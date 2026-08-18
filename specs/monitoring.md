# Monitoring and evaluation runbook

This runbook defines the minimum observability required before any recurring
paper-trading schedule is accepted. It does not authorize live trading.

> **Azure state (2026-08-15): releases and monitoring live.** Dev is
> shadow/scheduled with activation-bound missing-success monitoring; production
> is disabled/manual. Both Action Groups returned successful test dispatches.

Release thresholds and authorization are in
[`readiness.md`](./readiness.md); deployment order is in
[`deployment.md`](./deployment.md).

## Goals

- Detect failed or missing Container Apps Job executions.
- Prove schedule monitoring is active before unattended work starts.
- Confirm deterministic guardrails, locks, and reconciliation behavior.
- Track model latency/tokens and provider failures.
- Prove daily-summary delivery through ACS Email.
- Keep paper results distinct from evidence of positive expected value.

## Required signals

| Signal | Primary source | Purpose |
|---|---|---|
| Agent run outcome | Persisted `AgentRun.outcome` | Authoritative completed/skipped/locked/error state |
| Trigger source | Persisted run plus PostHog event | Distinguish scheduled, manual, and admin runs |
| Guardrail event | `guardrail_triggered` + persisted account/journal state | Explain cooldown, drawdown, lease, and policy blocks |
| Paper trade | Immutable DB ledger; PostHog secondary | Confirm exact authorized paper execution |
| Model usage | `AgentRun` + `llm_token_usage` | Attempts, latency, and token anomalies |
| Execution envelope | `AgentRun.deadlineAt`, terminal outcome/error code, job duration | Prove deadline/cancellation produces a terminal no-trade result inside the owned lease |
| Provider daily usage | `ProviderDailyUsage` + typed budget outcome | Prove fail-closed Coinbase/Foundry/PostHog/ACS ceiling enforcement |
| Readiness | ACA probe status + opaque reason codes | Detect unsafe release/config/runtime-role/schema/lease/mode/admission state without provider calls |
| Daily delivery | `AgentJournal` event `daily-summary-delivery` | Persisted ACS `sent`/`skipped`/`failed` health |
| Job execution | Container Apps Job history + Log Analytics | Prove scheduler process started and completed |
| Idempotency proof | Job execution env + exact `AgentRun.idempotencyKey` + activation-check report | Bind attended shadow and scheduled observation to the current proof generation |
| App/job logs | Per-environment Log Analytics workspace | Diagnose route, model, market, database, email, and process failures |
| Immutable deployment evidence | Evidence blob report | Bind checks to environment, release SHA, image digest, operation, and execution ID |

## Bounded execution and provider ceilings

The monitored PAPER execution ordering is:

```text
providers 125s (Coinbase 20 + version-pinned Foundry 80 + ACS 20 + PostHog 5)
< app deadline 180s
< scheduler HTTP 210s
< ACA ingress platform bound 240s
< job replica 270s
< owned lease 300s
```

The app partitions its window into providers 125 seconds, database policy/execution 20, terminal persistence/owned-lease release 15, cancellation/response 10, and slack 10. Both scheduler jobs have `replicaRetryLimit=0`; idempotency is defense in depth, not a retry policy. Manual ops jobs remain outside this chain and retain their longer operation-specific timeouts.

The runtime records no-trade deadline, cancellation, admission, and daily-provider-budget failures as typed terminal outcomes. Operators correlate the persisted run, `deadlineAt`, lease release/expiry, Container Apps execution duration, and provider daily count. No alert or dashboard should display database URLs, release secrets, lease owners, role details, or provider payloads.

Operator safety ceilings per UTC day are Coinbase `1,000`, version-pinned Foundry `200`, PostHog `2,000`, and ACS `100`. They must be reconciled against contracted provider quotas, rate-limit policy, and costs before rollout; they are not evidence of plan entitlement. Engineering owns the application/runtime implementation, release/operator owns plan/quota/cost reconciliation, and operator owns deadline/budget/capacity alert response.

