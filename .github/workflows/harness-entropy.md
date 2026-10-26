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
    - "cat /tmp/gh-aw/factory-health.json"
    - "cat /tmp/gh-aw/entropy-manifest.json"
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
    run: timeout 10m node scripts/agentic/prepare-monitor-ops.cjs entropy
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

### 1. Read the validated manifest

The trusted pre-agent step has already collected and validated the MonitorOps
snapshot, then generated and validated `/tmp/gh-aw/entropy-manifest.json` from
it. Collection uses the pinned CLI and read-only GitHub token. The entropy
collector reuses the health snapshot for WIP, telemetry, and repeated-failure
signals instead of querying them again.

Read `/tmp/gh-aw/entropy-manifest.json`. Do not run collectors or other
data-gathering commands; the manifest is the single source of truth for this report.

### 2. Decide whether to report

- If `summary.shouldReport` is `false`, call `noop` with a one-line reason (no
  material entropy delta since the last published report, or no actionable
  violations) and stop.
- Otherwise, create exactly one issue using the `create-issue` safe output.

A cache miss never suppresses a report: when there is no published baseline the
collector sets `baselineDelta.changed` to `true`, so a first run still reports.

### 3. Write the report

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

### 4. Embed the state-hash marker

End the issue body with the exact material-state marker on its own line so the
next run can detect a noop:

```
<!-- entropy-state-hash: MATERIAL_STATE_HASH -->
```

Replace `MATERIAL_STATE_HASH` with `materialHash` from the manifest.

## Rules

- The collectors — not the agent — gather data. Collection and JSON validation
  failures stop the agent job and use GH-AW's failure reporting. If you cannot
  read the prepared manifest, call `missing_data` and stop; never use `noop` for
  missing data or fabricate findings.
- This workflow is **report-only**. It has no `create-pull-request`, branch push,
  file edit, or deletion output, and it must never apply a code, policy,
  instruction, or trading change. It may quote the collector's remediation for a
  risky path but must never modify it, invent a change, or suggest bypassing
  review.
- Do not add GitHub references, backlinks, or @mentions.
- Keep everything read-only. The only visible write is the single report issue.
