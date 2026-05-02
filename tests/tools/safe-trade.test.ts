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
});
