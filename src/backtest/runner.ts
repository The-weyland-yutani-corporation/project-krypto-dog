import {
  BUY_TRIGGER_PCT,
  COOLDOWN_MS,
  INITIAL_CAPITAL_USD,
  MAX_DCA_COUNT,
  MAX_TRADE_SIZE_USD,
  MIN_PORTFOLIO_VALUE_USD,
  SELL_TRIGGER_PCT,
  SLIPPAGE_TOLERANCE_PCT,
  STOP_LOSS_PCT,
} from "@/lib/config";
import type {
  BacktestOptions,
  BacktestPolicy,
  BacktestResult,
  BacktestTrade,
  ScenarioInput,
} from "./types";

interface BacktestState {
  eth: number;
  usdc: number;
  costBasisETH: number;
  costBasisUSD: number;
  anchorPrice: number;
  lastTradeAt: Date | null;
  consecutiveBuys: number;
  locked: boolean;
  realisedPnlUSD: number;
  totalFeesUSD: number;
  trades: BacktestTrade[];
}

interface NormalizedPoint {
  timestamp: Date;
  price: number;
}

const DEFAULT_INTERVAL_HOURS = 4;
const DEFAULT_FEE_RATE = 0.003;

function normalizeScenario(scenario: ScenarioInput): NormalizedPoint[] {
  if (scenario.prices.length < 2) {
    throw new Error("Backtest scenario requires at least two prices");
  }

  const start = new Date(scenario.start ?? "2026-01-01T00:00:00.000Z");
  const intervalMs = (scenario.intervalHours ?? DEFAULT_INTERVAL_HOURS) * 60 * 60 * 1000;

  return scenario.prices.map((price, index) => {
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`Invalid scenario price at index ${index}: ${price}`);
    }
    return {
      timestamp: new Date(start.getTime() + index * intervalMs),
      price,
    };
  });
}

function equity(state: BacktestState, price: number): number {
  return state.usdc + state.eth * price;
}

function canTrade(state: BacktestState, now: Date, cooldownMs: number): boolean {
  return (
    state.lastTradeAt === null ||
    now.getTime() - state.lastTradeAt.getTime() >= cooldownMs
  );
}

function chooseAction(
  policy: BacktestPolicy,
  state: BacktestState,
  price: number,
  now: Date,
  opts: Required<BacktestOptions>,
): { direction: "BUY" | "SELL"; reason: string } | null {
  if (policy === "always-hold" || state.locked || !canTrade(state, now, opts.cooldownMs)) {
    return null;
  }

  const positionValue = state.eth * price;
  if (
    state.eth > 0 &&
    price <= state.anchorPrice * (1 - opts.stopLossPct)
  ) {
    return { direction: "SELL", reason: "stop-loss" };
  }

  if (
    state.eth > 0 &&
    price >= state.anchorPrice * (1 + opts.sellTriggerPct) &&
    positionValue >= opts.minTradeSizeUSD
  ) {
    return { direction: "SELL", reason: "sell-trigger" };
  }

  if (
    price <= state.anchorPrice * (1 - opts.buyTriggerPct) &&
    state.consecutiveBuys < opts.maxDcaCount &&
    state.usdc >= opts.minTradeSizeUSD * (1 + opts.feeRate)
  ) {
    return { direction: "BUY", reason: "buy-trigger" };
  }

  return null;
}

