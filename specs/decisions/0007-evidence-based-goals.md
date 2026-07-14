# 0007 -- Evidence-based goals and removal of guaranteed-profit language

- **Status:** Accepted
- **Date:** 2026-07-14
- **Deciders:** @VeVarunSharma

## Context

`specs/prd.md` §1 previously stated a Phase 2 end-state of "$100/day passive
profit (mathematically: 0.5% daily return on $20,000)." RFC 0001 repeated this
figure as the target for v3 live trading.

This framing has several problems:

1. **It presents a profit target as a product commitment.** No trading strategy
   guarantees a specific daily return. Stating it in the PRD implies the system
   will achieve it.

2. **It conflates roadmap aspiration with validated evidence.** The $100/day
   figure was a motivating aspiration, not a result of backtesting or paper
   trading. At the time of this ADR, the v2 synthetic fixture results show
   3 of 8 scenarios beating the cash baseline, 2 of 8 beating buy-and-hold,
   and 0 of 8 beating both.
   These are engineering tests, but they do not support a $100/day claim.

3. **It sets the wrong first-order success criterion.** "Did we achieve $100/day?"
   is not the right question to ask of a paper-trading system. The right question
   is: "Does the strategy produce positive risk-adjusted returns relative to
   cash and buy-and-hold over an out-of-sample evaluation period?"

4. **It cannot be made true by documentation.** Writing it in a spec does not
   make it achievable; it only misleads future readers about what the system does.

## Decision

Remove "$100/day passive profit" and equivalent guaranteed-profit language from
`specs/prd.md` and `specs/rfcs/0001-v3-live-trading.md`.

Replace with evidence-based success criteria (detailed in `specs/evaluation.md`):

- **Primary criterion:** Aggregate out-of-sample results are positive after
  modeled fees, slippage, and LLM cost.
- **Benchmark criterion:** Results are favorable to both cash and buy-and-hold
  on a risk-adjusted basis; a strong bull window is not failed solely because
  raw buy-and-hold return is higher.
- **Risk criterion:** Max drawdown remains below 25% of tracked peak equity.
- **Signal quality criterion:** Sharpe and Sortino ratios are positive and are
  reported with sample-size caveats.

Long-term aspirations (capital scaling, compounding returns) are preserved in RFCs
as goals that are contingent on demonstrated positive expected value, not as product
commitments.

## Consequences

- Positive: The PRD no longer claims an outcome that cannot be guaranteed.
- Positive: Success criteria are falsifiable and measurable; evaluation methodology
  is documented in `specs/evaluation.md`.
- Positive: Future contributors and reviewers understand that evidence gates are
  required before scaling capital or enabling live trading.
- Negative: Less immediately compelling framing for early readers of the PRD.
- Follow-ups: Update PRD Vision section. Update RFC 0001 Summary. Add
  `specs/evaluation.md` with full metric definitions and anti-cherry-picking rules.

## Alternatives considered

- **Keep the target but add a disclaimer:** rejected -- disclaimers are easier to
  overlook than removing the claim. The target belongs in an RFC as an aspiration,
  not in the PRD as a stated goal.
- **Move the target to a separate "goals" document:** rejected -- it is an
  aspiration contingent on evidence, not a product fact. It does not belong in
  any document that describes what the system currently does or commits to do.
