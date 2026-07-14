# Deployment Runbook

> **STOP: Do NOT deploy until the target-environment gates are satisfied.**
> The historical v2 baseline had blocking safety and correctness issues. v2.1
> resolves the atomicity and deterministic-policy defects locally; current
> deployment risks are:
>
> - The destructive v2 Supabase seed has been removed locally, but the remote
>   database and migration history remain unknown. Never recover or apply that
>   deleted file. See ADR 0006.
> - **The production DB credentials in Vercel are stale** (connection attempts failed
>   with "tenant/user ... not found"). Credential repair and a full pre-migration
>   safety check (§0a) are required before any schema work.
>
> See `specs/readiness.md` §3 for the full issue list, `specs/readiness.md` §1
> (Production infrastructure inventory) for the known production state, and
> `specs/readiness.md` §4 for release gates.

End-to-end recipe for deploying Project Krypto (paper-trading v2) to **Vercel + Supabase**. Assumes you have local development working per the README.

> **Status target after this runbook:** the agent runs hourly against a Supabase Postgres DB, observable via PostHog + the `/admin` dashboard + the daily-summary email. **No real money moves** -- all execution is paper-modelled until v3.

---

## 0. Pre-flight checklist

Infrastructure status as of 2026-07-14: a Vercel project and a Supabase project
both exist. The steps below confirm readiness; they do not start from scratch.

- [ ] **Vercel** project: already exists. Confirm local linkage with `vercel link`.
  Do not re-create. Verify the production deployment status in the Vercel dashboard.
- [ ] **Supabase** project: already exists. DB credentials in Vercel are stale
  (connection failed -- see §0a). Obtain fresh credentials from the Supabase
  dashboard before proceeding.
  - Pooler URL (port `6543`, append `?pgbouncer=true&connection_limit=1`) -> `DATABASE_URL`
  - Direct URL (port `5432`) -> `DIRECT_URL` (used by drizzle-kit migrations)
- [ ] **Azure AI Foundry**: env vars present in Vercel. Confirm they still resolve
  to a working model deployment.
- [ ] **PostHog**: env var present in Vercel. No action needed unless rotating.
- [ ] **Resend**: `RESEND_API_KEY`, `ALERT_EMAIL_TO`, `ALERT_EMAIL_FROM` are
  ABSENT from Vercel production. The live app cannot send email alerts. Add these
  before re-enabling the agent (see §4 -- Configure Vercel environment variables).
- [ ] **Admin dashboard secrets**: `ADMIN_PASSWORD` and `ADMIN_SESSION_SECRET` are
  ABSENT from Vercel production. The admin dashboard login will fail. Add these
  before enabling the agent (see §4).
- [ ] **Startup validation**: the Next.js instrumentation hook validates runtime
  configuration on process startup. Production deployment must fail fast if
  required database, Foundry, cron, analytics, password, or dedicated admin
  session values are absent or malformed.
- [ ] **CRON_SECRET**: present in Vercel. Confirm the value stored in Supabase Vault
  as `krypto_cron_secret` matches (Vault state not yet verified -- see §0a).

---

## 0a. Pre-migration safety check (required for existing deployment)

A Vercel project and a Supabase project are known to exist. The internal state of
the production DB is unknown. **Complete every item in this section before
touching §1 (migrations) or §4 (env vars).** Do not skip or reorder these steps.

### Step 1 -- Credential repair