Liveness is dependency-free. Readiness is four-second bounded, non-mutating, provider-free, and uses runtime `DATABASE_URL` only. Alert and platform-probe handling may use only its `ready`/`not_ready` status and opaque reason codes. A readiness reason must be diagnosed through protected target evidence rather than by expanding the public response with identities, versions, digests, or state values.

## PostHog isolation

Every event must carry `deployment_environment=dev|prod`; production startup
fails if `POSTHOG_ENVIRONMENT` is absent. A shared ingestion key is temporarily
accepted for deployment validation because the environment property makes every
query filterable, but it does not satisfy final project isolation. Create separate
**dev** and **prod** PostHog projects before any production promotion design.

Each dashboard/query must filter `deployment_environment`. The eventual
per-project "Project Krypto Ops" dashboards should include:

1. **Run status**
   - event `agent_run_completed`;
   - breakdown `status`;
   - alert on any `status=error`.
2. **Guardrail/lock activity**
   - event `guardrail_triggered`;
   - breakdown `reason` or `guardrailName`;
   - immediate review for drawdown lock.
3. **Paper trades**
   - event `trade_executed`;
   - trends for direction, amount, fees, and PnL.
4. **Model usage**
   - event `llm_token_usage`;
   - attempts, latency, input/output/total tokens.
5. **Trigger mix**
   - events `agent_run_started` and `agent_run_completed`;
   - scheduled production runs should be explainable and admin runs audited.
6. **Deployment smoke**
   - event `deployment_smoke`;
   - retain the smoke ID with the target-smoke artifact.

PostHog is operational telemetry, not the accounting source of truth.

## Admin health

The `/admin` dashboard derives:

- **Run schedule:** healthy within two hours of `lastCompletedRunAt`, or
  explicitly disabled.
- **Lease:** idle, active, stale, or recoverable.
- **Market data:** fresh within the configured window.
- **Accounting:** reconciled, uninitialized, or quarantined.
- **Alert delivery:** latest persisted ACS delivery state.

Pause/resume, expired-lease recovery, and safety-lock override create atomic
audit journal entries. Unlock requires a reason, rejects an active owned
lease, and leaves the agent paused until a separate resume.

## Azure Monitor resources

Each `environment.bicep` foundation declares:

- Log Analytics workspace `log-krypto-<env>`;
- Action Group `ag-krypto-<env>`; and
- severity-1 scheduled-query alert
  `alert-caj-<env>-agent-run-or-caj-<env>-daily-summary-failed`.

The failure alert:

- evaluates every 5 minutes over a 15-minute window;
- checks both scheduler job names;
- matches terminal failure/backoff/deadline/nonzero-exit signals; and
- sends the common alert schema to the operator Action Group.

Initial query validation is skipped because a new workspace has no Container
Apps log table until its first log arrives. This alert is still enabled from
foundation deployment. Its live behavior must be tested before accepting
schedule activation.

### Fail-closed missing-hourly-success alert

`schedule-monitoring.bicep`, with
`infra/params/schedule-monitoring.{dev,prod}.bicepparam`, owns
`alert-caj-<env>-agent-run-missing-success`, separate from the foundation.
This prevents routine environment or rollout-state deployment from resetting
schedule monitoring.

| Hourly trigger | Alert state | Activation boundary |
|---|---|---|
| `Manual` | Not required; if deployed, disabled | `0` |
| `Schedule` | Enabled before job trigger mutation | Exact workflow-captured UTC Unix timestamp |

When enabling:

1. the workflow captures the current UTC activation epoch;
2. it what-ifs and deploys `schedule-monitoring.bicep` with the rule enabled
   and that exact epoch;
3. the module validates the live Log Analytics table/columns because
   `skipQueryValidation=false`;
4. the workflow verifies the enabled output and exact boundary before
   `rollout.bicep` may set jobs to `Schedule`; and
5. after two hours measured from that activation timestamp, zero successful
   hourly completions in the current window raises severity 1.

The query ignores successes before the current activation boundary. A missing,
zero, invalid, or materially future boundary fails closed rather than granting
an unbounded grace period.

