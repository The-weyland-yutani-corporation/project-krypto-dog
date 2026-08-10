export type BacktestDecisionSource = "rules-basic" | "always-hold";
export type BacktestPolicy = BacktestDecisionSource;

export interface ScenarioInput {
  name: string;
  datasetId?: string;
  description?: string;
  policy?: BacktestDecisionSource;
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

export interface BacktestObservation {
  timestamp: string;
  price: number;
}

export type ExplicitBacktestInput = Omit<
  ScenarioInput,
  "prices" | "start" | "intervalHours"
> & {
  observations: BacktestObservation[];
};

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
  maximumDrawdownPct?: number;
  policy?: BacktestDecisionSource;
  llmCostUSD?: number;
}

export interface BacktestTrade {
  timestamp: string;
  direction: "BUY" | "SELL";
  amountUSD: number;
  amountAsset: number;
  observedPrice: number;
  executionPrice: number;
  feesUSD: number;
  slippageUSD: number;
  pnlUSD: number | null;
  reason: string;
}

export interface BacktestEquitySnapshot {
  timestamp: string;
  price: number;
  agentEquityUSD: number;
  cashEquityUSD: number;
  buyHoldEquityUSD: number;
  drawdownPct: number;
}

export interface BacktestMetrics {
  netPnlUSD: number;
  sharpe: number | null;
  sortino: number | null;
  calmar: number | null;
  turnover: number | null;
  feeEfficiency: number | null;
  winRate: number | null;
  profitFactor: number | null;
  benchmarkAlphaPct: number;
  totalModeledSlippageUSD: number;
  llmCostUSD: number | null;
  llmCostAdjustedPnlUSD: number | null;
  returnObservations: number;
}

export interface BacktestVersionMetadata {
  strategyVersion: string;
  configurationVersion: string;
  costModelVersion: string;
  costModel: {
    feeBps: number;
    paperSlippageBps: number;
  };
  codeVersion: string;
  reportSchemaVersion: string;
  decisionSource: BacktestDecisionSource;
  scenarioDatasetId: string;
}

export interface BacktestResult {
  metadata: BacktestVersionMetadata;
  scenarioName: string;
  policy: BacktestDecisionSource;
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
  metrics: BacktestMetrics;
  trades: BacktestTrade[];
  equitySnapshots: BacktestEquitySnapshot[];
  assertionFailures: string[];
}

export interface BacktestAggregateReport {
  reportSchemaVersion: string;
  engineeringAssertions: {
    passedScenarios: number;
    failedScenarios: number;
    failures: Array<{ scenarioName: string; failures: string[] }>;
  };
  financialEvidenceSummary: {
    classification: "engineering-fixtures-only";
    scenarioCount: number;
    beatsCash: number;
    beatsBuyHold: number;
    beatsBoth: number;
    historicalOrWalkForwardEvidence: false;
  };
  results: BacktestResult[];
}
