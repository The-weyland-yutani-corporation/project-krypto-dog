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
| `agentic-corrections` | `Built-in prompt` | manual; schedule: weekly on monday | `create-issue`, `noop` | 1000 / 2500 |
| `agentic-governance` | `Built-in prompt` | manual; schedule: weekly on monday | `create-issue`, `noop`, `update-issue` | 1000 / 2500 |
| `ci-doctor` | `Built-in prompt` | manual; workflow_run: CI | `add-comment`, `create-issue`, `noop` | 1200 / 3000 |
| `code-review` | `Built-in prompt` | manual; PR: opened, ready_for_review, reopened, synchronize | `add-comment`, `add-labels`, `create-issue`, `jobs`, `noop` | 1500 / 5000 |
| `daily-repo-status` | `Built-in prompt` | manual; schedule: daily | `create-issue`, `noop`, `update-issue` | 1000 / 2500 |
| `docs-sync` | `docs-spec-writer.md` | manual; issue label: docs-sync; PR: labeled | `add-comment`, `create-issue`, `create-pull-request`, `noop`, `remove-labels` | 1400 / 3000 |
| `em-planning` | `engineering-manager.md` | manual; issue label: ready-for-planning | `add-comment`, `add-labels`, `create-issue`, `noop`, `remove-labels` | 1200 / 3000 |
| `harness-entropy` | `Built-in prompt` | manual; schedule: weekly on monday | `create-issue`, `noop` | 1000 / 2500 |
| `implement-ticket` | `project-krypto-dev.md` | manual | `add-comment`, `assign-to-agent`, `noop` | 500 / 1500 |
| `opportunity-discovery` | `trading-growth-pm.md` | manual | `add-comment`, `create-issue`, `noop` | 1000 / 2000 |
| `pm-triage` | `product-manager.md` | manual; issue: labeled, opened, reopened | `add-comment`, `add-labels`, `create-issue`, `noop`, `remove-labels` | 1000 / 3000 |
| `pr-self-heal` | `project-krypto-dev.md` | manual | `add-comment`, `add-labels`, `noop`, `push-to-pull-request-branch` | 2200 / 5000 |
| `qa-test-plan` | `qa-engineer.md` | manual; issue label: needs-qa; PR: labeled | `add-comment`, `create-issue`, `jobs`, `noop` | 1600 / 3500 |
| `release-readiness` | `release-manager.md` | manual; /release-readiness; PR: labeled | `add-comment`, `create-issue`, `noop` | 1200 / 3000 |
| `research-brief` | `researcher.md` | manual; /research; issue label: ai:research | `add-comment`, `create-issue`, `noop`, `remove-labels` | 1500 / 4000 |
| `rubber-duck-architecture` | `rubber-duck.md` | manual; issue label: needs-rubber-duck; PR: labeled | `add-comment`, `add-labels`, `noop`, `remove-labels` | 1200 / 3000 |
| `security-review` | `security-reviewer.md` | manual; issue label: security-review; PR: labeled | `add-comment`, `create-issue`, `jobs`, `noop` | 1500 / 3500 |
| `trading-safety-review` | `trading-safety-reviewer.md` | manual; issue label: trading-safety; PR: labeled, opened, reopened, synchronize (path-scoped) | `add-comment`, `add-labels`, `create-issue`, `jobs`, `noop` | 1600 / 4000 |

<!-- generated:workflow-inventory:end -->

## Typical paths

Issues flow through PM/planning/implementation; PRs flow through code/QA and conditional security/trading review; failures may enter capped self-heal; schedules produce read-only governance, evaluation, status, or opportunity evidence.
