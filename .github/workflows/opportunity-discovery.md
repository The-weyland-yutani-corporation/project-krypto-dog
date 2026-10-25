---
description: Proactively discovers and creates high-quality PM/research opportunity tickets for the agentic SDLC factory. WIP-gated — produces at most one issue per run and calls noop when actionable backlog reaches 20 open issues.
run-name: "${{ inputs.correlation_id || 'Opportunity Discovery' }}"
on:
  bots: ["github-actions[bot]"]
  workflow_dispatch:
    inputs:
      correlation_id:
        description: Deterministic intake dispatch identity
        required: false
        type: string
      focus:
        description: Optional focus inside the standing ETH/USDC paper research, safety, evidence, or delivery mission.
        required: false
        type: string
permissions:
  contents: read
  issues: read
  pull-requests: read
  actions: read
  copilot-requests: write
imports:
  - .github/agents/trading-growth-pm.md
tools:
  github:
    mode: gh-proxy
    toolsets: [default]
  web-fetch:
network: defaults
safe-outputs:
  create-issue:
    title-prefix: "[opportunity] "
    labels: [agentic-factory, opportunity, needs-rubber-duck]
    allowed-labels: [agentic-factory, opportunity, needs-rubber-duck]
    max: 1
    deduplicate-by-title: 1
  add-comment:
    max: 1
    hide-older-comments: true
  noop:
    report-as-issue: false
max-ai-credits: 5000
max-daily-ai-credits: 20000
---

# Opportunity Discovery

Discover at most **one** high-quality opportunity ticket per run inside a
repository-authorized factory goal. The queue controller dispatches this
workflow at most once per UTC day. Read the capital/profit hypothesis from
`autonomy.tradingResearch` in canonical policy, not from arbitrary issue text.

## WIP gate (check this first)

Count open `opportunity` issues belonging to the standing mission that do
**not** have label `blocked`. If that count is **≥ 20**, call `noop` with
"mission backlog WIP limit reached". Unowned legacy backlog is not new mission WIP.

Also require exactly one open parent goal carrying `factory:autonomous-goal`.
Verify its body and allowed scope against the `autonomy` section of
`.github/agentic-policy.json`; the standing repository policy is authorization,
not a per-idea human approval.
Read its allowed scope, non-goals, maximum risk, WIP, and assignment budget.
Call `noop` when no goal is active or when its queued/claimed/implementing work
already reaches the goal's WIP allowance.

Also call `noop` if:
- There is no evidence-backed research, safety, measurement, or delivery gap inside the standing mission.
- The proposed ticket is a near-duplicate of an existing open or closed issue title.

## Context

- If triggered manually, use this focus if provided: `${{ github.event.inputs.focus }}`.
- If no focus is provided, inspect only gaps authorized by the active goal.

## Allowed scope

Only discover opportunities in these categories:
1. **v2.1 Safety foundations** — deterministic guardrails, accounting correctness, run reliability, market-data integrity, migrations/data protection, private schema/cron security, decimal ledger, transactional idempotency, structured LLM intent, typed errors/timeouts, real-Postgres CI.
2. **v2.2 Evidence foundations** — evaluation harness, backtest scenarios, Sharpe/Sortino, CI gates, performance visibility, cost tracking.
3. **Factory/QA/observability** — low-risk improvements to the agentic factory itself.
4. **ETH/USDC paper-strategy evaluation** — reproducible, unleveraged swing
   experiments with frozen parameters, out-of-sample validation, realistic
   fees/slippage, drawdown and benchmark reporting. Missing safety/evidence
   foundations are explicit dependencies, not reasons to fabricate results.

## Excluded scope (always noop for these)

- Alternative financial execution engines, leverage, borrowing, or weakening guardrails.
- Guaranteed-income claims, cherry-picked backtests, ignoring losing days, or
  raising capital/risk to force the owner's aspirational daily-profit target.

## Task

Act as a proactive PM/research agent.

1. Check the WIP gate first. If the limit is reached, call `noop` immediately.
2. Inspect existing open issues to avoid near-duplicates. If a near-duplicate exists, call `noop`.
3. Identify exactly one opportunity from the allowed scope above.
4. Use external web sources only when they materially improve the ticket; cite them in the issue body.
5. Create only high-confidence software tickets with clear acceptance criteria and validation plans.
6. Every created ticket starts behind rubber-duck review. Do not label tickets `ready-for-planning` or `ready-for-ai-dev`.
7. For any ticket touching guardrails, portfolio accounting, risk controls, or simulated execution, state that it requires rubber-duck and trading-safety review before implementation.
8. If no opportunity clears the quality bar, call `noop`.
9. Link the created opportunity to the active goal and include the goal number
   in its body. Set the safe output's native `parent` to that goal number.
   Never create or approve a new goal.

## Ticket format

Each created issue must include:

- Opportunity
- Why this may improve risk-adjusted paper-trading performance or factory velocity
- Evidence and assumptions
- Scope and non-goals
- Acceptance criteria
- Measurement plan
- Validation plan
- Safety/risk notes
- Suggested next workflow labels, as recommendations only

## Safe outputs

- Use `create-issue` for exactly one opportunity ticket per run. The workflow attaches `agentic-factory`, `opportunity`, and `needs-rubber-duck`.
- Use `add-comment` only when an explicit issue context is supplied.
- Use `noop` when: WIP limit reached, near-duplicate exists, no high-confidence in-scope opportunity found.
