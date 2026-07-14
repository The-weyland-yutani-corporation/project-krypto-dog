import { NextRequest } from "next/server";
import { mockDb } from "../setup";
import {
  EmailDeliveryError,
  sendDailySummary,
} from "@/lib/email";

jest.mock("@/lib/email", () => ({
  EmailDeliveryError: class EmailDeliveryError extends Error {},
  sendDailySummary: jest.fn(),
}));

import { POST } from "@/app/api/agent/daily-summary/route";

const mockedSendDailySummary = sendDailySummary as jest.MockedFunction<
  typeof sendDailySummary
>;

function request(secret = "test-cron-secret"): NextRequest {
  return new NextRequest(
    new Request("http://localhost:3000/api/agent/daily-summary", {
      method: "POST",
      headers: { "x-cron-secret": secret },
    }),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
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
});

describe("POST /api/agent/daily-summary", () => {
  it("records skipped delivery as degraded evidence", async () => {
    mockedSendDailySummary.mockResolvedValue({
      status: "skipped",
      reason: "RESEND_API_KEY is not configured",
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
      new EmailDeliveryError("Resend rejected daily summary"),
    );

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toMatchObject({
      error: "Resend rejected daily summary",
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
    mockDb._insertChain.values.mockRejectedValueOnce(
      new Error("journal insert failed"),
    );

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toMatchObject({
      generated: true,
      delivery: { status: "sent", id: "email-123" },
      alertAuditRecorded: false,
      error: "journal insert failed",
    });
  });

  it("rejects an invalid cron secret before querying the database", async () => {
    const response = await POST(request("wrong-secret"));

    expect(response.status).toBe(401);
    expect(mockDb.select).not.toHaveBeenCalled();
    expect(mockedSendDailySummary).not.toHaveBeenCalled();
  });
});
