# `src/agent` — agent runtime

Scoped delta to root [`AGENTS.md`](../../AGENTS.md). Read the root safety kernel
first, then apply these specifics.

## Mission

Own the decision loop and run orchestration: `decision.ts` (structured LLM
proposal), `run-flow.ts` (invocation lease + journaling), `llm.ts`, `index.ts`.

## Non-negotiables (delta)

- The model is **read-only**: `decision.ts` returns exactly one structured
  `HOLD`/`BUY`/`SELL` proposal validated by `tradeDecisionSchema`. Never give the
  model a mutating trade tool or let it execute.
- Preserve idempotent invocation acquisition and the owned, expiring run lease.
- Authorization and execution belong to `src/trading` — see
  [`../trading/AGENTS.md`](../trading/AGENTS.md). Do not inline policy or
  accounting logic here.
- Keep typed error classification (`classifyLlmError`); no broad catches or
  silent fallbacks.

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
  authorization → **trading safety review** and, if live-adjacent, an RFC.
- Agents may author control-plane implementation changes, but they are
  `risk:boundary`: never auto-repaired or auto-merged, and gated by an
  authorized repository administrator's explicit merge after all applicable
  current-head checks pass. Do not edit
  `.github/agentic-policy.json` merge/authority semantics or perform a
  human-only action listed in the root map.
