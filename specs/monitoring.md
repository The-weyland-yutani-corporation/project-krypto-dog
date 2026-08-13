# Monitoring and evaluation runbook

This runbook defines the minimum observability needed before production cron is
enabled and before any future live-trading RFC can move beyond draft.

These signals supply evidence for PR-G2 through PR-G4 in
[`production-readiness-prd.v1.md`](./production-readiness-prd.v1.md). The PRD
remains authoritative for gate thresholds and authorization.

## Goals

- Detect broken cron/API runs quickly.
- Confirm guardrails are firing when expected.
- Track LLM cost and latency.
- Track paper-trading outcomes without confusing them for proven expected value.
- Preserve enough evidence for the v3 go/no-go review.

## Required signals

| Signal | Source | Why it matters |
|---|---|---|
| Agent run status | Persisted `AgentRun.outcome` (PostHog is secondary) | Detects errors, skipped runs, locks, and successful paper decisions |
| Trigger source | PostHog `triggerSource` | Separates cron behavior from operator-triggered runs |
| Guardrail events | PostHog `guardrail_triggered` | Shows cooldown, drawdown, and pre-flight skips |
| Trade events | PostHog `trade_executed` | Confirms paper trade execution and structured trade fields |
| Token usage | PostHog `llm_token_usage` | Tracks prompt/completion cost and abnormal token spikes |
| Daily summary | `AgentJournal.marketConditions.event = daily-summary-delivery` plus route result | Human-readable 24h digest and persisted sent/skipped/failed health |
| Cron job result | Current baseline: Supabase `cron.job_run_details` and `net._http_response`. Azure runbook (implemented, unprovisioned): Container Apps Job execution history (see "Azure Container Apps Jobs and Log Analytics checks" below) | Verifies scheduled invocation actually reached the app |
| App logs | Current baseline: Vercel logs / local console. Azure runbook: Container Apps Log Analytics workspace (`infra/environment.bicep`, implemented, unprovisioned) | Debugging route exceptions, LLM retries, Coinbase failures, email failures |

## PostHog dashboard

Create a "Project Krypto Ops" dashboard with:

1. **Run status over time**
   - Event: `agent_run_completed`
   - Breakdown: `status`
   - Filter: last 7 / 30 days

2. **Error runs**
   - Event: `agent_run_completed`
   - Filter: `status = error`
   - Alert if count is `> 0` in a 24h window.

3. **Locked or guardrail-skipped runs**
   - Event: `guardrail_triggered`
   - Breakdown: `reason` or `guardrailName`
   - Alert immediately for drawdown lock.

4. **Trade outcomes**
   - Event: `trade_executed`
   - Breakdown: `direction`
   - Trends: `amountUSD`, `feesUSD`, `pnlUSD`

5. **Token usage**
   - Event: `llm_token_usage`
   - Trends: `totalTokens`, `promptTokens`, `completionTokens`
   - Alert on large unexpected spikes.

6. **Trigger source mix**
   - Events: `agent_run_started`, `agent_run_completed`
   - Breakdown: `triggerSource`
   - Goal: production should mostly be `cron`; `admin` runs should be explainable.

## Admin health dashboard

The `/admin` dashboard derives operational status from persisted database
evidence:

- **Run Schedule:** healthy within two hours of `lastCompletedRunAt`, or
  explicitly disabled.
- **Run Lease:** idle, active, stale, or recoverable based on owner/expiry.
- **Market Data:** fresh when the latest persisted observation is within two
  hours.
- **Accounting:** reconciled, uninitialized, or quarantined.
- **Alert Delivery:** sent, skipped, failed, stale, or unknown from the latest
  daily-summary journal event.

Pause/resume, expired-lease recovery, and safety-lock override also write audit
journal records. Unlock requires an operator reason and is refused while an
owned lease is active. Unlock leaves the agent paused so resumption is a
separate audited decision.

## Azure Container Apps Jobs and Log Analytics checks (implemented runbook, unprovisioned)

Once an Azure environment is actually provisioned (`specs/deployment.md`),
the scheduler equivalent of the Supabase cron checks above is Container
Apps Job execution history — there is no `pg_cron`/`pg_net` on the Azure
target (ADR 0008 item 1, item 10):

