# 0002 -- Evidence-Grade Paper Trading (v2.1 + v2.2)

- **Status:** Draft
- **Date opened:** 2026-07-14
- **Author:** @VeVarunSharma

> This RFC remains architectural design context. Production-paper controls,
> acceptance thresholds, and authorization are governed by
> [`../production-readiness-prd.v1.md`](../production-readiness-prd.v1.md).
> Its §8.1 table is the only normative numeric SLI/SLO source.

Implementation note (2026-07-14): the v2.1 deterministic policy, structured
decision boundary, exact transactional paper executor, AgentRun ledger, and
owned lease orchestration, operations controls/health, production-aligned
backtesting, expanded CI gates, and v2.2 preflight/backup/disabled-target-smoke
tooling are implemented and locally verified. This RFC remains Draft because
the clean target still needs migration, backup, Vault, disabled deployment and
smoke; shadow/paper observation and financial evidence are not complete. The
imported walk-forward evidence foundation is engineering-only and cannot satisfy
the production evidence gates in this RFC.

ADR 0013's durable incident/outbox and independent-alert contract is accepted
design context but is not implemented or proven by this documentation update.

## Summary

Address the safety and correctness issues in the v2 code baseline and establish a
structured evidence-collection phase before any live-trading work begins. v2.1
resolves blocking issues in the shipped code. v2.2 runs paper trading in a way
that produces trustworthy, audit-grade evidence of strategy performance.

## Motivation

The v2 code baseline (commit cda2bca, tag `spec/v2`) passes 108 tests and 8
synthetic fixture scenarios, but is not production-ready. The plan review
identified the following blocking issues (full list in `specs/readiness.md` §3):

- Stop-loss, DCA count, and threshold rules are enforced by the system prompt
  only; deterministic code does not verify them independently.
- Trade execution is not wrapped in a DB transaction; a crash between the two
  writes (`TradeExecution` INSERT + `AgentState` UPDATE) leaves the database in
  an inconsistent state.
- The seed migration (`supabase/migrations/20260322000001_seed_data.sql`) is
  destructive: re-running it against a database with existing trading data resets
  live state.
- PnL is anchored to the most recent BUY price, not a weighted-average cost basis;
  DCA chains produce incorrect realised PnL.
- 80 npm audit findings in the dependency tree.
- The atomic `isRunning` flag has no owner or expiry; a hard timeout can leave it
  stuck indefinitely, while force-release can overlap a still-running request.

Without resolving these issues, production paper-trading data cannot be considered
reliable evidence of strategy performance, and any results are inadmissible for the
v3 live-trading evidence gate.

## Proposed architecture

### Structured LLM intent + hard deterministic authorization (ADR 0005)

v2 asks the LLM to call the `safe_trade` tool with free-form parameters. v2.1
separates the decision into two explicit layers.

**LLM intent layer.** The LLM is asked to produce a structured intent object:

```json
{
  "action": "BUY" | "SELL" | "HOLD",
  "notionalUSD": 30.00,
  "rationale": "EMA crossover confirms upward momentum; RSI not overbought."
}
```

The LLM is not prompted with rule thresholds (stop-loss percentages, DCA counts,
etc.). It proposes what it wants to do.

**Deterministic authorization layer.** A pure TypeScript function,
`authorizeTradeIntent(intent, agentState, marketSnapshot, config)`, enforces every
risk rule before any trade is executed:

| Rule | v2 location | v2.1 location |
|---|---|---|
| Max trade size | `safe-trade.ts` in-tool check | `authorizeTradeIntent` |
| Min trade size | System prompt (prompt-only) | `authorizeTradeIntent` |
| Asset whitelist | `safe-trade.ts` in-tool check | `authorizeTradeIntent` |
| Balance sufficiency | `safe-trade.ts` in-tool check | `authorizeTradeIntent` |
| Stop-loss threshold | System prompt (prompt-only) | `authorizeTradeIntent` |
| DCA count limit | System prompt (prompt-only) | `authorizeTradeIntent` |
| Buy/sell trigger pct | System prompt (prompt-only) | `authorizeTradeIntent` |
| In-flight pause/lock re-check | `safe-trade.ts` re-read | Policy check plus transactional executor re-check |
| Cooldown | Pre-flight guardrail | Policy check plus transactional executor re-check |
| Drawdown lock | Pre-flight guardrail | Pre-flight guardrail (unchanged) |

