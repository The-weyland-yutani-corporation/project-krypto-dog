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

With working direct and runtime connections, run the read-only preflight and
retain its machine-readable evidence:

```bash
DIRECT_URL="<verified-direct-connection>" \
DATABASE_URL="<verified-runtime-pooler-connection>" \
npm run deployment:preflight -- \
  --out deployment-evidence/preflight.json
```

The command:

- executes both connectivity probes and the inventory inside read-only
  transactions with bounded statement timeouts;
- requires `DATABASE_URL` and `DIRECT_URL` to report the same database name
  and PostgreSQL system identifier;
- redacts database credentials and query parameters from its JSON;
- inventories complete public/private application-table ownership, row counts,
  every protected `krypto`/Vault relation, migration ledgers, singleton
  balances, open positions, accounting state, leases, Krypto cron jobs,
  queued Krypto `pg_net` requests, canonical fixed-function definitions, Vault
  secret names, table- and
  column-level `PUBLIC`/anonymous/authenticated privileges, Vault
  schema/relation/routine access, protected public views, public
  `SECURITY DEFINER` routines, and the unsafe legacy arbitrary-path function;
- accepts only an empty fresh layout, the complete three-table legacy public
  layout, or the exact four-relation private layout with no extra Krypto
  relation, and verifies the exact ordered Drizzle hash/timestamp prefix rather
  than trusting only a migration count;
- blocks missing canonical cron functions once migration `0002` appears in the
  accepted history and recognizes reviewed pre-`0004`, pre-mode-binding, and
  current migration prefixes;
- exits `2` when a database safety blocker is detected.

Evidence commands refuse to overwrite existing output paths. Do not commit
`deployment-evidence/`; it may contain infrastructure metadata.
Review every `warn` and classify every `block`. Target identity, active cron,
lease, open-position, and quarantine blockers must be resolved before
migration. Legacy layout, unsafe-helper, and privilege blockers that are
explicitly remediated by the committed migrations may proceed only after the
verified backup gate; rerun preflight after migration and require zero blockers
before deployment or smoke. The following queries remain useful for manual
confirmation in the Supabase SQL Editor:

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

### Step 3 -- Open-position check

From the remote inventory results: if `AgentState.currentPositionETH > 0`, the
agent has an open paper ETH position. Record the position size and the most recent
BUY price from `TradeExecution` before any state change, so it can be reconciled
after migration.

### Step 4 -- Cron pause

If `cron.job` shows any Krypto/direct-endpoint job, stop schedules and drain
queued requests now:

```bash
psql "$DIRECT_URL" \
  -v ON_ERROR_STOP=1 \
  -f supabase/operations/disable-krypto-cron.sql
```

Verify:

```sql
SELECT jobid, jobname, active, command FROM cron.job;
SELECT id, url FROM net.http_request_queue
WHERE url ~* '/api/agent/(run|daily-summary)';
-- expect: no Krypto schedule and no matching queued HTTP request
```

Do not re-enable cron until §6 (Enable production cron), after all other steps
are complete and a smoke test has passed.

### Step 5 -- Backup

After cron is paused and before any schema or data change:

1. Create a Supabase dashboard/provider backup when the project plan supports
   it. Wait for completion and record its identifier.
2. Always create a verified Krypto application backup bundle:

```bash
DATABASE_URL="<verified-runtime-connection>" \
DIRECT_URL="<verified-direct-connection>" \
npm run deployment:backup -- \
  --out "deployment-evidence/backup-$(date -u +%Y%m%dT%H%M%SZ)"
```

The command refuses to run while a Krypto cron job is active. It exports one
consistent PostgreSQL snapshot into custom-format archives, never places the
database password in a child-process argument, refuses to overwrite an existing
output, computes SHA-256 checksums, validates every archive with
`pg_restore --list`, and writes a redacted `manifest.json` with source row
counts. Connection URLs containing host, identity, service, passfile, or
password override parameters are rejected, and inherited `PG*` client settings
are scrubbed before child commands run. The bundle covers the private
Krypto/migration schemas and any legacy public application tables. A legacy
public backup also includes a checksummed `legacy-public-types.sql` bootstrap
for the required `public.TradeDirection` enum; built-in restore verification
applies it before the custom-format table archive. Supabase-managed schemas,
Vault secret values, roles, and provider settings are explicitly excluded and
remain covered by the provider backup plus the preflight inventory.
Migration-only databases with no Krypto application table are refused rather
than producing a misleading verified application bundle.
`DATABASE_URL` and `DIRECT_URL` must resolve to the same database name and
PostgreSQL system identifier; both redacted targets and that immutable identity
are persisted in manifest schema `1.3.0`. The command also refuses to start
while a matching `pg_net` request remains queued.

For the strongest evidence, restore into a disposable local PostgreSQL server
whose major version is at least the source version:

