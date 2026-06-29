---
description: Product manager triage for new or labeled issues.
on:
  workflow_dispatch:
    inputs:
      issue:
        description: Issue number to triage
        required: false
        type: string
  issues:
    types: [opened, reopened, labeled]
permissions:
  contents: read
  issues: read
  pull-requests: read
  copilot-requests: write
imports:
  - .github/agents/product-manager.md
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
    allowed: [agentic-factory, needs-triage, ready-for-planning, needs-rubber-duck, ai:research, needs-qa, security-review, trading-safety, docs-sync]
    max: 6
  create-issue:
    title-prefix: "[pm] "
    labels: [agentic-factory]
    max: 5
    deduplicate-by-title: 1
  noop:
    report-as-issue: false
max-ai-credits: 1000
max-daily-ai-credits: 3000
---

# PM Triage

Refine the issue into an implementation-ready work item.

## Task

- Read the issue title, body, comments, labels, and relevant repository context.
- Identify the user/system problem, scope, non-goals, acceptance criteria, and validation plan.
- Recommend priority and risk.
- Add state labels when appropriate.
- Create follow-up issues only for clearly separate work.

## Safe outputs

- Use `add-comment` with the triage result.
- Use `add-labels` for factory state transitions.
- Use `create-issue` for separate follow-up tickets.
- Use `noop` for duplicates, spam, or issues that are already implementation-ready.