The production `DATABASE_URL` and `DIRECT_URL` stored in Vercel do not connect to
the live Supabase project (both pooler connections fail with "tenant/user ... not
found"). The credentials must be repaired first.

1. Open the Supabase dashboard for the live project.
2. Navigate to Settings -> Database -> Connection string.
3. Copy the Pooler URL (port 6543, `?pgbouncer=true&connection_limit=1`) and the
   Direct URL (port 5432). These are the new `DATABASE_URL` and `DIRECT_URL`.
4. Test read access from a local client (e.g., `psql` or Drizzle Studio) using
   the Direct URL before updating Vercel.

Do not update Vercel env vars until the credentials are confirmed working.

### Step 2 -- Remote inventory

With a working connection, inspect the live DB state. Run the following queries
in the Supabase SQL Editor or via `psql`:

```sql
-- Which v2 or v2.1 application tables exist?
SELECT schemaname, tablename
FROM pg_tables
WHERE schemaname IN ('public', 'krypto')
  AND tablename IN ('AgentState', 'TradeExecution', 'AgentJournal')
ORDER BY schemaname, tablename;

-- Before migration, use public; after migration, use krypto.
SELECT id, "currentPositionETH", "currentPositionUSDC", "portfolioValueUSD",
       "isLocked", "isOperatorPaused", "isRunning", "lastRunAt"
FROM "public"."AgentState";

-- If krypto.AgentState already exists, inspect authoritative numeric and lease state.
SELECT id, "currentPositionETHDecimal", "currentPositionUSDCDecimal",
       "portfolioValueUSDDecimal", "weightedCostBasisUSD",
       "accountingStatus", "leaseOwner", "leaseExpiresAt"
FROM "krypto"."AgentState";

-- How many trades and journal entries exist?
SELECT COUNT(*) FROM "public"."TradeExecution";
SELECT COUNT(*) FROM "public"."AgentJournal";

-- Which migrations have been applied?
-- (If using Drizzle runner:)
SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at;
-- (If using Supabase CLI runner:)
SELECT * FROM supabase_migrations.schema_migrations ORDER BY version;

-- Are cron jobs registered?
SELECT jobid, jobname, schedule, active FROM cron.job;
```

Document the results before proceeding. If `AgentState` has no rows, the DB may
be uninitialised (fresh). If it has rows, treat as preserve-required and do NOT
run the seed migration.

### Step 3 -- Backup

Before any schema or data change, take a point-in-time backup:

- **Supabase dashboard backup:** Project -> Backups -> Create backup. Wait for
  completion and download the backup file.
- **Alternative:** `pg_dump -h <direct-host> -U postgres -d postgres > krypto_prod_backup_$(date +%Y%m%d).sql`

Verify the backup is readable (e.g., `pg_restore --list` on the file) before
continuing.

### Step 4 -- Open-position check

From the remote inventory results: if `AgentState.currentPositionETH > 0`, the
agent has an open paper ETH position. Record the position size and the most recent
BUY price from `TradeExecution` before any state change, so it can be reconciled
after migration.

### Step 5 -- Cron pause

If `cron.job` shows active jobs (`active = true`), pause them now:

```sql
SELECT cron.unschedule('krypto-agent-run-hourly');
SELECT cron.unschedule('krypto-daily-summary');
```

Verify:

```sql
SELECT jobid, jobname, active FROM cron.job;
-- expect: both rows show active = false (or no rows if never registered)
```

Do not re-enable cron until §6 (Enable production cron), after all other steps
are complete and a smoke test has passed.

---

## 1. Apply database migrations

The repository now has one committed production migration history under
`drizzle/`.

- Migration commands require `DIRECT_URL`; the transaction-pooler
  `DATABASE_URL` is runtime-only.
- The baseline migration adopts either an empty database or the existing v2
  schema without deleting rows.
- Supabase application-schema migrations have been removed and Supabase
  automatic seed loading is disabled.
- The initializer creates the singleton account with
  `ON CONFLICT DO NOTHING`; it does not load fabricated history.
- `db:push` and `supabase db push` are not production deployment paths.

Before targeting production, complete the inventory, backup, open-position,
and cron-pause gates in section 0a. Valid production credentials are not
currently available, so these commands remain blocked for the observed
deployment.

Validate the migration against temporary fresh and v2 databases:

```bash
npm run test:migrations
```

After the production gates are recorded:

```bash
DIRECT_URL="<verified-direct-connection>" npm run db:migrate
DIRECT_URL="<verified-direct-connection>" npm run db:init
```

Do not generate or apply a schema diff directly in production. Future schema
changes must be reviewed committed Drizzle migrations. The current history
moves application tables and the enum into the private `krypto` schema while
preserving rows and foreign keys.

---

## 2. Store cron secrets in Supabase Vault

The fixed cron functions installed by `db:migrate` read the cron secret and
Vercel URL from Supabase Vault on every invocation. Set them only after
database inventory and before enabling cron:

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

## 3. Verify the fixed cron functions

The unsafe v2 arbitrary-path migration has been removed and must not be
recovered from Git history. `db:migrate` installs only fixed, parameterless
functions and does not schedule jobs.

```sql
SELECT to_regprocedure('krypto.invoke_agent_run()');
SELECT to_regprocedure('krypto.invoke_daily_summary()');

SELECT has_function_privilege(
  'anon', 'krypto.invoke_agent_run()', 'EXECUTE'
);
SELECT has_function_privilege(
  'authenticated', 'krypto.invoke_daily_summary()', 'EXECUTE'
);
-- Both privilege checks must be false.
```

---

## 4. Configure Vercel environment variables

In the Vercel project → **Settings → Environment Variables**, add (Production scope):

| Variable | Value |
|---|---|
| `ANTHROPIC_FOUNDRY_BASE_URL` | `https://<resource>.services.ai.azure.com/anthropic` |
| `ANTHROPIC_FOUNDRY_API_KEY` | Azure AI Foundry project key |
| `ANTHROPIC_FOUNDRY_DEPLOYMENT` | Foundry Claude deployment name |
| `ANTHROPIC_FOUNDRY_API_VERSION` | optional; defaults to `2024-10-21` |
| `DATABASE_URL` | Supabase pooler URL with `?pgbouncer=true&connection_limit=1` |
| `DIRECT_URL` | Supabase direct/session connection for reviewed migrations only |
| `POSTHOG_API_KEY` | from PostHog |
| `POSTHOG_HOST` | `https://us.i.posthog.com` (or eu) |
| `CRON_SECRET` | same value stored in Vault as `krypto_cron_secret` |
| `RESEND_API_KEY` | from Resend |
| `ALERT_EMAIL_TO` | recipient address |
| `ALERT_EMAIL_FROM` | from your verified Resend domain |
| `ADMIN_PASSWORD` | strong random password |
| `ADMIN_SESSION_SECRET` | dedicated HMAC key (different from `CRON_SECRET`) |

Trigger a deploy: `git push origin main` (Vercel auto-deploys) or `vercel --prod`.

Before shadow promotion, run the protected **Foundry smoke** GitHub workflow in
the `production-smoke` environment. It calls `npm run smoke:llm` with only
Foundry secrets and has no database or trade access.

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

- `200 {"status":"skipped", "action":"disabled", ...}` — required first-deploy
  result while `ROLLOUT_MODE=disabled`.
- `200 {"status":"executed", ...}` — agent decided to trade.
- `200 {"status":"skipped", "action":"hold", ...}` — agent decided to hold.
- `200 {"status":"skipped", "guardrailTriggered":"Cooldown active..."}` — within 2h of last trade. Expected on second invocation.
- `200 {"status":"locked", "guardrailTriggered":"System locked..."}` — drawdown breach. Investigate immediately.

Failure modes:

| Response | Likely cause |
|---|---|
| `401 Unauthorized` | `x-cron-secret` header doesn't match `CRON_SECRET` env var. |
| `409 Agent is already running` | An active owned lease exists. Inspect owner/expiry; do not clear an unexpired owner. |
| `500 AgentState singleton not found` | Singleton initialization was skipped. Run `DIRECT_URL="<verified-direct-connection>" npm run db:init`; it uses `ON CONFLICT DO NOTHING` and does not replace existing state. |
| `500` configuration error | Check `ROLLOUT_MODE`; if inference was needed, verify Foundry configuration with `npm run smoke:llm`. |
| `502 Coinbase API error` | Transient. Re-try. If persistent, check Coinbase status. |

### 5b. Verify side effects

After a successful run:

1. **Database:** new row in `AgentJournal`, optionally a new row in `TradeExecution`, `AgentState.lastRunAt` updated.
2. **PostHog:** events `agent_run_started` and `agent_run_completed` visible in the live activity view.
3. **Admin dashboard:** open `https://<your-app>.vercel.app/admin/login`, sign in with `ADMIN_PASSWORD`, confirm dashboard loads, pause/resume works, and the "Run Agent Now" path returns a structured result.

### 5c. Manual `POST /api/agent/daily-summary`

```bash
curl -X POST "$VERCEL_URL/api/agent/daily-summary" \
  -H "x-cron-secret: $CRON_SECRET" -i
```

Expected: `200 {"generated":true,"delivery":{"status":"sent",...},
"alertAuditRecorded":true,...}` and an email arrives at `ALERT_EMAIL_TO`.
The admin **Alert Delivery** health card should change to `Sent`. A skipped or
failed delivery is persisted and must be resolved before cron enablement.

---

## 6. Enable production cron

After disabled and shadow smoke checks pass, run the reviewed, fixed-path
operation from the repository root:

```bash
psql "$DIRECT_URL" \
  -v ON_ERROR_STOP=1 \
  -f supabase/operations/enable-krypto-cron.sql
```

Do not recreate or call `public.krypto_invoke_endpoint(text)`. Cron enablement
remains separate from schema migration so rollback can unschedule jobs without
reverting schema.

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

- **Daily:** check the persisted daily-summary delivery result and email. Treat
  PnL as one observation, not proof of an edge; investigate material losses
  without tuning against a single window.
- **Weekly:** open `/admin/journal`. Skim 5–10 entries. Are reasons coherent? Is the LLM ignoring the strategy rules? Are guardrails firing as expected?
- **Per release:** PostHog → events filtered to `guardrail_triggered` and `agent_run_completed { status = "error" }`. Spike investigation.

See [`monitoring.md`](./monitoring.md) for the PostHog dashboard, alert thresholds, Supabase cron checks, and v3 evidence checklist.

### "System is locked" recovery

A drawdown breach sets `isLocked = true` and blocks trading. The system never
auto-unlocks; manual review and an audited reason are required.

```sql
-- Investigate. Read recent journal + trade log first.
SELECT * FROM "krypto"."AgentJournal" ORDER BY "createdAt" DESC LIMIT 10;
SELECT * FROM "krypto"."TradeExecution" ORDER BY "createdAt" DESC LIMIT 10;
```

After review, use **Clear Safety Lock** in `/admin`. The route requires a
10-500 character reason, refuses an active owned run lease, clears the lock
inside a row-locked transaction, and writes the prior lock state plus reason to
`AgentJournal`. The route leaves `isOperatorPaused = true`; resume separately
only after confirming the unlocked state. Do not bypass this audit path with a
direct SQL update.

### Stuck or expired run lease

Inspect ownership before recovery:

```sql
SELECT "leaseOwner", "leaseExpiresAt", "isRunning", "lastRunAt"
FROM "krypto"."AgentState"
WHERE id = 'singleton';
```

Do not clear an unexpired owned lease. A later invocation automatically recovers
an expired lease. The admin release endpoint also refuses active owners and
clears only expired/unowned state. If emergency SQL is required, keep the same
condition:

```sql
UPDATE "krypto"."AgentState"
SET "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "isRunning" = false
WHERE id = 'singleton'
  AND ("leaseOwner" IS NULL OR "leaseExpiresAt" < NOW())
RETURNING id;
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
| Pause without unscheduling | `UPDATE "krypto"."AgentState" SET "isLocked" = true WHERE id = 'singleton';` (cron still fires but agent refuses to trade) |
| Retire the deployment | Unschedule both jobs, set rollout mode to `disabled`, revoke the fixed cron functions, and retain immutable run/trade history unless a separately reviewed retention procedure authorizes removal. |

---

## 9. Remaining release blockers

> Do not proceed to production paper mode until the remaining v2.1 gates in
> `specs/readiness.md` §4 are satisfied.

See `specs/readiness.md` §3 for the full blocking issue list. Summary:

- **Unknown remote migration/data state.** The destructive v2 Supabase seed was
  removed locally, but production inventory and backup are still blocked by
  stale credentials. (ADR 0006)
- **Target smoke evidence.** Foundry, Coinbase, email, analytics, admin,
  disabled/shadow/paper transitions, cron, backup, and rollback are unproven on
  the target deployment.
- **Financial evidence.** Engineering backtests share production
  policy/accounting and remain unfavorable versus both benchmarks in aggregate.
  Historical walk-forward and the required production paper window do not yet
  exist.

Additional limitations that are accepted carry-overs (do not block v2.1 deployment,
addressed in v3):

- **Paper trading only.** No real funds move. See ADR `0002-paper-trading-before-live.md`.
- **Admin login rate limit is per-Vercel-instance.** Acceptable for single-user paper trading; multi-instance hardening would need a shared store (Upstash/Redis).
- **No SLO/alerting on cron failures.** PostHog captures `agent_run_completed { status: "error" }`. Set up a PostHog Insight + email alert on that event for proactive notification.
- **Vercel function timeout is 60s** (Hobby) / configurable (Pro). LLM cold-start + retries + agent loop can occasionally brush this. Watch for `cron.job_run_details.status = 'failed'`.
