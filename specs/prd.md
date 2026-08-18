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
| **v2.1** | Safety and Correctness: atomic execution, deterministic authorization, non-destructive migrations, cost-basis PnL, owned expiring run leases, dependency remediation | ✅ Implemented; verified Azure releases exist, while later source changes still require their own cutover evidence |
| **v2.2** | Evidence-Grade Paper Trading: target preflight/backup/smoke, shadow and paper rollout, 30-day evidence collection | 🚧 Azure releases are live: dev is shadow/scheduled and prod disabled/manual. Foundry prompt agents are active; the agent-integrated app-image cutover and 30-day qualifying paper window remain. Production promotion is intentionally unimplemented pending a new evidence-bound review; see [`rfcs/0002-evidence-grade-paper-trading.md`](./rfcs/0002-evidence-grade-paper-trading.md) |
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
| Application | Next.js 16 (App Router), TypeScript, Node.js 22.13.0 |
| AI orchestration | One structured `HOLD` / `BUY` / `SELL` output through `@langchain/openai`; no ReAct loop and no mutating model tool |
| LLM engine | Operational `ghcp-foundry-eastus2` project with version-pinned toolless Foundry prompt agents backed by OpenAI `gpt-5.6-luna` `2026-07-09`; Entra/project-scoped invoker access. Dedicated `ai-krypto-westus3` remains the model-empty future host. |
| Execution venue | Deterministic transactional paper executor using validated Coinbase market data. A future v3 live venue must implement the gated `ExecutionAdapter` contract. |
| Database | Azure Database for PostgreSQL Flexible Server 17 (private VNet target) via **Drizzle ORM** |
| Observability | Mandatory dev/prod PostHog event tags; separate projects before production promotion + Container Apps/Log Analytics + Azure Monitor alerts |
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
| identity | unique run ID, unique idempotency key, and allowlisted request/release/deployment/provider-attempt correlation |
| lifecycle | trigger, trading mode, outcome, start/end time, immutable `deadlineAt = startedAt + 180 seconds`, latency |
| attribution | strategy version, model version, market/account snapshots |
| decision | structured model proposal and deterministic authorization result |
| observability | token counts, model attempt count/latency, typed error fields |

### `ProviderDailyUsage`

Atomic `(usageDate, provider)` counters enforce fail-closed UTC-day request ceilings for Coinbase, version-pinned Foundry, PostHog, and ACS. Exhaustion is a typed no-trade condition; the table stores counts only, never provider payloads, tokens, or cost data.

### `RuntimeContract`

A runtime-readable singleton publishes current schema fingerprint
`0010_safety_incidents_v1` and contract version `2` for readiness, retaining the
bounded-execution contract and adding append-only incident evidence. The runtime
remains denied access to the Drizzle migration ledger.

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

### `SafetyIncidentOutbox`

Append-only incident/lifecycle/outbox events use application-generated
`eventId` and stable `incidentId`, monotonic event sequence, type, severity,
status, deduplication key, named owner/backup roles, linked runbook, and
occurrence/persistence/acknowledgment/escalation/resolution timestamps.
Allowlisted correlation covers request, run, release, deployment, provider
attempt, paper transaction, and incident. `redactedContext` and lifecycle
evidence accept only bounded allowlisted primitives; secrets, credentials, raw
prompts, provider payloads, URLs, and headers are rejected. Runtime has
`SELECT, INSERT` only; database triggers reject update/delete. PAPER execution
inserts its initial post-commit obligation in the same transaction as ledger,
state, and terminal run truth.

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
| Lease/deadline | **Concurrent-run prevention and bounded commit** | run flow + executor + DB constraint | owned 300-second lease, 180-second persisted run deadline, expiry recovery, owner-checked release, no PAPER commit at/after deadline |

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
- **Flow:** create/idempotently recover `AgentRun` with an immutable 180-second deadline → acquire the 300-second owned lease → honor disabled/shadow/paper mode → fetch and validate market data → mark account to market → apply deterministic policy and mandatory exits → optionally request one structured model decision → authorize → transactionally execute/reconcile → persist one terminal result and bounded telemetry → owner-checked lease release. Provider work shares a 125-second aggregate budget (Coinbase 20, version-pinned Foundry 80, ACS 20, PostHog 5); retries and `Retry-After` honor the remaining absolute deadline.
- **Idempotency:** replay is accepted only when the existing `AgentRun` belongs
  to the current rollout mode; cross-mode reuse fails as a conflict.
