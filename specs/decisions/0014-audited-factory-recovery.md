# 0014 -- Audited, capability-scoped factory recovery

- **Status:** Proposed
- **Date:** 2026-08-19
- **Deciders:** TBD -- human architecture owner

> **Proposal only.** This ADR authorizes no implementation, workflow change,
> activation, recovery, deployment, or architecture acceptance. Acceptance and
> unpause remain explicit human decisions.

## Context

[ADR 0013](./0013-autonomous-agentic-sdlc-factory.md) defines a global
`shadow` / `active` / `paused` control and legal lifecycle transitions. The
[factory contract](../agentic-factory-contract.md), deterministic
[policy core](../../.github/scripts/agentic-factory-policy.cjs), and current
[full E2E workflow](../../.github/workflows/agentic-factory-full-e2e.yml) use
that control to exercise one canary through exact-SHA dev evidence.

Recovery needs a narrower authority model. A global `active` label can be
observed by unrelated queue, merge, or deployment runs. Finalizers are not
guaranteed, GitHub mutations are not transactional, issue comments are mutable,
and the existing transition helper permits an omitted actor. An expired claim,
uncertain assignment dispatch, duplicate PR, or failed post-merge dev run must
therefore not be repaired by relabeling and retrying from stale observations.

The recovery boundary remains the existing paper-only boundary. It must not
create authority for production, live trading, secrets, architecture
acceptance, or a wider goal, path, risk, concurrency, or assignment budget.

## Decision

If accepted, factory canary activation and recovery will use the following
contract.

### 1. Issue-scoped activation capability

Scheduled E2E automation may create and validate a **prepared canary** and may
report its state. It may not activate the factory, issue an activation
capability, dispatch work, retry deployment, or unpause anything.

A prepared-canary record contains:

- canary issue and approved parent-goal numbers;
- a preparation nonce and the preparing workflow run;
- the one exact allowed path
  (`docs/e2e/factory-full-heartbeat.md`) and its digest;
- milestone, `risk:routine`, `max_wip: 1`, remaining assignment budget, and a
  digest of the goal authorization fields; and
- creation and expiry timestamps.

Only a trusted human (§3), through a manual recovery/activation entry point,
may issue a non-renewable activation capability. The capability is bound to
the prepared-canary record, goal, preparation nonce, expected claim nonce,
exact allowed path, permitted actions, issuer, issue time, and expiry. Its
maximum lifetime is six hours. It authorizes one canary issue and consumes at
most one assignment-budget unit; it is not a repository-wide bearer token.

Every mutating component -- queue claim, assignment dispatch, session creation,
PR enrollment, merge authorization/enablement, dev dispatch, and lifecycle
advancement -- must compute effective mode immediately before acting:

| Observation | Effective mode |
|---|---|
| Control is `shadow` | `shadow`; advisory/read-only |
| Control is `paused`, missing, or ambiguous | `paused`; deny |
| Control is `active`, but no unique valid matching capability exists | `paused`; deny |
| Capability is expired, terminal-failure, malformed, or mismatched, or its claim is tombstoned | `paused`; deny |
| Control is `active` and the capability, issue, action, goal, nonce, path, risk, WIP, and budget all still match | `active` for that issue and action only |
| The canary has a verified terminal-success record | `shadow` |

The raw `factory-mode:active` label is never sufficient authority. Unrelated
issues and actions always resolve to denied/paused while an issue-scoped
capability is active. Goal approval and all goal fields are re-read; a digest
match does not substitute for current approval.

Expiry is evaluated from the capability timestamp on every entry point and
denies action without any finalizer or watchdog. A watchdog may later
materialize `factory-mode:paused`, but safety does not depend on that write.

Terminal success uses an explicit commit order so effective `shadow` cannot
block its own materialization:

1. while the capability remains active, verify exact-SHA dev evidence and write
   a nonterminal `success-prepared` record;
2. perform every remaining capability-authorized lifecycle, issue-close, and
   label mutation, including `factory:deployed-dev -> factory:done`; the
   control-label replacement from `active` to `shadow` is the final mutation in
   this step;
3. re-read and post-verify all those mutations; then
4. write and mirror `terminal-success` as the final commit point.

`terminal-success` is never written before step 3, and no lifecycle or label
write may follow it. The narrowly scoped `commit-terminal-success` action may
write only that record while the already-verified control label is `shadow`;
it is bound to the same nonexpired capability, `success-prepared` record, and
idempotency nonce and grants no queue, merge, deployment, or label authority.
The canary is successful only after all terminal-record mirrors verify. If that
last write fails, the canary is not successful, but the verified control state
is already safely `shadow`; retry may only use the same nonce after a fresh
human authorization. Any earlier partial completion is a paused failure.

