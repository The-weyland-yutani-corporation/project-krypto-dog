---
description: Weekly report-only CorrectionOps loop for Project Krypto's software factory. A deterministic, dependency-free collector reconstructs PM-triage and specialist-routing predictions from real GH-AW run artifacts, reconciles them against later trusted-human label/review events, and publishes at most one recurring measurement issue. It never proposes or applies a code, policy, instruction, label, or trading change; it improves measurement only.
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
    - "node scripts/agentic/collect-agentic-corrections.cjs *"
    - "cat /tmp/gh-aw/correction-report.json"
network: defaults
safe-outputs:
  create-issue:
    title-prefix: "[factory-corrections] "
    labels: [agentic-factory, report]
    allowed-labels: [agentic-factory, report]
    max: 1
    close-older-issues: true
    expires: 90d
  mentions: false
  allowed-github-references: []
  noop:
    report-as-issue: false
max-ai-credits: 1000
max-daily-ai-credits: 2500
---

# Agentic CorrectionOps (staged, report-only)

Weekly report-only measurement of how often the factory's **PM-triage** and
**specialist-routing** decisions were later corrected by a trusted human. A
single deterministic, dependency-free collector gathers everything **before** you
summarize anything. You only rank the normalized report and decide whether to
publish one measurement issue. You never invent, propose, or apply a fix, and you
never learn around any trading-safety decision.

## Steps

### 1. Run the CorrectionOps collector first

Run exactly this command. It is read-only toward GitHub, downloads only the runs
and artifacts it needs under `/tmp/gh-aw/correction-logs`, and writes only under
`/tmp/gh-aw/`:

```
node scripts/agentic/collect-agentic-corrections.cjs \
  --out /tmp/gh-aw/correction-report.json \
  --cache /tmp/gh-aw/cache-memory/corrections.json \
  --report-prefix "[factory-corrections] " \
  --count 50 \
  --workflow-mode
```

Then read `/tmp/gh-aw/correction-report.json`. Do not run any other
data-gathering commands; the report is the single source of truth for this issue.

### 2. Decide whether to report

- If `shouldReport` is `false`, call `noop` with a one-line reason (no new
  trusted correction evidence, or no material delta since the last published
  report) and stop.
- Otherwise, create exactly one issue using the `create-issue` safe output.

A cache miss never suppresses a report and never fabricates a correction: when
there is no published baseline the collector sets `baselineDelta.changed` to
`true`, and records with no trusted human action are counted as `pending`, never
scored.

### 3. Write the measurement issue

Report only what the report contains. Use `###`/`####` headings and GitHub
alerts (`> [!NOTE]`, `> [!WARNING]`). Do not use emoji, and do not invent
findings.

#### Required sections

- **Window and sample** — `window`, `predictionSummary.total`, `sampleSize`, and
  `pendingCount`. When `sampleSize` is `0`, state that `correctionRate` is
  unavailable (`null`) this cycle — never report it as zero.
- **Correction summary** — `diffSummary` (match / mismatch / pending) and
  `correctionRate`, grouped by `versionGroupings.byInstructionHash` and
  `versionGroupings.byWorkflowVersion` and `versionGroupings.byModel` so a
  prompt/workflow/model version can be compared.
- **Immutable-route conflicts** — every entry in `immutableRouteConflicts`, under
  a `> [!WARNING]` alert. Each conflict means a trusted human removed a predicted
  specialist label that the immutable path route still requires; the immutable
  route is preserved and is never weakened. State when there are none.
- **Baseline delta** — summarize `baselineDelta` (added/removed/changed record
  statuses when present); note whether this is a new baseline.

### 4. Embed the state-hash marker

End the issue body with the exact material-state marker on its own line so the
next run can detect a noop:

```
<!-- correction-state-hash: MATERIAL_STATE_HASH -->
```

Replace `MATERIAL_STATE_HASH` with `materialHash` from the report. The published
hash read from prior `[factory-corrections]` issues is authoritative over the
cache.

## Rules

- The collector — not the agent — gathers data. If it fails or its JSON is
  missing, call `noop` explaining the failure; do not fabricate findings.
- This workflow is **staged and report-only**. It has no `create-pull-request`,
  branch push, file edit, deletion, or `add-labels` output, and it must never
  apply a code, policy, instruction, label, or trading change. It measures only.
- Never score, learn around, or comment on trading authorization, guardrails,
  leases, reconciliation, operator pause, or paper-execution behavior. A human
  disagreement never weakens an immutable path route; surface such a conflict as
  a safety warning only.
- Do not store or quote any raw issue body, comment body, prompt text, or review
  body. Report only ids, labels, routes, counts, timestamps, and hashes.
- Do not add GitHub references, backlinks, or @mentions.
- Keep everything read-only. The only visible write is the single measurement
  issue.
