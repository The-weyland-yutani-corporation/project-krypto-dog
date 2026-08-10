import {
  ETH_SCALE,
  USD_SCALE,
  formatDecimal,
  notionalForQuantity,
  parseDecimal,
} from "@/trading/accounting";
import {
  calculateDrawdownPct,
  calculatePaperExecution,
} from "@/trading/paper-execution";
import { authorizeTradeIntent, evaluateTradePolicy } from "@/trading/policy";
import {
  DEFAULT_STRATEGY_CONFIG,
  type StrategyConfig,
} from "@/trading/strategy-config";
import type {
  PolicyEvaluation,
  TradeDecision,
  TradingAccountSnapshot,
} from "@/trading/types";
import type {
  BacktestAggregateReport,
  BacktestDecisionSource,
  BacktestMetrics,
  BacktestObservation,
  BacktestOptions,
  BacktestResult,
  BacktestTrade,
  ExplicitBacktestInput,
  ScenarioInput,
} from "./types";
import { canonicalSha256 } from "./canonical";

interface BacktestState {
  ethBalance: bigint;
  usdcBalance: bigint;
  weightedCostBasisUSD: bigint | null;
  referencePriceUSD: number | null;
  lastBuyPriceUSD: number | null;
  lastTradeAt: Date | null;
  dcaCount: number;
  peakPortfolioValueUSD: bigint;
  locked: boolean;
  realisedPnlUSD: bigint;
  totalFeesUSD: bigint;
  totalSlippageUSD: bigint;
  trades: BacktestTrade[];
}

interface NormalizedPoint {
  timestamp: Date;
  price: number;
  priceUSD: bigint;
}

type BacktestDefinition = Pick<
  ScenarioInput,
  "name" | "datasetId" | "policy" | "expected"
>;

const DEFAULT_INTERVAL_HOURS = 4;
export const BACKTEST_CODE_VERSION = "align-backtesting-v1";
export const BACKTEST_REPORT_SCHEMA_VERSION = "1.0.0";
export const BACKTEST_COST_MODEL_VERSION = "paper-execution-v1";

function decimalNumber(value: bigint, scale: number): number {
  return Number(formatDecimal(value, scale));
}

function usd(value: number, field: string): bigint {
  if (!Number.isFinite(value)) {
    throw new Error(`${field} must be finite`);
  }
  return parseDecimal(value.toFixed(USD_SCALE), USD_SCALE);
}

