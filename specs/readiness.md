# Release Readiness

This document records the current evidence baseline and defines the gates that must
be satisfied before each release milestone. It does not contain secrets or
credentials.

For metric definitions see `specs/evaluation.md`.
For the proposed architecture changes see `specs/rfcs/0002-evidence-grade-paper-trading.md`.

---

## 1. Current evidence baseline

### Test suite

- `npm run test:coverage` passes with global and critical-module thresholds.
- Critical safety modules are collected explicitly for deployment preflight,
  runtime configuration, admin-route authentication, decision, market data,
  accounting, policy, and shared execution code.
- All 8 synthetic fixture scenarios pass: the deterministic execution layer
  produces the correct trade sequences and equity curves given known inputs.
- The fixture runner is aligned to production policy, fixed-point accounting,
  and the shared paper-execution calculator. It defaults to 30 bps fees and
  15 bps adverse slippage and emits report schema `1.0.0`.

### Synthetic scenario results vs. benchmarks

| Result | Count |
|---|---|
| Beat cash baseline | 3 of 8 |
| Beat buy-and-hold baseline | 2 of 8 |
| Beat both cash and buy-and-hold | 0 of 8 |

These are engineering fixture results, not financial evidence. Passing all 8
scenarios does not imply positive expected value in live or paper markets.
See `specs/evaluation.md` §3 for the distinction.

### Out-of-sample paper trading evidence

None verified. A hosted deployment exists, but its database configuration is
stale and the remote database/run history could not be inspected. No production
paper record currently qualifies as financial evidence.

### Production infrastructure inventory

Directly observed on 2026-07-14. Remote Supabase internals (schema, table
contents, migration history, pg_cron state) have NOT been verified. No secrets,
project IDs, or internal URLs are recorded here.

**Vercel**

- Project exists; production deployment status: Ready (app is live).
- GitHub records no deployments; no GitHub Actions deployment workflow has fired.
- Production environment variables -- present: `DATABASE_URL`, `DIRECT_URL`,
  Azure AI Foundry vars (`AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`,
  `AZURE_OPENAI_DEPLOYMENT_NAME`), `CDP_API_KEY_NAME`, `CDP_API_KEY_PRIVATE_KEY`,
  `POSTHOG_API_KEY`, `CRON_SECRET`.
- Production environment variables -- absent: `RESEND_API_KEY`, `ALERT_EMAIL_TO`,
  `ALERT_EMAIL_FROM`, `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`.
- Consequence: the latest application build would not have working email alerts
  or the required authenticated admin configuration. The exact revision and
  behavior of the currently hosted deployment have not been verified.
- The current v2.1 source prefers `ANTHROPIC_FOUNDRY_*`, accepts the observed
  `AZURE_OPENAI_*` names only as a compatibility path, and no longer requires
  CDP variables for paper mode. These source changes have not been deployed.

**Supabase**

- Project exists.
- DB credential status: read-only connection attempts using both the Vercel
  production `DATABASE_URL` (pooler port 6543) and `DIRECT_URL` (pooler port
  5432) failed with "tenant/user ... not found". The DB configuration in Vercel
  appears stale or invalid; the credentials do not match the live project.
- Schema, tables, row counts, migration history, pg_cron jobs, and Vault secrets:
  NOT verified (connection attempts failed before inspection was possible).

**Classification: preserve-required, unknown DB data.**

A repository-local `deployment:preflight` run on 2026-07-14 produced exit `2`:
the currently loaded URLs both target an unavailable localhost database, so
this shell does not contain usable deployment credentials. The redacted report
is retained outside the repository. No target inventory or backup claim is
made from that failed probe.

A production Supabase project exists and its internal state is unknown. All of
the following steps are REQUIRED before any migration, seed, schema change, or
env-var update targeting the production DB:

- [ ] **Credential repair:** Obtain valid connection credentials for the live
      Supabase project (re-generate pooler URL and password from the Supabase
      dashboard). Confirm read access from a trusted client before proceeding.
- [ ] **Remote inventory:** Inspect the live DB -- check which tables exist, row
      counts in `AgentState`, `TradeExecution`, and `AgentJournal`, and migration
      history (`__drizzle_migrations` and/or Supabase migration ledger).
      Document what is present before touching anything.
- [ ] **Backup:** Take a point-in-time backup (Supabase dashboard backup or
      provider equivalent) before any schema or data change. Also run
      `deployment:backup`; require a checksummed/readable manifest and, for
      preserve-required data, a successful loopback restore/count comparison.
