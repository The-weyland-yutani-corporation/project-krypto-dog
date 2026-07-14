# Evaluation Criteria

This document defines how Project Krypto measures strategy performance. It governs
what counts as evidence, how datasets are versioned, and what comparisons are
required before advancing to the next rollout phase.

See `specs/readiness.md` for the current baseline results and release gates.

---

## 1. Why separate evaluation criteria from the PRD

`specs/prd.md` states the current product. This document states how we determine
whether the product is working. Keeping these separate prevents aspirational
language in the PRD from being interpreted as a claimed result, and prevents
evaluation shortcuts from being buried in roadmap prose.

Key principle (ADR 0007): no guaranteed-profit language. A strategy is considered
validated only when it satisfies the criteria in this document over a defined
evaluation window. Passing engineering fixture tests is a necessary but not
sufficient condition for that validation.

---

## 2. Metric definitions

| Metric | Definition | Notes |
|---|---|---|
| Final equity | Closing `portfolioValueUSD` at end of evaluation window | Includes unrealised position at mark-to-market using the closing ETH spot price |
| Net PnL | Final equity minus starting equity | Starting equity is `portfolioValueUSD` at the first observation in the window |
| Total fees | Sum of `feesUSD` across all `TradeExecution` rows in the window | Modelled at 0.3% in paper mode |
| Realised PnL | Sum of `pnlUSD` on SELL rows in the window | Requires correct weighted-average cost basis (v2.1+) |
| Max drawdown | Largest peak-to-trough decline in `portfolioValueUSD` during the window | Expressed as a percentage of the peak value observed in the window |
| Trade count | Number of `TradeExecution` rows in the window | Report BUY and SELL counts separately |
| Win rate | Fraction of SELL trades with positive `pnlUSD` | Meaningful only with correct cost-basis accounting |
| Sharpe ratio (annualised) | Mean daily return divided by the sample standard deviation of daily returns, multiplied by sqrt(252) | Runner returns `null` with fewer than two daily returns or zero variance; >= 30 daily observations are required for interpretation |
| Sortino ratio (annualised) | Mean daily return divided by root-mean-square negative daily return, multiplied by sqrt(252) | Runner returns `null` when there is no downside deviation |
| Calmar ratio | Geometrically annualised return (365.25-day year) divided by maximum drawdown | Runner returns `null` for a zero drawdown or invalid/empty window |
| Turnover | Total traded notional divided by average equity | High turnover may indicate fee-generating overactivity |
| Fee efficiency | Net PnL divided by total fees plus modeled slippage | Returns `null` when modeled execution friction is zero |
| Profit factor | Gross profit on winning exits divided by gross loss on losing exits | Returns `null` when there are no losing exits rather than Infinity |
| Benchmark alpha | Strategy return minus buy-and-hold return, in percentage points | Same scenario window and starting capital |
| LLM-cost-adjusted PnL | Net PnL minus an externally supplied LLM cost | Optional; `null` when no cost is supplied because deterministic fixture runs do not call an LLM |
| Cash comparison | Net PnL vs. zero (hold starting USDC, no trades) | Cash baseline is 0% return on the starting equity |
| Buy-and-hold comparison | Net PnL vs. buying ETH at the first window observation price and holding to the end | Requires the ETH spot price at the window start |

---

## 3. Engineering fixtures vs. financial evidence

### Engineering fixtures (synthetic scenarios)

Synthetic scenario files in `scenarios/` are replayed by the backtest runner
against a no-LLM, deterministic rules policy. They are engineering tests, not
financial evidence.

Purpose: verify that the deterministic execution layer (fees, slippage, cooldown,
DCA, drawdown, cost basis, benchmark comparison) produces the correct trade
sequence and equity curve given known inputs.

These scenarios may intentionally represent favorable market conditions for the
strategy (e.g., `dip-recovery.json` is designed as a scenario where a mean-
reversion strategy should perform well). This is acceptable for engineering tests
because the goal is correctness verification, not performance measurement.

**Passing all fixture scenarios does not imply positive expected value in live
or paper markets.**

The aligned runner calls production `evaluateTradePolicy`,
`authorizeTradeIntent`, fixed-point accounting, and the same pure paper-execution
calculator used by the transactional executor. Defaults are 30 bps fees and
15 bps adverse paper slippage. Drawdown snapshots are marked on post-action
equity in the same scenario step.

Decision sources are deterministic:

- `rules-basic`: mandatory production-policy actions always win; otherwise,
  choose the maximum eligible SELL before BUY, then choose the maximum eligible
  BUY, otherwise HOLD.
- `always-hold`: reject every optional action; mandatory production stop-loss
  actions still execute because they override discretion.

