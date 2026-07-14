# 0001 — v3: Live Coinbase AgentKit execution

- **Status:** **Draft (stub)** — high-level placeholder. Full design in a separate RFC pass once v2.2 evidence gates are satisfied and paper-trading data is available.
- **Date opened:** 2026-05-02
- **Author:** @VeVarunSharma

## Summary

Promote the agent from paper trading to **live execution on Base L2 via Coinbase AgentKit**, beginning with the existing $200 capital pool. Live trading is enabled by wiring a live `ExecutionAdapter` implementation behind the existing deterministic authorization layer (`authorizeTradeIntent`, ADR 0005); the authorization and strategy logic are unchanged.

This is the boundary at which real money starts moving. **Do not start v3 implementation until all v2.2 evidence gates in `specs/readiness.md` §4 are satisfied.**

## Motivation

The v1/v2 PRDs explicitly carve out paper trading as a stepping stone (see ADR `0002-paper-trading-before-live.md`). v3 is the goal those steps were taken for. However, advancement to v3 requires statistically significant out-of-sample evidence that the strategy produces positive risk-adjusted returns versus cash and buy-and-hold baselines (see `specs/evaluation.md` §5).

## Scope (high-level — to be expanded)

In scope:

- Implement a live `ExecutionAdapter` that calls AgentKit on an MPC wallet on Base L2. The paper adapter (write `TradeExecution` + update `AgentState`) and the live adapter share the same interface, enabling a mode switch without modifying the authorization layer.
- Real fee accounting (gas + DEX swap fee) replacing modelled 0.3%.
- Real slippage handling (currently 0; tolerance is 1%).
- MPC wallet provisioning, key custody plan, recovery procedure.
- Pre-deploy capital reconciliation (does on-chain balance match `AgentState`?).
- Sentiment / news feed evaluation (LLM tends to overreact -- guarded mitigation needed).
- Trailing-stop and limit-order tools.
- A separately approved capital-scaling ramp with explicit stop-and-review
  checkpoints; no dollar-return promise is attached.
- WebSocket-triggered runs (volatility-based) replacing the hourly cron once volatility data is reliable.
- Live-adapter replay and reconciliation tests using the evidence-grade
  backtesting infrastructure delivered before v3.

Out of scope (still): non-ETH/USDC pairs, leverage, perpetuals, derivatives.

## Pre-conditions before this RFC can move from Draft -> Accepted

0. All v2.2 gates from `specs/readiness.md` §4 satisfied (includes v2.1 prerequisites).
1. v2.2 paper mode running for >= 30 calendar days.
2. At least two non-overlapping 30-day evaluation windows show positive net PnL, positive Sharpe ratio, and final equity beating both cash and buy-and-hold baselines (per `specs/evaluation.md` §5).
3. PostHog and `AgentRun` evidence show expected scheduled-run coverage,
   guardrail behavior, and no unexplained errors. HOLD decisions are valid;
   there is no minimum-trades-per-day requirement.
4. Daily-summary email reports show positive cumulative `pnlUSD` computed with weighted-average cost basis (requires v2.1 PnL fix).
5. Manual review of `AgentJournal` confirms the LLM is reasoning sensibly, not gaming the strategy parameters.
6. `authorizeTradeIntent` deterministic authorization layer (ADR 0005) in production use for >= 30 days without false-accept or false-reject incidents.
7. `ExecutionAdapter` interface defined and reviewed.
8. Documented MPC wallet provisioning + recovery plan reviewed by the owner.
9. Live trading risk register: maximum-loss scenarios identified and mitigations agreed.

## Open questions (to be answered in the full RFC)

- AgentKit MPC vs. self-custodial signer? (Trade-off: ops vs. trust assumption.)
- Fee model: who pays Base L2 gas -- the agent's own USDC balance (auto-swap) or a separately-funded ETH gas reserve?
- How to reconcile `AgentState` with on-chain balances on every run (poll vs. event subscription)?
- Killswitch escalation: should the drawdown lock also auto-withdraw funds to a cold address, or only halt trading?
- Sentiment integration: when (and how) do we let the LLM see news without the panic-selling failure mode flagged in v1 PRD section 4?
- Does the cron model still fit, or do we move to event-driven (WebSocket) immediately for v3?
- **`ExecutionAdapter` interface shape.** The adapter must accept an authorized `TradeIntent` and return an execution result with real fee and slippage data. Define the TypeScript interface before any v3 implementation begins.
- **Volume-weighted cost basis tracking.** v2 anchors realised PnL to the most recent BUY only. v2.1 fixes this with weighted-average cost basis on `AgentState`. v3 must ensure the live adapter updates cost basis atomically with the on-chain execution.

## Drawbacks / risks

- Real money at risk. Any unhandled bug can create loss. Initial live capital,
  maximum exposure, and drawdown thresholds must be approved in the accepted
  RFC and enforced by the same deterministic policy used in paper mode.
- Regulatory ambiguity around autonomous trading agents in some jurisdictions -- owner's responsibility.
- AgentKit + Base L2 dependency surface is new; failure modes not yet observed in production.

## Alternatives

- **Skip live trading, run paper indefinitely:** acceptable but defeats the project's stated end-state.
- **Live trading on a different chain (Solana, ETH L1):** rejected -- Base L2 fee structure is the only one viable at the $50 trade size per the v1 fee analysis.
