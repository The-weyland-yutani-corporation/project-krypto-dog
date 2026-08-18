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
    - "node scripts/agentic/collect-factory-health.cjs *"
    - "cat /tmp/gh-aw/factory-health.json"
network: defaults
safe-outputs:
  create-issue:
    title-prefix: "[factory-governance] "
    labels: [agentic-factory, report]
    allowed-labels: [agentic-factory, report]
    max: 1
    close-older-issues: true
    expires: 30d
  mentions: false
  allowed-github-references: []
  noop:
    report-as-issue: false
max-ai-credits: 1000
max-daily-ai-credits: 2500
---

# Agentic Governance (MonitorOps)

Weekly governance report for the GH-AW software factory. A deterministic,
dependency-free collector normalizes every active workflow, its usage, factory
throughput, and configured-threshold state into one JSON snapshot **before** you
summarize it. You never re-derive metrics by hand.

## Steps

### 1. Run the collector first

Run exactly this command (it is read-only toward GitHub and writes only under
`/tmp/gh-aw/`):

```
node scripts/agentic/collect-factory-health.cjs \
  --mode governance \
  --out /tmp/gh-aw/factory-health.json \
  --cache /tmp/gh-aw/cache-memory/monitor-ops-governance.json \
  --workflow-mode \
  --title-prefix "[factory-governance] "
```

Then read `/tmp/gh-aw/factory-health.json`. Do not run any other data-gathering
commands; the snapshot is the single source of truth for this report.

### 2. Decide whether to report

- If `materialState.changed` is `false`, call `noop` with a one-line reason
  (the material state matches the last published governance report) and stop.
- Otherwise, create exactly one issue using the `create-issue` safe output.

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

- The collector — not the agent — gathers data. If the collector fails or its
  JSON is missing, call `noop` explaining the failure; do not fabricate metrics.
- Do not add GitHub references, backlinks, or @mentions.
- Keep everything read-only. The only visible write is the single report issue.
