import { mockDb } from "../setup";

// Mock modules that the route handler imports (besides @/db which setup.ts handles)
jest.mock("@/agent", () => ({ runAgent: jest.fn() }));
jest.mock("@/lib/config", () => ({
  JOURNAL_CONTEXT_COUNT: 3,
  validateEnv: jest.fn(),
  RSI_PERIOD: 14,
  EMA_SHORT_PERIOD: 12,
  EMA_LONG_PERIOD: 26,
}));
jest.mock("@/lib/analytics", () => ({
  trackAgentRunStarted: jest.fn(),
  trackAgentRunCompleted: jest.fn(),
  trackTradeExecuted: jest.fn(),
  trackGuardrailTriggered: jest.fn(),
  trackLLMTokenUsage: jest.fn(),
}));
jest.mock("@/lib/indicators", () => ({
  fetchCandles: jest.fn().mockResolvedValue([100, 101, 102]),
  calculateRSI: jest.fn().mockReturnValue(50),
  calculateEMA: jest.fn().mockReturnValue(100),
}));
jest.mock("@/guardrails", () => ({ runPreFlightChecks: jest.fn() }));
jest.mock("@/tools/safe-trade", () => ({ safeTrade: {} }));
jest.mock("@/tools/market-data", () => ({
  getEthPriceTool: {},
  getRsiTool: {},
  getEmaTool: {},
}));
jest.mock("@/tools/portfolio", () => ({ getPortfolioStateTool: {} }));
jest.mock("@/tools/journal", () => ({ writeJournalEntryTool: {} }));

import { POST } from "@/app/api/agent/run/route";
import { runAgent } from "@/agent";
import { runPreFlightChecks } from "@/guardrails";

const mockedRunAgent = runAgent as jest.MockedFunction<typeof runAgent>;
const mockedRunPreFlightChecks = runPreFlightChecks as jest.MockedFunction<
  typeof runPreFlightChecks
>;

// Mock global fetch for Coinbase price API
const originalFetch = global.fetch;
const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;

function makeRequest(headers: Record<string, string> = {}) {
  return new Request("http://localhost:3000/api/agent/run", {
    method: "POST",
    headers: { "x-cron-secret": "test-cron-secret", ...headers },
  });
}

/** Configure mockDb chains so acquireMutex succeeds */
function stubMutexSuccess() {
  mockDb._updateChain.returning.mockResolvedValue([{ id: "singleton" }]);
}

/** Configure mockDb chains so acquireMutex fails (already running) */
function stubMutexConflict() {
  mockDb._updateChain.returning.mockResolvedValue([]);
}

/** Stub the two SELECT calls the route makes after pre-flight:
 *  1. agentState singleton  2. recent journal entries */
function stubSelectCalls(
  state: Record<string, unknown> = {
    id: "singleton",
    currentPositionETH: 0.05,
    currentPositionUSDC: 150,
    lastTradePrice: 1950,
    isLocked: false,
    isRunning: true,
    portfolioValueUSD: 250,
  }
) {
  let callCount = 0;
  mockDb.select.mockImplementation(() => {
    callCount++;
    if (callCount === 1) {
      // agentState – no terminal method, resolves via chain.then
      const stateChain: Record<string, jest.Mock> & { then?: unknown } = {};
      stateChain.from = jest.fn().mockReturnValue(stateChain);
      stateChain.where = jest.fn().mockResolvedValue([state]);
      return stateChain as any;
    }
    // journal entries – uses orderBy().limit()
    const journalChain: Record<string, jest.Mock> = {};
    journalChain.from = jest.fn().mockReturnValue(journalChain);
    journalChain.orderBy = jest.fn().mockReturnValue(journalChain);
    journalChain.limit = jest.fn().mockResolvedValue([]);
    return journalChain as any;
  });
}

describe("POST /api/agent/run", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = mockFetch;
    process.env.CRON_SECRET = "test-cron-secret";

    // Default: Coinbase price API returns $2000
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ data: { amount: "2000.00" } }), {
        status: 200,
      })
    );
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  // ── Auth ───────────────────────────────────────────────────────────────

  it("returns 401 without valid cron secret", async () => {
    const req = new Request("http://localhost:3000/api/agent/run", {
      method: "POST",
      headers: { "x-cron-secret": "wrong" },
    });

    const res = await POST(req as any);
    expect(res.status).toBe(401);
  });

  // ── Mutex ──────────────────────────────────────────────────────────────

  it("returns 409 when agent is already running (mutex)", async () => {
    stubMutexConflict();

    const res = await POST(makeRequest() as any);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("already running");
  });

  // ── Guardrails ─────────────────────────────────────────────────────────

  it("returns skipped when guardrails trigger (cooldown)", async () => {
    stubMutexSuccess();
    mockedRunPreFlightChecks.mockResolvedValue({
      skip: true,
      reason: "Cooldown active: last trade was less than 2 hours ago",
    });

    const res = await POST(makeRequest() as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("skipped");
    expect(body.guardrailTriggered).toContain("Cooldown");
  });

  it("returns locked when guardrails trigger (drawdown)", async () => {
    stubMutexSuccess();
    mockedRunPreFlightChecks.mockResolvedValue({
      skip: true,
      reason: "System locked: max drawdown reached",
    });

    const res = await POST(makeRequest() as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("locked");
    expect(body.guardrailTriggered).toMatch(/locked/i);
  });

  // ── Happy path ─────────────────────────────────────────────────────────

  it("runs agent and returns result on success (hold)", async () => {
    stubMutexSuccess();
    mockedRunPreFlightChecks.mockResolvedValue({ skip: false });
    stubSelectCalls();

    mockedRunAgent.mockResolvedValue({
      status: "skipped",
      action: "hold",
      reasoning: "Market is neutral, holding position.",
      durationMs: 1500,
    });

    const res = await POST(makeRequest() as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("skipped");
    expect(body.action).toBe("hold");
    // Verify the agent was actually called
    expect(mockedRunAgent).toHaveBeenCalledTimes(1);
  });

  // ── Mutex release ──────────────────────────────────────────────────────

  it("releases mutex even when the agent throws", async () => {
    stubMutexSuccess();
    mockedRunPreFlightChecks.mockResolvedValue({ skip: false });
    stubSelectCalls();

    mockedRunAgent.mockRejectedValue(new Error("LLM exploded"));

    const res = await POST(makeRequest() as any);
    expect(res.status).toBe(500);

    // update is called for acquire AND release
    expect(mockDb.update).toHaveBeenCalledTimes(2);
  });
});
