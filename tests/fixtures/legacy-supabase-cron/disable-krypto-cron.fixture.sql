-- TEST FIXTURE ONLY - LEGACY PRE-0007 INPUT.
-- DO NOT RUN THIS FILE AGAINST A REAL, SHARED, OR PRODUCTION DATABASE.
-- It preserves the retired hosted-baseline cron cleanup solely for disposable
-- migration tests that reproduce the state before Drizzle migration 0007.
--
BEGIN;

DO $$
DECLARE
	v_job_id bigint;
	v_remaining boolean;
BEGIN
	IF to_regclass('cron.job') IS NOT NULL THEN
		FOR v_job_id IN
			SELECT jobid
			FROM cron.job
			WHERE jobname IN (
					'krypto-agent-run-hourly',
					'krypto-daily-summary'
				)
				OR COALESCE(jobname, '') ILIKE 'krypto%'
				OR COALESCE(command, '') ILIKE '%krypto%'
				OR COALESCE(command, '')
					~* '/api/agent/(run|daily-summary)'
				OR COALESCE(command, '')
					~* 'invoke_(agent_run|daily_summary)'
				OR COALESCE(command, '')
					ILIKE '%krypto_invoke_endpoint%'
		LOOP
			PERFORM cron.unschedule(v_job_id);
		END LOOP;
	END IF;

	IF to_regclass('net.http_request_queue') IS NOT NULL THEN
		DELETE FROM net.http_request_queue
		WHERE url ~* '/api/agent/(run|daily-summary)';
	END IF;

	v_remaining := false;
	IF to_regclass('cron.job') IS NOT NULL THEN
		SELECT EXISTS (
			SELECT 1
			FROM cron.job
			WHERE jobname IN (
					'krypto-agent-run-hourly',
					'krypto-daily-summary'
				)
				OR COALESCE(jobname, '') ILIKE 'krypto%'
				OR COALESCE(command, '') ILIKE '%krypto%'
				OR COALESCE(command, '')
					~* '/api/agent/(run|daily-summary)'
				OR COALESCE(command, '')
					~* 'invoke_(agent_run|daily_summary)'
				OR COALESCE(command, '')
					ILIKE '%krypto_invoke_endpoint%'
		)
		INTO v_remaining;
	END IF;

	IF NOT v_remaining
		AND to_regclass('net.http_request_queue') IS NOT NULL THEN
		SELECT EXISTS (
			SELECT 1
			FROM net.http_request_queue
			WHERE url ~* '/api/agent/(run|daily-summary)'
		)
		INTO v_remaining;
	END IF;

	IF v_remaining THEN
		RAISE EXCEPTION 'Krypto schedules or queued HTTP requests remain active';
	END IF;
END
$$;

COMMIT;
