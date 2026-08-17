-- PostgreSQL trust-boundary hardening (see GitHub issue #133 and
-- specs/decisions/0008-azure-native-deployment-architecture.md).
--
-- This migration establishes the final segment of a four-role trust
-- boundary. The other three roles, and all identity/credential
-- provisioning, are established out-of-band by the protected admin
-- bootstrap step (src/deployment/bootstrap-runtime-role.ts,
-- scripts/bootstrap-azure-runtime-role.ts) using DIRECT_URL, which runs
-- before this migration and guarantees:
--   - krypto_schema_owner (NOLOGIN) exists and this migration's executing
--     role (krypto_migrator) can SET ROLE to it.
--   - krypto_scheduler (NOLOGIN) exists, reserved for future
--     SECURITY DEFINER function ownership, and is never assumable by the
--     runtime.
--   - krypto_runtime (NOLOGIN) exists (pre-created so the historical
--     `CREATE ROLE IF NOT EXISTS` in migration 0007 is always a no-op
--     under krypto_migrator, which deliberately lacks CREATEROLE).
--   - On an upgrade from a pre-existing deployment, ownership of every
--     existing krypto-schema object and the drizzle migration ledger has
--     already been transferred (krypto schema/objects -> schema owner,
--     drizzle ledger -> migrator) by the admin bootstrap step, because
--     ALTER ... OWNER TO requires the *current* session to already own
--     the object -- a legacy admin-owned object can only be re-owned by
--     the admin identity itself, not by krypto_migrator.
--
-- This migration therefore only needs to transfer ownership for the
-- *fresh install* case, where krypto_migrator itself created every
-- krypto-schema object while running migrations 0000-0007 in the same
-- `drizzle-kit migrate` invocation. On an upgrade, every ownership
-- transfer below is a guarded no-op because the objects are already
-- owned by krypto_schema_owner.
--
-- No trading row, table, or history is ever deleted, truncated, or
-- reset by this migration. Every statement is idempotent.
--> statement-breakpoint

-- 1. Fail-closed prerequisite verification. Refuse to proceed (rather
-- than silently skip or fall back) if the admin bootstrap invariants this
-- migration depends on are not met.
DO $$
BEGIN
	IF current_user <> 'krypto_migrator' THEN
		RAISE EXCEPTION
			'Migration 0008 must run as krypto_migrator via MIGRATION_URL, not %.',
			current_user;
	END IF;

	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'krypto_schema_owner') THEN
		RAISE EXCEPTION
			'krypto_schema_owner does not exist. Run the admin database-role bootstrap (DIRECT_URL) before migrating.';
	END IF;

	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'krypto_scheduler') THEN
		RAISE EXCEPTION
			'krypto_scheduler does not exist. Run the admin database-role bootstrap (DIRECT_URL) before migrating.';
	END IF;

	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'krypto_runtime') THEN
		RAISE EXCEPTION
			'krypto_runtime does not exist. Run the admin database-role bootstrap (DIRECT_URL) before migrating.';
	END IF;

	IF NOT pg_has_role(current_user, 'krypto_schema_owner', 'SET') THEN
		RAISE EXCEPTION
			'krypto_migrator cannot SET ROLE krypto_schema_owner. Run the admin database-role bootstrap (DIRECT_URL) before migrating.';
	END IF;

	IF to_regnamespace('krypto') IS NULL THEN
		RAISE EXCEPTION
			'krypto schema does not exist; refusing to run trust-boundary migration out of order.';
	END IF;

	IF (SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname = 'krypto')
		NOT IN ('krypto_migrator', 'krypto_schema_owner') THEN
		RAISE EXCEPTION
			'krypto schema is owned by an unexpected role (%); expected krypto_migrator (fresh install) or krypto_schema_owner (post-bootstrap upgrade). Ownership transfer for a pre-existing deployment must happen in the admin bootstrap step, not this migration.',
			(SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname = 'krypto');
	END IF;
END
$$;
--> statement-breakpoint

