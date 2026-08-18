---
description: Round-robin rubber-duck validation for approaches and risky tickets.
on:
  workflow_dispatch:
    inputs:
      target:
        description: Issue, PR, or free-form approach to review
        required: false
        type: string
  slash_command:
    name: rubber-duck
    events: [issues, issue_comment, pull_request, pull_request_comment]
    strategy: centralized
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
runs-on-slim: "${{ vars.CI_RUNNER_LABEL || 'ubuntu-slim' }}"
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
    allowed: [ready-for-planning, ready-for-ai-dev, needs-qa, security-review, trading-safety, ready-for-human-review]
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

## Safe outputs

- Use `add-comment` with the full review and decision.
- Use `add-labels` only when the next state is clear.
- Use `noop` if there is no approach or target to review.
