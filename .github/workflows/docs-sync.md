---
description: Keeps canonical specs, operator docs, and agent guidance aligned.
on:
  workflow_dispatch:
    inputs:
      target:
        description: Issue, PR, or scope to check
        required: true
        type: string
  pull_request:
    types: [labeled]
    names: [docs-sync]
  issues:
    types: [labeled]
    names: [docs-sync]
permissions:
  contents: read
  issues: read
  pull-requests: read
  copilot-requests: write
imports:
  - .github/agents/docs-spec-writer.md
tools:
  github:
    mode: gh-proxy
    toolsets: [default]
network: defaults
safe-outputs:
  add-comment:
    max: 1
    hide-older-comments: true
  create-pull-request:
    title-prefix: "[docs-sync] "
    labels: [agentic-factory, docs-sync]
    draft: false
    auto-merge: false
    max: 1
    allowed-files:
      - "docs/**"
      - "specs/**"
    protected-files: fallback-to-issue
  create-issue:
    title-prefix: "[docs-gap] "
    labels: [agentic-factory, docs-sync]
    max: 3
    deduplicate-by-title: 1
  remove-labels:
    target: "*"
    allowed: [docs-sync]
    max: 1
  noop:
    report-as-issue: false
max-ai-credits: 1400
max-daily-ai-credits: 3000
---

# Docs Sync

Check whether docs and specs need updates.

## Context

- For manual runs, use this target exactly: `${{ github.event.inputs.target }}`.
- For issue or PR label events, use the triggering item.

## Task

- Inspect the target issue or PR.
- Determine whether README, one of the five canonical specs, deployment docs,
  workflow docs, or agent prompts need updates.
- For small documentation-only fixes, open one PR.
- Docs-sync PRs remain reviewable and do not opt into native auto-merge.
  Canonical specs, deployment, security, trading, database, workflow, and
  agentic-policy documentation still require human approval.
- For protected files such as README or `.github/**`, create a follow-up issue instead of trying to modify them.
- For larger or ambiguous gaps, create a follow-up issue or comment with required changes.

## Safe outputs

- Use `create-pull-request` for contained docs/spec updates.
- Use `add-comment` for PR-local findings.
- Use `create-issue` for follow-up docs gaps.
- Use `remove-labels` to clear the processed `docs-sync` request label after
  emitting the durable PR/comment/issue result.
- Use `noop` when docs/specs are already aligned.
