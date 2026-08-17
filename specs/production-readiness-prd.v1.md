# Production PAPER Readiness PRD v1

| Field | Value |
|---|---|
| Status | Draft |
| Version | 1.0 |
| Baseline reference (main tip at authoring) | `main@38901cf1a620a60d3a8821220183c3a6ca971e29` |
| Document owner | `@VeVarunSharma` |
| Release owner | Required before PR-G1; recorded in issue #76 |
| Trading-safety approver | Required before PR-G2; must be distinct from the release actor |
| Evidence custodian | Required before PR-G1; recorded in issue #76 |
| Scope | Production-grade PAPER trading only |

This PRD defines the durable requirements, authorization model, trust
boundaries, and release gates for operating Project Krypto as a production
paper-trading system. It does not authorize a deployment or record current
evidence. Current status remains in [`readiness.md`](./readiness.md).

## 1. Document authority

Project Krypto separates durable requirements from mutable evidence and
procedures:

| Document | Authority |
|---|---|
| [`prd.md`](./prd.md) | Implemented product behavior |
| This PRD | Production-paper controls, authorization rules, trust boundaries, and gate thresholds |
| [`readiness.md`](./readiness.md) | Current evidence/status ledger and gate disposition |
| [`deployment.md`](./deployment.md) | Operator procedures |
| [`monitoring.md`](./monitoring.md) | Signals, dashboards, alerts, and response instructions |
| [`evaluation.md`](./evaluation.md) | Metric definitions and evaluation methodology |
| [`rfcs/0002-evidence-grade-paper-trading.md`](./rfcs/0002-evidence-grade-paper-trading.md) | Architectural design context |
| [`decisions/`](./decisions/) | Accepted architectural decisions |
| [Backlog governance](../.github/BACKLOG_GOVERNANCE.md) | Milestones, labels, WIP, and agentic workflow policy |
| GitHub issue #76 | Canonical immutable evidence and go/no-go index for a release candidate |

If two documents conflict, the more specific authority in this table wins.
Mutable observations must be corrected in `readiness.md`; they must not be
copied into this PRD.

The words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, and **MAY** are used
normatively.

## 2. Problem

The application has deterministic trading policy, transactional paper
execution, owned leases, private-schema migrations, deployment preflight,
target smoke, and evidence tooling. Those foundations do not by themselves
make a production system.

Production-paper operation also requires:

- enforced human and automation trust boundaries;
- immutable source-to-deployment provenance;
- identity-bound operator and scheduler access;
- least-privilege database identities;
- a bounded execution and readiness envelope;
- independent safety alerts and response ownership;
- complete recovery and retention proof;
- an absolute stop fence;
- deterministic pre-PAPER accounting attestation; and
- controlled shadow, PAPER, and evidence windows.

Without these controls, passing CI or merging code can be mistaken for
authorization to mutate a target or promote trading.

### Current NO-GO baseline

At the authoring baseline:

- PR #78 is not part of protected `main` and requires reconciliation before its
  migration/runtime/evidence changes can become release evidence;
- issues #72 through #76 and SRC-01 through ROLL-01 remain open;
- no protected approval record authorizes target mutation, shadow, or PAPER;
- target, recovery, alert, absolute-stop, and accounting-attestation evidence
  is incomplete; and
- the only safe posture is rollout `disabled` with Krypto cron unscheduled.

This section records the baseline used to design the contract. Current
disposition belongs in `readiness.md` and issue #76 rather than being updated
here.

## 3. Required outcome

Project Krypto is **production-paper operational** when:

1. an approved, immutable deployment runs only against its approved paper
   target;
2. all requests and operator actions are authenticated, authorized, attributable,
   and replay-resistant;
3. deterministic controls retain sole authority over trading;
4. execution is bounded by one proven deadline, lease, and stop contract;
5. ledger/materialized state is reconciled before and during operation;
6. independent alerts reach named responders;
7. the complete operating boundary can be recovered within its objectives; and
8. every release and rollout decision is backed by immutable evidence.

