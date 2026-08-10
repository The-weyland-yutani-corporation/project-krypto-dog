# 0005 -- Structured LLM intent + hard deterministic authorization

- **Status:** Accepted
- **Date:** 2026-07-14
- **Deciders:** @VeVarunSharma

## Context

In v2, the LLM agent receives risk rules (stop-loss percentage, DCA count, minimum
trade size, trigger thresholds) in the system prompt and is trusted to follow them.
The deterministic code in `src/tools/safe-trade.ts` enforces only the outer bounds
(max trade size, asset whitelist, balance validation). This has two problems:

1. The LLM can ignore prompt instructions. There is no guarantee that the model
   respects stop-loss or DCA constraints on every run.
2. Rule changes require prompt edits, which are not auditable as code changes and
   are not independently tested.

The planned live-trading phase requires that deterministic code enforces every
risk/eligibility/execution rule. This ADR records the decision to adopt a two-layer
architecture to achieve that requirement before any production deployment.

## Decision

Split every trade decision into two explicit layers:

**Layer 1 -- LLM intent.** The LLM produces a narrow, well-typed intent object:

```json
{ "action": "BUY" | "SELL" | "HOLD", "amountUSD": 30.00, "rationale": "..." }
```

The LLM is not recited a list of rule thresholds. It proposes what it wants to do;
the authorization layer decides whether that proposal is permitted.

**Layer 2 -- Deterministic authorization.** A pure TypeScript function
(`authorizeTradeIntent(intent, agentState, marketSnapshot, config)`) enforces every
risk rule: stop-loss, DCA count limit, minimum and maximum trade size, buy/sell
trigger percentages, balance sufficiency, asset whitelist, in-flight pause/lock
re-check. This function is the single, auditable location for all risk logic.

If the authorization layer rejects the intent, no trade is executed. The rejection
reason is logged and written into the journal entry so future runs have context.

If the authorization layer approves (possibly with an adjusted amount), the
execution wrapper records the trade atomically (single DB transaction).

See RFC 0002 for the full proposed design.

## Consequences

- Positive: All risk rules are version-controlled, independently testable TypeScript.
- Positive: `authorizeTradeIntent` is a pure function; full branch coverage is achievable.
- Positive: Prompt changes cannot bypass risk rules.
- Positive: The same authorization layer gates both paper and future live execution.
- Negative: Adds a JSON parsing step between LLM response and execution; malformed
  LLM output must be handled gracefully (treat as HOLD, not crash).
- Negative: Implicit prompt rules must be made explicit in code before this
  architecture can be adopted; ambiguous rules must be clarified first.
- Implemented by the structured decision schema, deterministic
  `evaluateTradePolicy` / `authorizeTradeIntent` boundary, transactional paper
  executor, and their test suites.

## Alternatives considered

- **Status quo (prompt-only rules):** rejected -- not auditable; not reliable for
  real-money execution; cannot be unit-tested independently of an LLM call.
- **Hard-coded constants in safe-trade.ts (no structured intent):** rejected -- does
  not produce a structured authorization result with a reason for logging; does not
  cleanly separate the LLM decision from the execution check.
- **Fine-tune the LLM to follow rules:** rejected -- requires ongoing maintenance,
  does not provide determinism guarantees, and cannot be unit-tested.
