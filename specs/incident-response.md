# Production-paper incident-response runbook

This runbook implements the operating contract in
[ADR 0013](./decisions/0013-durable-safety-incidents-and-independent-alerts.md).
It is PAPER-only. It authorizes no Azure mutation, schedule activation,
production promotion, fabricated ledger correction, or live-money action.

All numeric SLI/SLO, acknowledgment, escalation, containment, and recovery
thresholds come only from the authoritative table in
[`production-readiness-prd.v1.md`](./production-readiness-prd.v1.md) §8.1.
Do not restate, weaken, average away, or locally override those thresholds.

## Fail-closed responder roster

The roster must be bound to the frozen release, environment, declared window,
and tested contact path, then indexed in issue #76.

| Required role | Named person and tested contact path | Current status |
|---|---|---|
| Primary on-call | `[REQUIRED — name and protected contact record]` | **Placeholder; blocking** |
| Backup on-call | `[REQUIRED — name and protected contact record]` | **Placeholder; blocking** |
| Release owner | `[REQUIRED — name and release authority]` | **Placeholder; blocking** |
| Trading-safety approver | `[REQUIRED — name; distinct where the gate requires]` | **Placeholder; blocking** |
| Evidence custodian | `[REQUIRED — name and evidence access]` | **Placeholder; blocking** |
| Rollback owner | `[REQUIRED — name and tested stop access]` | **Placeholder; blocking** |

A roster is stale when it is not explicitly accepted for the exact release and
window, a responder is unavailable, its protected contact path has not been
test-fired for the candidate, access or role independence has changed, or its
issue #76 record cannot be verified. A missing, placeholder, contradictory, or
stale roster blocks issue #75 / PR-G2. No unattended window may start while this
table remains unresolved.

Each named role also registers a distinct Ed25519 public key. Acknowledge and
escalate API requests are accepted only when their canonical action, incident,
actor, reason, evidence, and five-minute timestamp are signed by that role's
private key. Private keys never enter Project Krypto configuration or evidence.
The shared admin session alone cannot impersonate a responder. Resolution is
not exposed through that shared session and remains a protected owner/migrator
operation with the database transition checks described below.

## Severity and authority

- **Critical:** An actual or credible loss of a trading-safety invariant,
  accounting truth, authorization/provenance, alert obligation, required
  monitoring, or recovery objective. Invoke the absolute-stop/containment path.
- **Warning:** A degraded non-trading condition that remains fail closed and has
  not crossed a critical SLO or safety boundary. Investigate and prevent
  escalation.

The primary on-call owns initial acknowledgment and containment. The backup
assumes response when the primary does not acknowledge by the applicable SLO.
The rollback owner controls the approved stop path. The trading-safety approver
controls safety re-entry, not diagnosis. The evidence custodian verifies
redaction, append-only completeness, checksums, and issue #76 indexing. A
provider receipt, bot, retry, or application process cannot acknowledge or
resolve an incident.

## Response lifecycle and evidence

### 1. Detect and preserve

Accept detections from independent Azure job/readiness/capacity monitors,
durable database incident/outbox evidence, reconciliation and ledger checks,
provider/delivery receipts, and attended operator observations. Application
liveness alone is not a health signal.

Immediately preserve:

- incident ID, category, severity, detection source and UTC timestamp;
- immutable raw-source reference or checksum-addressed redacted export;
- initial outbox obligation and every delivery attempt/receipt;
- rollout mode, environment, and the known correlation identifiers; and
- the current ledger/reconciliation/lease state without modifying it.

If an expected incident or outbox record is absent, treat the persistence gap as
a critical incident. Do not reconstruct a false same-transaction history.

### 2. Correlate without guessing

Correlate the allowlisted request, run, release, immutable deployment, provider
operation, database transaction, and incident IDs. Record which identifiers are
not applicable and which are missing. Never infer or invent a missing ID.

Redact secrets, credentials, tokens, connection strings, raw provider payloads,
database URLs, internal resource IDs, lease-owner values, and unreviewed
free-form content. Retain opaque reason codes, timestamps, environment, rollout
mode, category, severity, and immutable evidence references.