- [ ] **Open-position check:** Confirm whether `AgentState.currentPositionETH`
      is non-zero. A non-zero value means the agent has an open paper ETH
      position whose cost basis and PnL history must be preserved.
- [ ] **Cron pause:** Check whether pg_cron jobs are registered and active
      (`SELECT jobid, jobname, active FROM cron.job`). If active, pause them
      before any migration or env-var change to prevent the agent from firing
      against an inconsistent state.

See `specs/deployment.md` §0a for the runbook steps that implement these checks.

---

## 2. Current v2.1 implementation progress

Verified locally; no production database mutation has occurred:

- Coinbase pagination, complete UTC four-hour candle construction, freshness,
  gap, timeout, retry, and flat-RSI behavior are covered by focused tests.
- Drizzle is the only application migration history. Fresh install,
  existing-v2 adoption, row preservation, and idempotent singleton
  initialization pass against temporary real PostgreSQL clusters.
- Application tables and the enum move into the private `krypto` schema.
  `PUBLIC`/anonymous/authenticated table, column, schema, sequence, Krypto
  routine, and Vault schema/relation/routine privileges are denied in real
  migration tests and inventoried across every protected relation by preflight.
  Protected public views and every executable public `SECURITY DEFINER`
  routine are also blocked. The migration removes the unsafe legacy
  arbitrary-path helper. Cron scheduling is a separate
  transactional reviewed operation that rejects canonical-function drift and
  verifies the latest passing smoke approval against decrypted Vault URL/secret
  values, rejects unexpected jobs or queued endpoint requests, and verifies
  both final job definitions before commit. Every cron request carries its
  Vault-selected shadow/paper mode, so delayed requests fail across promotion
  boundaries.
