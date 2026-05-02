import { mockDb } from "../setup";
import { MAX_TRADE_SIZE_USD, ALLOWED_ASSETS } from "@/lib/config";

const mockFetch = jest.fn();
global.fetch = mockFetch;

import { safeTradeHandler } from "@/tools/safe-trade";

describe("Guardrails 3 & 4 – Safe Trade Tool", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Restore chain wiring after clearAllMocks
    mockDb.select.mockReturnValue(mockDb._selectChain);
    mockDb.insert.mockReturnValue(mockDb._insertChain);
    mockDb.update.mockReturnValue(mockDb._updateChain);
    mockDb._selectChain.from.mockReturnValue(mockDb._selectChain);
    mockDb._selectChain.where.mockReturnValue(mockDb._selectChain);
    mockDb._selectChain.orderBy.mockReturnValue(mockDb._selectChain);
    mockDb._selectChain.limit.mockResolvedValue([{
      id: "singleton", currentPositionETH: 0.01, currentPositionUSDC: 180,
      portfolioValueUSD: 200, lastTradePrice: 2000, isLocked: false, isRunning: false,
    }]);
    mockDb._insertChain.values.mockReturnValue(mockDb._insertChain);
    mockDb._insertChain.returning.mockResolvedValue([{ id: "trade-1" }]);
    mockDb._insertChain.onConflictDoUpdate.mockReturnValue(mockDb._insertChain);
    mockDb._updateChain.set.mockReturnValue(mockDb._updateChain);
    mockDb._updateChain.where.mockReturnValue(mockDb._updateChain);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: { amount: "2000" } }),
    });
  });

  it("should reject unauthorized assets (Guardrail 4)", async () => {
    const result = await safeTradeHandler({ direction: "BUY", asset: "BTC", amountUSD: 30, reasoning: "test" });
    expect(result).toContain("Unauthorized asset");
  });

  it("should reject trades exceeding $50 (Guardrail 3)", async () => {
    const result = await safeTradeHandler({ direction: "BUY", asset: "ETH", amountUSD: 60, reasoning: "test" });
    expect(result).toContain("exceeds max limit");
  });

  it("should reject zero amount", async () => {
    const result = await safeTradeHandler({ direction: "BUY", asset: "ETH", amountUSD: 0, reasoning: "test" });
    expect(result.toLowerCase()).toContain("error");
  });

  it("should reject negative amount", async () => {
    const result = await safeTradeHandler({ direction: "BUY", asset: "ETH", amountUSD: -10, reasoning: "test" });
    expect(result.toLowerCase()).toContain("error");
  });

  it("should allow valid ETH trade", async () => {
    const result = await safeTradeHandler({ direction: "BUY", asset: "ETH", amountUSD: 30, reasoning: "Buy dip" });
    expect(result.toLowerCase()).not.toContain("unauthorized");
    expect(result.toLowerCase()).not.toContain("exceeds max");
  });

  it("should allow USDC as asset", () => {
    expect(ALLOWED_ASSETS).toContain("USDC");
  });

  it("should enforce MAX_TRADE_SIZE_USD = $50", () => {
    expect(MAX_TRADE_SIZE_USD).toBe(50);
  });

  it("should log trade to DB on success", async () => {
    await safeTradeHandler({ direction: "BUY", asset: "ETH", amountUSD: 25, reasoning: "test" });
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it("should NOT log to DB when guardrail blocks", async () => {
    mockDb.insert.mockClear();
    await safeTradeHandler({ direction: "BUY", asset: "BTC", amountUSD: 30, reasoning: "test" });
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("computes pnlUSD on SELL using the most recent BUY price as anchor", async () => {
    const state = {
      id: "singleton", currentPositionETH: 0.05, currentPositionUSDC: 50,
      portfolioValueUSD: 150, lastTradePrice: 2222, isLocked: false, isOperatorPaused: false, isRunning: false,
    };
    // 4 SELECT.limit() calls for a SELL after the in-flight guard was added:
    // (1) initial balance check, (2) in-flight pause/lock guard, (3) last-BUY
    // anchor, (4) state rebuild for the upsert.
    // Note: state.lastTradePrice is intentionally bogus (2222) to prove the
    // PnL anchor comes from the tradeExecution table, NOT from agentState.
    mockDb._selectChain.limit
      .mockResolvedValueOnce([state])
      .mockResolvedValueOnce([{ isLocked: false, isOperatorPaused: false }])
      .mockResolvedValueOnce([{ price: 1900 }])
      .mockResolvedValueOnce([state]);
    mockFetch.mockResolvedValue({
      ok: true, json: async () => ({ data: { amount: "2000" } }),
    });

    await safeTradeHandler({ direction: "SELL", asset: "ETH", amountUSD: 30, reasoning: "take profit" });

    const insertedValues = mockDb._insertChain.values.mock.calls[0][0];
    // amountAsset = 30 / 2000 = 0.015 ETH
    // pnl = (2000 - 1900) * 0.015 - (30 * 0.003) = 1.5 - 0.09 = 1.41
    expect(insertedValues.pnlUSD).toBeCloseTo(1.41, 2);
  });

  it("does NOT compute pnlUSD on BUY", async () => {
    mockDb._selectChain.limit.mockResolvedValue([{
      id: "singleton", currentPositionETH: 0, currentPositionUSDC: 200,
      portfolioValueUSD: 200, lastTradePrice: null, isLocked: false, isRunning: false,
    }]);

    await safeTradeHandler({ direction: "BUY", asset: "ETH", amountUSD: 25, reasoning: "open position" });

    const insertedValues = mockDb._insertChain.values.mock.calls[0][0];
    expect(insertedValues.pnlUSD).toBeNull();
  });

  it("leaves pnlUSD null on SELL when there is no prior BUY trade", async () => {
    const state = {
      id: "singleton", currentPositionETH: 0.5, currentPositionUSDC: 50,
      portfolioValueUSD: 1050, lastTradePrice: null, isLocked: false, isOperatorPaused: false, isRunning: false,
    };
    mockDb._selectChain.limit
      .mockResolvedValueOnce([state])
      .mockResolvedValueOnce([{ isLocked: false, isOperatorPaused: false }])
      .mockResolvedValueOnce([])             // no BUY trades
      .mockResolvedValueOnce([state]);
    mockFetch.mockResolvedValue({
      ok: true, json: async () => ({ data: { amount: "2000" } }),
    });

    await safeTradeHandler({ direction: "SELL", asset: "ETH", amountUSD: 30, reasoning: "test" });

    const insertedValues = mockDb._insertChain.values.mock.calls[0][0];
    expect(insertedValues.pnlUSD).toBeNull();
  });

  it("anchors SELL PnL to the prior BUY even when the previous trade was also a SELL", async () => {
    // Regression test for the consecutive-SELL bug surfaced in code review:
    // earlier impl used agentState.lastTradePrice (which is overwritten by
    // every trade), so a SELL after a SELL would silently anchor against the
    // previous SELL price. The new impl queries for the latest BUY directly.
    const state = {
      id: "singleton", currentPositionETH: 0.04, currentPositionUSDC: 50,
      portfolioValueUSD: 130, lastTradePrice: 2050,  // <-- a recent SELL price
      isLocked: false, isOperatorPaused: false, isRunning: false,
    };
    mockDb._selectChain.limit
      .mockResolvedValueOnce([state])
      .mockResolvedValueOnce([{ isLocked: false, isOperatorPaused: false }])
      .mockResolvedValueOnce([{ price: 1800 }])  // the actual BUY anchor
      .mockResolvedValueOnce([state]);
    mockFetch.mockResolvedValue({
      ok: true, json: async () => ({ data: { amount: "2000" } }),
    });

    await safeTradeHandler({ direction: "SELL", asset: "ETH", amountUSD: 30, reasoning: "trim" });

    const insertedValues = mockDb._insertChain.values.mock.calls[0][0];
    // amountAsset = 0.015; pnl = (2000 - 1800) * 0.015 - 0.09 = 3.0 - 0.09 = 2.91
    expect(insertedValues.pnlUSD).toBeCloseTo(2.91, 2);
    // And critically, NOT (2000 - 2050) * 0.015 - 0.09 = -0.84
    expect(insertedValues.pnlUSD).toBeGreaterThan(0);
  });

  it("aborts mid-run if operator pauses agent before INSERT", async () => {
    const state = {
      id: "singleton", currentPositionETH: 0, currentPositionUSDC: 200,
      portfolioValueUSD: 200, lastTradePrice: null, isLocked: false, isOperatorPaused: false, isRunning: true,
    };
    // Initial balance check shows fine. In-flight guard then reports paused=true.
    mockDb._selectChain.limit
      .mockResolvedValueOnce([state])
      .mockResolvedValueOnce([{ isLocked: false, isOperatorPaused: true }]);

    mockDb.insert.mockClear();
    const result = await safeTradeHandler({
      direction: "BUY", asset: "ETH", amountUSD: 25, reasoning: "test",
    });

    expect(result.toLowerCase()).toContain("aborted");
    expect(result.toLowerCase()).toContain("paused");
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("aborts mid-run if drawdown safety lock engages before INSERT", async () => {
    const state = {
      id: "singleton", currentPositionETH: 0, currentPositionUSDC: 200,
      portfolioValueUSD: 200, lastTradePrice: null, isLocked: false, isOperatorPaused: false, isRunning: true,
    };
    mockDb._selectChain.limit
      .mockResolvedValueOnce([state])
      .mockResolvedValueOnce([{ isLocked: true, isOperatorPaused: false }]);

    mockDb.insert.mockClear();
    const result = await safeTradeHandler({
      direction: "BUY", asset: "ETH", amountUSD: 25, reasoning: "test",
    });

    expect(result.toLowerCase()).toContain("aborted");
    expect(result.toLowerCase()).toContain("drawdown");
    expect(mockDb.insert).not.toHaveBeenCalled();
  });
});
