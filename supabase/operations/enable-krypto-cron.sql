-- Run only after disabled and shadow production smoke checks pass.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $$
BEGIN
	IF to_regprocedure('krypto.invoke_agent_run()') IS NULL
		OR to_regprocedure('krypto.invoke_daily_summary()') IS NULL THEN
		RAISE EXCEPTION 'Fixed Krypto cron functions are not installed';
	END IF;

	IF NOT EXISTS (
		SELECT 1
		FROM vault.decrypted_secrets
		WHERE name = 'krypto_cron_secret'
	) OR NOT EXISTS (
		SELECT 1
		FROM vault.decrypted_secrets
		WHERE name = 'krypto_vercel_url'
	) THEN
		RAISE EXCEPTION 'Required Krypto Vault secrets are not configured';
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
