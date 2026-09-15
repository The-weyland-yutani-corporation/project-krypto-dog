---
description: Optional manual governance summary after trusted model-independent collection. Native Factory Watchdog owns weekly canonical receipts and failure publication.
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
  - uses: github/gh-aw-actions/setup-cli@v0.81.6
    with:
      version: v0.81.6
  - name: Verify tooling and collect before model execution
    uses: actions/github-script@v9
    env:
      GH_TOKEN: ${{ github.token }}
      WATCHDOG_INCLUDE_USAGE: "true"
    with:
      script: |
        const { runCollectionStep } = require(`${process.env.GITHUB_WORKSPACE}/scripts/agentic/factory-watchdog.cjs`);
        await runCollectionStep({ github, context, core, mode: "governance", includeUsage: true });
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

# Agentic Governance

Summarize the trusted governance receipt, never rerun collection in the prompt.
Scheduled weekly health and canonical publication belong to
`factory-watchdog.yml`; healthy no-change checks require no model.

### Read before summarizing

Read `/tmp/gh-aw/watchdog/receipts.json` and
`/tmp/gh-aw/watchdog/factory-health.json`. Use `report_incomplete` when data is
missing, partial, or failed. Do not call `noop` to disguise collector failure.

### Evidence summary

Use `###`/`####` headings and `> [!WARNING]` for failures. Include every workflow,
closed UTC window, coverage, exact measured cost, actual control/goal/budget
reasons, stage ages, claims/repairs, and verified substantive dev outcomes.
Zero observed runs from an incomplete API read are unknown, not healthy.
Report gross issue churn separately from delivery and expose unavailable metrics.

Goal approval, activation, budget renewal, hard-stop recovery, boundary merges,
production, live trading, secrets, accounts, and architecture remain human-only.
No finite standing maintenance goal is inferred from a broad path allowlist.

The receipt exposes `canonicalReport`; do not mutate any issue. Use
`record_summary` once for the concise Actions summary, or `noop` for no material
summary change. Native publication
owns `<!-- factory-state-hash: MATERIAL_STATE_HASH -->`.