### 2. Authoritative claim and tombstone records

Claims, activation capabilities, dispatch receipts, recovery decisions, and
tombstones use one versioned record family. Records are ordered per
`(issue, claimNonce)` by an explicit sequence and link to the predecessor
digest. The authoritative state is reconstructed from the complete mirrored
lineage (§7), never from the mutable latest issue comment. For an issue with
evidence of a prior claim, missing records or mirrors, duplicate sequence
numbers, broken links, conflicting tips, or an unreadable source fail closed.
A provably virgin issue may have no claim lineage; post-queue labels (lifecycle
states at or after `factory:claimed`, explicitly excluding pre-claim
`ready-for-ai-dev`), assignees, dispatch receipts, or correlated PRs make it
non-virgin.

A positive terminal tombstone is terminal for its claim nonce. It names the
terminal assignment runs and supersedes, rather than edits or deletes, the
prior claim. A new claim must use a new nonce and may be created only after the
issue legally returns to `ready-for-ai-dev` **and** every prior claim nonce in
the mirrored lineage ends in a valid positive terminal tombstone.

Before a stale or uncertain claim may be tombstoned and requeued, recovery must
prove that every assignment workflow run correlated to the original claim
nonce is identified and terminal. An absent, queued, in-progress, or
unresolvable run is not terminal proof and leaves the issue blocked.

Queue claimability must resolve the complete mirrored lineage before it
examines lifecycle labels. A missing or edited claim marker, or evidence of a
prior claim whose lineage lacks a positive terminal tombstone, is an
independent blocking fence. Moving `blocked -> ready-for-ai-dev`, removing an
assignee, or changing any lifecycle label does not clear it.

The assignment workflow must resolve that lineage again immediately before
creating a coding-agent session. A terminal tombstone, expired/mismatched
activation capability, changed lifecycle state, missing/edited lineage mirror,
or ambiguous read exits without session creation. This downstream fence is
required even when the original assignment run is already reported terminal.

### 3. Deterministic trusted-human authorization

Recovery is available only through `workflow_dispatch`. The deterministic
authorizer must receive, never infer or omit:

- the triggering actor's login, stable user ID, and `User` type;
- the requested recovery kind and idempotency nonce;
- issue, goal, preparation, activation, and claim identifiers;
- canonical PR/head/merge SHA when applicable; and
- the actor's current repository permission.

Authorization succeeds only when the triggering actor is in a human-maintained
`recoveryOperators` allow-list in boundary policy, has current `maintain` or
`admin` permission, and all requested identifiers match current state. A rerun
revalidates `github.triggering_actor`; bot/app identity, `actor.type === User`
alone, an omitted actor, or a stale authorization is insufficient.

The transition policy must reject a missing actor for every lifecycle
transition. Recovery uses the distinct authorized principal
`trusted-human-recovery`; merely passing that string is insufficient without
the authorizer's structured proof. This principal grants no production,
live-trading, secrets, architecture-acceptance, or unscoped unpause authority.

### 4. Actor-aware transition resolution

Normal and recovery transitions are separate deterministic sets:

- normal transitions remain keyed by `(from, to, actor)`; resolution collects
  **all** exact and wildcard matches and authorizes only a match whose owner
  equals the required explicit actor; and
- recovery transitions are keyed by
  `(recoveryKind, from, to, actor)` and additionally require the corresponding
  structured recovery proof. A recovery request never falls back to the normal
  or wildcard set.

There is no first-match resolution. In particular, the existing specific
normal edge `ready-for-human-review -> blocked` owned by `human-operator` and
the wildcard `* -> blocked` owned by `lifecycle-reconciler` both remain legal:
the explicit actor deterministically selects the matching owner. Neither edge
shadows the other.

The recovery-only set contains exactly:

| Recovery kind | From | To | Required actor | Required proof |
|---|---|---|---|---|
| `claim-requeue` | `blocked` | `ready-for-ai-dev` | `trusted-human-recovery` | Terminal original assignment runs plus positive tombstone (§2) |
| `duplicate-pr` | `blocked` | `factory:pr-open` | `trusted-human-recovery` | Issue-wide duplicate proof (§5) |
| `post-merge-dev` | `blocked` | `factory:merged` | `trusted-human-recovery` | Merge proof plus retry reservation (§6) |

