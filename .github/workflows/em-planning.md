---
description: Engineering manager planning and ticket decomposition.
on:
  workflow_dispatch:
    inputs:
      scope:
        description: Issue number, epic, or planning scope
        required: false
        type: string
  slash_command:
    name: plan
    events: [issues, issue_comment]
    strategy: centralized
  issues:
    types: [labeled]
    names: [ready-for-planning]
permissions:
  contents: read
  issues: read
  pull-requests: read
  copilot-requests: write
imports:
  - .github/agents/engineering-manager.md
tools:
  github:
    mode: gh-proxy
    toolsets: [default]
network: defaults
safe-outputs:
  add-comment:
    max: 1
    hide-older-comments: true
  create-issue:
    title-prefix: "[plan] "
    labels: [agentic-factory]
    max: 10
    group: true
    deduplicate-by-title: 1
  add-labels:
    allowed: [ready-for-ai-dev, needs-rubber-duck, needs-qa, security-review, trading-safety, docs-sync]
    max: 8
  noop:
    report-as-issue: false
max-ai-credits: 1200
max-daily-ai-credits: 3000
---

# EM Planning

Break approved work into small, sequenced implementation tickets.

## Task

- Read the target issue or planning scope.
- Identify dependencies, parallel work, blockers, risks, and owners by role.
- Create implementation-ready child/follow-up issues when needed.
- State the definition of done and validation plan for each ticket.

## Safe outputs

- Use `add-comment` for the plan summary.
- Use `create-issue` for child tickets.
- Use `add-labels` to mark clear next-state labels.
- Use `noop` if the scope is not ready for planning.
