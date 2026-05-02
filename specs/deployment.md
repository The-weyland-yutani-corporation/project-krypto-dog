# Deployment Runbook

End-to-end recipe for deploying Project Krypto (paper-trading v2) to **Vercel + Supabase**. Assumes you have local development working per the README.

> **Status target after this runbook:** the agent runs hourly against a Supabase Postgres DB, observable via PostHog + the `/admin` dashboard + the daily-summary email. **No real money moves** — all execution is paper-modelled until v3.

---

## 0. Pre-flight checklist

Before touching production, confirm you have:

- [ ] **Vercel** project linked (`vercel link`). If not yet, run `vercel link` in the repo root.
- [ ] **Supabase** project created. Note the project ref, the `postgres` user password, and both connection URLs:
  - Pooler URL (port `6543`, append `?pgbouncer=true&connection_limit=1`) → `DATABASE_URL`
  - Direct URL (port `5432`) → `DIRECT_URL` (used by drizzle-kit migrations)
- [ ] **Azure OpenAI** resource provisioned with a `gpt-4o` deployment. Have endpoint URL, API key, deployment name.
- [ ] **PostHog** project created. Have project API key + region host (`https://us.i.posthog.com` or `https://eu.i.posthog.com`).
- [ ] **Resend** account with the sending domain verified (otherwise `ALERT_EMAIL_FROM` will be rejected). Have `RESEND_API_KEY`.
- [ ] **Coinbase Developer Platform** API key (declared as required in `validateEnv()` schema; not used in v2 paper trading but must be present).
- [ ] Two strong random secrets generated (`openssl rand -hex 32`):
  - `CRON_SECRET` — auth header for cron-triggered routes.
  - `ADMIN_SESSION_SECRET` — HMAC key for admin cookies.
- [ ] One strong admin password (`openssl rand -base64 24` is fine) → `ADMIN_PASSWORD`.

---

## 1. Apply database migrations

Migrations are split:

| Migration | Purpose | When to apply |
|---|---|---|
| `supabase/migrations/20260322000000_init_schema.sql` | Tables (AgentState, TradeExecution, AgentJournal) + indexes + enum | First deploy |
| `supabase/migrations/20260322000001_seed_data.sql` | Seeds the AgentState singleton (`id='singleton'`, USDC=200) | First deploy |
| `supabase/migrations/20260322000002_cron_schedule.sql` | pg_cron + pg_net + scheduled jobs | After §2 (Vault setup) |

```bash
# From the repo root, with DIRECT_URL set in .env.production.local
DATABASE_URL="<your-direct-url>" npm run db:push
```

`drizzle-kit push` will sync the schema to Supabase. Verify in the Supabase Studio → Tables that `AgentState`, `TradeExecution`, `AgentJournal` exist.

> **Why not just `supabase db push`?** Either works. `drizzle-kit push` keeps the Drizzle schema as canonical (see ADR `0001-drizzle-over-prisma.md`). If you prefer the Supabase CLI, `supabase db push` will pick up the migrations in `supabase/migrations/` in order.

### Seed the singleton

```bash
DATABASE_URL="<your-pooler-url>" npm run db:seed
```

This inserts the `AgentState` row with `id='singleton'`. **Skipping this step makes the first cron run fail** because `checkDrawdown` throws `AgentState singleton not found`.

Verify:

```sql
SELECT id, currentPositionETH, currentPositionUSDC, isLocked, isRunning
FROM "AgentState";
-- expect: singleton | 0 | 200 | false | false
```

---

## 2. Store cron secrets in Supabase Vault

The `pg_cron` migration reads the cron secret + Vercel URL from Supabase Vault on every job invocation. Set them once, **before** applying the cron migration:

In the Supabase SQL Editor:

```sql
-- Replace with your actual values
SELECT vault.create_secret('<your-cron-secret>',           'krypto_cron_secret');
SELECT vault.create_secret('https://<your-app>.vercel.app', 'krypto_vercel_url');

-- Verify both exist
SELECT name FROM vault.decrypted_secrets WHERE name IN ('krypto_cron_secret', 'krypto_vercel_url');
-- expect: both names listed
```

To **rotate** later, `UPDATE vault.secrets SET secret = vault.encrypt_secret(...) WHERE name = '...'`. Cron jobs pick up the new value on the next tick.

---

## 3. Apply the cron schedule migration

```bash
# Via Supabase CLI:
supabase db push

# Or paste the contents of supabase/migrations/20260322000002_cron_schedule.sql
# into the SQL Editor and run.
```

Verify the jobs registered:

```sql
SELECT jobid, jobname, schedule, command FROM cron.job;
-- expect 2 rows: krypto-agent-run-hourly, krypto-daily-summary
```

> **Don't enable yet.** `cron.schedule` registers jobs but they fire on the schedule. To pause until you've smoke-tested the endpoint, use `SELECT cron.unschedule('krypto-agent-run-hourly');` and re-schedule via the migration once you're confident.

---

## 4. Configure Vercel environment variables

In the Vercel project → **Settings → Environment Variables**, add (Production scope):

| Variable | Value |
|---|---|
| `AZURE_OPENAI_ENDPOINT` | from Azure portal |
| `AZURE_OPENAI_API_KEY` | from Azure portal |
| `AZURE_OPENAI_DEPLOYMENT_NAME` | e.g. `gpt-4o` |
| `CDP_API_KEY_NAME` | from Coinbase Developer Platform |
| `CDP_API_KEY_PRIVATE_KEY` | from CDP (use as-is, including newlines) |
| `DATABASE_URL` | Supabase pooler URL with `?pgbouncer=true&connection_limit=1` |
| `POSTHOG_API_KEY` | from PostHog |
| `POSTHOG_HOST` | `https://us.i.posthog.com` (or eu) |
| `CRON_SECRET` | same value stored in Vault as `krypto_cron_secret` |
| `RESEND_API_KEY` | from Resend |
| `ALERT_EMAIL_TO` | recipient address |
| `ALERT_EMAIL_FROM` | from your verified Resend domain |
| `ADMIN_PASSWORD` | strong random password |
| `ADMIN_SESSION_SECRET` | dedicated HMAC key (different from `CRON_SECRET`) |

Trigger a deploy: `git push origin main` (Vercel auto-deploys) or `vercel --prod`.

---

## 5. Smoke test (do this before enabling cron!)

### 5a. Manual `POST /api/agent/run`

```bash
CRON_SECRET="<your-secret>" \
VERCEL_URL="https://<your-app>.vercel.app" \
curl -X POST "$VERCEL_URL/api/agent/run" \
  -H "x-cron-secret: $CRON_SECRET" \
  -H "Content-Type: application/json" \
  -i
```

Expected outcomes (any of these = healthy):

- `200 {"status":"executed", ...}` — agent decided to trade.
- `200 {"status":"skipped", "action":"hold", ...}` — agent decided to hold.
- `200 {"status":"skipped", "guardrailTriggered":"Cooldown active..."}` — within 2h of last trade. Expected on second invocation.
- `200 {"status":"locked", "guardrailTriggered":"System locked..."}` — drawdown breach. Investigate immediately.

Failure modes:

| Response | Likely cause |
|---|---|
| `401 Unauthorized` | `x-cron-secret` header doesn't match `CRON_SECRET` env var. |
| `409 Agent is already running` | Stale mutex. Run: `UPDATE "AgentState" SET "isRunning" = false WHERE id = 'singleton';` |
| `500 AgentState singleton not found` | Skipped step 1 seed. Re-run `npm run db:seed`. |
| `500 Invalid environment variables` | Check Vercel env vars vs `validateEnv()` schema in `src/lib/config.ts`. |
| `502 Coinbase API error` | Transient. Re-try. If persistent, check Coinbase status. |

### 5b. Verify side effects

After a successful run:

1. **Database:** new row in `AgentJournal`, optionally a new row in `TradeExecution`, `AgentState.lastRunAt` updated.
2. **PostHog:** events `agent_run_started` and `agent_run_completed` visible in the live activity view.
3. **Admin dashboard:** open `https://<your-app>.vercel.app/admin/login`, sign in with `ADMIN_PASSWORD`, confirm dashboard loads.

### 5c. Manual `POST /api/agent/daily-summary`

```bash
curl -X POST "$VERCEL_URL/api/agent/daily-summary" \
  -H "x-cron-secret: $CRON_SECRET" -i
```

Expected: `200 {"success":true,"tradesCount":N,"totalPnlUSD":X}` and an email arrives at `ALERT_EMAIL_TO`.

---

## 6. Enable production cron

If you previously unscheduled (§3), re-apply the migration or run inline:

```sql
SELECT cron.schedule(
  'krypto-agent-run-hourly',
  '0 * * * *',
  $cmd$ SELECT public.krypto_invoke_endpoint('/api/agent/run'); $cmd$
);

SELECT cron.schedule(
  'krypto-daily-summary',
  '5 0 * * *',
  $cmd$ SELECT public.krypto_invoke_endpoint('/api/agent/daily-summary'); $cmd$
);
```