- **Response:** `AgentRunResult` JSON (`status`, `action`, `reasoning`, `trade`, `portfolioState`, `tokenUsage`, `durationMs`).

### `GET /api/health/live`
- Dependency-free liveness. Returns only process/event-loop responsiveness and makes no database or provider call.

### `GET /api/health/ready`
- Four-second bounded, non-mutating, provider-free readiness using runtime `DATABASE_URL` only.
- Proves release SHA/image digest, bounded config, PostgreSQL 17 and current login/runtime membership/denials/`CONNECTION LIMIT 20`, runtime schema fingerprint, singleton reconciliation, lease sanity, rollout mode, and one free local admission slot.
- Returns `200` or `503` with only `ready`/`not_ready` and opaque reason codes; no protected values or identities are exposed.

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
- Manually invokes the same shared `executeAgentRun({ triggerSource: "admin" })` path used by scheduled Container Apps Jobs.

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

### `GET|POST /api/admin/safety-incidents`

- Protected by the admin session; lifecycle mutation also requires same-origin
  validation and an actor matching the fail-closed responder roster.
- `GET` lists latest immutable incident events with redacted context excluded by
  default.
- `POST` is deliberately fail closed for every human lifecycle change because
  the current admin session is shared. `npm run incident:respond` appends
  signed acknowledge/escalate/resolve events through the protected owner/
  migrator lane. Resolution requires distinct release-owner/trading-safety
  confirmation and complete evidence; a successful retry never resolves.

### `POST /api/admin/safety-incidents/test-fire`

- Strictly non-trading: it never calls run-flow, model/provider decision code,
  policy, executor, or paper state.
- Dry-run is the target-smoke contract. Persisted warning/critical drills require
  an explicit drill flag, complete roster, and disabled/shadow mode. Source
  validation never enables the flag or fires Azure alerts.

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

- `sendDailySummary(...)` — fired from the scheduled daily-summary route.
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
[`.env.example`](../.env.example)). The Foundry project, agent name, and
immutable version retain valid target shapes even in disabled mode; production
also requires the workload identity client ID and complete ACS configuration.

| Variable | Purpose | Required |
|---|---|---|
| `AZURE_FOUNDRY_PROJECT_ENDPOINT` | Environment project endpoint ending `/api/projects/<project>` | yes |
| `AZURE_FOUNDRY_AGENT_NAME` | Environment agent: `krypto-dev-decision` or `krypto-prod-decision` | yes |
| `AZURE_FOUNDRY_AGENT_VERSION` | Exact immutable version attested during deployment | yes |
| `AZURE_OPENAI_BASE_URL` / `AZURE_OPENAI_DEPLOYMENT_NAME` | Optional attended platform-operator direct-model diagnostics | no |
| `AZURE_CLIENT_ID` | Runtime/ops user-assigned identity client ID used for Entra authentication | production |
| `DATABASE_URL` | Least-privilege `krypto_app` PostgreSQL URL; the only DB URL used by web runtime/readiness | yes |
| `DATABASE_POOL_MAX` | Runtime pool size; exactly `1` in production | production |
| `AGENT_RUN_ADMISSION_CAPACITY` | Per-replica run slots; exactly `1` in production | production |
| `RELEASE_SHA` / `IMAGE_DIGEST` | Immutable release provenance checked by readiness | production |
| `EXECUTION_CONTRACT_VERSION` | Must be `bounded-sync-v1` | production |
| `DIRECT_URL` | Admin/operator (`krypto_owner`) database URL for idempotent role bootstrap and privileged inventory/backup -- never migrations | deployment only |
| `MIGRATION_URL` | Dedicated least-privilege `krypto_migrator` database URL for `drizzle-kit migrate` and singleton init ([ADR 0014](./decisions/0014-postgresql-trust-boundary-roles.md)); mounted only on `migrate-init` (read-only on `preflight`) | deployment only |
| `POSTHOG_API_KEY` | PostHog ingest key; temporary dev fallback may share the key only with mandatory environment tagging | operational |
| `POSTHOG_ENVIRONMENT` | `dev` or `prod`; attached to every event and required in production | yes |
| `COINBASE_DAILY_REQUEST_BUDGET` | Fail-closed daily ceiling; release default `1000` | production |
| `FOUNDRY_DAILY_REQUEST_BUDGET` | Fail-closed daily ceiling; release default `200` | production |
| `POSTHOG_DAILY_REQUEST_BUDGET` | Fail-closed daily ceiling; release default `2000` | production |
| `ACS_DAILY_REQUEST_BUDGET` | Fail-closed daily ceiling; release default `100` | production |
| `POSTHOG_HOST` | PostHog host | optional, default `https://us.i.posthog.com` |
| `CRON_SECRET` | Auth header for scheduler-triggered routes | yes |
| `ROLLOUT_MODE` | `disabled`, `shadow`, or `paper`; releases land `disabled` | production |
| `AZURE_COMMUNICATION_CONNECTION_STRING` | ACS connection string generated in Azure and read from Key Vault; never GitHub | production |
| `AZURE_COMMUNICATION_EMAIL_SENDER` | Azure-managed ACS sender emitted by the environment deployment | production |
| `ALERT_EMAIL_TO` | Recipient for guardrail/daily emails | production |
| `APP_ORIGIN` | Exact HTTPS public origin for admin CSRF validation | yes in production |
| `ADMIN_PASSWORD` | Admin dashboard password | yes |
| `ADMIN_SESSION_SECRET` | HMAC key for expiring admin cookies | yes in production |

