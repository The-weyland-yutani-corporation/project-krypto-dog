---
description: Security review for PRs and labeled issues.
on:
  workflow_dispatch:
    inputs:
      target:
        description: Issue, PR, or scope to review
        required: true
        type: string
  pull_request:
    types: [labeled]
    names: [security-review]
  issues:
    types: [labeled]
    names: [security-review]
permissions:
  contents: read
  issues: read
  pull-requests: read
  checks: read
  copilot-requests: write
imports:
  - .github/agents/security-reviewer.md
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
    title-prefix: "[security] "
    labels: [agentic-factory, security-review]
    max: 3
    deduplicate-by-title: 1
  noop:
    report-as-issue: false
max-ai-credits: 1500
max-daily-ai-credits: 3500
---

# Security Review

Find high-confidence, exploitable security issues.

## Task

- Inspect the target issue or PR and relevant repository files.
- Focus on auth, CSRF, secrets, injection, unsafe tool access, dependency risks, GitHub Actions permissions, and prompt/tool injection.
- Include severity, exploit path, affected files, and concrete remediation.
- Do not report speculative low-confidence concerns.

## Safe outputs

- Use `add-comment` for findings on the triggering item.
- Use `create-issue` for separate security follow-up work.
- Use `noop` when there are no high-confidence findings.
