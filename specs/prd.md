# Project Krypto — Product Spec

> **This document is the single source of truth for the current state of Project Krypto.**
> Historical PRDs are preserved in [`specs/archive/`](./archive/). Architectural decisions are logged in [`specs/decisions/`](./decisions/). Future proposals live in [`specs/rfcs/`](./rfcs/).
> Current deployment, paper, and live readiness gates: [`specs/readiness.md`](./readiness.md).
> Evaluation methodology: [`specs/evaluation.md`](./evaluation.md).

## Status

| Phase | Description | State |
|---|---|---|
| **v1** | Paper-trading scaffolding: agent loop, guardrails, schema, tools, admin dashboard | ✅ Shipped (tag `spec/v1`) |
| **v2** | Hardening: admin auth, balance validation, full PostHog/email wiring, env validation, Drizzle consolidation | ⚠️ Code baseline shipped (tag `spec/v2`) -- NOT production-ready. See §14. |
| **v2.1** | Safety and Correctness: atomic execution, deterministic authorization, non-destructive migrations, cost-basis PnL, owned expiring run leases, dependency remediation | ✅ Implemented -- live Azure target evidence remains before deployment |
| **v2.2** | Evidence-Grade Paper Trading: target preflight/backup/smoke, shadow and paper rollout, 30-day evidence collection | 🚧 Azure foundation/release implementation is unprovisioned; platform/foundations/access, first releases, live smoke, and rollout evidence remain. Production promotion is intentionally unimplemented pending a new evidence-bound review; see [`rfcs/0002-evidence-grade-paper-trading.md`](./rfcs/0002-evidence-grade-paper-trading.md) |
| **v3** | Live Coinbase AgentKit execution on Base L2, sentiment, advanced orders, scaling | 📋 RFC stub only -- see [`rfcs/0001-v3-live-trading.md`](./rfcs/0001-v3-live-trading.md) |

---

## 1. Vision

**Project Krypto** is an autonomous, LLM-driven cryptocurrency trading agent designed to execute swing trades on the ETH/USDC pair.

- **Phase 1 (v2 baseline):** Paper trading on a **$200 USD** notional pool. v2 is a shipped code baseline -- the engineering loop, guardrails, and schema are in place, but known safety and correctness issues (see §14) must be resolved before any production deployment. The goal at this stage is not profit; it is to harden the agentic loop, move risk rules from the system prompt to deterministic code, and lay the groundwork for trustworthy evidence collection.
- **Phase 2 (v2.1 / v2.2):** Resolve blocking issues (RFC 0002), provision disabled/manual, and collect qualifying shadow/paper evidence only after a new evidence-bound production promotion design is reviewed and approved. No executable production promotion workflow is currently shipped. Collect at least 30 days of out-of-sample paper-trading data. Success means capital preservation plus positive risk-adjusted returns versus cash and buy-and-hold baselines. No specific daily profit target is committed (see ADR 0007 and `specs/evaluation.md`).
- **Phase 3 (v3+):** If the live-money boundary in `specs/readiness.md` §11 is satisfied, enable live execution behind an `ExecutionAdapter` interface. Long-term aspiration is positive compounding returns at scale; this outcome is contingent on demonstrated positive expected value, not a guaranteed result.

---

## 2. Architecture

| Layer | Technology |
|---|---|
| Application | Next.js 16 (App Router), TypeScript, Node.js |
| AI orchestration | One structured `HOLD` / `BUY` / `SELL` output through `@langchain/openai`; no ReAct loop and no mutating model tool |
| LLM engine | Dedicated Microsoft Foundry account `ai-krypto-westus3`; OpenAI `gpt-5.6-luna` `2026-07-09` via Azure OpenAI v1 and Microsoft Entra identity |
| Execution venue | Deterministic transactional paper executor using validated Coinbase market data. A future v3 live venue must implement the gated `ExecutionAdapter` contract. |
| Database | Azure Database for PostgreSQL Flexible Server 17 (private VNet target) via **Drizzle ORM** |
| Observability | Separate dev/prod PostHog projects + Container Apps/Log Analytics + Azure Monitor alerts |
| Design system | Root [`DESIGN.md`](../DESIGN.md): shadcn/ui + Tailwind trading-terminal UI, EvilCharts-style Recharts graphs |
| Hosting | Azure Container Apps (`westus3`) |
| Scheduling | Azure Container Apps Jobs: hourly agent run and daily summary; Manual until approved activation |
| Email | Per-environment Azure Communication Services Email with Azure-managed domain |

