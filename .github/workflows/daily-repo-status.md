---
description: Daily MonitorOps factory status report focused on throughput, aging, and blocked work for existing issues and PRs. Runs the deterministic collector first and never creates new feature scope.
on:
  workflow_dispatch:
  schedule: daily
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
  update-issue:
    target: "*"
  create-issue:
    title-prefix: "[factory-status] "
    labels: [agentic-factory, report]
    allowed-labels: [agentic-factory, report]
    max: 1
    deduplicate-by-title: 1
    close-older-issues: true
    expires: 7d
  mentions: false
  allowed-github-references: []
  noop:
    report-as-issue: false
max-ai-credits: 5000
max-daily-ai-credits: 20000
---

# Daily Repo Status (MonitorOps)

Concise daily factory status for Project Krypto: throughput, issue aging, and
blocked work for **existing** issues and PRs only. A deterministic collector
gathers the data first; you only summarize it. Do **not** create, suggest, or
scope new feature issues.

## Steps

### 1. Run the collector first

Run exactly this command (read-only toward GitHub; writes only under
`/tmp/gh-aw/`):

```
node scripts/agentic/collect-factory-health.cjs \
  --mode daily \
  --out /tmp/gh-aw/factory-health.json \
  --cache /tmp/gh-aw/cache-memory/monitor-ops-daily.json \
  --workflow-mode \
  --title-prefix "[factory-status] "
```

Then read `/tmp/gh-aw/factory-health.json`. Do not run other data-gathering
commands.

### 2. Decide whether to report

- If `materialState.changed` is `false`, call `noop` with a one-line reason
  (no material change since the last published status) and stop.
- Otherwise, update the canonical open `[factory-status]` issue when it exists;
  use `create-issue` only when absent.

### 3. Write the report

Keep it concise and grounded only in the snapshot. Use `###`/`####` headings and
GitHub alerts (`> [!NOTE]`, `> [!WARNING]`). No emoji, no invented numbers.

#### Required sections

- **Throughput** — `issues.openedInWindow`, `issues.closedInWindow`, and
  `issues.netOpened`; flag under `> [!WARNING]` when `netOpened` is positive.
- **WIP and aging** — `issues.staleWip` (with ages) and actionable-opportunity
  WIP (`issues.openActionableOpportunities`) versus the cap (`issues.wipCap`).
- **Blocked work** — `issues.blocked`.
- **Open PRs** — grouped by `pullRequests.byReviewState` and
  `pullRequests.byCheckState`.
- **Failing workflows** — any workflow in `workflows[]` whose `usage.conclusions`
  include failures, or a `thresholds.breaches` entry. Zero-run workflows are not
  failures.
- **Autonomy funnel and invariants** — include queue/lifecycle counts,
  assignment/repair/dev outcomes, duplicate/orphaned state, stale leases,
  boundary escalations, and paper-production delivery attempts when the snapshot exposes
  them.

### 4. Embed the state-hash marker

End the issue body with the material-state marker on its own line:

```
<!-- factory-state-hash: MATERIAL_STATE_HASH -->
```

Replace `MATERIAL_STATE_HASH` with `materialState.hash` from the snapshot.

## Rules

- Use snapshot data only; never speculate or generate new feature scope.
- Report existing-work changes only. Threshold breaches belong to the weekly
  governance report; here just note them briefly and link nothing.
- If the collector fails or its JSON is missing, call `noop` and explain; do not
  fabricate metrics.
- Do not add GitHub references, backlinks, or @mentions.