`blocked -> factory:pr-open` and `blocked -> factory:merged` exist only in this
recovery set and only for `trusted-human-recovery`. Fail-closed transitions
from `factory:claimed`, `factory:implementing`, `factory:pr-open`,
`factory:repairing`, `ready-for-human-review`, or `factory:merged` to
`blocked` continue to use the normal wildcard reconciler edge; the specific
human edge above also remains available for its normal use.

When mirrored lineage shows any prior claim, a requested
`blocked -> ready-for-ai-dev` transition is deterministically classified as
`claim-requeue`; it cannot be presented as an ordinary human unblock to bypass
the recovery proof.

There is no recovery transition directly to `factory:implementing`,
`factory:deployed-dev`, or `factory:done`. Requeue uses a new claim and normal
dispatch. Duplicate recovery resumes exact-head checks from `factory:pr-open`;
boundary work then follows the normal `ready-for-human-review` path.
Post-merge recovery resumes only at the already-proven merge SHA.

Any other recovery transition, wrong actor, failed precondition, or partial
mutation leaves the issue `blocked` and effective mode paused.

Making a missing actor denied is a coupled migration requirement: every
existing reconciler, queue, merge, emergency-block, and composite-transition
call must thread its explicit actor through every hop before the deny rule is
enabled. An omitted actor is never interpreted from call-site context.

### 5. Duplicate-PR recovery

A trusted human may nominate one canonical PR only after a complete,
issue-scoped proof. The candidate set is the deduplicated union of:

- every PR in every state carrying an exact reference to the issue (native
  closing/cross-reference metadata or an anchored `Refs #N` reference that
  cannot match another issue number); and
- every PR recorded anywhere in the issue's mirrored lineage across **all**
  prior and current claim nonces.

Every candidate is re-read directly after complete pagination. The exact issue
reference defines proof scope; the nominated claim nonce identifies only the
canonical candidate and never filters the issue-wide set. Recovery then proves:

1. the canonical PR is still open and unmerged at the exact recorded head;
2. its same-repository/base, claim marker, goal, allowed-path, and risk
   provenance are valid;
3. every noncanonical PR, under any prior or current nonce, is closed and
   unmerged; and
4. no PR under any noncanonical prior or current nonce has ever merged.

Together with the canonical open/unmerged proof, these predicates prove that
no PR in the issue-wide set under any prior or current nonce has ever merged.
An API/read ambiguity, an open noncanonical PR, or any noncanonical merge keeps
the issue blocked and the factory paused. Duplicate recovery never merges the
canonical PR and never reuses checks from another head. After the legal
transition, all required checks and any current-head boundary approval are
evaluated normally against the canonical PR's exact current head.

### 6. Post-merge dev recovery

Paused mode is read-only for deployment and evidence state. It permits no
autonomous or human-triggered deploy exception. A dev retry requires a fresh,
trusted-human-issued capability whose actions are limited to the exact issue,
merge SHA, `dev-retry`, and subsequent `evidence-reconcile`; unrelated queue,
merge, and deploy actions remain denied.

The trusted human must first perform the human-only control transition to
`active` and issue that capability. A capability is inert while the control
remains `paused`; neither dev retry nor evidence advancement can occur there.

Before reserving the single retry, recovery must prove all of the following:

1. canonical claim provenance from prepared canary through activation, claim,
   assignment run, issue, and canonical PR;
2. the complete required-check set succeeded on the exact pre-merge PR head;
3. any applicable `Human boundary approval` was trusted, current, and for that
   exact head;
4. the merge was authorized for its tier (merge-policy authorization for
   routine/sensitive work, or a trusted-human merge for boundary work);
5. the PR is merged and its exact merge SHA is present on the default branch;
6. the original dev run ID is correlated to that merge SHA and has a terminal
   non-success conclusion; missing evidence alone is not proof of a failed
   run; and
7. the durable retry ledger for `(issue, canonical PR, merge SHA, dev-retry)`
   is still `unused`.

The ledger transition `unused -> reserved` is persisted and post-verified
before dispatch. `reserved` consumes the only retry if dispatch outcome is
unknown; it cannot be reset to manufacture another attempt. The same
idempotency nonce may observe or reconcile the existing attempt but may not
dispatch it again. A terminal retry failure leaves the item blocked with no
second retry.

The trusted human explicitly dispatches the dev retry while the scoped
capability is valid. Evidence reconciliation then re-reads the deployment,
statuses, required evidence paths, and release SHA. Only successful evidence
for the exact merge SHA permits the normal
`factory:merged -> factory:deployed-dev -> factory:done` sequence, followed by
§1's terminal ordering and verified return to `shadow`. If the capability
expires first, reconciliation is read-only until a human issues a
reconcile-only capability and performs the human-only control transition to
`active`; that capability cannot dispatch a deployment or reset the retry
ledger.