function executeTrade(
  state: BacktestState,
  direction: "BUY" | "SELL",
  price: number,
  timestamp: Date,
  reason: string,
  opts: Required<BacktestOptions>,
): void {
  const executionPrice =
    direction === "BUY"
      ? price * (1 + opts.slippagePct)
      : price * (1 - opts.slippagePct);

  if (direction === "BUY") {
    const amountUSD = Math.min(
      opts.maxTradeSizeUSD,
      state.usdc / (1 + opts.feeRate),
    );
    if (amountUSD < opts.minTradeSizeUSD) return;

    const feesUSD = amountUSD * opts.feeRate;
    const amountAsset = amountUSD / executionPrice;

    state.usdc -= amountUSD + feesUSD;
    state.eth += amountAsset;
    state.costBasisETH += amountAsset;
    state.costBasisUSD += amountUSD + feesUSD;
    state.totalFeesUSD += feesUSD;
    state.anchorPrice = executionPrice;
    state.consecutiveBuys += 1;
    state.lastTradeAt = timestamp;
    state.trades.push({
      timestamp: timestamp.toISOString(),
      direction,
      amountUSD,
      amountAsset,
      executionPrice,
      feesUSD,
      pnlUSD: null,
      reason,
    });
    return;
  }

  const positionValue = state.eth * executionPrice;
  const amountUSD = Math.min(opts.maxTradeSizeUSD, positionValue);
  if (amountUSD < opts.minTradeSizeUSD) return;

  const amountAsset = Math.min(state.eth, amountUSD / executionPrice);
  const feesUSD = amountUSD * opts.feeRate;
  const avgCost = state.costBasisETH > 0 ? state.costBasisUSD / state.costBasisETH : executionPrice;
  const pnlUSD = (executionPrice - avgCost) * amountAsset - feesUSD;
  const costBasisReduction = avgCost * amountAsset;

  state.eth -= amountAsset;
  state.usdc += amountUSD - feesUSD;
  state.costBasisETH = Math.max(0, state.costBasisETH - amountAsset);
  state.costBasisUSD = Math.max(0, state.costBasisUSD - costBasisReduction);
  if (state.costBasisETH < 1e-10) {
    state.costBasisETH = 0;
    state.costBasisUSD = 0;
  }
  state.realisedPnlUSD += pnlUSD;
  state.totalFeesUSD += feesUSD;
  state.anchorPrice = executionPrice;
  state.consecutiveBuys = 0;
  state.lastTradeAt = timestamp;
  state.trades.push({
    timestamp: timestamp.toISOString(),
    direction,
    amountUSD,
    amountAsset,
    executionPrice,
    feesUSD,
    pnlUSD,
    reason,
  });
}

function requiredOptions(options: BacktestOptions): Required<BacktestOptions> {
  return {
    initialCapitalUSD: options.initialCapitalUSD ?? INITIAL_CAPITAL_USD,
    maxTradeSizeUSD: options.maxTradeSizeUSD ?? MAX_TRADE_SIZE_USD,
    minTradeSizeUSD: options.minTradeSizeUSD ?? 10,
    feeRate: options.feeRate ?? DEFAULT_FEE_RATE,
    slippagePct: options.slippagePct ?? 0,
    buyTriggerPct: options.buyTriggerPct ?? BUY_TRIGGER_PCT,
    sellTriggerPct: options.sellTriggerPct ?? SELL_TRIGGER_PCT,
    stopLossPct: options.stopLossPct ?? STOP_LOSS_PCT,
    maxDcaCount: options.maxDcaCount ?? MAX_DCA_COUNT,
    cooldownMs: options.cooldownMs ?? COOLDOWN_MS,
    minPortfolioValueUSD: options.minPortfolioValueUSD ?? MIN_PORTFOLIO_VALUE_USD,
    policy: options.policy ?? "rules-basic",
  };
}

