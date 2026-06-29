# 0003 — Supabase pg_cron over Vercel Cron

- **Status:** Accepted
- **Date:** 2026-03-22
- **Deciders:** @VeVarunSharma

## Context

The agent must run on a schedule (hourly during paper trading; eventually WebSocket-triggered in v3). Two reasonable options exist for triggering the Vercel API route:

1. **Vercel Cron** — built into the Vercel platform, configured via `vercel.json`.
2. **Supabase pg_cron + pg_net** — Postgres extension that schedules jobs and makes HTTP calls from the database.

## Decision

**Use Supabase `pg_cron` + `pg_net`** to schedule HTTP POSTs to `/api/agent/run` and `/api/agent/daily-summary`.

The schedule lives in `supabase/migrations/20260322000002_cron_schedule.sql` so it ships with the database, not the application code.

## Consequences

- **Positive:** Schedule lives next to the data. Disaster recovery is one `pg_dump` (DB + cron + secrets) instead of two systems.
- **Positive:** No Vercel Hobby/Pro tier limits on cron frequency or count (Hobby caps at 1×/day; Pro at limited counts).
- **Positive:** Calls survive Vercel project re-linking.
- **Positive:** Easier to migrate the trigger model in v3 (e.g., listen on a Postgres `LISTEN` channel from a price oracle) without changing Vercel config.
- **Trade-off:** Adds a dependency on Supabase's `pg_net` extension (Supabase-managed, low risk).
- **Trade-off:** First deploy requires manual substitution of the Vercel host URL inside the migration. Documented in `specs/deployment.md`.
- **Follow-up:** Operators must monitor `cron.job_run_details` and `net._http_response` for failed schedule runs.

## Alternatives considered

- **Vercel Cron:** rejected — schedule is divorced from data; tier limits constrain experimentation; harder to migrate to event-driven triggers later.
- **External scheduler (GitHub Actions, EventBridge):** rejected — adds an unrelated service for a single hourly POST; overkill at this stage.