The provider values are operator safety ceilings, not plan entitlement or cost approval. Release/operator must reconcile them against contracted quotas, rate limits, and costs before rollout and lower them when required. Engineering owns application/runtime correctness; release/operator owns plan/quota/cost reconciliation; operator owns deadline/budget/capacity alert response.

Rollout mode is validated when a run begins. Agent configuration is validated
at startup, while inference is skipped in disabled mode. Foundry accepts no
application API key: runtime/ops UAMIs use the project-scoped custom Project
Krypto Foundry Agent Invoker with Entra tokens.

---

## 10. Deployment model

- **State:** model fallback, foundations, releases, isolated Foundry projects,
  and prompt agents are live. Dev remains shadow/scheduled and production
  disabled/manual on the pre-agent image; the reviewed agent-integrated image
  cutover remains pending the reviewed source merge and gated release.
- **Deployment control:** GitHub Environments, branch restrictions, and
  protected values are configured except for a distinct dev PostHog key.
  Enterprise-hosted Actions are active, `CI_RUNNER_LABEL` is unset, and the
  temporary Azure self-hosted runner infrastructure is retired.
  Platform and production mutations require `@VeVarunSharma` environment
  approval with `prevent_self_review=true` and administrator bypass disabled;
  development intentionally has no reviewer. Branch, exact-SHA, and CI gates
  remain mandatory.
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
  The account and lock are live, but both model deployments are absent after
  Azure error `715-123420`. Support API ticket creation is unavailable without
  an eligible support plan; portal/account support action is required.
- **Hosting:** Next.js runs in Azure Container Apps. Web and ops images are
  digest-pinned in separate dev/prod ACRs. Both environment releases are live;
  the next release replaces direct inference with the version-pinned Foundry
  Agent client.
- **Database:** private Azure PostgreSQL Flexible Server 17. Reviewed Drizzle
  migrations use the dedicated least-privilege `krypto_migrator` role over
  `MIGRATION_URL`; runtime uses least-privilege `DATABASE_URL`; `DIRECT_URL`
  (`krypto_owner`) is narrowed to idempotent role bootstrap and privileged
  inventory/backup ([ADR 0014](./decisions/0014-postgresql-trust-boundary-roles.md);
  source implemented, live per-environment upgrade pending).
- **Singleton initialization:** `npm run db:init` inserts the account only when
  absent and never deletes history.
- **Bounded runtime:** [ADR 0015](./decisions/0015-bounded-synchronous-execution.md) fixes provider aggregate `125 s` < app `180 s` < scheduler HTTP `210 s` < ACA ingress platform bound `240 s` < job replica `270 s` < owned lease `300 s`. The app partition is provider 125, DB policy/execution 20, terminal persistence/lease release 15, cancellation/response 10, slack 10 seconds. Web maximum replicas are 3; each replica has pool/admission 1. The runtime login limit is 20 and connect/statement/lock/idle-in-transaction timeouts are 5/10/2/15 seconds.
- **Scheduling:** Container Apps Jobs call the same routes at hourly and daily
  UTC schedules. `release.bicep` always lands disabled/manual.
  `rollout.bicep` owns schedule/mode mutation;
  `schedule-monitoring.bicep` independently owns missing-success alert state.
  Monitoring is enabled and validated before Schedule; disable paths verify
  Manual jobs before disabling monitoring. Both scheduler jobs use
  `replicaRetryLimit=0`, a 270-second replica timeout, and one 210-second HTTP
  attempt; idempotency remains defense in depth. Manual ops jobs stay outside
  the trading deadline/lease chain and retain their longer job-specific
  timeouts.
