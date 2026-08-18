# 0014 — Deterministic immutable-ledger attestation

- **Status:** Accepted
- **Date:** 2026-08-17
- **Deciders:** Project Krypto trading-safety and release owners

## Context

Materialized `AgentState` can be internally consistent while disagreeing with
the immutable `TradeExecution` authority. The disabled-target checks also did
not prove cost basis, DCA count, fees, realized PnL, correlation, legacy
classification, or the age and attribution of reference/last-buy/peak anchors.
A stale shadow reference could therefore become the first PAPER trigger.

The operation must be safe to run against a disabled production target. It must
not repair history, reseed an anchor, acquire a trading lease, call a provider,
or turn approximate floating-point agreement into success.

## Decision

Migration `0011` adds explicit JSON anchor/valuation metadata: observation time,
allowlisted source, fixed one-hour maximum age, release attribution, strategy
configuration version, observed fixed-point price, and observed portfolio
value. Price and metadata presence are paired by database constraints. Existing
rows are preserved and explicitly labeled `legacy-migration-0011`; no trade row
is changed.

`attestLedger` replays at most 10,000 rows ordered by `(createdAt, id)` from zero
ETH and `initialCapitalUSD` USDC. It uses only the approved bigint accounting
functions and exact decimal strings. It derives and compares quantities,
modeled prices, fees, slippage, ETH/USDC transitions, weighted cost basis,
realized PnL, DCA state, portfolio observations, legacy fields, anchors, and
run/journal/incident correlations. Modern rows require one PAPER/EXECUTED run,
one trade-linked journal, and one correlated post-commit incident origin.
Unlinked rows pass only under the reviewed `v2-legacy`/`v2-backfill`
classification.

The database operation uses one repeatable-read, statement-bounded,
`READ ONLY` PostgreSQL transaction and exposes no write callback. Its redacted,
canonical report hashes identifiers, is checksum-addressed, and binds the exact
release SHA, image digest, strategy configuration, database identity, runtime
role, purpose, and as-of time.

Disabled preflight and target smoke require the report. The signed target-smoke
approval includes its checksum. The promotion-time activation check reruns the
attestation with purpose `pre-paper`; only a fresh, config-matched reference
returns the explicit `RETAIN` decision and PAPER eligibility. Missing reference
state reports `RESET_REQUIRED` outside promotion and blocks at promotion.
Nothing resets it automatically.

A failed attestation remains read-only. The separate
`ledger:quarantine` operation verifies the failed checksum against a fresh
read-only replay of the bound database, requires the protected
`krypto_migrator` to `krypto_schema_owner` boundary, atomically
sets/retains `QUARANTINED`, and appends a deduplicated critical
`RECONCILIATION_QUARANTINE` incident. It never edits or deletes ledger history.

## Consequences

- PAPER promotion and execution remain blocked by reconciliation/quarantine.
- Repeated attestation at the same snapshot/as-of value is identical and
  mutation-free.
- Anchor expiry is a release gate, not an invitation to silently reseed.
- Legacy compatibility is explicit and countable, not a numeric tolerance.
- Target evidence must retain both disabled-target and immediate pre-PAPER
  reports; source tests do not constitute live target evidence.
- v2 remains paper-only. This decision adds no live-money adapter, credential,
  tool, deployment, or rollout activation.

## Alternatives considered

- **Compare only `AgentState` fields** — rejected because correlated tampering or
  migration drift can remain self-consistent.
- **Use floating tolerances** — rejected because success would depend on runtime
  approximation rather than the approved fixed-point rules.
- **Repair state during replay** — rejected because read verification and
  mutation would share authority and could destroy auditability.
- **Automatically reset stale anchors** — rejected because it can manufacture
  the first PAPER reference without an audited shadow observation.
