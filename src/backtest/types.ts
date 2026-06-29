export type BacktestPolicy = "rules-basic" | "always-hold";

export interface ScenarioInput {
  name: string;
  description?: string;
  policy?: BacktestPolicy;
  start?: string;
  intervalHours?: number;
  prices: number[];
  expected?: {
    minFinalEquity?: number;
    mustBeatCash?: boolean;
    mustBeatBuyHold?: boolean;
    maxDrawdownPct?: number;
    minTrades?: number;
    maxTrades?: number;
    mustNotLock?: boolean;
  };
}

export interface BacktestOptions {
  initialCapitalUSD?: number;
  maxTradeSizeUSD?: number;
  minTradeSizeUSD?: number;
  feeRate?: number;
  slippagePct?: number;
  buyTriggerPct?: number;
  sellTriggerPct?: number;
  stopLossPct?: number;
  maxDcaCount?: number;
  cooldownMs?: number;
  minPortfolioValueUSD?: number;
  policy?: BacktestPolicy;
}

export interface BacktestTrade {
  timestamp: string;
  direction: "BUY" | "SELL";
  amountUSD: number;
  amountAsset: number;
  executionPrice: number;
  feesUSD: number;
  pnlUSD: number | null;
  reason: string;
}

export interface BacktestEquitySnapshot {
  timestamp: string;
  price: number;
  agentEquityUSD: number;
  cashEquityUSD: number;
  buyHoldEquityUSD: number;
}

export interface BacktestResult {
  scenarioName: string;
  policy: BacktestPolicy;
  initialCapitalUSD: number;
  finalEquityUSD: number;
  cashBaselineUSD: number;
  buyHoldEquityUSD: number;
  beatsCash: boolean;
  beatsBuyHold: boolean;
  realisedPnlUSD: number;
  unrealisedPnlUSD: number;
  totalFeesUSD: number;
  maxDrawdownPct: number;
  minEquityUSD: number;
  locked: boolean;
  trades: BacktestTrade[];
  equitySnapshots: BacktestEquitySnapshot[];
  assertionFailures: string[];
}
