# Project Krypto — Product Spec

> **This document is the single source of truth for the current state of Project Krypto.**
> Historical PRDs are preserved in [`specs/archive/`](./archive/). Architectural decisions are logged in [`specs/decisions/`](./decisions/). Future proposals live in [`specs/rfcs/`](./rfcs/).
> Current evidence baseline and release gates: [`specs/readiness.md`](./readiness.md).
> Evaluation methodology: [`specs/evaluation.md`](./evaluation.md).

## Status

| Phase | Description | State |
|---|---|---|
| **v1** | Paper-trading scaffolding: agent loop, guardrails, schema, tools, admin dashboard | ✅ Shipped (tag `spec/v1`) |
| **v2** | Hardening: admin auth, balance validation, full PostHog/email wiring, env validation, Drizzle consolidation | ⚠️ Code baseline shipped (tag `spec/v2`) -- NOT production-ready. See §14. |
| **v2.1** | Safety and Correctness: atomic execution, deterministic authorization, non-destructive migrations, cost-basis PnL, owned expiring run leases, dependency remediation | ✅ Implemented and locally verified -- hosted CI and target-environment evidence remain before deployment |
| **v2.2** | Evidence-Grade Paper Trading: target preflight/backup/smoke, shadow and paper rollout, 30-day evidence collection | 🚧 Active deployment preparation -- clean target inventory passed; migration, backup, disabled smoke, and rollout remain; see [`rfcs/0002-evidence-grade-paper-trading.md`](./rfcs/0002-evidence-grade-paper-trading.md) |
| **v3** | Live Coinbase AgentKit execution on Base L2, sentiment, advanced orders, scaling | 📋 RFC stub only -- see [`rfcs/0001-v3-live-trading.md`](./rfcs/0001-v3-live-trading.md) |

---

## 1. Vision

**Project Krypto** is an autonomous, LLM-driven cryptocurrency trading agent designed to execute swing trades on the ETH/USDC pair.

- **Phase 1 (v2 baseline):** Paper trading on a **$200 USD** notional pool. v2 is a shipped code baseline -- the engineering loop, guardrails, and schema are in place, but known safety and correctness issues (see §14) must be resolved before any production deployment. The goal at this stage is not profit; it is to harden the agentic loop, move risk rules from the system prompt to deterministic code, and lay the groundwork for trustworthy evidence collection.
- **Phase 2 (v2.1 / v2.2):** Resolve blocking issues (RFC 0002), deploy to production in shadow mode, then promote to paper mode. Collect at least 30 days of out-of-sample paper-trading data. Success means capital preservation plus positive risk-adjusted returns versus cash and buy-and-hold baselines. No specific daily profit target is committed (see ADR 0007 and `specs/evaluation.md`).
- **Phase 3 (v3+):** If evidence gates in `specs/readiness.md` §4 are satisfied, enable live execution behind an `ExecutionAdapter` interface. Long-term aspiration is positive compounding returns at scale; this outcome is contingent on demonstrated positive expected value, not a guaranteed result.

---

## 2. Architecture

| Layer | Technology |
|---|---|
| Application | Next.js 16 (App Router), TypeScript, Node.js |
| AI orchestration | One structured `HOLD` / `BUY` / `SELL` output through `@langchain/anthropic`; no ReAct loop and no mutating model tool |
| LLM engine | Azure AI Foundry-hosted Anthropic model via the Azure `/anthropic` API surface |
| Execution venue | Deterministic transactional paper executor using validated Coinbase market data. A future v3 live venue must implement the gated `ExecutionAdapter` contract. |
| Database | Supabase (PostgreSQL) via **Drizzle ORM** |
| Observability | PostHog (events) + Vercel logs + Resend (email alerts) |
| Design system | Root [`DESIGN.md`](../DESIGN.md): shadcn/ui + Tailwind trading-terminal UI, EvilCharts-style Recharts graphs |
| Hosting | Vercel |
| Scheduling | Supabase `pg_cron` + `pg_net` calling the Vercel endpoint hourly |
| Email | Resend |

