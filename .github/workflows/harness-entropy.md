---
description: Optional manual entropy summary after trusted deterministic collection. Scheduled weekly collection, resolution publication and canonical identity are model-independent.
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
    with:
      script: |
        const { runCollectionStep } = require(`${process.env.GITHUB_WORKSPACE}/scripts/agentic/factory-watchdog.cjs`);
        await runCollectionStep({ github, context, core, mode: "governance" });
  - name: Preserve deterministic receipt even if the model fails
    if: always()
    uses: actions/upload-artifact@v4
    with:
      name: factory-observer-receipts
      path: /tmp/gh-aw/watchdog/*.json
      retention-days: 30
tools:
  bash:
    - "cat /tmp/gh-aw/watchdog/entropy-manifest.json"
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

# Harness Entropy

Read `/tmp/gh-aw/watchdog/entropy-manifest.json` and the deterministic receipts.
The collectors ran in trusted pre-agent steps. Do not collect again or apply a
remediation. Missing/partial/failed receipts require `report_incomplete`, never
a success-shaped `noop`.

### Report evidence, including resolution

Use `###`/`####` headings and `> [!WARNING]` for zero-tolerance findings. Summarize
dimensions, violations, unknown MonitorOps inputs and baseline delta. Clearing
the last finding is a material resolution: native publication records it once.
No human feedback is inferred from missing data.

### Boundaries

This collector is report-only. Native `factory-watchdog.yml` owns the weekly
canonical issue and `<!-- entropy-state-hash: MATERIAL_STATE_HASH -->`.
`canonicalReport` identifies it; never create, close, update, or label issues.
Use `record_summary` once for an Actions-only summary, or `noop` for no material
summary change.
Potential work must separately pass versioned signal intake and normal PM/EM
review; a finding does not grant scope, readiness, or authority.
