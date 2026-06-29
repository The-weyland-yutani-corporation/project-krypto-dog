---
description: QA workflow for test plans, regression gaps, and acceptance validation.
on:
  workflow_dispatch:
    inputs:
      target:
        description: Issue, PR, or feature to test
        required: false
        type: string
  issues:
    types: [labeled]
    names: [needs-qa]
  pull_request:
    types: [labeled]
    names: [needs-qa]
permissions:
  contents: read
  issues: read
  pull-requests: read
  checks: read
  actions: read
  copilot-requests: write
imports:
  - .github/agents/qa-engineer.md
env:
  AZURE_OPENAI_ENDPOINT: https://stub.openai.azure.com
  AZURE_OPENAI_API_KEY: stub
  AZURE_OPENAI_DEPLOYMENT_NAME: claude-sonnet-stub
  CDP_API_KEY_NAME: stub
  CDP_API_KEY_PRIVATE_KEY: stub
  DATABASE_URL: postgresql://stub:stub@localhost:5432/stub
  POSTHOG_API_KEY: phc_stub
  CRON_SECRET: stub
  ADMIN_PASSWORD: stub
  ADMIN_SESSION_SECRET: stub
tools:
  github:
    mode: gh-proxy
    toolsets: [default]
  bash:
    - npm ci
    - npm run lint
    - npm run typecheck:scripts
    - npm run build
    - npm test -- --ci
network:
  allowed: [defaults, node]
safe-outputs:
  add-comment:
    max: 1
    hide-older-comments: true
  create-issue:
    title-prefix: "[qa-gap] "
    labels: [agentic-factory, needs-qa]
    max: 5
    deduplicate-by-title: 1
  noop:
    report-as-issue: false
max-ai-credits: 1600
max-daily-ai-credits: 3500
timeout-minutes: 25
---

# QA Test Plan

Create a test plan or test-gap review for the target issue or PR.

## Task

- Map requirements and changed files to expected behavior.
- Identify missing unit, integration, route, guardrail, and regression tests.
- For PRs, inspect CI status and relevant test files.
- Recommend the smallest set of tests needed for confidence.

## Safe outputs

- Use `add-comment` with the QA plan or PR review.
- Use `create-issue` for test gaps that should be tracked separately.
- Use `noop` when no actionable QA gap exists.
