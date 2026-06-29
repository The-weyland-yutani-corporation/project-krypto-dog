import { mockDb } from "../setup";
import { NextRequest } from "next/server";

jest.mock("@/agent/run-flow", () => ({
  executeAgentRun: jest.fn(),
}));

import { POST as runAgent } from "@/app/api/admin/run-agent/route";
import { POST as pause } from "@/app/api/admin/pause/route";
import { POST as releaseLease } from "@/app/api/admin/release-run-lease/route";
import { executeAgentRun } from "@/agent/run-flow";

const mockedExecuteAgentRun = executeAgentRun as jest.MockedFunction<
  typeof executeAgentRun
>;

function makeReq(
  url: string,
  init: { body?: unknown; origin?: string | null } = {},
): NextRequest {
  const headers: Record<string, string> = {};
  if (init.origin !== null) {
    headers.origin = init.origin ?? "http://localhost:3000";
  }
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  return new NextRequest(
    new Request(url, {
      method: "POST",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.select.mockReturnValue(mockDb._selectChain);
  mockDb.update.mockReturnValue(mockDb._updateChain);
  mockDb._selectChain.from.mockReturnValue(mockDb._selectChain);
  mockDb._selectChain.where.mockReturnValue(mockDb._selectChain);
  mockDb._selectChain.limit.mockResolvedValue([
    {
      isRunning: true,
      isLocked: false,
      isOperatorPaused: false,
      lastRunAt: null,
    },
  ]);
  mockDb._updateChain.set.mockReturnValue(mockDb._updateChain);
  mockDb._updateChain.where.mockReturnValue(mockDb._updateChain);
  mockDb._updateChain.returning.mockResolvedValue([
    { isRunning: false, isLocked: false, isOperatorPaused: false },
  ]);
});

describe("POST /api/admin/run-agent", () => {
  it("delegates to executeAgentRun with triggerSource=admin and returns 200 on ok", async () => {
    mockedExecuteAgentRun.mockResolvedValue({
      kind: "ok",
      result: {
        status: "skipped",
        guardrailTriggered: "Cooldown active",
        durationMs: 5,
      },
    });

    const res = await runAgent(
      makeReq("http://localhost:3000/api/admin/run-agent"),
    );

    expect(mockedExecuteAgentRun).toHaveBeenCalledWith({ triggerSource: "admin" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("skipped");
  });

  it("returns 409 on mutex outcome", async () => {
    mockedExecuteAgentRun.mockResolvedValue({
      kind: "mutex",
      message: "Agent is already running",
    });
    const res = await runAgent(
      makeReq("http://localhost:3000/api/admin/run-agent"),
    );
    expect(res.status).toBe(409);
  });

  it("returns the upstream HTTP status on upstream_error outcome", async () => {
    mockedExecuteAgentRun.mockResolvedValue({
      kind: "upstream_error",
      result: { status: "error", error: "boom", durationMs: 10 },
      httpStatus: 502,
    });
    const res = await runAgent(
      makeReq("http://localhost:3000/api/admin/run-agent"),
    );
    expect(res.status).toBe(502);
  });

  it("rejects cross-origin requests with 403", async () => {
    const res = await runAgent(
      makeReq("http://localhost:3000/api/admin/run-agent", {
        origin: "https://evil.example.com",
      }),
    );
    expect(res.status).toBe(403);
    expect(mockedExecuteAgentRun).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/pause", () => {
  it("sets isOperatorPaused=true on { paused: true }", async () => {
    const res = await pause(
      makeReq("http://localhost:3000/api/admin/pause", {
        body: { paused: true },
      }),
    );
    expect(res.status).toBe(200);
    expect(mockDb.update).toHaveBeenCalled();
    expect(mockDb._updateChain.set).toHaveBeenCalledWith({
      isOperatorPaused: true,
    });
  });

  it("sets isOperatorPaused=false on { paused: false }", async () => {
    const res = await pause(
      makeReq("http://localhost:3000/api/admin/pause", {
        body: { paused: false },
      }),
    );
    expect(res.status).toBe(200);
    expect(mockDb._updateChain.set).toHaveBeenCalledWith({
      isOperatorPaused: false,
    });
  });

  it("rejects body without `paused` with 400", async () => {
    const res = await pause(
      makeReq("http://localhost:3000/api/admin/pause", {
        body: { lock: true },
      }),
    );
    expect(res.status).toBe(400);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON body with 400", async () => {
    const req = new NextRequest(
      new Request("http://localhost:3000/api/admin/pause", {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "content-type": "application/json",
        },
        body: "not-json",
      }),
    );
    const res = await pause(req);
    expect(res.status).toBe(400);
  });

  it("rejects cross-origin with 403", async () => {
    const res = await pause(
      makeReq("http://localhost:3000/api/admin/pause", {
        origin: "https://evil.example.com",
        body: { paused: true },
      }),
    );
    expect(res.status).toBe(403);
    expect(mockDb.update).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/release-run-lease", () => {
  it("clears isRunning and returns prior state", async () => {
    const prior = {
      isRunning: true,
      isLocked: false,
      isOperatorPaused: true,
      lastRunAt: null,
    };
    mockDb._selectChain.limit.mockResolvedValueOnce([prior]);
    mockDb._updateChain.returning.mockResolvedValueOnce([
      { isRunning: false, isLocked: false, isOperatorPaused: true },
    ]);

    const res = await releaseLease(
      makeReq("http://localhost:3000/api/admin/release-run-lease"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.priorState).toEqual(prior);
    expect(body.state.isRunning).toBe(false);
    expect(body.state.isOperatorPaused).toBe(true); // not touched
    expect(body.state.isLocked).toBe(false); // not touched
    expect(mockDb._updateChain.set).toHaveBeenCalledWith({ isRunning: false });
  });

  it("rejects cross-origin with 403", async () => {
    const res = await releaseLease(
      makeReq("http://localhost:3000/api/admin/release-run-lease", {
        origin: "https://evil.example.com",
      }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 500 if singleton is missing (defensive)", async () => {
    mockDb._selectChain.limit.mockResolvedValueOnce([]);
    const res = await releaseLease(
      makeReq("http://localhost:3000/api/admin/release-run-lease"),
    );
    expect(res.status).toBe(500);
    expect(mockDb.update).not.toHaveBeenCalled();
  });
});