ADR `0001-drizzle-over-prisma.md` records the Drizzle decision (Prisma was removed in v2).

---

## 3. Database schema

Source of truth: [`src/db/schema.ts`](../src/db/schema.ts). Drizzle is the only
application migration history. The Azure target does not use database-side
scheduling. Legacy hosted-baseline cron operations remain under
[`supabase/operations/`](../supabase/operations/) for historical compatibility
and do not define the Azure release.

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
| `lockReason`, `lockedAt` | `text`, `timestamptz` | persisted cause and time of the first active safety lock |
| `isOperatorPaused` | `boolean` | operator-controlled pause switch; can be toggled from admin without clearing drawdown lock |
| `leaseOwner`, `leaseExpiresAt` | `text`, `timestamptz` | owned expiring run lease |
| `isRunning`, `lastRunAt`, `lastCompletedRunAt` | `boolean`, timestamps | lease compatibility flag and persisted run-health timestamps |
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
| `agentReasoning` | `text` | reasoning on the authorized intent; model-supplied for optional trades and deterministic for mandatory safety exits |
| `createdAt` | `timestamp(3)` | indexed |

### `AgentJournal`

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | UUID |
| `entryText` | `text` | application-written decision, authorization, operator-audit, or delivery narrative; not a model-authored free-form journal |
| `marketConditions` | `jsonb` | run journals store `{ spotPriceUSD, observedAt, rsi, emaShort, emaLong }`; audit and delivery journals use typed event payloads |
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
- **Idempotency:** replay is accepted only when the existing `AgentRun` belongs
  to the current rollout mode; cross-mode reuse fails as a conflict.
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

### Email delivery (Azure Communication Services)

- `sendDailySummary(...)` — fired from the daily-summary cron route.
- `sendGuardrailAlert(...)` remains wired to the legacy `checkDrawdown` helper,
  but the current `executeAgentRun` path does not call that helper. The current
  path persists drawdown locks and emits guardrail telemetry, so drawdown
  alerting currently relies on the PostHog monitoring rule rather than a direct
  email from the run path.

Dynamic model/error/journal content is HTML-escaped. Outside production,
missing ACS configuration returns an explicit console-only skipped result.
Production requires complete ACS configuration; provider failures/timeouts
throw a typed delivery error rather than returning success-shaped `void`.
Target smoke requires an actual `sent` result and persisted delivery audit.

### Container Apps and Log Analytics
- Web/job logs capture typed upstream/internal errors and lease-release
  failures.
- Azure Monitor declares terminal job-failure alerts plus a fail-closed
  missing-hourly-success alert bound to the current schedule activation
  timestamp.

Operational dashboards, alert thresholds, Container Apps Job checks, and the
paper-trading evidence checklist are documented in
[`specs/monitoring.md`](./monitoring.md).

---

## 9. Environment variables

Production configuration is validated at startup (see
[`.env.example`](../.env.example)). The Azure OpenAI base URL and deployment
name retain valid target shapes even in disabled mode; production also requires
the workload identity client ID and complete ACS configuration.