ADR `0001-drizzle-over-prisma.md` records the Drizzle decision (Prisma was removed in v2).

---

## 3. Database schema

Source of truth: [`src/db/schema.ts`](../src/db/schema.ts). Drizzle is the only
application migration history. Supabase cron enable/disable SQL is kept
separately under [`supabase/operations/`](../supabase/operations/) and does not
create application tables.

### `AgentState` (singleton — `id = "singleton"`)

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | always `"singleton"` |
| `initialCapitalUSD` | `numeric(20,8)` | immutable sizing baseline; default `$200` |
| `currentPositionETHDecimal` | `numeric(28,18)` | authoritative ETH balance |
| `currentPositionUSDCDecimal` | `numeric(20,8)` | authoritative USDC balance |
| `portfolioValueUSDDecimal` | `numeric(20,8)` | marked-to-market account value |
| `weightedCostBasisUSD` | `numeric(20,8)` | weighted open-position cost basis |
| `referencePriceUSD`, `lastBuyPriceUSD` | `numeric(20,8)` | cold-start/entry and DCA anchors |
| `dcaCount` | `integer` | BUY executions since the last full exit |
| `peakPortfolioValueUSD`, `drawdownPct` | `numeric` | deterministic drawdown state |
| `isLocked` | `boolean` | set true when drawdown breach occurs; manual reset only |
| `isOperatorPaused` | `boolean` | operator-controlled pause switch; can be toggled from admin without clearing drawdown lock |
| `leaseOwner`, `leaseExpiresAt` | `text`, `timestamptz` | owned expiring run lease |
| `accountingStatus`, `accountingIssue` | enum, `text` | reconciliation state or quarantine reason |
| `strategyVersion`, `strategySnapshot` | `text`, `jsonb` | exact strategy attribution |
| `updatedAt` | `timestamp(3)` | auto on update |

Legacy floating-point balance/value columns remain temporarily for rollback
compatibility. New orchestration and execution use the numeric columns.

### `AgentRun`

| Column group | Notes |
|---|---|
| identity | unique run ID and unique idempotency key |
| lifecycle | trigger, trading mode, outcome, start/end time, latency |
| attribution | strategy version, model version, market/account snapshots |
| decision | structured model proposal and deterministic authorization result |
| observability | token counts, model attempt count/latency, typed error fields |

### `TradeExecution`

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | UUID |
| `direction` | `TradeDirection` enum | `BUY` or `SELL` |
| `agentRunId` | unique FK | one execution at most per run |
| `asset`, `pair` | `text` | fixed to `ETH` and `ETH/USDC` |
| exact execution fields | `numeric` | requested/gross notional, quantity, observed/modeled price, fee, slippage, balances, cost basis, and realized PnL |
| strategy fields | `text`, `jsonb` | strategy version and signal snapshot |
| `agentReasoning` | `text` | snapshot of LLM output |
| `createdAt` | `timestamp(3)` | indexed |

### `AgentJournal`

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | UUID |
| `entryText` | `text` | LLM-written reasoning |
| `marketConditions` | `jsonb` | full snapshot: `{ ethPrice, rsi, emaShort, emaLong, emaCrossover, timestamp }` |
| `tradeExecutionId` | `text` (FK, nullable) | links journal to the trade it caused, if any |
| `agentRunId` | `text` (FK, nullable) | links journal to the originating run |
| `createdAt` | `timestamp(3)` | indexed |

---

## 4. Trading strategy