Disable ordering is the reverse dependency. Dev manual staging/rollback, prod
forced-disable, and secret rotation first apply `rollout.bicep` and verify both
jobs are `Manual` with no schedule. Only then do they deploy and verify
`schedule-monitoring.bicep` disabled with boundary `0`.

The current query contract expects legacy
`ContainerAppSystemLogs_CL` columns (`JobName_s`, `Reason_s`, `Type_s`,
`Log_s`) and a successful completion with `Reason_s == "Completed"`.
If Azure emits the resource-specific schema instead, update and review both
queries before activation; do not bypass validation.

## Deployment-time monitoring gates

### Dev

For attended proof, `run-ops-job.sh` still starts from the complete live
template via `--yaml`. It always injects `JOB_EXECUTION_ID` and may additionally
inject only validated `SCHEDULED_IDEMPOTENCY_KEY`,
`EXPECTED_SHADOW_IDEMPOTENCY_KEY`, and
`EXPECTED_SHADOW_STARTED_AFTER`. Because Azure `JobExecutionTemplate` cannot
preserve volumes through this override path, the helper rejects any template
volume or container/init-container volume mount. Current Project Krypto jobs
use none.

The full dev workflow must:

1. stage `shadow` while jobs remain Manual;
2. capture a UTC boundary and unique `manual-shadow:` key;
3. succeed exactly once with a Manual hourly execution carrying that key;
4. run activation-check afterward and require its immutable report to prove
   the exact new SHADOW `AgentRun` started after the boundary, reached a safe
   terminal outcome, created zero `TradeExecution`, and released the lease;
5. enable and validate monitoring with the current activation timestamp;
6. deploy Schedule only after that validation, with the hourly idempotency
   namespace bound to the exact image digest and activation generation;
7. observe an unmarked successful hourly execution in the first scheduled
   window; and
8. verify final live state.

The scheduled key also includes the UTC hour. The digest/generation namespace
prevents an older same-hour execution from satisfying current observation.
Run-flow rejects reuse of an existing idempotency key across rollout modes.

Any failure from shadow staging onward triggers rollback to
disabled/manual, verifies both jobs are Manual, and then disables the
missing-success alert.

### Prod

Initial prod provisioning ends disabled/manual. No schedule-monitoring window
starts. No executable production promotion/activation workflow is shipped or
approved. The `production-promotion` identity/environment is retained only for
the forced-disable portions of prod deploy and secret rotation. Any future
promotion requires a new evidence-bound design and review.

Prod deploy and rotation share the `azure-production-mutation` concurrency
lock so forced-disable and secret mutations cannot overlap.

## Operator checks after release deployment

These commands inspect the live jobs:

```bash
az containerapp job execution list \
  --name caj-<env>-agent-run \
  --resource-group rg-krypto-<env> \
  --output table

az containerapp job execution list \
  --name caj-<env>-daily-summary \
  --resource-group rg-krypto-<env> \
  --output table
```

Healthy scheduled state requires:

- both job definitions are `Schedule` only after approved activation;
- hourly cron is `0 * * * *` UTC and daily is `5 0 * * *` UTC;
- hourly `SCHEDULED_IDEMPOTENCY_NAMESPACE` matches the exact image digest and
  current activation generation;
- recent execution status is `Succeeded`;
- a successful hourly execution exists inside the current activation window;
- the missing-success alert is enabled with that same window timestamp;
- failure alert queries are functioning; and
- persisted `AgentRun`/delivery evidence agrees with platform history.

Container Apps success alone is insufficient if the route outcome, database
state, or provider checks fail.

## ACS Email monitoring

Production runtime configuration requires:

```text
AZURE_COMMUNICATION_CONNECTION_STRING
AZURE_COMMUNICATION_EMAIL_SENDER
ALERT_EMAIL_TO
```

The connection string is generated in Azure and stored directly in Key Vault;
it never passes through GitHub. Target smoke invokes the running app's daily
summary and requires both a provider `sent` result and persisted sent audit.
A local console-only skip is not target evidence.

Review delivery health when the latest event is failed/skipped or older than
36 hours. Inspect ACS operation state, sender/domain state, recipient, Key
Vault reference resolution, and app logs. Do not report healthy delivery from
a successful HTTP response without the persisted delivery audit.

