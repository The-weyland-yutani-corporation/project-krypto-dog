---
description: Weekly governance report for GH-AW cost, outcomes, noise, and factory health.
on:
  workflow_dispatch:
  schedule: weekly on monday
permissions:
  contents: read
  issues: read
  pull-requests: read
  actions: read
  checks: read
  copilot-requests: write
tools:
  github:
    mode: gh-proxy
    toolsets: [default]
  bash:
    - gh aw status
    - gh aw health
    - gh aw logs
    - gh aw outcomes
network: defaults
safe-outputs:
  create-issue:
    title-prefix: "[factory-governance] "
    labels: [agentic-factory, report]
    allowed-labels: [agentic-factory, report]
    max: 1
    close-older-issues: true
  noop:
    report-as-issue: false
max-ai-credits: 1000
max-daily-ai-credits: 2500
---

# Agentic Governance

Create a weekly governance report for the GH-AW software factory.

## Include

- Which workflows ran and whether they succeeded.
- Which safe outputs were accepted, ignored, closed, or merged.
- Noisy workflows, duplicate outputs, or low-value automation.
- AI-credit and runtime concerns when available.
- Recommended workflow tuning.
- If `gh aw` commands are unavailable in the runner, report the missing tool instead of inventing metrics.

## Safe outputs

- Use `create-issue` for the weekly report.
- Use `noop` if no GH-AW runs or outcomes exist yet.