| Parameter | Value | Source |
|---|---|---|
| Pair | ETH/USDC | v1 |
| Initial capital | $200 USD | v1 |
| Buy trigger | 3% below reference price or previous BUY | `StrategyConfig.buyTriggerFraction` |
| Optional sell trigger | 3% above weighted open cost basis | `StrategyConfig.takeProfitFraction` |
| Position sizing | minimum $10; maximum 25% of initial capital ($50 by default) | `StrategyConfig` |
| Maximum ETH exposure | 75% of current portfolio value | `StrategyConfig.maximumEthExposureFraction` |
| Stop-loss | mandatory full exit at 15% below weighted cost basis | `StrategyConfig.stopLossFraction` |
| DCA | at most 3 BUY executions in an open-position cycle | `StrategyConfig.maximumDcaEntries` |
| Fees and paper slippage | 30 bps fee + 15 bps modeled slippage; 100 bps ceiling | `StrategyConfig` |
| Cooldown between trades | 2 hours, rechecked in the execution transaction | `StrategyConfig.cooldownMs` |
| Maximum drawdown | 25% from tracked peak; new entries lock | `StrategyConfig.maximumDrawdownPct` |
| Indicators | RSI(14) + EMA(12/26) crossover on 4h candles | `lib/indicators.ts` |

Cold start stores a reference price and returns `HOLD`. Deterministic code
computes eligible/mandatory actions first. The LLM receives read-only context
and returns exactly one structured proposal; it cannot execute a trade.

---

## 5. Engineering guardrails

The pure policy in `src/trading/policy.ts` runs before inference. Every hard
invariant is then re-read and re-authorized inside the same database transaction
that would persist a paper trade.

| # | Guardrail | Implementation | Behaviour |
|---|---|---|---|
| 1 | **Market validity** | provider + policy | finite, fresh, complete paginated candles only |
| 2 | **Accounting state** | policy + executor | only `RECONCILED` accounts may trade |
| 3 | **Mandatory stop-loss** | policy + executor | full exit does not depend on the model |
| 4 | **Pause, lock, cooldown** | policy + executor | optional entries are blocked and transactionally rechecked |
| 5 | **Sizing and balances** | policy + executor | minimum/maximum notional, fee buffer, nonnegative balances |
| 6 | **DCA and trigger rules** | policy + executor | lower-price DCA, cycle count, take-profit eligibility, dust prevention |
| 7 | **Exposure/drawdown** | policy + executor | concentration and projected post-trade drawdown limits |
| 8 | **Idempotency/atomicity** | executor + DB constraints | one run-to-trade mapping; ledger and state commit together |
| Lease | **Concurrent-run prevention** | run flow + executor | owned 90-second lease, expiry recovery, owner-checked execution/release |

---

## 6. Self-determinism mitigations (AI risks)

| Risk | Mitigation |
|---|---|
| Hallucination liquidation (LLM invents a trade for $10k) | Strict structured output plus deterministic eligibility and sizing authorization |
| Multiple model actions | The model has no mutating tool and returns one final proposal |
| Overtrading / fee bleed | Transactionally rechecked 2h cooldown and one execution per run |
| Context-window amnesia | Recent journal entries and versioned account/market snapshots accompany each proposal |
| News-panic selling | v1/v2 operate purely on price action + technicals + own ledger. Sentiment deferred to v3. |
| Ignored safety exit | Mandatory stop-loss bypasses model discretion |
| Phantom positions | Locked-row balance checks plus post-trade ledger reconciliation |

---

## 7. API surface

### `POST /api/agent/run`
- **Auth:** `x-cron-secret` header matched against `CRON_SECRET`.
- **Deployment safety:** `x-required-rollout-mode` is mandatory and the
  effective mode must match before any `AgentRun` or lease is created.
  Target smoke proves this with an authenticated no-mutation mismatched-mode
  probe that cannot enter orchestration plus direct database evidence before
  sending disabled runs.
- **Flow:** create/idempotently recover `AgentRun` → acquire owned lease → honor
  disabled/shadow/paper mode → fetch and validate market data → mark account to
  market → apply deterministic policy and mandatory exits → optionally request
  one structured model decision with a 20-second timeout and one safe retry →
  authorize → transactionally execute/reconcile → journal/complete/flush
  telemetry → owner-checked lease release.
