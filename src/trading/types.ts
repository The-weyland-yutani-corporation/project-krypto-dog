import { z } from "zod/v4";

export interface TradingMarketSnapshot {
  spotPriceUSD: number;
  observedAt: Date;
  rsi: number | null;
  emaShort: number | null;
  emaLong: number | null;
}

export interface TradingAccountSnapshot {
  initialCapitalUSD: number;
  ethBalance: number;
  usdcBalance: number;
  weightedCostBasisUSD: number | null;
  referencePriceUSD: number | null;
  lastBuyPriceUSD: number | null;
  dcaCount: number;
  peakPortfolioValueUSD: number;
  lastExecutionAt: Date | null;
  isLocked: boolean;
  isOperatorPaused: boolean;
  accountingStatus: "RECONCILED" | "QUARANTINED" | "UNINITIALIZED";
}

export const tradeDecisionSchema = z
  .object({
    action: z.enum(["HOLD", "BUY", "SELL"]),
    notionalUSD: z.number().finite().positive().nullable(),
    reasoning: z.string().trim().min(1).max(2000),
  })
  .superRefine((decision, ctx) => {
    if (decision.action === "HOLD" && decision.notionalUSD !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["notionalUSD"],
        message: "HOLD decisions must use a null notionalUSD",
      });
    }
    if (decision.action !== "HOLD" && decision.notionalUSD === null) {
      ctx.addIssue({
        code: "custom",
        path: ["notionalUSD"],
        message: "BUY and SELL decisions require a positive notionalUSD",
      });
    }
  });

export type TradeDecision = z.infer<typeof tradeDecisionSchema>;

export interface EligibleTrade {
  action: "BUY" | "SELL";
  minimumNotionalUSD: number;
  maximumNotionalUSD: number;
  reason: string;
}

export interface AuthorizedTradeIntent {
  action: "BUY" | "SELL";
  notionalUSD: number;
  reasoning: string;
  mandatory: boolean;
  fullExit: boolean;
}

export type AuthorizationResult =
  | {
      authorized: true;
      intent: AuthorizedTradeIntent;
      adjusted: boolean;
      reason: string;
    }
  | {
      authorized: false;
      reason: string;
    };

export interface PolicyEvaluation {
  portfolioValueUSD: number;
  peakPortfolioValueUSD: number;
  drawdownPct: number;
  buy?: EligibleTrade;
  sell?: EligibleTrade;
  mandatoryTrade?: AuthorizedTradeIntent;
  shouldInvokeModel: boolean;
  holdReason?: string;
  referencePriceToInitialize?: number;
}

export interface DecisionResult {
  decision: TradeDecision;
  tokenUsage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    attemptCount: number;
    latencyMs: number;
  };
}