Project Krypto is **evidence-qualified** only after it also completes PR-G4.
An unfavorable financial result can still be valid operational evidence. It
does not prove strategy value and must not be hidden, retuned, or reframed.

## 4. Scope and strict paper/live boundary

### In scope

- ETH/USDC market observations from public provider APIs.
- Structured model proposals that cannot execute trades.
- Deterministic `HOLD`, `BUY`, and `SELL` authorization.
- Simulated fills and an internal immutable paper ledger.
- Disabled, shadow, and PAPER rollout modes.
- Azure Container Apps web/Jobs, private Azure Database for PostgreSQL Flexible Server 17, Key Vault, version-pinned Foundry prompt agents, PostHog, and ACS Email production-paper operation. Vercel, Supabase, `pg_cron`/`pg_net`, and Resend remain historical/archive references only.
- Security, reliability, recovery, rollout, and evaluation evidence.

### Out of scope

- Exchange order submission.
- Wallets, custody, funding, private trading keys, or settlement.
- AgentKit or any model-accessible mutating execution tool.
- A live execution adapter.
- Real capital or capital scaling.
- Automatic promotion or safety-lock clearing.
- Strategy tuning during a declared evidence window.
- Profit guarantees.
- v3 implementation or approval.

No environment used by this scope may contain an execution-capable live
credential. Any change to this boundary requires an approved v3 RFC, a separate
PRD, security review, trading-safety review, and explicit human authorization.

## 5. Actors and RACI requirements

The same person MAY hold multiple routine roles, but the independence rules
below still apply.

| Role | Responsibility |
|---|---|
| Product owner | Owns paper-product outcomes and scope |
| Source approver | Reviews current source head and sensitive changes |
| Release manager | Owns gate sequencing and release go/no-go |
| Database operator | Executes approved migration, backup, and restore actions |
| Deployment operator | Operates the protected deployment path |
| Security approver | Approves security controls and exceptions |
| Trading-safety approver | Approves rollout risk and PAPER promotion |
| Primary/backup on-call | Acknowledges and responds to production-paper alerts |
| Evidence custodian | Verifies redaction, immutability, hashes, and indexing |
| Rollback owner | Has authority and access to invoke the absolute stop path |

Before PR-G1:

- every role MUST have a named primary and required backup;
- at least two eligible human approvers MUST exist;
- the actor requesting a target mutation MUST NOT self-approve it; and
- PAPER promotion MUST have distinct release and trading-safety approvers.

## 6. Authorization model

Authorization is separated into five decisions:

| Decision | Required authority | Does not authorize |
|---|---|---|
| Source merge | Protected source policy and current-head human approval for high-risk paths | Deployment or target mutation |
| Target mutation | Protected environment approval bound to exact evidence | Shadow or PAPER promotion |
| Shadow activation | Separate release/operator approval | PAPER promotion |
| PAPER promotion | Distinct release and trading-safety approvals | Live-money trading |
| Evidence acceptance | Human review of the complete immutable record | A favorable financial claim or v3 |

AI-generated reviews and checks MAY advise these decisions. They MUST NOT
authorize target mutation, shadow activation, PAPER promotion, break-glass use,
or v3.

Every target or promotion approval MUST bind:

- frozen release reference and commit SHA;
- immutable deployment identifier;
- environment and database system identity;
- migration and configuration fingerprints;
- evidence-manifest digest;
- intended action;
- approver identity and role;
- issue/workflow identity;
- timestamp and expiry; and
- rollback owner.

Approval expires within 24 hours and immediately when any bound value changes.

## 7. Trust boundaries

### 7.1 Source and automation

Repository content, issue text, model output, generated workflow output, and
third-party Actions are untrusted inputs. High-risk changes require current-head
human review. Automation tokens and dependencies are least privilege and
immutable.