- **Response:** `AgentRunResult` JSON (`status`, `action`, `reasoning`, `trade`, `portfolioState`, `tokenUsage`, `durationMs`).

### `GET /api/agent/status`
- Uses timing-safe `CRON_SECRET` auth and returns the effective rollout mode
  with `Cache-Control: no-store`. An optional deployment-smoke challenge checks
  for an exact immutable journal marker written through `DIRECT_URL`.
- It never acquires a lease, fetches market data, calls the model, or mutates
  the database. Deployment smoke uses it to prove both `disabled` mode and
  runtime/direct database binding before invoking a run.

### `POST /api/agent/daily-summary`
- Uses the same timing-safe `CRON_SECRET` auth and mandatory required-mode
  binding before any query or email. Aggregates exact ledger values, escapes
  journal content, and returns an explicit `sent` or `skipped` delivery result;
  provider failures return HTTP 502.

### `POST /api/auth/login`, `GET|POST /api/auth/logout`
- Timing-safe password check against `ADMIN_PASSWORD`. Sets an HMAC-signed
  cookie containing issued-at and expiry values (HTTP-only, SameSite=Lax, 24h).
  Expired/forged tokens are rejected by `src/proxy.ts`; logout is visible in the
  protected shell and clears the cookie.

### `POST /api/admin/run-agent`
- **Auth:** admin cookie verified by both `src/proxy.ts` and the route handler,
  plus same-origin check.
- Manually invokes the same shared `executeAgentRun({ triggerSource: "admin" })` path used by cron.

### `POST /api/admin/pause`
- **Auth:** admin cookie verified by proxy and handler, plus same-origin check.
- Body `{ paused: boolean }`. Toggles `AgentState.isOperatorPaused` and writes an
  atomic audit journal entry; it does not clear the drawdown `isLocked` safety
  state.

### `POST /api/admin/release-run-lease`
- **Auth:** admin cookie verified by proxy and handler, plus same-origin check.
- Recovers only a legacy unowned or expired lease. An active owned lease returns
  HTTP 409 and is not cleared. Successful recovery writes an atomic audit entry.

### `POST /api/admin/unlock`
- **Auth:** admin cookie verified by proxy and handler, plus same-origin check.
- Requires `{ confirm: "UNLOCK", reason }`, refuses an active owned lease,
  clears the safety lock in a row-locked transaction, and persists the prior
  lock state and operator reason. The agent remains operator-paused until a
  separate audited resume.

### `/admin`, `/admin/trades`, `/admin/journal`
- Server-rendered AgentRun/accounting/lease dashboard with auto-refresh,
  persisted run-schedule, market-freshness, reconciliation, and alert-delivery
  health, plus audited operations controls. The login route is outside the
  protected route-group shell. `src/proxy.ts` protects the remaining admin
  pages and API routes.

---

## 8. Observability

### PostHog events (all wired in v2)

| Event | Trigger |
|---|---|
| `agent_run_started` | After an invocation record is created |
| `agent_run_completed` | Every completed, skipped, locked, conflicting, or failed run |
| `guardrail_triggered` | Policy block, lease conflict, or lease-release anomaly |
| `trade_executed` | After the paper transaction commits |
| `llm_token_usage` | Token counts plus bounded attempt count and model latency |

### Email alerts (Resend)

- `sendGuardrailAlert(...)` — fired from `checkDrawdown` when system locks.
- `sendDailySummary(...)` — fired from the daily-summary cron route.

Dynamic model/error/journal content is HTML-escaped. Missing configuration
returns an explicit skipped result and logs locally; Resend failures throw a
typed delivery error rather than returning success-shaped `void`.

### Vercel logs
- Default function logs for typed upstream/internal errors and lease-release failures.

Operational dashboards, alert thresholds, Supabase cron checks, and the paper-trading evidence checklist are documented in [`specs/monitoring.md`](./monitoring.md).

---

## 9. Environment variables

Production configuration is mode-aware (see
[`.env.example`](../.env.example)). Database, route-auth, and admin values are
required for deployment; Foundry values are required before `shadow` or `paper`
can request a model decision.

