CREATE OR REPLACE FUNCTION "krypto"."invoke_agent_run"()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
	v_secret text;
	v_url_base text;
	v_required_mode text;
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

	SELECT decrypted_secret
	INTO v_required_mode
	FROM vault.decrypted_secrets
	WHERE name = 'krypto_rollout_mode'
	LIMIT 1;

	IF v_secret IS NULL OR v_secret = '' THEN
		RAISE EXCEPTION 'Vault secret krypto_cron_secret is missing';
	END IF;

	IF v_url_base IS NULL
		OR v_url_base !~ '^https://[^/]+/?$' THEN
		RAISE EXCEPTION 'Vault secret krypto_vercel_url must be an HTTPS origin';
	END IF;

	IF v_required_mode NOT IN ('shadow', 'paper') THEN
		RAISE EXCEPTION 'Vault secret krypto_rollout_mode must be shadow or paper';
	END IF;

	SELECT net.http_post(
		url := rtrim(v_url_base, '/') || '/api/agent/run',
		headers := jsonb_build_object(
			'Content-Type', 'application/json',
			'x-cron-secret', v_secret,
			'x-required-rollout-mode', v_required_mode,
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
	v_required_mode text;
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

	SELECT decrypted_secret
	INTO v_required_mode
	FROM vault.decrypted_secrets
	WHERE name = 'krypto_rollout_mode'
	LIMIT 1;

	IF v_secret IS NULL OR v_secret = '' THEN
		RAISE EXCEPTION 'Vault secret krypto_cron_secret is missing';
	END IF;

	IF v_url_base IS NULL
		OR v_url_base !~ '^https://[^/]+/?$' THEN
		RAISE EXCEPTION 'Vault secret krypto_vercel_url must be an HTTPS origin';
	END IF;

	IF v_required_mode NOT IN ('shadow', 'paper') THEN
		RAISE EXCEPTION 'Vault secret krypto_rollout_mode must be shadow or paper';
	END IF;

	SELECT net.http_post(
		url := rtrim(v_url_base, '/') || '/api/agent/daily-summary',
		headers := jsonb_build_object(
			'Content-Type', 'application/json',
			'x-cron-secret', v_secret,
			'x-required-rollout-mode', v_required_mode
		),
		body := '{}'::jsonb,
		timeout_milliseconds := 55000
	)
	INTO v_request_id;

	RETURN v_request_id;
END
$$;