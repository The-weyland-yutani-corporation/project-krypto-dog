---
description: Release readiness checklist and operator handoff.
on:
  workflow_dispatch:
    inputs:
      target:
        description: Release, PR, branch, or deployment scope
        required: false
        type: string
  slash_command:
    name: release-readiness
    events: [issues, issue_comment, pull_request, pull_request_comment]
    strategy: centralized
  pull_request:
    types: [labeled]
    names: [release-readiness]
permissions:
  contents: read
  issues: read
  pull-requests: read
  actions: read
  checks: read
  deployments: read
  copilot-requests: write
imports:
  - .github/agents/release-manager.md
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
    title-prefix: "[release-readiness] "
    labels: [agentic-factory, release-readiness]
    max: 3
    deduplicate-by-title: 1
  noop:
    report-as-issue: false
max-ai-credits: 5000
max-daily-ai-credits: 20000
---

# Release Readiness

Produce a release readiness checklist and operator handoff.

## Task

- Inspect the target release scope, related PRs/issues, CI status, migrations, docs, and deployment runbook.
- For factory-delivered work, require exact-merge native development and
  paper-production receipts, actual scheduled PAPER evidence and receipt-bound
  production Deployment. Confirm the latest workflow attempts and required
  jobs; green statuses, disabled releases, deferrals and `factory:done` labels
  alone are not completed delivery. Apply `specs/factory.md` for ownership,
  artifact expiry and bounded recovery.
- Identify required secrets, environment changes, migrations, smoke tests, rollback steps, and operator actions.
- Block release readiness for unresolved high-risk issues.
- Apply the lean paper-production gate contract in `specs/operations.md`.
  Separate analytics projects, mailbox-delivery proof, and irreversible
  retention locking are optional, not POC release blockers.
- This workflow is advisory and does not dispatch deployment or change
  permissions/secrets. Trusted native workflows own verified paper promotion;
  commissioning and external-setting changes retain their scoped approvals.

## Safe outputs

- Use `add-comment` for the checklist on the triggering issue or PR.
- Use `create-issue` for release blockers that need tracking.
- Use `noop` when there is no release scope to evaluate.