- Unused AgentKit/OpenAI packages and CDP requirements are removed. A same-major
  PostCSS override removes Next.js's vulnerable nested copy; `npm audit
  --omit=dev` reports zero production vulnerabilities.
- Foundry uses explicit Anthropic endpoint configuration with a no-trade smoke
  command and temporary legacy environment compatibility.
- The mutating ReAct trade tool has been removed. One structured model proposal
  is evaluated by deterministic policy, while mandatory stop-loss exits bypass
  model discretion. Mandatory exits still require fresh validated market data,
  a `RECONCILED` account, and `paper` mode; shadow records but does not execute
  them.
- New paper execution is fixed-point/numeric, locked-row transactional,
  idempotent by `AgentRun`, weighted-cost-basis aware, and reconciled to the
  immutable trade ledger.
- Backtests now reuse production policy and the pure execution calculation used
  by the transactional executor; post-action equity drives same-step drawdown.
  Sharpe, Sortino, Calmar, turnover, fee efficiency, win rate, profit factor,
  benchmark alpha, modeled slippage, optional LLM-cost-adjusted PnL, and version
  metadata are reported with unavailable ratios represented as `null`.
- Run orchestration now persists `AgentRun` outcomes, uses owned expiring
  leases, supports disabled/shadow/paper modes, bounds model calls to two
  attempts with 20-second attempt timeouts, records attempt count/latency, and
  flushes PostHog per request.
- Real PostgreSQL tests prove disabled mode, idempotent replay, cold start,
  mandatory stop-loss without a model, shadow non-execution, active-lease
  conflict, expired-lease recovery, configuration errors, market failures,
  transaction rollback, concurrency, and owner mismatch rejection.
- Operator pause/resume, expired-lease recovery, and drawdown-lock override now
  write atomic audit journal entries. Unlock requires an explicit reason and is
  refused while an owned run lease is active.
- Next.js startup instrumentation validates required runtime configuration, and
  mutating admin handlers re-verify the signed session in addition to proxy
  enforcement.
- The admin dashboard derives missed-run, lease, market-freshness,
  reconciliation, and alert-delivery health from persisted state. Daily-summary
  sent/skipped/failed outcomes are persisted and route/database failures are
  explicit.
- CI now enforces lint, app and script/test typechecking, production build,
  critical-module coverage, all engineering backtests, production dependency
  audit, real-PostgreSQL migration/executor/orchestration tests, and migration
  drift. A protected manual no-trade Foundry smoke workflow is included.
- Harness integrity now enforces canonical agentic policy, instruction/reference
  integrity, deterministic SDLC safety fixtures, report-only entropy contracts,
  and byte-stable GH-AW source/lock generation. A mock-first per-worktree app
  harness proves isolated database/app startup and operator-console safety states
  without production credentials or provider calls.
- Current local validation: lint passes with one pre-existing PostCSS config
  warning; the coverage-gated Jest suite, script/test typecheck, production
  build, and real-PostgreSQL suite pass;
  deliberate cron-function tampering and `PUBLIC` table exposure are rejected;
  migration generation reports no drift; and the production dependency audit
  is clean. The 8-scenario aggregate reports 8 engineering assertion passes,
  3/8 beating cash, 2/8 beating buy-and-hold, and 0/8 beating both.

Production remains blocked by target database credential repair,
inventory/backup, target-environment smoke checks, controlled disabled/shadow/
paper rollout, and evidence collection.

The current v2.2 preparation includes:

- read-only `deployment:preflight`, so repaired credentials can immediately
  prove runtime/direct cluster identity and produce redacted schema,
  canonical-function, pending-HTTP-request, privilege, and blocker evidence
  without mutating the target;
- `deployment:backup`, which creates non-overwriting, checksummed custom-format
  application archives, binds runtime/direct URLs to one database and
  PostgreSQL system identifier, and can prove them by restoring into a
  disposable loopback database and comparing critical row counts. Legacy
  public backups include the required enum bootstrap and are restore-tested
  before migration. Migration-only databases cannot produce a verified
  application bundle, and queued Krypto HTTP work blocks backup.
- `smoke:target`, which binds the deployed runtime to `DIRECT_URL`, enforces
  disabled mode inside each run before lease acquisition, proves a mismatched
  authenticated no-mutation mode probe creates no run/trade/lease mutation
  even if its requested mode matches, rejects queued Krypto HTTP work, and
  proves
  target authentication, two persisted disabled runs, unchanged trades, lease
  release, admin login/logout, sent email audit, and no-trade
  Foundry/Coinbase/PostHog access. A successful report persists the target
  origin/cron-secret-fingerprint approval required by cron activation.

---

## 3. Known issues in the v2 code baseline

The following issues were identified during the plan review at commit cda2bca.
They are tracked in GitHub issues and draft PR #43. Issues marked [BLOCKS PROD]
must be resolved in v2.1 before any production deployment.

| # | Category | Issue | Blocks |
|---|---|---|---|
| 1 | Security | Resolved locally: unused live-execution packages are removed, reachable direct packages are upgraded, and a same-major PostCSS override removes the vulnerable nested dependency. `npm audit --omit=dev` reports zero vulnerabilities. | [CI/PROD SMOKE PENDING] |
| 2 | Data integrity | The destructive v2 Supabase seed has been removed. The local Drizzle path preserves fresh and existing-v2 data, but the unknown production schema/history must be inventoried and backed up before migration. (ADR 0006) | [BLOCKS PROD: INVENTORY] |
| 3 | Risk enforcement | Resolved locally: pure policy and in-transaction reauthorization enforce cold start, stop-loss, DCA, thresholds, cooldown, sizing, balances, dust, exposure, pause, lock, and drawdown. | [PROD SMOKE PENDING] |
| 4 | Atomicity | Resolved locally: immutable trade insert, account transition, reconciliation fields, and `AgentRun` execution outcome commit in one locked transaction. Injected post-insert failure rolls back. | [PROD MIGRATION PENDING] |
| 5 | Idempotency | Resolved locally: unique idempotency key and unique `TradeExecution.agentRunId`; parallel same-run execution produces one trade and one idempotent result. | [PROD SMOKE PENDING] |
| 6 | PnL accuracy | Resolved locally: fixed-point weighted cost basis supports multiple buys, partial sells, realized PnL, and full-exit reset. | [PROD MIGRATION PENDING] |
| 7 | Money representation | Resolved for new execution: numeric columns are authoritative; legacy float columns remain only during rollback compatibility. | [CONTRACT MIGRATION PENDING] |
| 8 | Lease recovery | Resolved locally: owner/expiry lease acquisition, active-owner conflict, automatic expired recovery, owner-checked execution/release, and active-lease admin refusal are tested. | [PROD SMOKE PENDING] |
| 9 | Retry visibility | Resolved locally: model calls have a 20-second attempt timeout, at most two attempts, typed auth/rate/timeout/model failures, and persisted/emitted attempt count plus latency. | [FOUNDRY SMOKE PENDING] |
| 10 | Market data | Resolved locally: paginated retrieval, UTC alignment, complete-bucket filtering, freshness/gap validation, bounded retries, and timeouts are implemented and tested. Production smoke remains pending. | [BLOCKS PROD: SMOKE] |
| 11 | Observability | Mostly resolved locally: per-request PostHog flush, typed/escaped daily-summary delivery, persisted delivery status, expiring admin sessions/logout, correct EMA rendering, AgentRun-backed health, atomic operator-action audits, and explicit safety-lock override are implemented and tested. The structured run path persists drawdown locks and emits guardrail telemetry but does not invoke the legacy guardrail-email helper; the PostHog drawdown alert remains required. | [BLOCKS PROD: TARGET SMOKE] |

---

## 4. Release gates

### v2.1 -- Safety and Correctness

Status: Locally complete. Hosted CI and target-environment evidence remain
required before production deployment.

All criteria must be met before any production deployment:

- [x] Seed migration replaced with idempotent `INSERT ... ON CONFLICT DO NOTHING`
      script (issue #2, ADR 0006).
- [x] No unresolved critical advisory and no reachable high-severity direct
      advisory without documented ownership, reachability analysis, and an
      expiry condition (issue #1).
- [x] One reviewed Drizzle history supports fresh and existing-v2 databases,
      uses `DIRECT_URL`, preserves rows, and moves application data into the
      private `krypto` schema with restricted fixed cron functions.
- [x] All risk rules (stop-loss, DCA count, trade size bounds, trigger thresholds)
      enforced in `authorizeTradeIntent` (deterministic TypeScript, not prompt)
      (issue #3, ADR 0005).
- [x] Trade execution wrapped in a single DB transaction (issue #4).
- [x] Execution path idempotent: idempotency key per run, retry-safe (issue #5).
- [x] PnL uses weighted-average cost basis, not latest-BUY anchor (issue #6).
- [x] New execution uses Drizzle numeric/fixed-point values; legacy float columns
      are compatibility-only until the post-deployment contract migration
      (issue #7).
- [x] Run concurrency uses an owned expiring lease with owner-checked release
      and expired-lease recovery (issue #8).
- [x] LLM retry count and latency captured in `AgentRun` and PostHog
      `llm_token_usage` events
      (issue #9).
- [x] Coinbase market-data error handling returns a structured error with HTTP
      status code and prevents candle misalignment (issue #10).
- [x] PostHog event schema, daily-summary email path, and admin dashboard are
      consistent and covered by tests; drawdown alerting uses the required
      PostHog monitoring rule (issue #11).
- [x] The coverage-gated Jest suite and the real-PostgreSQL migration,
      privilege, transaction, accounting, lease, and orchestration suites pass.

### v2.2 -- Evidence-Grade Paper Trading

Status: Draft deployment/evidence phase. The local preflight, backup, target
smoke, and evaluation tooling is implemented; target inventory, controlled
shadow/paper rollout, and the evidence window remain incomplete. See RFC 0002
Gates 2 and 3.

- [ ] All v2.1 gates satisfied.
- [ ] Schema reconciliation: confirm the production Supabase DB schema matches
      `src/db/schema.ts` before first deploy (ADR 0006).
- [ ] Shadow-mode run, authorization, rejection, alert, and journal evidence is
      reviewed and contains no unexplained route or accounting errors.
- [ ] Guardrails (drawdown, cooldown, operator pause) fire as expected under real
      cron traffic in shadow mode.
- [ ] Operator approval to promote to `paper` mode.
- [ ] Paper mode running for >= 30 calendar days.
- [ ] At least one evaluation window completed and results documented (per
      `specs/evaluation.md` §4 and §6).
- [ ] Results beat the cash baseline for the evaluation window.
- [ ] Manual journal review: coherent LLM reasoning observed; no prompt gaming
      detected.

### v3 -- Live Trading

Status: RFC stub only. See `specs/rfcs/0001-v3-live-trading.md`.

All criteria must be met before the v3 RFC can advance from Draft to Accepted:

- [ ] All v2.2 gates satisfied.
- [ ] At least two non-overlapping 30-day evaluation windows show positive net PnL,
      positive Sharpe ratio, and final equity beating both cash and buy-and-hold
      baselines (per `specs/evaluation.md` §5).
- [ ] `ExecutionAdapter` interface defined, reviewed, and in use (RFC 0001 revised).
- [ ] `authorizeTradeIntent` deterministic authorization layer (ADR 0005) in
      production use for >= 30 days without false-accept or false-reject incidents.
- [ ] MPC wallet provisioning and recovery plan reviewed and approved.
- [ ] Live trading risk register: maximum-loss scenarios identified and mitigations
      agreed.
- [ ] All preconditions in `specs/rfcs/0001-v3-live-trading.md` satisfied.