```bash
DATABASE_URL="<verified-runtime-connection>" \
DIRECT_URL="<verified-direct-connection>" \
npm run deployment:backup -- \
  --out "deployment-evidence/backup-$(date -u +%Y%m%dT%H%M%SZ)" \
  --restore-test-url "postgresql://postgres@127.0.0.1:5432/postgres"
```

Restore verification is hard-restricted to loopback hosts. It creates a
randomly named database, applies any manifest bootstrap files, restores all
bundle archives with ownership and ACLs disabled, compares every critical
source/restored row count, and then drops the temporary database. A manual
restore must apply `bootstrapFiles` in manifest order before the archives. Do
not continue unless `manifest.json` reports
`verified: true`; for preserve-required data, require
`restoreVerification.matched: true` as well.

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
- The latest privilege migration revokes table-, column-, schema-, sequence-,
  and routine-level access to `krypto` and Vault objects from `PUBLIC`, `anon`,
  and `authenticated`, revokes restricted-role execution from every public
  `SECURITY DEFINER` routine, and drops the unsafe legacy
  `public.krypto_invoke_endpoint(text)` helper.
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

The fixed cron functions installed by `db:migrate` read the cron secret,
Vercel URL, and required rollout mode from Supabase Vault on every invocation.
Set them only after
database inventory and before enabling cron:

Enable `pg_cron` and `pg_net` through the reviewed Supabase extension controls.
The cron operation verifies that both are already installed; it does not create
extensions.

In the Supabase SQL Editor:

```sql
-- Replace with your actual values
SELECT vault.create_secret('<your-cron-secret>',           'krypto_cron_secret');
SELECT vault.create_secret('https://<your-app>.vercel.app', 'krypto_vercel_url');
SELECT vault.create_secret('shadow',                        'krypto_rollout_mode');

-- Verify all three exist
SELECT name FROM vault.decrypted_secrets
WHERE name IN (
  'krypto_cron_secret',
  'krypto_vercel_url',
  'krypto_rollout_mode'
);
-- expect: all three names listed
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

Deploy with `ROLLOUT_MODE=disabled`, keep cron unscheduled, and run the
automated target smoke from a trusted operator machine. The local Foundry and
PostHog variables must match the reviewed target values; Coinbase needs no
credential.

```bash
ROLLOUT_MODE=disabled \
DIRECT_URL="<verified-direct-connection>" \
CRON_SECRET="<target-cron-secret>" \
ADMIN_PASSWORD="<target-admin-password>" \
ANTHROPIC_FOUNDRY_BASE_URL="<reviewed-base-url>" \
ANTHROPIC_FOUNDRY_API_KEY="<reviewed-key>" \
ANTHROPIC_FOUNDRY_DEPLOYMENT="<reviewed-deployment>" \
POSTHOG_API_KEY="<reviewed-key>" \
npm run smoke:target -- \
  --base-url "https://<your-app>.vercel.app" \
  --confirm-host "<your-app>.vercel.app" \
  --out deployment-evidence/disabled-target-smoke.json
```

The command refuses to start unless the operator explicitly sets
`ROLLOUT_MODE=disabled`, the exact hostname is confirmed, the authenticated
target status endpoint independently reports `disabled`, the database is
reconciled and position/lease/cron-free, and remote targets use HTTPS. It then:

- proves missing cron/admin credentials are rejected;
- sends an authenticated no-mutation `requiredMode=paper` probe to the disabled
  cron route, requires HTTP `409`, and proves directly that it created no run,
  trade, or lease mutation; the probe branch never enters orchestration even
  if its requested mode matches;
- writes a unique immutable journal challenge through `DIRECT_URL` and requires
  the deployed runtime to read the same marker through `DATABASE_URL`;
- performs one authenticated cron run and one authenticated admin run, both of
  which carry `x-required-rollout-mode: disabled`; orchestration rechecks that
  requirement before creating a run or acquiring a lease, and both invocations
  must persist as completed `DISABLED` `AgentRun` records;
- proves admin login, protected page/API access, and logout cookie clearing;
- sends the daily summary and requires both Resend status `sent` and a
  persisted delivery audit;
- runs no-trade Foundry, Coinbase spot/candle, and PostHog flush checks from the
  operator environment;
- confirms the trade count did not change and the run lease was released.
- only after every automated check passes, writes an immutable approval marker
  binding the tested target origin and an MD5 fingerprint of the reviewed cron
  secret; no secret value is stored in the report or marker.

Exit `0` means every automated check passed, `2` means the JSON contains one or
more blockers, and `1` means the smoke runner itself failed. The smoke
intentionally creates one database-binding journal marker, one target/cron
approval marker, two disabled run records, and one delivery-audit journal
entry, but cannot create a trade.

After a passing report, manually confirm:

1. The report's `deployment_smoke` ID is visible in PostHog.
2. The daily summary reached the intended mailbox.
3. Vercel logs show the report's two run evidence IDs and no unexpected errors.
4. The admin dashboard shows disabled mode, an idle lease, reconciled
   accounting, and sent alert delivery.

---

## 6. Promote to shadow and enable cron

After Gate 0 in RFC 0002 is signed off:

1. Change Vercel `ROLLOUT_MODE` to `shadow` and create a fresh deployment.
2. Keep cron disabled.
3. Record the deployment ID, commit, strategy/model versions, migration count,
   operator, and timestamp.
4. Invoke one attended run with a unique idempotency key:

```bash
SMOKE_KEY="shadow-promotion-$(date -u +%Y%m%dT%H%M%SZ)"
curl -X POST "https://<your-app>.vercel.app/api/agent/run" \
  -H "x-cron-secret: $CRON_SECRET" \
  -H "x-idempotency-key: $SMOKE_KEY" \
  -H "x-required-rollout-mode: shadow" \
  -i
