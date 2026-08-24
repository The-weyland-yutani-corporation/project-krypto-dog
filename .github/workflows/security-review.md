---
description: Security review for PRs and labeled issues.
run-name: "${{ inputs.correlation_id || 'Security Review' }}"
on:
  bots: ["github-actions[bot]"]
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
  threat-detection:
    continue-on-error: false
  jobs:
    create-pr-check:
      description: Create the Security review check on the reviewed PR head.
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
        CHECK_NAME: Security review
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
- For every pull request, call `create-pr-check` exactly once with the PR
  number, exact reviewed head SHA, conclusion, title, and summary.
- Set the check to `failure` when any high-confidence exploitable issue is present or the review cannot be completed safely.
- Set the check to `success` only when no high-confidence exploitable issue remains.
- Keep the non-lifecycle `security-review` requirement label so the reconciler
  reruns security review on every new head. The exact-current-head check clears
  the merge gate.

## Safe outputs

- Use `add-comment` for findings on the triggering item.
- Use `create-pr-check` for every pull-request result.
- Use `create-issue` for separate security follow-up work.
- Use `noop` only for a non-PR target with no high-confidence findings.
