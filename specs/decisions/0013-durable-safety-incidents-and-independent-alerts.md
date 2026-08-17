# 0013 — Durable safety incidents and independent external alerts

- **Status:** Accepted
- **Date:** 2026-08-17
- **Deciders:** @VeVarunSharma

## Context

Project Krypto can preserve an authoritative paper execution while a later
journal, analytics, or notification write fails. A process log or best-effort
email cannot carry the resulting alert obligation: the process may exit, a
provider may be unavailable, and the application cannot detect its own absence.
Likewise, a successful retry does not prove that responders saw, contained, and
resolved the original safety condition.

The immutable paper ledger remains accounting truth. Incident handling must not
rewrite that truth, fabricate a compensating trade, or turn a telemetry failure
into a success-shaped response. The production target remains PAPER-only and
production remains disabled/manual; this decision authorizes no Azure mutation,
schedule activation, PAPER promotion, or live-money execution.

## Decision

**Use an append-only PostgreSQL safety-incident/outbox ledger and independently
operated external Azure alerts.** The exact table and worker names are
implementation details, but the following logical records and invariants are
required:

1. An immutable incident origin records a stable incident ID, category,
   severity, detection time/source, redacted summary, and the available
   correlation identifiers.
2. A lifecycle is represented by appended events such as detected,
   acknowledged, escalated, contained, recovered, and resolved. Retrying,
   acknowledging, or resolving an incident never updates or deletes prior
   evidence.
3. An append-only outbox records every external-alert obligation. Delivery
   attempts and provider receipts are appended and retain failures as well as
   successes. A mutable queue projection or lease may optimize dispatch, but it
   is never incident or delivery truth.
4. A safety-relevant state change and its incident origin, initial event, and
   alert obligation are committed in the same database transaction. If that
   durable evidence cannot be written, the safety-relevant mutation fails
   closed.
5. Every PAPER execution transaction creates its durable post-commit
   obligations before commit. If a journal, analytics, telemetry, or other
   post-commit action later fails, the already-committed ledger remains
   authoritative and a persisted post-commit incident references the execution
   and obligation. No retry re-executes or hides the trade.

Missing runs, readiness loss, platform failure, and outbox age/delivery failure
must also be detectable outside the application. Azure Monitor rules therefore
observe external Log Analytics/platform signals plus redacted exports of the
durable incident/outbox ledger. A separately operated, least-privilege relay
delivers outbox obligations; it is not the web process whose failure may be the
incident. Process liveness alone is never sufficient evidence of schedule,
route, database, incident, or alert-delivery health.

Delivery is at least once. Deduplication uses the stable incident ID, alert
class, environment, and channel; duplicates are safer than a lost critical
alert. Provider acceptance is delivery evidence, not acknowledgment or
resolution.

### Correlation and redaction

Structured incident evidence propagates, when applicable:

- request, run, release, immutable deployment, provider operation, database
  transaction, and incident IDs;
- environment, rollout mode, category, severity, and event timestamp; and
- an allowlisted opaque error/reason code.

Secrets, credentials, tokens, connection strings, raw provider payloads,
database URLs, internal resource IDs, lease owners, and unreviewed free-form
content are excluded. Missing correlation is itself evidence to classify; an
operator must not invent a value after the fact.

### Resolution

Only the named release owner or trading-safety approver can append resolution,
and only after a distinct actor in the complementary role has confirmed the
incident, plus acknowledgment, escalation when due, containment, cause,
recovery validation, and follow-up ownership are recorded. A later successful
run, retry, delivery attempt, readiness probe, or provider call may be appended
as recovery evidence but must never auto-resolve the incident.

The severity, SLI/SLO, acknowledgment, escalation, containment, and recovery
thresholds are governed only by the authoritative table in
[`production-readiness-prd.v1.md`](../production-readiness-prd.v1.md) §8.1.
Operational steps and required evidence are in
[`incident-response.md`](../incident-response.md).

## Evidence status

This ADR and the issue #125 source/documentation change are not target evidence.
Any implemented schema, repository, correlation, roster-validation, or
transaction integration must first be proven and labeled as source/CI evidence.
They do not prove that the transactional obligations, independent relay, Azure
alert rules, Action Group delivery, responder roster, drills, or game day exist
on a target. Source/CI evidence and future exact-release target evidence must be
classified separately and indexed in issue #76.

## Consequences

- **Positive:** A committed safety condition cannot lose its alert obligation
  when the process, telemetry path, journal write, or provider fails.
- **Positive:** Append-only lifecycle and delivery attempts preserve the full
  timeline for replay, audit, and gate review.
- **Positive:** External absence and delivery monitors do not depend on the
  application reporting its own health.
- **Trade-off:** PostgreSQL, a separate relay, Log Analytics exports, and Azure
  alerts form a larger operational boundary that needs least-privilege access,
  retention, deduplication, capacity, recovery, and drill evidence.
- **Trade-off:** At-least-once delivery can produce duplicate notifications;
  responders and channels must deduplicate by incident identity.
- **Follow-up required:** Complete and prove source/migration integration plus
  the relay, monitor, redaction, drill, and target contracts before issue #75 /
  PR-G2.

## Alternatives considered

- **Application logs and email only:** Rejected because the application cannot
  detect its own absence and process/provider failure can erase the obligation.
- **Mutable incident rows:** Rejected because status updates can overwrite the
  timeline and make retry success look like incident resolution.
- **Telemetry as accounting truth:** Rejected because the immutable paper
  ledger and deterministic reconciliation remain authoritative.
- **Synchronous external notification inside the trade transaction:** Rejected
  because an external provider is not transactional with PostgreSQL and would
  extend or ambiguously fail the paper commit boundary.
