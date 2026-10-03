# Project Krypto — agent map

Project Krypto is an autonomous ETH/USDC **paper-trading** app. This file is a
map for coding agents, not an encyclopedia. Read the authoritative document a
route points to; do not re-derive policy from memory.

<!-- safety-kernel:start -->
## Safety kernel (never weaken)

- **Paper only.** v2 executes paper trades exclusively. Live execution is a
  separate RFC + explicit rollout; do not enable it here.
- **Model is read-only.** The LLM returns exactly one structured `HOLD`, `BUY`,
  or `SELL` proposal and must never receive a mutating trade tool.
- **Deterministic guardrails hold.** Do not silently weaken
  `evaluateTradePolicy`, `authorizeTradeIntent`, the transactional paper
  executor, accounting reconciliation, drawdown lock, cooldown, operator pause,
  idempotent invocation, or the owned/expiring run lease.
- **Fail loud.** No broad catches or silent fallbacks; journal and alert on
  failure using existing patterns.
- **Design system is binding.** Any frontend, admin UI, chart, or user-facing
  copy/layout change follows root [`DESIGN.md`](./DESIGN.md).

Canonical machine-readable policy data lives in
[`.github/agentic-policy.json`](./.github/agentic-policy.json). Do not duplicate
its lists in prose; reference it.
<!-- safety-kernel:end -->

## Authoritative links

| Concern | Source of truth |
| --- | --- |
| Product behavior / requirements | [`specs/prd.md`](./specs/prd.md) |
| Design system | [`DESIGN.md`](./DESIGN.md) |
| Deployment procedure | [`specs/deployment.md`](./specs/deployment.md) |
| Local testing | [`specs/local-testing.md`](./specs/local-testing.md) |
| Monitoring | [`specs/monitoring.md`](./specs/monitoring.md) |
| Readiness gates | [`specs/readiness.md`](./specs/readiness.md) |
| Agentic SDLC evaluation | [`specs/agentic-sdlc-evaluation.md`](./specs/agentic-sdlc-evaluation.md) |
| Factory autonomy contract | [`specs/agentic-factory-contract.md`](./specs/agentic-factory-contract.md) |
| Architecture decisions | [`specs/decisions/`](./specs/decisions/) |
| Future proposals | [`specs/rfcs/`](./specs/rfcs/) |
| Merge / self-heal / routing policy data | [`.github/agentic-policy.json`](./.github/agentic-policy.json) |
| Factory risk / lifecycle policy core | [`.github/scripts/agentic-factory-policy.cjs`](./.github/scripts/agentic-factory-policy.cjs) |
| Merge-authorization rationale | [`specs/decisions/0008-agentic-merge-authorization.md`](./specs/decisions/0008-agentic-merge-authorization.md) |

## Instruction discovery

Some coding-agent platforms auto-load the nearest `AGENTS.md` for a file; others
do not. **Do not assume automatic nested discovery.** When you work in a mapped
area below, explicitly open its scoped `AGENTS.md` before editing. Role prompts
under `.github/agents/` name the scoped file for their area.

## Repo map

| Area | Path | Scoped instructions |
| --- | --- | --- |
| Agent runtime / decision loop | `src/agent/**` | [`src/agent/AGENTS.md`](./src/agent/AGENTS.md) |
| Trading policy / paper executor | `src/trading/**` | [`src/trading/AGENTS.md`](./src/trading/AGENTS.md) |
| Schema / migrations / seed | `src/db/**`, `drizzle/**` | [`src/db/AGENTS.md`](./src/db/AGENTS.md) |
| Agentic workflows (GH-AW) | `.github/workflows/**` | [`.github/workflows/AGENTS.md`](./.github/workflows/AGENTS.md) |
| Frontend / admin UI | `src/app/**`, `src/components/**` | [`DESIGN.md`](./DESIGN.md) |
| API routes / tools / lib | `src/app/api/**`, `src/tools/**`, `src/lib/**` | root + `src/agent`, `src/trading` |

## Task router