If the authorization layer rejects the intent, no trade is executed and no
`TradeExecution` row is written. The rejection reason is logged to PostHog and
included in the journal entry so future runs have context.

If the authorization layer approves (or adjusts the amount), the execution wrapper
records the trade in a single DB transaction covering both the `TradeExecution`
INSERT and the `AgentState` UPDATE.

### Rollout modes

Three modes control execution behavior:

| Mode | Description |
|---|---|
| `disabled` | Agent runs are skipped entirely. No LLM call. Equivalent to operator pause but controlled by configuration rather than DB state. Used during deployment and debugging. |
| `shadow` | Full loop runs (LLM call, authorization, journal write), but approved trades are NOT recorded as `TradeExecution` rows. Used to verify the production loop works correctly before committing paper capital. |
| `paper` | Full loop runs and approved trades ARE recorded. This is the production paper-trading mode. |

`ROLLOUT_MODE` is a validated server-side environment variable and defaults to
`disabled` outside local development. Promotion from `shadow` to `paper`
requires an explicit Vercel environment change and deployment. The database
operator-pause flag remains a separate emergency control; the public/admin API
cannot promote rollout mode.

### v2.1 additional correctness changes

Beyond the authorization architecture, v2.1 must also:

- Replace the destructive seed migration with an idempotent seed script
  (`INSERT ... ON CONFLICT DO NOTHING`) per ADR 0006.
- Wrap trade execution in a single DB transaction (atomicity).
- Add an idempotency key to the execution path so retrying after a partial failure
  records no duplicate trades.
- Replace the boolean `isRunning` flag with an owned, expiring run lease and
  owner-checked release/recovery.
- Implement weighted-average cost basis for PnL calculation.
- Replace IEEE 754 float money storage with integer cents or Drizzle `numeric` type.
- Resolve critical findings and all reachable high-severity direct advisories;
  any temporary exception requires documented reachability, ownership, and an
  expiry condition.
- Surface LLM retry count and latency in PostHog `llm_token_usage` events.
- Paginate Coinbase candle requests within the 300-candle limit, align complete
  four-hour buckets to UTC, and add freshness, finite-value, and timeout checks.
- Align PostHog event schema, Resend email paths, and admin dashboard state across
  all code paths.

### Durable safety incidents and independent alerts (ADR 0013)

Before the shadow evidence gate, the production-paper control plane must satisfy
[ADR 0013](../decisions/0013-durable-safety-incidents-and-independent-alerts.md):

- safety state changes atomically append an incident origin, lifecycle event,
  and durable alert outbox obligation;
- every PAPER execution commits its post-commit obligations with immutable
  ledger truth;
- a separate least-privilege relay and Azure rules observe external
  Log Analytics/platform signals plus redacted durable incident/outbox
  evidence, not process liveness alone;
- correlation is allowlisted and redacted across request, run, release,
  deployment, provider, transaction, and incident IDs; and
- delivery, acknowledgment, escalation, containment, recovery, and explicit
  resolution remain append-only; a retry never auto-resolves an incident.

The fail-closed responder roster, scenario response, non-trading warning and
critical drills, game day, and issue #76 evidence contract are in
[`../incident-response.md`](../incident-response.md). A missing or stale roster
blocks issue #75 / PR-G2.

## Revised strategy parameters

The default account remains $200, but starting paper capital becomes
configurable and is persisted when the account is initialized. Risk controls
scale from that persisted account configuration:

