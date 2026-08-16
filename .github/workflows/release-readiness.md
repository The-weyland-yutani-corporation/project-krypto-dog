---
description: Release readiness checklist and operator handoff.
on:
  workflow_dispatch:
    inputs:
      target:
        description: Release, PR, branch, or deployment scope
        required: false
        type: string
  slash_command:
    name: release-readiness
    events: [issues, issue_comment, pull_request, pull_request_comment]
    strategy: centralized
  pull_request:
    types: [labeled]
    names: [release-readiness]
permissions:
  contents: read
  issues: read
  pull-requests: read
  actions: read
  checks: read
  deployments: read
  copilot-requests: write
runs-on-slim: "${{ vars.CI_RUNNER_LABEL || 'ubuntu-slim' }}"
imports:
  - .github/agents/release-manager.md
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
    title-prefix: "[release-readiness] "
    labels: [agentic-factory, release-readiness]
    max: 3
    deduplicate-by-title: 1
  noop:
    report-as-issue: false
max-ai-credits: 1200
max-daily-ai-credits: 3000
---

# Release Readiness

Produce a release readiness checklist and operator handoff.

## Task

- Inspect the target release scope, related PRs/issues, CI status, migrations, docs, and deployment runbook.
- Identify required secrets, environment changes, migrations, smoke tests, rollback steps, and operator actions.
- Block release readiness for unresolved high-risk issues.

## Safe outputs

- Use `add-comment` for the checklist on the triggering issue or PR.
- Use `create-issue` for release blockers that need tracking.
- Use `noop` when there is no release scope to evaluate.
