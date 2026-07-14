# 0002 -- Evidence-Grade Paper Trading (v2.1 + v2.2)

- **Status:** Draft
- **Date opened:** 2026-07-14
- **Author:** @VeVarunSharma

Implementation note (2026-07-14): the v2.1 deterministic policy, structured
decision boundary, exact transactional paper executor, AgentRun ledger, and
owned lease orchestration, operations controls/health, production-aligned
backtesting, and expanded CI gates are implemented and locally verified. This
RFC remains Draft because target deployment and the v2.2 evidence phase are not
complete.

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

### Gate 1 -- shadow mode eligible

All v2.1 criteria from `specs/readiness.md` §4 must be satisfied:

- [ ] Seed migration replaced with idempotent script (ADR 0006).
- [ ] No critical advisory or undocumented reachable high-severity direct
      advisory.
- [ ] All risk rules in `authorizeTradeIntent` (ADR 0005), with unit tests.
- [ ] Trade execution atomic (single DB transaction).
- [ ] Execution path idempotent (idempotency key per run).
- [ ] Owned expiring run lease with owner-checked release and stale recovery.
- [ ] Weighted-average cost basis PnL.
- [ ] Integer cent / Drizzle numeric money storage.
- [ ] LLM retry metadata in PostHog.
- [ ] Market-data error handling corrected.
- [ ] PostHog / email / admin dashboard consistent.
- [ ] 108 existing tests pass; new tests cover each fixed issue.

### Gate 2 -- paper mode eligible

- [ ] Gate 1 satisfied.
- [ ] Shadow-mode run, authorization, rejection, journal, alert, and accounting
      evidence reviewed with no unexplained errors.
- [ ] Guardrails (drawdown, cooldown, operator pause) fire as expected under real
      cron traffic in shadow mode.
- [ ] Operator approval to promote to paper mode.

### Gate 3 -- v3 RFC eligible (requires paper mode results)

- [ ] Gate 2 satisfied.
- [ ] Paper mode ran for >= 30 calendar days.
- [ ] At least one evaluation window (per `specs/evaluation.md` §4) completed and
      documented with results beating the cash baseline.
- [ ] Manual journal review shows coherent LLM reasoning; no prompt gaming detected.
- [ ] All v3 preconditions in `specs/rfcs/0001-v3-live-trading.md` satisfied.

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
