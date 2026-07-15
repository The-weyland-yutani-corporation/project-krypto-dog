jest.mock("@/agent/run-flow", () => ({
  executeAgentRun: jest.fn(),
}));

import { POST } from "@/app/api/agent/run/route";
import { executeAgentRun } from "@/agent/run-flow";
import { RequiredRolloutModeError } from "@/trading/errors";

const mockedExecuteAgentRun = executeAgentRun as jest.MockedFunction<
  typeof executeAgentRun
>;

function request(
  secret = "test-cron-secret",
  idempotencyKey?: string,
  requiredMode: string | null = "disabled",
  modeProbe = false,
) {
  const headers: Record<string, string> = {
    "x-cron-secret": secret,
  };
  if (idempotencyKey) {
    headers["x-idempotency-key"] = idempotencyKey;
  }
  if (requiredMode) {
    headers["x-required-rollout-mode"] = requiredMode;
  }
  if (modeProbe) {
    headers["x-krypto-mode-probe"] = "no-mutation";
  }
  return new Request("http://localhost:3000/api/agent/run", {
    method: "POST",
    headers,
  });
}

describe("POST /api/agent/run", () => {
  const originalRolloutMode = process.env.ROLLOUT_MODE;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = "test-cron-secret";
    process.env.ROLLOUT_MODE = "disabled";
  });

  afterAll(() => {
    if (originalRolloutMode === undefined) {
      delete process.env.ROLLOUT_MODE;
    } else {
      process.env.ROLLOUT_MODE = originalRolloutMode;
    }
  });

  it("rejects an invalid cron secret", async () => {
    const response = await POST(request("wrong") as never);
    expect(response.status).toBe(401);
    expect(mockedExecuteAgentRun).not.toHaveBeenCalled();
  });

  it("passes the caller idempotency key into orchestration", async () => {
    mockedExecuteAgentRun.mockResolvedValue({
      kind: "ok",
      result: {
        runId: "run-1",
        status: "skipped",
        action: "hold",
        durationMs: 10,
      },
    });

    const response = await POST(
      request("test-cron-secret", "cron:2026-07-14T12") as never,
    );

    expect(response.status).toBe(200);
    expect(mockedExecuteAgentRun).toHaveBeenCalledWith({
      triggerSource: "cron",
      idempotencyKey: "cron:2026-07-14T12",
      requiredMode: "disabled",
    });
  });

  it("maps lease conflicts to HTTP 409", async () => {
    mockedExecuteAgentRun.mockResolvedValue({
      kind: "mutex",
      message: "Agent is already running",
    });

    const response = await POST(request() as never);
    expect(response.status).toBe(409);
  });

  it("passes a required disabled mode into orchestration", async () => {
    mockedExecuteAgentRun.mockResolvedValue({
      kind: "ok",
      result: {
        runId: "disabled-run",
        status: "skipped",
        action: "disabled",
        durationMs: 1,
      },
    });

    const response = await POST(
      request("test-cron-secret", "smoke-run", "disabled") as never,
    );

    expect(response.status).toBe(200);
    expect(mockedExecuteAgentRun).toHaveBeenCalledWith({
      triggerSource: "cron",
      idempotencyKey: "smoke-run",
      requiredMode: "disabled",
    });
  });

  it("rejects invalid or changed required modes before a run", async () => {
    const missing = await POST(
      request("test-cron-secret", undefined, null) as never,
    );
    expect(missing.status).toBe(400);
    expect(mockedExecuteAgentRun).not.toHaveBeenCalled();

    const invalid = await POST(
      request("test-cron-secret", undefined, "live") as never,
    );
    expect(invalid.status).toBe(400);
    expect(mockedExecuteAgentRun).not.toHaveBeenCalled();

    mockedExecuteAgentRun.mockRejectedValueOnce(
      new RequiredRolloutModeError("disabled", "paper"),
    );
    const changed = await POST(
      request("test-cron-secret", "smoke-run", "disabled") as never,
    );
    expect(changed.status).toBe(409);
    await expect(changed.json()).resolves.toEqual({
      error: "Rollout mode changed before the run started",
      expectedMode: "disabled",
      actualMode: "paper",
    });
  });

  it("checks a rollout mode without invoking orchestration", async () => {
    process.env.ROLLOUT_MODE = "paper";
    const matched = await POST(
      request(
        "test-cron-secret",
        "deployment-probe",
        "paper",
        true,
      ) as never,
    );
    expect(matched.status).toBe(200);
    await expect(matched.json()).resolves.toEqual({
      modeProbe: true,
      expectedMode: "paper",
      actualMode: "paper",
    });
    expect(mockedExecuteAgentRun).not.toHaveBeenCalled();

    const mismatched = await POST(
      request(
        "test-cron-secret",
        "deployment-probe",
        "disabled",
        true,
      ) as never,
    );
    expect(mismatched.status).toBe(409);
    expect(mockedExecuteAgentRun).not.toHaveBeenCalled();
  });

  it("preserves typed upstream status codes", async () => {
    mockedExecuteAgentRun.mockResolvedValue({
      kind: "upstream_error",
      httpStatus: 504,
      result: {
        runId: "run-timeout",
        status: "error",
        error: "Market data timed out",
        durationMs: 10,
      },
    });

    const response = await POST(request() as never);
    expect(response.status).toBe(504);
  });
});
