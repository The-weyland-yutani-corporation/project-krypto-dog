---
description: Proactively discovers and creates high-quality PM/research opportunity tickets for the agentic SDLC factory.
on:
  workflow_dispatch:
    inputs:
      focus:
        description: Optional focus area, e.g. strategy, QA, observability, safety, factory, admin UX
        required: false
        type: string
      max_tickets:
        description: Maximum opportunity tickets to create; hard-capped at 3
        required: false
        type: string
        default: "3"
  schedule: daily
  slash_command:
    name: discover
    events: [issues, issue_comment]
    strategy: centralized
permissions:
  contents: read
  issues: read
  pull-requests: read
  actions: read
  copilot-requests: write
imports:
  - .github/agents/trading-growth-pm.md
tools:
  github:
    mode: gh-proxy
    toolsets: [default]
  web-fetch:
network: defaults
safe-outputs:
  create-issue:
    title-prefix: "[opportunity] "
    labels: [agentic-factory, opportunity, needs-rubber-duck]
    max: 3
    deduplicate-by-title: 1
  add-comment:
    max: 1
    hide-older-comments: true
  noop:
    report-as-issue: false
max-ai-credits: 1800
max-daily-ai-credits: 5000
---

# Opportunity Discovery

Create up to 3 high-quality opportunity tickets that can improve Project Krypto's risk-adjusted paper-trading performance or the software factory's ability to ship those improvements safely.

## Context

- If triggered manually, use this focus if provided: `${{ github.event.inputs.focus }}`.
- If triggered by `/discover`, use the sanitized triggering text as steering context: `${{ steps.sanitized.outputs.text }}`.
- If no focus is provided, inspect the repository, current issues/PRs, specs, recent workflow state, and obvious gaps.

## Task

Act as a proactive PM/research agent.

1. Inspect existing open issues and recent context first. Do not create duplicates.
2. Identify opportunities in these categories: trading strategy experiments, risk/safety, backtesting/evaluation, observability, QA/security, factory velocity, and admin/operator UX.
3. Use external web sources only when they materially improve the ticket; cite them in the issue body.
4. Create only high-confidence software tickets with clear acceptance criteria and validation plans.
5. Every created ticket starts behind rubber-duck review. Do not label tickets `ready-for-planning` or `ready-for-ai-dev`; rubber-duck review should decide whether to advance them.
6. For any ticket touching strategy, guardrails, portfolio accounting, risk controls, or live-trading boundaries, state that it requires rubber-duck and trading-safety review before implementation.
7. Low-risk factory/QA/docs/observability tickets may be recommended for planning in the issue body, but the workflow must not auto-apply planning or implementation labels.
8. If no opportunity clears the quality bar, call `noop`.

## Ticket format

Each created issue must include:

- Opportunity
- Why this may improve risk-adjusted paper-trading performance or factory velocity
- Evidence and assumptions
- Scope and non-goals
- Acceptance criteria
- Measurement plan
- Validation plan
- Safety/risk notes
- Suggested next workflow labels, as recommendations only

## Safe outputs

- Use `create-issue` for opportunity tickets. The workflow attaches `agentic-factory`, `opportunity`, and `needs-rubber-duck`.
- Use `add-comment` when triggered by `/discover` to summarize what was created or why no tickets were created.
- Use `noop` when there are no high-confidence non-duplicate opportunities.