## Alert thresholds

| Alert | Threshold | Required response |
|---|---|---|
| Scheduler process failure | Any terminal failure signal | Disable/keep Manual as appropriate; inspect job revision and Log Analytics |
| Missing hourly success | No success for >2h inside the active schedule window | Treat as failed schedule; inspect job history, route outcome, secrets, and revision |
| Agent error | Any completed run with error | Inspect app logs and persisted run/error fields |
| Drawdown lock | Any drawdown lock/event | Keep trading blocked; review ledger/journal; never auto-unlock |
| Stale lease | Expired owner or repeated conflict after expiry | Use only audited expired-lease recovery |
| Reconciliation failure | `accountingStatus != RECONCILED` | Keep trading blocked until immutable history reconciles |
| ACS delivery | Failed/skipped or no success for 36h | Repair provider/config and prove a new sent audit |
| Model retry/latency | Attempts >1 or material latency increase | Inspect Luna deployment health, quota, `Retry-After`, remaining deadline, and timeout frequency |
| Execution deadline/cancellation | Any deadline or cancellation terminal outcome | Keep no-trade; confirm one terminal run and owned-lease release/expiry; operator responds |
| Provider daily ceiling | Any fail-closed ceiling exhaustion | Keep no-trade; operator reconciles usage with contracted quota/cost before reactivation |
| Admission/readiness | Capacity rejection or readiness `503` | Stop activation; inspect local admission, pool, runtime role/schema, lease, and rollout-mode reason code |
| Token spike | Material increase over recent baseline | Inspect prompt/context growth |

## Daily and weekly review

Daily:

- hourly scheduled success exists for the current digest/activation generation
  when Schedule is active;
- no scheduler or application error is unexplained;
- daily ACS summary is sent and audited;
- no unexpected drawdown/reconciliation/lease state exists;
- each paper trade has a matching run and journal;
- no-trade decisions remain coherent.

Current baseline: 0 production days (v2 not yet deployed). See `specs/readiness.md`
§1 for the current evidence summary.

## Factory observability (MonitorOps)

The signals above cover the **trading app**. The **agentic factory** that builds
it has its own observability, documented in
[`../docs/agentic-workflows-map.md`](../docs/agentic-workflows-map.md)
(Operational reporting). In short, the `daily-repo-status` and
`agentic-governance` workflows run a deterministic collector
(`scripts/agentic/collect-factory-health.cjs`) over explicit closed UTC windows
and summarize a normalized JSON snapshot:

- every active GH-AW workflow is represented, including zero-run workflows;
- unavailable cost/token/safe-output/correction telemetry is `null`, never `0`;
- a material-state hash drives noop suppression, with the published hash read
  from prior report issues (`<!-- factory-state-hash: ... -->`) rather than cache;
- configured thresholds (repeated failure, WIP over cap, eval/harness failure,
  per-run AI-credit cap, telemetry missing across two published periods, and
  source/lock drift) produce explicit, evidence-backed breaches.

Factory reports are read-only, single recurring issues; they do not replace the
trading-app signals in this runbook.

### Report-only entropy (harness-entropy)

The weekly `harness-entropy` workflow adds a report-only entropy loop on top of
MonitorOps. A deterministic, dependency-free collector
(`scripts/agentic/collect-agentic-entropy.cjs`) runs the MonitorOps governance
collector first, then scans the governance surfaces (canonical policy, GH-AW
sources/locks, instruction/doc references, architecture boundaries) and reuses
the MonitorOps snapshot for backlog and telemetry signals. It emits a versioned
JSON manifest:

- entropy is reported across explicit dimensions (policy consistency, source/lock
  consistency, instruction/reference integrity, architecture integrity,
  observability coverage, backlog hygiene, maintainability hotspots) with per-rule
  evidence — there is no single opaque score;
- zero-tolerance rules also run locally via `npm run entropy:check` (wired into
  `npm run harness:check`); advisory findings (stale WIP, file-size hotspots,
  TODO markers) are report-only and never block ordinary CI;
