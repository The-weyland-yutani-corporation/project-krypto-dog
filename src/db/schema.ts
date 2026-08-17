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
  date,
  primaryKey,
  check,
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

export const safetyIncidentEventKindEnum = kryptoSchema.enum(
  "SafetyIncidentEventKind",
  [
    "CREATED",
    "ACKNOWLEDGED",
    "ESCALATED",
    "RESOLVED",
    "DELIVERY_CONFIRMED",
    "DELIVERY_FAILED",
  ],
);

export const safetyIncidentTypeEnum = kryptoSchema.enum("SafetyIncidentType", [
  "PAPER_TRADE_POST_COMMIT",
  "POST_COMMIT_FAILURE",
  "TELEMETRY_FAILURE",
  "JOURNAL_FAILURE",
  "EMAIL_DELIVERY_FAILURE",
  "DAILY_DELIVERY_OBLIGATION",
  "DRAWDOWN_LOCK",
  "STALE_OR_OVERLAPPING_LEASE",
  "RECONCILIATION_QUARANTINE",
  "UNEXPECTED_SHADOW_TRADE",
  "AUTH_PROVENANCE_MISMATCH",
  "PROVIDER_FAILURE",
  "DEADLINE_BUDGET_EXHAUSTION",
  "READINESS_CAPACITY_FAILURE",
  "MISSING_RUN",
  "CREDENTIAL_CONCERN",
  "TEST_FIRE_WARNING",
  "TEST_FIRE_CRITICAL",
  "ROUTE_RUN_FAILURE",
]);

export const safetyIncidentSeverityEnum = kryptoSchema.enum(
  "SafetyIncidentSeverity",
  ["WARNING", "CRITICAL"],
);

export const safetyIncidentStatusEnum = kryptoSchema.enum(
  "SafetyIncidentStatus",
  ["OPEN", "ACKNOWLEDGED", "ESCALATED", "RESOLVED"],
);

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
    requestId: text("requestId").notNull(),
    releaseId: text("releaseId").notNull(),
    deploymentId: text("deploymentId").notNull(),
    providerAttemptId: text("providerAttemptId"),
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
    deadlineAt: timestamp("deadlineAt", {
      precision: 3,
      withTimezone: true,
    }).notNull(),
  },
  (table) => [
    uniqueIndex("AgentRun_idempotencyKey_uidx").on(table.idempotencyKey),
    index("AgentRun_startedAt_idx").on(table.startedAt),
    index("AgentRun_outcome_startedAt_idx").on(
      table.outcome,
      table.startedAt,
    ),
    check(
      "AgentRun_deadline_after_start_check",
      sql`${table.deadlineAt} > ${table.startedAt}`,
    ),
    check(
      "AgentRun_deadline_exact_check",
      sql`${table.deadlineAt} = ${table.startedAt} + interval '180 seconds'`,
    ),
  ],
);

export const providerDailyUsage = kryptoSchema.table(
  "ProviderDailyUsage",
  {
    usageDate: date("usageDate").notNull(),
    provider: text("provider").notNull(),
    requestCount: integer("requestCount").notNull().default(0),
    updatedAt: timestamp("updatedAt", {
      precision: 3,
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "ProviderDailyUsage_pkey",
      columns: [table.usageDate, table.provider],
    }),
    check(
      "ProviderDailyUsage_provider_check",
      sql`${table.provider} IN ('coinbase', 'foundry', 'posthog', 'acs')`,
    ),
    check(
      "ProviderDailyUsage_requestCount_check",
      sql`${table.requestCount} >= 0`,
    ),
  ],
);

/**
 * Runtime-readable migration contract.  The runtime role intentionally cannot
 * read drizzle.__drizzle_migrations; readiness reads this single row instead.
 */