```

The response must be `200` with `action: "shadow"`. Verify the corresponding
`AgentRun` is terminal with mode/outcome `SHADOW`, its journal is coherent, the
lease is idle, accounting is `RECONCILED`, and the global trade count did not
change. Do not continue on an upstream/configuration error merely because no
trade occurred.

Only after that attended run passes, enable the reviewed fixed-path schedules:

```bash
psql "$DIRECT_URL" \
  -v ON_ERROR_STOP=1 \
  -f supabase/operations/enable-krypto-cron.sql
```

The operation requires exact function configuration and reviewed body
digests. It also requires the decrypted Vault URL and MD5 of the decrypted cron
secret to match the latest passing target-smoke approval marker. Validation,
rejection of any active noncanonical Krypto/direct-endpoint job, replacement
scheduling, and final verification of both job definitions run in one
transaction, so any failure preserves the prior cron state.
Every queued request carries the Vault `krypto_rollout_mode`; requests queued
before a deployment-mode change fail with HTTP `409` instead of running under
the new mode.

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

Observe shadow mode for at least 72 consecutive hours. Require at least 95% of
expected scheduled runs, terminal outcomes for every observed run, zero trade
count delta, no stale lease, reconciled accounting, and two consecutive sent
daily summaries. Review every model proposal/authorization/journal and classify
every provider failure before paper promotion.

---

## 7. Promote to paper

Paper promotion is a separate reviewed change:

1. Disable both cron jobs:

   ```bash
   psql "$DIRECT_URL" \
     -v ON_ERROR_STOP=1 \
     -f supabase/operations/disable-krypto-cron.sql
   ```

2. Run a fresh `deployment:preflight`. It must show no active cron, lease,
   position, quarantine, unsafe function, or exposed role.
3. Create another verified backup bundle so the complete shadow evidence is
   restorable.
4. Record the shadow evidence report and named operator approval.
5. Change Vault `krypto_rollout_mode` to `paper`, change Vercel
   `ROLLOUT_MODE` to `paper`, and deploy the exact approved commit:

   ```sql
   UPDATE vault.secrets
   SET secret = vault.encrypt_secret('paper', name)
   WHERE name = 'krypto_rollout_mode';
   ```

6. Invoke one attended run with a unique idempotency key and
   `x-required-rollout-mode: paper`. A trade or hold is acceptable only if the
   persisted run, authorization, balances, cost basis, fee/slippage fields,
   and reconciliation all agree.
7. Re-enable cron with `enable-krypto-cron.sql` only after that attended run is
   reconciled.
8. Maintain attended monitoring for the first 24 hours. The 30-day evidence
   window starts at the first scheduled paper run and is attributed to the
   exact strategy/model/cost versions.

Any strategy, model deployment, cost model, or safety-parameter change starts a
new evidence-attribution window. Never reset or discard the earlier evidence.

---

## 8. Operational runbook

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

## 9. Rollback

| Goal | Action |
|---|---|
| Stop all schedules immediately | Run `supabase/operations/disable-krypto-cron.sql` with `psql -v ON_ERROR_STOP=1`; it removes every matching job and queued Krypto HTTP request, then verifies both are absent |
| Prevent manual execution | Set Vercel `ROLLOUT_MODE=disabled` and deploy |
| Roll back code | `vercel rollback` (or revert the offending commit and push to `main`) |
| Pause while preserving configuration | Use **Pause Agent** in `/admin`; this writes an audit journal record |
| Retire the deployment | Run the reviewed disable operation, set rollout mode to `disabled`, revoke the fixed cron functions, and retain immutable run/trade history unless a separately reviewed retention procedure authorizes removal. |

Rollback immediately on any trigger listed in RFC 0002: a trade in
disabled/shadow, reconciliation failure, negative/duplicate accounting,
stale/overlapping lease, auth/privilege failure, unsafe/stale market data,
consecutive missed/error runs, prolonged email failure, drawdown lock,
credential concern, or migration drift. Preserve all evidence and record the
incident; never reset the ledger to make a promotion window appear clean.

---

## 10. Remaining release blockers

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
