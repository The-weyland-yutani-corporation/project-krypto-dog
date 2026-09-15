---
description: Product manager triage for new or labeled issues.
on:
  workflow_dispatch:
    inputs:
      issue:
        description: Issue number to triage
        required: true
        type: string
  issues:
    types: [opened, reopened, labeled]
permissions:
  contents: read
  issues: read
  pull-requests: read
  copilot-requests: write
imports:
  - .github/agents/product-manager.md
tools:
  github:
    mode: gh-proxy
    toolsets: [default]
network: defaults
concurrency:
  group: factory-queue-controller
  cancel-in-progress: false
safe-outputs:
  add-comment:
    max: 1
    hide-older-comments: true
  jobs:
    apply-work-item:
      description: Validate one immutable proposal and materialize one bounded planning leaf.
      runs-on: ubuntu-latest
      if: >-
        github.ref == format('refs/heads/{0}', github.event.repository.default_branch) &&
        needs.agent.result == 'success' && needs.detection.result == 'success' &&
        needs.detection.outputs.detection_success == 'true'
      inputs:
        issue:
          description: Exact triggering issue number
          required: true
          type: number
        body:
          description: Complete proposed issue-form body with exact canonical headings
          required: true
          type: string
        expected_body:
          description: Exact original issue body read before drafting, including all existing content
          required: true
          type: string
        expected_updated_at:
          description: Original issue updated_at value
          required: true
          type: string
      permissions:
        contents: read
        issues: write
        pull-requests: read
        actions: write
      steps:
        - uses: actions/checkout@v4
          with:
            ref: ${{ github.event.repository.default_branch }}
            persist-credentials: false
            sparse-checkout: |
              .github/scripts
              .github/agentic-policy.json
        - uses: actions/github-script@v9
          with:
            script: |
              const fs = require("node:fs");
              const path = require("node:path");
              const { runIntakeSafeOutput } = require(path.join(process.env.GITHUB_WORKSPACE, ".github/scripts/agentic-intake-runtime.cjs"));
              const output = JSON.parse(fs.readFileSync(process.env.GH_AW_AGENT_OUTPUT, "utf8"));
              await runIntakeSafeOutput({ github, context, core, stage: "pm", output });
  noop:
    report-as-issue: false
max-ai-credits: 1000
max-daily-ai-credits: 3000
---

# PM Triage

Refine the issue into an implementation-ready work item.

## Task

- Read the issue title, body, comments, labels, and relevant repository context.
- Identify the user/system problem, scope, non-goals, acceptance criteria, and validation plan.
- Require a linked parent issue carrying `factory:goal-approved`. If the issue
  is outside that goal or has no approved goal, keep `needs-triage` and explain
  the missing authorization.
- Read that goal's Objective, Allowed scope and Explicit non-goals, not merely
  its path allow-list. Paths are a ceiling, never permission for novel work.
  Where scope names specific issues, require the original source to be one
  of them or already have a single `Scope source: #N` in Context naming one.
  Verify substantive relevance to that source; a marker alone is not approval.
  Preserve source signal markers and evidence verbatim in any proposed leaf.
- Derived scope also needs a trusted admission/result receipt binding the
  actual issue and exact current body hash. Do not fabricate receipts or
  revise an immutable derived leaf to bypass that proof; re-plan from the
  approved anchor when clarification is needed. Reuse a complete admitted
  signal body unchanged rather than rewriting its Work type just to advance.
- Require dependencies, exactly one risk tier, rollback/safe reversal, and a
  bounded validation plan before advancing.
- Require machine-readable allowed paths: one exact repo-relative file or
  terminal `path/**` directory glob per line. Reject other wildcard forms,
  absolute paths, backslashes, and parent traversal.
- Submit at most one complete proposal through `apply_work_item`, with the exact
  original body and `updated_at` as the expected snapshot. Use every exact
  rendered heading in `.github/ISSUE_TEMPLATE/agentic-work-item.yml`.
- Never edit human-owned bodies, milestones, or native parents. If the proposal
  differs, the deterministic safe-output job reserves one handoff and creates
  at most one immutable planning leaf directly under the approved goal with
  its milestone. If the existing leaf already matches, only its legal
  lifecycle/risk/priority labels advance.
- Keep exactly one priority and risk tier in the proposal. Risk cannot be
  lowered below either the existing declaration or canonical path floor.
- The job independently verifies current mode, singleton human goal approval,
  scope, dependencies, WIP, budget, claims and PRs before applying anything.
- The job explicitly dispatches `em-planning.lock.yml` with the materialized
  issue number. GITHUB_TOKEN label events do not recursively start EM; never
  treat adding a label or writing a comment as a successful handoff.
- Reservations and uncertain dispatches are not authorization. Do not retry a
  reserved proposal or create a replacement ticket; surface human recovery.

## Safe outputs

- Use `add-comment` with the triage result.
- Use `apply_work_item` for the single bounded validated application.
- Use `noop` for duplicates, spam, or issues that are already implementation-ready.