Mandatory means independent of model discretion, not unconditional execution:
the production policy still requires fresh validated market data and a
`RECONCILED` account, and shadow mode records the authorized exit without
mutating balances.

Current status after alignment: 8 synthetic fixture scenarios. 3 of 8 beat the
cash baseline, 2 of 8 beat buy-and-hold, and 0 of 8 beat both. See
`specs/readiness.md` §1.

### Financial evidence (out-of-sample paper data)

Financial evidence requires all of the following:

1. Real or realistic market data that was NOT used to tune strategy parameters
   (out-of-sample).
2. An evaluation window defined before the run starts, not after observing the
   outcome.
3. At least 30 calendar days of observations.
4. Cash and buy-and-hold comparisons over the exact same window.
5. No post-hoc exclusion of trades or time periods.

Financial evidence is required before advancing to v2.2 paper mode (Gate 3 in
RFC 0002) and before v3 live trading can be considered.

---

## 4. Dataset and versioning rules

### Paper trading data

Each evaluation run is identified by:

- Start and end date of the evaluation window.
- Starting equity (`portfolioValueUSD` at window start).
- Codebase version: git commit SHA or release tag.
- Rollout mode: `shadow` or `paper`.

Results are summarised in weekly reviews using the monitoring runbook format in
`specs/monitoring.md` and archived as part of the release gate record in
`specs/readiness.md`.

**Do not modify the evaluation window after it starts.** If strategy parameters
or code change mid-window, start a new evaluation window. Do not retroactively
reframe the previous window.

### Synthetic scenarios

- Scenario files in `scenarios/` are version-controlled.
- When a scenario file is modified, existing results for that scenario are
  invalidated and must be re-run.
- Adding new scenarios does not invalidate results for existing ones.
- Scenario results from before a strategy parameter change are not comparable to
  results after the change.

### Cherry-picking prevention

The following practices are prohibited when claiming financial evidence:

- Selecting the evaluation window after observing the outcome.
- Removing trades or time periods from the evaluation because the market was
  "unusual" or "adversarial".
- Using a cash or buy-and-hold baseline computed over a different window than the
  strategy window.
- Using the same dataset to both tune parameters and evaluate performance.

If a scenario is created specifically because the strategy is observed to perform
well in that market condition, label it explicitly as an in-sample fixture, not
financial evidence.

---

## 5. Cash and buy-and-hold comparison

### Cash baseline

Hold the starting equity in USDC with no trades.

- Starting value: `portfolioValueUSD` at window start.
- Ending value: same (USDC earns no yield in this model).
- If final equity is less than the cash baseline, the strategy destroyed value
  compared with doing nothing.

### Buy-and-hold baseline

Buy ETH at the first observation price in the window and hold to the end.

- Buy price: first ETH spot price in the evaluation window.
- Quantity: starting equity divided by buy price (no fees, for simplicity of
  comparison).
- Ending value: quantity multiplied by the final ETH spot price.
- If final equity is greater than the cash baseline but less than buy-and-hold,
  the strategy added value over inaction but underperformed passive ETH exposure.

### Minimum success threshold

A result is considered a **positive signal** (not proof of edge) when all of the
following are true over a predeclared out-of-sample window:

- Final equity exceeds the cash baseline.
- Performance is favorable to buy-and-hold on a risk-adjusted basis.
- Max drawdown is less than 25% of tracked peak equity.
- Annualised Sharpe and Sortino ratios are positive.

A minimum 30-day production paper window remains required, but it is not
statistically sufficient by itself. Multiple non-overlapping historical and
production windows must show consistent results before the v3 RFC can advance
from Draft to Accepted.

---

## 6. Reporting format

Each evaluation result must include:

- Evaluation window: start and end date.
- Codebase version: git commit SHA or release tag.
- Rollout mode: `shadow` or `paper`.
- Starting equity.
- Final equity (mark-to-market at window end).
- Net PnL.
- Total fees.
- Max drawdown (value and percentage of peak equity).
- Trade count (BUY / SELL).
- Win rate (SELL trades only, requires v2.1 cost basis).
- Cash comparison (absolute difference and percentage).
- Buy-and-hold comparison (absolute difference and percentage).
- Annualised Sharpe and Sortino ratios (report sample size and omit when the
  return series is insufficient).
- Calmar ratio, turnover, fee efficiency, and profit factor.
- Total modeled slippage, benchmark alpha, and optional LLM-cost-adjusted PnL.
- Strategy version, fee/slippage cost model, code/report schema version,
  decision source, and scenario/dataset identifier.
- Notes on any market conditions that may affect interpretation (e.g., high
  volatility, broad market crash, exchange outage).
