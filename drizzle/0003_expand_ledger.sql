CREATE TYPE "krypto"."AccountingStatus" AS ENUM('UNINITIALIZED', 'RECONCILED', 'QUARANTINED');--> statement-breakpoint
CREATE TYPE "krypto"."AgentRunOutcome" AS ENUM('RUNNING', 'DISABLED', 'SHADOW', 'HOLD', 'REJECTED', 'EXECUTED', 'LOCKED', 'CONFLICT', 'UPSTREAM_ERROR', 'INTERNAL_ERROR');--> statement-breakpoint
CREATE TYPE "krypto"."TradingMode" AS ENUM('DISABLED', 'SHADOW', 'PAPER');--> statement-breakpoint
CREATE TABLE "krypto"."AgentRun" (
	"id" text PRIMARY KEY NOT NULL,
	"idempotencyKey" text NOT NULL,
	"triggerSource" text NOT NULL,
	"tradingMode" "krypto"."TradingMode" NOT NULL,
	"outcome" "krypto"."AgentRunOutcome" DEFAULT 'RUNNING' NOT NULL,
	"strategyVersion" text NOT NULL,
	"modelVersion" text,
	"marketSnapshot" jsonb,
	"accountSnapshotBefore" jsonb,
	"accountSnapshotAfter" jsonb,
	"proposedDecision" jsonb,
	"authorizationResult" jsonb,
	"tokenUsage" jsonb,
	"latencyMs" integer,
	"errorType" text,
	"errorMessage" text,
	"startedAt" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"completedAt" timestamp (3) with time zone
);
--> statement-breakpoint
ALTER TABLE "krypto"."AgentJournal" ADD COLUMN "agentRunId" text;--> statement-breakpoint
ALTER TABLE "krypto"."AgentState" ADD COLUMN "initialCapitalUSD" numeric(20, 8) DEFAULT '200' NOT NULL;--> statement-breakpoint
ALTER TABLE "krypto"."AgentState" ADD COLUMN "lastTradePriceDecimal" numeric(20, 8);--> statement-breakpoint
ALTER TABLE "krypto"."AgentState" ADD COLUMN "currentPositionETHDecimal" numeric(28, 18);--> statement-breakpoint
ALTER TABLE "krypto"."AgentState" ADD COLUMN "currentPositionUSDCDecimal" numeric(20, 8);--> statement-breakpoint
ALTER TABLE "krypto"."AgentState" ADD COLUMN "portfolioValueUSDDecimal" numeric(20, 8);--> statement-breakpoint
ALTER TABLE "krypto"."AgentState" ADD COLUMN "weightedCostBasisUSD" numeric(20, 8);--> statement-breakpoint
ALTER TABLE "krypto"."AgentState" ADD COLUMN "referencePriceUSD" numeric(20, 8);--> statement-breakpoint
ALTER TABLE "krypto"."AgentState" ADD COLUMN "lastBuyPriceUSD" numeric(20, 8);--> statement-breakpoint
ALTER TABLE "krypto"."AgentState" ADD COLUMN "dcaCount" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "krypto"."AgentState" ADD COLUMN "peakPortfolioValueUSD" numeric(20, 8);--> statement-breakpoint
ALTER TABLE "krypto"."AgentState" ADD COLUMN "drawdownPct" numeric(12, 8);--> statement-breakpoint
ALTER TABLE "krypto"."AgentState" ADD COLUMN "strategyVersion" text DEFAULT 'v2-legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "krypto"."AgentState" ADD COLUMN "strategySnapshot" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "krypto"."AgentState" ADD COLUMN "accountingStatus" "krypto"."AccountingStatus" DEFAULT 'UNINITIALIZED' NOT NULL;--> statement-breakpoint
ALTER TABLE "krypto"."AgentState" ADD COLUMN "accountingIssue" text;--> statement-breakpoint
ALTER TABLE "krypto"."AgentState" ADD COLUMN "lockReason" text;--> statement-breakpoint
ALTER TABLE "krypto"."AgentState" ADD COLUMN "lockedAt" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "krypto"."AgentState" ADD COLUMN "leaseOwner" text;--> statement-breakpoint
ALTER TABLE "krypto"."AgentState" ADD COLUMN "leaseExpiresAt" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "krypto"."AgentState" ADD COLUMN "lastCompletedRunAt" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "krypto"."TradeExecution" ADD COLUMN "agentRunId" text;--> statement-breakpoint
ALTER TABLE "krypto"."TradeExecution" ADD COLUMN "pair" text DEFAULT 'ETH/USDC' NOT NULL;--> statement-breakpoint
ALTER TABLE "krypto"."TradeExecution" ADD COLUMN "requestedNotionalUSD" numeric(20, 8);--> statement-breakpoint
ALTER TABLE "krypto"."TradeExecution" ADD COLUMN "observedMarketPriceUSD" numeric(20, 8);--> statement-breakpoint
ALTER TABLE "krypto"."TradeExecution" ADD COLUMN "modeledExecutionPriceUSD" numeric(20, 8);--> statement-breakpoint
ALTER TABLE "krypto"."TradeExecution" ADD COLUMN "quantityAssetDecimal" numeric(28, 18);--> statement-breakpoint
ALTER TABLE "krypto"."TradeExecution" ADD COLUMN "feeRateBps" integer;--> statement-breakpoint
ALTER TABLE "krypto"."TradeExecution" ADD COLUMN "feesUSDDecimal" numeric(20, 8);--> statement-breakpoint
ALTER TABLE "krypto"."TradeExecution" ADD COLUMN "slippageBps" integer;--> statement-breakpoint
ALTER TABLE "krypto"."TradeExecution" ADD COLUMN "slippageUSD" numeric(20, 8);--> statement-breakpoint
ALTER TABLE "krypto"."TradeExecution" ADD COLUMN "ethBalanceBefore" numeric(28, 18);--> statement-breakpoint
ALTER TABLE "krypto"."TradeExecution" ADD COLUMN "ethBalanceAfter" numeric(28, 18);--> statement-breakpoint
ALTER TABLE "krypto"."TradeExecution" ADD COLUMN "usdcBalanceBefore" numeric(20, 8);--> statement-breakpoint
ALTER TABLE "krypto"."TradeExecution" ADD COLUMN "usdcBalanceAfter" numeric(20, 8);--> statement-breakpoint
ALTER TABLE "krypto"."TradeExecution" ADD COLUMN "costBasisBeforeUSD" numeric(20, 8);--> statement-breakpoint
ALTER TABLE "krypto"."TradeExecution" ADD COLUMN "costBasisAfterUSD" numeric(20, 8);--> statement-breakpoint
ALTER TABLE "krypto"."TradeExecution" ADD COLUMN "realizedPnlUSDDecimal" numeric(20, 8);--> statement-breakpoint
ALTER TABLE "krypto"."TradeExecution" ADD COLUMN "strategyVersion" text DEFAULT 'v2-legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "krypto"."TradeExecution" ADD COLUMN "signalSnapshot" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "krypto"."TradeExecution"
SET
	"requestedNotionalUSD" = CASE
		WHEN "amountUSD"::text NOT IN ('NaN', 'Infinity', '-Infinity')
			AND "amountUSD" >= 0
		THEN round("amountUSD"::numeric, 8)
		ELSE NULL
	END,
	"observedMarketPriceUSD" = CASE
		WHEN "executionPrice"::text NOT IN ('NaN', 'Infinity', '-Infinity')
			AND "executionPrice" > 0
		THEN round("executionPrice"::numeric, 8)
		ELSE NULL
	END,
	"modeledExecutionPriceUSD" = CASE
		WHEN "executionPrice"::text NOT IN ('NaN', 'Infinity', '-Infinity')
			AND "executionPrice" > 0
		THEN round("executionPrice"::numeric, 8)
		ELSE NULL
	END,
	"quantityAssetDecimal" = CASE
		WHEN "amountAsset"::text NOT IN ('NaN', 'Infinity', '-Infinity')
			AND "amountAsset" >= 0
		THEN round("amountAsset"::numeric, 18)
		ELSE NULL
	END,
	"feeRateBps" = CASE
		WHEN "amountUSD"::text NOT IN ('NaN', 'Infinity', '-Infinity')
			AND "feesUSD"::text NOT IN ('NaN', 'Infinity', '-Infinity')
			AND "amountUSD" > 0
			AND "feesUSD" >= 0
		THEN round(("feesUSD" / "amountUSD") * 10000)::integer
		ELSE NULL
	END,
	"feesUSDDecimal" = CASE
		WHEN "feesUSD"::text NOT IN ('NaN', 'Infinity', '-Infinity')
			AND "feesUSD" >= 0
		THEN round("feesUSD"::numeric, 8)
		ELSE NULL
	END,
	"slippageBps" = CASE
		WHEN "slippage"::text NOT IN ('NaN', 'Infinity', '-Infinity')
			AND "slippage" >= 0
		THEN round("slippage" * 10000)::integer
		ELSE NULL
	END,
	"slippageUSD" = CASE
		WHEN "amountUSD"::text NOT IN ('NaN', 'Infinity', '-Infinity')
			AND "slippage"::text NOT IN ('NaN', 'Infinity', '-Infinity')
			AND "amountUSD" >= 0
			AND "slippage" >= 0
		THEN round(("amountUSD" * "slippage")::numeric, 8)
		ELSE NULL
	END,
	"realizedPnlUSDDecimal" = CASE
		WHEN "pnlUSD" IS NULL THEN NULL
		WHEN "pnlUSD"::text NOT IN ('NaN', 'Infinity', '-Infinity')
		THEN round("pnlUSD"::numeric, 8)
		ELSE NULL
	END,
	"strategyVersion" = 'v2-legacy',
	"signalSnapshot" = jsonb_build_object('source', 'v2-backfill');
