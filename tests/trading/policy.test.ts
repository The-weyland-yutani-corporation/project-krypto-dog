import {
  authorizeTradeIntent,
  evaluateTradePolicy,
} from "@/trading/policy";
import { DEFAULT_STRATEGY_CONFIG } from "@/trading/strategy-config";
import type {
  TradingAccountSnapshot,
  TradingMarketSnapshot,
} from "@/trading/types";

const now = new Date("2026-07-14T12:00:00.000Z");

function account(
  overrides: Partial<TradingAccountSnapshot> = {},
): TradingAccountSnapshot {
  return {
    initialCapitalUSD: 200,
    ethBalance: 0,
    usdcBalance: 200,
    weightedCostBasisUSD: null,
    referencePriceUSD: 2000,
    lastBuyPriceUSD: null,
    dcaCount: 0,
    peakPortfolioValueUSD: 200,
    lastExecutionAt: null,
    isLocked: false,
    isOperatorPaused: false,
    accountingStatus: "RECONCILED",
    ...overrides,
  };
}

function market(
  spotPriceUSD: number,
  overrides: Partial<TradingMarketSnapshot> = {},
): TradingMarketSnapshot {
  return {
    spotPriceUSD,
    observedAt: now,
    rsi: 50,
    emaShort: 1950,
    emaLong: 2000,
    ...overrides,
  };
}

describe("evaluateTradePolicy", () => {
  it("holds on cold start and establishes a reference price", () => {
    const result = evaluateTradePolicy(
      account({ referencePriceUSD: null }),
      market(2000),
      DEFAULT_STRATEGY_CONFIG,
      now,
    );

    expect(result.shouldInvokeModel).toBe(false);
    expect(result.referencePriceToInitialize).toBe(2000);
    expect(result.holdReason).toMatch(/Cold start/);
  });

  it("permits an initial buy only after the 3% threshold", () => {
    const notTriggered = evaluateTradePolicy(
      account(),
      market(1941),
      DEFAULT_STRATEGY_CONFIG,
      now,
    );
    const triggered = evaluateTradePolicy(
      account(),
      market(1940),
      DEFAULT_STRATEGY_CONFIG,
      now,
    );

    expect(notTriggered.buy).toBeUndefined();
    expect(triggered.buy?.maximumNotionalUSD).toBe(50);
  });

  it("uses the previous buy price for DCA eligibility", () => {
    const result = evaluateTradePolicy(
      account({
        ethBalance: 0.02,
        usdcBalance: 150,
        weightedCostBasisUSD: 2000,
        lastBuyPriceUSD: 1900,
        dcaCount: 1,
      }),
      market(1843),
      DEFAULT_STRATEGY_CONFIG,
      now,
    );

    expect(result.buy).toBeDefined();
  });

  it("blocks a fourth buy in the same open-position cycle", () => {
    const result = evaluateTradePolicy(
      account({
        ethBalance: 0.02,
        usdcBalance: 150,
        weightedCostBasisUSD: 2000,
        lastBuyPriceUSD: 1900,
        dcaCount: 3,
      }),
      market(1800),
      DEFAULT_STRATEGY_CONFIG,
      now,
    );

    expect(result.buy).toBeUndefined();
  });

  it("limits buys by maximum ETH exposure", () => {
    const result = evaluateTradePolicy(
      account({
        ethBalance: 0.07,
        usdcBalance: 60,
        weightedCostBasisUSD: 1800,
        lastBuyPriceUSD: 1800,
        dcaCount: 1,
      }),
      market(1700),
      DEFAULT_STRATEGY_CONFIG,
      now,
    );

    expect(result.buy?.maximumNotionalUSD).toBeCloseTo(15.25, 8);
  });

  it("permits optional selling at 3% over weighted cost basis", () => {
    const result = evaluateTradePolicy(
      account({
        ethBalance: 0.05,
        usdcBalance: 100,
        weightedCostBasisUSD: 2000,
        lastBuyPriceUSD: 1900,
        dcaCount: 2,
      }),
      market(2060),
      DEFAULT_STRATEGY_CONFIG,
      now,
    );

    expect(result.sell).toEqual(
      expect.objectContaining({ maximumNotionalUSD: 103 }),
    );
  });

  it("returns a mandatory full stop-loss despite operator pause", () => {
    const result = evaluateTradePolicy(
      account({
        ethBalance: 0.05,
        usdcBalance: 100,
        weightedCostBasisUSD: 2000,
        isOperatorPaused: true,
      }),
      market(1700),
      DEFAULT_STRATEGY_CONFIG,
      now,
    );

    expect(result.mandatoryTrade).toEqual(
      expect.objectContaining({
        action: "SELL",
        notionalUSD: 85,
        mandatory: true,
        fullExit: true,
      }),
    );
    expect(result.shouldInvokeModel).toBe(false);
  });

  it("blocks inference for stale market data", () => {
    const result = evaluateTradePolicy(
      account(),
      market(1900, {
        observedAt: new Date(now.getTime() - 11 * 60 * 1000),
      }),
      DEFAULT_STRATEGY_CONFIG,
      now,
    );

    expect(result.shouldInvokeModel).toBe(false);
    expect(result.holdReason).toMatch(/stale/);
  });

  it("blocks inference for quarantined accounting", () => {
    const result = evaluateTradePolicy(
      account({ accountingStatus: "QUARANTINED" }),
      market(1900),
      DEFAULT_STRATEGY_CONFIG,
      now,
    );

    expect(result.holdReason).toContain("QUARANTINED");
  });

  it("blocks optional actions during cooldown", () => {
    const result = evaluateTradePolicy(
      account({
        lastExecutionAt: new Date(now.getTime() - 60 * 60 * 1000),
      }),
      market(1900),
      DEFAULT_STRATEGY_CONFIG,
      now,
    );

    expect(result.buy).toBeUndefined();
    expect(result.holdReason).toMatch(/cooldown/);
  });

  it("locks optional trading at the configured drawdown", () => {
    const result = evaluateTradePolicy(
      account({
        usdcBalance: 140,
        peakPortfolioValueUSD: 200,
      }),
      market(1900),
      DEFAULT_STRATEGY_CONFIG,
      now,
    );

    expect(result.drawdownPct).toBe(30);
    expect(result.shouldInvokeModel).toBe(false);
    expect(result.holdReason).toMatch(/drawdown/);
  });
});

