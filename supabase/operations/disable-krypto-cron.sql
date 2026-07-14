SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname IN ('krypto-agent-run-hourly', 'krypto-daily-summary');
