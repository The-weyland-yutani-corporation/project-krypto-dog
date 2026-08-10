import { readFileSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import {
  BACKTEST_REPORT_SCHEMA_VERSION,
  runBacktest,
  runBacktestObservations,
} from "@/backtest/runner";
import type { ScenarioInput } from "@/backtest/types";
import {
  ETH_SCALE,
  USD_SCALE,
  parseDecimal,
} from "@/trading/accounting";
import { calculatePaperExecution } from "@/trading/paper-execution";
import {
  authorizeTradeIntent,
  evaluateTradePolicy,
} from "@/trading/policy";
import { DEFAULT_STRATEGY_CONFIG } from "@/trading/strategy-config";

function scenario(name: string): ScenarioInput {
  const path = join(process.cwd(), "scenarios", `${name}.json`);
  return JSON.parse(readFileSync(path, "utf8")) as ScenarioInput;
}

const scenarioNames = [
  "dip-recovery",
  "sideways-chop",
  "crash-rebound",
  "steady-uptrend",
  "slow-drawdown",
  "cooldown-edge",
  "fee-slippage-recovery",
  "balance-guard",
];

describe("deterministic backtest runner", () => {
  it.each(scenarioNames)("passes fixture assertions for %s", (name) => {
    const result = runBacktest(scenario(name));
    expect(result.assertionFailures).toEqual([]);
  });

  it("produces net gains in the dip-recovery scenario after fees", () => {
    const result = runBacktest(scenario("dip-recovery"));
    expect(result.assertionFailures).toEqual([]);
    expect(result.equitySnapshots).toHaveLength(scenario("dip-recovery").prices.length);
    expect(result.equitySnapshots.at(-1)?.agentEquityUSD).toBeCloseTo(
      result.finalEquityUSD,
      8,
    );
    expect(result.beatsCash).toBe(true);
    expect(result.finalEquityUSD).toBeGreaterThan(200);
    expect(result.trades.some((trade) => trade.direction === "BUY")).toBe(true);
    expect(result.trades.some((trade) => trade.direction === "SELL")).toBe(true);
  });

  it("keeps sideways-chop drawdown bounded", () => {
    const result = runBacktest(scenario("sideways-chop"));
    expect(result.assertionFailures).toEqual([]);
    expect(result.maxDrawdownPct).toBeLessThanOrEqual(5);
  });

  it("tracks weighted-average cost basis across DCA sells", () => {
    const result = runBacktest({
      name: "weighted-cost-basis",
      prices: [2100, 2020, 1900, 1980, 2070],
      expected: { minTrades: 3, mustNotLock: true },
    });

    const sellPnls = result.trades
      .filter((trade) => trade.direction === "SELL")
      .map((trade) => trade.pnlUSD ?? 0);
    expect(sellPnls.length).toBeGreaterThan(0);
    expect(result.realisedPnlUSD).toBeCloseTo(
      sellPnls.reduce((sum, pnl) => sum + pnl, 0),
      8,
    );
  });

  it("compares against buy-and-hold separately from cash", () => {
    const result = runBacktest(scenario("dip-recovery"));
    expect(result.cashBaselineUSD).toBe(200);
    expect(result.buyHoldEquityUSD).toBeGreaterThan(200);
    expect(typeof result.beatsBuyHold).toBe("boolean");
  });

  it("supports an always-hold baseline policy", () => {
    const result = runBacktest(scenario("dip-recovery"), {
      policy: "always-hold",
    });
    expect(result.trades).toHaveLength(0);
    expect(result.finalEquityUSD).toBe(200);
    expect(result.beatsCash).toBe(false);
  });

  it("uses production policy and exact accounting for an eligible buy", () => {
    const input: ScenarioInput = {
      name: "production-parity",
      prices: [2000, 1940],
    };
    const result = runBacktest(input);
    const now = new Date("2026-01-01T04:00:00.000Z");
    const evaluation = evaluateTradePolicy(
      {
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
      {
        spotPriceUSD: 1940,
        observedAt: now,
        rsi: null,
        emaShort: null,
        emaLong: null,
      },
      DEFAULT_STRATEGY_CONFIG,
      now,
    );
    const authorization = authorizeTradeIntent(
      evaluation,
      {
        action: "BUY",
        notionalUSD: evaluation.buy?.maximumNotionalUSD ?? null,
        reasoning: "rules-basic selects the maximum eligible BUY",
      },
      DEFAULT_STRATEGY_CONFIG,
    );
    expect(authorization.authorized).toBe(true);
    if (!authorization.authorized) return;

    const calculation = calculatePaperExecution(
      {
        account: {
          ethBalance: 0n,
          usdcBalance: parseDecimal("200.00000000", USD_SCALE),
          weightedCostBasisUSD: null,
          dcaCount: 0,
        },
        direction: authorization.intent.action,
        requestedNotionalUSD: parseDecimal("50.00000000", USD_SCALE),
        observedPriceUSD: parseDecimal("1940.00000000", USD_SCALE),
        feeBps: DEFAULT_STRATEGY_CONFIG.feeBps,
        slippageBps: DEFAULT_STRATEGY_CONFIG.paperSlippageBps,
        fullExit: authorization.intent.fullExit,
        initialCapitalUSD: parseDecimal("200.00000000", USD_SCALE),
        peakPortfolioValueUSD: parseDecimal("200.00000000", USD_SCALE),
      },
      USD_SCALE,
    );

    expect(result.trades[0].direction).toBe(
      authorization.intent.action,
    );
    expect(result.trades[0].amountAsset).toBeCloseTo(
      Number(calculation.quantityETH) /
        Number(10n ** BigInt(ETH_SCALE)),
      15,
    );
    expect(result.trades[0].feesUSD).toBe(
      Number(calculation.feeUSD) /
        Number(10n ** BigInt(USD_SCALE)),
    );
    expect(result.finalEquityUSD).toBe(
      Number(calculation.portfolioValueUSD) /
        Number(10n ** BigInt(USD_SCALE)),
    );
  });

  it("defaults to production fees and nonzero paper slippage", () => {
    const result = runBacktest({
      name: "default-costs",
      prices: [2000, 1940],
    });
    const trade = result.trades[0];

    expect(result.metadata.costModel).toEqual({
      feeBps: 30,
      paperSlippageBps: 15,
    });
    expect(trade.executionPrice).toBeGreaterThan(trade.observedPrice);
    expect(trade.slippageUSD).toBeGreaterThan(0);
    expect(result.metrics.totalModeledSlippageUSD).toBe(trade.slippageUSD);
  });

  it("records post-action drawdown in the execution step", () => {
    const result = runBacktest({
      name: "post-action-drawdown",
      prices: [100, 97],
    });

    expect(result.trades).toHaveLength(1);
    expect(result.equitySnapshots[1].drawdownPct).toBeGreaterThan(0);
    expect(result.maxDrawdownPct).toBe(
      result.equitySnapshots[1].drawdownPct,
    );
    expect(result.minEquityUSD).toBe(
      result.equitySnapshots[1].agentEquityUSD,
    );
  });

  it("computes metrics and uses null for unavailable ratios", () => {
    const result = runBacktest(
      {
        name: "metric-check",
        intervalHours: 24,
        prices: [100, 97, 82, 79, 85],
      },
      { llmCostUSD: 1.25 },
    );
    const equity = result.equitySnapshots.map(
      (snapshot) => snapshot.agentEquityUSD,
    );
    const returns = equity.slice(1).map(
      (value, index) => value / equity[index] - 1,
    );
    const mean =
      returns.reduce((sum, value) => sum + value, 0) / returns.length;
    const sampleVariance =
      returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
      (returns.length - 1);
    const expectedSharpe =
      (mean / Math.sqrt(sampleVariance)) * Math.sqrt(252);
    const sellTrades = result.trades.filter(
      (trade) => trade.pnlUSD !== null,
    );
    const grossProfit = sellTrades.reduce(
      (sum, trade) => sum + Math.max(0, trade.pnlUSD ?? 0),
      0,
    );
    const grossLoss = sellTrades.reduce(
      (sum, trade) => sum + Math.max(0, -(trade.pnlUSD ?? 0)),
      0,
    );
    const averageEquity =
      equity.reduce((sum, value) => sum + value, 0) / equity.length;
    const tradedNotional = result.trades.reduce(
      (sum, trade) => sum + trade.amountUSD,
      0,
    );

    expect(result.metrics.sharpe).toBeCloseTo(expectedSharpe, 10);
    expect(result.metrics.turnover).toBeCloseTo(
      tradedNotional / averageEquity,
      10,
    );
    expect(result.metrics.profitFactor).toBeCloseTo(
      grossProfit / grossLoss,
      10,
    );
    expect(result.metrics.winRate).toBe(0.5);
    expect(result.metrics.llmCostAdjustedPnlUSD).toBeCloseTo(
      result.metrics.netPnlUSD - 1.25,
      10,
    );

    const noTrades = runBacktest(
      { name: "undefined-denominators", prices: [100, 101, 102] },
      { policy: "always-hold" },
    );
    expect(noTrades.metrics.sharpe).toBeNull();
    expect(noTrades.metrics.sortino).toBeNull();
    expect(noTrades.metrics.calmar).toBeNull();
    expect(noTrades.metrics.feeEfficiency).toBeNull();
    expect(noTrades.metrics.winRate).toBeNull();
    expect(noTrades.metrics.profitFactor).toBeNull();
    expect(noTrades.metrics.llmCostAdjustedPnlUSD).toBeNull();
  });

  it("does not compute daily returns across missing UTC calendar dates", () => {
    const prices = [100, 97, 82, 79, 85];
    const consecutive = runBacktestObservations({
      name: "consecutive-daily-spacing",
      observations: prices.map((price, index) => ({
        timestamp: new Date(
          Date.parse("2026-01-01T00:00:00.000Z") +
            index * 24 * 60 * 60 * 1000,
        ).toISOString(),
        price,
      })),
    });
    const missingDay = runBacktestObservations({
      name: "missing-daily-spacing",
      observations: prices.map((price, index) => ({
        timestamp: new Date(
          Date.parse("2026-01-01T00:00:00.000Z") +
            [0, 1, 3, 4, 5][index] * 24 * 60 * 60 * 1000,
        ).toISOString(),
        price,
      })),
    });

    expect(
      missingDay.equitySnapshots.map(
        (snapshot) => snapshot.agentEquityUSD,
      ),
    ).toEqual(
      consecutive.equitySnapshots.map(
        (snapshot) => snapshot.agentEquityUSD,
      ),
    );
    expect(consecutive.metrics.returnObservations).toBe(4);
    expect(missingDay.metrics.returnObservations).toBe(3);

    const equity = missingDay.equitySnapshots.map(
      (snapshot) => snapshot.agentEquityUSD,
    );
    const consecutiveOnlyReturns = [
      equity[1] / equity[0] - 1,
      equity[3] / equity[2] - 1,
      equity[4] / equity[3] - 1,
    ];
    const mean =
      consecutiveOnlyReturns.reduce(
        (sum, value) => sum + value,
        0,
      ) / consecutiveOnlyReturns.length;
    const sampleVariance =
      consecutiveOnlyReturns.reduce(
        (sum, value) => sum + (value - mean) ** 2,
        0,
      ) /
      (consecutiveOnlyReturns.length - 1);
    expect(missingDay.metrics.sharpe).toBeCloseTo(
      (mean / Math.sqrt(sampleVariance)) * Math.sqrt(252),
      10,
    );
  });

  it.each([
    [
      "exact 24-hour spacing",
      "2026-01-01T12:00:00.000Z",
      "2026-01-02T12:00:00.000Z",
      1,
    ],
    [
      "16-hour adjacent-date spacing",
      "2026-01-01T20:00:00.000Z",
      "2026-01-02T12:00:00.000Z",
      0,
    ],
    [
      "32-hour adjacent-date spacing",
      "2026-01-01T12:00:00.000Z",
      "2026-01-02T20:00:00.000Z",
      0,
    ],
    [
      "47-hour adjacent-date spacing",
      "2026-01-01T00:00:00.000Z",
      "2026-01-02T23:00:00.000Z",
      0,
    ],
  ] as Array<[string, string, string, number]>)(
    "counts daily returns only for %s",
    (_description, firstTimestamp, secondTimestamp, expectedReturns) => {
      const result = runBacktestObservations({
        name: "close-spacing-check",
        policy: "always-hold",
        observations: [
          { timestamp: firstTimestamp, price: 100 },
          { timestamp: secondTimestamp, price: 101 },
        ],
      });

      expect(result.metrics.returnObservations).toBe(
        expectedReturns,
      );
    },
  );

  it("emits a machine-readable all-scenario aggregate", () => {
    const output = execFileSync(
      "npm",
      ["run", "--silent", "backtest:all"],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    const report = JSON.parse(output) as {
      reportSchemaVersion: string;
      engineeringAssertions: {
        passedScenarios: number;
        failedScenarios: number;
        failures: unknown[];
      };
      financialEvidenceSummary: {
        classification: string;
        scenarioCount: number;
        historicalOrWalkForwardEvidence: boolean;
      };
      results: unknown[];
    };

    expect(report.reportSchemaVersion).toBe(
      BACKTEST_REPORT_SCHEMA_VERSION,
    );
    expect(report.engineeringAssertions).toEqual({
      passedScenarios: scenarioNames.length,
      failedScenarios: 0,
      failures: [],
    });
    expect(report.financialEvidenceSummary).toEqual(
      expect.objectContaining({
        classification: "engineering-fixtures-only",
        scenarioCount: scenarioNames.length,
        historicalOrWalkForwardEvidence: false,
      }),
    );
    expect(report.results).toHaveLength(scenarioNames.length);
  });
});
