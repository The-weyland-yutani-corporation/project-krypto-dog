# 🐕 Project Krypto

```text
+--------------------------------------------------------------------------------------+
|                            P R O J E C T   K R Y P T O                               |
|                                                                                      |
|          /^-----^\                              /\                    |       |      |
|         V  o o  V                             /  \              |    |   |   |       |
|          |  Y  |                             / /\ \            _|_  _|_ _|_ _|_      |
|           \ Q /             __              / /  \ \            |    |   |   |       |
|       ____/ - \____     _.-'  `-._         /_/____\_\      _____|____|___|___|_____  |
|    .-' ___| K |___ `---'          `-.     <___ ETH ___>    MARKET: ETH / USDC        |
|   /_.-'   |___|   `-._               \     \ \    / /                                |
|         _/ / \ \_      `---------------'     \ \  / /     PAPER ONLY // SAFETY FIRST |
|        (__/   \__)                            \ \/ /                                 |
|                                                \  /                                  |
|                                                 \/                                   |
|                                                                                      |
|                    SUPER-DOG INSTINCTS. HARD-CODED GUARDRAILS.                       |
+--------------------------------------------------------------------------------------+
```

> **Autonomous LLM-driven swing-trading agent for ETH/USDC.**
> The Azure dev and production releases are deployed.
> Dev is `shadow` with monitored schedules; production is deliberately
> `disabled` with every job `Manual`. **Paper promotion and live-money
> execution are not authorized.**

