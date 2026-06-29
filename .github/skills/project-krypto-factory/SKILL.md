---
name: Project Krypto Agentic Software Factory
description: Repo-specific operating model for GH-AW workflows, role agents, labels, quality gates, and safe automation.
disable-model-invocation: true
---

# Project Krypto Agentic Software Factory

Use this skill when designing, debugging, or extending the Project Krypto GH-AW software factory.

## Factory principles

1. Use GH-AW markdown workflows as the orchestration backbone.
2. Keep each workflow small, event-driven, and permission-scoped.
3. Keep agent jobs read-only; use GH-AW safe outputs for issues, comments, labels, and PRs.
4. Treat labels as state transitions.
5. Keep implementation PRs draft-first.
6. Require human review for merges and any production/live-trading decision.
7. Route risky changes through security, trading-safety, QA, and architecture reviews.

## Core labels

- `agentic-factory`
- `needs-triage`
- `ai:research`
- `ready-for-planning`
- `needs-rubber-duck`
- `ready-for-ai-dev`
- `needs-ai-review`
- `needs-qa`
- `security-review`
- `trading-safety`
- `docs-sync`
- `release-readiness`
- `ready-for-human-review`

## Role agents

Role prompts live in `.github/agents/`:

- `researcher.md`
- `product-manager.md`
- `engineering-manager.md`
- `architect.md`
- `rubber-duck.md`
- `nextjs-dev.md`
- `backend-agent-dev.md`
- `db-dev.md`
- `qa-engineer.md`
- `security-reviewer.md`
- `trading-safety-reviewer.md`
- `release-manager.md`
- `docs-spec-writer.md`

## Validation baseline

Use existing scripts only:

- `npm run lint`
- `npm run typecheck:scripts`
- `npm run build`
- `npm test -- --ci`

## High-risk surfaces

Always require extra review for:

- `src/tools/safe-trade*`
- `src/guardrails/**`
- `src/agent/**`
- `src/app/api/**`
- `src/middleware.ts`
- `src/db/**`
- `drizzle/**`
- `.github/workflows/**`
- `specs/deployment.md`
- future live-trading or AgentKit execution paths

## Design-system convention

- Root `DESIGN.md` is the source of truth for frontend/admin/chart styling.
- Frontend implementation agents must use shadcn/ui + Tailwind and keep the dark trading-terminal/operator-console direction.
- Chart work must use EvilCharts-inspired Recharts components/patterns.
- Design deviations should be explained in PR notes or follow-up issues.

## Cost and noise controls

- Keep only lightweight review automatic on PR open/synchronize.
- Run QA, security, docs-sync, and implementation through labels or explicit commands unless a path-based safety trigger is required.
- Configure `noop.report-as-issue: false` unless a no-op should become visible repository work.
- Prefer CODEOWNERS and human branch protection for high-risk surfaces.
