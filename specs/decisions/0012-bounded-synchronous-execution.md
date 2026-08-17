# 0012 — Bounded synchronous execution

- **Status:** Accepted
- **Date:** 2026-08-17
- **Deciders:** @VeVarunSharma

## Context

Project Krypto production PAPER runs need one timing and capacity contract that cannot be extended by provider retries, a scheduler retry, or a stale lease. The previous worst-case Coinbase and Foundry retry windows could outlive the request that started them. A process-only health probe could not prove that the release, runtime database identity, schema, lease, and rollout mode were safe for traffic.

The current target is Azure Container Apps in `westus3` with private Azure Database for PostgreSQL Flexible Server 17. Vercel, Supabase, `pg_cron`/`pg_net`, and Resend are historical baselines, not part of this runtime contract. The system is PAPER-only; nothing in this decision adds an exchange-order path, live trading credential, or live-money authorization.

## Decision

**Keep the run boundary synchronous, but make it explicitly bounded and fail closed.** The one-attempt Container Apps scheduler HTTP call stays open only long enough for the application to persist one terminal outcome and release its owned lease. Durable queue/worker orchestration is not introduced at this stage.

### Timing contract

The authoritative ordering is:

| Boundary | Limit |
|---|---:|
| Provider time budgets, aggregate | `125 s` |
| — Coinbase | `20 s` |
| — version-pinned Foundry prompt agent | `80 s` |
| — ACS Email | `20 s` |
| — PostHog | `5 s` |
| Application absolute deadline | `180 s` |
| Scheduler HTTP timeout | `210 s` |
| Azure Container Apps ingress platform bound | `240 s` |
| Scheduler job replica timeout | `270 s` |
| Owned run lease expiry | `300 s` |

The `180 s` application window is a partition, not a single upstream timeout:

- providers: `125 s`;
- database policy and execution: `20 s`;
- terminal persistence and owned-lease release: `15 s`;
- cancellation and HTTP response: `10 s`; and
- slack: `10 s`.

Provider calls, retries, `Retry-After` delays, database work, telemetry flush, and email polling must use the remaining absolute deadline and cancellation signal. No retry may consume a reserved terminal, response, or slack window.

Both the hourly agent-run and daily-summary jobs use `replicaRetryLimit = 0` and a 270-second replica timeout. The scheduler performs exactly one HTTP attempt. Persisted idempotency remains defense in depth against platform redelivery, replay, and manual mistakes; it is not itself permission to retry. Manual migration, preflight, backup, target-smoke, and activation-check ops jobs are outside the trading lease/deadline chain and keep their existing long-running timeout semantics.

### Capacity and database

- The web Container App scales to no more than `3` replicas.
- Each runtime replica has a maximum database pool size of `1` and a process-local admission capacity of `1` run. The owned database lease remains the cross-replica serialization boundary.
- The `krypto_app` runtime login has `CONNECTION LIMIT 20`.
- Runtime connections use a `5 s` connect timeout, `10 s` statement timeout, `2 s` lock timeout, and `15 s` idle-in-transaction timeout.

At the application boundary, capacity exhaustion is a no-trade failure, not a queue. Readiness fails when the local admission slot is unavailable.

### Terminal state and deadline fence

Every acquired run persists its `deadlineAt`. The application treats deadline, cancellation, provider-budget, and admission exhaustion as fail-closed no-trade outcomes, persists one terminal run where possible, flushes bounded telemetry, and releases only the lease it owns. If owner-checked release cannot complete, the 300-second lease expiry is the final safety bound.

Migration `0009_bounded_execution.sql` adds three database defenses:

1. an exact `startedAt + 180 s` `AgentRun.deadlineAt` constraint and immutability trigger;
2. a runtime-readable `RuntimeContract` singleton fingerprint for bounded readiness while the migration ledger remains denied; and
3. a deferred constraint trigger on `TradeExecution` that, at transaction commit, rejects any insert without a matching PAPER run or at/after that persisted run deadline.