| | |
|---|---|
| **Status** | **Azure releases deployed.** Dev passed migration, target smoke, manual-shadow activation, alert delivery, and its first scheduled run. Production passed migration, restore-verified backup, and target smoke, and remains disabled/manual. |
| **Hosted today** | [Azure dev](https://ca-dev-web.wonderfulmoss-0222e5e1.westus3.azurecontainerapps.io/) · [Azure production](https://ca-prod-web.ambitioussea-a305198e.westus3.azurecontainerapps.io/) |
| **Azure state (2026-08-15)** | Application/data resources run in `westus3`. Operational dev/prod `gpt-5.6-luna` deployments run on `ghcp-foundry-eastus2` with Entra authentication. The dedicated `ai-krypto-westus3` account remains model-empty after `715-123420`. |
| **Current blockers** | A separate PostHog project and a new evidence-bound promotion design remain mandatory before production may leave `disabled`. The 90-day production evidence policy remains `Unlocked` pending separate irreversible approval. |
| **Stack** | Next.js 16 (App Router) · TypeScript · structured GPT-5.6 Luna output · deterministic policy/executor · Drizzle ORM · PostgreSQL |
| **Scheduling state** | Dev hourly/daily jobs are monitored `Schedule` jobs in `shadow`; production jobs are all `Manual` and production has no promotion workflow. |
| **Trigger (Azure runbook, implemented)** | Azure Container Apps Jobs (scheduled for recurring triggers, manual for operator actions); see ADR `0008` and `infra/README.md` |
| **Architecture and live links** | [`specs/architecture.md`](./specs/architecture.md) — hosted baseline, target diagrams, planned resources, live endpoint register, rollout safety, and operator consoles |
| **Spec** | [`specs/prd.md`](./specs/prd.md) (current) · [`specs/archive/`](./specs/archive/) (v1, v2 history) |
| **Deploy** | [`specs/deployment.md`](./specs/deployment.md) (Azure runbook) · [`infra/README.md`](./infra/README.md) (Bicep infrastructure design) |
| **Local test** | [`specs/local-testing.md`](./specs/local-testing.md) |
| **Monitoring** | [`specs/monitoring.md`](./specs/monitoring.md) |
| **Readiness** | [`specs/readiness.md`](./specs/readiness.md) |
| **Evaluation** | [`specs/evaluation.md`](./specs/evaluation.md) |
| **Design** | [`DESIGN.md`](./DESIGN.md) |
| **Decisions** | [`specs/decisions/`](./specs/decisions/) (ADRs) |
| **Future work** | [`specs/rfcs/`](./specs/rfcs/) (RFC 0001: v3 live trading · RFC 0002: Evidence-Grade Paper Trading) |

## What it does

When scheduling is enabled, an hourly job hits `POST /api/agent/run`. The route:

1. Creates or idempotently recovers an `AgentRun`, then claims an owned,
   expiring account lease.
2. Applies the configured `disabled`, `shadow`, or `paper` rollout mode.
3. Fetches validated Coinbase data, marks the account to market, and computes
   deterministic cold-start, stop-loss, drawdown, cooldown, sizing, DCA,
   exposure, and take-profit eligibility.
4. Executes mandatory safety exits without the model. For optional actions,
   requests exactly one structured `HOLD`, `BUY`, or `SELL` proposal from the
   dedicated Foundry-hosted OpenAI `gpt-5.6-luna` deployment with bounded
   timeout/retry behavior and Microsoft Entra authentication.
5. Re-authorizes every invariant against a freshly locked database row. In
   paper mode, the trade, fixed-point accounting transition, run outcome, and
   reconciliation state commit atomically and idempotently.
6. Persists the journal/run result, emits and flushes telemetry, and releases
   only the lease owned by that invocation.

A separate daily-summary job emails the previous 24h of trades + PnL through
the environment's Azure Communication Services Email resource.

## Local quick-start

```bash
# 1. Install deps
npm install

# 2. Spin up local Postgres
docker compose up -d
# (Postgres on :5433, user/pass krypto/krypto_local, db krypto)

# 3. Configure env
cp .env.example .env
# For attended agent calls, run `az login` and fill in the environment-specific
# AZURE_FOUNDRY_PROJECT_ENDPOINT, AZURE_FOUNDRY_AGENT_NAME, and immutable
# AZURE_FOUNDRY_AGENT_VERSION. Azure runtime also requires AZURE_CLIENT_ID.
# Fill in POSTHOG_API_KEY, CRON_SECRET,
# ADMIN_PASSWORD, and ADMIN_SESSION_SECRET.
# ACS Email vars may be omitted locally; non-production delivery then reports
# an explicit console-only skipped result.

# 4. Apply reviewed schema migrations + initialize singleton
npm run db:migrate
npm run db:init

# 5. Run dev server
npm run dev
# → http://localhost:3000

# 6. Trigger an agent run manually
curl -X POST http://localhost:3000/api/agent/run \
  -H "x-cron-secret: $(grep CRON_SECRET .env | cut -d= -f2-)" \
  -H "x-required-rollout-mode: $(grep ROLLOUT_MODE .env | cut -d= -f2-)"

# 7. Open the admin dashboard
open http://localhost:3000/admin/login
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Next.js dev server with Turbopack |
| `npm run build` | Production build (also typechecks) |
| `npm run start` | Run the production build |
| `npm run lint` | ESLint over the project |
| `npm test` | Jest unit + integration tests |
| `npm run test:unit` | Deterministic Jest suite in one process |
| `npm run test:coverage` | Jest plus enforced critical-module coverage gates |
| `npm run test:integration` | Real-PostgreSQL migration and execution suite |
| `npm run test:watch` | Jest watch mode |
| `npm run db:generate` | Generate Drizzle migration SQL from schema changes |
| `npm run db:migrate` | Run committed migrations using `DIRECT_URL` |
| `npm run db:init` | Idempotently initialize the `AgentState` singleton |
| `npm run test:migrations` | Real-PostgreSQL migration, privilege/tamper, decimal, transaction, lease, run-flow, preflight, and backup tests |
| `npm run db:studio` | Drizzle Studio (browse the DB) |
| `npm run foundry:agent -- <deploy\|show\|smoke> --environment <dev\|prod> --project-endpoint <endpoint>` | Deploy, attest, inspect, or no-trade smoke the environment's immutable Foundry prompt agent |
| `npm run smoke:llm` | Optional platform-operator diagnostic for direct Luna model access; application runtime does not use this path |
| `npm run deployment:preflight -- --provider azure` | Prove runtime/direct DB identity, exact schema/migration state, leases, ACLs, and retirement of legacy scheduler/Vault objects |
| `npm run deployment:backup -- --out <dir>` | Bind `DATABASE_URL`/`DIRECT_URL`, refuse active legacy scheduler/queued HTTP state and migration-only targets, create checksummed archives, and optionally prove a local restore |
| `npm run smoke:target -- --base-url <url> --confirm-host <host>` | Bind runtime/direct DB and scheduler auth, prove mismatched-mode rejection plus disabled runs, admin/postconditions, ACS Email, exact Foundry Agent `HOLD`, Coinbase, PostHog, and final unchanged trade state |
| `npm run backtest -- --scenario scenarios/dip-recovery.json` | Run deterministic paper scenario evaluation |
| `npm run backtest:all` | Emit aggregate JSON for every engineering scenario |
| `npm run evidence:import -- --input <dataset.json> --out <materialized.json>` | Strictly validate and hash a versioned JSON evidence dataset |
| `npm run evidence:import -- --input <observations.csv> --manifest <manifest.json> --out <materialized.json>` | Import strict `timestamp,priceUSD` CSV observations with an explicit manifest/gap descriptor |
| `npm run evidence:evaluate -- --dataset <materialized.json> --plan <plan.json> --json-out <report.json> --html-out <report.html>` | Run predeclared isolated walk-forward windows through the production-aligned backtest runner |

Evidence datasets and reports are internal simulation artifacts. Keep real or
large source datasets and generated reports outside git; only tiny deterministic
fixtures belong in `tests/fixtures/evidence/`. Holdout datasets may be evaluated
but are rejected by the parameter-sweep/tuning guard. Evaluation plans require
the raw source-file hash, deterministic complete-materialization hash, a
lowercase 40-hex implementation commit SHA, and a `declaredAt` timestamp
strictly before the first evaluation window. The materialization hash binds the
recorded JSON/CSV import format and both dataset hashes while preserving semantic
canonical equivalence. The commit and declaration time are operator-declared
unless externally bound by retained CI artifact metadata; the evaluator never
shells out to Git. Source metadata and `sourceFileSha256` are likewise
importer/operator-declared because standalone evaluation does not retain the raw
bytes needed for independent recomputation or authenticity verification.
Imported reports are always `engineering-only` and `releaseGateEligible: false`,
regardless of performance.

## Project layout

```
src/
  app/                    # Next.js App Router
    api/agent/run/        # POST /api/agent/run    — main agent loop entry
    api/agent/daily-summary/  # POST — daily PnL email
    api/auth/{login,logout}/  # Admin cookie auth
    api/admin/*              # Admin operations: run, pause, lease recovery, audited unlock
    admin/{,trades,journal,login}/  # Server-rendered dashboard
  agent/                  # Structured decision generation and run orchestration
  trading/                # Deterministic policy, fixed-point accounting, paper executor
  db/                     # Drizzle schema + client
  guardrails/             # Legacy/admin guardrail helpers
  lib/                    # Indicators, analytics, email, config, types
  proxy.ts                # Admin route protection
drizzle/                  # Generated migrations
infra/                     # Bicep platform account/model/agents, dev/prod foundation,
                           # release, rollout, and schedule monitoring
.github/workflows/azure-* # OIDC platform, validation, deploy, and rotation flows
supabase/operations/      # Historical Vercel/Supabase cron operations
specs/                    # Product spec, ADRs, RFCs, deployment runbook
scripts/                  # One-shot scripts (seed, etc.)
tests/                    # Jest unit + integration tests
```

## Deploying

> **WARNING:** No executable production promotion workflow is shipped or
> approved. Dev is live in shadow/scheduled mode and production is
> disabled/manual on the validated pre-agent image. Foundry prompt agents are
> active; the agent-integrated image cutover remains gated by reviewed release
> smoke and legacy-role retirement. See
> [`specs/readiness.md`](./specs/readiness.md) for the remaining gates.

> **Target platform: Azure-native; dev and production releases deployed.**
> The approved deployment plan supersedes Vercel/Supabase with a fully
> Azure-native target (ADR
> [`0008`](./specs/decisions/0008-azure-native-deployment-architecture.md)).
> The Bicep templates, GitHub Actions workflows, and application-side
> deployment code for that target all exist in this repo — see
> [`infra/README.md`](./infra/README.md) and
> [`specs/deployment.md`](./specs/deployment.md). Required providers,
> bootstrap/OIDC, operational Luna, workload access, both foundations, and both
> releases are live. Dev is shadow/scheduled; production is disabled/manual.
> See [`specs/architecture.md`](./specs/architecture.md) for diagrams,
> live/planned resource names, the exact current-vs-target state, and safe
> operator links. The selected runtime subscription is **Visual Studio
> Enterprise Subscription**; do not publish its subscription ID.

Observed live runs:

- [Dedicated account succeeded; model deployment failed](https://github.com/The-weyland-yutani-corporation/project-krypto-dog/actions/runs/31839812884) (fallback Luna is now live on the established account)
- [Dev foundation passed](https://github.com/The-weyland-yutani-corporation/project-krypto-dog/actions/runs/31841581875)
- [Prod foundation passed](https://github.com/The-weyland-yutani-corporation/project-krypto-dog/actions/runs/31841960745)

GitHub Environments, branch restrictions, and protected values are configured.
Enterprise-hosted Actions are active ([proof run
31981510383](https://github.com/The-weyland-yutani-corporation/project-krypto-dog/actions/runs/31981510383));
`CI_RUNNER_LABEL` is unset; the temporary Azure self-hosted runner registrations
and their runner resource group are retired. `platform`, `production-deploy`,
and `production-promotion` require
review by `@VeVarunSharma` with `prevent_self_review=false`; `development`
intentionally has no required reviewer so routine dev releases can proceed.
Every mutation still requires the configured branch, an exact CI-passed source
SHA, and the workflow's fail-closed checks. The first releases used the
authenticated operator path before Enterprise-hosted Actions became available.
Shared-key PostHog telemetry is environment-tagged but cannot qualify as final
project isolation for production promotion.

Dev completed the staged
disabled/manual → shadow/manual → unique manual shadow run → post-run
activation proof → monitored schedule sequence with automatic fail-closed
rollback. Missing-success monitoring was
enabled and validated before a Schedule rollout; disable, rollback, and
rotation paths first verify both jobs are Manual and only then disable
monitoring. Production landed disabled/manual and its fresh baseline backup was
restore-verified before target smoke. The
`production-promotion` identity/environment exists only for forced-disable
steps in prod deploy and rotation. Any future production promotion requires a
new evidence-bound design and trading-safety review. Follow
[`specs/deployment.md`](./specs/deployment.md) (the implemented Azure
runbook). The prior Vercel/Supabase runbook is preserved, unmodified
except for its archive banner, at
[`specs/archive/deployment.vercel-supabase.md`](./specs/archive/deployment.vercel-supabase.md)
for historical/safety reference only -- do not follow it to start a new
Vercel/Supabase production deployment.

## Local testing

Use [`specs/local-testing.md`](./specs/local-testing.md) for local Postgres setup, no-LLM smoke tests, optional live local paper runs, admin dashboard checks, and the current limits of profitability testing.

## Contributing / spec changes

Project Krypto uses a hybrid spec strategy (see ADR [`0004-hybrid-spec-strategy.md`](./specs/decisions/0004-hybrid-spec-strategy.md)):

- **Behaviour change** → update `specs/prd.md` in the same PR.
- **Architectural decision** → add an ADR under `specs/decisions/`.
- **Future proposal** → open an RFC under `specs/rfcs/`.

## Repository

[github.com/The-weyland-yutani-corporation/project-krypto-dog](https://github.com/The-weyland-yutani-corporation/project-krypto-dog)