| Variable | Purpose | Required |
|---|---|---|
| `ANTHROPIC_FOUNDRY_BASE_URL` | Foundry Anthropic base URL ending in `/anthropic` | shadow/paper |
| `ANTHROPIC_FOUNDRY_API_KEY` | Foundry project key | shadow/paper |
| `ANTHROPIC_FOUNDRY_DEPLOYMENT` | Foundry Claude deployment name | shadow/paper |
| `ANTHROPIC_FOUNDRY_API_VERSION` | Foundry Anthropic API version | optional |
| `DATABASE_URL` | Supabase Postgres URL (use `?pgbouncer=true` for runtime) | yes |
| `DIRECT_URL` | Direct/session database URL for migration and initialization commands | deployment only |
| `POSTHOG_API_KEY` | PostHog ingest key | operational gate; local no-op if absent |
| `POSTHOG_HOST` | PostHog host | optional, default `https://us.i.posthog.com` |
| `CRON_SECRET` | Auth header for cron-triggered routes | yes |
| `RESEND_API_KEY` | Resend API key for emails | optional (no-op if absent) |
| `ALERT_EMAIL_TO` | Recipient for guardrail/daily emails | optional |
| `ALERT_EMAIL_FROM` | Verified sender domain | optional |
| `ADMIN_PASSWORD` | Admin dashboard password | yes |
| `ADMIN_SESSION_SECRET` | HMAC key for expiring admin cookies | yes in production |

Rollout mode is validated when a run begins. Foundry configuration is validated
only when inference is actually required, so `disabled` mode remains a safe
deployable default even before model credentials are installed.

---

## 10. Deployment model

- **Hosting:** Vercel (linked project, `develop/v2` → `main` branch deploys to prod).
- **Database:** Supabase Postgres. Reviewed Drizzle migrations are applied with
  `DIRECT_URL` via `npm run db:migrate`; the transaction-pooler
  `DATABASE_URL` is runtime-only.
- **Singleton initialization:** `npm run db:init` inserts the account only when
  absent and never deletes history.
- **Cron target:** Supabase `pg_cron` + `pg_net`, with two fixed,
  privilege-restricted functions:
  - hourly → `POST https://<vercel-host>/api/agent/run`
  - daily 00:00 UTC → `POST https://<vercel-host>/api/agent/daily-summary`
  - both require the Vault-selected `shadow` or `paper` mode in
    `x-required-rollout-mode`
- **Current cron status:** the unsafe v2 arbitrary-path migration has been
  removed. The Drizzle history installs fixed restricted functions, while
  `supabase/operations/enable-krypto-cron.sql` performs the separate post-smoke
  transaction and verifies exact function configuration, reviewed body
  digests, the latest smoke-approved Vault URL/secret fingerprint, and both
  final job definitions before commit. Activation rejects unexpected matching
  jobs and queued endpoint requests; disablement removes and verifies both.
- **Smoke test + rollback:** see [`specs/deployment.md`](./deployment.md).

ADR `0003-pg-cron-over-vercel-cron.md` records why we chose Supabase `pg_cron` over Vercel Cron.

---

## 11. Error handling & recovery

| Failure mode | Behaviour |
|---|---|
| Mid-trade crash | Database transaction rolls back; post-commit retries resolve by run idempotency instead of re-executing. |
| Coinbase API unreachable | Abort run with HTTP 502; next cron tick retries naturally. |
| Azure-hosted LLM 429/timeout | At most 2 total attempts, 20 seconds per attempt, with attempt count and latency persisted/emitted. |
| Drawdown breach | Lock + alert. Review immutable history, then use the audited admin unlock with an explicit reason; direct SQL unlock is not an operator path. |
| Crashed run lease | A later invocation can recover an expired lease. The admin endpoint clears only expired/unowned leases and rejects active owners. |
| Cron HTTP timeout | Vercel kills > 60s; `pg_net` records the response status — see Supabase `net._http_response`. |