export const runtimeContract = kryptoSchema.table(
  "RuntimeContract",
  {
    id: text("id").primaryKey().default("singleton"),
    schemaFingerprint: text("schemaFingerprint").notNull(),
    contractVersion: integer("contractVersion").notNull(),
    updatedAt: timestamp("updatedAt", {
      precision: 3,
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("RuntimeContract_singleton_check", sql`${table.id} = 'singleton'`),
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

export const safetyIncidentOutbox = kryptoSchema.table(
  "SafetyIncidentOutbox",
  {
    eventId: text("eventId")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    incidentId: text("incidentId").notNull(),
    eventSequence: integer("eventSequence").notNull(),
    eventKind: safetyIncidentEventKindEnum("eventKind").notNull(),
    incidentType: safetyIncidentTypeEnum("incidentType").notNull(),
    severity: safetyIncidentSeverityEnum("severity").notNull(),
    status: safetyIncidentStatusEnum("status").notNull(),
    dedupKey: text("dedupKey").notNull(),
    requestId: text("requestId").notNull(),
    agentRunId: text("agentRunId").references(() => agentRun.id, {
      onDelete: "restrict",
    }),
    releaseId: text("releaseId").notNull(),
    deploymentId: text("deploymentId").notNull(),
    providerAttemptId: text("providerAttemptId"),
    transactionId: text("transactionId").references(() => tradeExecution.id, {
      onDelete: "restrict",
    }),
    redactedContext: jsonb("redactedContext").notNull(),
    occurredAt: timestamp("occurredAt", {
      precision: 3,
      withTimezone: true,
    }).notNull(),
    persistedAt: timestamp("persistedAt", {
      precision: 3,
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    acknowledgedAt: timestamp("acknowledgedAt", {
      precision: 3,
      withTimezone: true,
    }),
    resolvedAt: timestamp("resolvedAt", {
      precision: 3,
      withTimezone: true,
    }),
    escalatedAt: timestamp("escalatedAt", {
      precision: 3,
      withTimezone: true,
    }),
    ownerRole: text("ownerRole").notNull(),
    backupRole: text("backupRole").notNull(),
    runbook: text("runbook").notNull(),
    actorId: text("actorId"),
    actorRole: text("actorRole"),
    evidence: jsonb("evidence"),
  },
  (table) => [
    uniqueIndex("SafetyIncidentOutbox_incidentId_eventSequence_uidx").on(
      table.incidentId,
      table.eventSequence,
    ),
    uniqueIndex("SafetyIncidentOutbox_created_dedupKey_uidx")
      .on(table.dedupKey)
      .where(sql`${table.eventKind} = 'CREATED'`),
    index("SafetyIncidentOutbox_incident_status_occurredAt_idx").on(
      table.incidentId,
      table.status,
      table.occurredAt,
    ),
    index("SafetyIncidentOutbox_severity_status_occurredAt_idx").on(
      table.severity,
      table.status,
      table.occurredAt,
    ),
    index("SafetyIncidentOutbox_agentRunId_idx").on(table.agentRunId),
    index("SafetyIncidentOutbox_transactionId_idx").on(table.transactionId),
    check(
      "SafetyIncidentOutbox_eventSequence_positive_check",
      sql`${table.eventSequence} > 0`,
    ),
    check(
      "SafetyIncidentOutbox_redactedContext_object_check",
      sql`jsonb_typeof(${table.redactedContext}) = 'object'`,
    ),
    check(
      "SafetyIncidentOutbox_evidence_object_check",
      sql`${table.evidence} IS NULL OR jsonb_typeof(${table.evidence}) = 'object'`,
    ),
    check(
      "SafetyIncidentOutbox_persistedAt_consistency_check",
      sql`${table.persistedAt} >= ${table.occurredAt}`,
    ),
    check(
      "SafetyIncidentOutbox_acknowledgedAt_consistency_check",
      sql`${table.acknowledgedAt} IS NULL OR ${table.acknowledgedAt} >= ${table.occurredAt}`,
    ),
    check(
      "SafetyIncidentOutbox_escalatedAt_consistency_check",
      sql`${table.escalatedAt} IS NULL OR ${table.escalatedAt} >= ${table.occurredAt}`,
    ),
    check(
      "SafetyIncidentOutbox_resolvedAt_consistency_check",
      sql`${table.resolvedAt} IS NULL OR ${table.resolvedAt} >= ${table.occurredAt}`,
    ),
    check(
      "SafetyIncidentOutbox_event_timestamp_check",
      sql`(${table.eventKind} <> 'ACKNOWLEDGED' OR ${table.acknowledgedAt} IS NOT NULL)
        AND (${table.eventKind} <> 'ESCALATED' OR ${table.escalatedAt} IS NOT NULL)
        AND (${table.eventKind} <> 'RESOLVED' OR ${table.resolvedAt} IS NOT NULL)`,
    ),
    check(
      "SafetyIncidentOutbox_status_timestamp_check",
      sql`(${table.status} <> 'OPEN'
          OR (${table.acknowledgedAt} IS NULL AND ${table.escalatedAt} IS NULL AND ${table.resolvedAt} IS NULL))
        AND (${table.status} <> 'ACKNOWLEDGED'
          OR (${table.acknowledgedAt} IS NOT NULL AND ${table.escalatedAt} IS NULL AND ${table.resolvedAt} IS NULL))
        AND (${table.status} <> 'ESCALATED'
          OR (${table.escalatedAt} IS NOT NULL AND ${table.resolvedAt} IS NULL))
        AND (${table.status} <> 'RESOLVED' OR ${table.resolvedAt} IS NOT NULL)`,
    ),
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
export type SafetyIncidentOutbox = typeof safetyIncidentOutbox.$inferSelect;
export type AgentJournal = typeof agentJournal.$inferSelect;
export type NewAgentRun = typeof agentRun.$inferInsert;
export type NewTradeExecution = typeof tradeExecution.$inferInsert;
export type NewSafetyIncidentOutbox = typeof safetyIncidentOutbox.$inferInsert;
export type NewAgentJournal = typeof agentJournal.$inferInsert;
export type ProviderDailyUsage = typeof providerDailyUsage.$inferSelect;
export type RuntimeContract = typeof runtimeContract.$inferSelect;
