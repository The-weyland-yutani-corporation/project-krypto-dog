import type { StrategyConfig } from "./strategy-config";
import type {
  AuthorizationResult,
  AuthorizedTradeIntent,
  PolicyEvaluation,
  TradeDecision,
  TradingAccountSnapshot,
  TradingMarketSnapshot,
} from "./types";

const EPSILON = 1e-8;

function isFiniteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100_000_000) / 100_000_000;
}

function validateInputs(
  account: TradingAccountSnapshot,
  market: TradingMarketSnapshot,
): string | undefined {
  if (!isFinitePositive(market.spotPriceUSD)) {
    return "Market price is not finite and positive";
  }
  if (!Number.isFinite(market.observedAt.getTime())) {
    return "Market timestamp is invalid";
  }
  if (
    !isFinitePositive(account.initialCapitalUSD) ||
    !isFiniteNonNegative(account.ethBalance) ||
    !isFiniteNonNegative(account.usdcBalance) ||
    !isFiniteNonNegative(account.peakPortfolioValueUSD) ||
    !Number.isInteger(account.dcaCount) ||
    account.dcaCount < 0
  ) {
    return "Account snapshot contains invalid numeric values";
  }
  return undefined;
}

function mandatoryStopLoss(
  account: TradingAccountSnapshot,
  market: TradingMarketSnapshot,
  strategy: StrategyConfig,
): AuthorizedTradeIntent | undefined {
  if (
    account.ethBalance <= EPSILON ||
    !isFinitePositive(account.weightedCostBasisUSD ?? Number.NaN)
  ) {
    return undefined;
  }

  const stopPrice =
    (account.weightedCostBasisUSD as number) * (1 - strategy.stopLossFraction);
  if (market.spotPriceUSD > stopPrice) {
    return undefined;
  }

  return {
    action: "SELL",
    notionalUSD: roundMoney(account.ethBalance * market.spotPriceUSD),
    reasoning: `Mandatory stop-loss: market price ${market.spotPriceUSD.toFixed(2)} is at or below ${stopPrice.toFixed(2)}`,
    mandatory: true,
    fullExit: true,
  };
}

export function evaluateTradePolicy(
  account: TradingAccountSnapshot,
  market: TradingMarketSnapshot,
  strategy: StrategyConfig,
  now = new Date(),
): PolicyEvaluation {
  const invalidReason = validateInputs(account, market);
  const portfolioValueUSD =
    account.ethBalance * market.spotPriceUSD + account.usdcBalance;
  const peakPortfolioValueUSD = Math.max(
    account.initialCapitalUSD,
    account.peakPortfolioValueUSD,
    portfolioValueUSD,
  );
  const drawdownPct =
    peakPortfolioValueUSD > 0
      ? Math.max(
          0,
          ((peakPortfolioValueUSD - portfolioValueUSD) /
            peakPortfolioValueUSD) *
            100,
        )
      : 0;

  const base: PolicyEvaluation = {
    portfolioValueUSD,
    peakPortfolioValueUSD,
    drawdownPct,
    shouldInvokeModel: false,
  };

  if (invalidReason) {
    return { ...base, holdReason: invalidReason };
  }

  const marketAgeMs = now.getTime() - market.observedAt.getTime();
  if (marketAgeMs < 0 || marketAgeMs > strategy.marketDataMaxAgeMs) {
    return { ...base, holdReason: "Market snapshot is stale" };
  }

  if (account.accountingStatus !== "RECONCILED") {
    return {
      ...base,
      holdReason: `Account accounting status is ${account.accountingStatus}`,
    };
  }

  const stopLoss = mandatoryStopLoss(account, market, strategy);
  if (stopLoss) {
    return {
      ...base,
      mandatoryTrade: stopLoss,
      holdReason: stopLoss.reasoning,
    };
  }

  if (account.isLocked || drawdownPct >= strategy.maximumDrawdownPct) {
    return {
      ...base,
      holdReason: account.isLocked
        ? "Account safety lock is active"
        : `Maximum drawdown reached (${drawdownPct.toFixed(2)}%)`,
    };
  }

  if (
    account.ethBalance <= EPSILON &&
    account.referencePriceUSD === null
  ) {
    return {
      ...base,
      referencePriceToInitialize: market.spotPriceUSD,
      holdReason: "Cold start establishes a reference price before trading",
    };
  }

  if (account.isOperatorPaused) {
    return { ...base, holdReason: "Operator pause blocks optional trades" };
  }

  const cooldownActive =
    account.lastExecutionAt !== null &&
    now.getTime() - account.lastExecutionAt.getTime() < strategy.cooldownMs;
  if (cooldownActive) {
    return { ...base, holdReason: "Execution cooldown is active" };
  }

  const feeFraction = strategy.feeBps / 10_000;
  const currentEthNotional = account.ethBalance * market.spotPriceUSD;
  const maximumTradeUSD =
    account.initialCapitalUSD *
    strategy.maximumTradeFractionOfInitialCapital;
  const cashCapacity = account.usdcBalance / (1 + feeFraction);
  const exposureCapacity = Math.max(
    0,
    portfolioValueUSD * strategy.maximumEthExposureFraction -
      currentEthNotional,
  );
  const maximumBuyNotional = roundMoney(
    Math.max(0, Math.min(maximumTradeUSD, cashCapacity, exposureCapacity)),
  );

  const buyReference =
    account.ethBalance > EPSILON
      ? account.lastBuyPriceUSD
      : account.referencePriceUSD;
  const buyTriggered =
    isFinitePositive(buyReference ?? Number.NaN) &&
    market.spotPriceUSD <=
      (buyReference as number) * (1 - strategy.buyTriggerFraction);

  const buy =
    buyTriggered &&
    account.dcaCount < strategy.maximumDcaEntries &&
    maximumBuyNotional + EPSILON >= strategy.minimumTradeUSD
      ? {
          action: "BUY" as const,
          minimumNotionalUSD: strategy.minimumTradeUSD,
          maximumNotionalUSD: maximumBuyNotional,
          reason:
            account.ethBalance > EPSILON
              ? "DCA threshold and account limits permit another buy"
              : "Initial buy threshold and account limits are satisfied",
        }
      : undefined;

  const positionNotionalUSD = roundMoney(currentEthNotional);
  const sellTriggered =
    account.ethBalance > EPSILON &&
    isFinitePositive(account.weightedCostBasisUSD ?? Number.NaN) &&
    market.spotPriceUSD >=
      (account.weightedCostBasisUSD as number) *
        (1 + strategy.takeProfitFraction);
  const sell =
    sellTriggered && positionNotionalUSD > EPSILON
      ? {
          action: "SELL" as const,
          minimumNotionalUSD: Math.min(
            strategy.minimumTradeUSD,
            positionNotionalUSD,
          ),
          maximumNotionalUSD: positionNotionalUSD,
          reason: "Take-profit threshold is satisfied",
        }
      : undefined;

  return {
    ...base,
    buy,
    sell,
    shouldInvokeModel: true,
    holdReason:
      buy || sell
        ? undefined
        : "No optional BUY or SELL action is currently eligible",
  };
}

