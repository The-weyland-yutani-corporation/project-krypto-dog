---
description: Product manager triage for new or labeled issues.
run-name: "${{ inputs.correlation_id || 'PM Triage' }}"
on:
  bots: ["github-actions[bot]"]
  workflow_dispatch:
    inputs:
      correlation_id:
        description: Deterministic intake dispatch identity
        required: false
        type: string
      issue:
        description: Issue number to triage
        required: false
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
safe-outputs:
  add-comment:
    max: 1
    hide-older-comments: true
  add-labels:
    allowed: [agentic-factory, needs-triage, ready-for-planning, needs-rubber-duck, ai:research, needs-qa, security-review, trading-safety, docs-sync, risk:routine, risk:sensitive, risk:boundary, priority:P0, priority:P1, priority:P2, blocked]
    max: 6
  remove-labels:
    allowed: [needs-triage, ready-for-planning, needs-rubber-duck, ai:research, risk:routine, risk:sensitive, risk:boundary, priority:P0, priority:P1, priority:P2]
    max: 6
  create-issue:
    title-prefix: "[pm] "
    labels: [agentic-factory]
    max: 5
    deduplicate-by-title: 1
  noop:
    report-as-issue: false
max-ai-credits: 5000
max-daily-ai-credits: 20000
---

# PM Triage

Refine the issue into an implementation-ready work item.

## Task

- Read the issue title, body, comments, labels, and relevant repository context.
- Identify the user/system problem, scope, non-goals, acceptance criteria, and validation plan.
- The product is permanently paper-only in development and production.
  Decline requests for another financial execution mode as unsupported; do
  not advance them or open an enablement/governance approval path.
- Require a linked parent issue carrying `factory:autonomous-goal`, whose
  scope matches `.github/agentic-policy.json`'s standing autonomy mission.
  No per-issue human approval is required. For a new, unowned idea, assess it
  against that mission and create at most one deduplicated, scoped proposal
  with its native `parent` set to the standing goal. Reference the source idea.
  Do not adopt, rewrite, or reparent legacy work automatically. If the idea
  is outside the mission, explain the scope mismatch without advancing it.
- Require dependencies, exactly one risk tier, rollback/safe reversal, and a
  bounded validation plan before advancing.
- Require machine-readable allowed paths: one exact repo-relative file or
  terminal `path/**` directory glob per line. Reject other wildcard forms,
  absolute paths, backslashes, and parent traversal.
- Apply exactly one priority label and exactly one risk label. Agent classification may
  raise risk but cannot lower the deterministic path floor applied later.
- Add state labels when appropriate.
- Remove obsolete state/risk labels when advancing so an issue has one current
  lifecycle state and one risk tier.
- Create follow-up issues only for clearly separate work.
- Set every created follow-up's native `parent` to the same approved goal as
  the triggering issue; never create an unowned queue candidate.
- Use the exact rendered headings from
  `.github/ISSUE_TEMPLATE/agentic-work-item.yml` for any created follow-up;
  never duplicate an authorization heading.

## Safe outputs

- Use `add-comment` with the triage result.
- Use `add-labels` for factory state transitions.
- Use `remove-labels` to clear superseded triage and risk labels.
- Use `create-issue` for separate follow-up tickets.
- Use `noop` for duplicates, spam, or issues that are already implementation-ready.
