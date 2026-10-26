# Agentic workflows map

## SDLC lifecycle

Human-approved goal -> eligible issue -> owned claim -> implementation PR -> current-head reviews/checks -> bounded repair or merge -> exact-SHA development/shadow deployment -> done. Labels and deterministic workflows own transitions; ambiguity blocks.

## Safety and governance model

[`specs/factory.md`](../specs/factory.md) and [`.github/agentic-policy.json`](../.github/agentic-policy.json) are authoritative. Same-repository boundary/architecture work uses risk-selected automated verification, not per-change human approval. Forks and external access retain their explicit controls. Every environment is permanently paper-only; trusted production delivery follows the approved POC gate contract, not model-issued deployment commands.

## Workflow catalog

<!-- generated:workflow-inventory:start -->

_Generated from `.github/workflows/*.md` frontmatter by `scripts/generate-agentic-docs.ts`. Do not edit by hand; run `npm run agentic:docs` after changing a workflow source._

| Workflow | Import | Primary triggers | Safe outputs | AI credits (run / day) |
|---|---|---|---|---|
| `agentic-corrections` | `Built-in prompt` | manual; schedule: weekly on monday | `create-issue`, `noop` | 5000 / 20000 |
| `agentic-governance` | `Built-in prompt` | manual; schedule: weekly on monday | `create-issue`, `noop`, `update-issue` | 5000 / 20000 |
| `ci-doctor` | `Built-in prompt` | manual; workflow_run: CI | `add-comment`, `create-issue`, `noop` | 5000 / 20000 |
| `code-review` | `Built-in prompt` | manual; PR: opened, ready_for_review, reopened, synchronize | `add-comment`, `add-labels`, `create-issue`, `jobs`, `noop` | 5000 / 20000 |
| `daily-repo-status` | `Built-in prompt` | manual; schedule: daily | `create-issue`, `noop`, `update-issue` | 5000 / 20000 |
| `docs-sync` | `docs-spec-writer.md` | manual; issue label: docs-sync; PR: labeled | `add-comment`, `create-issue`, `create-pull-request`, `noop`, `remove-labels` | 5000 / 20000 |
| `em-planning` | `engineering-manager.md` | manual; issue label: ready-for-planning | `add-comment`, `add-labels`, `create-issue`, `noop`, `remove-labels` | 5000 / 20000 |
| `harness-entropy` | `Built-in prompt` | manual; schedule: weekly on monday | `create-issue`, `noop` | 5000 / 20000 |
| `implement-ticket` | `project-krypto-dev.md` | manual | `add-comment`, `assign-to-agent`, `noop` | 5000 / 20000 |
| `opportunity-discovery` | `trading-growth-pm.md` | manual | `add-comment`, `create-issue`, `noop` | 5000 / 20000 |
| `pm-triage` | `product-manager.md` | manual; issue: labeled, opened, reopened | `add-comment`, `add-labels`, `create-issue`, `noop`, `remove-labels` | 5000 / 20000 |
| `pr-self-heal` | `project-krypto-dev.md` | manual | `add-comment`, `add-labels`, `noop`, `push-to-pull-request-branch` | 5000 / 20000 |
| `qa-test-plan` | `qa-engineer.md` | manual; issue label: needs-qa; PR: labeled | `add-comment`, `create-issue`, `jobs`, `noop` | 5000 / 20000 |
| `release-readiness` | `release-manager.md` | manual; /release-readiness; PR: labeled | `add-comment`, `create-issue`, `noop` | 5000 / 20000 |
| `research-brief` | `researcher.md` | manual; /research; issue label: ai:research | `add-comment`, `create-issue`, `noop`, `remove-labels` | 5000 / 20000 |
| `rubber-duck-architecture` | `rubber-duck.md` | manual; issue label: needs-rubber-duck; PR: labeled | `add-comment`, `add-labels`, `noop`, `remove-labels` | 5000 / 20000 |
| `security-review` | `security-reviewer.md` | manual; issue label: security-review; PR: labeled | `add-comment`, `create-issue`, `jobs`, `noop` | 5000 / 20000 |
| `trading-safety-review` | `trading-safety-reviewer.md` | manual; issue label: trading-safety; PR: labeled, opened, reopened, synchronize (path-scoped) | `add-comment`, `add-labels`, `create-issue`, `jobs`, `noop` | 5000 / 20000 |

<!-- generated:workflow-inventory:end -->

## Typical paths

Issues flow through PM/planning/implementation; PRs flow through code/QA and conditional security/trading review; failures may enter capped self-heal; schedules produce read-only governance, evaluation, status, or opportunity evidence.

## MonitorOps collection

Daily status, weekly governance, and entropy run deterministic collection in
trusted pre-agent steps, not through model-selected shell commands. The steps
restore default-branch source, select Node from `.nvmrc`, and install the pinned
GH-AW CLI before `prepare-monitor-ops.cjs` calls `gh aw status` and `gh aw logs`
with a read-only job token. Snapshot and cache writes stay under `/tmp/gh-aw/`.

Collection has a ten-minute limit. Preparation rejects failed collectors,
incomplete log downloads, missing or invalid JSON, and inconsistent
material-state hashes before the agent starts. A failed step reaches GH-AW's
existing conclusion/failure-issue handler; it is not a successful no-op. Only a
successfully collected and validated snapshot can justify a no-material-change
no-op. The entropy path also preserves its valid no-actionable-findings no-op.
Local checks and compilation do not prove that a hosted report was published.
