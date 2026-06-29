# 0001 — v3: Live Coinbase AgentKit execution

- **Status:** **Draft (stub)** — high-level placeholder. Full design in a separate RFC pass once v2 is deployed and producing data.
- **Date opened:** 2026-05-02
- **Author:** @VeVarunSharma

## Summary

Promote the agent from paper trading to **live execution on Base L2 via Coinbase AgentKit**, beginning with the existing $200 capital pool and scaling toward the $100/day passive-profit end-state described in `specs/prd.md` §1.

This is the boundary at which real money starts moving. **Do not start v3 implementation until v2 has produced ≥30 days of stable paper-trading data with documented positive expected value.**

## Motivation

The v1/v2 PRDs explicitly carve out paper trading as a stepping stone (see ADR `0002-paper-trading-before-live.md`). v3 is the goal those steps were taken for.

## Scope (high-level — to be expanded)

In scope:

- Replace `safeTradeHandler`'s "log + update AgentState" body with an AgentKit live trade against an MPC wallet on Base L2.
- Real fee accounting (gas + DEX swap fee) replacing modelled 0.3%.
- Real slippage handling (currently 0; tolerance is 1%).
- MPC wallet provisioning, key custody plan, recovery procedure.
- Pre-deploy capital reconciliation (does on-chain balance match `AgentState`?).
- Sentiment / news feed evaluation (LLM tends to overreact — guarded mitigation needed).
- Trailing-stop and limit-order tools.
- Capital-scaling ramp ($200 → $1k → $5k → $20k) with explicit stop-and-review checkpoints.
- WebSocket-triggered runs (volatility-based) replacing the hourly cron once volatility data is reliable.
- Backtesting harness (replay historical candles through `runAgent` to estimate strategy performance).

Out of scope (still): non-ETH/USDC pairs, leverage, perpetuals, derivatives.

## Pre-conditions before this RFC can move from Draft → Accepted

1. v2 deployed and running for ≥30 calendar days.
2. PostHog dashboards show: ≥1 trade per day on average; cooldown + drawdown guardrails firing as expected; no unhandled errors in `agent_run_completed` events.
3. Daily-summary email reports show positive cumulative `pnlUSD` (computed correctly — see plan item `T-pnl-compute`).
4. Manual review of `AgentJournal` confirms the LLM is reasoning sensibly, not gaming the strategy parameters.
5. Documented MPC wallet provisioning + recovery plan reviewed by the owner.
6. Live trading risk register: maximum-loss scenarios identified and mitigations agreed.

## Open questions (to be answered in the full RFC)

- AgentKit MPC vs. self-custodial signer? (Trade-off: ops vs. trust assumption.)
- Fee model: who pays Base L2 gas — the agent's own USDC balance (auto-swap) or a separately-funded ETH gas reserve?
- How to reconcile `AgentState` with on-chain balances on every run (poll vs. event subscription)?
- Killswitch escalation: should the drawdown lock also auto-withdraw funds to a cold address, or only halt trading?
- Sentiment integration: when (and how) do we let the LLM see news without the panic-selling failure mode flagged in v1 PRD §4?
- Does the cron model still fit, or do we move to event-driven (WebSocket) immediately for v3?
- **Volume-weighted cost basis tracking.** v2 anchors realised PnL to the *most recent* BUY only (queried from `TradeExecution`). DCA chains skew this — we need either a `costBasisETH` column on `AgentState` updated on every BUY/SELL, or a derived view that aggregates across open positions.

## Drawbacks / risks

- Real money at risk. Any unhandled bug = real loss. The strict $200 cap and $150 drawdown lock provide a hard floor for the initial phase.
- Regulatory ambiguity around autonomous trading agents in some jurisdictions — owner's responsibility.
- AgentKit + Base L2 dependency surface is new; failure modes not yet observed in production.

## Alternatives

- **Skip live trading, run paper indefinitely:** acceptable but defeats the project's stated end-state.
- **Live trading on a different chain (Solana, ETH L1):** rejected — Base L2 fee structure is the only one viable at the $50 trade size per the v1 fee analysis.
