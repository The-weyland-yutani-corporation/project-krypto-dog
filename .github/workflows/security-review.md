---
description: Security review for PRs and labeled issues.
run-name: "${{ inputs.correlation_id || 'Security Review' }}"
on:
  bots: ["github-actions[bot]", "copilot-swe-agent[bot]"]
  workflow_dispatch:
    inputs:
      target:
        description: Issue, PR, or scope to review
        required: true
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
    types: [labeled]
    names: [security-review]
  issues:
    types: [labeled]
    names: [security-review]
permissions:
  contents: read
  issues: read
  pull-requests: read
  checks: read
  copilot-requests: write
imports:
  - .github/agents/security-reviewer.md
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
  create-check-run:
    name: Security review
    max: 1
  create-issue:
    title-prefix: "[security] "
    labels: [agentic-factory, security-review]
    max: 3
    deduplicate-by-title: 1
  noop:
    report-as-issue: false
max-ai-credits: 1500
max-daily-ai-credits: 3500
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

# Security Review

Find high-confidence, exploitable security issues.

## Task

- Resolve whether the target is an issue or pull request. For manual PR dispatch, use the `target` input, verify the checked-out PR head matches the `head_sha` input, and use its number as `item_number` in comments.
- Agent instruction files in the workspace are restored from the trusted base;
  inspect proposed `AGENTS.md` changes through the PR diff.
- Inspect the target issue or PR and relevant repository files.
- Focus on auth, CSRF, secrets, injection, unsafe tool access, dependency risks, GitHub Actions permissions, and prompt/tool injection.
- Include severity, exploit path, affected files, and concrete remediation.
- Do not report speculative low-confidence concerns.
- For every pull request, create exactly one `Security review` check on the current head.
- Set the check to `failure` when any high-confidence exploitable issue is present or the review cannot be completed safely.
- Set the check to `success` only when no high-confidence exploitable issue remains.
- Keep the non-lifecycle `security-review` requirement label so the reconciler
  reruns security review on every new head. The exact-current-head check clears
  the merge gate.

## Safe outputs

- Use `add-comment` for findings on the triggering item.
- Use `create-check-run` for every pull-request result.
- Use `create-issue` for separate security follow-up work.
- Use `noop` only for a non-PR target with no high-confidence findings.