| Variable | Purpose | Required |
|---|---|---|
| `AZURE_OPENAI_BASE_URL` | Dedicated Azure OpenAI v1 base URL ending `/openai/v1` | yes |
| `AZURE_OPENAI_DEPLOYMENT_NAME` | Environment deployment: `krypto-dev-luna` or `krypto-prod-luna` | yes |
| `AZURE_CLIENT_ID` | Runtime/ops user-assigned identity client ID used for Entra authentication | production |
| `DATABASE_URL` | Least-privilege `krypto_app` PostgreSQL URL | yes |
| `DIRECT_URL` | Direct/session database URL for migration and initialization commands | deployment only |
| `POSTHOG_API_KEY` | Environment-specific PostHog ingest key; dev/prod keys must differ | operational gate |
| `POSTHOG_HOST` | PostHog host | optional, default `https://us.i.posthog.com` |
| `CRON_SECRET` | Auth header for scheduler-triggered routes | yes |
| `ROLLOUT_MODE` | `disabled`, `shadow`, or `paper`; releases land `disabled` | production |
| `AZURE_COMMUNICATION_CONNECTION_STRING` | ACS connection string generated in Azure and read from Key Vault; never GitHub | production |
| `AZURE_COMMUNICATION_EMAIL_SENDER` | Azure-managed ACS sender emitted by the environment deployment | production |
| `ALERT_EMAIL_TO` | Recipient for guardrail/daily emails | production |
| `ADMIN_PASSWORD` | Admin dashboard password | yes |
| `ADMIN_SESSION_SECRET` | HMAC key for expiring admin cookies | yes in production |

Rollout mode is validated when a run begins. Luna configuration is validated
at startup, while inference is skipped in disabled mode. Foundry accepts no
application API key: runtime/ops UAMIs receive only Cognitive Services OpenAI
User and use Entra tokens.

---

## 10. Deployment model

- **State:** implemented in source, **not provisioned**. No Azure URL or live
  Azure evidence exists.
- **Subscription/region:** select **Visual Studio Enterprise Subscription** at
  runtime; deploy `rg-krypto-platform`, `rg-krypto-dev`, and
  `rg-krypto-prod` in `westus3`. A subscription owner must register/wait for
  required providers, including `Microsoft.Network`, before bootstrap;
  deployment workflows check only. All mutation roles remain
  resource-group-scoped. Platform/dev/prod-deploy receive only the one-action
  provider-state reader at subscription scope; platform additionally receives
  Cognitive Services Usages Reader. Platform and prod-deploy Locks Contributor
  remain scoped to their respective resource groups. Never publish
  subscription/internal IDs.
- **Foundry:** Bicep-managed `ai-krypto-westus3` with local auth disabled,
  exact OpenAI `gpt-5.6-luna` `2026-07-09` `GlobalStandard` deployments
  `krypto-dev-luna`/`krypto-prod-luna`, capacity 10 each. Catalog/quota
  validation passes both target name/capacity pairs and subtracts only exact
  replaceable target capacity on the same format/model/version/SKU dimension.
- **Hosting:** Next.js runs in Azure Container Apps. Web and ops images are
  digest-pinned in separate dev/prod ACRs.
- **Database:** private Azure PostgreSQL Flexible Server 17. Reviewed Drizzle
  migrations use `DIRECT_URL`; runtime uses least-privilege `DATABASE_URL`.
- **Singleton initialization:** `npm run db:init` inserts the account only when
  absent and never deletes history.
- **Scheduling:** Container Apps Jobs call the same routes at hourly and daily
  UTC schedules. `release.bicep` always lands disabled/manual.
  `rollout.bicep` owns schedule/mode mutation;
  `schedule-monitoring.bicep` independently owns missing-success alert state.
  Monitoring is enabled and validated before Schedule; disable paths verify
  Manual jobs before disabling monitoring.
- **Foundation/access dependency:** deploy environment foundations for dev and
  prod, then bind both runtime/ops identity pairs through the protected
  `azure-platform-access.yml` workflow before full releases.
- **Dev rollout:** disabled/manual evidence → shadow/manual →
  one unique `manual-shadow:` hourly execution → post-run activation-check
  proving the exact safe no-trade `AgentRun` and released lease → monitored
  Schedule with digest/generation-namespaced idempotency → observed scheduled
  success. Activation failure rolls back automatically to disabled/manual.
