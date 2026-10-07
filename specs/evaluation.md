# Evaluation
- Freeze commit/image, strategy/model/config, balances, data, costs, benchmarks, dates, exclusions, sample size, and stop rules before an evidence window; retain immutable favorable and unfavorable results.
- Report net PnL, equity, drawdown, risk-adjusted metrics when valid, turnover/fees, cash and buy-and-hold comparisons, run/trade outcomes, failures, freshness, attribution, and operational incidents; unavailable values are `null`.
- Retuning, selective omission, balance resets, benchmark replacement, or rule changes end the window and require a new version.
- Acceptance requires intact deterministic guardrails, lease, idempotency, reconciliation, alerts, rollback, backup/restore, and paper/live isolation; evidence never authorizes production or live trading.
- Factory evaluation uses versioned public-safe fixtures for routing, authorization, lifecycle, repair, regressions, latency, tokens, and cost.
- Live-model trials and CorrectionOps are report-only and cannot mutate policy, authorization, guardrails, leases, reconciliation, accounting, or the paper/live boundary.
