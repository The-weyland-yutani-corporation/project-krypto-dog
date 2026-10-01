# 0013 -- Safety-bounded autonomous agentic SDLC factory

- **Status:** Accepted
- **Date:** 2026-08-18
- **Deciders:** @VeVarunSharma
- **Amended by:** [ADR 0014](./0014-explicit-admin-merge-for-boundary-changes.md)
  for the boundary-change merge authority gate.

## Context

`docs/agentic-software-factory.md` and `.github/BACKLOG_GOVERNANCE.md` already
describe a label-driven GH-AW pipeline: discovery, triage, planning,
rubber-duck review, implementation, review, and a deterministic merge policy
that approves same-repository PRs after current-head CI and path-selected
specialist checks. That pipeline still depends on a human (or an
under-specified process) to decide, moment to moment, which `ready-for-ai-dev`
issue an implementation agent actually picks up, how many implementations run
concurrently, when a repair loop must stop, and when the factory itself should
stop dispatching work.

Two prior decisions constrain any answer:

- **ADR 0002** draws a hard line at real money movement: v1/v2 are 100% paper
  trading, and live execution requires a separate RFC, review, and human
  approval.
- **ADR 0005** establishes the pattern this ADR generalizes to the SDLC
  itself: an LLM proposes, and a small, pure, independently testable
  deterministic function authorizes. `authorizeTradeIntent` is the trading
  analogue of the queue controller and merge policy described below.
- **ADR 0008** established the exact-SHA, immutable-evidence deployment model
  (`<environment>/<release-sha>/<operation>/<job-execution-id>/report.json`)
  and that production promotion ships no executable workflow -- production
  deploys land disabled/manual and schedule activation never happens
  automatically past dev.

Project Krypto now has a deterministic policy core
(`.github/scripts/agentic-factory-policy.cjs`) and a deterministic queue
controller (`.github/scripts/agentic-queue-controller.cjs`) that implement
risk classification, required-check selection, lifecycle-state transitions,
claim/lease semantics, and eligibility ordering as pure, dependency-free
functions. What was missing was the single authoritative contract that says,
in one place and without ambiguity, what these functions are for, what
"human-approved goal" means as a machine-checkable input, and where the
factory's autonomy stops. This ADR records that contract's shape; the full
normative detail lives in
[`specs/agentic-factory-contract.md`](../agentic-factory-contract.md).

## Decision

Adopt a safety-bounded autonomous SDLC factory with the following bounds:

1. **Human-approved goals bound discovery.** No implementation work is
   selectable unless it descends from a goal that a human has explicitly
   approved (`goalApproved: true`) and whose milestone is on that goal's
   allow-list. Discovery, planning, and rubber-duck stages may keep
   proposing work outside an approved goal, but the queue controller will
   never dispatch it.

2. **A deterministic queue controller assigns exactly one eligible issue at a
   time.** `selectNextIssue` in `agentic-queue-controller.cjs` is a pure
   function: given the current candidates and the goal's authorization
   configuration, it selects at most one issue using a fixed eligibility
   check and a fixed comparator (priority, then milestone order, then oldest
   `createdAt`, then lowest issue number), and reports a structured rejection
   reason for everything else. It never calls GitHub and never guesses.

3. **Issues, native GitHub sub-issues, and explicit labels are the sole
   source of truth for lifecycle state.** There is no side-channel database
   of "what the factory thinks is happening." A work item's state is exactly
   what its labels and its parent/child issue relationships say it is.

4. **Auto-merge is available only for `risk:routine` and `risk:sensitive`
   (reversible) changes, and only after every required check has reported
   success against the exact current head SHA** -- baseline quality/CI/code
   review for every change, plus QA for sensitive work, plus any
   path-selected `Security review` / `Trading safety review`.

5. **`risk:boundary` changes always require current-head, trusted human
   approval.** They are never auto-merged, never auto-repaired (repair cap
   0), and current-head human approval is added to their required evidence.

6. **Automatic deployment stops at exact-SHA dev/staging, with fail-closed
   rollback.** This factory reuses, and does not loosen, ADR 0008's
   evidence model: a merged change may reach `factory:deployed-dev` only once
   its immutable dev evidence report is validated against the exact merged
   SHA. Missing, unreadable, or mismatched evidence is a rollback, not a
   pass.

