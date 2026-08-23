---
description: High-signal automated PR review for correctness and maintainability.
run-name: "${{ inputs.correlation_id || 'Code Review' }}"
on:
  bots: ["github-actions[bot]"]
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
  threat-detection:
    continue-on-error: false
  jobs:
    create-pr-check:
      description: Create the Agentic code review check on the reviewed PR head.
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
        CHECK_NAME: Agentic code review
        EXPECTED_PR_NUMBER: ${{ github.event.pull_request.number || inputs.pr }}
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
      GH_TOKEN: ${{ github.token }}
      GH_AW_REPOSITORY: ${{ github.repository }}
      EXPECTED_PR_NUMBER: ${{ inputs.pr }}
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
- Always call `create-pr-check` exactly once for a PR result, passing the PR
  number, exact reviewed head SHA, conclusion, title, and summary.
- Set the check to `success` when this code review finds no required fix or unresolved correctness concern. Adding a specialist label does not fail this check; the deterministic merge policy independently requires the corresponding specialist check.
- Set the check to `failure` only for a required fix, unresolved correctness concern, incomplete review, or the deterministic E2E marker case above.

## Safe outputs

- Use `add-comment` for PR findings.
- Use `add-labels` for specialized review escalation.
- Use `create-issue` only for cross-cutting follow-up beyond the PR.
- Use `create-pr-check` for the required pass/fail result.
- Use `noop` only when no open PR can be resolved from the trigger.
