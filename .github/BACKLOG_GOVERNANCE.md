# Backlog Governance

This document defines WIP thresholds, milestone rules, and unblock criteria for Project Krypto's issue backlog. It governs the agentic workflow factory to prevent scope explosion. Production-paper issue scope and ordering are mapped in [`specs/production-readiness-prd.v1.md`](../specs/production-readiness-prd.v1.md); this document remains authoritative for workflow governance. See [`specs/agentic-factory-contract.md`](../specs/agentic-factory-contract.md) and [ADR 0009](../specs/decisions/0009-autonomous-agentic-sdlc-factory.md) for the normative queue/lifecycle contract this document's thresholds feed.

## Milestones

| Milestone | Purpose | Unblock criteria |
|-----------|---------|-----------------|
| **v2.1 Safety and Correctness** | Deterministic guardrails, accounting correctness, run reliability, market-data integrity, database migrations, private schema/cron security, decimal ledger, transactional idempotency, structured LLM intent, typed errors/timeouts, real-Postgres CI. | All v2.1 issues closed or explicitly deferred by human review. |
| **v2.2 Evidence-Grade Paper Trading** | Production-paper security, reliability, recovery, rollout, evaluation, performance visibility, and immutable evidence. | Production readiness PRD gates and all v2.2 issues complete. Requires v2.1 complete. |
| **v3 Live Trading RFC** | Live trading enablement. Requires explicit human approval and RFC merge. | v2.1 + v2.2 complete; RFC approved. |
| **Deferred: Strategy Research** | Speculative strategy improvements (ATR, MACD, volume signals, market regime classifiers, EMA trend filters, dynamic sizing). | v2.1 + v2.2 complete. |

## Goal authorization gates all discovery and queue selection

Every automated ticket-creation and queue-selection path is bound by a
human-approved factory goal (issue labeled `factory:goal` +
human-applied `factory:goal-approved`; see
[`.github/ISSUE_TEMPLATE/factory-goal.yml`](ISSUE_TEMPLATE/factory-goal.yml)).
There must be exactly one open, approved goal in scope before
`opportunity-discovery`, `em-planning`, or `factory-queue-controller` may
act:

- **`max_wip`** starts at **`1`** by default (the template's own guidance:
  "Use 1 until concurrency graduation evidence passes") — at most one issue
  may be `factory:claimed`/`factory:implementing`/`factory:pr-open`/
  `factory:repairing` under the goal at a time until the evidence-gated
  graduation to concurrency 2 described in ADR 0009 §8/contract §11.
- **`assignment_budget`** is the maximum number of `implement-ticket`
  assignments the goal authorizes before it requires human renewal. When
  exhausted, `factory-queue-controller` must stop selecting issues under
  that goal even if `ready-for-ai-dev` issues remain.
- **`max_risk`** is the ceiling risk tier (`risk:routine` /
  `risk:sensitive` / `risk:boundary`) the goal authorizes; no descendant
  issue may be scheduled above it.
- No new opportunity, planning, or queue-selection work may be created or
  claimed when the active goal's WIP or assignment budget is exhausted, or
  when no goal is `factory:goal-approved`. This applies independent of the
  legacy WIP threshold below.

## Queue-readiness schema

`em-planning` may only apply `ready-for-ai-dev` when every field below is
present on the issue; `factory-queue-controller` treats an issue missing any
field as ineligible (fails closed, not silently skipped):

| Field | Requirement |
|---|---|
| Parent goal | Exactly one `factory:goal-approved` ancestor, in scope |
| Risk tier | Exactly one of `risk:routine` / `risk:sensitive` / `risk:boundary` |
| Scope | Explicit allowed scope and non-goals |
| Acceptance criteria | Concrete, checkable acceptance criteria |
| Validation | Existing validation commands (no new tooling required) |
| Rollback | A safe reversal or rollback note |
| Blocking dependencies | Any `blocked-by` relationship resolved or absent |

## WIP Threshold (secondary absolute ceiling)

**Opportunity-discovery workflow noop limit: 20 open `opportunity` issues without the `blocked` label.**

This count remains a secondary, absolute ceiling — a hard backstop against
unbounded backlog growth — and is checked in addition to, not instead of,
the goal-level WIP/assignment-budget gate above. When open actionable
opportunity count ≥ 20, `opportunity-discovery` must call `noop`
immediately regardless of remaining goal budget. The goal's WIP and
assignment budget are the **primary** authorization; this count is not a
substitute for an approved goal.

## Opportunity-Discovery Schedule

- **Schedule**: weekly (not daily).
- **Max issues per run**: 1.
- **Allowed scope**: v2.1 safety foundations, v2.2 evidence foundations, factory/QA/observability, all bounded by the active goal's allowed scope.
- **Deferred scope** (always noop): strategy experiments including ATR, MACD, volume signals, regime classifiers, EMA filters, dynamic sizing.

## Deferred Work

Issues in the **Deferred: Strategy Research** milestone carry the `blocked` label. They must not be promoted to `ready-for-planning` until v2.1 and v2.2 milestones are closed.

Draft PR #43 ([WIP] Add ATR(14) volatility context) is deferred. It must not be merged until v2.1 and v2.2 are complete.

## Unblock Criteria for Strategy Research

A human reviewer must explicitly:
1. Confirm v2.1 milestone is closed.
2. Confirm v2.2 milestone is closed with sufficient Sharpe/Sortino evidence.
3. Remove the `blocked` label from individual strategy issues.
4. Advance them to `needs-rubber-duck` for rubber-duck and trading-safety review before any implementation.

## Daily Status Report

The `daily-repo-status` workflow finds or creates one canonical `[factory-status]` issue (labels `agentic-factory` + `report`) and refreshes it in place on each run instead of creating a new issue every time. It reports throughput, aging, blocked work, WIP gate status, an autonomy-funnel count per lifecycle label (`ready-for-ai-dev` through `factory:done`), and hard invariants (duplicate claims, multiple PRs per issue, malformed lifecycle/risk labels, stale leases, boundary PRs merged without human approval, and any production/live automation attempt). It does **not** create new feature scope.
