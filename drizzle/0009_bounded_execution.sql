-- Bounded synchronous execution contract (GitHub issue #132).
-- No trading history is deleted or rewritten by this migration.
SET ROLE "krypto_schema_owner";
--> statement-breakpoint
CREATE TABLE "krypto"."ProviderDailyUsage" (
	"usageDate" date NOT NULL,
	"provider" text NOT NULL,
	"requestCount" integer DEFAULT 0 NOT NULL,
	"updatedAt" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ProviderDailyUsage_pkey" PRIMARY KEY("usageDate","provider"),
	CONSTRAINT "ProviderDailyUsage_provider_check"
		CHECK ("provider" IN ('coinbase', 'foundry', 'posthog', 'acs')),
	CONSTRAINT "ProviderDailyUsage_requestCount_check"
		CHECK ("requestCount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "krypto"."RuntimeContract" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"schemaFingerprint" text NOT NULL,
	"contractVersion" integer NOT NULL,
	"updatedAt" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "RuntimeContract_singleton_check" CHECK ("id" = 'singleton')
);
--> statement-breakpoint
INSERT INTO "krypto"."RuntimeContract"
	("id", "schemaFingerprint", "contractVersion")
VALUES
	('singleton', '0009_bounded_execution_v1', 1)
ON CONFLICT ("id") DO UPDATE SET
	"schemaFingerprint" = EXCLUDED."schemaFingerprint",
	"contractVersion" = EXCLUDED."contractVersion",
	"updatedAt" = now();
--> statement-breakpoint
ALTER TABLE "krypto"."AgentRun"
	ADD COLUMN "deadlineAt" timestamp (3) with time zone;
--> statement-breakpoint
UPDATE "krypto"."AgentRun"
SET "deadlineAt" = "startedAt" + interval '180 seconds'
WHERE "deadlineAt" IS NULL;
--> statement-breakpoint
ALTER TABLE "krypto"."AgentRun"
	ALTER COLUMN "deadlineAt" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "krypto"."AgentRun"
	ADD CONSTRAINT "AgentRun_deadline_after_start_check"
	CHECK ("deadlineAt" > "startedAt");
--> statement-breakpoint
ALTER TABLE "krypto"."AgentRun"
	ADD CONSTRAINT "AgentRun_deadline_exact_check"
	CHECK ("deadlineAt" = "startedAt" + interval '180 seconds');
--> statement-breakpoint

-- The application must not be able to move the persisted fence after run
-- acquisition.  This also prevents an accidental retry from extending a run.
CREATE FUNCTION "krypto"."reject_agent_run_deadline_change"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
	IF NEW."deadlineAt" IS DISTINCT FROM OLD."deadlineAt" THEN
		RAISE EXCEPTION 'AgentRun deadlineAt is immutable after acquisition'
			USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "AgentRun_deadline_immutable"
BEFORE UPDATE OF "deadlineAt" ON "krypto"."AgentRun"
FOR EACH ROW
EXECUTE FUNCTION "krypto"."reject_agent_run_deadline_change"();
--> statement-breakpoint

-- A DEFERRABLE INITIALLY DEFERRED constraint trigger executes at transaction
-- commit, using clock_timestamp() rather than transaction_timestamp().  A
-- paper transaction that began before its deadline but crosses it therefore
-- cannot commit a TradeExecution row.
CREATE FUNCTION "krypto"."enforce_paper_trade_commit_deadline"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
	run_deadline timestamptz;
	run_mode text;
BEGIN
	IF NEW."agentRunId" IS NULL THEN
		RAISE EXCEPTION 'TradeExecution requires an AgentRun deadline fence'
			USING ERRCODE = 'check_violation';
	END IF;

	SELECT run."deadlineAt", run."tradingMode"::text
	INTO run_deadline, run_mode
	FROM "krypto"."AgentRun" AS run
	WHERE run."id" = NEW."agentRunId";

	IF run_deadline IS NULL OR run_mode <> 'PAPER' THEN
		RAISE EXCEPTION 'TradeExecution requires a persisted PAPER AgentRun deadline'
			USING ERRCODE = 'check_violation';
	END IF;
	IF clock_timestamp() >= run_deadline THEN
		RAISE EXCEPTION 'Paper trade commit rejected at or after AgentRun deadline'
			USING ERRCODE = '57014';
	END IF;
	RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "TradeExecution_commit_deadline_fence"
AFTER INSERT ON "krypto"."TradeExecution"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "krypto"."enforce_paper_trade_commit_deadline"();
--> statement-breakpoint

-- Exact runtime grants.  The migration ledger remains unreadable; readiness
-- receives only the dedicated RuntimeContract singleton.
REVOKE ALL PRIVILEGES ON TABLE "krypto"."ProviderDailyUsage" FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "krypto"."RuntimeContract" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "krypto"."ProviderDailyUsage" TO "krypto_runtime";
--> statement-breakpoint
GRANT SELECT ON TABLE "krypto"."RuntimeContract" TO "krypto_runtime";
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "krypto"."reject_agent_run_deadline_change"() FROM PUBLIC, "krypto_runtime";
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "krypto"."enforce_paper_trade_commit_deadline"() FROM PUBLIC, "krypto_runtime";
--> statement-breakpoint
DO $$
BEGIN
	IF to_regnamespace('drizzle') IS NOT NULL
		AND has_schema_privilege('krypto_runtime', 'drizzle', 'USAGE') THEN
		RAISE EXCEPTION 'krypto_runtime must remain unable to read the drizzle migration ledger';
	END IF;
	IF NOT has_table_privilege(
		'krypto_runtime',
		'krypto."RuntimeContract"',
		'SELECT'
	) THEN
		RAISE EXCEPTION 'krypto_runtime cannot read the runtime schema contract';
	END IF;
END
$$;
--> statement-breakpoint
RESET ROLE;
