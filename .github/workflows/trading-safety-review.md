---
description: Trading and guardrail safety review for risky changes.
run-name: "${{ inputs.correlation_id || 'Trading Safety Review' }}"
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
    types: [opened, synchronize, reopened, labeled]
    paths:
      - "src/trading/**"
      - "src/tools/**"
      - "src/guardrails/**"
      - "src/agent/**"
      - "src/backtest/**"
      - "src/app/api/agent/**"
      - "src/db/**"
      - "drizzle/**"
      - "supabase/migrations/**"
      - "specs/rfcs/**"
  issues:
    types: [labeled]
    names: [trading-safety]
permissions:
  contents: read
  issues: read
  pull-requests: read
  checks: read
  copilot-requests: write
imports:
  - .github/agents/trading-safety-reviewer.md
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
    allowed: [trading-safety, ready-for-human-review, needs-qa, blocked]
    max: 4
  create-check-run:
    name: Trading safety review
    max: 1
  create-issue:
    title-prefix: "[trading-safety] "
    labels: [agentic-factory, trading-safety]
    max: 3
    deduplicate-by-title: 1
  noop:
    report-as-issue: false
max-ai-credits: 1600
max-daily-ai-credits: 4000
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

# Trading Safety Review

Review changes for paper-trading, portfolio, guardrail, and live-execution boundary risks.

## Task

- Resolve whether the target is an issue or pull request. For manual PR dispatch, use the `target` input, verify the checked-out PR head matches the `head_sha` input, and use its number as `item_number` in comments or labels.
- Agent instruction files in the workspace are restored from the trusted base;
  inspect proposed `AGENTS.md` changes through the PR diff.
- Inspect the target issue or PR and relevant files.
- Verify v2 remains paper trading only.
- Check deterministic policy and authorization, transactional paper execution, owned-lease behavior, portfolio state, journaling, and alerting invariants.
- Classify the result as `safe`, `safe-with-required-fixes`, or `unsafe`.
- For every pull request, create exactly one `Trading safety review` check on the current head.
- Set the check to `success` only for `safe`.
- Set the check to `failure` for `safe-with-required-fixes`, `unsafe`, or an incomplete review.
- Keep the non-lifecycle `trading-safety` requirement label so the reconciler
  reruns trading-safety review on every new head. The exact-current-head check
  clears the merge gate.

## Safe outputs

- Use `add-comment` for the review result.
- Use `add-labels` only for clear next-state labels.
- Use `create-check-run` for every pull-request result.
- Use `create-issue` for separate safety follow-up work.
- Use `noop` only for a non-PR target that cannot affect trading behavior.