-- 2. Fresh-install-only ownership transfer: krypto_migrator created every
-- krypto-schema object while running migrations 0000-0007 in this same
-- invocation. Transfer objects before the schema itself (an object's new
-- owner needs CREATE on its schema, which krypto_schema_owner does not
-- yet have while krypto_migrator still owns the schema), then transfer
-- the schema last. Entirely skipped (no-op loops) on an upgrade, where
-- everything is already owned by krypto_schema_owner.
DO $$
DECLARE
	relation_record record;
	type_record record;
	function_record record;
BEGIN
	IF (SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname = 'krypto') <> 'krypto_migrator' THEN
		RETURN;
	END IF;

	GRANT CREATE, USAGE ON SCHEMA "krypto" TO "krypto_schema_owner";

	FOR relation_record IN
		SELECT relation.oid, relation.relname, relation.relkind
		FROM pg_class AS relation
		JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
		WHERE namespace.nspname = 'krypto'
			AND relation.relkind IN ('r', 'p', 'v', 'm', 'S')
			AND relation.relowner::regrole::text = 'krypto_migrator'
			-- Sequences owned by a table column (SERIAL / GENERATED ... AS
			-- IDENTITY) cannot have their ownership changed independently;
			-- it follows the owning table's ownership automatically, and
			-- attempting it explicitly raises an error.
			AND NOT (
				relation.relkind = 'S'
				AND EXISTS (
					SELECT 1 FROM pg_depend dependency
					WHERE dependency.objid = relation.oid
						AND dependency.deptype IN ('a', 'i')
				)
			)
	LOOP
		IF relation_record.relkind = 'S' THEN
			EXECUTE format(
				'ALTER SEQUENCE "krypto".%I OWNER TO "krypto_schema_owner"',
				relation_record.relname
			);
		ELSE
			EXECUTE format(
				'ALTER TABLE "krypto".%I OWNER TO "krypto_schema_owner"',
				relation_record.relname
			);
		END IF;
	END LOOP;

	FOR type_record IN
		SELECT type.typname
		FROM pg_type AS type
		JOIN pg_namespace AS namespace ON namespace.oid = type.typnamespace
		WHERE namespace.nspname = 'krypto'
			AND type.typtype IN ('e', 'c', 'd')
			AND type.typowner::regrole::text = 'krypto_migrator'
	LOOP
		EXECUTE format(
			'ALTER TYPE "krypto".%I OWNER TO "krypto_schema_owner"',
			type_record.typname
		);
	END LOOP;

	FOR function_record IN
		SELECT routine.oid::regprocedure::text AS signature
		FROM pg_proc AS routine
		JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
		WHERE namespace.nspname = 'krypto'
			AND routine.proowner::regrole::text = 'krypto_migrator'
	LOOP
		EXECUTE format(
			'ALTER FUNCTION %s OWNER TO "krypto_schema_owner"',
			function_record.signature
		);
	END LOOP;

	ALTER SCHEMA "krypto" OWNER TO "krypto_schema_owner";
END
$$;
--> statement-breakpoint

-- 3. Reassert the exact least-privilege krypto_runtime grant matrix
-- (unchanged from migration 0007) and default privileges for any future
-- object, now as the schema owner rather than krypto_migrator. Ownership
-- transfer never touches existing GRANTs, so this step is defense in
-- depth against drift rather than a functional requirement -- but it is
-- also the only way to install *default* privileges scoped to the new
-- owner identity, which did not previously exist.
SET ROLE "krypto_schema_owner";
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA "krypto" FROM "krypto_runtime";
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA "krypto" FROM "krypto_runtime";
--> statement-breakpoint
GRANT USAGE ON SCHEMA "krypto" TO "krypto_runtime";
--> statement-breakpoint
GRANT SELECT, UPDATE ON TABLE "krypto"."AgentState" TO "krypto_runtime";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "krypto"."AgentRun" TO "krypto_runtime";
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "krypto"."TradeExecution" TO "krypto_runtime";
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "krypto"."AgentJournal" TO "krypto_runtime";
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE "krypto_schema_owner" IN SCHEMA "krypto"
	REVOKE ALL PRIVILEGES ON TABLES FROM "krypto_runtime";
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE "krypto_schema_owner" IN SCHEMA "krypto"
	REVOKE ALL PRIVILEGES ON SEQUENCES FROM "krypto_runtime";
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE "krypto_schema_owner" IN SCHEMA "krypto"
	REVOKE EXECUTE ON FUNCTIONS FROM "krypto_runtime";
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE "krypto_schema_owner" IN SCHEMA "krypto"
	REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE "krypto_schema_owner" IN SCHEMA "krypto"
	REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE "krypto_schema_owner" IN SCHEMA "krypto"
	REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
