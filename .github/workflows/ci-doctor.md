---
description: Diagnoses failed CI from deterministic receipts and submits at most one goal-authorized signal to normal intake; never creates ready work directly.
on:
  workflow_dispatch:
  workflow_run:
    workflows: [CI]
    types: [completed]
    branches:
      - main
if: github.event_name != 'workflow_run' || (github.event.workflow_run.head_branch == github.event.repository.default_branch && contains(fromJSON('["cancelled","failure","startup_failure","timed_out"]'), github.event.workflow_run.conclusion))
concurrency:
  group: factory-queue-controller
  cancel-in-progress: false
permissions:
  contents: read
  issues: read
  pull-requests: read
  actions: read
  checks: read
  deployments: read
  statuses: read
  copilot-requests: write
pre-agent-steps:
  - name: Check out trusted collectors
    uses: actions/checkout@v4
    with:
      ref: ${{ github.event.repository.default_branch }}
      persist-credentials: false
  - uses: actions/setup-node@v4
    with:
      node-version-file: .nvmrc
  - name: Collect native failure receipt before model execution
    uses: actions/github-script@v9
    env:
      GH_TOKEN: ${{ github.token }}
      WATCHDOG_SOURCE_RUN_ID: ${{ github.event.workflow_run.id }}
    with:
      script: |
        const { runCollectionStep } = require(`${process.env.GITHUB_WORKSPACE}/scripts/agentic/factory-watchdog.cjs`);
        await runCollectionStep({ github, context, core, mode: "daily" });
  - name: Preserve deterministic failure receipt
    if: always()
    uses: actions/upload-artifact@v4
    with:
      name: factory-observer-receipts
      path: /tmp/gh-aw/watchdog/*.json
      retention-days: 30
tools:
  github:
    mode: gh-proxy
    toolsets: [default]
network:
  allowed: [defaults, node]
safe-outputs:
  jobs:
    submit-signal:
      if: needs.agent.result == 'success' && needs.detection.outputs.detection_success == 'true'
      description: Corroborate one CI signal and admit at most one authorized native-goal child to PM triage.
      runs-on: ubuntu-latest
      inputs:
        payload:
          description: JSON object with signal and proposal, matching specs/factory-signals.md
          required: true
          type: string
      permissions:
        contents: read
        issues: write
        actions: write
        pull-requests: read
      steps:
        - uses: actions/checkout@v4
          with:
            ref: ${{ github.event.repository.default_branch }}
            persist-credentials: false
        - uses: actions/github-script@v9
          with:
            script: |
              const { runSafeOutput } = require(`${process.env.GITHUB_WORKSPACE}/scripts/agentic/signal-intake.cjs`);
              await runSafeOutput({
                github, context, core, outputPath: process.env.GH_AW_AGENT_OUTPUT,
                repoRoot: process.env.GITHUB_WORKSPACE,
              });
  report-failure-as-issue: false
  noop:
    report-as-issue: false
max-ai-credits: 1200
max-daily-ai-credits: 3000
---

# CI Doctor

Read the trusted `/tmp/gh-aw/watchdog/receipts.json` and `factory-health.json`
before diagnosis. Collection already ran without a model. Missing or incomplete
collection requires `report_incomplete`, never a success-shaped noop. A complete
receipt with `reason: monitored-workflow-failed` is the expected CI incident to
diagnose, not a collector failure. Native watchdog
publishes canonical failure even when this model is unavailable.

## Task

- Automatic diagnosis is limited to supported CI failure conclusions on the
  default branch. Non-default-branch runs and `action_required` approvals do
  not authorize signal intake; leave operator approval to a human.
- Inspect the failed workflow run, failing jobs, failing steps, and relevant logs.
- Identify whether the failure is deterministic, flaky, infrastructure-related, or caused by a recent code change.
- Search existing issues for the same stable source/problem fingerprint.
- If the failure recovered, duplicates existing work, lacks approved scope, or
  control/capacity is paused/blocked/exhausted, use `noop`; do not open work.

## Safe outputs

- Follow `specs/factory-signals.md`; emit `submit_signal` exactly once only for
  a complete signal and proposal with a numeric baseline, independent test
  oracle, rollback, and expected outcome. Reference existing direct-goal work
  explicitly named in the human-approved scope, not just an allowed path.
- The deterministic adapter rechecks source SHA/window, completeness, duplicate,
  scope/risk, WIP1, budget, evaluation capacity, and native lineage, then creates
  only `needs-triage` and dispatches ordinary PM triage. Never label work ready
  by fiat or infer a new standing maintenance goal.
