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
    target: "*"
    max: 1
    hide-older-comments: true
  add-labels:
    target: "*"
    allowed: [needs-qa, security-review, trading-safety, docs-sync, ready-for-human-review]
    max: 5
  create-check-run:
    name: Agentic code review
    max: 1
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
- Resolve the PR from the pull request event or the `pr` workflow-dispatch input.
- For manual dispatch, verify the workflow ref is the target PR head and include the PR number as `item_number` in comments or labels.
- Report only correctness, reliability, maintainability, or product-behavior issues that matter.
- For frontend/admin/chart changes, check that the PR follows root `DESIGN.md`, uses shadcn/ui + Tailwind primitives, and avoids default unstyled chart output.
- Do not comment on style or formatting unless it causes a real defect.
- Use `add-labels` to escalate trading, auth/security, QA, or docs/spec concerns to specialized review labels.
- Always create exactly one `Agentic code review` check on the target PR's current head SHA.
- Set the check to `success` only when there are no required fixes and no specialist escalation is needed.
- Set the check to `failure` for any required fix, unresolved correctness concern, or specialist escalation.

## Safe outputs

- Use `add-comment` for PR findings.
- Use `add-labels` for specialized review escalation.
- Use `create-issue` only for cross-cutting follow-up beyond the PR.
- Use `create-check-run` for the required pass/fail result.
- Use `noop` only when no open PR can be resolved from the trigger.