### 7. GitHub mutation and audit protocol

GitHub writes are a fail-closed, idempotent saga, not a transaction:

1. derive a stable operation nonce from the recovery kind and bound
   issue/goal/claim/PR/SHA identifiers;
2. perform trusted-human authorization and a fresh pre-mutation read of every
   predicate;
3. reserve the nonce/ledger before an external dispatch;
4. replace the complete label set in one API request where available,
   preserving the freshly read unrelated labels;
5. apply the remaining mutation;
6. re-read and verify labels, records, PR/run state, and digests; and
7. on any partial, concurrent, or unverifiable result, compensate by blocking
   the issue and making effective mode paused. Never silently restore queue
   eligibility or retry with a new nonce.

The single label-replacement request reduces intermediate states but is not
claimed to be compare-and-swap. Pre-read and post-verification detect
concurrent changes; they do not make GitHub transactional.

Each structured operation record is mirrored with the same canonical JSON
digest and predecessor digest in multiple GitHub sources: the work issue, the
factory-control audit trail, and a workflow-run artifact or exact-SHA check
record as applicable. Dispatch and retry records include their workflow run
IDs. A mismatch, missing mirror, edit, deletion, or broken digest chain is
tamper evidence and blocks further action.

Comments, check records, and artifacts are not described as immutable or
tamper-proof. The mirrors and digest chain make unexpected mutation detectable;
they do not provide CAS or atomic commit.

### 8. Preserved boundaries

- Paper trading remains the only execution mode. No recovery path can enable
  live execution or move money.
- Dev evidence remains exact-SHA. Production deployment, production schedule
  activation, live trading, secrets/external accounts, architecture
  acceptance, and unpause remain human-only.
- Current goal approval, milestone, allowed path, path-derived risk floor,
  required checks, WIP, assignment budget, repair cap, and human veto are
  revalidated and may only narrow recovery.
- A successful canary consumes its capability and returns the factory to
  `shadow`. No scheduled job may reactivate it.

### 9. Coupled full-E2E replacement

This ADR must not be marked Accepted, and capability-scoped recovery must not
be enabled, unless one reviewed rollout also neutralizes or replaces the
current active-label-only full E2E path. There is no compatibility window in
which both authorization models may dispatch.

The scheduled branch of `agentic-factory-full-e2e.yml` must become
prepare/read/report-only and must not invoke the queue controller, create a
session, enable merge, dispatch dev, or reuse a previously issued capability.
Any manual execution path must require the issue-scoped capability described
here. Coupled tests must prove that `factory-mode:active` by itself cannot
advance the current workflow or any downstream mutator. Disabling the schedule
without removing the active-label-only manual bypass is insufficient.

Until that coupled change is reviewed and deployed, the present workflow is
not a conforming implementation of this proposal and no capability-scoped
canary may be activated.

## Consequences

- **Positive:** Activation cannot dispatch unrelated work, and lease expiry
  denies action even when cleanup never runs.
- **Positive:** Tombstones fence late session creation, while duplicate and
  post-merge recovery require complete, exact-state proof.
- **Positive:** One durable retry and idempotent saga semantics bound ambiguous
  GitHub failures without claiming transactional guarantees.
- **Trade-off:** Recovery requires trusted-human attention and multiple
  independent reads; ambiguous historical runs or PRs remain blocked.
- **Trade-off:** A successful dev retry may wait for a separate
  reconcile-only capability if its activation lease expires.
- **Follow-up if accepted:** In one coupled first rollout, update ADR 0013's
  contract, transition authorizers and explicit-actor call sites,
  queue/assignment/lifecycle/deployment adapters, record-lineage resolver, the
  full E2E workflow, audit records, and tests. Partial activation is forbidden.
  This Proposed ADR itself authorizes none of that work.

## Alternatives considered

- **Keep global `active` and rely on a finalizer:** rejected; unrelated work can
  observe it, and finalizers are not guaranteed.
- **Allow autonomous deployment while paused:** rejected; it contradicts the
  paused boundary and turns recovery into an authority escalation.
- **Requeue after posting a tombstone without terminal-run proof:** rejected;
  an already-dispatched worker can still create a late session.
- **Choose a canonical duplicate after another candidate merged:** rejected;
  lifecycle labels cannot undo merged code.
- **Treat one issue comment as an immutable ledger:** rejected; GitHub comments
  are mutable and writes have no transaction/CAS guarantee.
