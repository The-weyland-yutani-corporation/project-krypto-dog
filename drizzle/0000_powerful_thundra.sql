CREATE TYPE "public"."TradeDirection" AS ENUM('BUY', 'SELL');--> statement-breakpoint
CREATE TABLE "AgentJournal" (
	"id" text PRIMARY KEY NOT NULL,
	"entryText" text NOT NULL,
	"marketConditions" jsonb NOT NULL,
	"tradeExecutionId" text,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "AgentState" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"lastTradePrice" double precision,
	"currentPositionETH" double precision DEFAULT 0 NOT NULL,
	"currentPositionUSDC" double precision DEFAULT 200 NOT NULL,
	"portfolioValueUSD" double precision DEFAULT 200 NOT NULL,
	"isLocked" boolean DEFAULT false NOT NULL,
	"isRunning" boolean DEFAULT false NOT NULL,
	"lastRunAt" timestamp (3),
	"updatedAt" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "TradeExecution" (
	"id" text PRIMARY KEY NOT NULL,
	"direction" "TradeDirection" NOT NULL,
	"asset" text NOT NULL,
	"amountUSD" double precision NOT NULL,
	"amountAsset" double precision NOT NULL,
	"executionPrice" double precision NOT NULL,
	"feesUSD" double precision DEFAULT 0 NOT NULL,
	"slippage" double precision DEFAULT 0 NOT NULL,
	"pnlUSD" double precision,
	"agentReasoning" text NOT NULL,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "AgentJournal" ADD CONSTRAINT "AgentJournal_tradeExecutionId_TradeExecution_id_fk" FOREIGN KEY ("tradeExecutionId") REFERENCES "public"."TradeExecution"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "AgentJournal_createdAt_idx" ON "AgentJournal" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "TradeExecution_createdAt_idx" ON "TradeExecution" USING btree ("createdAt");