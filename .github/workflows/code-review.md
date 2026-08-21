---
description: High-signal automated PR review for correctness and maintainability.
run-name: "${{ inputs.correlation_id || 'Code Review' }}"
on:
  bots: ["github-actions[bot]", "copilot-swe-agent[bot]"]
  workflow_dispatch:
    inputs:
      pr:
        description: Pull request number
        required: false
        type: string
      head_sha:
        description: Exact pull request head to review
        required: false
        type: string
      correlation_id:
        description: Reconciler run correlation
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
pre-agent-steps:
  - name: Restore trusted agent instructions
    if: ${{ github.event.pull_request || (github.event_name == 'workflow_dispatch' && inputs.head_sha != '') }}
    env:
      TRUSTED_WORKFLOW_SHA: ${{ github.event.pull_request.base.sha || github.sha }}
    run: node .github/scripts/restore-trusted-agent-instructions.cjs
  - name: Verify dispatched PR head
    if: ${{ github.event_name == 'workflow_dispatch' && inputs.head_sha != '' }}
    env:
      EXPECTED_HEAD_SHA: ${{ inputs.head_sha }}
    run: test "$(git rev-parse HEAD)" = "${EXPECTED_HEAD_SHA}"
---

# Code Review

Review the PR for real defects only.

## Task

- Inspect the PR diff, changed files, tests, and CI status.
- Resolve the PR from the pull request event or the `pr` workflow-dispatch input.
- For manual dispatch, verify the checked-out PR head matches the `head_sha` input and include the PR number as `item_number` in comments or labels.
- Agent instruction files in the workspace are restored from the trusted base;
  inspect proposed `AGENTS.md` changes through the PR diff.
- Treat the exact marker `<!-- agentic-e2e:self-heal -->` in `docs/e2e/factory-heartbeat.md` as a deterministic required fix: create a failing `Agentic code review` check, ask for that marker to be removed, and do not add a specialist label for this known canary. After the marker is absent, review the file normally.
- Report only correctness, reliability, maintainability, or product-behavior issues that matter.
- For frontend/admin/chart changes, check that the PR follows root `DESIGN.md`, uses shadcn/ui + Tailwind primitives, and avoids default unstyled chart output.
- Do not comment on style or formatting unless it causes a real defect.
- Use `add-labels` to escalate trading, auth/security, QA, or docs/spec concerns to specialized review labels.
- Always create exactly one `Agentic code review` check on the target PR's current head SHA.
- Set the check to `success` when this code review finds no required fix or unresolved correctness concern. Adding a specialist label does not fail this check; the deterministic merge policy independently requires the corresponding specialist check.
- Set the check to `failure` only for a required fix, unresolved correctness concern, incomplete review, or the deterministic E2E marker case above.

## Safe outputs

- Use `add-comment` for PR findings.
- Use `add-labels` for specialized review escalation.
- Use `create-issue` only for cross-cutting follow-up beyond the PR.
- Use `create-check-run` for the required pass/fail result.
- Use `noop` only when no open PR can be resolved from the trigger.