- **Prod rollout:** force-disable and verified-backup the current release
  before environment mutation; the current-release backup execution ID ends
  `-current` to prevent same-SHA evidence collision. Then deploy the new release
  disabled/manual. Prod deploy and rotation share one concurrency lock. No
  executable production promotion workflow is shipped or approved; any future
  promotion requires a new evidence-bound design and review.
- **Email:** each environment has ACS Email with an Azure-managed domain.
  Azure generates the connection string and writes it directly to Key Vault;
  GitHub never carries it.
- **Evidence:** job starts clone the complete live execution template via
  `--yaml`, always inject `JOB_EXECUTION_ID`, and permit only three validated
  attended-proof overrides (`SCHEDULED_IDEMPOTENCY_KEY`,
  `EXPECTED_SHADOW_IDEMPOTENCY_KEY`,
  `EXPECTED_SHADOW_STARTED_AFTER`). Reports are immutable and validated
  against exact SHA/digest bindings. The helper rejects volumes and volume
  mounts because Azure cannot preserve them through this override path;
  current jobs use none.
- **Runbook:** see [`specs/deployment.md`](./deployment.md).

ADR `0008-azure-native-deployment-architecture.md` supersedes ADR 0003 for the
current target.

---

## 11. Error handling & recovery

| Failure mode | Behaviour |
|---|---|
| Mid-trade crash | Database transaction rolls back; post-commit retries resolve by run idempotency instead of re-executing. |
| Coinbase API unreachable | Abort run with HTTP 502; next cron tick retries naturally. |
| Foundry Luna 429/timeout | At most 2 total attempts, 20 seconds per attempt, with attempt count and latency persisted/emitted. |
| Drawdown breach | Lock + alert. Review immutable history, then use the audited admin unlock with an explicit reason; direct SQL unlock is not an operator path. |
| Crashed run lease | A later invocation can recover an expired lease. The admin endpoint clears only expired/unowned leases and rejects active owners. |
| Scheduled job/HTTP timeout | Container Apps Job fails; Azure Monitor and persisted run state expose the failure. Missing hourly success also alerts after the activation-bound two-hour window. |

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
- `npm run test:coverage` validates the current Jest suite and enforces explicit
  global and critical-module thresholds without relying on a hard-coded test
  count.
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
- **Production activation before readiness gates pass.** Provisioning must land
  disabled/manual; paper and any future live execution require separate
  evidence and approval.

---

## 14. Current baseline and known limitations

The source includes coverage-gated Jest and real-PostgreSQL suites for
migration, transaction, accounting, lease, and orchestration behavior. Their
results are engineering evidence only and do not prove a live Azure target.
Deterministic authorization, mandatory stop-loss, exact accounting,
transactional/idempotent execution, owned expiring leases, structured model
output, disabled/shadow/paper modes, reviewed non-destructive migrations, and
the engineering-only evidence-pipeline foundation are implemented.

Production is still blocked by:

- **Azure provisioning:** the dedicated platform account/model, both
  foundations, and Foundry workload-access bindings have not been deployed.
- **Replacement initialization:** no Azure PostgreSQL target exists. Reviewed
  migration, initialization, and baseline restore-verified backup remain.
- **Production smoke/evidence:** Luna/Entra, Coinbase, ACS Email, separate
  PostHog projects, admin, disabled/shadow/paper modes, Container Apps Jobs,
  alerts, backup, and rollback have not been proven on a live Azure target.
- **Historical and paper evidence:** imported walk-forward reports are
  deliberately classified engineering-only and cannot satisfy release gates.
  Real holdout datasets and the required 30-day production paper window do not
  exist yet.
- **Synthetic scenarios:** fixture outcomes remain engineering tests rather
  than financial or live-target evidence.

Current decision and blockers: `specs/readiness.md` §1.
Paper and live gates: `specs/readiness.md` §10–§11.
Evaluation methodology: `specs/evaluation.md`.