-- krypto_migrator also creates objects directly (migrations 0000-0007 on
-- a fresh install, and any future migration that forgets to
-- `SET ROLE krypto_schema_owner` before creating an object). Mirror the
-- same default-privilege posture for krypto_migrator as creator so a
-- forgotten SET ROLE never leaves a future object with wider-than-
-- intended default access.
ALTER DEFAULT PRIVILEGES FOR ROLE "krypto_migrator" IN SCHEMA "krypto"
	REVOKE ALL PRIVILEGES ON TABLES FROM "krypto_runtime";
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE "krypto_migrator" IN SCHEMA "krypto"
	REVOKE ALL PRIVILEGES ON SEQUENCES FROM "krypto_runtime";
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE "krypto_migrator" IN SCHEMA "krypto"
	REVOKE EXECUTE ON FUNCTIONS FROM "krypto_runtime";
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE "krypto_migrator" IN SCHEMA "krypto"
	REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE "krypto_migrator" IN SCHEMA "krypto"
	REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE "krypto_migrator" IN SCHEMA "krypto"
	REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
--> statement-breakpoint

-- 4. The drizzle migration ledger: krypto_migrator owns it on a fresh
-- install (it created it by running `drizzle-kit migrate`), and the
-- admin bootstrap step transfers its ownership to krypto_migrator ahead
-- of time on an upgrade. Either way krypto_migrator owns it by the time
-- this statement runs, so it can revoke runtime access itself -- the
-- runtime must never be able to read or write migration history.
DO $$
BEGIN
	IF to_regnamespace('drizzle') IS NULL THEN
		RETURN;
	END IF;

	EXECUTE 'REVOKE ALL ON SCHEMA "drizzle" FROM "krypto_runtime"';
	EXECUTE 'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA "drizzle" FROM "krypto_runtime"';
	EXECUTE 'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA "drizzle" FROM "krypto_runtime"';
	EXECUTE 'REVOKE ALL ON SCHEMA "drizzle" FROM PUBLIC';
	EXECUTE 'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA "drizzle" FROM PUBLIC';
END
$$;
--> statement-breakpoint

-- 5. krypto_runtime must never itself be a member of the elevated
-- roles. Revoking role membership requires the ADMIN option on the
-- target role -- an object-ownership-scoped role like krypto_migrator
-- never holds that by design, so this invariant is established and
-- enforced by the admin database-role bootstrap step (which already
-- requires role-management authority to create these roles in the
-- first place) rather than by this migration. This migration only
-- verifies the invariant below and fails closed if it does not hold.

-- 6. Final fail-closed self-verification. If any invariant below does
-- not hold, this migration fails the deployment rather than leaving a
-- silently-inconsistent trust boundary in place.
DO $$
DECLARE
	bad_owner_count integer;
BEGIN
	SELECT count(*) INTO bad_owner_count
	FROM pg_class AS relation
	JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
	WHERE namespace.nspname = 'krypto'
		AND relation.relkind IN ('r', 'p', 'v', 'm', 'S')
		AND relation.relowner::regrole::text <> 'krypto_schema_owner';

	IF bad_owner_count > 0 THEN
		RAISE EXCEPTION
			'% object(s) in schema krypto are not owned by krypto_schema_owner after trust-boundary migration.',
			bad_owner_count;
	END IF;

	IF (SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname = 'krypto') <> 'krypto_schema_owner' THEN
		RAISE EXCEPTION 'Schema krypto is not owned by krypto_schema_owner after trust-boundary migration.';
	END IF;

	IF pg_has_role('krypto_runtime', 'krypto_schema_owner', 'MEMBER')
		OR pg_has_role('krypto_runtime', 'krypto_migrator', 'MEMBER')
		OR pg_has_role('krypto_runtime', 'krypto_scheduler', 'MEMBER') THEN
		RAISE EXCEPTION
			'krypto_runtime is a member of an elevated role after trust-boundary migration; refusing to leave the deployment in this state.';
	END IF;
END
$$;
