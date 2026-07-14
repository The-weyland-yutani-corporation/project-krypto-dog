CREATE SCHEMA IF NOT EXISTS "krypto";
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM pg_type type
		JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
		WHERE namespace.nspname = 'public'
			AND type.typname = 'TradeDirection'
	) AND NOT EXISTS (
		SELECT 1
		FROM pg_type type
		JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
		WHERE namespace.nspname = 'krypto'
			AND type.typname = 'TradeDirection'
	) THEN
		ALTER TYPE "public"."TradeDirection" SET SCHEMA "krypto";
	END IF;
END
$$;
--> statement-breakpoint
DO $$
BEGIN
	IF to_regclass('public."AgentJournal"') IS NOT NULL
		AND to_regclass('krypto."AgentJournal"') IS NULL THEN
		ALTER TABLE "public"."AgentJournal" SET SCHEMA "krypto";
	END IF;

	IF to_regclass('public."AgentState"') IS NOT NULL
		AND to_regclass('krypto."AgentState"') IS NULL THEN
		ALTER TABLE "public"."AgentState" SET SCHEMA "krypto";
	END IF;

	IF to_regclass('public."TradeExecution"') IS NOT NULL
		AND to_regclass('krypto."TradeExecution"') IS NULL THEN
		ALTER TABLE "public"."TradeExecution" SET SCHEMA "krypto";
	END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON SCHEMA "krypto" FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA "krypto" FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA "krypto" FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA "krypto"
	REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA "krypto"
	REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA "krypto"
	REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "krypto"."invoke_agent_run"()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
	v_secret text;
	v_url_base text;
	v_request_id bigint;
BEGIN
	SELECT decrypted_secret
	INTO v_secret
	FROM vault.decrypted_secrets
	WHERE name = 'krypto_cron_secret'
	LIMIT 1;

	SELECT decrypted_secret
	INTO v_url_base
	FROM vault.decrypted_secrets
	WHERE name = 'krypto_vercel_url'
	LIMIT 1;

	IF v_secret IS NULL OR v_secret = '' THEN
		RAISE EXCEPTION 'Vault secret krypto_cron_secret is missing';
	END IF;

	IF v_url_base IS NULL
		OR v_url_base !~ '^https://[^/]+/?$' THEN
		RAISE EXCEPTION 'Vault secret krypto_vercel_url must be an HTTPS origin';
	END IF;

	SELECT net.http_post(
		url := rtrim(v_url_base, '/') || '/api/agent/run',
		headers := jsonb_build_object(
			'Content-Type', 'application/json',
			'x-cron-secret', v_secret,
			'x-idempotency-key',
			'cron:' || to_char(
				date_trunc('hour', clock_timestamp() AT TIME ZONE 'UTC'),
				'YYYY-MM-DD"T"HH24'
			)
		),
		body := '{}'::jsonb,
		timeout_milliseconds := 55000
	)
	INTO v_request_id;

	RETURN v_request_id;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "krypto"."invoke_daily_summary"()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
	v_secret text;
	v_url_base text;
	v_request_id bigint;
BEGIN
	SELECT decrypted_secret
	INTO v_secret
	FROM vault.decrypted_secrets
	WHERE name = 'krypto_cron_secret'
	LIMIT 1;

	SELECT decrypted_secret
	INTO v_url_base
	FROM vault.decrypted_secrets
	WHERE name = 'krypto_vercel_url'
	LIMIT 1;

	IF v_secret IS NULL OR v_secret = '' THEN
		RAISE EXCEPTION 'Vault secret krypto_cron_secret is missing';
	END IF;

	IF v_url_base IS NULL
		OR v_url_base !~ '^https://[^/]+/?$' THEN
		RAISE EXCEPTION 'Vault secret krypto_vercel_url must be an HTTPS origin';
	END IF;

	SELECT net.http_post(
		url := rtrim(v_url_base, '/') || '/api/agent/daily-summary',
		headers := jsonb_build_object(
			'Content-Type', 'application/json',
			'x-cron-secret', v_secret
		),
		body := '{}'::jsonb,
		timeout_milliseconds := 55000
	)
	INTO v_request_id;

	RETURN v_request_id;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "krypto"."invoke_agent_run"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "krypto"."invoke_daily_summary"() FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE
	role_name text;
BEGIN
	IF to_regclass('vault.decrypted_secrets') IS NOT NULL THEN
		REVOKE ALL PRIVILEGES ON TABLE vault.decrypted_secrets FROM PUBLIC;
	END IF;

	FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated']
	LOOP
		IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
			EXECUTE format(
				'REVOKE ALL ON SCHEMA krypto FROM %I',
				role_name
			);
			EXECUTE format(
				'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA krypto FROM %I',
				role_name
			);
			EXECUTE format(
				'REVOKE EXECUTE ON FUNCTION krypto.invoke_agent_run() FROM %I',
				role_name
			);
			EXECUTE format(
				'REVOKE EXECUTE ON FUNCTION krypto.invoke_daily_summary() FROM %I',
				role_name
			);
			IF to_regclass('vault.decrypted_secrets') IS NOT NULL THEN
				EXECUTE format(
					'REVOKE ALL PRIVILEGES ON TABLE vault.decrypted_secrets FROM %I',
					role_name
				);
			END IF;
		END IF;
	END LOOP;

	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
		GRANT USAGE ON SCHEMA "krypto" TO service_role;
		GRANT EXECUTE ON FUNCTION "krypto"."invoke_agent_run"()
			TO service_role;
		GRANT EXECUTE ON FUNCTION "krypto"."invoke_daily_summary"()
			TO service_role;
	END IF;
END
$$;