--> statement-breakpoint
UPDATE "krypto"."AgentState"
SET
	"lastTradePriceDecimal" = CASE
		WHEN "lastTradePrice" IS NULL THEN NULL
		WHEN "lastTradePrice"::text NOT IN ('NaN', 'Infinity', '-Infinity')
			AND "lastTradePrice" > 0
		THEN round("lastTradePrice"::numeric, 8)
		ELSE NULL
	END,
	"currentPositionETHDecimal" = CASE
		WHEN "currentPositionETH"::text NOT IN ('NaN', 'Infinity', '-Infinity')
			AND "currentPositionETH" >= 0
		THEN round("currentPositionETH"::numeric, 18)
		ELSE NULL
	END,
	"currentPositionUSDCDecimal" = CASE
		WHEN "currentPositionUSDC"::text NOT IN ('NaN', 'Infinity', '-Infinity')
			AND "currentPositionUSDC" >= 0
		THEN round("currentPositionUSDC"::numeric, 8)
		ELSE NULL
	END,
	"portfolioValueUSDDecimal" = CASE
		WHEN "portfolioValueUSD"::text NOT IN ('NaN', 'Infinity', '-Infinity')
			AND "portfolioValueUSD" >= 0
		THEN round("portfolioValueUSD"::numeric, 8)
		ELSE NULL
	END,
	"peakPortfolioValueUSD" = CASE
		WHEN "portfolioValueUSD"::text NOT IN ('NaN', 'Infinity', '-Infinity')
			AND "portfolioValueUSD" >= 0
		THEN greatest(200::numeric, round("portfolioValueUSD"::numeric, 8))
		ELSE 200::numeric
	END,
	"strategyVersion" = 'v2-legacy',
	"strategySnapshot" = jsonb_build_object('source', 'v2-backfill'),
	"lastCompletedRunAt" = CASE
		WHEN "lastRunAt" IS NULL THEN NULL
		ELSE "lastRunAt" AT TIME ZONE 'UTC'
	END,
	"lockReason" = CASE
		WHEN "isLocked" THEN 'legacy-drawdown-lock'
		ELSE NULL
	END,
	"lockedAt" = CASE
		WHEN "isLocked" THEN "updatedAt" AT TIME ZONE 'UTC'
		ELSE NULL
	END;