- **Foundation/access dependency:** deploy environment foundations for dev and
  prod, then create isolated Foundry projects/agents and bind each runtime/ops
  pair to the project-scoped custom invoker before full releases.
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
| Coinbase API unreachable, delayed, or over daily ceiling | Persist a typed terminal no-trade failure within Coinbase 20-second/provider aggregate budget; alert; a later scheduled tick is a new idempotent run. |
| Foundry 429/timeout/budget | Retry only when `Retry-After` and backoff fit the remaining 80-second Foundry and 180-second app deadline; otherwise persist terminal no-trade and alert. |
| Drawdown breach | Lock + alert. Review immutable history, then use the audited admin unlock with an explicit reason; direct SQL unlock is not an operator path. |
| Crashed run lease | Owner-checked cleanup runs inside the 15-second terminal reserve; otherwise the 300-second lease expires. A later invocation can recover only an expired lease. |
| Deadline, cancellation, admission, or scheduler timeout | Persist one typed terminal no-trade result where possible; release only the owned lease; scheduler has one 210-second HTTP attempt, zero replica retries, and a 270-second replica timeout. |

Production-paper qualification additionally requires the pending behavior in
[ADR 0016](./decisions/0016-durable-safety-incidents-and-independent-alerts.md):
safety state changes atomically append an incident and outbox obligation; every
PAPER execution commits its post-commit obligations with ledger truth; a
separate relay and Azure monitors observe durable evidence and application
absence; and retry success never auto-resolves the original incident. Journal,
analytics, telemetry, or notification failure must preserve the committed
ledger, append correlated incident evidence, and never re-execute or hide the
trade.

That behavior is **not implemented by this documentation change**. The current
post-commit incident/outbox and independent-alert gap remains an OPS-01 blocker
before issue #75 / PR-G2. Numeric targets are governed only by
`production-readiness-prd.v1.md` §8.1, and response is governed by
[`incident-response.md`](./incident-response.md).

---

## 12. Testing

- Unit: deterministic policy, fixed-point accounting, structured decisions,
  model retry/error classification, market data, route status mapping, admin
  controls, migrations, CSRF, and legacy guardrail behavior.
- Real PostgreSQL: `npm run test:migrations` proves fresh install, existing-v2
  upgrade, table/column/Krypto/runtime-role privileges, decimal round trips,
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
  dependency audit, real-PostgreSQL migration/execution tests, migration
  drift detection, and bounded deadline/provider/readiness/capacity fault tests.

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
the engineering-only evidence-pipeline foundation are implemented. The issue #132 source additionally implements ADR 0015, migration `0009`, provider daily usage, a 180-second deadline/PAPER commit fence, bounded database/runtime capacity, and split liveness/readiness. No live Azure evidence for that later contract is claimed; it requires a future exact-release proof indexed in issue #76.

Production is still blocked by:

- **Agent application cutover:** both releases, model deployments, isolated
  Foundry projects, and prompt agents are live, but the deployed app images are
  still the validated pre-agent versions. The replacement release now awaits
  reviewed source and the applicable exact-SHA/CI/environment gates.
- **Operational account hardening:** Agent calls use Entra/project-scoped
  Consumer and Project Krypto stores no key, but the shared fallback account
  still permits legacy local/model key authentication. Disable it with the
  account owner or migrate to the dedicated Entra-only account before any
  production promotion.
- **Production smoke/evidence:** the pre-agent production release passed
  migration, backup restore, provider/email/admin target smoke, and disabled
  state checks. The agent-integrated image must repeat target smoke, including
  the unconditional post-provider no-trade database check.
- **Analytics isolation:** the prod PostHog key is staged; the distinct dev key
  is still missing.
- **Safety incident control plane:** ADR 0016 and the incident runbook are
  documented and source foundations must be classified through exact CI
  evidence. Full runtime transaction/post-commit integration, a separate relay,
  expanded Azure alert catalog, fail-closed responder roster, drills, and
  exact-release issue #76 target proof remain unproven. Earlier Action Group
  dispatches do not satisfy OPS-01.
- **Historical and paper evidence:** imported walk-forward reports are
  deliberately classified engineering-only and cannot satisfy release gates.
  Real holdout datasets and the required 30-day production paper window do not
  exist yet.
- **Synthetic scenarios:** fixture outcomes remain engineering tests rather
  than financial or live-target evidence.

Current decision and blockers: `specs/readiness.md` §1.
Paper and live gates: `specs/readiness.md` §10–§11.
Evaluation methodology: `specs/evaluation.md`.
