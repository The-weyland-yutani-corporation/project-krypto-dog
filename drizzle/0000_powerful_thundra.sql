DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM pg_type type
		JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
		WHERE namespace.nspname = 'public'
			AND type.typname = 'TradeDirection'
	) THEN
		CREATE TYPE "public"."TradeDirection" AS ENUM('BUY', 'SELL');
	END IF;
END
$$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."AgentJournal" (
	"id" text PRIMARY KEY NOT NULL,
	"entryText" text NOT NULL,
	"marketConditions" jsonb NOT NULL,
	"tradeExecutionId" text,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."AgentState" (
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
CREATE TABLE IF NOT EXISTS "public"."TradeExecution" (
	"id" text PRIMARY KEY NOT NULL,
	"direction" "public"."TradeDirection" NOT NULL,
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
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conrelid = '"public"."AgentJournal"'::regclass
			AND conname = 'AgentJournal_tradeExecutionId_fkey'
	) THEN
		ALTER TABLE "public"."AgentJournal"
			DROP CONSTRAINT "AgentJournal_tradeExecutionId_fkey";
	END IF;

	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conrelid = '"public"."AgentJournal"'::regclass
			AND conname = 'AgentJournal_tradeExecutionId_TradeExecution_id_fk'
	) THEN
		ALTER TABLE "public"."AgentJournal"
			ADD CONSTRAINT "AgentJournal_tradeExecutionId_TradeExecution_id_fk"
			FOREIGN KEY ("tradeExecutionId")
			REFERENCES "public"."TradeExecution"("id")
			ON DELETE set null
			ON UPDATE no action;
	END IF;
END
$$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "AgentJournal_createdAt_idx" ON "public"."AgentJournal" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "TradeExecution_createdAt_idx" ON "public"."TradeExecution" USING btree ("createdAt");