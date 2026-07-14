import {
  text,
  doublePrecision,
  boolean,
  timestamp,
  jsonb,
  index,
  pgSchema,
  numeric,
  integer,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const kryptoSchema = pgSchema("krypto");

export const tradeDirectionEnum = kryptoSchema.enum("TradeDirection", [
  "BUY",
  "SELL",
]);

export const tradingModeEnum = kryptoSchema.enum("TradingMode", [
  "DISABLED",
  "SHADOW",
  "PAPER",
]);

export const agentRunOutcomeEnum = kryptoSchema.enum("AgentRunOutcome", [
  "RUNNING",
  "DISABLED",
  "SHADOW",
  "HOLD",
  "REJECTED",
  "EXECUTED",
  "LOCKED",
  "CONFLICT",
  "UPSTREAM_ERROR",
  "INTERNAL_ERROR",
]);

export const accountingStatusEnum = kryptoSchema.enum("AccountingStatus", [
  "UNINITIALIZED",
  "RECONCILED",
  "QUARANTINED",
]);

export const agentState = kryptoSchema.table("AgentState", {
  id: text("id").primaryKey().default("singleton"),
  lastTradePrice: doublePrecision("lastTradePrice"),
  currentPositionETH: doublePrecision("currentPositionETH")
    .notNull()
    .default(0),
  currentPositionUSDC: doublePrecision("currentPositionUSDC")
    .notNull()
    .default(200),
  portfolioValueUSD: doublePrecision("portfolioValueUSD")
    .notNull()
    .default(200),
  isLocked: boolean("isLocked").notNull().default(false),
  isOperatorPaused: boolean("isOperatorPaused").notNull().default(false),
  isRunning: boolean("isRunning").notNull().default(false),
  lastRunAt: timestamp("lastRunAt", { precision: 3 }),
  initialCapitalUSD: numeric("initialCapitalUSD", {
    precision: 20,
    scale: 8,
  })
    .notNull()
    .default("200"),
  lastTradePriceDecimal: numeric("lastTradePriceDecimal", {
    precision: 20,
    scale: 8,
  }),
  currentPositionETHDecimal: numeric("currentPositionETHDecimal", {
    precision: 28,
    scale: 18,
  }),
  currentPositionUSDCDecimal: numeric("currentPositionUSDCDecimal", {
    precision: 20,
    scale: 8,
  }),
  portfolioValueUSDDecimal: numeric("portfolioValueUSDDecimal", {
    precision: 20,
    scale: 8,
  }),
  weightedCostBasisUSD: numeric("weightedCostBasisUSD", {
    precision: 20,
    scale: 8,
  }),
  referencePriceUSD: numeric("referencePriceUSD", {
    precision: 20,
    scale: 8,
  }),
  lastBuyPriceUSD: numeric("lastBuyPriceUSD", {
    precision: 20,
    scale: 8,
  }),
  // Counts BUY executions since the last full exit; partial sells do not reset it.
  dcaCount: integer("dcaCount").notNull().default(0),
  peakPortfolioValueUSD: numeric("peakPortfolioValueUSD", {
    precision: 20,
    scale: 8,
  }),
  drawdownPct: numeric("drawdownPct", {
    precision: 12,
    scale: 8,
  }),
  strategyVersion: text("strategyVersion").notNull().default("v2-legacy"),
  strategySnapshot: jsonb("strategySnapshot")
    .notNull()
    .default(sql`'{}'::jsonb`),
  accountingStatus: accountingStatusEnum("accountingStatus")
    .notNull()
    .default("UNINITIALIZED"),
  accountingIssue: text("accountingIssue"),
  lockReason: text("lockReason"),
  lockedAt: timestamp("lockedAt", { precision: 3, withTimezone: true }),
  leaseOwner: text("leaseOwner"),
  leaseExpiresAt: timestamp("leaseExpiresAt", {
    precision: 3,
    withTimezone: true,
  }),
  lastCompletedRunAt: timestamp("lastCompletedRunAt", {
    precision: 3,
    withTimezone: true,
  }),
  updatedAt: timestamp("updatedAt", { precision: 3 })
    .notNull()
    .$onUpdate(() => new Date()),
});

export const agentRun = kryptoSchema.table(
  "AgentRun",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    idempotencyKey: text("idempotencyKey").notNull(),
    triggerSource: text("triggerSource").notNull(),
    tradingMode: tradingModeEnum("tradingMode").notNull(),
    outcome: agentRunOutcomeEnum("outcome").notNull().default("RUNNING"),
    strategyVersion: text("strategyVersion").notNull(),
    modelVersion: text("modelVersion"),
    marketSnapshot: jsonb("marketSnapshot"),
    accountSnapshotBefore: jsonb("accountSnapshotBefore"),
    accountSnapshotAfter: jsonb("accountSnapshotAfter"),
    proposedDecision: jsonb("proposedDecision"),
    authorizationResult: jsonb("authorizationResult"),
    tokenUsage: jsonb("tokenUsage"),
    latencyMs: integer("latencyMs"),
    errorType: text("errorType"),
    errorMessage: text("errorMessage"),
    startedAt: timestamp("startedAt", {
      precision: 3,
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completedAt", {
      precision: 3,
      withTimezone: true,
    }),
  },
  (table) => [
    uniqueIndex("AgentRun_idempotencyKey_uidx").on(table.idempotencyKey),
    index("AgentRun_startedAt_idx").on(table.startedAt),
    index("AgentRun_outcome_startedAt_idx").on(
      table.outcome,
      table.startedAt,
    ),
  ],
);

