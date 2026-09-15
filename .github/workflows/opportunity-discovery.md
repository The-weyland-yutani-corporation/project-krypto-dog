---
description: Proposes at most one evidence-bound signal for deterministic goal/capacity admission. Native watchdog schedules discovery only when eligible; the model cannot create or ready work directly.
on:
  workflow_dispatch:
    inputs:
      focus:
        description: Optional focus area, e.g. QA, observability, safety, factory, admin UX. Strategy areas are deferred.
        required: false
        type: string
      receipt_run_id:
        description: Optional trusted Factory Watchdog receipt run (not authorization)
        required: false
        type: string
  slash_command:
    name: discover
    events: [issues, issue_comment]
    strategy: centralized
concurrency:
  group: factory-queue-controller
  cancel-in-progress: false
permissions:
  contents: read
  issues: read
  pull-requests: read
  actions: read
  deployments: read
  statuses: read
  copilot-requests: write
imports:
  - .github/agents/trading-growth-pm.md
pre-agent-steps:
  - name: Check out trusted signal adapters
    uses: actions/checkout@v4
    with:
      ref: ${{ github.event.repository.default_branch }}
      persist-credentials: false
  - uses: actions/setup-node@v4
    with:
      node-version-file: .nvmrc
  - name: Collect current control and evidence before any model
    uses: actions/github-script@v9
    env:
      GH_TOKEN: ${{ github.token }}
    with:
      script: |
        const { runCollectionStep } = require(`${process.env.GITHUB_WORKSPACE}/scripts/agentic/factory-watchdog.cjs`);
        await runCollectionStep({ github, context, core, mode: "daily" });
  - name: Verify optional native watchdog receipt provenance
    id: receipt-source
    if: github.event.inputs.receipt_run_id != ''
    uses: actions/github-script@v9
    env:
      RECEIPT_RUN_ID: ${{ github.event.inputs.receipt_run_id }}
    with:
      script: |
        const { inspectReceiptRun } = require(`${process.env.GITHUB_WORKSPACE}/scripts/agentic/factory-watchdog.cjs`);
        const receipt = await inspectReceiptRun({
          github, ...context.repo, runId: process.env.RECEIPT_RUN_ID,
          defaultBranch: context.payload.repository.default_branch,
        });
        core.setOutput("attempt", receipt.attempt);
  - name: Read exact-attempt signal receipt
    if: github.event.inputs.receipt_run_id != ''
    uses: actions/download-artifact@v4
    with:
      github-token: ${{ github.token }}
      run-id: ${{ github.event.inputs.receipt_run_id }}
      name: factory-watchdog-receipts-a${{ steps.receipt-source.outputs.attempt }}
      path: /tmp/gh-aw/watchdog-source
  - name: Merge bounded fresh signal evidence without granting authority
    if: github.event.inputs.receipt_run_id != ''
    uses: actions/github-script@v9
    with:
      script: |
        const { mergeDiscoverySignals } = require(`${process.env.GITHUB_WORKSPACE}/scripts/agentic/factory-watchdog.cjs`);
        mergeDiscoverySignals({
          sourcePath: "/tmp/gh-aw/watchdog-source/signal-candidates.json",
          outputPath: "/tmp/gh-aw/watchdog/signal-candidates.json",
          repository: `${context.repo.owner}/${context.repo.repo}`,
        });
  - name: Preserve current deterministic receipt
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
  web-fetch:
network: defaults
safe-outputs:
  jobs:
    submit-signal:
      if: needs.agent.result == 'success' && needs.detection.outputs.detection_success == 'true'
      description: Validate exactly one signal and proposal, then admit at most one native approved-goal child to normal PM triage.
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
  mentions: false
  noop:
    report-as-issue: false
max-ai-credits: 1000
max-daily-ai-credits: 2000
---

# Opportunity Discovery

Propose at most **one** corroborated signal inside an existing human-approved
factory goal. Read `specs/factory-signals.md` and the trusted
`/tmp/gh-aw/watchdog/receipts.json`, `factory-health.json`, and
`signal-candidates.json` first. Do not rerun collection in the prompt.
Missing or failed collection requires `report_incomplete`, not `noop`.
Strategy research is explicitly deferred.

