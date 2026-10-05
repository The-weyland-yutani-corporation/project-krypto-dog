# `src/trading` — policy & paper executor

Scoped delta to root [`AGENTS.md`](../../AGENTS.md). Read the root safety kernel
first. This is the highest-risk area in the repo.

## Mission

Own deterministic trade policy and transactional paper execution:
`policy.ts` (`evaluateTradePolicy`, `authorizeTradeIntent`),
`paper-execution.ts` / `paper-executor.ts`, `accounting.ts`,
`strategy-config.ts`, `errors.ts`, `types.ts`.

## Non-negotiables (delta)

- **Paper only.** No live-execution code path here without an accepted
  governance proposal and release plan.
- `evaluateTradePolicy`, `authorizeTradeIntent`, and the transactional executor
  must keep enforcing eligibility, sizing, balance, exposure, DCA, stop-loss,
  freshness, reconciliation, and paper-mode invariants.
- Drawdown lock, cooldown, operator pause, idempotency, and owned-lease behavior
  must not be weakened silently.
- Accounting reconciliation must stay correct and transactional; failures
  journal and alert.

## Validation

- `npm test -- --ci` — policy, paper-execution, and accounting suites carry high
  coverage thresholds; keep them green.
- `npm run lint`, `npm run build`.

## Escalation / non-goals

- **Every change here routes to trading safety review** (see
  `specialistRouting.tradingSafety` in
  [`.github/agentic-policy.json`](../../.github/agentic-policy.json)).
- Paper-only changes may be agent-authored and merged after their deterministic
  and specialist checks pass. Live-trading enablement remains human-only; stop
  and escalate.
- UI/formatting of trading data belongs to the frontend under `DESIGN.md`.
