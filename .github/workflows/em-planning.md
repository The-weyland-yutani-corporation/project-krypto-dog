---
description: Engineering manager planning and ticket decomposition.
on:
  workflow_dispatch:
    inputs:
      scope:
        description: Exact issue number of the materialized planning leaf
        required: false
        type: string
  slash_command:
    name: plan
    events: [issues, issue_comment]
    strategy: centralized
  issues:
    types: [labeled]
    names: [ready-for-planning]
permissions:
  contents: read
  issues: read
  pull-requests: read
  copilot-requests: write
imports:
  - .github/agents/engineering-manager.md
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
      description: Verify one immutable planning leaf and apply its legal ready transition.
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
          description: Exact current issue-form body; EM never rewrites human-owned fields
          required: true
          type: string
        expected_body:
          description: Exact original issue body read before verification
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
              await runIntakeSafeOutput({ github, context, core, stage: "em", output });
  noop:
    report-as-issue: false
max-ai-credits: 1200
max-daily-ai-credits: 3000
---

# EM Planning

Verify one small, materialized planning leaf before it enters the queue.

## Task

- Read the target issue or planning scope.
- Require a human-approved `factory:goal-approved` ancestor and keep every
  child inside its allowed scope, maximum risk tier, WIP, and assignment budget.
- Independently review Objective, Allowed scope and Explicit non-goals. A
  broad path allow-list or agent-created native parent is not permission for
  novel maintenance. Verify the existing `Scope source: #N` and substantive
  linkage when a goal restricts work to named issues; do not invent evidence.
- A source marker alone is insufficient: derived scope must have the trusted,
  issue-bound, current-body admission/result receipt the deterministic adapter
  verifies. A closed or blocked source cannot authorize more work.
- Identify dependencies, parallel work, blockers, risks, and owners by role.
- Require a leaf issue with explicit parent goal, scope/non-goals,
  machine-readable allowed paths, blocked-by relationships, exactly one risk
  tier, acceptance criteria, exactly one priority, existing validation
  commands, and rollback/safe reversal. Allowed paths use only exact files or
  terminal `path/**` directory globs.
- Verify the active goal is the direct native parent and its milestone is
  already bound. Never reparent or rewrite an existing issue.
- Submit the exact current body, original `expected_body` and `updated_at`
  through `apply_work_item`. The deterministic job applies `ready-for-ai-dev`
  only after every canonical queue-readiness, authorization and capacity gate
  passes, preserving hard blocks, claims, and concurrent human edits.
- Do not create more issues or merely suggest labels in a comment. Incomplete,
  conflicting or changed fields require a new reviewed proposal, not a silent
  fallback. Reserved/uncertain work remains explicit human recovery.
- The existing scheduled Factory Queue Controller observes the persisted
  ready leaf independently of GITHUB_TOKEN event suppression. EM never
  dispatches implementation, invents a claim, or consumes an assignment itself.

## Child ticket body contract

Every materialized queue candidate must use these rendered `###` headings exactly:

- `Work type`
- `Approved parent goal`
- `Problem or goal`
- `Scope and non-goals`
- `Allowed paths`
- `Risk tier`
- `Priority`
- `Dependencies`
- `Acceptance criteria`
- `Validation plan`
- `Rollback or safe reversal`
- `Context, links, or constraints`

Do not duplicate a heading. The deterministic parser fails closed on missing,
renamed, or duplicate authorization headings.

## Safe outputs

- Use `add-comment` for the plan summary.
- Use `apply_work_item` for the single bounded verified transition.
- Use `noop` if the scope is not ready for planning.
