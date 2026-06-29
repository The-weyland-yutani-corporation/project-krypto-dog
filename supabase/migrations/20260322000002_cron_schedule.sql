-- supabase/migrations/20260322000002_cron_schedule.sql
--
-- Schedules the Krypto agent on Supabase pg_cron via pg_net.
--
-- ============================================================================
-- PREREQUISITE — before applying, store secrets in Supabase Vault:
--
--   SELECT vault.create_secret('YOUR-ACTUAL-CRON-SECRET',  'krypto_cron_secret');
--   SELECT vault.create_secret('https://your-app.vercel.app', 'krypto_vercel_url');
--
-- Both Vault entries MUST exist before pg_cron fires, otherwise
-- public.krypto_invoke_endpoint() raises and the cron job records a failure.
--
-- The Vault values are read on every job invocation (not at schedule time),
-- so rotating the cron secret only requires updating the Vault row — no
-- migration re-run needed.
-- ============================================================================
--
-- Operational monitoring (run from Supabase SQL editor):
--   SELECT * FROM cron.job;                                       -- registered jobs
--   SELECT * FROM cron.job_run_details ORDER BY runid DESC LIMIT 20;  -- recent runs
--   SELECT * FROM net._http_response   ORDER BY id    DESC LIMIT 20;  -- HTTP results
--
-- Rollback:
--   SELECT cron.unschedule('krypto-agent-run-hourly');
--   SELECT cron.unschedule('krypto-daily-summary');
--   DROP FUNCTION public.krypto_invoke_endpoint(TEXT);

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Compatibility for the Supabase migration track: Drizzle has a dedicated
-- migration for this column, but this file may be applied on a fresh Supabase
-- project before the idempotent 0003 backfill below. Keep cron-safe schema in
-- place before scheduling jobs.
ALTER TABLE "AgentState"
ADD COLUMN IF NOT EXISTS "isOperatorPaused" BOOLEAN NOT NULL DEFAULT false;

-- ----------------------------------------------------------------------------
-- Helper: invoke a Krypto API endpoint with the cron-secret header.
-- Reads URL + secret from Vault on every call (so rotation = single UPDATE).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.krypto_invoke_endpoint(endpoint_path TEXT)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_secret      TEXT;
  v_url_base    TEXT;
  v_request_id  bigint;
BEGIN
  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets
  WHERE name = 'krypto_cron_secret'
  LIMIT 1;

  IF v_secret IS NULL THEN
    RAISE EXCEPTION
      'Vault secret "krypto_cron_secret" not found. Run: SELECT vault.create_secret(''<your-cron-secret>'', ''krypto_cron_secret'')';
  END IF;

  SELECT decrypted_secret INTO v_url_base
  FROM vault.decrypted_secrets
  WHERE name = 'krypto_vercel_url'
  LIMIT 1;

  IF v_url_base IS NULL THEN
    RAISE EXCEPTION
      'Vault secret "krypto_vercel_url" not found. Run: SELECT vault.create_secret(''https://your-app.vercel.app'', ''krypto_vercel_url'')';
  END IF;

  -- Strip trailing slash to avoid `//api/...` URLs.
  v_url_base := rtrim(v_url_base, '/');

  SELECT net.http_post(
    url := v_url_base || endpoint_path,
    headers := jsonb_build_object(
      'Content-Type',   'application/json',
      'x-cron-secret',  v_secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000  -- Vercel function ceiling
  ) INTO v_request_id;

  RETURN v_request_id;
END;
$$;

-- ----------------------------------------------------------------------------
-- Idempotent reschedule: unschedule existing jobs (if any), then schedule.
-- Lets this migration safely re-run during local resets and recovery.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  PERFORM cron.unschedule('krypto-agent-run-hourly');
EXCEPTION WHEN OTHERS THEN
  NULL;  -- job didn't exist — fine
END;
$$;

DO $$
BEGIN
  PERFORM cron.unschedule('krypto-daily-summary');
EXCEPTION WHEN OTHERS THEN
  NULL;  -- job didn't exist — fine
END;
$$;

-- Hourly: POST /api/agent/run    (top of every hour, UTC)
SELECT cron.schedule(
  'krypto-agent-run-hourly',
  '0 * * * *',
  $cmd$ SELECT public.krypto_invoke_endpoint('/api/agent/run'); $cmd$
);

-- Daily summary: POST /api/agent/daily-summary  (00:05 UTC)
-- 00:05 not 00:00 to give the hourly job a clean buffer.
SELECT cron.schedule(
  'krypto-daily-summary',
  '5 0 * * *',
  $cmd$ SELECT public.krypto_invoke_endpoint('/api/agent/daily-summary'); $cmd$
);