function fractionToBps(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${field} must be between 0 and 1`);
  }
  const bps = value * 10_000;
  if (!Number.isInteger(bps)) {
    throw new Error(`${field} must resolve to whole basis points`);
  }
  return bps;
}

function normalizeScenario(scenario: ScenarioInput): NormalizedPoint[] {
  if (scenario.prices.length < 2) {
    throw new Error("Backtest scenario requires at least two prices");
  }
  const start = new Date(scenario.start ?? "2026-01-01T00:00:00.000Z");
  if (!Number.isFinite(start.getTime())) {
    throw new Error("Backtest scenario start must be a valid timestamp");
  }
  const intervalHours = scenario.intervalHours ?? DEFAULT_INTERVAL_HOURS;
  if (!Number.isFinite(intervalHours) || intervalHours <= 0) {
    throw new Error("Backtest scenario intervalHours must be positive");
  }
  const intervalMs = intervalHours * 60 * 60 * 1000;

  return scenario.prices.map((price, index) => {
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`Invalid scenario price at index ${index}: ${price}`);
    }
    return {
      timestamp: new Date(start.getTime() + index * intervalMs),
      price,
      priceUSD: usd(price, `price at index ${index}`),
    };
  });
}

function normalizeObservations(
  observations: BacktestObservation[],
): NormalizedPoint[] {
  if (observations.length < 2) {
    throw new Error("Backtest observations require at least two prices");
  }
  let previousTimestamp = -Infinity;
  return observations.map((observation, index) => {
    const timestamp = new Date(observation.timestamp);
    if (!Number.isFinite(timestamp.getTime())) {
      throw new Error(
        `Invalid observation timestamp at index ${index}: ${observation.timestamp}`,
      );
    }
    if (timestamp.getTime() <= previousTimestamp) {
      throw new Error(
        "Backtest observation timestamps must be strictly ascending without duplicates",
      );
    }
    previousTimestamp = timestamp.getTime();
    if (!Number.isFinite(observation.price) || observation.price <= 0) {
      throw new Error(
        `Invalid observation price at index ${index}: ${observation.price}`,
      );
    }
    return {
      timestamp,
      price: observation.price,
      priceUSD: usd(
        observation.price,
        `observation price at index ${index}`,
      ),
    };
  });
}

function resolveStrategy(options: BacktestOptions): StrategyConfig {
  const initialCapitalUSD =
    options.initialCapitalUSD ?? DEFAULT_STRATEGY_CONFIG.initialCapitalUSD;
  const maximumTradeUSD =
    options.maxTradeSizeUSD ??
    initialCapitalUSD *
      DEFAULT_STRATEGY_CONFIG.maximumTradeFractionOfInitialCapital;
  if (initialCapitalUSD <= 0 || maximumTradeUSD <= 0) {
    throw new Error("Backtest capital and maximum trade size must be positive");
  }

  return {
    ...DEFAULT_STRATEGY_CONFIG,
    initialCapitalUSD,
    minimumTradeUSD:
      options.minTradeSizeUSD ?? DEFAULT_STRATEGY_CONFIG.minimumTradeUSD,
    maximumTradeFractionOfInitialCapital:
      maximumTradeUSD / initialCapitalUSD,
    feeBps:
      options.feeRate === undefined
        ? DEFAULT_STRATEGY_CONFIG.feeBps
        : fractionToBps(options.feeRate, "feeRate"),
    paperSlippageBps:
      options.slippagePct === undefined
        ? DEFAULT_STRATEGY_CONFIG.paperSlippageBps
        : fractionToBps(options.slippagePct, "slippagePct"),
    buyTriggerFraction:
      options.buyTriggerPct ??
      DEFAULT_STRATEGY_CONFIG.buyTriggerFraction,
    takeProfitFraction:
      options.sellTriggerPct ??
      DEFAULT_STRATEGY_CONFIG.takeProfitFraction,
    stopLossFraction:
      options.stopLossPct ?? DEFAULT_STRATEGY_CONFIG.stopLossFraction,
    maximumDcaEntries:
      options.maxDcaCount ?? DEFAULT_STRATEGY_CONFIG.maximumDcaEntries,
    cooldownMs: options.cooldownMs ?? DEFAULT_STRATEGY_CONFIG.cooldownMs,
    maximumDrawdownPct:
      options.maximumDrawdownPct ??
      DEFAULT_STRATEGY_CONFIG.maximumDrawdownPct,
  };
}

function configurationVersion(strategy: StrategyConfig): string {
  return `sha256:${canonicalSha256(strategy)}`;
}

function costModelVersion(strategy: StrategyConfig): string {
  return [
    BACKTEST_COST_MODEL_VERSION,
    `fee-${strategy.feeBps}bps`,
    `slippage-${strategy.paperSlippageBps}bps`,
  ].join(":");
}

function portfolioValue(state: BacktestState, priceUSD: bigint): bigint {
  return (
    state.usdcBalance +
    notionalForQuantity(state.ethBalance, priceUSD)
  );
}

function toPolicyAccount(
  state: BacktestState,
  strategy: StrategyConfig,
): TradingAccountSnapshot {
  return {
    initialCapitalUSD: strategy.initialCapitalUSD,
    ethBalance: decimalNumber(state.ethBalance, ETH_SCALE),
    usdcBalance: decimalNumber(state.usdcBalance, USD_SCALE),
    weightedCostBasisUSD:
      state.weightedCostBasisUSD === null
        ? null
        : decimalNumber(state.weightedCostBasisUSD, USD_SCALE),
    referencePriceUSD: state.referencePriceUSD,
    lastBuyPriceUSD: state.lastBuyPriceUSD,
    dcaCount: state.dcaCount,
    peakPortfolioValueUSD: decimalNumber(
      state.peakPortfolioValueUSD,
      USD_SCALE,
    ),
    lastExecutionAt: state.lastTradeAt,
    isLocked: state.locked,
    isOperatorPaused: false,
    accountingStatus: "RECONCILED",
  };
}

function chooseDecision(
  source: BacktestDecisionSource,
  evaluation: PolicyEvaluation,
): TradeDecision {
  if (source === "rules-basic") {
    if (evaluation.sell) {
      return {
        action: "SELL",
        notionalUSD: evaluation.sell.maximumNotionalUSD,
        reasoning:
          "rules-basic selects the maximum eligible SELL before considering BUY",
      };
    }
    if (evaluation.buy) {
      return {
        action: "BUY",
        notionalUSD: evaluation.buy.maximumNotionalUSD,
        reasoning: "rules-basic selects the maximum eligible BUY",
      };
    }
  }
  return {
    action: "HOLD",
    notionalUSD: null,
    reasoning:
      source === "always-hold"
        ? "always-hold rejects all optional actions"
        : evaluation.holdReason ?? "No eligible action",
  };
}

function sampleStandardDeviation(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    (values.length - 1);
  return variance > 0 ? Math.sqrt(variance) : null;
}

function finiteRatio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  if (Math.abs(denominator) <= Number.EPSILON) return null;
  const result = numerator / denominator;
  return Number.isFinite(result) ? result : null;
}

function calculateMetrics(
  result: {
    initialCapitalUSD: number;
    finalEquityUSD: number;
    buyHoldEquityUSD: number;
    totalFeesUSD: number;
    maxDrawdownPct: number;
    totalSlippageUSD: number;
    trades: BacktestTrade[];
    equitySnapshots: BacktestResult["equitySnapshots"];
    durationMs: number;
  },
  llmCostUSD: number | undefined,
): BacktestMetrics {
  if (
    llmCostUSD !== undefined &&
    (!Number.isFinite(llmCostUSD) || llmCostUSD < 0)
  ) {
    throw new Error("llmCostUSD must be finite and non-negative");
  }
  const dailyCloses = new Map<
    string,
    { timestampMs: number; equity: number }
  >();
  for (const snapshot of result.equitySnapshots) {
    dailyCloses.set(snapshot.timestamp.slice(0, 10), {
      timestampMs: Date.parse(snapshot.timestamp),
      equity: snapshot.agentEquityUSD,
    });
  }
  const dailyEquity = [...dailyCloses.values()];
  const returns: number[] = [];
  for (let index = 1; index < dailyEquity.length; index++) {
    const prior = dailyEquity[index - 1];
    const current = dailyEquity[index];
    if (
      current.timestampMs - prior.timestampMs !==
      24 * 60 * 60 * 1000
    ) {
      continue;
    }
    returns.push(
      prior.equity > 0 ? current.equity / prior.equity - 1 : 0,
    );
  }
  const meanReturn =
    returns.length > 0
      ? returns.reduce((sum, value) => sum + value, 0) / returns.length
      : 0;
  const standardDeviation = sampleStandardDeviation(returns);
  const sharpe =
    standardDeviation === null
      ? null
      : finiteRatio(
          meanReturn * Math.sqrt(252),
          standardDeviation,
        );
  const downsideDeviation =
    returns.length === 0
      ? 0
      : Math.sqrt(
          returns.reduce(
            (sum, value) => sum + Math.min(0, value) ** 2,
            0,
          ) / returns.length,
        );
  const sortino = finiteRatio(
    meanReturn * Math.sqrt(252),
    downsideDeviation,
  );
  const years = result.durationMs / (365.25 * 24 * 60 * 60 * 1000);
  const annualizedReturn =
    years > 0 && result.initialCapitalUSD > 0 && result.finalEquityUSD >= 0
      ? (result.finalEquityUSD / result.initialCapitalUSD) ** (1 / years) - 1
      : null;
  const calmar =
    annualizedReturn === null
      ? null
      : finiteRatio(annualizedReturn, result.maxDrawdownPct / 100);
  const averageEquity =
    result.equitySnapshots.reduce(
      (sum, snapshot) => sum + snapshot.agentEquityUSD,
      0,
    ) / result.equitySnapshots.length;
  const tradedNotional = result.trades.reduce(
    (sum, trade) => sum + trade.amountUSD,
    0,
  );
  const netPnlUSD = result.finalEquityUSD - result.initialCapitalUSD;
  const exits = result.trades.filter(
    (trade): trade is BacktestTrade & { pnlUSD: number } =>
      trade.direction === "SELL" && trade.pnlUSD !== null,
  );
  const winningExits = exits.filter((trade) => trade.pnlUSD > 0);
  const grossProfit = winningExits.reduce(
    (sum, trade) => sum + trade.pnlUSD,
    0,
  );
  const grossLoss = exits
    .filter((trade) => trade.pnlUSD < 0)
    .reduce((sum, trade) => sum + Math.abs(trade.pnlUSD), 0);
  const strategyReturn = netPnlUSD / result.initialCapitalUSD;
  const benchmarkReturn =
    result.buyHoldEquityUSD / result.initialCapitalUSD - 1;

  return {
    netPnlUSD,
    sharpe,
    sortino,
    calmar,
    turnover: finiteRatio(tradedNotional, averageEquity),
    feeEfficiency: finiteRatio(
      netPnlUSD,
      result.totalFeesUSD + result.totalSlippageUSD,
    ),
    winRate:
      exits.length === 0 ? null : winningExits.length / exits.length,
    profitFactor: finiteRatio(grossProfit, grossLoss),
    benchmarkAlphaPct: (strategyReturn - benchmarkReturn) * 100,
    totalModeledSlippageUSD: result.totalSlippageUSD,
    llmCostUSD: llmCostUSD ?? null,
    llmCostAdjustedPnlUSD:
      llmCostUSD === undefined ? null : netPnlUSD - llmCostUSD,
    returnObservations: returns.length,
  };
}

function evaluateAssertions(
  scenario: BacktestDefinition,
  result: Omit<BacktestResult, "assertionFailures">,
): string[] {
  const expected = scenario.expected;
  if (!expected) return [];
  const failures: string[] = [];
  if (
    expected.minFinalEquity !== undefined &&
    result.finalEquityUSD < expected.minFinalEquity
  ) {
    failures.push(
      `final equity ${result.finalEquityUSD.toFixed(2)} < expected ${expected.minFinalEquity.toFixed(2)}`,
    );
  }
  if (expected.mustBeatCash && !result.beatsCash) {
    failures.push("did not beat cash baseline");
  }
  if (expected.mustBeatBuyHold && !result.beatsBuyHold) {
    failures.push("did not beat buy-and-hold baseline");
  }
  if (
    expected.maxDrawdownPct !== undefined &&
    result.maxDrawdownPct > expected.maxDrawdownPct
  ) {
    failures.push(
      `max drawdown ${result.maxDrawdownPct.toFixed(2)}% > expected ${expected.maxDrawdownPct.toFixed(2)}%`,
    );
  }
  if (expected.minTrades !== undefined && result.trades.length < expected.minTrades) {
    failures.push(`trade count ${result.trades.length} < expected ${expected.minTrades}`);
  }
  if (expected.maxTrades !== undefined && result.trades.length > expected.maxTrades) {
    failures.push(`trade count ${result.trades.length} > expected ${expected.maxTrades}`);
  }
  if (expected.mustNotLock && result.locked) {
    failures.push("strategy locked during scenario");
  }
  return failures;
}

function runBacktestPoints(
  scenario: BacktestDefinition,
  points: NormalizedPoint[],
  options: BacktestOptions,
): BacktestResult {
  const strategy = resolveStrategy(options);
  const decisionSource =
    options.policy ?? scenario.policy ?? "rules-basic";
  const initialCapitalUSD = usd(
    strategy.initialCapitalUSD,
    "initialCapitalUSD",
  );
  const state: BacktestState = {
    ethBalance: 0n,
    usdcBalance: initialCapitalUSD,
    weightedCostBasisUSD: null,
    referencePriceUSD: null,
    lastBuyPriceUSD: null,
    lastTradeAt: null,
    dcaCount: 0,
    peakPortfolioValueUSD: initialCapitalUSD,
    locked: false,
    realisedPnlUSD: 0n,
    totalFeesUSD: 0n,
    totalSlippageUSD: 0n,
    trades: [],
  };
  let maxDrawdownPct = 0;
  let minEquityUSD = strategy.initialCapitalUSD;
  const equitySnapshots: BacktestResult["equitySnapshots"] = [];

  for (const point of points) {
    const markedEquity = portfolioValue(state, point.priceUSD);
    if (markedEquity > state.peakPortfolioValueUSD) {
      state.peakPortfolioValueUSD = markedEquity;
    }
    const preActionDrawdown = decimalNumber(
      calculateDrawdownPct(
        state.peakPortfolioValueUSD,
        markedEquity,
        USD_SCALE,
      ),
      USD_SCALE,
    );
    if (preActionDrawdown >= strategy.maximumDrawdownPct) {
      state.locked = true;
    }

    const evaluation = evaluateTradePolicy(
      toPolicyAccount(state, strategy),
      {
        spotPriceUSD: point.price,
        observedAt: point.timestamp,
        rsi: null,
        emaShort: null,
        emaLong: null,
      },
      strategy,
      point.timestamp,
    );
    if (evaluation.referencePriceToInitialize !== undefined) {
      state.referencePriceUSD = evaluation.referencePriceToInitialize;
    }
    const decision = chooseDecision(decisionSource, evaluation);
    const authorization = authorizeTradeIntent(
      evaluation,
      decision,
      strategy,
    );

    if (authorization.authorized) {
      const requestedNotionalUSD = usd(
        authorization.intent.notionalUSD,
        "authorized notional",
      );
      const calculation = calculatePaperExecution(
        {
          account: {
            ethBalance: state.ethBalance,
            usdcBalance: state.usdcBalance,
            weightedCostBasisUSD: state.weightedCostBasisUSD,
            dcaCount: state.dcaCount,
          },
          direction: authorization.intent.action,
          requestedNotionalUSD,
          observedPriceUSD: point.priceUSD,
          feeBps: strategy.feeBps,
          slippageBps: strategy.paperSlippageBps,
          fullExit: authorization.intent.fullExit,
          initialCapitalUSD,
          peakPortfolioValueUSD: state.peakPortfolioValueUSD,
        },
        USD_SCALE,
      );
      state.ethBalance = calculation.transition.after.ethBalance;
      state.usdcBalance = calculation.transition.after.usdcBalance;
      state.weightedCostBasisUSD =
        calculation.transition.after.weightedCostBasisUSD;
      state.dcaCount = calculation.transition.after.dcaCount;
      state.peakPortfolioValueUSD = calculation.peakPortfolioValueUSD;
      state.lastTradeAt = point.timestamp;
      state.totalFeesUSD += calculation.feeUSD;
      state.totalSlippageUSD += calculation.slippageUSD;
      if (calculation.transition.realizedPnlUSD !== null) {
        state.realisedPnlUSD += calculation.transition.realizedPnlUSD;
      }
      if (authorization.intent.action === "BUY") {
        state.lastBuyPriceUSD = decimalNumber(
          calculation.executionPriceUSD,
          USD_SCALE,
        );
      } else if (authorization.intent.fullExit) {
        state.referencePriceUSD = decimalNumber(
          calculation.executionPriceUSD,
          USD_SCALE,
        );
        state.lastBuyPriceUSD = null;
      }
      state.trades.push({
        timestamp: point.timestamp.toISOString(),
        direction: authorization.intent.action,
        amountUSD: decimalNumber(
          calculation.grossNotionalUSD,
          USD_SCALE,
        ),
        amountAsset: decimalNumber(calculation.quantityETH, ETH_SCALE),
        observedPrice: point.price,
        executionPrice: decimalNumber(
          calculation.executionPriceUSD,
          USD_SCALE,
        ),
        feesUSD: decimalNumber(calculation.feeUSD, USD_SCALE),
        slippageUSD: decimalNumber(
          calculation.slippageUSD,
          USD_SCALE,
        ),
        pnlUSD:
          calculation.transition.realizedPnlUSD === null
            ? null
            : decimalNumber(
                calculation.transition.realizedPnlUSD,
                USD_SCALE,
              ),
        reason: authorization.intent.reasoning,
      });
    }

    const postActionEquity = portfolioValue(state, point.priceUSD);
    if (postActionEquity > state.peakPortfolioValueUSD) {
      state.peakPortfolioValueUSD = postActionEquity;
    }
    const postActionDrawdown = decimalNumber(
      calculateDrawdownPct(
        state.peakPortfolioValueUSD,
        postActionEquity,
        USD_SCALE,
      ),
      USD_SCALE,
    );
    maxDrawdownPct = Math.max(maxDrawdownPct, postActionDrawdown);
    const postActionEquityNumber = decimalNumber(
      postActionEquity,
      USD_SCALE,
    );
    minEquityUSD = Math.min(minEquityUSD, postActionEquityNumber);
    equitySnapshots.push({
      timestamp: point.timestamp.toISOString(),
      price: point.price,
      agentEquityUSD: postActionEquityNumber,
      cashEquityUSD: strategy.initialCapitalUSD,
      buyHoldEquityUSD:
        (strategy.initialCapitalUSD / points[0].price) * point.price,
      drawdownPct: postActionDrawdown,
    });
  }

  const finalPoint = points[points.length - 1];
  const finalEquityUSD =
    equitySnapshots[equitySnapshots.length - 1].agentEquityUSD;
  const weightedCostBasisUSD =
    state.weightedCostBasisUSD === null
      ? 0
      : decimalNumber(state.weightedCostBasisUSD, USD_SCALE);
  const ethBalance = decimalNumber(state.ethBalance, ETH_SCALE);
  const unrealisedPnlUSD =
    state.weightedCostBasisUSD === null
      ? 0
      : (finalPoint.price - weightedCostBasisUSD) * ethBalance;
  const buyHoldEquityUSD =
    (strategy.initialCapitalUSD / points[0].price) * finalPoint.price;
  const totalFeesUSD = decimalNumber(state.totalFeesUSD, USD_SCALE);
  const totalSlippageUSD = decimalNumber(
    state.totalSlippageUSD,
    USD_SCALE,
  );
  const metrics = calculateMetrics(
    {
      initialCapitalUSD: strategy.initialCapitalUSD,
      finalEquityUSD,
      buyHoldEquityUSD,
      totalFeesUSD,
      maxDrawdownPct,
      totalSlippageUSD,
      trades: state.trades,
      equitySnapshots,
      durationMs:
        finalPoint.timestamp.getTime() - points[0].timestamp.getTime(),
    },
    options.llmCostUSD,
  );
  const resultWithoutAssertions: Omit<
    BacktestResult,
    "assertionFailures"
  > = {
    metadata: {
      strategyVersion: strategy.version,
      configurationVersion: configurationVersion(strategy),
      costModelVersion: costModelVersion(strategy),
      costModel: {
        feeBps: strategy.feeBps,
        paperSlippageBps: strategy.paperSlippageBps,
      },
      codeVersion: BACKTEST_CODE_VERSION,
      reportSchemaVersion: BACKTEST_REPORT_SCHEMA_VERSION,
      decisionSource,
      scenarioDatasetId: scenario.datasetId ?? scenario.name,
    },
    scenarioName: scenario.name,
    policy: decisionSource,
    initialCapitalUSD: strategy.initialCapitalUSD,
    finalEquityUSD,
    cashBaselineUSD: strategy.initialCapitalUSD,
    buyHoldEquityUSD,
    beatsCash: finalEquityUSD > strategy.initialCapitalUSD,
    beatsBuyHold: finalEquityUSD > buyHoldEquityUSD,
    realisedPnlUSD: decimalNumber(state.realisedPnlUSD, USD_SCALE),
    unrealisedPnlUSD,
    totalFeesUSD,
    maxDrawdownPct,
    minEquityUSD,
    locked: state.locked,
    metrics,
    trades: state.trades,
    equitySnapshots,
  };

  return {
    ...resultWithoutAssertions,
    assertionFailures: evaluateAssertions(
      scenario,
      resultWithoutAssertions,
    ),
  };
}

export function runBacktest(
  scenario: ScenarioInput,
  options: BacktestOptions = {},
): BacktestResult {
  return runBacktestPoints(
    scenario,
    normalizeScenario(scenario),
    options,
  );
}

export function runBacktestObservations(
  input: ExplicitBacktestInput,
  options: BacktestOptions = {},
): BacktestResult {
  return runBacktestPoints(
    input,
    normalizeObservations(input.observations),
    options,
  );
}

export function createAggregateReport(
  results: BacktestResult[],
): BacktestAggregateReport {
  const failures = results
    .filter((result) => result.assertionFailures.length > 0)
    .map((result) => ({
      scenarioName: result.scenarioName,
      failures: result.assertionFailures,
    }));
  return {
    reportSchemaVersion: BACKTEST_REPORT_SCHEMA_VERSION,
    engineeringAssertions: {
      passedScenarios: results.length - failures.length,
      failedScenarios: failures.length,
      failures,
    },
    financialEvidenceSummary: {
      classification: "engineering-fixtures-only",
      scenarioCount: results.length,
      beatsCash: results.filter((result) => result.beatsCash).length,
      beatsBuyHold: results.filter((result) => result.beatsBuyHold).length,
      beatsBoth: results.filter(
        (result) => result.beatsCash && result.beatsBuyHold,
      ).length,
      historicalOrWalkForwardEvidence: false,
    },
    results,
  };
}

function ratio(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(4);
}

export function formatBacktestReport(result: BacktestResult): string {
  const financialLines = [
    "Financial evidence summary (synthetic engineering fixture only):",
    `Final equity: $${result.finalEquityUSD.toFixed(2)}`,
    `Cash baseline: $${result.cashBaselineUSD.toFixed(2)} (${result.beatsCash ? "beat" : "did not beat"})`,
    `Buy-and-hold: $${result.buyHoldEquityUSD.toFixed(2)} (${result.beatsBuyHold ? "beat" : "did not beat"})`,
    `Net PnL: ${result.metrics.netPnlUSD >= 0 ? "+" : ""}$${result.metrics.netPnlUSD.toFixed(2)}`,
    `Fees / slippage: $${result.totalFeesUSD.toFixed(2)} / $${result.metrics.totalModeledSlippageUSD.toFixed(2)}`,
    `Max drawdown: ${result.maxDrawdownPct.toFixed(2)}%`,
    `Sharpe / Sortino / Calmar: ${ratio(result.metrics.sharpe)} / ${ratio(result.metrics.sortino)} / ${ratio(result.metrics.calmar)}`,
    `Turnover / fee efficiency: ${ratio(result.metrics.turnover)} / ${ratio(result.metrics.feeEfficiency)}`,
    `Win rate / profit factor: ${ratio(result.metrics.winRate)} / ${ratio(result.metrics.profitFactor)}`,
    `Benchmark alpha: ${result.metrics.benchmarkAlphaPct.toFixed(2)} percentage points`,
    "Historical/walk-forward evidence: none",
  ];
  const engineeringLines = [
    "Engineering assertions:",
    result.assertionFailures.length === 0 ? "passed" : "failed",
    ...result.assertionFailures.map((failure) => `- ${failure}`),
  ];
  return [
    `Scenario: ${result.scenarioName}`,
    `Decision source: ${result.policy}`,
    `Strategy / schema: ${result.metadata.strategyVersion} / ${result.metadata.reportSchemaVersion}`,
    `Trades: ${result.trades.length}`,
    ...engineeringLines,
    ...financialLines,
  ].join("\n");
}