### 3. Acknowledge and escalate

The named responder appends an acknowledgment with actor, role, UTC timestamp,
contact path, incident ID, and initial containment decision. Use the
acknowledgment and escalation targets in the normative SLI/SLO table.

If acknowledgment is absent at the applicable deadline, independently notify
the backup and required release/safety authorities and append the escalation
attempt and provider receipt. Escalation does not wait for an application
retry. A failed escalation delivery is a separate critical delivery incident.

### 4. Contain

For critical incidents, use the approved absolute-stop path: prevent new lease
acquisition, disable/drain recurring work, preserve in-flight truth, and block
promotion. Do not clear an active lease by direct SQL, delete a run or incident,
unlock a drawdown automatically, or fabricate a flattening trade.

Append containment time, actor, command/workflow identity, bound release and
deployment, before/after schedule and rollout state, lease state, and immutable
ledger checkpoint. Containment must satisfy the normative recovery SLO.

### 5. Investigate and recover

Determine the initiating condition, blast radius, affected runs/executions,
delivery path, and whether credentials or evidence integrity are in doubt.
Recovery remains disabled/manual until the incident-specific checks below,
reconciliation, readiness, and protected approval pass.

A clean retry is only a recovery observation. Append it to the original
timeline; never auto-resolve or erase the failure.

### 6. Resolve explicitly

Only the named release owner or trading-safety approver may append resolution,
after a distinct actor in the complementary role has acknowledged or escalated
the incident and:

- the cause and affected interval are recorded;
- acknowledgment, required escalation, and containment evidence are complete;
- ledger truth is preserved and every execution is reconciled or quarantined;
- monitoring and alert delivery are independently re-proven;
- recovery satisfies the normative objectives;
- follow-up owner and issue links are recorded; and
- the evidence custodian verifies redaction and issue #76 indexing.

Resolution records actor, role, UTC timestamp, reason, recovery evidence, known
residual risk, and re-entry decision. It never replaces earlier events.

The source operation is `npm run incident:respond` with `SAFETY_ACTION` set to
`ACKNOWLEDGE`, `ESCALATE`, or `RESOLVE`. It runs only from the protected
owner/operator lane with `DIRECT_URL`, sets the fixed `krypto_schema_owner` role
inside one transaction, verifies a fresh Ed25519 role assertion, enforces the
role/action matrix, requires the complete evidence set for resolution, and
relies on the database transition trigger for distinct complementary-role
confirmation. Runtime credentials and the shared admin session cannot append
human lifecycle events.
The required `SAFETY_*` environment names are visible in the script and the
protected operator handoff; real identities, signatures, and private keys are
never committed.

## Scenario actions

| Scenario | Required fail-closed response and evidence |
|---|---|
| Missing scheduled run | Confirm the external schedule monitor and activation boundary; keep/restore disabled/manual; correlate expected slot, ACA history, route outcome, durable run/incident evidence, alert delivery, acknowledgment, and escalation. |
| Route/run error, deadline, cancellation, or provider budget | Preserve the typed terminal no-trade result and owned-lease release/expiry; classify provider versus internal cause; never return a success-shaped fallback or retry past the bounded deadline. |
| Provider failure | Keep the run no-trade, preserve request budget/attempt/receipt evidence, and classify the outage. Later provider success is recovery evidence only. |
| Telemetry or alert-provider failure | Do not alter paper state. Preserve the durable outbox obligation, pending age, failed attempts, external delivery-failure signal, and alternate protected evidence path. Loss of required monitoring is critical. |
| `journalWritten=false` or persisted post-commit failure | Preserve the committed execution and ledger. Open/correlate the durable incident and post-commit obligation, block further PAPER activity as required, repair the journal/evidence projection from ledger truth, and reconcile before re-entry. Never re-execute or delete the trade. |
| Drawdown | Keep the drawdown lock engaged, invoke the stop path, checkpoint and reconcile immutable ledger/equity history, and require an explicit reviewed unlock reason plus separate resume. |
| Lease stale or overlap | Stop new work. Preserve owner/expiry/transaction evidence in protected form; recover only an expired lease through the audited path. Any overlap is critical and direct SQL clearing is prohibited. |
| Reconciliation mismatch or quarantine | Keep trading blocked, preserve ledger and materialized-state snapshots, deterministically replay, and leave the account quarantined until the mismatch is explained and verified. |
| Unexpected shadow trade | Invoke the absolute stop, disable schedules, preserve the unexpected `TradeExecution` and all linked evidence, reconcile/quarantine, invalidate the window, and require a new approved window. Never delete or offset the row. |
| Authentication or provenance mismatch | Reject the action, disable recurring work, preserve signed request/release/deployment evidence, and treat any successful unauthorized mutation as critical. |
| Credential concern | Stop schedules and affected access, preserve nonsecret audit evidence, notify security/release/safety roles, rotate or revoke only through an approved path, and re-prove identity and provenance. Never copy the credential into an incident or issue. |
| Readiness or capacity loss | Prevent activation/admission, correlate opaque readiness reasons with protected target evidence, and use the normative readiness SLO to determine critical escalation. |
| Recovery-objective concern | Keep the target disabled/manual, restore into a clean isolated target, verify ledger/incident/outbox completeness and disabled scheduling, and treat an objective breach as critical. |

