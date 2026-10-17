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



The automatic `security-review` route covers `.github/**`, admin/auth and
deployment surfaces, `.env.example`, and all `specs/**` paths so legacy or
attempted non-canonical proposals fail closed.
Trading-safety routing likewise covers every `specs/**` path, while only the
five canonical files may remain in the specification surface.

That filter is not the risk classifier. Use
`.github/scripts/agentic-factory-policy.cjs` as the only path-risk source:
routine changes need baseline checks; sensitive/reversible changes add QA and
path-selected specialists; boundary changes require the same trusted automated
evidence rather than per-change human approval.
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
  Boundary PRs require all of those, bound to immutable trusted-run receipts.
- A current human change request always vetoes merge.
- Required contexts are `Quality and evidence gates`,
  `PostgreSQL migrations and execution`, `Agentic code review`, and
  `Agentic merge policy`; required conversation resolution still applies.
- Self-heal never treats missing or held checks as failures. It stops after two
  routine attempts, one sensitive attempt, or zero boundary attempts, and
  never edits factory, production, live, permission, or unrelated scope.

## Proactive opportunity discovery

`opportunity-discovery.md` is dispatched daily by the queue controller or
through manual workflow dispatch. It creates work inside the standing repository-authorized
`factory:autonomous-goal`, not a per-batch human-approved goal.

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
- Preserve GitHub-enforced protections. Autonomous merges bind the checked
  SHA and trusted verdict receipts; never bypass checks or arm a future head.
