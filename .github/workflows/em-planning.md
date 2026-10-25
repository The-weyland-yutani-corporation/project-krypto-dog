---
description: Engineering manager planning and ticket decomposition.
run-name: "${{ inputs.correlation_id || 'EM Planning' }}"
on:
  bots: ["github-actions[bot]"]
  workflow_dispatch:
    inputs:
      correlation_id:
        description: Deterministic intake dispatch identity
        required: false
        type: string
      scope:
        description: Issue number, epic, or planning scope
        required: false
        type: string
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
safe-outputs:
  add-comment:
    max: 1
    hide-older-comments: true
  create-issue:
    title-prefix: "[plan] "
    labels: [agentic-factory]
    allowed-labels: [agentic-factory, ready-for-ai-dev, needs-rubber-duck, needs-qa, security-review, trading-safety, docs-sync, risk:routine, risk:sensitive, risk:boundary, priority:P0, priority:P1, priority:P2, blocked]
    max: 10
    deduplicate-by-title: 1
  add-labels:
    allowed: [ready-for-ai-dev, needs-rubber-duck, needs-qa, security-review, trading-safety, docs-sync, risk:routine, risk:sensitive, risk:boundary, priority:P0, priority:P1, priority:P2, blocked]
    max: 8
  remove-labels:
    allowed: [ready-for-planning, needs-rubber-duck, ready-for-ai-dev, risk:routine, risk:sensitive, risk:boundary, priority:P0, priority:P1, priority:P2]
    max: 8
  noop:
    report-as-issue: false
max-ai-credits: 5000
max-daily-ai-credits: 20000
---

# EM Planning

Break approved work into small, sequenced implementation tickets.

## Task

- Read the target issue or planning scope.
- Require the repository-authorized `factory:autonomous-goal` ancestor,
  matching the standing mission in `.github/agentic-policy.json`, and keep every
  child inside its allowed scope, maximum risk tier, WIP, and assignment budget.
- Do not request per-ticket human approval. After child creation, remove
  `ready-for-planning` from the source issue to acknowledge this handoff.
- Identify dependencies, parallel work, blockers, risks, and owners by role.
- Create leaf child issues with explicit parent goal, scope/non-goals,
  machine-readable allowed paths, blocked-by relationships, exactly one risk
  tier, acceptance criteria, exactly one priority, existing validation
  commands, and rollback/safe reversal. Allowed paths use only exact files or
  terminal `path/**` directory globs.
- Set every created issue's native `parent` to the active approved goal. Do not
  create an intermediate tracking parent: queue eligibility requires the
  active goal to be the issue's direct native parent.
- Apply `ready-for-ai-dev` only when every queue-readiness field is complete.
- Remove superseded planning/risk labels when advancing an existing issue.

## Child ticket body contract

Every created queue candidate must use these rendered `###` headings exactly:

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
- Use `create-issue` for child tickets.
- Use `add-labels` to mark clear next-state labels.
- Use `remove-labels` to clear superseded state and risk labels.
- Use `noop` if the scope is not ready for planning.
