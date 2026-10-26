---
description: Weekly MonitorOps governance report for GH-AW factory health, cost, safe-output outcomes, and configured-threshold breaches. Deterministic collector runs first; the agent only summarizes the normalized snapshot.
on:
  workflow_dispatch:
  schedule: weekly on monday
permissions:
  contents: read
  issues: read
  pull-requests: read
  actions: read
  checks: read
  copilot-requests: write
tools:
  github:
    mode: gh-proxy
    toolsets: [default]
  cache-memory:
    retention-days: 90
  bash:
    - "cat /tmp/gh-aw/factory-health.json"
network: defaults
pre-agent-steps:
  - name: Restore trusted MonitorOps source
    uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
    with:
      ref: ${{ github.event.repository.default_branch }}
      persist-credentials: false
  - name: Set up collector Node.js
    uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0
    with:
      node-version-file: .nvmrc
  - name: Install pinned MonitorOps CLI
    uses: github/gh-aw-actions/setup-cli@ba6380cc6e5be5d21677bebe04d52fb48e3abec7 # v0.81.6
    with:
      version: v0.81.6
  - name: Collect and validate MonitorOps snapshot
    env:
      GH_TOKEN: ${{ github.token }}
    run: timeout 10m node scripts/agentic/prepare-monitor-ops.cjs governance
safe-outputs:
  update-issue:
    target: "*"
  create-issue:
    title-prefix: "[factory-governance] "
    labels: [agentic-factory, report]
    allowed-labels: [agentic-factory, report]
    max: 1
    deduplicate-by-title: 1
    close-older-issues: true
    expires: 30d
  mentions: false
  allowed-github-references: []
  noop:
    report-as-issue: false
max-ai-credits: 5000
max-daily-ai-credits: 20000
---

# Agentic Governance (MonitorOps)

Weekly governance report for the GH-AW software factory. A deterministic,
dependency-free collector normalizes every active workflow, its usage, factory
throughput, and configured-threshold state into one JSON snapshot **before** you
summarize it. You never re-derive metrics by hand.

## Steps

### 1. Read the validated snapshot

The trusted pre-agent step has already collected and validated
`/tmp/gh-aw/factory-health.json` using the pinned CLI and read-only GitHub token.
Read that file. Do not run collectors or other data-gathering commands; the
snapshot is the single source of truth for this report.

### 2. Decide whether to report

- If `materialState.changed` is `false`, call `noop` with a one-line reason
  (the material state matches the last published governance report) and stop.
- Otherwise, update the canonical open `[factory-governance]` issue when it
  exists; use `create-issue` only to establish it when absent.

### 3. Write the report

Report on the whole active factory from the snapshot only. Use `###`/`####`
headings and GitHub alerts (`> [!NOTE]`, `> [!WARNING]`). Do not use emoji, and
do not invent numbers.

#### Required sections

- **Coverage** — confirm every active workflow in `workflows[]` is represented,
  including zero-run workflows (`usage.runs == 0`). Never report a zero-run
  workflow as failing.
- **Run health** — per-workflow run counts and conclusions from
  `usage.conclusions`; call out repeated failures.
- **Cost** — `usage.aiCredits`, `usage.maxRunAiCredits`, and duration. When a
  value is `null` it is unavailable; state "not available", never `0`.
- **Telemetry coverage** — from `telemetry`; if `usage.tokens`,
  `usage.safeOutputOutcomes`, or `usage.corrections` are `null`, report them as
  unavailable rather than zero.
- **Issue and PR state** — throughput, actionable-opportunity WIP vs the policy
  cap (`issues.wipCap`), stale/blocked work, and PR review/check state.
- **Autonomy funnel and invariants** — report queue/lifecycle counts,
  assignment/repair/dev outcomes, duplicate/orphaned state, boundary
  escalations, rollback, and human vetoes when present in the snapshot.
- **Threshold breaches** — list every entry in `thresholds.breaches` with its
  `id` and `evidence`. If empty, state that no configured threshold is breached.
  Put breaches under a `> [!WARNING]` alert.

### 4. Embed the state-hash marker

End the issue body with the exact material-state marker so the next run can
detect a noop, on its own line:

```
<!-- factory-state-hash: MATERIAL_STATE_HASH -->
```

Replace `MATERIAL_STATE_HASH` with `materialState.hash` from the snapshot.

## Rules

- The collector — not the agent — gathers data. Collection and JSON validation
  failures stop the agent job and use GH-AW's failure reporting. If you cannot
  read the prepared snapshot, call `missing_data` and stop; never use `noop` for
  missing data or fabricate metrics.
- Do not add GitHub references, backlinks, or @mentions.
- Keep everything read-only. The only visible write is the single report issue.
