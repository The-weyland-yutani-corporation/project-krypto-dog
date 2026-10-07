import {
  createFixtureMarketDataProvider,
  getMarketDataProvider,
  setMarketDataProvider,
} from "@/lib/market-data-provider";
import { resolveDecisionProvider } from "@/agent/decision-provider";
import { DEFAULT_STRATEGY_CONFIG } from "@/trading/strategy-config";

// Additive branch coverage for the harness provider-selection and
// production-rejection seams required by the mock-first governance contract.

describe("harness market-data provider selection branches", () => {
  it("returns the deterministic crash fixture in mock mode", async () => {
    const provider = getMarketDataProvider({
      NODE_ENV: "development",
      AGENT_HARNESS_MODE: "mock",
      AGENT_HARNESS_SCENARIO: "crash",
    });
    await expect(provider.getEthSpotPrice()).resolves.toBe(1500);
  });

  it("returns the steady baseline fixture when no scenario is set", async () => {
    const provider = getMarketDataProvider({
      NODE_ENV: "development",
      AGENT_HARNESS_MODE: "mock",
    });
    await expect(provider.getEthSpotPrice()).resolves.toBe(2000);
  });

  it("falls back to the real Coinbase provider outside harness mode", () => {
    const provider = getMarketDataProvider({ NODE_ENV: "development" });
    expect(typeof provider.getEthSpotPrice).toBe("function");
  });

  it("honors an explicitly installed active provider, then restores it", async () => {
    const fixture = createFixtureMarketDataProvider([1234]);
    const restore = setMarketDataProvider(fixture);
    // The cached active provider wins regardless of env.
    const active = getMarketDataProvider({
      NODE_ENV: "development",
      AGENT_HARNESS_MODE: "mock",
      AGENT_HARNESS_SCENARIO: "crash",
    });
    await expect(active.getEthSpotPrice()).resolves.toBe(1234);
    restore();
    // After restore the harness selection logic applies again.
    const afterRestore = getMarketDataProvider({
      NODE_ENV: "development",
      AGENT_HARNESS_MODE: "mock",
    });
    await expect(afterRestore.getEthSpotPrice()).resolves.toBe(2000);
  });
});

describe("harness decision provider selection branches", () => {
  it("defaults to the real model provider when no env is passed", () => {
    // Uses process.env (test env has no harness mode) via the default param.
    const provider = resolveDecisionProvider();
    expect(typeof provider.generate).toBe("function");
  });

  it("returns a HOLD fixture with null notional when no decision is set", async () => {
    const provider = resolveDecisionProvider({
      NODE_ENV: "development",
      AGENT_HARNESS_MODE: "mock",
    });
    const result = await provider.generate({
      account: {
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
      },
      market: {
        spotPriceUSD: 2000,
        observedAt: new Date("2026-08-09T00:00:00Z"),
        rsi: 50,
        emaShort: 2000,
        emaLong: 2000,
      },
      policy: {
        portfolioValueUSD: 200,
        peakPortfolioValueUSD: 200,
        drawdownPct: 0,
        shouldInvokeModel: true,
      },
      strategy: DEFAULT_STRATEGY_CONFIG,
      recentJournalEntries: [],
    });
    expect(result.decision).toEqual({
      action: "HOLD",
      notionalUSD: null,
      reasoning: "Deterministic HOLD harness fixture",
    });
  });
});
