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
| Daily delivery | `AgentJournal` event `daily-summary-delivery` | Persisted ACS `sent`/`skipped`/`failed` health |
| Job execution | Container Apps Job history + Log Analytics | Prove scheduler process started and completed |
| Idempotency proof | Job execution env + exact `AgentRun.idempotencyKey` + activation-check report | Bind attended shadow and scheduled observation to the current proof generation |
| App/job logs | Per-environment Log Analytics workspace | Diagnose route, model, market, database, email, and process failures |
| Immutable deployment evidence | Evidence blob report | Bind checks to environment, release SHA, image digest, operation, and execution ID |

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
| Model retry/latency | Attempts >1 or material latency increase | Inspect Luna deployment health, quota, and timeout frequency |
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

Current Azure baseline: **2 provisioned environment foundations, 0 releases,
0 Container Apps Jobs, and 0 scheduled production days**. Foundation workflow
evidence exists; release, ops-job, and schedule evidence does not.