The application also checks the deadline before policy, locked execution, state transition, and commit phases. The database constraint is the final defense. It applies only to PAPER trades because there is no live-execution path in the product.

### Health contract

- `/api/health/live` is unauthenticated and dependency-free. It proves only that the process and event loop can respond.
- `/api/health/ready` runs a four-second, bounded, non-mutating, provider-free check using only the runtime `DATABASE_URL`. It proves:
  - the 40-hex release SHA and sha256 image digest bindings;
  - `EXECUTION_CONTRACT_VERSION` and presence/bounds of database-pool, admission, and provider daily-ceiling configuration;
  - PostgreSQL 17, the current login, membership in `krypto_runtime`, safe non-elevated attributes, `CONNECTION LIMIT 20`, stable `current_user`/`session_user`/`current_role`, inheritance, and denial of elevated roles and the `drizzle` migration ledger;
  - the reviewed runtime schema fingerprint (`0009_bounded_execution_v1` at
    this decision; advanced to `0010_safety_incidents_v1`/contract `2` by
    ADR 0013 without changing the bounded timings);
  - exactly one `AgentState` singleton, `RECONCILED` accounting, a sane idle or owned/unexpired 300-second lease, a valid rollout mode, and one free local admission slot.

The response contains only `status` and an ordered list of opaque, stable reason codes. It does not return role names, privileges, versions, digests, configuration, lease owners, or database values. Readiness is an admission signal, not a provider health cache.

### Provider daily safety ceilings and ownership

The runtime atomically counts requests per UTC day in `ProviderDailyUsage` before provider access. The release-reviewed operator safety ceilings are:

| Provider | Maximum requests / UTC day |
|---|---:|
| Coinbase | `1,000` |
| version-pinned Foundry prompt agent | `200` |
| PostHog | `2,000` |
| ACS Email | `100` |

These are application safety ceilings, not a claim that a current provider plan allows that usage or that it is affordable. Before each rollout, the release/operator must reconcile each ceiling against the contracted quota, rate-limit policy, and cost/plan, lowering the application ceiling when needed. Exhaustion is a persisted no-trade outcome and operator alert; it must not become a success-shaped trade fallback.

- **Application/runtime contract owner:** engineering.
- **Provider plan, quota, and cost-reconciliation owner:** release/operator.
- **Budget/deadline/capacity alert response owner:** operator.

## Evidence status

This ADR and issue #132 source/CI changes do not constitute live Azure evidence. Timing, region, capacity, readiness, database-timeout, provider-plan/quota/cost, budget-exhaustion, and terminal/lease behavior evidence must be produced from the exact future release and indexed in issue #76. The verified live facts recorded in the other Azure documents remain valid, but they do not prove this contract.

## Consequences

- **Positive:** The synchronous route remains simple while each layer has numeric slack for terminal persistence and cleanup.
- **Positive:** Daily provider ceilings, local admission, database timeouts, and the PAPER commit fence make time, capacity, quota, and cost exhaustion fail closed.
- **Positive:** Liveness and readiness now have separate meanings; the readiness body remains safe to expose as a platform probe.
- **Trade-off:** The contract assumes the synchronous route can complete within `180 s`. Repeated deadline pressure means the boundary must be reconsidered as a durable worker, not loosened.
- **Trade-off:** One pooled connection and one admitted run per replica prioritize trading safety over throughput. The 300-second lease limits cross-replica overlap.

## Alternatives considered

- **Durable queue + worker:** Rejected for this stage because it adds queue persistence, replay, and a new operational boundary before measurement shows the bounded synchronous path is insufficient.
- **Extend ingress, job, or lease timeouts:** Rejected. It reduces safety margin, holds scarce resources longer, and does not guarantee a terminal run.
- **Increase connections/concurrency:** Rejected until private PostgreSQL 17 capacity, failover, and lock-contention evidence proves a new bound.