### 7.2 Deployment

Preview, staging, and production are distinct environments. Production
mutations occur only through protected exact-artifact workflows. A moving
production alias is not sufficient provenance.

### 7.3 Database

Ownership, migration, scheduler/function ownership, runtime DML, and operator
recovery are distinct roles. Runtime cannot own application objects, migrate, read the migration ledger,
manage Container Apps Jobs, or assume privileged roles. The application uses
only runtime `DATABASE_URL`; owner and migrator connections remain ops-only.

### 7.4 Admin identity

Routine administration uses named MFA-backed identities. A shared password, if
retained, is break-glass only and independently rate-limited, alerted, rotated,
and audited.

### 7.5 Scheduler identity

Container Apps Job requests are signed, route-scoped, time-bound, nonce-bound,
release/target-bound, and replay-protected. A reusable static bearer secret is
not sufficient.

### 7.6 Model and provider data

The model proposes one structured intent and has no mutation tool. Provider
data and model output remain untrusted until deterministic validation and
authorization complete.

### 7.7 Telemetry and evidence

PostHog, logs, email, and traces are supporting evidence, not accounting truth.
The immutable trade ledger and deterministic replay remain authoritative.
Telemetry failure cannot turn an error into success or alter paper state.

### 7.8 Live execution

The paper runtime has no route, adapter, credential, wallet, or tool that can
move real funds.

## 8. Normative control requirements

The focused issues below are the implementation and proof records for this
contract.

