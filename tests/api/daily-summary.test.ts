import { NextRequest } from "next/server";
import { mockDb } from "../setup";
import {
  EmailDeliveryError,
  sendDailySummary,
} from "@/lib/email";
import { flushPostHog } from "@/lib/posthog";
import {
  resetRunAdmissionForTest,
  tryAcquireRunAdmission,
} from "@/lib/run-admission";
import { safetyIncidentRepository } from "@/lib/safety-incidents";

jest.mock("@/lib/email", () => ({
  EmailDeliveryError: class EmailDeliveryError extends Error {},
  sendDailySummary: jest.fn(),
}));
jest.mock("@/lib/safety-incidents", () => ({
  safetyIncidentRepository: {
    createOrGet: jest.fn(async () => ({
      created: true,
      event: {
        incidentId: "incident-daily",
      },
    })),
    appendDeliveryLifecycle: jest.fn(async () => ({
      incidentId: "incident-daily",
    })),
  },
}));
jest.mock("@/lib/posthog", () => ({
  reservePostHogBudget: jest.fn(async () => true),
  flushPostHog: jest.fn(async () => undefined),
}));

import { POST } from "@/app/api/agent/daily-summary/route";

const mockedSendDailySummary = sendDailySummary as jest.MockedFunction<
  typeof sendDailySummary
>;
const mockedFlushPostHog = flushPostHog as jest.MockedFunction<
  typeof flushPostHog
>;
const originalRolloutMode = process.env.ROLLOUT_MODE;

function request(
  secret = "test-cron-secret",
  requiredMode: string | null = "disabled",
): NextRequest {
  const headers: Record<string, string> = {
    "x-cron-secret": secret,
  };
  if (requiredMode) {
    headers["x-required-rollout-mode"] = requiredMode;
  }
  return new NextRequest(
    new Request("http://localhost:3000/api/agent/daily-summary", {
      method: "POST",
      headers,
    }),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  resetRunAdmissionForTest();
  process.env.ROLLOUT_MODE = "disabled";
  mockDb.select.mockReturnValue(mockDb._selectChain);
  mockDb.insert.mockReturnValue(mockDb._insertChain);
  mockDb._selectChain.from.mockReturnValue(mockDb._selectChain);
  mockDb._selectChain.where.mockReturnValue(mockDb._selectChain);
  mockDb._selectChain.orderBy.mockReturnValue(mockDb._selectChain);
  mockDb._selectChain.limit.mockResolvedValue([
    {
      portfolioValueUSDDecimal: "205.00000000",
      portfolioValueUSD: 205,
    },
  ]);
  mockDb._insertChain.values.mockReturnValue(mockDb._insertChain);
  mockDb._insertChain.returning.mockResolvedValue([{ id: "journal-daily" }]);
});

afterAll(() => {
  if (originalRolloutMode === undefined) {
    delete process.env.ROLLOUT_MODE;
  } else {
    process.env.ROLLOUT_MODE = originalRolloutMode;
  }
});

describe("POST /api/agent/daily-summary", () => {
  it("records skipped delivery as degraded evidence", async () => {
    mockedSendDailySummary.mockResolvedValue({
      status: "skipped",
      reason:
        "Missing ACS email configuration: AZURE_COMMUNICATION_CONNECTION_STRING",
    });

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      generated: true,
      alertAuditRecorded: true,
      delivery: { status: "skipped" },
    });
    expect(mockDb._insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({
        marketConditions: expect.objectContaining({
          event: "daily-summary-delivery",
          status: "skipped",
        }),
      }),
    );
  });

  it("returns 502 and records provider delivery failures", async () => {
    mockedSendDailySummary.mockRejectedValue(
      new EmailDeliveryError(
        "ACS email daily summary ended with status Failed",
      ),
    );

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toMatchObject({
      error: "ACS email daily summary ended with status Failed",
      alertAuditRecorded: true,
    });
    expect(mockDb._insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({
        marketConditions: expect.objectContaining({
          event: "daily-summary-delivery",
          status: "failed",
        }),
      }),
    );
  });

  it("surfaces audit persistence failure after email delivery", async () => {
    mockedSendDailySummary.mockResolvedValue({
      status: "sent",
      id: "email-123",
    });

    mockDb._insertChain.returning.mockRejectedValueOnce(
      new Error("journal insert failed"),
    );

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toMatchObject({
      alertAuditRecorded: false,
      error: "journal insert failed",
      incidentId: "incident-daily",
    });
  });

  it("returns terminal incident evidence when telemetry fails after email delivery", async () => {
    mockedSendDailySummary.mockResolvedValue({
      status: "sent",
      id: "email-telemetry",
    });
    mockedFlushPostHog.mockRejectedValueOnce(
      new Error("injected telemetry failure"),
    );

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toMatchObject({
      alertAuditRecorded: false,
      incidentId: "incident-daily",
    });
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("rejects an invalid cron secret before querying the database", async () => {
    const response = await POST(request("wrong-secret"));

    expect(response.status).toBe(401);
    expect(mockDb.select).not.toHaveBeenCalled();
    expect(mockedSendDailySummary).not.toHaveBeenCalled();
  });

  it("requires a matching rollout mode before querying the database", async () => {
    const missing = await POST(request("test-cron-secret", null));
    expect(missing.status).toBe(400);

    const mismatched = await POST(
      request("test-cron-secret", "paper"),
    );
    expect(mismatched.status).toBe(409);
    expect(mockDb.select).not.toHaveBeenCalled();
    expect(mockedSendDailySummary).not.toHaveBeenCalled();
  });

  it("returns retryable backpressure without opening a critical incident", async () => {
    const release = tryAcquireRunAdmission();
    try {
      const response = await POST(request());
      const body = await response.json();

      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("1");
      expect(body).toMatchObject({
        error: "Process run admission capacity is exhausted",
        code: "admission-capacity-exhausted",
      });
      expect(safetyIncidentRepository.createOrGet).not.toHaveBeenCalled();
      expect(mockDb.select).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });
});
