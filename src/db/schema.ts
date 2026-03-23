import {
  pgTable,
  pgEnum,
  text,
  doublePrecision,
  boolean,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

export const tradeDirectionEnum = pgEnum("TradeDirection", ["BUY", "SELL"]);

export const agentState = pgTable("AgentState", {
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
  isRunning: boolean("isRunning").notNull().default(false),
  lastRunAt: timestamp("lastRunAt", { precision: 3 }),
  updatedAt: timestamp("updatedAt", { precision: 3 })
    .notNull()
    .$onUpdate(() => new Date()),
});

export const tradeExecution = pgTable(
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
    createdAt: timestamp("createdAt", { precision: 3 }).notNull().defaultNow(),
  },
  (table) => [index("TradeExecution_createdAt_idx").on(table.createdAt)],
);

export const agentJournal = pgTable(
  "AgentJournal",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    entryText: text("entryText").notNull(),
    marketConditions: jsonb("marketConditions").notNull(),
    tradeExecutionId: text("tradeExecutionId").references(
      () => tradeExecution.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("createdAt", { precision: 3 }).notNull().defaultNow(),
  },
  (table) => [index("AgentJournal_createdAt_idx").on(table.createdAt)],
);

// Type helpers
export type AgentState = typeof agentState.$inferSelect;
export type TradeExecution = typeof tradeExecution.$inferSelect;
export type AgentJournal = typeof agentJournal.$inferSelect;
export type NewTradeExecution = typeof tradeExecution.$inferInsert;
export type NewAgentJournal = typeof agentJournal.$inferInsert;
