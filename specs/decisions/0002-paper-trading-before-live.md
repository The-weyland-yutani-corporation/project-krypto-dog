# 0002 — Paper trading before live AgentKit

- **Status:** Accepted
- **Date:** 2026-03-15
- **Deciders:** @VeVarunSharma

## Context

The v1 PRD stated that v1 "operates with a strict $200 USD capital pool" and explicitly framed the goal of v1 as debugging the agentic loop, prompt engineering, and guardrail behaviour rather than profit. The v2 PRD reaffirmed this by deferring "Live Coinbase AgentKit execution (real trades on Base L2)" to v3.

The question was where to draw the v1/v2 vs. v3 line: at the AgentKit integration boundary, or at the moment real money flows.

## Decision

**v1 and v2 are 100% paper trading.** No funds move on chain. The system models trades by:

- Fetching real Coinbase spot prices.
- Modelling 0.3% fees and 1% slippage tolerance.
- Writing `TradeExecution` rows and updating `AgentState` balances *as if* the trade had happened.
- Returning trade-result strings to the LLM that look identical to live ones.

Live AgentKit execution is gated behind a separate ship event (v3) preceded by:
1. ≥30 days of stable paper-trading data with positive expected value.
2. Manual review of all guardrails under realistic load.
3. A live-trading RFC (see `rfcs/0001-v3-live-trading.md`).

## Consequences

- **Positive:** The entire infra (cron, mutex, guardrails, observability, admin) can be deployed and observed in production with zero financial risk. Bugs in the loop cost token budget, not capital.
- **Positive:** Sharp upgrade boundary — v3 swaps `safeTradeHandler`'s "log to DB" with "call AgentKit" and nothing else needs to change.
- **Trade-off:** Paper-trade fees are modelled, not real. Real Base L2 fees may differ; v3 must re-validate EV math.
- **Trade-off:** No real-execution latency data until v3.

## Alternatives considered

- **Skip paper trading, go live with $200 immediately:** rejected — too many infra unknowns (cron reliability, mutex correctness, admin auth, alert deliverability) to risk even small capital.
- **Local paper trading only, deploy directly to live:** rejected — production-shaped traffic surfaces problems local runs hide (cold starts, env-var issues, network egress).
