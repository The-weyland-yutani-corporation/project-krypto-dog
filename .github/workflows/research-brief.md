---
description: On-demand researcher workflow for product, architecture, dependency, and market questions.
on:
  workflow_dispatch:
    inputs:
      topic:
        description: Research topic or question
        required: false
        type: string
  slash_command:
    name: research
    events: [issues, issue_comment]
    strategy: centralized
  issues:
    types: [labeled]
    names: [ai:research]
permissions:
  contents: read
  issues: read
  pull-requests: read
  copilot-requests: write
imports:
  - .github/agents/researcher.md
tools:
  github:
    mode: gh-proxy
    toolsets: [default]
  web-fetch:
network: defaults
safe-outputs:
  add-comment:
    max: 1
    hide-older-comments: true
  create-issue:
    title-prefix: "[research] "
    labels: [agentic-factory, ai:research]
    max: 3
    deduplicate-by-title: 1
  noop:
    report-as-issue: false
max-ai-credits: 1500
max-daily-ai-credits: 4000
---

# Research Brief

Produce an evidence-backed research brief.

## Context

- If triggered by `/research`, use the sanitized triggering text: `${{ steps.sanitized.outputs.text }}`.
- If triggered manually, research: `${{ github.event.inputs.topic }}`.
- If triggered by a label, research the labeled issue.

## Task

Research the question, cite sources, compare options, and recommend a next action.

## Safe outputs

- Use `add-comment` to post the brief back to the triggering issue/comment when there is a triggering item.
- Use `create-issue` only for concrete follow-up tickets that are not duplicates.
- Use `noop` if the request has no actionable research question.