---

## 12. Testing

- Unit: deterministic policy, fixed-point accounting, structured decisions,
  model retry/error classification, market data, route status mapping, admin
  controls, migrations, CSRF, and legacy guardrail behavior.
- Real PostgreSQL: `npm run test:migrations` proves fresh install, existing-v2
  upgrade, table/column/Krypto/Vault privileges, decimal round trips,
  quarantine,
  transactional rollback, parallel idempotency, lease ownership/recovery,
  disabled/shadow/paper orchestration, required-mode fail-closed behavior,
  cold start, mandatory stop-loss, deployment preflight, function/privilege
  tamper detection, and verified private plus legacy-enum backup restoration.
- Local paper smoke: [`specs/local-testing.md`](./local-testing.md) covers local Postgres setup, no-LLM route checks, optional live local paper runs, admin checks, daily summary, reset/reseed, and current profitability-testing limits.
- Deterministic evaluation: `npm run backtest -- --scenario scenarios/dip-recovery.json` replays fixture prices through a no-LLM rules policy with fees, slippage, cooldown, DCA, drawdown, weighted-average cost basis, and cash / buy-and-hold benchmarks.
- Current local suite: 30 Jest suites / 279 tests. `npm run test:coverage`
  enforces explicit global and critical-module thresholds.
- CI runs lint, script/test typecheck, production build, critical coverage,
  aggregate backtests and engineering-only evidence artifacts, production
  dependency audit, real-PostgreSQL migration/execution tests, and migration
  drift detection.

---

## 13. Non-goals and out of scope

### Deferred to v3

The following are explicitly deferred to v3 (see [`rfcs/0001-v3-live-trading.md`](./rfcs/0001-v3-live-trading.md)):

- Live Coinbase AgentKit execution on Base L2.
- Sentiment / news feeds.
- Advanced order types (trailing stops, limit orders).
- Capital scaling beyond $200.
- WebSocket-triggered runs (volatility-based).
- Multi-user admin auth, SSO.

### Non-goals

The following are not goals of this project at any phase:

- **Guaranteed profit or specific daily return targets.** Success is defined by evidence-based metrics relative to cash and buy-and-hold baselines (see `specs/evaluation.md` and ADR 0007). A $100/day figure was previously cited in this document; it has been removed (ADR 0007).
- **Production deployment before v2.1 is complete.** The v2 code baseline has blocking issues (§14) that must be resolved first.

---

## 14. Current baseline and known limitations

The local v2.1/v2.2 release candidate now has 279 passing Jest tests plus real-PostgreSQL
migration, transaction, accounting, lease, and orchestration evidence.
Deterministic authorization, mandatory stop-loss, exact accounting,
transactional/idempotent execution, owned expiring leases, structured model
output, disabled/shadow/paper modes, additive NULL-safe cron migration, and the
engineering-only evidence-pipeline foundation are implemented.

Production is still blocked by:

- **Replacement initialization:** the clean PostgreSQL 17 target passed
  read-only inventory with no application tables, migrations, cron, queued
  requests, or retained position. The reviewed migration, initialization,
  baseline backup, and Vault steps remain.
- **Production smoke/evidence:** Foundry, Coinbase, email, analytics, admin,
  disabled/shadow/paper, cron, backup, and rollback have not been proven on the
  target Vercel/Supabase deployment.
- **Historical and paper evidence:** imported walk-forward reports are
  deliberately classified engineering-only and cannot satisfy release gates.
  Real holdout datasets and the required 30-day production paper window do not
  exist yet.
- **Synthetic scenario shortfall:** 3 of 8 fixture scenarios beat cash and 0 of
  8 beat both cash and buy-and-hold; these remain engineering tests rather than
  financial evidence.

Full issue list: `specs/readiness.md` §3.
Release gates (v2.1, v2.2, v3): `specs/readiness.md` §4.
Evaluation methodology: `specs/evaluation.md`.