Wait one full hour, then verify:

```sql
SELECT runid, jobname, status, return_message, start_time, end_time
FROM cron.job_run_details
ORDER BY runid DESC
LIMIT 10;
```

`status = 'succeeded'` is the goal. `pg_net` records the HTTP response separately:

```sql
SELECT id, status_code, content
FROM net._http_response
ORDER BY id DESC
LIMIT 10;
```

`status_code = 200` confirms the Vercel route accepted the request.

---

## 7. Operational runbook

### Routine monitoring

- **Daily:** check the daily-summary email. Total PnL > 0 = agent is finding edges. Total PnL ≪ 0 = strategy review (LLM may need prompt tuning).
- **Weekly:** open `/admin/journal`. Skim 5–10 entries. Are reasons coherent? Is the LLM ignoring the strategy rules? Are guardrails firing as expected?
- **Per release:** PostHog → events filtered to `guardrail_triggered` and `agent_run_completed { status = "error" }`. Spike investigation.

### "System is locked" recovery

A drawdown breach (`portfolioValue < $150`) sets `isLocked = true` and pauses all trading. The system never auto-unlocks — manual review is required.

```sql
-- 1. Investigate. Read recent journal + trade log first.
SELECT * FROM "AgentJournal" ORDER BY "createdAt" DESC LIMIT 10;
SELECT * FROM "TradeExecution" ORDER BY "createdAt" DESC LIMIT 10;

-- 2. Decide: reset and resume, or pause indefinitely?
-- To resume:
UPDATE "AgentState" SET "isLocked" = false WHERE id = 'singleton';

-- To pause indefinitely (keep cron on, but agent will refuse to trade):
-- (already locked — leave it.)
```

### Stuck mutex

If a run crashed mid-flight, `isRunning` may stay `true` and every subsequent run returns 409.

```sql
UPDATE "AgentState" SET "isRunning" = false WHERE id = 'singleton';
```

### Rotate the cron secret

```sql
-- Update Vault
UPDATE vault.secrets
SET secret = vault.encrypt_secret('<new-cron-secret>', name)
WHERE name = 'krypto_cron_secret';
```

Then update the same value in Vercel → Environment Variables → `CRON_SECRET`. The next cron tick uses the new value automatically (Vault is read per-invocation).

### Rotate `ADMIN_SESSION_SECRET`

Just update the Vercel env var. All existing admin sessions are invalidated (they'll be redirected to `/admin/login`).

---

## 8. Rollback

| Goal | Action |
|---|---|
| Stop the agent immediately | `SELECT cron.unschedule('krypto-agent-run-hourly');` |
| Stop daily summaries | `SELECT cron.unschedule('krypto-daily-summary');` |
| Roll back code | `vercel rollback` (or revert the offending commit and push to `main`) |
| Pause without unscheduling | `UPDATE "AgentState" SET "isLocked" = true WHERE id = 'singleton';` (cron still fires but agent refuses to trade) |
| Full teardown | Unschedule both jobs → delete Vault secrets → `DROP FUNCTION public.krypto_invoke_endpoint(TEXT);` → optionally `DROP TABLE` the three tables. |

---

## 9. Known limitations of v2 deployment

These are deliberate or accepted carry-overs to v3:

- **Paper trading only.** No real funds move. See ADR `0002-paper-trading-before-live.md`.
- **PnL is anchor-based, not weighted-average.** Realised PnL on a SELL anchors against the price of the **most recent BUY trade** (queried directly from `TradeExecution`, not derived from `agentState.lastTradePrice`, so consecutive SELLs don't cascade into nonsense values). DCA chains still skew it: with multiple BUYs at different prices the anchor is only the last one, not the volume-weighted cost basis. Acceptable for v2 observability; v3 will need real cost-basis accounting.
- **Admin login rate limit is per-Vercel-instance.** A determined attacker hitting many cold-started instances could exceed the nominal 5/15min limit. Acceptable for single-user paper trading; multi-instance hardening would need a shared store (Upstash/Redis).
- **No SLO/alerting on cron failures.** PostHog captures `agent_run_completed { status: "error" }`. Set up a PostHog Insight + email alert on that event for proactive notification.
- **Vercel function timeout is 60s** (Hobby) / configurable (Pro). LLM cold-start + retries + agent loop can occasionally brush this. Watch for `cron.job_run_details.status = 'failed'`.

These do not block v2 deployment. They are tracked for v3 in [`specs/rfcs/0001-v3-live-trading.md`](./rfcs/0001-v3-live-trading.md).
