# `src/trading` - policy and paper executor

Read the root [`AGENTS.md`](../../AGENTS.md) delivery contract first.

## Mission

Own deterministic trade policy and transactional paper execution:
`policy.ts` (`evaluateTradePolicy`, `authorizeTradeIntent`),
`paper-execution.ts`, `paper-executor.ts`, `accounting.ts`,
`strategy-config.ts`, `errors.ts`, and `types.ts`.

## Application invariants

- Execution remains paper-only. Software-delivery autonomy does not enable
  exchange orders, real-money execution, custody, or transfers.
- The model proposes one structured decision and never receives a mutating
  trade tool. Authorization and execution remain deterministic.
- Preserve eligibility, sizing, balances, exposure, DCA, stop-loss, freshness,
  reconciliation, and paper-mode checks inside the transactional executor.
- Preserve drawdown lock, cooldown, operator pause, idempotency, and the
  owned/expiring run lease. Do not silently weaken any of these checks.
- Accounting remains correct and transactional. Failures journal and alert;
  no silent fallback, automatic drift correction, or guardrail bypass.

## Validation

Run the relevant policy, paper-execution, and accounting suites, plus
`npm run lint` and `npm run build`; keep existing coverage thresholds.
Every trading-path change requires the current-head trading-safety review
selected by `.github/agentic-policy.json`. This is automated verification,
not a blanket human approval gate for paper-only software changes.

UI and formatting of trading data follow root `DESIGN.md`.