# Monitoring and evaluation runbook

This runbook defines the minimum observability required before any recurring
paper-trading schedule is accepted. It does not authorize live trading.

> **Azure state (2026-08-15): limited release monitoring live.** Dev is
> shadow/scheduled with activation-bound missing-success monitoring; production
> is disabled/manual. Both Action Groups returned successful historical test
> dispatches. Those records predate OPS-01 and do not prove the catalog,
> durable outbox, exact-release delivery, roster, drills, or game day specified
> here.

The only normative numeric SLI/SLO thresholds are in
[`production-readiness-prd.v1.md`](./production-readiness-prd.v1.md) §8.1.
Incident procedure is in
[`incident-response.md`](./incident-response.md), release authorization/status
is in [`readiness.md`](./readiness.md), and deployment order is in
[`deployment.md`](./deployment.md).

## Goals

- Detect failed or missing Container Apps Job executions.
- Prove schedule monitoring is active before unattended work starts.
- Confirm deterministic guardrails, locks, and reconciliation behavior.
- Track model latency/tokens and provider failures.
- Prove daily-summary delivery through ACS Email.
- Preserve append-only incident/outbox and delivery evidence.
- Detect application absence and alert-path failure outside the application.
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
| Safety incident | Append-only database incident origin/events | Preserve detection, acknowledgment, escalation, containment, recovery, and explicit resolution |
| Alert obligation | Append-only database outbox/delivery attempts + provider receipts | Prove an incident retained its external delivery obligation through process/provider failure |
| External alert | Azure Monitor over Log Analytics/platform signals and redacted incident/outbox exports | Detect absence, failures, unsafe state, and overdue delivery independently of web-process liveness |
| Correlation | Structured allowlisted IDs in DB evidence and redacted Log Analytics export | Bind request, run, release, deployment, provider, transaction, and incident timelines |
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

Safety incident exports carry only reviewed opaque reason codes and applicable
request, run, release, immutable deployment, provider operation, database
transaction, and incident IDs. Missing correlation is recorded as missing; it
is never invented after the fact.

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

- **Run schedule:** healthy only while the active schedule satisfies the
  Scheduled completion SLO in the authoritative PRD §8.1 table, or explicitly
  disabled.
- **Lease:** idle, active, stale, or recoverable.
- **Market data:** fresh within the configured window.
- **Accounting:** reconciled, uninitialized, or quarantined.
- **Alert delivery:** latest persisted ACS delivery state.

Pause/resume, expired-lease recovery, and safety-lock override create atomic
audit journal entries. Unlock requires a reason, rejects an active owned
lease, and leaves the agent paused until a separate resume.

## Azure Monitor resources

The issue #125 release adds `caj-<env>-safety-relay`, an independently
scheduled, non-trading five-minute job. It performs a read-only latest-event
scan of `SafetyIncidentOutbox` and exports only allowlisted lifecycle and
correlation fields plus a scan heartbeat. It has no cron secret, run route,
model/provider call, policy call, or executor import. Its schedule is monitoring
infrastructure and does not make the hourly/daily trading jobs scheduled;
production remains disabled with those two trading jobs Manual.

Each `environment.bicep` foundation declares:

- Log Analytics workspace `log-krypto-<env>`;
- Action Group `ag-krypto-<env>`; and
- critical scheduled-query alert `alert-krypto-<env>-job-failed`; and
- the independent issue #125 safety catalog.

The failure alert:

- evaluates every 5 minutes over a 15-minute window;
- checks both trading scheduler jobs plus the non-trading safety relay;
- matches terminal failure/backoff/deadline/nonzero-exit signals; and
- sends the common alert schema to the operator Action Group.

Initial query validation is skipped because a new workspace has no Container
Apps log table until its first log arrives. This alert is still enabled from
foundation deployment. Its live behavior must be tested before accepting
schedule activation.

The catalog source now observes two independent evidence planes:

1. external Log Analytics/platform signals such as Container Apps Job history,
   scheduled probe results, failures, capacity, and absence; and
2. redacted exports of durable PostgreSQL incident/outbox origins, pending age,
   delivery attempts, and provider receipts.

The relay/exporter runs as a separate read-only job process. Azure alerts remain actionable when the
web process is dead. A liveness `200`, application-emitted event, daily email,
or successful retry cannot by itself establish scheduled completion, durable
incident persistence, external delivery, acknowledgment, or resolution.
No live deployment or delivery proof is claimed until the exact release exports
and drills are indexed in issue #76.

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
5. a missing scheduled completion that reaches the authoritative PRD §8.1
   critical condition raises severity 1.

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

For either environment to satisfy OPS-01, the future exact-release procedure
must also deploy/export the complete alert catalog below, prove durable
incident/outbox visibility, test warning and critical delivery,
acknowledgment/escalation, and retain the game-day evidence required by
`incident-response.md`. Missing or stale roster evidence blocks issue #75 /
PR-G2.

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

Review delivery health immediately when an expected daily slot has no persisted
`sent` event or the latest event is failed/skipped. Inspect ACS operation state,
sender/domain state, recipient, Key Vault reference resolution, and protected
logs. Do not report healthy delivery from a successful HTTP response without
the persisted delivery audit.

## Alert catalog

`Severity/SLO` references the authoritative table in
`production-readiness-prd.v1.md` §8.1. `Primary` and `backup` are roles whose
current named assignments belong in the fail-closed roster, not identities to
invent in this document.

