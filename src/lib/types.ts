export interface PortfolioState {
  ethBalance: number;
  usdcBalance: number;
  ethPrice: number;
  portfolioValueUSD: number;
  lastTradePrice: number | null;
  isLocked: boolean;
}

export interface MarketData {
  ethPrice: number;
  rsi: number | null;
  emaShort: number | null;
  emaLong: number | null;
  emaCrossover: "bullish" | "bearish" | "neutral";
  timestamp: Date;
}

export interface TradeRequest {
  direction: "BUY" | "SELL";
  asset: string;
  amountUSD: number;
}

export interface TradeResult {
  success: boolean;
  tradeId?: string;
  direction?: "BUY" | "SELL";
  asset?: string;
  amountUSD?: number;
  executionPrice?: number;
  amountAsset?: number;
  feesUSD?: number;
  pnlUSD?: number | null;
  error?: string;
}

export interface AgentRunResult {
  status: "executed" | "skipped" | "error" | "locked";
  action?: string;
  reasoning?: string;
  trade?: TradeResult;
  portfolioState?: PortfolioState;
  guardrailTriggered?: string;
  error?: string;
  tokenUsage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  journalWritten?: boolean;
  journalFallbackWritten?: boolean;
  durationMs: number;
}

export interface JournalEntry {
  id: string;
  entryText: string;
  marketConditions: MarketData;
  tradeExecutionId: string | null;
  createdAt: Date;
}

export class SystemLockedError extends Error {
  constructor(message = "System locked due to max drawdown") {
    super(message);
    this.name = "SystemLockedError";
  }
}

export class CooldownActiveError extends Error {
  constructor(message = "Trade cooldown is active") {
    super(message);
    this.name = "CooldownActiveError";
  }
}

export class MutexError extends Error {
  constructor(message = "Agent is already running") {
    super(message);
    this.name = "MutexError";
  }
}
