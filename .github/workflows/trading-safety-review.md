---
description: Trading and guardrail safety review for risky changes.
on:
  workflow_dispatch:
    inputs:
      target:
        description: Issue, PR, or scope to review
        required: true
        type: string
  pull_request:
    types: [opened, synchronize, reopened, labeled]
    paths:
      - "src/tools/**"
      - "src/guardrails/**"
      - "src/agent/**"
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
    max: 1
    hide-older-comments: true
  add-labels:
    allowed: [trading-safety, ready-for-human-review, needs-qa, blocked]
    max: 4
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

- Inspect the target issue or PR and relevant files.
- Verify v2 remains paper trading only.
- Check deterministic policy and authorization, transactional paper execution, owned-lease behavior, portfolio state, journaling, and alerting invariants.
- Classify the result as `safe`, `safe-with-required-fixes`, or `unsafe`.

## Safe outputs

- Use `add-comment` for the review result.
- Use `add-labels` only for clear next-state labels.
- Use `create-issue` for separate safety follow-up work.
- Use `noop` when the target cannot affect trading behavior.
