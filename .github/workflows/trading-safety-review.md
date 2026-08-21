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
  threat-detection:
    continue-on-error: false
  jobs:
    create-pr-check:
      description: Create the Trading safety review check on the reviewed PR head.
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
        CHECK_NAME: Trading safety review
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
- For every pull request, call `create-pr-check` exactly once with the PR
  number, exact reviewed head SHA, conclusion, title, and summary.
- Set the check to `success` only for `safe`.
- Set the check to `failure` for `safe-with-required-fixes`, `unsafe`, or an incomplete review.
- Keep the non-lifecycle `trading-safety` requirement label so the reconciler
  reruns trading-safety review on every new head. The exact-current-head check
  clears the merge gate.

## Safe outputs

- Use `add-comment` for the review result.
- Use `add-labels` only for clear next-state labels.
- Use `create-pr-check` for every pull-request result.
- Use `create-issue` for separate safety follow-up work.
- Use `noop` only for a non-PR target that cannot affect trading behavior.
