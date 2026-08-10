---
description: Trading and guardrail safety review for risky changes.
on:
  bots: ["github-actions[bot]", "copilot-swe-agent[bot]"]
  workflow_dispatch:
    inputs:
      target:
        description: Issue, PR, or scope to review
        required: true
        type: string
  pull_request:
    types: [opened, synchronize, reopened, labeled]
    paths:
      - "src/trading/**"
      - "src/tools/**"
      - "src/guardrails/**"
      - "src/agent/**"
      - "src/backtest/**"
      - "src/app/api/agent/**"
      - "src/db/**"
      - "drizzle/**"
      - "supabase/migrations/**"
      - "specs/rfcs/**"
  issues:
    types: [labeled]
    names: [trading-safety]
permissions:
  contents: read
  issues: read
  pull-requests: read
  checks: read
  copilot-requests: write
imports:
  - .github/agents/trading-safety-reviewer.md
tools:
  github:
    mode: gh-proxy
    toolsets: [default]
network: defaults
safe-outputs:
  add-comment:
    target: "*"
    max: 1
    hide-older-comments: true
  add-labels:
    target: "*"
    allowed: [trading-safety, ready-for-human-review, needs-qa, blocked]
    max: 4
  create-check-run:
    name: Trading safety review
    max: 1
  create-issue:
    title-prefix: "[trading-safety] "
    labels: [agentic-factory, trading-safety]
    max: 3
    deduplicate-by-title: 1
  noop:
    report-as-issue: false
max-ai-credits: 1600
max-daily-ai-credits: 4000
---

# Trading Safety Review

Review changes for paper-trading, portfolio, guardrail, and live-execution boundary risks.

## Task

- Resolve whether the target is an issue or pull request. For manual PR dispatch, use the `target` input, verify the workflow ref is that PR's current head, and use its number as `item_number` in comments or labels.
- Inspect the target issue or PR and relevant files.
- Verify v2 remains paper trading only.
- Check `safe_trade`, guardrails, mutex behavior, portfolio state, journaling, and alerting invariants.
- Classify the result as `safe`, `safe-with-required-fixes`, or `unsafe`.
- For every pull request, create exactly one `Trading safety review` check on the current head.
- Set the check to `success` only for `safe`.
- Set the check to `failure` for `safe-with-required-fixes`, `unsafe`, or an incomplete review.

## Safe outputs

- Use `add-comment` for the review result.
- Use `add-labels` only for clear next-state labels.
- Use `create-check-run` for every pull-request result.
- Use `create-issue` for separate safety follow-up work.
- Use `noop` only for a non-PR target that cannot affect trading behavior.