## WIP gate (check this first)

Count the number of open issues with label `opportunity` that do **not** have label `blocked`. If that count is **≥ 20**, call `noop` immediately with the reason "backlog WIP limit reached — {count} open opportunity issues". Do not proceed further.

Also require active human-backed factory control and exactly one open parent goal carrying `factory:goal-approved`.
Read its allowed scope, non-goals, maximum risk, WIP, and assignment budget.
Call `noop` when no goal is active or when its queued/claimed/implementing work
already reaches the goal's WIP allowance.

Also call `noop` if:
- The trigger is `workflow_dispatch` or `schedule` and there are no visible gaps in the v2.1 or v2.2 foundation work.
- The proposed ticket is a near-duplicate of an existing open or closed issue title.

## Context

- If triggered manually, use this focus if provided: `${{ github.event.inputs.focus }}`.
- If triggered by `/discover`, use the sanitized triggering text as steering context: `${{ steps.sanitized.outputs.text }}`.
- If no focus is provided, inspect only gaps authorized by the active goal.

## Allowed scope

Only discover opportunities in these categories:
1. **v2.1 Safety foundations** — deterministic guardrails, accounting correctness, run reliability, market-data integrity, migrations/data protection, private schema/cron security, decimal ledger, transactional idempotency, structured LLM intent, typed errors/timeouts, real-Postgres CI.
2. **v2.2 Evidence foundations** — evaluation harness, backtest scenarios, Sharpe/Sortino, CI gates, performance visibility, cost tracking.
3. **Factory/QA/observability** — low-risk improvements to the agentic factory itself.

## Explicitly deferred scope (always noop for these)

- Strategy experiments: ATR, MACD, volume signals, market regime classifiers, EMA trend filters, dynamic sizing.
- Any work that requires v2.1 or v2.2 to be complete first.

## Task

Act as a proactive PM/research agent.

1. Check the WIP gate first. If the limit is reached, call `noop` immediately.
2. Inspect existing open issues to avoid near-duplicates. If a near-duplicate exists, call `noop`.
3. Identify exactly one opportunity from the allowed scope above.
4. Use external web sources only when they materially improve the ticket; cite them in the issue body.
5. Create only high-confidence software tickets with clear acceptance criteria and validation plans.
6. The adapter creates only `needs-triage`. Rubber-duck review remains a normal PM step. Never apply `ready-for-planning`, `ready-for-ai-dev`, or multiple lifecycle labels.
7. For any ticket touching guardrails, portfolio accounting, risk controls, or live-trading boundaries, state that it requires rubber-duck and trading-safety review before implementation.
8. If no opportunity clears the quality bar, call `noop`.
9. The proposal must reference an existing native direct-goal work issue explicitly
   named in the goal's Objective or Allowed scope. Broad paths do not authorize
   novel maintenance. Never infer a standing goal, renew a budget, or create or
   approve a goal. The trusted adapter creates and verifies the direct native link.

## Ticket format

The `submit_signal` payload must use the exact versioned schema in
`specs/factory-signals.md`, including:

- Opportunity
- Why this may improve risk-adjusted paper-trading performance or factory velocity
- Evidence and assumptions
- Scope and non-goals
- Acceptance criteria
- Measurement plan
- Validation plan
- Safety/risk notes
- Suggested next workflow labels, as recommendations only
- Numeric baseline, an independent existing test oracle, rollback, expected
  outcome, source fingerprint/window/SHA/evidence, exact allowed files, dependencies,
  risk tier, and an explicitly authorized scope issue.

## Safe outputs

- Emit `submit_signal` exactly once only for a complete, corroborated candidate.
  It rechecks freshness, deduplication, human-backed control/goal, scope, risk,
  WIP1, lifetime assignment budget, and current-SHA evaluation capacity.
  Admission is not readiness or verified delivery. A rejection creates no work.
- Use `noop` for no eligible signal, paused/shadow control, exhausted capacity,
  stale/duplicate signals or no explicitly authorized scope.
