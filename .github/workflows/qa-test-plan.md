---
description: QA workflow for test plans, regression gaps, and acceptance validation.
run-name: "${{ inputs.correlation_id || 'QA Test Plan' }}"
on:
  bots: ["github-actions[bot]", "copilot-swe-agent[bot]"]
  workflow_dispatch:
    inputs:
      target:
        description: Issue, PR, or feature to test
        required: false
        type: string
      head_sha:
        description: Exact pull request head to verify
        required: false
        type: string
      correlation_id:
        description: Reconciler run correlation
        required: false
        type: string
  issues:
    types: [labeled]
    names: [needs-qa]
  pull_request:
    types: [labeled]
    names: [needs-qa]
permissions:
  contents: read
  issues: read
  pull-requests: read
  checks: read
  actions: read
  copilot-requests: write
imports:
  - .github/agents/qa-engineer.md
env:
  AZURE_OPENAI_ENDPOINT: https://stub.openai.azure.com
  AZURE_OPENAI_API_KEY: stub
  AZURE_OPENAI_DEPLOYMENT_NAME: claude-sonnet-stub
  CDP_API_KEY_NAME: stub
  CDP_API_KEY_PRIVATE_KEY: stub
  DATABASE_URL: postgresql://stub:stub@localhost:5432/stub
  POSTHOG_API_KEY: phc_stub
  CRON_SECRET: stub
  ADMIN_PASSWORD: stub
  ADMIN_SESSION_SECRET: stub
tools:
  github:
    mode: gh-proxy
    toolsets: [default]
  bash:
    - npm ci
    - npm run lint
    - npm run typecheck:scripts
    - npm run build
    - npm test -- --ci
network:
  allowed: [defaults, node]
safe-outputs:
  add-comment:
    max: 1
    hide-older-comments: true
  create-issue:
    title-prefix: "[qa-gap] "
    labels: [agentic-factory, needs-qa]
    max: 5
    deduplicate-by-title: 1
  create-check-run:
    name: QA verification
    max: 1
  noop:
    report-as-issue: false
max-ai-credits: 1600
max-daily-ai-credits: 3500
timeout-minutes: 25
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

# QA Test Plan

Create a test plan for an issue or perform a current-head QA verification for a
pull request.

## Task

- Map requirements and changed files to expected behavior.
- Identify missing unit, integration, route, guardrail, and regression tests.
- Resolve the target from the triggering item or `target` input. For a manually
  dispatched PR, verify the checked-out PR head matches the `head_sha` input.
- Agent instruction files in the workspace are restored from the trusted base;
  inspect proposed `AGENTS.md` changes through the PR diff.
- For PRs, inspect the implementation issue, acceptance criteria, diff, CI
  status, tests, and retained evidence.
- Recommend the smallest set of tests needed for confidence.
- For every PR, create exactly one `QA verification` check on the current head.
- Set the check to `success` only when the acceptance criteria are covered by
  executable tests/evidence and no material regression gap remains.
- Set the check to `failure` when required coverage is missing, CI evidence is
  incomplete, or verification cannot be completed safely.
- Keep the non-lifecycle `needs-qa` requirement label so the reconciler reruns
  QA on every new head. The exact-current-head check, not label removal, clears
  the merge gate.

## Safe outputs

- Use `add-comment` with the QA plan or PR review.
- Use `create-issue` for test gaps that should be tracked separately.
- Use `create-check-run` for every pull-request result.
- Use `noop` only for a non-PR target with no actionable QA gap.
