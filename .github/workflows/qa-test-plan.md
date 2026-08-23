---
description: QA workflow for test plans, regression gaps, and acceptance validation.
run-name: "${{ inputs.correlation_id || 'QA Test Plan' }}"
on:
  bots: ["github-actions[bot]"]
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
  threat-detection:
    continue-on-error: false
  jobs:
    create-pr-check:
      description: Create the QA verification check on the reviewed PR head.
      runs-on: ubuntu-latest
      if: ${{ needs.agent.result == 'success' && needs.detection.result == 'success' && needs.detection.outputs.detection_success == 'true' }}
      inputs:
        pull_request_number:
          description: Pull request number that was reviewed
          required: true
          type: string
        head_sha:
          description: Exact 40-character pull request head SHA that was reviewed
          required: true
          type: string
        conclusion:
          description: Check conclusion
          required: true
          type: string
        title:
          description: Check title
          required: true
          type: string
        summary:
          description: Markdown check summary
          required: true
          type: string
      permissions:
        checks: write
        pull-requests: read
      env:
        CHECK_NAME: QA verification
        EXPECTED_PR_NUMBER: ${{ github.event.pull_request.number || inputs.target }}
        EXPECTED_HEAD_SHA: ${{ github.event.pull_request.head.sha || inputs.head_sha }}
      steps:
        - name: Create PR-head check
          uses: actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3 # v9
          with:
            script: |
              const fs = require("node:fs");
              const data = JSON.parse(
                fs.readFileSync(process.env.GH_AW_AGENT_OUTPUT, "utf8"),
              );
              const items = (data.items || []).filter(
                (item) => item.type === "create_pr_check",
              );
              if (items.length !== 1) {
                core.setFailed(`Expected exactly one create_pr_check item; found ${items.length}`);
                return;
              }
              const item = items[0];
              const pullNumber = Number(process.env.EXPECTED_PR_NUMBER);
              const expectedHeadSha = process.env.EXPECTED_HEAD_SHA || "";
              const validConclusions = new Set([
                "success",
                "failure",
                "neutral",
                "cancelled",
                "skipped",
                "timed_out",
                "action_required",
              ]);
              if (!Number.isInteger(pullNumber) || pullNumber <= 0) {
                core.setFailed("Trusted pull request context is unavailable");
                return;
              }
              if (Number(item.pull_request_number) !== pullNumber) {
                core.setFailed("Agent pull request number does not match trusted context");
                return;
              }
              if (
                typeof item.head_sha !== "string" ||
                !/^[0-9a-f]{40}$/.test(item.head_sha)
              ) {
                core.setFailed("head_sha must be a lowercase 40-character SHA");
                return;
              }
              if (!validConclusions.has(item.conclusion)) {
                core.setFailed(`Invalid conclusion: ${item.conclusion}`);
                return;
              }
              if (
                typeof item.title !== "string" ||
                item.title.length === 0 ||
                item.title.length > 256 ||
                typeof item.summary !== "string" ||
                item.summary.length === 0 ||
                item.summary.length > 65535
              ) {
                core.setFailed("title or summary is empty or exceeds GitHub limits");
                return;
              }
              const { data: pull } = await github.rest.pulls.get({
                owner: context.repo.owner,
                repo: context.repo.repo,
                pull_number: pullNumber,
              });
              const trustedHeadSha = expectedHeadSha || pull.head.sha;
              if (
                pull.head.sha !== trustedHeadSha ||
                item.head_sha !== trustedHeadSha
              ) {
                core.setFailed(
                  `PR #${pullNumber} head does not match trusted reviewed SHA`,
                );
                return;
              }
              await github.rest.checks.create({
                owner: context.repo.owner,
                repo: context.repo.repo,
                name: process.env.CHECK_NAME,
                head_sha: trustedHeadSha,
                status: "completed",
                conclusion: item.conclusion,
                completed_at: new Date().toISOString(),
                details_url: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
                output: {
                  title: item.title,
                  summary: item.summary,
                },
              });
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
      GH_TOKEN: ${{ github.token }}
      GH_AW_REPOSITORY: ${{ github.repository }}
      EXPECTED_PR_NUMBER: ${{ inputs.target }}
      EXPECTED_HEAD_SHA: ${{ inputs.head_sha }}
    run: |
      set -euo pipefail
      case "${EXPECTED_PR_NUMBER}" in
        ''|*[!0-9]*)
          echo "Dispatched target '${EXPECTED_PR_NUMBER}' is not a pull-request number." >&2
          exit 1
          ;;
      esac
      actual="$(gh api "repos/${GH_AW_REPOSITORY}/pulls/${EXPECTED_PR_NUMBER}" --jq '.head.sha')"
      if [ "${actual}" != "${EXPECTED_HEAD_SHA}" ]; then
        echo "PR #${EXPECTED_PR_NUMBER} head is now ${actual}, not the dispatched ${EXPECTED_HEAD_SHA}." >&2
        exit 1
      fi
      echo "Verified PR #${EXPECTED_PR_NUMBER} head is still ${EXPECTED_HEAD_SHA}."
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
- For every PR, call `create-pr-check` exactly once with the PR number, exact
  reviewed head SHA, conclusion, title, and summary.
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
- Use `create-pr-check` for every pull-request result.
- Use `noop` only for a non-PR target with no actionable QA gap.
