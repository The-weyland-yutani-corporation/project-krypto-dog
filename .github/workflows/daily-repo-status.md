---
description: Daily Project Krypto factory status report focused on throughput, aging, and blocked work. Does not generate new feature scope.
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
    allowed-labels: [agentic-factory, report]
    max: 1
    close-older-issues: true
  noop:
    report-as-issue: false
max-ai-credits: 1000
max-daily-ai-credits: 2500
---

# Daily Repo Status

Create a concise daily factory status report for Project Krypto. Focus on throughput, issue aging, and blocked work. Do **not** create, suggest, or scope new feature issues.

## Include

1. **Milestone progress** — open/closed issue counts per milestone (v2.1, v2.2, v3, Deferred: Strategy Research).
2. **Throughput** — issues closed in the last 7 days vs. issues opened in the last 7 days. Flag if opening rate exceeds closing rate.
3. **WIP aging** — list any `in_progress` or `ready-for-ai-dev` issues older than 5 days with their age in days.
4. **Blocked work** — list all issues with the `blocked` label and their blocking reason if stated.
5. **Open PRs** — grouped by review state (draft, needs-review, approved, failing CI).
6. **Failing or recently failed CI runs** — name, branch, and failure type.
7. **Stale items** — open issues with no activity in > 14 days that need human attention.
8. **High-risk work** — anything touching trading, guardrails, auth, workflows, database state, or deployment.
9. **WIP gate status** — count of open `opportunity` issues without the `blocked` label; flag if ≥ 20 (opportunity-discovery noop threshold).
10. **Recommended next actions** — up to 3 concrete actions for the next 24 hours based only on existing work; do not invent new scope.

## Rules

- Use repository data only; do not speculate or generate new feature scope.
- Create one issue with the configured `create-issue` safe output.
- Use `noop` only if there is no meaningful repository activity and no open work to report.
