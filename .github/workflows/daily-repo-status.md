---
description: Optional manual summary of model-independent daily factory health. Native Factory Watchdog owns scheduled canonical publication, including collector and model failures.
on:
  workflow_dispatch:
permissions:
  contents: read
  issues: read
  pull-requests: read
  actions: read
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
  - name: Verify tooling and collect before model execution
    uses: actions/github-script@v9
    env:
      GH_TOKEN: ${{ github.token }}
    with:
      script: |
        const { runCollectionStep } = require(`${process.env.GITHUB_WORKSPACE}/scripts/agentic/factory-watchdog.cjs`);
        await runCollectionStep({ github, context, core, mode: "daily" });
  - name: Preserve deterministic receipt even if the model fails
    if: always()
    uses: actions/upload-artifact@v4
    with:
      name: factory-observer-receipts
      path: /tmp/gh-aw/watchdog/*.json
      retention-days: 30
tools:
  bash:
    - "cat /tmp/gh-aw/watchdog/factory-health.json"
    - "cat /tmp/gh-aw/watchdog/receipts.json"
network: defaults
safe-outputs:
  jobs:
    record-summary:
      if: needs.agent.result == 'success' && needs.detection.outputs.detection_success == 'true'
      description: Record one optional summary in the Actions job summary only, with no GitHub issue write.
      runs-on: ubuntu-latest
      inputs:
        summary:
          description: Evidence-only summary, at most 8000 characters
          required: true
          type: string
      permissions:
        contents: read
      steps:
        - uses: actions/checkout@v4
          with:
            ref: ${{ github.event.repository.default_branch }}
            persist-credentials: false
            sparse-checkout: scripts/agentic
        - uses: actions/github-script@v9
          with:
            script: |
              const { recordSummary } = require(`${process.env.GITHUB_WORKSPACE}/scripts/agentic/factory-report.cjs`);
              await recordSummary({ core, outputPath: process.env.GH_AW_AGENT_OUTPUT });
  report-failure-as-issue: false
  noop:
    report-as-issue: false
max-ai-credits: 1000
max-daily-ai-credits: 2500
---

# Daily Repo Status

This is an optional manual summary, not the daily liveness mechanism.
`factory-watchdog.yml` collects and publishes daily while paused without a model.
Trusted pre-agent steps already produced the receipt. Do not collect again.

### Read the receipt

Read `/tmp/gh-aw/watchdog/receipts.json` and
`/tmp/gh-aw/watchdog/factory-health.json`. If either is absent, incomplete, or
failed, use `report_incomplete`, never a success-shaped `noop`.

### Summarize only recorded evidence

Use `###`/`####` headings and `> [!WARNING]` for errors. Report factory mode,
control/goal reasons, lifetime budget, WIP, stage ages, source completeness,
freshness, actual verified development outcomes, and explicit unknowns.
Issue/report churn and heartbeat changes are not substantive throughput.
Absent paper metrics remain unknown; synthetic results never imply trading edge.

The snapshot's `canonicalReport` identifies the owned report. Do not create,
update, close, or relabel an issue. Use `record_summary` once for the concise
Actions summary, or `noop` for no material summary change. Native
publication alone owns `<!-- factory-state-hash: MATERIAL_STATE_HASH -->`.
