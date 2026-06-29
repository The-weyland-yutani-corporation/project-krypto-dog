import { mockDb } from "../setup";

// Mock external boundaries only.
//
// The previous version of this test mocked `@/agent` itself, which meant the
// real agent loop (prompt construction, token-usage extraction, trade detection
// from tool calls) was never exercised. We now stub only:
//   - `@/agent/llm`              — wraps the Azure-hosted Anthropic SDK
//   - `@langchain/langgraph/prebuilt` — provides the ReAct agent factory
// so the route handler + the real `runAgent` are both under test.

jest.mock("@/agent/llm", () => ({ getLLM: jest.fn(() => ({ __isMockLLM: true })) }));

const mockAgentInvoke = jest.fn();
jest.mock("@langchain/langgraph/prebuilt", () => ({
  createReactAgent: jest.fn(() => ({ invoke: mockAgentInvoke })),
}));

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
jest.mock("@/tools/safe-trade", () => ({ safeTrade: { name: "safe_trade" } }));
jest.mock("@/tools/market-data", () => ({
  getEthPriceTool: { name: "get_eth_price" },
  getRsiTool: { name: "get_rsi" },
  getEmaTool: { name: "get_ema" },
}));
jest.mock("@/tools/portfolio", () => ({ getPortfolioStateTool: { name: "get_portfolio_state" } }));
jest.mock("@/tools/journal", () => ({ writeJournalEntryTool: { name: "write_journal_entry" } }));

import { POST } from "@/app/api/agent/run/route";
import { runPreFlightChecks } from "@/guardrails";
import {
  trackTradeExecuted,
  trackLLMTokenUsage,
} from "@/lib/analytics";
import { createReactAgent } from "@langchain/langgraph/prebuilt";

const mockedRunPreFlightChecks = runPreFlightChecks as jest.MockedFunction<
  typeof runPreFlightChecks
>;
const mockedCreateReactAgent = createReactAgent as jest.MockedFunction<typeof createReactAgent>;

// Mock global fetch for Coinbase price API
const originalFetch = global.fetch;
const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;

function makeRequest(headers: Record<string, string> = {}) {
  return new Request("http://localhost:3000/api/agent/run", {
    method: "POST",
    headers: { "x-cron-secret": "test-cron-secret", ...headers },
  });
}

