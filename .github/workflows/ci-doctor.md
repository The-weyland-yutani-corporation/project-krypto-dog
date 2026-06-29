---
description: Diagnoses failed CI runs and opens actionable incident issues.
on:
  workflow_dispatch:
  workflow_run:
    workflows: [CI]
    types: [completed]
    branches:
      - main
      - "develop/**"
if: github.event_name != 'workflow_run' || contains(fromJSON('["failure","cancelled","timed_out","action_required"]'), github.event.workflow_run.conclusion)
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
network:
  allowed: [defaults, node]
safe-outputs:
  create-issue:
    title-prefix: "[ci-doctor] "
    labels: [agentic-factory, ci-failure]
    max: 1
    deduplicate-by-title: 2
  add-comment:
    max: 1
  noop:
    report-as-issue: false
max-ai-credits: 1200
max-daily-ai-credits: 3000
---

# CI Doctor

Diagnose failed CI and produce an actionable incident report.

## Task

- Inspect the failed workflow run, failing jobs, failing steps, and relevant logs.
- Identify whether the failure is deterministic, flaky, infrastructure-related, or caused by a recent code change.
- Search for an existing open `[ci-doctor]` issue with the same failure key before creating a new issue.
- If the failure self-recovered or duplicates an existing issue, use `noop` or `add-comment` instead of opening a duplicate.

## Safe outputs

- Use `create-issue` for new actionable CI incidents.
- Use `add-comment` when the failure belongs on an existing issue or PR.
- Use `noop` for self-recovered, duplicate, or non-actionable failures.