--> statement-breakpoint
DO $$
DECLARE
	state_row record;
	trade_row record;
	computed_quantity numeric(28, 18) := 0;
	open_cost numeric(28, 8) := 0;
	running_usdc numeric(20, 8);
	weighted_cost numeric(20, 8);
	reference_price numeric(20, 8);
	last_buy_price numeric(20, 8);
	eth_before numeric(28, 18);
	usdc_before numeric(20, 8);
	cost_basis_before numeric(20, 8);
	cost_basis_after numeric(20, 8);
	dca_count integer := 0;
	issue text;
BEGIN
	SELECT *
	INTO state_row
	FROM "krypto"."AgentState"
	WHERE "id" = 'singleton';

	IF NOT FOUND THEN
		RETURN;
	END IF;

	IF state_row."currentPositionETHDecimal" IS NULL
		OR state_row."currentPositionUSDCDecimal" IS NULL
		OR state_row."portfolioValueUSDDecimal" IS NULL THEN
		issue := 'legacy state contains invalid or negative numeric values';
	END IF;

	running_usdc := state_row."initialCapitalUSD";

	IF issue IS NULL THEN
		FOR trade_row IN
			SELECT
				"id",
				"direction",
				"requestedNotionalUSD",
				"modeledExecutionPriceUSD",
				"quantityAssetDecimal",
				"feesUSDDecimal"
			FROM "krypto"."TradeExecution"
			ORDER BY "createdAt", "id"
		LOOP
			IF trade_row."requestedNotionalUSD" IS NULL
				OR trade_row."modeledExecutionPriceUSD" IS NULL
				OR trade_row."quantityAssetDecimal" IS NULL
				OR trade_row."feesUSDDecimal" IS NULL
				OR trade_row."requestedNotionalUSD" <= 0
				OR trade_row."modeledExecutionPriceUSD" <= 0
				OR trade_row."quantityAssetDecimal" <= 0
				OR trade_row."feesUSDDecimal" < 0 THEN
				issue := 'legacy trade contains invalid numeric values';
				EXIT;
			END IF;

			eth_before := computed_quantity;
			usdc_before := running_usdc;
			cost_basis_before := CASE
				WHEN computed_quantity > 0
				THEN round(open_cost / computed_quantity, 8)
				ELSE NULL
			END;

			IF trade_row."direction" = 'BUY' THEN
				computed_quantity :=
					computed_quantity + trade_row."quantityAssetDecimal";
				open_cost :=
					open_cost
					+ trade_row."requestedNotionalUSD"
					+ trade_row."feesUSDDecimal";
				running_usdc :=
					running_usdc
					- trade_row."requestedNotionalUSD"
					- trade_row."feesUSDDecimal";
				dca_count := dca_count + 1;
				last_buy_price := trade_row."modeledExecutionPriceUSD";
				IF reference_price IS NULL THEN
					reference_price := trade_row."modeledExecutionPriceUSD";
				END IF;
			ELSE
				IF computed_quantity <= 0
					OR trade_row."quantityAssetDecimal"
						> computed_quantity + 0.000000000001 THEN
					issue := 'legacy trade history sells more ETH than is open';
					EXIT;
				END IF;

				open_cost :=
					open_cost
					- (
						open_cost
						* trade_row."quantityAssetDecimal"
						/ computed_quantity
					);
				computed_quantity :=
					computed_quantity - trade_row."quantityAssetDecimal";
				running_usdc :=
					running_usdc
					+ trade_row."requestedNotionalUSD"
					- trade_row."feesUSDDecimal";

				IF computed_quantity <= 0.000000000001 THEN
					computed_quantity := 0;
					open_cost := 0;
					dca_count := 0;
					last_buy_price := NULL;
					reference_price := trade_row."modeledExecutionPriceUSD";
				END IF;
			END IF;

			IF running_usdc < -0.01 THEN
				issue := 'legacy trade history produces a negative USDC balance';
				EXIT;
			END IF;

			cost_basis_after := CASE
				WHEN computed_quantity > 0
					THEN round(open_cost / computed_quantity, 8)
				ELSE NULL
			END;

			UPDATE "krypto"."TradeExecution"
			SET
				"ethBalanceBefore" = eth_before,
				"ethBalanceAfter" = computed_quantity,
				"usdcBalanceBefore" = usdc_before,
				"usdcBalanceAfter" = running_usdc,
				"costBasisBeforeUSD" = cost_basis_before,
				"costBasisAfterUSD" = cost_basis_after
			WHERE "id" = trade_row."id";
		END LOOP;
	END IF;

	IF issue IS NULL
		AND abs(
			computed_quantity - state_row."currentPositionETHDecimal"
		) > 0.000001 THEN
		issue := format(
			'legacy ETH balance mismatch: ledger=%s state=%s',
			computed_quantity,
			state_row."currentPositionETHDecimal"
		);
	END IF;

	IF issue IS NULL
		AND abs(
			running_usdc - state_row."currentPositionUSDCDecimal"
		) > 0.01 THEN
		issue := format(
			'legacy USDC balance mismatch: ledger=%s state=%s',
			running_usdc,
			state_row."currentPositionUSDCDecimal"
		);
	END IF;

	IF issue IS NULL AND computed_quantity > 0 THEN
		weighted_cost := round(open_cost / computed_quantity, 8);
	END IF;

	UPDATE "krypto"."AgentState"
	SET
		"weightedCostBasisUSD" = weighted_cost,
		"referencePriceUSD" = coalesce(
			reference_price,
			"lastTradePriceDecimal"
		),
		"lastBuyPriceUSD" = last_buy_price,
		"dcaCount" = dca_count,
		"drawdownPct" = CASE
			WHEN "peakPortfolioValueUSD" IS NULL
				OR "peakPortfolioValueUSD" <= 0
				OR "portfolioValueUSDDecimal" IS NULL THEN NULL
			ELSE round(
				greatest(
					0::numeric,
					(
						"peakPortfolioValueUSD"
						- "portfolioValueUSDDecimal"
					) / "peakPortfolioValueUSD" * 100
				),
				8
			)
		END,
		"accountingStatus" = CASE
			WHEN issue IS NULL THEN 'RECONCILED'::"krypto"."AccountingStatus"
			ELSE 'QUARANTINED'::"krypto"."AccountingStatus"
		END,
		"accountingIssue" = issue
	WHERE "id" = 'singleton';
END
$$;
--> statement-breakpoint
CREATE UNIQUE INDEX "AgentRun_idempotencyKey_uidx" ON "krypto"."AgentRun" USING btree ("idempotencyKey");--> statement-breakpoint
CREATE INDEX "AgentRun_startedAt_idx" ON "krypto"."AgentRun" USING btree ("startedAt");--> statement-breakpoint
CREATE INDEX "AgentRun_outcome_startedAt_idx" ON "krypto"."AgentRun" USING btree ("outcome","startedAt");--> statement-breakpoint
ALTER TABLE "krypto"."AgentJournal" ADD CONSTRAINT "AgentJournal_agentRunId_AgentRun_id_fk" FOREIGN KEY ("agentRunId") REFERENCES "krypto"."AgentRun"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "krypto"."TradeExecution" ADD CONSTRAINT "TradeExecution_agentRunId_AgentRun_id_fk" FOREIGN KEY ("agentRunId") REFERENCES "krypto"."AgentRun"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "AgentJournal_agentRunId_idx" ON "krypto"."AgentJournal" USING btree ("agentRunId");--> statement-breakpoint
CREATE UNIQUE INDEX "TradeExecution_agentRunId_uidx" ON "krypto"."TradeExecution" USING btree ("agentRunId");