| ID | Requirement | Issue |
|---|---|---|
| SRC-01 | Trusted source governance and CI/CD supply-chain controls | [#131](https://github.com/The-weyland-yutani-corporation/project-krypto-dog/issues/131) |
| DEP-01 | Protected exact-SHA target mutations and deployment provenance | [#126](https://github.com/The-weyland-yutani-corporation/project-krypto-dog/issues/126) |
| IAM-01 | MFA-backed admin identity and controlled break-glass access | [#129](https://github.com/The-weyland-yutani-corporation/project-krypto-dog/issues/129) |
| M2M-01 | Signed, scoped, replay-protected, rotatable cron requests | [#128](https://github.com/The-weyland-yutani-corporation/project-krypto-dog/issues/128) |
| DB-01 | Separate database owner, migrator, scheduler, and runtime roles | [#133](https://github.com/The-weyland-yutani-corporation/project-krypto-dog/issues/133) |
| RUN-01 | Bounded deadlines, readiness, capacity, region, and provider budgets | [#132](https://github.com/The-weyland-yutani-corporation/project-krypto-dog/issues/132) |
| OPS-01 | Independent safety alerts, SLOs, incident evidence, and on-call | [#125](https://github.com/The-weyland-yutani-corporation/project-krypto-dog/issues/125) |
| REC-01 | Full-stack recovery, RPO/RTO, restore, and retention | [#134](https://github.com/The-weyland-yutani-corporation/project-krypto-dog/issues/134) |
| SAFE-01 | Absolute stop fence for in-flight paper commits | [#135](https://github.com/The-weyland-yutani-corporation/project-krypto-dog/issues/135) |
| ACCT-01 | Ledger, cost-basis, DCA, and anchor attestation | [#130](https://github.com/The-weyland-yutani-corporation/project-krypto-dog/issues/130) |
| ROLL-01 | Attended PAPER promotion and 30-day continuity gate | [#127](https://github.com/The-weyland-yutani-corporation/project-krypto-dog/issues/127) |

DB-01's design and source implementation is
[ADR 0014](./decisions/0014-postgresql-trust-boundary-roles.md); its
Consequences section is the required attended per-environment upgrade
procedure and #76 evidence contract. Source implementation alone does not
satisfy DB-01 — the ADR performs no live role migration.

### RUN-01 bounded synchronous execution

Production PAPER runs target Azure Container Apps plus private PostgreSQL 17 and MUST satisfy [ADR 0015](./decisions/0015-bounded-synchronous-execution.md):

- provider time budgets aggregate to `125 s`: Coinbase `20`, version-pinned Foundry `80`, ACS `20`, PostHog `5`;
- app absolute deadline `180 s` < scheduler HTTP `210 s` < ACA ingress platform bound `240 s` < scheduler job replica `270 s` < owned lease `300 s`;
- the app partition is provider `125 s`, DB policy/execution `20 s`, terminal persistence/owned-lease release `15 s`, cancellation/response `10 s`, and slack `10 s`;
- both scheduled jobs have `replicaRetryLimit=0`; one-attempt scheduling is backed by idempotency defense in depth;
- manual migration, preflight, backup, target-smoke, and activation-check jobs remain outside the trading deadline/lease chain and keep long-running operation-specific timeouts;
- web maximum replicas are `3`, with database pool `1` and admitted run `1` per replica; the runtime login has `CONNECTION LIMIT 20`;
- runtime database timeouts are connect `5 s`, statement `10 s`, lock `2 s`, and idle in transaction `15 s`;
- liveness is dependency-free; readiness is four-second bounded, non-mutating, provider-free, uses runtime `DATABASE_URL` only, proves release/image/config, PostgreSQL 17 login/membership/denials/connection limit, schema fingerprint, singleton reconciliation, lease sanity, rollout mode, and admission, and returns only opaque reason codes; and
- migration `0009` persists immutable `AgentRun.deadlineAt`, publishes a runtime-readable schema fingerprint while denying the migration ledger, and enforces a deferred PAPER-only no-commit-at/after-deadline fence.

Daily application safety ceilings are Coinbase `1,000`, version-pinned Foundry `200`, PostHog `2,000`, and ACS `100` requests per UTC day. Engineering owns the application/runtime contract; release/operator owns provider-plan, quota, rate-limit, and cost reconciliation before rollout; operator owns deadline/budget/capacity alert response. Exhaustion MUST persist a no-trade condition and alert rather than execute or return a success-shaped trade fallback.

Source implementation does not satisfy RUN-01 target proof. No issue #132 live Azure evidence is claimed. The exact future release MUST separately index source/CI and target timing, region, capacity, readiness, PostgreSQL runtime identity/timeouts, quota/cost, fault, terminal-run, PAPER deadline-fence, and lease evidence in issue #76. RUN-01 remains PAPER-only and adds no live execution capability.

The existing release issues own the gate records:

| Gate record | Issue |
|---|---|
| NULL-safe cron migration | [#72](https://github.com/The-weyland-yutani-corporation/project-krypto-dog/issues/72) |
| Node 22/PostgreSQL 17 build and integration matrix | [#73](https://github.com/The-weyland-yutani-corporation/project-krypto-dog/issues/73) |
| Disabled target attestation and smoke | [#74](https://github.com/The-weyland-yutani-corporation/project-krypto-dog/issues/74) |
| 72-hour shadow window | [#75](https://github.com/The-weyland-yutani-corporation/project-krypto-dog/issues/75) |
| Canonical evidence and go/no-go index | [#76](https://github.com/The-weyland-yutani-corporation/project-krypto-dog/issues/76) |

## 9. Gate-wide rules

All gates are fail closed.

Gate mapping to RFC 0002: PR-G1 corresponds to RFC Gate 0, PR-G2 to RFC
Gate 1, PR-G3 to RFC Gate 2, and PR-G4 to RFC Gate 3. PR-G0 adds the trusted
source prerequisite required before the RFC rollout gates.

- Evidence from an older gate MAY be reused only when every bound identity and
  fingerprint remains unchanged and the evidence has not expired.
- Missing, stale, expired, contradictory, or unverified evidence blocks the
  gate.
- No screenshot or mutable narrative is sufficient release evidence.
- Secrets and raw credentials MUST NOT be stored in reports, issues, logs, or
  repository content.
- A declared observation window is a UTC half-open interval `[start, end)`.
- Scheduled and manual runs are never deleted or excluded after observation.
- A failed window is retained and clearly classified.
- Promotion is never automatic.

The rollout unit is a frozen release artifact/ref and immutable deployment, not
the moving `main` tip. Unrelated changes to `main` do not invalidate a running
window when the deployed artifact and all attributed configuration remain
unchanged.

The following changes invalidate approval and restart the applicable window:

- deployed artifact or deployment;
- target database or system identity;
- migration history or canonical function definition;
- strategy, model deployment, or prompt/decision schema;
- fee, slippage, cost, or accounting model;
- risk or safety parameters;
- rollout schedule or mode;
- bound environment configuration;
- authentication key or signer; or
- evidence schema or data transformation that changes interpretation.

## 10. PR-G0: trusted source

### Entry

- The current safe posture is rollout disabled and cron unscheduled.
- The release candidate is identified but not approved for target mutation.

### Exit

- [#72](https://github.com/The-weyland-yutani-corporation/project-krypto-dog/issues/72)
  and [#73](https://github.com/The-weyland-yutani-corporation/project-krypto-dog/issues/73)
  are complete against the exact merged source SHA.
- SRC-01 is complete.
- Required CI, database, security, and trading-safety checks pass on the final
  head and post-merge protected `main`.
- Source evidence is indexed in issue #76.

PR-G0 does not authorize a target mutation.

## 11. PR-G1: disabled target

### Entry

- PR-G0 is complete.
- DEP-01, IAM-01, DB-01, REC-01, and ACCT-01 are complete.
- Required implementation portions of M2M-01 and RUN-01 are complete.
- The target-mutation approval is current.

### Required sequence

1. Bind the frozen artifact, deployment, target, migration, and configuration.
2. Run read-only target inventory and preflight.
3. Confirm zero active Krypto cron, zero queued Krypto HTTP work, no unsafe
   lease, and no unresolved position/accounting condition.
4. Verify RPO/RTO backup and clean-target restore evidence.
5. Apply migration/init through the protected migrator lane with rollout
   disabled.
6. Configure reviewed provider, admin, Key Vault, and telemetry values without
   scheduling cron.
7. Run post-migration preflight and exact-deployment disabled smoke.
8. Observe the disabled target for 30 minutes with independent monitoring.

### Exit

- Target identity, runtime/migrator identities, PostgreSQL version/extensions,
  migration history, canonical functions, configuration digest, and deployment
  identity match the approval.
- Preflight reports zero blockers.
- Smoke proves auth, mode binding, database binding, providers, daily email,
  admin access, no trade mutation, no active cron, no queued work, and lease
  release.
- During observation:
  - readiness remains healthy;
  - Krypto cron and queues remain empty;
  - no active lease remains;
  - trade count does not change;
  - no unexpected scheduled AgentRun appears; and
  - no unexplained error or alert remains.
- The complete redacted evidence is indexed in issue #76.

PR-G1 does not authorize shadow.

## 12. PR-G2: 72-hour shadow

### Entry

- PR-G1 is complete.
- M2M-01, RUN-01, OPS-01, and SAFE-01 are complete on the target.
- A distinct shadow activation approval is current.
- The shadow window and expected schedule are declared before activation.

### Window

- Duration: exactly 72 hours.
- Expected hourly slots: 72.
- Minimum terminal scheduled runs:

  ```text
  ceil(0.95 * 72) = 69
  ```

- No two consecutive hourly slots may remain unexplained.
- Manual/admin runs are excluded from the scheduled denominator but remain in
  evidence and review.
- An exact 72-hour window normally contains three daily-summary schedule slots.
  Every expected slot must be terminal and `sent`, including at least two
  consecutive sent deliveries.

### Exit

- At least 69 scheduled runs are terminal and persisted.
- Every gap, error, provider failure, proposal, authorization, journal, manual
  run, and alert is classified.
- Shadow creates zero `TradeExecution` rows and no balance/cost-basis mutation.
- Accounting remains reconciled.
- No stale/overlapping lease, duplicate run, auth/provenance mismatch, queue
  residue, or unresolved alert remains.
- The absolute-stop rollback rehearsal succeeds and proves no commit after stop
  acknowledgment.
- The completeness and rollback reports are indexed in issue #76.
- Distinct humans make the PAPER go/no-go decision; no automatic promotion
  occurs.

Any attributed change restarts PR-G2.

## 13. PR-G3: attended PAPER promotion

### Entry

- PR-G2 is complete.
- REC-01, OPS-01, SAFE-01, and ACCT-01 are current.
- Fresh preflight, recovery proof, and accounting attestation pass.
- Distinct release and trading-safety approvals are current.
- A primary/backup 24-hour coverage roster and rollback owner are active.

### Evidence-window boundary

The evidence window begins immediately before the first PAPER-capable
invocation. An attended validation before that boundary MUST be provably
non-executing.

The baseline records:

- immutable ledger checkpoint;
- starting equity and balances;
- trade/run counts;
- open paper position;
- cost basis and DCA state;
- reference/last-buy/peak anchors and observation times; and
- complete attributed configuration.

### Exit

- The exact approved deployment enters PAPER with cron still disabled.
- The first invocation is attended.
- Its hold or execution is immediately reconciled before cron activation.
- Cron is enabled only through the approved fixed-path operation.
- Named responders cover the first 24 hours and acknowledge all alerts.
- A production-equivalent isolated drill proves absolute stop with an open
  paper position, preserved ledger/position truth, and reconciled or
  quarantined state without a fabricated flattening trade.
- Promotion and 24-hour evidence are indexed in issue #76.

PR-G3 authorizes only the declared paper ledger.

## 14. PR-G4: 30-day continuity and evaluation

### Entry

- PR-G3 is complete.
- The 30-day UTC window is declared before its first PAPER-capable invocation.
- Artifact, deployment, target, configuration, schedule, and evidence schema
  are frozen.

### Window

- Duration: exactly 30 calendar days.
- Expected hourly slots: 720.
- Minimum terminal scheduled runs:

  ```text
  ceil(0.95 * 720) = 684
  ```

- No unexplained consecutive misses remain.
- All scheduled and manual runs remain in the dataset.

### Exit

- At least 684 scheduled runs are terminal and persisted.
- Every run, gap, incident, proposal, authorization, journal, alert, and trade
  is retained and classified.
- Every execution reconciles.
- No unresolved safety incident remains.
- Attribution remains unchanged for the complete window.
- The exact-window evaluation required by `evaluation.md` is complete,
  checksum-addressed, and indexed in issue #76.
- Humans record operational-readiness and strategy-evidence decisions
  separately.

A negative financial result does not erase the window. It may prevent the
strategy from satisfying the financial gate in `readiness.md`; it does not
justify cherry-picking, post-hoc tuning, or a live-money claim.

## 15. Evidence and provenance

Issue #76 is the passive canonical index. It does not authorize or execute a
mutation.

Each evidence artifact MUST record:

- schema/version;
- creation time;
- source commit and frozen release ref;
- workflow/run or operator action;
- immutable deployment;
- target identity;
- migration/configuration fingerprints;
- control/gate;
- redaction classification;
- checksum or attestation;
- author/approver identity and role where applicable; and
- expiry or retention class.

Artifacts MUST be independently verifiable without exposing secrets.
Engineering fixtures MUST remain labeled engineering-only. Provider,
historical, target, and financial evidence MUST not be conflated.

### Exact issue #76 evidence matrix

Issue #76 requires the following exact evidence categories for the frozen release candidate:

- Frozen source ref, merge SHA, protected-main checks, and source-governance policy version.
- Explicit distinction between AI/check authorization, human source approval, target-mutation approval, shadow approval, and PAPER approval.
- Node/npm/PostgreSQL server/client version proof.
- Migration inventory, hashes, drift result, database role/ownership matrix, and runtime/migrator separation.
- Target identity, immutable deployment ID, configuration digest, readiness result, and preflight.
- Provider/application backup checksums, RPO/RTO restore proof, and retention policy.
- Admin and cron authentication control evidence.
- Exact-deployment disabled smoke and 30-minute observation.
- Shadow completeness, zero-trade proof, expected daily summaries, alerts, classified gaps, and rollback rehearsal.
- PAPER promotion approvals, first-run reconciliation, 24-hour attended coverage, and stop-drill evidence.
- Predeclared 30-day continuity and exact-window evaluation report.
- Clear classification of engineering fixtures versus historical, target, and financial evidence.

For RUN-01, source/CI evidence includes the exact merge/checks, runtime matrix, migration `0009` hash/drift, constants/configuration, and deterministic deadline/retry/cancellation/pool/lock/budget/readiness tests. Future target evidence includes the immutable ACA deployment and private PostgreSQL 17 identity, live duration/capacity/timeouts/readiness, provider plan/quota/cost reconciliation, exhaustion alerts, terminal persistence, owned-lease cleanup/expiry, and PAPER deadline fence. The future package does not exist merely because this PRD or source implementation exists.

One canonical issue/comment thread must index every gate and artifact. Every artifact must be immutable or checksum-addressed and bound to the exact artifact, deployment, target, migration, configuration, actor, and timestamp it proves. Missing, stale, expired, or contradictory evidence is blocking, and synthetic/engineering evidence must never be presented as production-performance evidence.

## 16. Absolute stop and rollback

The product distinguishes optional-trade pause from absolute halt.

### Absolute-stop invariant

After stop acknowledgment:

- no new run may acquire a lease;
- no invocation authorized under an older stop fence may commit;
- no delayed/replayed request may mutate state;
- Container Apps Job schedules and in-flight scheduler work are disabled/drained;
- active ownership is safely resolved; and
- all evidence is preserved.

The transactional executor MUST recheck the current monotonic stop fence
immediately before commit.

### Stop triggers

The stop path is invoked for:

- any shadow trade;
- reconciliation, ledger, cost-basis, or anchor mismatch;
- duplicate or unauthorized execution;
- deployment/target/configuration/mode/auth mismatch;
- unsafe/stale market data;
- unsafe lease or queue state;
- migration/function drift;
- credential concern;
- unacknowledged critical alert or loss of required monitoring;
- recovery-objective breach; or
- operator trading-safety concern.

An open paper position is preserved and reconciled or quarantined. Rollback
MUST NOT fabricate a flattening trade or reset/delete ledger history.

After a stop, the current window is invalid. Re-entry requires remediation,
fresh preflight, fresh evidence-bound approval, and a new declared window.

## 17. Recovery and retention

The production-paper boundary MUST meet:

- **RPO <= 1 hour**
- **RTO <= 4 hours**

Recovery includes:

- application data and immutable paper evidence;
- migrations and canonical functions;
- database ownership, roles, grants, and extensions;
- Key Vault secret-reference and Container Apps Jobs reconstruction definitions without exporting secret values;
- deployment/environment configuration;
- frozen release provenance; and
- disabled scheduling/readiness verification.

Restore completes into a clean isolated target. Cron remains disabled until
post-restore preflight and exact-deployment smoke pass.

Retention rules MUST preserve:

- the active and all failed evaluation windows;
- source/deployment/approval evidence;
- accounting and incident evidence needed for deterministic replay; and
- backups required to meet the recovery objectives.

No retention job may prune current ledger truth or canonical issue #76
evidence.

## 18. Operational success measures

| Measure | Required result |
|---|---|
| Source trust | High-risk merge cannot pass on AI/self/stale approval alone |
| Target trust | Wrong/stale artifact, target, config, key, or approval is rejected |
| Shadow mutation | Zero trades and zero balance/cost-basis mutation |
| Shadow completeness | At least 69/72 terminal scheduled runs |
| Daily summary in shadow | Every expected slot terminal and sent |
| PAPER continuity | At least 684/720 terminal scheduled runs |
| Accounting | Every execution reconciled; mismatch quarantines |
| Stop | Zero commits after stop acknowledgment |
| Recovery | RPO <= 1 hour and RTO <= 4 hours |
| Alerting | Critical test alerts delivered, acknowledged, escalated, and linked |
| Evidence | Every gate artifact immutable/checksum-addressed and indexed |
| Live boundary | No real-fund capability or credential present |

Financial metrics and acceptance remain governed by `evaluation.md` and the
current gate disposition in `readiness.md`.

## 19. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Policy prose differs from executable GitHub controls | SRC-01 and governance attestation |
| Production alias moves after smoke | DEP-01 immutable deployment binding |
| Shared admin or cron credential leaks | IAM-01 and M2M-01 |
| Runtime holds migration/owner privilege | DB-01 |
| Provider retries exceed request/lease budget | RUN-01 absolute deadline |
| App cannot alert on its own absence | OPS-01 external missing-run monitor |
| Trade commits after operator stop | SAFE-01 monotonic transaction fence |
| Materialized state hides ledger drift | ACCT-01 deterministic replay |
| Backup omits roles/configuration | REC-01 full-boundary restore |
| Active factory changes `main` during a window | Frozen artifact/deployment attribution |
| Positive short window is overstated | PR-G4 predeclaration and evidence classification |

## 20. Dependency map

```text
#72 + #73 + SRC-01
          |
          +--> DEP-01 --> M2M-01
          |       |
          |       +--> DB-01 --> RUN-01 --> OPS-01
          |                    |          |
          |                    +--------> SAFE-01
          |                    |
          |                    +--------> ACCT-01
          |
IAM-01 ---+--> REC-01

completed source/control evidence
          |
          +--> #74 / PR-G1
                  |
                  +--> #75 / PR-G2
                          |
                          +--> ROLL-01 / PR-G3 + PR-G4
                                      |
                                      +--> final #76 review
```

Issue #76 starts early and remains open as the evidence index. Gate checks
depend on completed sections and artifact digests, not on closing #76, avoiding
a dependency cycle.

## 21. ADR and RFC policy

Implementation issues identify the required decisions:

- source/AI trust and review model;
- deployment environments and immutable promotion;
- admin identity;
- machine-to-machine cron authentication;
- database ownership and role topology;
- runtime/worker/deadline boundary;
- absolute stop semantics;
- recovery objectives and boundaries; and
- retention or telemetry vendor choices where durable dependencies are added.

Those ADRs are created or amended with the implementing change, not this PRD.
RFC 0002 remains Draft design context until the production-paper gates are
complete. Nothing in this PRD advances the v3 RFC.

## 22. Change control

A new PRD version and release/trading-safety approval are required to change:

- the paper/live boundary;
- authorization independence;
- gate ordering;
- window durations or completeness thresholds;
- absolute-stop semantics;
- recovery objectives; or
- accounting/evidence authority.

Behavior changes update `prd.md`. Procedures update `deployment.md`. Signals
and response instructions update `monitoring.md`. Metric formulas update
`evaluation.md`. Current observations update `readiness.md`.

This PRD never carries mutable test totals, coverage percentages, issue counts,
provider inventory, row counts, or current gate results.

## 23. Non-authorization statement

Merging this document, creating its issues, or completing an implementation
ticket authorizes no production action by itself. The safe default remains:

- rollout mode `disabled`;
- Krypto cron unscheduled;
- no queued Krypto HTTP work;
- no target mutation without protected approval; and
- no live-money capability.