7. **Production deployment and live trading remain human-only.** The factory
   has no authority to dispatch `azure-deploy-prod.yml`, activate a production
   schedule, or enable AgentKit live execution. The manual, environment-
   protected production deployment remains available only to a human operator.
   See `specs/agentic-factory-contract.md` §14 for the exact exclusion list.

8. **Concurrency starts at 1 and may only be raised to an evidence-gated 2.**
   A goal's `concurrencyLimit` defaults to 1 in-flight implementation.
   Raising it to 2 requires clearing an explicit evidence gate (a run of
   clean autonomous cycles with zero fail-closed escapes, zero stale-claim
   recoveries, and zero boundary misclassifications caught after the fact),
   recorded as a human-approved update to the goal's authorization fields --
   never a silent, time-based self-increase.

9. **The factory has three modes -- shadow, active, paused -- and automation
   may only ever pause itself.** In `shadow` mode the queue controller and
   merge policy run and report advisory decisions without dispatching or
   merging anything. In `active` mode they dispatch and merge within the
   bounds above. Automation may transition `active -> paused` (or
   `active -> shadow`) unilaterally when it detects one of the pause
   triggers in the contract document. Only a human operator may transition
   `paused -> active`.

## Consequences

- **Positive:** The factory's autonomy boundary is now a checkable contract
  (`specs/agentic-factory-contract.md`), not tribal knowledge spread across
  workflow YAML. `agentic-factory-policy.cjs` and
  `agentic-queue-controller.cjs` already implement the risk tiers, required
  checks, lifecycle transitions, and claim/lease semantics this ADR
  describes, so the contract can be tested, not just asserted.
- **Positive:** The claim/provenance nonce (`buildClaimNonce` /
  `buildClaimPayload`) makes "exactly one eligible issue is being worked at a
  time" independently verifiable, and malformed or stale claims fail closed
  (they block reselection and require explicit recovery) rather than being
  silently reclaimed.
- **Positive:** Tiered repair caps (routine 2, sensitive 1, boundary 0)
  extend the existing flat two-commit self-heal cap
  (`docs/agentic-software-factory.md`) with a risk-aware ceiling instead of
  applying the same retry budget to every change regardless of
  reversibility.
- **Negative / trade-off:** Starting concurrency at 1 caps factory
  throughput below what the infrastructure could technically sustain; this
  is intentional until the evidence gate is cleared.
- **Negative / trade-off:** Because `risk:boundary` never auto-repairs, a
  single flaky required check on a boundary-tier PR routes straight to a
  human rather than getting an automatic retry, which is slower but
  matches the "no autonomous action at the boundary" principle.
- **Follow-ups required:** Wire `agentic-queue-controller.cjs` into an actual
  dispatch workflow (issue claim comment/label application, session
  creation) and into the deployment reconciler that validates dev evidence
  before applying `factory:deployed-dev`; both are implementation work
  against the contract this ADR approves, not part of this documentation
  change.

## Alternatives considered

- **Fully autonomous continuous deployment through production:** rejected --
  directly contradicts ADR 0002 (paper trading boundary) and ADR 0008 §12
  (no executable production-promotion workflow).
- **No queue controller; keep relying on a human to apply
  `ready-for-ai-dev` one issue at a time:** rejected -- does not scale past
  a single human operator's attention and provides no deterministic,
  testable guarantee that only one eligible issue is claimed at a time.
- **Unlimited concurrency from day one:** rejected -- no evidence yet exists
  that the repair loop and merge policy behave safely at scale; concurrency
  is a privilege the factory earns via the evidence gate, not a default.
- **Let the implementation agent decide its own scope/milestone:**
  rejected -- violates the ADR 0005 pattern this ADR generalizes: an agent
  proposes, a small deterministic function authorizes. Milestone and risk
  ceilings must come from the human-approved goal, not from agent judgment.
- **A single flat repair cap for all risk tiers (status quo):** rejected --
  applies the same retry budget to a documentation typo fix and a guardrail
  change; tiering the cap to risk (2/1/0) keeps the retry budget
  proportional to blast radius.
