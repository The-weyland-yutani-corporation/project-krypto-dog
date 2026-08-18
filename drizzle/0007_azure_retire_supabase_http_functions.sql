-- Azure PostgreSQL safety transition.
--
-- The Supabase pg_cron/pg_net HTTP-invocation functions are obsolete on
-- Azure Database for PostgreSQL Flexible Server: scheduling moves to Azure
-- Container Apps Jobs (see specs/decisions/0008-azure-native-deployment-architecture.md),
-- which call the application's HTTP routes directly instead of a
-- database-side pg_net call. This migration drops the two now-unused
-- functions and establishes a least-privilege NOLOGIN runtime group role
-- for the application's Azure login role to join. It does not touch any
-- trading table, row, or history.
--
-- The krypto_runtime grants below are fail-closed and table-specific
-- rather than schema-wide: AgentRun/TradeExecution/AgentJournal are
-- immutable-by-design history (no UPDATE on TradeExecution/AgentJournal,
-- no row-removal, table-clearing, TRIGGER, or REFERENCES privilege
-- anywhere), and AgentState never
-- receives INSERT from the application (its singleton row is seeded
-- separately). Existing privileges are revoked first so re-running this
-- migration (or correcting a prior manual grant) always converges on the
-- same exact matrix instead of accumulating privileges. The krypto schema
-- currently defines no sequences (every primary key is an
-- application-generated text/UUID value), so no sequence privileges are
-- granted; a future migration that introduces a sequence must grant the
-- specific privileges it needs explicitly in that same migration.
--> statement-breakpoint
DROP FUNCTION IF EXISTS "krypto"."invoke_agent_run"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS "krypto"."invoke_daily_summary"();
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_roles WHERE rolname = 'krypto_runtime'
	) THEN
		CREATE ROLE "krypto_runtime" NOLOGIN NOSUPERUSER NOCREATEDB
			NOCREATEROLE NOREPLICATION;
	END IF;
END
$$;
--> statement-breakpoint
-- Idempotent drift correction: revoke any previously-granted privileges
-- (broad or otherwise) before applying the exact least-privilege matrix
-- below.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA "krypto" FROM "krypto_runtime";
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA "krypto" FROM "krypto_runtime";
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA "krypto"
	REVOKE ALL PRIVILEGES ON TABLES FROM "krypto_runtime";
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA "krypto"
	REVOKE ALL PRIVILEGES ON SEQUENCES FROM "krypto_runtime";
--> statement-breakpoint
GRANT USAGE ON SCHEMA "krypto" TO "krypto_runtime";
--> statement-breakpoint
-- AgentState: the application reads and updates the singleton row; it
-- never inserts, deletes, or truncates it.
GRANT SELECT, UPDATE ON TABLE "krypto"."AgentState" TO "krypto_runtime";
--> statement-breakpoint
-- AgentRun: the application creates a run and updates it as it completes,
-- but never removes or clears run history.
GRANT SELECT, INSERT, UPDATE ON TABLE "krypto"."AgentRun" TO "krypto_runtime";
--> statement-breakpoint
-- TradeExecution: immutable trade history. Append-only; no UPDATE, and no
-- row-removal or table-clearing privilege for the application runtime.
GRANT SELECT, INSERT ON TABLE "krypto"."TradeExecution" TO "krypto_runtime";
--> statement-breakpoint
-- AgentJournal: immutable journal history. Append-only; no UPDATE, and no
-- row-removal or table-clearing privilege for the application runtime.
GRANT SELECT, INSERT ON TABLE "krypto"."AgentJournal" TO "krypto_runtime";
--> statement-breakpoint
-- Defense in depth: krypto_runtime is a login-less group role. Nothing
-- above grants it, or any other role, the ability to authenticate; an
-- Azure login role only gains these privileges once it is explicitly made
-- a member (see scripts/bootstrap-azure-runtime-role.ts), and that
-- bootstrap step never embeds a password in migration history.
DO $$
DECLARE
	target_role text;
BEGIN
	FOREACH target_role IN ARRAY ARRAY['anon', 'authenticated']
	LOOP
		IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
			EXECUTE format(
				'REVOKE ALL ON SCHEMA krypto FROM %I',
				target_role
			);
			EXECUTE format(
				'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA krypto FROM %I',
				target_role
			);
			EXECUTE format(
				'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA krypto FROM %I',
				target_role
			);
		END IF;
	END LOOP;
	REVOKE ALL ON SCHEMA "krypto" FROM PUBLIC;
	REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA "krypto" FROM PUBLIC;
	REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA "krypto" FROM PUBLIC;
END
$$;
