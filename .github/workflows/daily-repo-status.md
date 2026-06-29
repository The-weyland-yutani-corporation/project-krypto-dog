---
description: Daily Project Krypto factory status report.
on:
  workflow_dispatch:
  schedule: daily
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
network: defaults
safe-outputs:
  create-issue:
    title-prefix: "[factory-status] "
    labels: [agentic-factory, report]
    max: 1
    close-older-issues: true
  noop:
    report-as-issue: false
max-ai-credits: 1000
max-daily-ai-credits: 2500
---

# Daily Repo Status

Create a concise daily factory status report for Project Krypto.

## Include

- Open issues grouped by factory state label.
- Open PRs grouped by review state.
- Failing or recently failed CI runs.
- Stale items that need human attention.
- Any high-risk work touching trading, guardrails, auth, workflows, database state, or deployment.
- Recommended next actions for the next 24 hours.

## Rules

- Use repository data; do not speculate beyond available evidence.
- Create one issue with the configured `create-issue` safe output.
- Use `noop` only if there is no meaningful repository activity and no open work to report.