export const tradeExecution = kryptoSchema.table(
  "TradeExecution",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    direction: tradeDirectionEnum("direction").notNull(),
    asset: text("asset").notNull(),
    amountUSD: doublePrecision("amountUSD").notNull(),
    amountAsset: doublePrecision("amountAsset").notNull(),
    executionPrice: doublePrecision("executionPrice").notNull(),
    feesUSD: doublePrecision("feesUSD").notNull().default(0),
    slippage: doublePrecision("slippage").notNull().default(0),
    pnlUSD: doublePrecision("pnlUSD"),
    agentReasoning: text("agentReasoning").notNull(),
    agentRunId: text("agentRunId").references(() => agentRun.id, {
      onDelete: "restrict",
    }),
    pair: text("pair").notNull().default("ETH/USDC"),
    requestedNotionalUSD: numeric("requestedNotionalUSD", {
      precision: 20,
      scale: 8,
    }),
    observedMarketPriceUSD: numeric("observedMarketPriceUSD", {
      precision: 20,
      scale: 8,
    }),
    modeledExecutionPriceUSD: numeric("modeledExecutionPriceUSD", {
      precision: 20,
      scale: 8,
    }),
    quantityAssetDecimal: numeric("quantityAssetDecimal", {
      precision: 28,
      scale: 18,
    }),
    feeRateBps: integer("feeRateBps"),
    feesUSDDecimal: numeric("feesUSDDecimal", {
      precision: 20,
      scale: 8,
    }),
    slippageBps: integer("slippageBps"),
    slippageUSD: numeric("slippageUSD", {
      precision: 20,
      scale: 8,
    }),
    ethBalanceBefore: numeric("ethBalanceBefore", {
      precision: 28,
      scale: 18,
    }),
    ethBalanceAfter: numeric("ethBalanceAfter", {
      precision: 28,
      scale: 18,
    }),
    usdcBalanceBefore: numeric("usdcBalanceBefore", {
      precision: 20,
      scale: 8,
    }),
    usdcBalanceAfter: numeric("usdcBalanceAfter", {
      precision: 20,
      scale: 8,
    }),
    costBasisBeforeUSD: numeric("costBasisBeforeUSD", {
      precision: 20,
      scale: 8,
    }),
    costBasisAfterUSD: numeric("costBasisAfterUSD", {
      precision: 20,
      scale: 8,
    }),
    realizedPnlUSDDecimal: numeric("realizedPnlUSDDecimal", {
      precision: 20,
      scale: 8,
    }),
    strategyVersion: text("strategyVersion").notNull().default("v2-legacy"),
    signalSnapshot: jsonb("signalSnapshot")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("createdAt", { precision: 3 }).notNull().defaultNow(),
  },
  (table) => [
    index("TradeExecution_createdAt_idx").on(table.createdAt),
    uniqueIndex("TradeExecution_agentRunId_uidx").on(table.agentRunId),
  ],
);

export const agentJournal = kryptoSchema.table(
  "AgentJournal",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    entryText: text("entryText").notNull(),
    marketConditions: jsonb("marketConditions").notNull(),
    tradeExecutionId: text("tradeExecutionId").references(
      () => tradeExecution.id,
      { onDelete: "set null" },
    ),
    agentRunId: text("agentRunId").references(() => agentRun.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("createdAt", { precision: 3 }).notNull().defaultNow(),
  },
  (table) => [
    index("AgentJournal_createdAt_idx").on(table.createdAt),
    index("AgentJournal_agentRunId_idx").on(table.agentRunId),
  ],
);

// Type helpers
export type AgentState = typeof agentState.$inferSelect;
export type AgentRun = typeof agentRun.$inferSelect;
export type TradeExecution = typeof tradeExecution.$inferSelect;
export type AgentJournal = typeof agentJournal.$inferSelect;
export type NewAgentRun = typeof agentRun.$inferInsert;
export type NewTradeExecution = typeof tradeExecution.$inferInsert;
export type NewAgentJournal = typeof agentJournal.$inferInsert;
