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
4. Keep baseline merge/routing/authority policy in
   `.github/agentic-policy.json`; validate it with
   `.github/scripts/agentic-policy.cjs`.
5. Accept work only under a human-approved `factory:goal` and use issues,
   sub-issues, milestones, and labels as the queue source of truth.
6. Let the deterministic queue controller select and claim one issue; use
   `implement-ticket` only to assign that exact claim to the Copilot coding
   agent.
7. Let the deterministic lifecycle reconciler independently verify claim
   provenance, exactly one Copilot PR, merge SHA, and exact-SHA dev evidence
   before closing the issue.
8. Treat labels as explicit lifecycle state and keep exactly one lifecycle
   label plus one risk label on each queued item.
9. Permit agent-consensus merge for routine and sensitive/reversible changes
   only after all exact-current-head checks pass. Boundary/irreversible changes
   require a current-head trusted human approval.
10. Auto-deploy only to exact-SHA dev/staging. Production deployment, secrets,
   permission widening, schedule activation, and live trading remain human-only.

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
- `factory:claimed`
- `factory:implementing`
- `factory:pr-open`
- `factory:repairing`
- `needs-ai-review`
- `needs-qa`
- `security-review`
- `trading-safety`
- `docs-sync`
- `release-readiness`
- `ready-for-human-review`
- `blocked`
- `factory:merged`
- `factory:deployed-dev`
- `factory:done`
- `agentic-automerge`
- `self-heal-exhausted`
- `ci-failure`
- `report`
- `factory:goal`
- `factory:goal-approved`
- `factory-control`
- `factory-mode:shadow`
- `factory-mode:active`
- `factory-mode:paused`
- `risk:routine`
- `risk:sensitive`
- `risk:boundary`

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

That filter is not the risk classifier. Use
`.github/scripts/agentic-factory-policy.cjs` as the only path-risk source:
routine changes need baseline checks; sensitive/reversible changes add QA and
path-selected specialists; boundary changes add current-head human approval.
Unknown paths, malformed risk data, factory-control files, live/production
boundaries, permission policy, destructive migrations, and migrations whose
patch content is unavailable fail closed to `risk:boundary`.
The specialist route regexes remain centralized in
`.github/agentic-policy.json`; the deterministic factory policy adds the
goal/risk/path ceiling without weakening those routes.

## Merge and self-heal policy

- `implement-ticket` validates one claim and uses `assign-to-agent`; it never
  edits code or creates a PR itself.
- The lifecycle reconciler enrolls only a same-repository
  `copilot-swe-agent[bot]` PR whose `[ai-dev] ` title, issue reference, claim
  marker, and nonce all match the controller claim.
- `needs-qa`, `security-review`, and `trading-safety` are persistent
  review-requirement labels, not lifecycle state. Their current-head checks are
  the merge signals and rerun after every new head.
- Routine PRs require baseline CI and code review. Sensitive PRs additionally
  require `QA verification` and every path-selected specialist check.
  Boundary PRs require all of those plus current-head human approval.
- A current human change request always vetoes merge.
- Required contexts are `Quality and evidence gates`,
  `PostgreSQL migrations and execution`, `Agentic code review`, and
  the reconciler's internal policy evaluation; required conversation resolution
  still applies.
- Self-heal never treats missing or held checks as failures. It stops after two
  routine attempts, one sensitive attempt, or zero boundary attempts, and
  never edits factory, production, live, permission, or unrelated scope.

## Proactive opportunity discovery

`opportunity-discovery.md` runs weekly or through `/discover`, but it may create
work only inside one active human-approved goal.

- It calls `noop` immediately when there are at least 20 open `opportunity`
  issues without `blocked`.
- It also calls `noop` when no goal is approved or the goal's queue/WIP or
  assignment budget is full.
- It creates at most one `[opportunity]` issue per run.
- Every created issue receives `agentic-factory`, `opportunity`, and
  `needs-rubber-duck`; discovery must not apply `ready-for-planning` or
  `ready-for-ai-dev`.
- Allowed scope is the intersection of the active goal, its milestone, v2.1/
  v2.2 governance, and its maximum risk tier.
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
- Run QA, security, and trading-safety through requirement labels or
  deterministic path dispatch. Implementation is queue-only; `/implement` is
  not an authority bypass.
- Configure `noop.report-as-issue: false` unless a no-op should become visible repository work.
- Prefer CODEOWNERS and human branch protection for high-risk surfaces.