function safeTradeSuccessContent({
  id = "trade-123",
  direction = "BUY",
  asset = "ETH",
  amount = "$25.00",
  executionPrice = "$2000.00",
  assetAmount = "0.012500 ETH",
  fees = "$0.0750",
  pnl = "N/A",
}: {
  id?: string;
  direction?: "BUY" | "SELL";
  asset?: string;
  amount?: string;
  executionPrice?: string;
  assetAmount?: string;
  fees?: string;
  pnl?: string;
} = {}) {
  return [
    "Trade executed successfully.",
    `ID: ${id}`,
    `Direction: ${direction}`,
    `Asset: ${asset}`,
    `Amount: ${amount}`,
    `Execution Price: ${executionPrice}`,
    `Asset Amount: ${assetAmount}`,
    `Fees: ${fees}`,
    `P&L: ${pnl}`,
    "New ETH Balance: 0.012500",
    "New USDC Balance: $174.93",
  ].join("\n");
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

  it("returns 401 when cron secret length differs", async () => {
    const req = new Request("http://localhost:3000/api/agent/run", {
      method: "POST",
      headers: { "x-cron-secret": "short" },
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

  // ── Happy path: hold (no trade) ────────────────────────────────────────

  it("runs the real agent loop and returns hold when no tool was called", async () => {
    stubMutexSuccess();
    mockedRunPreFlightChecks.mockResolvedValue({ skip: false });
    stubSelectCalls();

    // Synthetic LangChain message stream — no tool calls = "hold".
    mockAgentInvoke.mockResolvedValue({
      messages: [
        { role: "user", content: "..." },
        {
          role: "assistant",
          content: "Market is neutral, holding position.",
          usage_metadata: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
        },
      ],
    });

    const res = await POST(makeRequest() as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("skipped");
    expect(body.action).toBe("hold");
    expect(body.reasoning).toContain("Market is neutral");
    expect(body.tokenUsage).toEqual({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    });
    // Real runAgent was used: it invoked the agent factory exactly once.
    expect(mockedCreateReactAgent).toHaveBeenCalledTimes(1);
    expect(mockAgentInvoke).toHaveBeenCalledTimes(1);
    // LLM token usage analytics fired through the real run path.
    expect(trackLLMTokenUsage).toHaveBeenCalledWith({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    });
    expect(body.journalWritten).toBe(true);
    expect(body.journalFallbackWritten).toBe(true);
    expect(mockDb._insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({
        entryText: expect.stringContaining("Fallback journal entry"),
        marketConditions: expect.objectContaining({
          ethPrice: 2000,
        }),
      }),
    );
    // Pure hold path: no trade analytics call.
    expect(trackTradeExecuted).not.toHaveBeenCalled();
  });

  // ── Happy path: trade executed ─────────────────────────────────────────

  it("detects an executed trade when the model emitted a safe_trade tool call", async () => {
    stubMutexSuccess();
    mockedRunPreFlightChecks.mockResolvedValue({ skip: false });
    stubSelectCalls();

    mockAgentInvoke.mockResolvedValue({
      messages: [
        { role: "user", content: "..." },
        {
          role: "assistant",
          tool_calls: [{ name: "safe_trade", args: { direction: "BUY", asset: "ETH", amountUSD: 25 } }],
          usage_metadata: { input_tokens: 200, output_tokens: 80, total_tokens: 280 },
        },
        {
          role: "tool",
          name: "safe_trade",
          content: safeTradeSuccessContent(),
        },
        {
          role: "tool",
          name: "write_journal_entry",
          content: "Journal entry recorded (ID: journal-123). ETH price at time of entry: $2000.00.",
        },
        { role: "assistant", content: "Bought ETH because RSI < 30." },
      ],
    });

    const res = await POST(makeRequest() as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("executed");
    expect(body.action).toBe("trade");
    expect(body.trade).toEqual(
      expect.objectContaining({
        success: true,
        tradeId: "trade-123",
        direction: "BUY",
        asset: "ETH",
        amountUSD: 25,
        executionPrice: 2000,
        amountAsset: 0.0125,
        feesUSD: 0.075,
        pnlUSD: null,
      }),
    );
    expect(body.journalWritten).toBe(true);
    expect(body.journalFallbackWritten).toBeUndefined();
    expect(body.tokenUsage.totalTokens).toBe(280);
    expect(trackTradeExecuted).toHaveBeenCalledWith({
      direction: "BUY",
      asset: "ETH",
      amountUSD: 25,
      executionPrice: 2000,
      feesUSD: 0.075,
      pnlUSD: undefined,
    });
  });

  it("reports a later successful safe_trade when an earlier attempt failed", async () => {
    stubMutexSuccess();
    mockedRunPreFlightChecks.mockResolvedValue({ skip: false });
    stubSelectCalls();

    mockAgentInvoke.mockResolvedValue({
      messages: [
        { role: "user", content: "..." },
        {
          role: "tool",
          name: "safe_trade",
          content: "Error: Trade exceeds max limit of $50. Please reduce trade size.",
        },
        {
          role: "tool",
          name: "safe_trade",
          content: safeTradeSuccessContent({
            id: "trade-sell",
            direction: "SELL",
            amount: "$30.00",
            assetAmount: "0.015000 ETH",
            fees: "$0.0900",
            pnl: "+$1.4100",
          }),
        },
        {
          role: "tool",
          name: "write_journal_entry",
          content: "Journal entry recorded (ID: journal-sell). ETH price at time of entry: $2000.00.",
        },
        { role: "assistant", content: "Reduced size and sold successfully." },
      ],
    });

    const res = await POST(makeRequest() as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("executed");
    expect(body.trade).toEqual(
      expect.objectContaining({
        success: true,
        tradeId: "trade-sell",
        direction: "SELL",
        amountUSD: 30,
        amountAsset: 0.015,
        feesUSD: 0.09,
        pnlUSD: 1.41,
      }),
    );
    expect(trackTradeExecuted).toHaveBeenCalledWith({
      direction: "SELL",
      asset: "ETH",
      amountUSD: 30,
      executionPrice: 2000,
      feesUSD: 0.09,
      pnlUSD: 1.41,
    });
  });

  it("parses trade analytics when safe_trade money fields include USD suffixes", async () => {
    stubMutexSuccess();
    mockedRunPreFlightChecks.mockResolvedValue({ skip: false });
    stubSelectCalls();

    mockAgentInvoke.mockResolvedValue({
      messages: [
        {
          role: "tool",
          name: "safe_trade",
          content: safeTradeSuccessContent({
            direction: "SELL",
            amount: "$30.00 USD",
            executionPrice: "$2000.00 USD",
            fees: "$0.0900 USD",
            pnl: "+$1.3500 USD",
          }),
        },
        {
          role: "tool",
          name: "write_journal_entry",
          content: "Journal entry recorded (ID: journal-sell). ETH price at time of entry: $2000.00.",
        },
        { role: "assistant", content: "Sold ETH." },
      ],
    });

    const res = await POST(makeRequest() as any);
    expect(res.status).toBe(200);
    expect(trackTradeExecuted).toHaveBeenCalledWith(
      expect.objectContaining({
        amountUSD: 30,
        executionPrice: 2000,
        feesUSD: 0.09,
        pnlUSD: 1.35,
      }),
    );
  });

  it("does not fail an executed run when fallback journal insert fails", async () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    stubMutexSuccess();
    mockedRunPreFlightChecks.mockResolvedValue({ skip: false });
    stubSelectCalls();
    mockDb._insertChain.values.mockImplementationOnce(() => {
      throw new Error("fallback insert failed");
    });

    mockAgentInvoke.mockResolvedValue({
      messages: [
        { role: "user", content: "..." },
        { role: "tool", name: "safe_trade", content: safeTradeSuccessContent() },
        { role: "assistant", content: "Bought ETH but forgot to journal." },
      ],
    });

    try {
      const res = await POST(makeRequest() as any);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("executed");
      expect(body.journalWritten).toBe(false);
      expect(body.journalFallbackWritten).toBeUndefined();
      expect(trackTradeExecuted).toHaveBeenCalledWith({
        direction: "BUY",
        asset: "ETH",
        amountUSD: 25,
        executionPrice: 2000,
        feesUSD: 0.075,
        pnlUSD: undefined,
      });
    } finally {
      consoleError.mockRestore();
    }
  });

  // ── Tool wiring ────────────────────────────────────────────────────────

  it("passes all six trading tools and a SystemMessage prompt to the agent factory", async () => {
    stubMutexSuccess();
    mockedRunPreFlightChecks.mockResolvedValue({ skip: false });
    stubSelectCalls();
    mockAgentInvoke.mockResolvedValue({ messages: [{ role: "assistant", content: "hold" }] });

    await POST(makeRequest() as any);

    expect(mockedCreateReactAgent).toHaveBeenCalledTimes(1);
    const args = mockedCreateReactAgent.mock.calls[0][0] as {
      tools: Array<{ name: string }>;
      prompt: { content: string };
    };
    const toolNames = args.tools.map((t) => t.name).sort();
    expect(toolNames).toEqual([
      "get_ema",
      "get_eth_price",
      "get_portfolio_state",
      "get_rsi",
      "safe_trade",
      "write_journal_entry",
    ]);
    // System prompt was assembled with real formatters and contains portfolio facts.
    expect(args.prompt.content).toContain("0.05"); // currentPositionETH
    expect(args.prompt.content).toContain("2000"); // ethPrice from Coinbase
  });

  // ── Mutex release ──────────────────────────────────────────────────────

  it("releases mutex even when the agent throws", async () => {
    stubMutexSuccess();
    mockedRunPreFlightChecks.mockResolvedValue({ skip: false });
    stubSelectCalls();

    mockAgentInvoke.mockRejectedValue(new Error("LLM exploded"));

    const res = await POST(makeRequest() as any);
    // runAgent catches the throw and returns an error AgentRunResult, so the
    // route returns 200 with status:"error". Mutex must still be released.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("error");
    expect(body.error).toContain("LLM exploded");

    // update is called for acquire AND release
    expect(mockDb.update).toHaveBeenCalledTimes(2);
  });
});
