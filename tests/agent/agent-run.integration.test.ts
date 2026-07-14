jest.mock("@/agent/run-flow", () => ({
  executeAgentRun: jest.fn(),
}));

import { POST } from "@/app/api/agent/run/route";
import { executeAgentRun } from "@/agent/run-flow";

const mockedExecuteAgentRun = executeAgentRun as jest.MockedFunction<
  typeof executeAgentRun
>;

function request(
  secret = "test-cron-secret",
  idempotencyKey?: string,
) {
  const headers: Record<string, string> = {
    "x-cron-secret": secret,
  };
  if (idempotencyKey) {
    headers["x-idempotency-key"] = idempotencyKey;
  }
  return new Request("http://localhost:3000/api/agent/run", {
    method: "POST",
    headers,
  });
}

describe("POST /api/agent/run", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = "test-cron-secret";
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
