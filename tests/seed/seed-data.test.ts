// Mock postgres and drizzle to prevent DB connection on seed import
jest.mock("postgres", () => jest.fn(() => jest.fn()));
jest.mock("drizzle-orm/postgres-js", () => ({
  drizzle: jest.fn(() => ({})),
}));

import { TRADES, JOURNALS, FINAL_AGENT_STATE } from "../../prisma/seed";
import {
  MAX_TRADE_SIZE_USD,
  ALLOWED_ASSETS,
  MAX_DCA_COUNT,
  INITIAL_CAPITAL_USD,
} from "@/lib/config";

beforeEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// 1. Guardrail Compliance
// ---------------------------------------------------------------------------
describe("Guardrail Compliance", () => {
  it("every BUY trade amountUSD must be ≤ MAX_TRADE_SIZE_USD ($50)", () => {
    const buyTrades = TRADES.filter((t) => t.direction === "BUY");
    for (const t of buyTrades) {
      expect(t.amountUSD).toBeLessThanOrEqual(MAX_TRADE_SIZE_USD);
    }
  });

  it("every trade amountUSD must be > 0", () => {
    for (const t of TRADES) {
      expect(t.amountUSD).toBeGreaterThan(0);
    }
  });

  it("every trade asset must be in ALLOWED_ASSETS", () => {
    const allowed = ALLOWED_ASSETS as readonly string[];
    for (const t of TRADES) {
      expect(allowed).toContain(t.asset);
    }
  });

  it("no more than MAX_DCA_COUNT consecutive BUY trades without a SELL", () => {
    let consecutiveBuys = 0;
    for (const t of TRADES) {
      if (t.direction === "BUY") {
        consecutiveBuys++;
        expect(consecutiveBuys).toBeLessThanOrEqual(MAX_DCA_COUNT);
      } else {
        consecutiveBuys = 0;
      }
    }
  });

  it("trades must be at least 2 hours apart (cooldown)", () => {
    const cooldownHours = 2;
    for (let i = 1; i < TRADES.length; i++) {
      const gap = TRADES[i - 1].hoursAgo - TRADES[i].hoursAgo;
      expect(gap).toBeGreaterThanOrEqual(cooldownHours);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Trade Data Integrity
// ---------------------------------------------------------------------------
describe("Trade Data Integrity", () => {
  it("every trade must have a non-empty agentReasoning", () => {
    for (const t of TRADES) {
      expect(t.agentReasoning.length).toBeGreaterThan(0);
    }
  });

  it("executionPrice must be > 0 for all trades", () => {
    for (const t of TRADES) {
      expect(t.executionPrice).toBeGreaterThan(0);
    }
  });

  it("amountAsset must be > 0 for all trades", () => {
    for (const t of TRADES) {
      expect(t.amountAsset).toBeGreaterThan(0);
    }
  });

  it("feesUSD must be ≥ 0 for all trades", () => {
    for (const t of TRADES) {
      expect(t.feesUSD).toBeGreaterThanOrEqual(0);
    }
  });

  it("slippage must be ≥ 0 and < 0.1 for all trades", () => {
    for (const t of TRADES) {
      expect(t.slippage).toBeGreaterThanOrEqual(0);
      expect(t.slippage).toBeLessThan(0.1);
    }
  });

  it("BUY trades should have pnlUSD as null (unrealized)", () => {
    const buys = TRADES.filter((t) => t.direction === "BUY");
    for (const t of buys) {
      expect(t.pnlUSD).toBeNull();
    }
  });

  it("SELL trades should have pnlUSD as a number (realized)", () => {
    const sells = TRADES.filter((t) => t.direction === "SELL");
    for (const t of sells) {
      expect(typeof t.pnlUSD).toBe("number");
    }
  });

  it("trade directions should alternate in a sensible pattern", () => {
    const buys = TRADES.filter((t) => t.direction === "BUY").length;
    const sells = TRADES.filter((t) => t.direction === "SELL").length;
    expect(buys).toBeGreaterThan(0);
    expect(sells).toBeGreaterThan(0);
    // Not all one direction
    expect(buys).not.toBe(TRADES.length);
    expect(sells).not.toBe(TRADES.length);
  });
});

// ---------------------------------------------------------------------------
// 3. Journal Data Integrity
// ---------------------------------------------------------------------------
describe("Journal Data Integrity", () => {
  it("every journal entry must have non-empty entryText", () => {
    for (const j of JOURNALS) {
      expect(j.entryText.length).toBeGreaterThan(0);
    }
  });

  it("ethPrice must be > 0 in all journal entries", () => {
    for (const j of JOURNALS) {
      expect(j.ethPrice).toBeGreaterThan(0);
    }
  });

  it("rsi must be between 0 and 100", () => {
    for (const j of JOURNALS) {
      expect(j.rsi).toBeGreaterThanOrEqual(0);
      expect(j.rsi).toBeLessThanOrEqual(100);
    }
  });

  it("emaShort and emaLong must be > 0", () => {
    for (const j of JOURNALS) {
      expect(j.emaShort).toBeGreaterThan(0);
      expect(j.emaLong).toBeGreaterThan(0);
    }
  });

  it('emaCrossover must be one of "bullish", "bearish", "neutral"', () => {
    const valid = ["bullish", "bearish", "neutral"];
    for (const j of JOURNALS) {
      expect(valid).toContain(j.emaCrossover);
    }
  });

  it("journal entries with tradeIndex must reference a valid TRADES index", () => {
    const linked = JOURNALS.filter((j) => j.tradeIndex !== null);
    for (const j of linked) {
      expect(j.tradeIndex).toBeGreaterThanOrEqual(0);
      expect(j.tradeIndex!).toBeLessThan(TRADES.length);
    }
  });

  it("there should be some observation-only journal entries (tradeIndex === null)", () => {
    const observations = JOURNALS.filter((j) => j.tradeIndex === null);
    expect(observations.length).toBeGreaterThan(0);
  });

  it("there should be more journal entries than trades", () => {
    expect(JOURNALS.length).toBeGreaterThan(TRADES.length);
  });
});

// ---------------------------------------------------------------------------
// 4. Chronological Consistency
// ---------------------------------------------------------------------------
describe("Chronological Consistency", () => {
  it("trades must be in chronological order (hoursAgo decreasing)", () => {
    for (let i = 1; i < TRADES.length; i++) {
      expect(TRADES[i - 1].hoursAgo).toBeGreaterThan(TRADES[i].hoursAgo);
    }
  });

  it("journals must be in chronological order (hoursAgo decreasing)", () => {
    for (let i = 1; i < JOURNALS.length; i++) {
      expect(JOURNALS[i - 1].hoursAgo).toBeGreaterThan(JOURNALS[i].hoursAgo);
    }
  });

  it("journal entries linked to a trade should have matching hoursAgo", () => {
    const linked = JOURNALS.filter((j) => j.tradeIndex !== null);
    for (const j of linked) {
      const trade = TRADES[j.tradeIndex!];
      expect(Math.abs(j.hoursAgo - trade.hoursAgo)).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Portfolio Math Consistency
// ---------------------------------------------------------------------------
describe("Portfolio Math Consistency", () => {
  it("walking through all trades should produce the correct final balances", () => {
    let usdc = INITIAL_CAPITAL_USD; // $200
    let eth = 0;

    for (const t of TRADES) {
      if (t.direction === "BUY") {
        usdc -= t.amountUSD;
        eth += t.amountAsset;
      } else {
        usdc += t.amountUSD - t.feesUSD;
        eth -= t.amountAsset;
      }
    }

    // Within $1 rounding tolerance
    expect(usdc).toBeCloseTo(FINAL_AGENT_STATE.currentPositionUSDC, 0);
    expect(eth).toBeCloseTo(FINAL_AGENT_STATE.currentPositionETH, 4);
  });

  it("FINAL_AGENT_STATE.portfolioValueUSD ≈ ETH * lastKnownPrice + USDC", () => {
    // Last known ETH price from the final journal entry
    const lastJournal = JOURNALS[JOURNALS.length - 1];
    const expectedValue =
      FINAL_AGENT_STATE.currentPositionETH * lastJournal.ethPrice +
      FINAL_AGENT_STATE.currentPositionUSDC;

    expect(FINAL_AGENT_STATE.portfolioValueUSD).toBeCloseTo(
      expectedValue,
      0,
    );
  });

  it("total realized P&L ≈ final portfolio value - initial capital (within $2)", () => {
    const totalPnL = TRADES.reduce(
      (sum, t) => sum + (t.pnlUSD ?? 0),
      0,
    );

    const portfolioChange =
      FINAL_AGENT_STATE.portfolioValueUSD - INITIAL_CAPITAL_USD;

    // The difference accounts for unrealized P&L and fees
    expect(Math.abs(totalPnL - portfolioChange)).toBeLessThan(2);
  });
});

// ---------------------------------------------------------------------------
// 6. Scenario Coverage
// ---------------------------------------------------------------------------
describe("Scenario Coverage", () => {
  it("there should be at least one stop-loss trade (SELL with negative pnlUSD)", () => {
    const stopLoss = TRADES.filter(
      (t) => t.direction === "SELL" && t.pnlUSD !== null && t.pnlUSD < 0,
    );
    expect(stopLoss.length).toBeGreaterThanOrEqual(1);
  });

  it("there should be at least one profitable SELL trade (positive pnlUSD)", () => {
    const profitable = TRADES.filter(
      (t) => t.direction === "SELL" && t.pnlUSD !== null && t.pnlUSD > 0,
    );
    expect(profitable.length).toBeGreaterThanOrEqual(1);
  });

  it("there should be at least one DCA sequence (2+ consecutive BUYs)", () => {
    let maxConsecutiveBuys = 0;
    let current = 0;
    for (const t of TRADES) {
      if (t.direction === "BUY") {
        current++;
        maxConsecutiveBuys = Math.max(maxConsecutiveBuys, current);
      } else {
        current = 0;
      }
    }
    expect(maxConsecutiveBuys).toBeGreaterThanOrEqual(2);
  });

  it("RSI values should span a realistic range (some oversold, some overbought-ish)", () => {
    const rsis = JOURNALS.map((j) => j.rsi);
    const hasOversold = rsis.some((r) => r < 30);
    const hasOverboughtish = rsis.some((r) => r > 60);
    expect(hasOversold).toBe(true);
    expect(hasOverboughtish).toBe(true);
  });

  it('both "bullish" and "bearish" crossovers should appear', () => {
    const crossovers = JOURNALS.map((j) => j.emaCrossover);
    expect(crossovers).toContain("bullish");
    expect(crossovers).toContain("bearish");
  });
});