- minimum trade: $10;
- maximum trade: 25% of initial capital ($50 at the default);
- maximum ETH exposure: 75% of current portfolio value;
- buy/DCA step: 3% below the relevant reference or previous-buy price;
- optional sell eligibility: 3% above weighted average open cost basis;
- mandatory full stop-loss exit: 15% below weighted average open cost basis;
- maximum three buys in the current open-position cycle;
- two-hour execution cooldown;
- maximum portfolio drawdown: 25% from tracked peak equity;
- modeled fee: 30 bps; modeled paper slippage defaults to a nonzero 15 bps
  with a 100 bps rejection ceiling.

The first fresh market snapshot establishes the cold-start reference price and
results in HOLD. Partial sells reduce cost basis proportionally and do not reset
the DCA count while a position remains.

## Gates

### Gate 0 -- target deployment eligible

All v2.1 criteria from `specs/readiness.md` must be satisfied, and the following
artifacts must be retained outside source control:

- [ ] Passing redacted `deployment:preflight` report.
      Runtime/direct database name and system identifier must match; private
      schema completeness with no extra Krypto relation, required Drizzle
      history fingerprint, migration/layout consistency, protected public
      wrapper checks, canonical
      cron-function integrity, absence of queued Krypto HTTP requests,
      table/column ACLs, and Vault
      schema/relation/routine privilege checks must pass.
- [ ] Provider backup identifier plus a verified `deployment:backup` manifest.
- [ ] Successful restore/count comparison for preserve-required data.
      Legacy public-schema evidence must prove restoration of the required enum
      bootstrap as well as all application tables.
- [ ] Reviewed migration and singleton-initialization logs.
- [ ] Deployment configured with `ROLLOUT_MODE=disabled`, cron unscheduled,
      and no matching `pg_net` request queued.
- [ ] Passing `smoke:target` report, including unchanged trade count, two
      persisted disabled runs, a runtime/direct database-binding challenge,
      an authenticated no-mutation mismatched-mode rejection that cannot enter
      orchestration, per-request disabled-mode enforcement, idle lease, sent
      email audit, admin auth, no-trade Foundry/Coinbase/PostHog checks, and an
      immutable target-origin/cron-secret-fingerprint approval.
- [ ] PostHog event, mailbox delivery, Vercel logs, and admin health manually
      confirmed.
- [ ] At least 30 minutes of disabled observation after the smoke with no
      unexplained 5xx, configuration, lease, or database errors.

### Gate 1 -- shadow mode eligible

- [ ] Gate 0 satisfied.
- [ ] Operator records the exact commit, deployment ID, strategy version,
      model deployment, migration count, and promotion timestamp.
- [ ] Rollout mode changes only through a reviewed Vercel environment update
      and fresh deployment; APIs cannot promote it.
- [ ] First manual shadow invocation completes as `SHADOW`, writes no
      `TradeExecution`, releases its lease, and produces a coherent journal.
- [ ] Fixed cron jobs are enabled only after that manual invocation.
- [ ] Shadow runs for the declared 72-hour window and satisfies the Scheduled
      completion and Run error SLOs in the authoritative PRD §8.1 table; no
      consecutive scheduled miss remains unexplained.
- [ ] Every shadow run is terminal; zero executions are recorded; accounting
      remains `RECONCILED`; no stale/overlapping lease or duplicate run exists.
- [ ] Daily summary delivery is `sent` on at least two consecutive days.
- [ ] All proposals, authorization decisions, holds, rejections, provider
      failures, and journals in the window are reviewed. No production state
      fault injection is permitted; deterministic guardrail fault cases remain
      proven by the real-PostgreSQL integration suite.
- [ ] OPS-01 source/CI and future exact-release monitor/outbox evidence, current
      roster, warning/critical drills, acknowledgments/escalations, and game-day
      timeline are indexed in issue #76.

### Gate 2 -- paper mode eligible

