# Backlog Governance

This document defines WIP thresholds, milestone rules, and unblock criteria for Project Krypto's issue backlog. It governs the agentic workflow factory to prevent scope explosion. Production-paper issue scope and ordering are mapped in [`specs/production-readiness-prd.v1.md`](../specs/production-readiness-prd.v1.md); this document remains authoritative for workflow governance.

## Milestones

| Milestone | Purpose | Unblock criteria |
|-----------|---------|-----------------|
| **v2.1 Safety and Correctness** | Deterministic guardrails, accounting correctness, run reliability, market-data integrity, database migrations, private schema/cron security, decimal ledger, transactional idempotency, structured LLM intent, typed errors/timeouts, real-Postgres CI. | All v2.1 issues closed or explicitly deferred by human review. |
| **v2.2 Evidence-Grade Paper Trading** | Production-paper security, reliability, recovery, rollout, evaluation, performance visibility, and immutable evidence. | Production readiness PRD gates and all v2.2 issues complete. Requires v2.1 complete. |
| **v3 Live Trading RFC** | Live trading enablement. Requires explicit human approval and RFC merge. | v2.1 + v2.2 complete; RFC approved. |
| **Deferred: Strategy Research** | Speculative strategy improvements (ATR, MACD, volume signals, market regime classifiers, EMA trend filters, dynamic sizing). | v2.1 + v2.2 complete. |

## WIP Threshold

**Opportunity-discovery workflow noop limit: 20 open `opportunity` issues without the `blocked` label.**

When open actionable opportunity count ≥ 20, `opportunity-discovery` must call `noop` immediately. This prevents scope expansion while delivery throughput is limited.

## Opportunity-Discovery Schedule

- **Schedule**: weekly (not daily).
- **Max issues per run**: 1.
- **Allowed scope**: v2.1 safety foundations, v2.2 evidence foundations, factory/QA/observability.
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

The `daily-repo-status` workflow reports throughput, aging, blocked work, and WIP gate status. It does **not** create new feature scope. Destination: GitHub Issues (`[factory-status]` title prefix, `agentic-factory + report` labels).
