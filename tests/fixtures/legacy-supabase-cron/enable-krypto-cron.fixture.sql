-- TEST FIXTURE ONLY - LEGACY PRE-0007 INPUT.
-- DO NOT RUN THIS FILE AGAINST A REAL, SHARED, OR PRODUCTION DATABASE.
-- It preserves the retired hosted-baseline cron program solely for disposable
-- migration tests that reproduce the state before Drizzle migration 0007.
--
-- The historical operator preconditions are intentionally not reproduced here;
-- the migration test runner creates every dependency in a disposable database.
BEGIN;

DO $$
DECLARE
	v_security_definer boolean;
	v_language text;
	v_owner text;
	v_configuration text[];
	v_source text;
	v_result_type text;
	v_secret text;
	v_url_base text;
	v_required_mode text;
	v_approved_binding text;
	v_approved_origin text;
	v_approved_secret_md5 text;
BEGIN
	SELECT
		p.prosecdef,
		l.lanname,
		pg_get_userbyid(p.proowner),
		p.proconfig,
		p.prosrc,
		pg_get_function_result(p.oid)
	INTO
		v_security_definer,
		v_language,
		v_owner,
		v_configuration,
		v_source,
		v_result_type
	FROM pg_proc AS p
	JOIN pg_language AS l ON l.oid = p.prolang
	WHERE p.oid = to_regprocedure('krypto.invoke_agent_run()');

	IF NOT FOUND
		OR NOT v_security_definer
		OR v_language <> 'plpgsql'
		OR v_owner <> current_user
		OR v_configuration IS DISTINCT FROM
			ARRAY['search_path=pg_catalog']
		OR v_result_type <> 'bigint'
		OR md5(v_source) <> '3cb03ace0e82bee3f8b755701a10ea6b'
	THEN
		RAISE EXCEPTION 'Agent-run cron function failed integrity verification';
	END IF;

	SELECT
		p.prosecdef,
		l.lanname,
		pg_get_userbyid(p.proowner),
		p.proconfig,
		p.prosrc,
		pg_get_function_result(p.oid)
	INTO
		v_security_definer,
		v_language,
		v_owner,
		v_configuration,
		v_source,
		v_result_type
	FROM pg_proc AS p
	JOIN pg_language AS l ON l.oid = p.prolang
	WHERE p.oid = to_regprocedure('krypto.invoke_daily_summary()');

	IF NOT FOUND
		OR NOT v_security_definer
		OR v_language <> 'plpgsql'
		OR v_owner <> current_user
		OR v_configuration IS DISTINCT FROM
			ARRAY['search_path=pg_catalog']
		OR v_result_type <> 'bigint'
		OR md5(v_source) <> '68aee98c8c762497b1b0cf016ea6d25d'
	THEN
		RAISE EXCEPTION 'Daily-summary cron function failed integrity verification';
	END IF;

	IF NOT EXISTS (
		SELECT 1
		FROM pg_extension
		WHERE extname = 'pg_cron'
	) OR NOT EXISTS (
		SELECT 1
		FROM pg_extension
		WHERE extname = 'pg_net'
	) THEN
		RAISE EXCEPTION 'Required pg_cron and pg_net extensions are not enabled';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM cron.job
		WHERE active
			AND COALESCE(jobname, '') NOT IN (
				'krypto-agent-run-hourly',
				'krypto-daily-summary'
			)
			AND (
				COALESCE(jobname, '') ILIKE 'krypto%'
				OR COALESCE(command, '') ILIKE '%krypto%'
				OR COALESCE(command, '')
					~* '/api/agent/(run|daily-summary)'
				OR COALESCE(command, '')
					~* 'invoke_(agent_run|daily_summary)'
				OR COALESCE(command, '')
					ILIKE '%krypto_invoke_endpoint%'
			)
	) THEN
		RAISE EXCEPTION 'Unexpected active Krypto cron job must be removed before activation';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM net.http_request_queue
		WHERE url ~* '/api/agent/(run|daily-summary)'
	) THEN
		RAISE EXCEPTION 'Pending Krypto HTTP requests must drain before cron activation';
	END IF;

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

	IF v_secret IS NULL OR v_secret = ''
		OR v_url_base IS NULL
		OR v_url_base !~ '^https://[^/]+/?$'
		OR v_required_mode IS NULL
		OR v_required_mode NOT IN ('shadow', 'paper') THEN
		RAISE EXCEPTION 'Required Krypto Vault secrets are not configured';
	END IF;

	SELECT
		"marketConditions" ->> 'bindingId',
		"marketConditions" ->> 'targetOrigin',
		"marketConditions" ->> 'cronSecretMd5'
	INTO
		v_approved_binding,
		v_approved_origin,
		v_approved_secret_md5
	FROM krypto."AgentJournal"
	WHERE "marketConditions" ->> 'event' = 'deployment-smoke-approved'
	ORDER BY "createdAt" DESC
	LIMIT 1;

	IF v_approved_binding IS NULL
		OR v_approved_origin IS NULL
		OR v_approved_secret_md5 IS NULL
		OR rtrim(v_url_base, '/') <> v_approved_origin
		OR md5(v_secret) <> v_approved_secret_md5
		OR NOT EXISTS (
			SELECT 1
			FROM krypto."AgentJournal"
			WHERE id = v_approved_binding
				AND "marketConditions" ->> 'event'
					= 'deployment-smoke-binding'
		) THEN
		RAISE EXCEPTION 'Vault cron configuration is not bound to a passing target smoke';
	END IF;
END
$$;

SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname IN ('krypto-agent-run-hourly', 'krypto-daily-summary');

SELECT cron.schedule(
	'krypto-agent-run-hourly',
	'0 * * * *',
	'SELECT krypto.invoke_agent_run();'
);

SELECT cron.schedule(
	'krypto-daily-summary',
	'5 0 * * *',
	'SELECT krypto.invoke_daily_summary();'
);

DO $$
BEGIN
	IF (
		SELECT count(*)
		FROM cron.job
		WHERE jobname IN (
			'krypto-agent-run-hourly',
			'krypto-daily-summary'
		)
	) <> 2 OR (
		SELECT count(*)
		FROM cron.job
		WHERE active
			AND (
				(
					jobname = 'krypto-agent-run-hourly'
					AND schedule = '0 * * * *'
					AND command = 'SELECT krypto.invoke_agent_run();'
				)
				OR (
					jobname = 'krypto-daily-summary'
					AND schedule = '5 0 * * *'
					AND command = 'SELECT krypto.invoke_daily_summary();'
				)
			)
	) <> 2 OR EXISTS (
		SELECT 1
		FROM cron.job
		WHERE active
			AND COALESCE(jobname, '') NOT IN (
				'krypto-agent-run-hourly',
				'krypto-daily-summary'
			)
			AND (
				COALESCE(jobname, '') ILIKE 'krypto%'
				OR COALESCE(command, '') ILIKE '%krypto%'
				OR COALESCE(command, '')
					~* '/api/agent/(run|daily-summary)'
				OR COALESCE(command, '')
					~* 'invoke_(agent_run|daily_summary)'
				OR COALESCE(command, '')
					ILIKE '%krypto_invoke_endpoint%'
			)
	) OR EXISTS (
		SELECT 1
		FROM net.http_request_queue
		WHERE url ~* '/api/agent/(run|daily-summary)'
	) THEN
		RAISE EXCEPTION 'Krypto cron jobs failed final definition verification';
	END IF;
END
$$;

COMMIT;