- [ ] Gate 1 satisfied.
- [ ] A versioned shadow evidence report records run reliability, model usage,
      proposal/authorization counts, error taxonomy, market-data freshness,
      alert delivery, reconciliation, and zero trade-count delta.
- [ ] A fresh pre-promotion preflight confirms no active lease, quarantine,
      open position, unsafe function, exposed role, or active cron.
- [ ] Cron is paused for the mode-changing deployment.
- [ ] Named operator approval records accepted risk, rollback owner, and the
      exact paper evidence-window start.
- [ ] Paper mode begins with a 24-hour attended observation period. Any
      execution is reconciled immediately against balances and ledger history.
- [ ] Cron is re-enabled only after the paper deployment reports the expected
      mode and the account remains reconciled.

### Gate 3 -- v3 RFC eligible (requires paper mode results)

- [ ] Gate 2 satisfied.
- [ ] One unchanged strategy/model/cost configuration ran in paper mode for at
      least 30 calendar days; configuration changes start a new evidence
      attribution window.
- [ ] Scheduled runs satisfy the authoritative PRD §8.1 completion and
      run-error SLOs; all missing windows and provider outages are classified.
- [ ] Every execution reconciles, no duplicate execution exists, and no
      unresolved alert, lease, authorization, or accounting incident remains.
- [ ] At least one evaluation window (per `specs/evaluation.md` §4) completed and
      documented with capital preservation and positive risk-adjusted evidence
      versus both cash and buy-and-hold under the declared methodology.
- [ ] Manual journal review shows coherent LLM reasoning; no prompt gaming detected.
- [ ] All v3 preconditions in `specs/rfcs/0001-v3-live-trading.md` satisfied.

### Immediate rollback triggers

Any one of the following ends the current observation/evidence window and
requires cron disablement plus `ROLLOUT_MODE=disabled`:

- any `TradeExecution` in disabled or shadow mode;
- negative balance, duplicate execution, ledger/state mismatch, or accounting
  status other than `RECONCILED`;
- an active lease beyond expiry, overlapping owner, or ownerless running flag;
- an unauthorized route succeeding, a fixed function becoming broadly
  executable, or the legacy arbitrary-path function reappearing;
- stale/invalid market data reaching model inference or execution;
- any Scheduled completion, Run error, readiness, incident-delivery,
  acknowledgment/escalation, or recovery breach in the authoritative PRD §8.1
  table;
- failed or missing daily-summary delivery that remains unclassified;
- drawdown lock, operator safety concern, suspected credential exposure, or
  migration drift.

Rollback preserves all run, journal, and trade evidence. It never deletes or
rewrites history; remediation and re-promotion require a new operator approval.

## Drawbacks / risks

- The authorization layer adds a code path that must be tested thoroughly. A bug
  in `authorizeTradeIntent` could silently reject valid trades (false reject) or
  silently permit invalid ones (false accept). 100% branch coverage is required.
- Defining formal rule logic in code requires disambiguating prompt rules that were
  previously left intentionally vague. Some rules may need owner input to clarify
  before they can be coded.
- Shadow mode adds an operational step before paper mode; operators must remember
  to promote. Document the promotion procedure clearly in `specs/deployment.md`.

## Alternatives

- **Prompt-only rules (status quo):** rejected -- not auditable, not reliable for
  real-money execution, cannot be unit-tested independently.
- **Skip shadow mode, deploy directly to paper:** rejected -- shadow mode provides
  a safety buffer while the production cron loop is validated under real traffic.
- **Move directly to v3 live trading:** rejected -- no production paper data exists;
  live execution requires statistically significant evidence per `specs/readiness.md`.

## Open questions

- Should the authorization layer return the adjusted amount to the LLM as journal
  feedback, or only the rejection reason?
- The `AgentRun.id` is the execution idempotency key. `TradeExecution.agentRunId`
  is unique.
- Pure policy computes eligibility before inference; the transactional executor
  re-checks pause, lock, lease, balance, cooldown, and risk invariants under row
  lock before commit.