export function authorizeTradeIntent(
  evaluation: PolicyEvaluation,
  decision: TradeDecision,
  strategy: StrategyConfig,
): AuthorizationResult {
  if (evaluation.mandatoryTrade) {
    return {
      authorized: true,
      intent: evaluation.mandatoryTrade,
      adjusted: decision.action !== "SELL",
      reason: "Mandatory safety action overrides model discretion",
    };
  }

  if (decision.action === "HOLD") {
    return {
      authorized: false,
      reason: decision.reasoning,
    };
  }

  const eligible =
    decision.action === "BUY" ? evaluation.buy : evaluation.sell;
  if (!eligible || decision.notionalUSD === null) {
    return {
      authorized: false,
      reason: `${decision.action} is not currently eligible`,
    };
  }

  if (!isFinitePositive(decision.notionalUSD)) {
    return { authorized: false, reason: "Trade notional must be positive" };
  }

  if (
    decision.notionalUSD >
    eligible.maximumNotionalUSD + EPSILON
  ) {
    return {
      authorized: false,
      reason: `Requested notional exceeds the authorized maximum of $${eligible.maximumNotionalUSD.toFixed(2)}`,
    };
  }

  let authorizedNotional = roundMoney(decision.notionalUSD);
  let adjusted = false;
  let fullExit = false;

  if (decision.action === "SELL") {
    const remainingNotional =
      eligible.maximumNotionalUSD - authorizedNotional;
    if (
      remainingNotional > EPSILON &&
      remainingNotional < strategy.minimumTradeUSD
    ) {
      authorizedNotional = eligible.maximumNotionalUSD;
      adjusted = true;
      fullExit = true;
    } else {
      fullExit =
        Math.abs(remainingNotional) <= EPSILON ||
        authorizedNotional >= eligible.maximumNotionalUSD;
    }
  }

  if (
    authorizedNotional + EPSILON < eligible.minimumNotionalUSD &&
    !fullExit
  ) {
    return {
      authorized: false,
      reason: `Requested notional is below the authorized minimum of $${eligible.minimumNotionalUSD.toFixed(2)}`,
    };
  }

  return {
    authorized: true,
    intent: {
      action: decision.action,
      notionalUSD: authorizedNotional,
      reasoning: decision.reasoning,
      mandatory: false,
      fullExit,
    },
    adjusted,
    reason: adjusted
      ? "Sell was expanded to a full exit to avoid a dust position"
      : eligible.reason,
  };
}