```bash
# Recent hourly agent-run executions
az containerapp job execution list \
  --name caj-<env>-agent-run \
  --resource-group <rg> \
  --query "[].{name:name, status:properties.status, startTime:properties.startTime}" \
  --output table

# Recent daily-summary executions
az containerapp job execution list \
  --name caj-<env>-daily-summary \
  --resource-group <rg> \
  --output table
```

`status = Succeeded` is the goal; `Failed` or a missing recent execution
during an enabled schedule window is the Azure equivalent of a missed
Supabase cron tick. Application-level logs are queryable from the
per-environment Log Analytics workspace `environment.bicep` creates
(`logAnalyticsWorkspaceId` output); an Action Group for operator email
alerts is also created (`infra/modules/monitoring.bicep`), but no
scheduled query alert rules are deployed by Bicep yet — configuring them
against the Log Analytics workspace is an operational follow-up once an
environment is provisioned, not something this repository automates
today.

## Supabase cron checks (current Vercel/Supabase baseline)

Registered jobs:

```sql
SELECT jobid, jobname, schedule, active
FROM cron.job
ORDER BY jobid;
```

Recent cron executions:

```sql
SELECT runid, jobname, status, return_message, start_time, end_time
FROM cron.job_run_details
ORDER BY runid DESC
LIMIT 20;
```

Recent HTTP responses:

```sql
SELECT id, status_code, content, created
FROM net._http_response
ORDER BY id DESC
LIMIT 20;
```

Healthy criteria:

- Before controlled cron enablement, neither Krypto job is active.
- After v2.1 fixed cron functions are installed and explicitly enabled,
  `cron.job` contains `krypto-agent-run-hourly` and
  `krypto-daily-summary`.
- Recent `cron.job_run_details.status` is `succeeded`.
- Recent `net._http_response.status_code` is `200`.
- The response body is one of the healthy API outcomes documented in
  [`deployment.md`](./deployment.md).

## Daily review checklist

- Daily summary email arrived or local no-op summary was logged.
- No `agent_run_completed.status = error` events.
- No unexpected drawdown lock.
- If trades occurred, confirm each has a corresponding journal entry.
- If no trades occurred, confirm the journal/decision rationale is coherent.

## Weekly paper-trading review

For the v3 evidence gate, record:

- Final paper equity.
- Realised and unrealised PnL.
- Fees and modeled slippage.
- Max drawdown.
- Trade count and average trade size.
- Guardrail activations.
- Whether paper equity beat cash baseline.
- Whether paper equity beat buy-and-hold ETH over the same period.
- Manual journal-quality notes.

Until weighted historical evidence is strong, treat positive daily PnL as a
single observation, not proof of edge.

## Alert thresholds

| Alert | Threshold | Action |
|---|---|---|
| Agent error | Any `agent_run_completed.status = error` in 24h | Inspect Vercel logs and DB state |
| Drawdown lock | Any drawdown guardrail event or `status = locked` | Stop, inspect recent trades/journals, do not auto-unlock |
| Missing cron | No `agent_run_completed` for > 2h during enabled cron window | Check Supabase cron, Vault secrets, Vercel deployment |
| Stale lease | `leaseExpiresAt < now()` or repeated 409 after expiry | Inspect owner/run record; use only the expired-lease recovery path |
| Reconciliation failure | `accountingStatus != RECONCILED` | Keep trading blocked and reconcile immutable history before any unlock |
| Alert delivery | Latest persisted delivery is failed/skipped, or older than 36h | Repair Resend configuration/provider health and prove a successful delivery |
| Model retry/latency | `attemptCount > 1` or latency materially above baseline | Inspect Foundry rate limits, deployment health, and timeout frequency |
| Token spike | `totalTokens` materially above recent median | Inspect prompt/journal context growth |

## Evidence for v3

The full evidence criteria are defined in `specs/evaluation.md` and the release
gates are in `specs/readiness.md` §4. Summary -- do not advance live-trading work
until monitoring shows:

- At least 30 calendar days of successful paper cron runs.
- No unexplained route errors.
- Guardrails behave as expected.
- Daily/weekly reports show positive net performance after fees/slippage.
- Paper runs satisfy the evaluation criteria in `specs/evaluation.md` §5: final
  equity beats both cash and buy-and-hold baselines over a >= 30-day out-of-sample
  window.
- Manual journal review finds coherent decisions and no prompt gaming.

Current baseline: 0 production days (v2 not yet deployed). See `specs/readiness.md`
§1 for the current evidence summary.