- backlog/telemetry rules report `unknown` when no MonitorOps snapshot is present,
  never a false zero;
- a material-state hash drives noop suppression, with the published hash read from
  prior `[factory-entropy]` report issues (`<!-- entropy-state-hash: ... -->`)
  authoritative over cache, so a cache miss never suppresses a report.

The workflow is strictly report-only: it has no create-pull-request, push, edit,
or deletion output, publishes at most one recurring issue, and never proposes or
applies a code, policy, or trading change.

### Staged CorrectionOps (agentic-corrections)

The weekly `agentic-corrections` workflow adds a staged, report-only correction
loop that measures — and only measures — how often the factory's PM-triage and
specialist-routing label decisions were later corrected by a trusted human. A
deterministic, dependency-free collector
(`scripts/agentic/collect-agentic-corrections.cjs`) reconstructs each prediction
from the real `gh aw logs --artifacts all` artifact shape (`aw_info.json`,
`safeoutputs.jsonl`, `safe-outputs-items/safe-output-items.jsonl`, and the
`aw-prompts/prompt-import-tree.json` + `prompt.txt` instruction fingerprint) and
emits a versioned JSON report:

- **PM triage** predictions parse the requested `add-labels`/`noop` and target
  issue; **specialist routing** predictions parse `add-labels` limited to
  `security-review`/`trading-safety` as *semantic* routes, kept separate from the
  *immutable* routes derived deterministically from the PR's changed filenames via
  the canonical reconciler (`.github/scripts/agentic-pr-reconciler.cjs`);
- trusted truth comes only from later GitHub label events authored by a
  `User` collaborator with `admin`/`maintain`/`write` permission, after the
  prediction was applied — bots and untrusted users are retained as provenance
  counts but never scored, and a record with no trusted human action is `pending`,
  never a `match`;
- a human removing a predicted specialist label is a semantic correction but can
  never weaken an immutable path route; such a case is surfaced as a
  safety-warning conflict and the immutable route is preserved;
- the report tracks match/mismatch/pending, correction rate (or `null` when the
  sample size is `0`), immutable-route conflicts, and
  instruction/workflow/model version groupings — no raw
  issue/comment/prompt/event body is ever stored or emitted;
- a material-state hash drives noop suppression, with the published hash read from
  prior `[factory-corrections]` report issues
  (`<!-- correction-state-hash: ... -->`) authoritative over cache, so a cache miss
  re-baselines without a false correction or a duplicate issue;
- a deterministic `npm run corrections:check` validates the diff engine against
  committed contract fixtures and never contacts GitHub.

CorrectionOps improves measurement only in v1: it has no create-pull-request,
push, edit, `add-labels`, or deletion output, publishes at most one recurring
issue, and never scores or learns around trading authorization, guardrails,
leases, reconciliation, operator pause, or the paper/live boundary. See
[`decisions/0010-staged-correction-ops.md`](./decisions/0010-staged-correction-ops.md).
Any future write authority requires a separate human-accepted decision and the
evidence gate in
[`decisions/0012-evidence-gated-automation-authority.md`](./decisions/0012-evidence-gated-automation-authority.md).
Weekly paper review:

- final paper equity;
- realized/unrealized PnL;
- fees and modeled slippage;
- max drawdown;
- trade count/size;
- guardrail activity;
- cash and buy-and-hold comparison; and
- manual journal-quality notes.

Positive short-window PnL is an observation, not proof of edge.

## Evidence for future live review

Do not advance live-trading work until the authoritative readiness gates are
met, including at least 60 consecutive days of qualifying paper evidence,
complete monitoring, no unexplained errors, expected guardrail behavior,
positive net results under the evaluation methodology, and manual journal
review.

Current verified Azure baseline remains: dev is shadow/scheduled and production is disabled/manual; both foundations, releases, and jobs exist, while production has zero scheduled days. Those records predate the issue #132 release. They do not prove the new deadline, readiness, capacity, database-timeout, provider-ceiling, or budget-exhaustion contract. No live #132 target evidence is claimed; source/CI and future exact-release evidence must be classified separately and indexed in issue #76.
