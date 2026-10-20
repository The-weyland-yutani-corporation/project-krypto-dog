# `src/agent` — agent runtime

Scoped delta to root [`AGENTS.md`](../../AGENTS.md). Read the root delivery contract
first, then apply these specifics.

## Mission

Own the decision loop and run orchestration: `decision.ts` (structured LLM
proposal), `run-flow.ts` (invocation lease + journaling), `llm.ts`, `index.ts`.

## Non-negotiables (delta)

- The model is read-only: `decision.ts` returns one structured
  `HOLD`/`BUY`/`SELL` proposal validated by `tradeDecisionSchema`, never an
  executable command or mutating trade tool.
- Preserve idempotent invocation acquisition and the owned, expiring run lease.
- Keep authorization and accounting in `src/trading`; do not inline or bypass
  them in the orchestration loop.
- Preserve typed error classification, journaling, and alerts. No broad
  catches or silent fallbacks.

## Inputs / outputs

- Inputs: account + market snapshots, `StrategyConfig`.
- Output: a policy-evaluable `DecisionResult`; failures journal and alert.

## Validation

- `npm test -- --ci` (agent + decision suites; `src/agent/decision.ts` carries a
  high coverage threshold).
- The harness selects the deterministic decision provider in validated
  non-production mock/shadow mode via `resolveDecisionProvider`; it never gives
  the model a mutating tool. Cover provider selection with
  `npm test -- tests/agent/decision-provider.test.ts`.
- `npm run lint`, `npm run build`.

## Escalation / non-goals

- Changing the paper/live boundary, adding trade tools, or altering guardrail
  authorization → **trading safety review** and, if live-adjacent, an accepted
  governance proposal and release plan.
- Agents may author control-plane implementation changes within issue scope.
  Boundary risk requires current-head automated QA/security verification,
  not a blanket human merge requirement. Preserve application invariants.
