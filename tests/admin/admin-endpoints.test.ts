import { mockDb } from "../setup";
import { NextRequest, NextResponse } from "next/server";

jest.mock("@/agent/run-flow", () => ({
  executeAgentRun: jest.fn(),
}));
jest.mock("@/lib/admin-route-auth", () => ({
  requireAdminSession: jest.fn().mockResolvedValue(null),
}));

import { POST as runAgent } from "@/app/api/admin/run-agent/route";
import { POST as pause } from "@/app/api/admin/pause/route";
import { POST as releaseLease } from "@/app/api/admin/release-run-lease/route";
import { POST as unlock } from "@/app/api/admin/unlock/route";
import { executeAgentRun } from "@/agent/run-flow";
import { requireAdminSession } from "@/lib/admin-route-auth";

const mockedExecuteAgentRun = executeAgentRun as jest.MockedFunction<
  typeof executeAgentRun
>;
const mockedRequireAdminSession =
  requireAdminSession as jest.MockedFunction<typeof requireAdminSession>;

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
      leaseOwner: null,
      leaseExpiresAt: null,
    },
  ]);
  mockDb._updateChain.set.mockReturnValue(mockDb._updateChain);
  mockDb._updateChain.where.mockReturnValue(mockDb._updateChain);
  mockDb._updateChain.returning.mockResolvedValue([
    {
      isRunning: false,
      isLocked: false,
      isOperatorPaused: false,
      leaseOwner: null,
      leaseExpiresAt: null,
    },
  ]);
  mockedRequireAdminSession.mockResolvedValue(null);
});

describe("POST /api/admin/run-agent", () => {
  it("rejects a same-origin request without a valid admin session", async () => {
    mockedRequireAdminSession.mockResolvedValueOnce(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );

    const res = await runAgent(
      makeReq("http://localhost:3000/api/admin/run-agent"),
    );

    expect(res.status).toBe(401);
    expect(mockedExecuteAgentRun).not.toHaveBeenCalled();
  });

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
    expect(mockDb._insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({
        entryText: "Operator paused the agent.",
        marketConditions: expect.objectContaining({
          event: "operator-pause",
          paused: true,
        }),
      }),
    );
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
  it("clears legacy and expired lease fields and returns prior state", async () => {
    const prior = {
      isRunning: true,
      isLocked: false,
      isOperatorPaused: true,
      lastRunAt: null,
      leaseOwner: "expired-run",
      leaseExpiresAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    mockDb._selectChain.limit.mockResolvedValueOnce([prior]);
    mockDb._updateChain.returning.mockResolvedValueOnce([
      {
        isRunning: false,
        isLocked: false,
        isOperatorPaused: true,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    ]);

    const res = await releaseLease(
      makeReq("http://localhost:3000/api/admin/release-run-lease"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.priorState).toEqual({
      ...prior,
      leaseExpiresAt: prior.leaseExpiresAt.toISOString(),
    });
    expect(body.state.isRunning).toBe(false);
    expect(body.state.isOperatorPaused).toBe(true); // not touched
    expect(body.state.isLocked).toBe(false); // not touched
    expect(mockDb._updateChain.set).toHaveBeenCalledWith({
      isRunning: false,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    expect(mockDb._insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({
        entryText: "Operator recovered an expired or legacy run lease.",
        marketConditions: expect.objectContaining({
          event: "lease-recovery",
          priorLeaseOwner: "expired-run",
        }),
      }),
    );
  });

  it("refuses to release an active owned lease", async () => {
    const prior = {
      isRunning: true,
      isLocked: false,
      isOperatorPaused: false,
      lastRunAt: null,
      leaseOwner: "active-run",
      leaseExpiresAt: new Date(Date.now() + 60_000),
    };
    mockDb._selectChain.limit.mockResolvedValueOnce([prior]);
    mockDb._updateChain.returning.mockResolvedValueOnce([]);

    const res = await releaseLease(
      makeReq("http://localhost:3000/api/admin/release-run-lease"),
    );
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: "Run lease is still active",
    });
  });

  describe("POST /api/admin/unlock", () => {
    it("requires an explicit audit reason", async () => {
      const res = await unlock(
        makeReq("http://localhost:3000/api/admin/unlock", {
          body: { confirm: "UNLOCK", reason: "short" },
        }),
      );

      expect(res.status).toBe(400);
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it("refuses to unlock while an owned lease is active", async () => {
      mockDb._selectChain.limit.mockResolvedValueOnce([
        {
          isLocked: true,
          lockReason: "drawdown",
          lockedAt: new Date("2026-01-01T00:00:00.000Z"),
          leaseOwner: "active-run",
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      ]);

      const res = await unlock(
        makeReq("http://localhost:3000/api/admin/unlock", {
          body: {
            confirm: "UNLOCK",
            reason: "Reviewed accounting and confirmed the lock cause.",
          },
        }),
      );

      expect(res.status).toBe(409);
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it("clears the safety lock and writes an audit entry", async () => {
      mockDb._selectChain.limit.mockResolvedValueOnce([
        {
          isLocked: true,
          lockReason: "drawdown limit",
          lockedAt: new Date("2026-01-01T00:00:00.000Z"),
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      ]);
      mockDb._updateChain.returning.mockResolvedValueOnce([
        { isLocked: false, isOperatorPaused: true },
      ]);

      const res = await unlock(
        makeReq("http://localhost:3000/api/admin/unlock", {
          body: {
            confirm: "UNLOCK",
            reason: "Reviewed accounting and confirmed the lock cause.",
          },
        }),
      );

      expect(res.status).toBe(200);
      expect(mockDb._updateChain.set).toHaveBeenCalledWith({
        isLocked: false,
        lockReason: null,
        lockedAt: null,
        isOperatorPaused: true,
      });
      expect(mockDb._insertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({
          entryText: expect.stringContaining(
            "Reviewed accounting and confirmed the lock cause.",
          ),
          marketConditions: expect.objectContaining({
            event: "operator-unlock",
            priorLockReason: "drawdown limit",
          }),
        }),
      );
    });

    it("rejects cross-origin unlock requests", async () => {
      const res = await unlock(
        makeReq("http://localhost:3000/api/admin/unlock", {
          origin: "https://evil.example.com",
          body: {
            confirm: "UNLOCK",
            reason: "Reviewed accounting and confirmed the lock cause.",
          },
        }),
      );

      expect(res.status).toBe(403);
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });
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
