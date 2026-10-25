---
description: Weekly report-only agentic entropy scan for Project Krypto's software factory. A deterministic MonitorOps collector and a deterministic entropy collector run first; the agent only ranks the normalized manifest and publishes at most one recurring report issue. Never proposes or applies code, policy, or trading changes.
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
    - "node scripts/agentic/collect-agentic-entropy.cjs *"
    - "cat /tmp/gh-aw/factory-health.json"
    - "cat /tmp/gh-aw/entropy-manifest.json"
network: defaults
safe-outputs:
  create-issue:
    title-prefix: "[factory-entropy] "
    labels: [agentic-factory, report]
    allowed-labels: [agentic-factory, report]
    max: 1
    close-older-issues: true
    expires: 90d
  mentions: false
  allowed-github-references: []
  noop:
    report-as-issue: false
max-ai-credits: 5000
max-daily-ai-credits: 20000
---

# Agentic Entropy (report-only)

Weekly report-only entropy scan for the Project Krypto software factory. Two
deterministic, dependency-free collectors run **before** you summarize anything:
MonitorOps normalizes factory health, and the entropy collector scans the
governance surfaces (policy, workflow sources/locks, instruction/doc references,
architecture boundaries) and reuses the MonitorOps snapshot for backlog and
observability signals. You only rank the normalized manifest and decide whether
to publish one report issue. You never invent or apply a fix; report only the collector's
deterministic evidence and remediation.

## Steps

### 1. Run the MonitorOps collector first

Run exactly this command (read-only toward GitHub; writes only under
`/tmp/gh-aw/`):

```
node scripts/agentic/collect-factory-health.cjs \
  --mode governance \
  --out /tmp/gh-aw/factory-health.json \
  --cache /tmp/gh-aw/cache-memory/monitor-ops-governance.json \
  --workflow-mode \
  --title-prefix "[factory-governance] "
```

### 2. Run the entropy collector with that snapshot

Run exactly this command. It reuses the MonitorOps snapshot for WIP, telemetry,
and repeated-failure signals and never re-queries GitHub for them:

```
node scripts/agentic/collect-agentic-entropy.cjs \
  --snapshot /tmp/gh-aw/factory-health.json \
  --out /tmp/gh-aw/entropy-manifest.json \
  --cache /tmp/gh-aw/cache-memory/entropy.json \
  --report-prefix "[factory-entropy] " \
  --workflow-mode
```

Then read `/tmp/gh-aw/entropy-manifest.json`. Do not run any other
data-gathering commands; the manifest is the single source of truth for this
report.

### 3. Decide whether to report

- If `summary.shouldReport` is `false`, call `noop` with a one-line reason (no
  material entropy delta since the last published report, or no actionable
  violations) and stop.
- Otherwise, create exactly one issue using the `create-issue` safe output.

A cache miss never suppresses a report: when there is no published baseline the
collector sets `baselineDelta.changed` to `true`, so a first run still reports.

### 4. Write the report

Rank the manifest's `violations` by severity (zero-tolerance first, then
advisory) and group them under their `dimensions`. Report only what the manifest
contains. Use `###`/`####` headings and GitHub alerts (`> [!NOTE]`,
`> [!WARNING]`). Do not use emoji, and do not invent findings.

#### Required sections

- **Dimensions** — one `####` block per entry in `dimensions[]` with its
  `status` and per-rule evidence. Cover every dimension: policy consistency,
  source/lock consistency, instruction/reference integrity, architecture
  integrity, observability coverage, backlog hygiene, and maintainability
  hotspots. There is no single aggregate score.
- **Zero-tolerance findings** — any `violations[]` entry with
  `severity: "zero-tolerance"`, each with its `path` and `remediation`, under a
  `> [!WARNING]` alert. State when there are none.
- **Advisory findings** — remaining `violations[]` entries with their `path` and
  `remediation`. These are report-only and do not block CI.
- **Observability and backlog** — the `opportunity_wip_over_cap` and
  `workflow_telemetry_coverage` checks. When their status is `unknown` (no
  MonitorOps snapshot), say "unavailable this run", never zero.
- **Baseline delta** — summarize `baselineDelta` (added/removed violations when
  present); note whether this is a new baseline.

### 5. Embed the state-hash marker

End the issue body with the exact material-state marker on its own line so the
next run can detect a noop:

```
<!-- entropy-state-hash: MATERIAL_STATE_HASH -->
```

Replace `MATERIAL_STATE_HASH` with `materialHash` from the manifest.

## Rules

- The collectors — not the agent — gather data. If either collector fails or its
  JSON is missing, call `noop` explaining the failure; do not fabricate findings.
- This workflow is **report-only**. It has no `create-pull-request`, branch push,
  file edit, or deletion output, and it must never apply a code, policy,
  instruction, or trading change. It may quote the collector's remediation for a
  risky path but must never modify it, invent a change, or suggest bypassing
  review.
- Do not add GitHub references, backlinks, or @mentions.
- Keep everything read-only. The only visible write is the single report issue.