function evaluateAssertions(
  scenario: ScenarioInput,
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

export function runBacktest(
  scenario: ScenarioInput,
  options: BacktestOptions = {},
): BacktestResult {
  const opts = requiredOptions({
    ...options,
    policy: options.policy ?? scenario.policy ?? "rules-basic",
  });
  const points = normalizeScenario(scenario);
  const firstPrice = points[0].price;
  const lastPrice = points[points.length - 1].price;
  const state: BacktestState = {
    eth: 0,
    usdc: opts.initialCapitalUSD,
    costBasisETH: 0,
    costBasisUSD: 0,
    anchorPrice: firstPrice,
    lastTradeAt: null,
    consecutiveBuys: 0,
    locked: false,
    realisedPnlUSD: 0,
    totalFeesUSD: 0,
    trades: [],
  };

  let peakEquity = opts.initialCapitalUSD;
  let minEquity = opts.initialCapitalUSD;
  let maxDrawdownPct = 0;
  const equitySnapshots: BacktestResult["equitySnapshots"] = [];

  for (const point of points) {
    const currentEquity = equity(state, point.price);
    peakEquity = Math.max(peakEquity, currentEquity);
    minEquity = Math.min(minEquity, currentEquity);
    maxDrawdownPct = Math.max(
      maxDrawdownPct,
      peakEquity > 0 ? ((peakEquity - currentEquity) / peakEquity) * 100 : 0,
    );

    if (currentEquity < opts.minPortfolioValueUSD) {
      state.locked = true;
      continue;
    }

    const action = chooseAction(opts.policy, state, point.price, point.timestamp, opts);
    if (action) {
      executeTrade(state, action.direction, point.price, point.timestamp, action.reason, opts);
    }

    equitySnapshots.push({
      timestamp: point.timestamp.toISOString(),
      price: point.price,
      agentEquityUSD: equity(state, point.price),
      cashEquityUSD: opts.initialCapitalUSD,
      buyHoldEquityUSD: (opts.initialCapitalUSD / firstPrice) * point.price,
    });
  }

  const finalEquityUSD = equity(state, lastPrice);
  const avgCost = state.costBasisETH > 0 ? state.costBasisUSD / state.costBasisETH : 0;
  const unrealisedPnlUSD =
    state.costBasisETH > 0 ? (lastPrice - avgCost) * state.eth : 0;
  const buyHoldEquityUSD = (opts.initialCapitalUSD / firstPrice) * lastPrice;
  const resultWithoutAssertions = {
    scenarioName: scenario.name,
    policy: opts.policy,
    initialCapitalUSD: opts.initialCapitalUSD,
    finalEquityUSD,
    cashBaselineUSD: opts.initialCapitalUSD,
    buyHoldEquityUSD,
    beatsCash: finalEquityUSD > opts.initialCapitalUSD,
    beatsBuyHold: finalEquityUSD > buyHoldEquityUSD,
    realisedPnlUSD: state.realisedPnlUSD,
    unrealisedPnlUSD,
    totalFeesUSD: state.totalFeesUSD,
    maxDrawdownPct,
    minEquityUSD: minEquity,
    locked: state.locked,
    trades: state.trades,
    equitySnapshots,
  };

  return {
    ...resultWithoutAssertions,
    assertionFailures: evaluateAssertions(scenario, resultWithoutAssertions),
  };
}

export function formatBacktestReport(result: BacktestResult): string {
  const lines = [
    `Scenario: ${result.scenarioName}`,
    `Policy: ${result.policy}`,
    `Final equity: $${result.finalEquityUSD.toFixed(2)}`,
    `Cash baseline: $${result.cashBaselineUSD.toFixed(2)} (${result.beatsCash ? "beat" : "did not beat"})`,
    `Buy-and-hold: $${result.buyHoldEquityUSD.toFixed(2)} (${result.beatsBuyHold ? "beat" : "did not beat"})`,
    `Realised PnL: ${result.realisedPnlUSD >= 0 ? "+" : ""}$${result.realisedPnlUSD.toFixed(2)}`,
    `Unrealised PnL: ${result.unrealisedPnlUSD >= 0 ? "+" : ""}$${result.unrealisedPnlUSD.toFixed(2)}`,
    `Fees: $${result.totalFeesUSD.toFixed(2)}`,
    `Max drawdown: ${result.maxDrawdownPct.toFixed(2)}%`,
    `Trades: ${result.trades.length}`,
    `Locked: ${result.locked ? "yes" : "no"}`,
  ];

  if (result.assertionFailures.length > 0) {
    lines.push("Assertions: failed");
    for (const failure of result.assertionFailures) {
      lines.push(`- ${failure}`);
    }
  } else {
    lines.push("Assertions: passed");
  }

  return lines.join("\n");
}
