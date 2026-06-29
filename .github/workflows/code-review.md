---
description: High-signal automated PR review for correctness and maintainability.
on:
  workflow_dispatch:
    inputs:
      pr:
        description: Pull request number
        required: false
        type: string
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
permissions:
  contents: read
  pull-requests: read
  issues: read
  checks: read
  copilot-requests: write
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
    allowed: [needs-qa, security-review, trading-safety, docs-sync, ready-for-human-review]
    max: 5
  create-issue:
    title-prefix: "[review-followup] "
    labels: [agentic-factory, needs-ai-review]
    max: 3
    deduplicate-by-title: 1
  noop:
    report-as-issue: false
max-ai-credits: 1500
max-daily-ai-credits: 5000
---

# Code Review

Review the PR for real defects only.

## Task

- Inspect the PR diff, changed files, tests, and CI status.
- Report only correctness, reliability, maintainability, or product-behavior issues that matter.
- For frontend/admin/chart changes, check that the PR follows root `DESIGN.md`, uses shadcn/ui + Tailwind primitives, and avoids default unstyled chart output.
- Do not comment on style or formatting unless it causes a real defect.
- Use `add-labels` to escalate trading, auth/security, QA, or docs/spec concerns to specialized review labels.

## Safe outputs

- Use `add-comment` for PR findings.
- Use `add-labels` for specialized review escalation.
- Use `create-issue` only for cross-cutting follow-up beyond the PR.
- Use `noop` when there are no actionable findings.