describe("authorizeTradeIntent", () => {
  it("rejects a model buy above the deterministic maximum", () => {
    const evaluation = evaluateTradePolicy(
      account(),
      market(1900),
      DEFAULT_STRATEGY_CONFIG,
      now,
    );
    const result = authorizeTradeIntent(
      evaluation,
      { action: "BUY", notionalUSD: 51, reasoning: "oversold" },
      DEFAULT_STRATEGY_CONFIG,
    );

    expect(result.authorized).toBe(false);
    expect(result.reason).toMatch(/maximum/);
  });

  it("authorizes an eligible buy", () => {
    const evaluation = evaluateTradePolicy(
      account(),
      market(1900),
      DEFAULT_STRATEGY_CONFIG,
      now,
    );
    const result = authorizeTradeIntent(
      evaluation,
      { action: "BUY", notionalUSD: 25, reasoning: "oversold" },
      DEFAULT_STRATEGY_CONFIG,
    );

    expect(result).toEqual(
      expect.objectContaining({
        authorized: true,
        adjusted: false,
      }),
    );
  });

  it("rejects an ineligible sell", () => {
    const evaluation = evaluateTradePolicy(
      account(),
      market(1900),
      DEFAULT_STRATEGY_CONFIG,
      now,
    );
    const result = authorizeTradeIntent(
      evaluation,
      { action: "SELL", notionalUSD: 10, reasoning: "sell" },
      DEFAULT_STRATEGY_CONFIG,
    );

    expect(result.authorized).toBe(false);
  });

  it("expands a partial sell to full exit when it would leave dust", () => {
    const evaluation = evaluateTradePolicy(
      account({
        ethBalance: 0.01,
        usdcBalance: 190,
        weightedCostBasisUSD: 1000,
      }),
      market(1200),
      DEFAULT_STRATEGY_CONFIG,
      now,
    );
    const result = authorizeTradeIntent(
      evaluation,
      { action: "SELL", notionalUSD: 5, reasoning: "trim" },
      DEFAULT_STRATEGY_CONFIG,
    );

    expect(result).toEqual(
      expect.objectContaining({
        authorized: true,
        adjusted: true,
        intent: expect.objectContaining({
          notionalUSD: 12,
          fullExit: true,
        }),
      }),
    );
  });

  it("overrides model HOLD with a mandatory stop-loss", () => {
    const evaluation = evaluateTradePolicy(
      account({
        ethBalance: 0.05,
        usdcBalance: 100,
        weightedCostBasisUSD: 2000,
      }),
      market(1700),
      DEFAULT_STRATEGY_CONFIG,
      now,
    );
    const result = authorizeTradeIntent(
      evaluation,
      { action: "HOLD", notionalUSD: null, reasoning: "wait" },
      DEFAULT_STRATEGY_CONFIG,
    );

    expect(result).toEqual(
      expect.objectContaining({
        authorized: true,
        adjusted: true,
        intent: expect.objectContaining({ mandatory: true }),
      }),
    );
  });
});
