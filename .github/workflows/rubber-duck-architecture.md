---
description: Round-robin rubber-duck validation for approaches and risky tickets.
run-name: "${{ inputs.correlation_id || 'Rubber Duck Architecture Review' }}"
on:
  bots: ["github-actions[bot]"]
  workflow_dispatch:
    inputs:
      correlation_id:
        description: Deterministic intake dispatch identity
        required: false
        type: string
      target:
        description: Issue, PR, or free-form approach to review
        required: false
        type: string
  issues:
    types: [labeled]
    names: [needs-rubber-duck]
  pull_request:
    types: [labeled]
    names: [needs-rubber-duck]
permissions:
  contents: read
  issues: read
  pull-requests: read
  copilot-requests: write
imports:
  - .github/agents/rubber-duck.md
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
    allowed: [ready-for-planning, ready-for-ai-dev, needs-qa, security-review, trading-safety, ready-for-human-review, risk:routine, risk:sensitive, risk:boundary, blocked]
    max: 5
  remove-labels:
    allowed: [needs-rubber-duck, ready-for-planning, ready-for-ai-dev, risk:routine, risk:sensitive, risk:boundary]
    max: 5
  noop:
    report-as-issue: false
max-ai-credits: 1200
max-daily-ai-credits: 3000
---

# Rubber Duck Architecture Review

Challenge the proposed approach before implementation.

## Task

Run a round-robin review using these lenses:

1. Product manager: does the approach solve the right problem?
2. Architect: is the design maintainable and correctly bounded?
3. Security reviewer: are there exploitable risks?
4. QA engineer: is the plan testable and are edge cases covered?
5. Trading safety reviewer: can the change affect paper/live trading boundaries or guardrails?

Synthesize one final recommendation: `approve`, `revise`, or `block`.

For an issue, verify it descends from the repository-authorized
`factory:autonomous-goal` matching `.github/agentic-policy.json` and stays
inside the goal scope/risk ceiling. Apply `ready-for-ai-dev` only when the
readiness contract is complete and exactly one risk label is present. Remove
superseded state/risk labels when advancing it.
Approval is an automated review decision, not a request for human approval.
If the work needs decomposition, advance it to `ready-for-planning`.

## Safe outputs

- Use `add-comment` with the full review and decision.
- Use `add-labels` only when the next state is clear.
- Use `remove-labels` only to clear superseded workflow-state or risk labels.
- Use `noop` if there is no approach or target to review.