| Alert | Detection and severity/SLO | Primary | Backup | Ack/escalation target | Deduplication key | Runbook |
|---|---|---|---|---|---|---|
| Missing scheduled run | External expected-slot/ACA history query. **Warning** for an unexplained missed slot; **Critical** at the Scheduled completion SLO breach. | Primary on-call | Backup on-call | Warning/Critical target in PRD §8.1 | Environment + activation generation + expected UTC slot | [Missing scheduled run](./incident-response.md#scenario-actions) |
| Route/run error, deadline, cancellation, or provider budget | Persisted route/run terminal outcome plus external job signal. **Warning** for an isolated fail-closed no-trade outcome; **Critical** for a critical category, absent terminal persistence, or Run error SLO breach. | Primary on-call | Backup on-call | Warning/Critical target in PRD §8.1 | Environment + run ID + typed category | [Route/run and provider](./incident-response.md#scenario-actions) |
| Drawdown | Durable drawdown lock/event. **Critical immediately.** | Primary on-call | Rollback owner | Critical target in PRD §8.1 | Environment + account + drawdown-lock generation | [Drawdown](./incident-response.md#scenario-actions) |
| Stale or overlapping lease | Durable lease observation plus readiness/external query. **Critical immediately** under the Lease age and overlap SLO. | Primary on-call | Rollback owner | Critical target in PRD §8.1 | Environment + account + lease generation + category | [Lease](./incident-response.md#scenario-actions) |
| Reconciliation failure or quarantine | Durable reconciliation checkpoint/quarantine state. **Critical immediately** under the Reconciliation and quarantine SLO. | Primary on-call | Trading-safety approver | Critical target in PRD §8.1 | Environment + account + execution/checkpoint ID | [Reconciliation](./incident-response.md#scenario-actions) |
| Unexpected shadow trade | `TradeExecution` joined to a SHADOW run/deployment. **Critical immediately.** | Primary on-call | Rollback owner | Critical target in PRD §8.1 | Environment + immutable deployment + execution ID | [Unexpected shadow trade](./incident-response.md#scenario-actions) |
| Authentication or provenance mismatch | Rejected or successful mismatch between signed request, release, deployment, target, mode, or approval. **Critical immediately** if mutation succeeded or provenance is uncertain; otherwise **Warning** while fail closed. | Release owner | Trading-safety approver | Warning/Critical target in PRD §8.1 | Environment + request/signature ID + immutable deployment | [Auth/provenance](./incident-response.md#scenario-actions) |
| Daily-summary delivery failure | Missing expected persisted `sent`, or persisted failed/skipped delivery. **Warning**; treat loss of the safety-alert channel under the incident/outbox-delivery row. | Primary on-call | Backup on-call | Warning target in PRD §8.1 | Environment + daily UTC schedule slot | [Provider/telemetry](./incident-response.md#scenario-actions) |
| `journalWritten=false` | A committed execution whose required journal projection is false/missing. **Critical immediately.** | Primary on-call | Evidence custodian | Critical target in PRD §8.1 | Environment + execution ID + journal obligation ID | [Post-commit failure](./incident-response.md#scenario-actions) |
| Persisted post-commit failure | Durable post-commit obligation/incident reports journal, analytics, telemetry, or notification failure after ledger commit. **Critical immediately** for execution evidence; otherwise severity follows the originating incident. | Primary on-call | Evidence custodian | Originating severity target in PRD §8.1 | Incident ID + post-commit obligation ID + category | [Post-commit failure](./incident-response.md#scenario-actions) |
| Readiness or capacity | Independent readiness probe or ACA admission/capacity signal. **Warning** for an isolated fail-closed rejection; **Critical** at the Readiness SLO breach or unsafe admission. | Primary on-call | Release owner | Warning/Critical target in PRD §8.1 | Environment + immutable deployment + opaque reason code + probe window | [Readiness/capacity](./incident-response.md#scenario-actions) |
| Safety incident persistence or external delivery | Missing atomic incident/outbox evidence, overdue pending obligation, failed relay, or absent provider receipt. **Critical immediately** for missing critical persistence/delivery; warning incidents follow the Incident persistence and external delivery SLO. | Primary on-call | Backup on-call | Warning/Critical target in PRD §8.1 | Incident ID + alert class + environment + channel | [Telemetry/alert provider](./incident-response.md#scenario-actions) |

Every row uses the acknowledgment/escalation target for its severity from the
normative SLI/SLO table. Alert providers and responders deduplicate by the key
above but retain every delivery attempt and duplicate receipt. Provider
acceptance is not acknowledgment. A later success/retry appends recovery
evidence and never auto-resolves the incident.

## Daily and weekly review

Daily:

- hourly scheduled success exists for the current digest/activation generation
  when Schedule is active;
- no scheduler or application error is unexplained;
- daily ACS summary is sent and audited;
- no unexpected drawdown/reconciliation/lease state exists;
- each paper trade has a matching run and journal;
- every safety incident has append-only lifecycle/outbox evidence and no overdue
  unclassified delivery obligation;
- no-trade decisions remain coherent.

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

The same evidence boundary applies to OPS-01. This documentation change does not
claim live catalog rules, durable outbox/relay behavior, Action Group delivery,
a completed on-call roster, warning/critical drills, game-day evidence, or
Azure target proof. Future monitor exports, delivery receipts, timelines,
acknowledgments, escalations, roster, correlation/redaction review, outbox
evidence, and preserved-ledger proof must be indexed in issue #76.
