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
5. Open implementation and docs-sync PRs ready for review (`draft: false`) with native auto-merge enabled; auto-merge is not authorization to bypass policy.
6. Allow same-repository merges only after current-head code review and every
   deterministically selected specialist check pass. Forks require current human
   approval; humans retain production, live-trading, secrets, and architecture
   authority.
7. Route risky changes through security, trading-safety, QA, and architecture reviews.
8. Let proactive PM/research discovery originate software opportunities, but never bypass trading safety.

## Core labels

- `agentic-factory`
- `opportunity`
- `profit-hypothesis`
- `experiment`
- `strategy-research`
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
- `blocked`
- `agentic-automerge`
- `self-heal-exhausted`
- `ci-failure`
- `report`

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
- `trading-growth-pm.md`

## Validation baseline

Use existing scripts only:

- `npm run lint`
- `npm run typecheck:scripts`
- `npm run build`
- `npm test -- --ci`

## High-risk surfaces

The automatic `trading-safety-review` PR path filter covers:

- `src/tools/**`
- `src/guardrails/**`
- `src/agent/**`
- `src/app/api/agent/**`
- `src/db/**`
- `drizzle/**`
- `supabase/migrations/**`
- `specs/rfcs/**`

That path filter is not a complete risk classification. Explicitly route other
risky changes, including `src/trading/**`, auth/admin APIs, `src/proxy.ts`,
deployment procedures, workflow/policy files, and future live-execution paths,
to the appropriate specialist review. The deterministic merge policy keeps all
of these paths gated on the applicable current-head agent checks.

## Merge and self-heal policy

- `implement-ticket` and `docs-sync` create non-draft PRs with
  `agentic-automerge` and native auto-merge enabled.
- Same-repository PRs may pass merge policy when `Agentic code review` and every
  specialist check selected from changed paths pass on the current head.
- Forked PRs require a current approval from a trusted human reviewer. A current
  trusted human change request remains a veto.
- Trusted enrolled agent PRs are same-repository PRs from
  `github-actions[bot]` or `copilot-swe-agent[bot]`, with an `[ai-dev] ` or
  `[docs-sync] ` title and `agentic-automerge`.
- Self-heal is further limited to trusted enrolled agent PRs that contain only
  added or modified non-sensitive `docs/**` files using `.gif`, `.jpg`, `.jpeg`,
  `.md`, `.png`, `.txt`, or `.webp`. Both current and previous paths must be
  allowlisted.
- The reconciler denies docs paths with these sensitive segment/name tokens:
  `agentic`, `auth`, `backup`, `database`, `deploy`, `deployment`, `env`,
  `guardrail`, `guardrails`, `incident`, `migration`, `migrations`, `oncall`,
  `operator`, `policy`, `production`, `release`, `rollback`, `runbook`,
  `runbooks`, `secret`, `secrets`, `security`, `trading`, `workflow`, and
  `workflows`. Renames and deletions are also outside the allowlist.
- `blocked`, `self-heal-exhausted`, `needs-qa`, `security-review`,
  `trading-safety`, and `ready-for-human-review` keep merge policy pending.
  A `docs-sync` label on a PR without the `[docs-sync] ` title is also blocking.
- Required contexts are `Quality and evidence gates`,
  `PostgreSQL migrations and execution`, `Agentic code review`, and
  `Agentic merge policy`; required conversation resolution still applies.
- Self-heal uses the same low-risk boundary, never treats missing or held checks
  as repairable failures, and stops after two trusted `[self-heal]` commits or
  a completed no-change repair run.
- Humans retain control over production deployment, live-trading enablement,
  secrets and external accounts, and accepting architecture decisions.

## Proactive opportunity discovery

`opportunity-discovery.md` is the self-starting PM/research intake path. It runs
weekly and can also be triggered manually or with `/discover`.

- It calls `noop` immediately when there are at least 20 open `opportunity`
  issues without `blocked`.
- It creates at most one `[opportunity]` issue per run.
- Every created issue receives `agentic-factory`, `opportunity`, and
  `needs-rubber-duck`; discovery must not apply `ready-for-planning` or
  `ready-for-ai-dev`.
- Allowed scope is v2.1 safety/correctness foundations, v2.2 evidence
  foundations, and factory/QA/observability improvements.
- Strategy experiments such as ATR, MACD, volume signals, regime classifiers,
  EMA filters, and dynamic sizing are deferred and must produce `noop`.
- Trading-strategy, guardrail, portfolio, risk, or live-adjacent opportunities must include safety notes and require rubber-duck/trading-safety review before implementation.
- It creates software tickets and experiments only; it never gives trading advice or authorizes live trading.

## Design-system convention

- Root `DESIGN.md` is the source of truth for frontend/admin/chart styling.
- Frontend implementation agents must use shadcn/ui + Tailwind and keep the dark trading-terminal/operator-console direction.
- Chart work must use EvilCharts-inspired Recharts components/patterns.
- Design deviations should be explained in PR notes or follow-up issues.

## Cost and noise controls

- Keep routine automatic review to `code-review` on opened, synchronized,
  reopened, and ready-for-review PRs; automatic trading-safety review remains
  limited to its configured path filter.
- Run QA, security, docs-sync, and implementation through labels or explicit commands unless a path-based safety trigger is required.
- Configure `noop.report-as-issue: false` unless a no-op should become visible repository work.
- Prefer CODEOWNERS and human branch protection for high-risk surfaces.
