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
  update-issue:
    target: "*"
  create-issue:
    title-prefix: "[factory-status] "
    labels: [agentic-factory, report]
    allowed-labels: [agentic-factory, report]
    max: 1
    deduplicate-by-title: 1
  noop:
    report-as-issue: false
max-ai-credits: 1000
max-daily-ai-credits: 2500
---

# Daily Repo Status

Create or refresh one canonical factory status issue for Project Krypto. Focus
on delivery-loop health, not issue volume. Do **not** create, suggest, or scope
new feature issues.

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
11. **Autonomy funnel** — counts in `ready-for-ai-dev`, `factory:claimed`,
    `factory:implementing`, `factory:pr-open`, `factory:repairing`,
    `factory:merged`, `factory:deployed-dev`, and `factory:done`.
12. **Hard invariants** — duplicate claims, multiple PRs per issue, malformed
    lifecycle/risk labels, stale leases, boundary PRs without human approval,
    and production/live automation attempts.
13. **Reliability** — assignment success, first-pass CI, bounded repair,
    canary, dev deployment, and rollback outcomes.

## Rules

- Use repository data only; do not speculate or generate new feature scope.
- Search for the canonical open `[factory-status]` issue. Use `update-issue`
  when it exists; create it only when absent.
- Use `noop` only if there is no meaningful repository activity and no open work to report.