## Recovery and preserved truth

Recovery uses the RPO and RTO in the normative SLI/SLO table. Restore into a
clean isolated target with schedules disabled. Verify migrations, roles,
configuration, immutable paper ledger, incident/event/outbox/delivery history,
reconciliation, readiness, alert rules, and release provenance before any
re-entry decision.

An open paper position remains open in evidence unless an authorized PAPER
execution actually changed it. Recovery and rollback never reset balances,
delete failed windows, rewrite incidents, fabricate a flattening trade, or prune
the evidence needed for deterministic replay.

## Non-trading drills and game day

Before issue #75 / PR-G2, use an isolated production-equivalent target or a
disabled/manual target that cannot commit a paper trade:

1. Test-fire one warning and one critical incident through durable persistence,
   outbox relay, independent Azure observation, delivery, acknowledgment, and
   escalation. Preserve duplicates and failed attempts.
2. Prove a successful retry does not auto-resolve either incident; append an
   explicit human resolution only after recovery evidence.
3. Run a game day covering missing run, provider failure, stale lease, drawdown,
   reconciliation/quarantine, persisted post-commit failure, and credential
   concern. Include telemetry/alert-provider loss and correlation/redaction
   review.
4. Prove zero unexpected `TradeExecution` delta and unchanged immutable ledger
   truth. Production state fault injection and live-money activity are
   prohibited.
5. Record follow-ups as blocking or owned work; do not mark the drill passed by
   excluding a failed scenario.

## Exact issue #76 OPS-01 evidence

Index source/CI evidence separately from future exact-release target evidence.

**Source/CI evidence:**

- frozen source ref, merge SHA, protected-main checks, and policy version;
- ADR/runbook versions and the normative SLI/SLO table version;
- migration/schema and append-only denial tests for incident, lifecycle,
  outbox, and delivery-attempt evidence;
- atomic state-change/incident/outbox and post-commit-obligation tests;
- relay deduplication, retry, provider-failure, and no-auto-resolution tests;
- structured correlation allowlist and redaction tests; and
- deterministic warning/critical fixtures labeled engineering-only.

**Future exact-release target evidence:**

- immutable release/deployment/target/configuration identities;
- redacted Azure Monitor rule exports showing external Log Analytics/platform
  queries and durable incident/outbox export coverage;
- Action Group/channel configuration and provider receipts for the exact target;
- current named roster and protected contact-path test proof;
- warning and critical drill timelines with detection, outbox, delivery,
  acknowledgment, escalation, containment, recovery, and explicit resolution;
- the game-day timeline and follow-ups;
- correlation-completeness and redaction review;
- append-only database/outbox export and pending-age/delivery-attempt proof;
- preserved ledger, zero unexpected trade delta, reconciliation/quarantine, and
  recovery-objective proof; and
- evidence-custodian attestation and immutable/checksum-addressed issue #76
  links.

This source documentation does not claim live drills, Action Group delivery, a
completed on-call roster, or Azure OPS-01 evidence.