| Task | Read first | Role prompt |
| --- | --- | --- |
| Implement a ticket | linked issue + scoped `AGENTS.md` | [`project-krypto-dev`](./.github/agents/project-krypto-dev.md) |
| Agent/API/backend change | [`src/agent/AGENTS.md`](./src/agent/AGENTS.md) | [`backend-agent-dev`](./.github/agents/backend-agent-dev.md) |
| Trading / guardrail change | [`src/trading/AGENTS.md`](./src/trading/AGENTS.md) | [`trading-safety-reviewer`](./.github/agents/trading-safety-reviewer.md) |
| Schema / migration change | [`src/db/AGENTS.md`](./src/db/AGENTS.md) | [`db-dev`](./.github/agents/db-dev.md) |
| Frontend / chart change | [`DESIGN.md`](./DESIGN.md) | [`nextjs-dev`](./.github/agents/nextjs-dev.md) |
| Workflow authoring/debug | [`.github/workflows/AGENTS.md`](./.github/workflows/AGENTS.md) | [`agentic-workflows`](./.github/agents/agentic-workflows.md) |
| Docs / spec / ADR / RFC | repo convention in [`docs-spec-writer`](./.github/agents/docs-spec-writer.md) | [`docs-spec-writer`](./.github/agents/docs-spec-writer.md) |
| Security review | risk routing below | [`security-reviewer`](./.github/agents/security-reviewer.md) |

## Validation matrix

Prefer the narrowest checks that cover the change; escalate as needed.

| Change area | Commands |
| --- | --- |
| Any TypeScript | `npm run lint`, `npm run build` |
| Agent / trading / lib logic | `npm test -- --ci` (or targeted suite) |
| Schema / migration | `npm run db:migrate` (disposable DB), `npm run db:init`, `npm run test:migrations` |
| Scripts | `npm run typecheck:scripts` |
| App harness / lifecycle | `npm test -- tests/harness` (pure helpers); manual `npm run harness:up` → `npm run harness:status` → `npm run harness:down` (mock, no network) |
| Operator-console UI states | `npm run harness:up` then `npm run harness:browser` (Playwright, pinned Chromium, against a running harness) |
| Real-provider smoke (opt-in) | `npm run smoke:providers -- --allow-network-smoke` (read-only Foundry + Coinbase, shadow) |
| Agentic SDLC contracts | `npm run test:agentic-sdlc` |
| Agentic SDLC evals (factory behavior) | `npm run agentic:evals:check` |

## Risk routing

Path classification is data in
[`.github/agentic-policy.json`](./.github/agentic-policy.json)
(`specialistRouting`). In summary:

- **Security review** — `.github/**`, admin/auth API routes, deployment, auth/
  CSRF/secure-compare libs, `src/proxy.ts`, `.env.example`, build/manifest files.
- **Trading safety review** — `src/agent|backtest|db|guardrails|tools|trading/`,
  `src/app/api/agent/`, `drizzle/`, `specs/rfcs/`.

## Merge & authority policy

The factory light switch is explicit and fail-closed: `active` permits bounded
dispatch and merge actions, `shadow` evaluates without dispatching or merging,
and `paused` performs neither. A missing or ambiguous mode resolves to `paused`.
See [`specs/agentic-factory-contract.md`](./specs/agentic-factory-contract.md).

For **same-repository** pull requests, current-head checks authorize routine and
sensitive merges without blanket per-change human approval:

- every PR requires a passing **Agentic code review**;
- sensitive and boundary work also requires passing **QA verification**;
- security-sensitive paths also require a passing **Security review**;
- trading/guardrail/agent/backtest/db/migration/RFC paths also require a passing
  **Trading safety review**;
- agents may author `risk:boundary` changes, but those changes are never
  auto-repaired or auto-merged; after all current-head automated checks pass,
  **Agentic merge policy** remains `action_required` until an authorized
  repository administrator performs an explicit merge;
- a current trusted human change request or blocking review label keeps the
  **Agentic merge policy** pending (human veto is fail-closed).

**Forked** pull requests require a current trusted **human approval**. The
low-risk non-sensitive `docs/**` allowlist is only a *self-heal repair-commit*
boundary, not the general merge boundary. Passing checks never delegates
operational authority.

### Human-only decisions (agents must stop and escalate)

- production deployment
- live-trading enablement
- secrets and external accounts
- accepting architecture decisions

## Stop conditions

Stop and escalate to a human instead of proceeding when a change would:

- touch any human-only decision above;
- enable or approach live trading without an accepted RFC + release plan;
- weaken any safety-kernel invariant or a `DESIGN.md` safety-state rule;
- require editing `.github/agentic-policy.json` merge/authority semantics;
- come from a fork (needs human approval before merge).

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
