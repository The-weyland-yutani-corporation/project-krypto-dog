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
> v2.1 safety core is implemented and locally verified. **NOT production-ready**
> until the clean target is migrated, initialized, backed up, deployed in
> disabled mode, and passes target smoke, controlled rollout, and evidence gates.

| | |
|---|---|
| **Status** | Azure deployment implementation is locally verified; Azure dev/prod remain unprovisioned. The hosted Vercel/Supabase baseline is not the current release candidate. |
| **Hosted today (observed baseline)** | Historical Vercel build + fresh Supabase PostgreSQL 17 replacement + existing Foundry/PostHog configuration. See the state map in [`specs/architecture.md`](./specs/architecture.md). |
| **Target (implemented, not provisioned)** | Fully Azure-native: Azure Container Apps + Jobs, private Azure Database for PostgreSQL Flexible Server 17, Key Vault, per-environment ACR, Bicep, and GitHub Actions OIDC. No Azure app URL or live Azure evidence exists yet. |
| **Stack** | Next.js 16 (App Router) · TypeScript · structured Anthropic output · deterministic policy/executor · Drizzle ORM · PostgreSQL |
| **Hosted trigger state** | The fresh Supabase inventory found no active Krypto cron jobs or queued HTTP requests; there is no approved production schedule. |
| **Trigger (Azure runbook, implemented)** | Azure Container Apps Jobs (scheduled for recurring triggers, manual for operator actions); see ADR `0008` and `infra/README.md` |
| **Architecture and live links** | [`specs/architecture.md`](./specs/architecture.md) — hosted baseline, target diagrams, planned resources, live endpoint register, promotion flow, and operator consoles |
| **Spec** | [`specs/prd.md`](./specs/prd.md) (current) · [`specs/archive/`](./specs/archive/) (v1, v2 history) |
| **Deploy** | [`specs/deployment.md`](./specs/deployment.md) (Azure runbook) · [`infra/README.md`](./infra/README.md) (Bicep infrastructure design) |
| **Local test** | [`specs/local-testing.md`](./specs/local-testing.md) |
| **Monitoring** | [`specs/monitoring.md`](./specs/monitoring.md) |
| **Readiness** | [`specs/readiness.md`](./specs/readiness.md) |
| **Production readiness contract** | [`specs/production-readiness-prd.v1.md`](./specs/production-readiness-prd.v1.md) — paper-only controls, ownership, authorization, and gate thresholds |
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
   Foundry-hosted Anthropic model with bounded timeout/retry behavior.
5. Re-authorizes every invariant against a freshly locked database row. In
   paper mode, the trade, fixed-point accounting transition, run outcome, and
   reconciliation state commit atomically and idempotently.
6. Persists the journal/run result, emits and flushes telemetry, and releases
   only the lease owned by that invocation.

A separate daily-summary cron emails the previous 24h of trades + PnL.

## Local quick-start

```bash
# 1. Install deps
npm install

# 2. Spin up local Postgres
docker compose up -d
# (Postgres on :5433, user/pass krypto/krypto_local, db krypto)

# 3. Configure env
cp .env.example .env
# Fill in ANTHROPIC_FOUNDRY_* (or legacy AZURE_OPENAI_*), POSTHOG_API_KEY,
# CRON_SECRET, ADMIN_PASSWORD, ADMIN_SESSION_SECRET.
# Resend vars are optional — emails fall back to console logs.

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
| `npm run smoke:llm` | Verify Foundry model access without tools or trading |
| `npm run deployment:preflight` | Prove runtime/direct DB identity and exact schema/migration, lease, cron/queued HTTP, function-integrity, table/column, and Vault privilege state |
| `npm run deployment:backup -- --out <dir>` | Bind `DATABASE_URL`/`DIRECT_URL`, refuse active cron/queued HTTP and migration-only targets, create checksummed archives, and optionally prove a local restore |
| `npm run smoke:target -- --base-url <url> --confirm-host <host>` | Bind runtime/direct DB and cron configuration, prove mismatched-mode rejection plus disabled runs, auth, postconditions, email, Foundry, Coinbase, and PostHog |
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
infra/                     # Bicep dev/prod platform, release, and rollout
.github/workflows/azure-* # OIDC validation, deploy, rotate, and promote flows
supabase/operations/      # Historical Vercel/Supabase cron operations
specs/                    # Product spec, ADRs, RFCs, deployment runbook
scripts/                  # One-shot scripts (seed, etc.)
tests/                    # Jest unit + integration tests
```

## Deploying

> **WARNING:** Do not promote the current source to production paper mode yet.
> The local safety core is verified and the clean replacement database passed
> fresh-target inventory, but migration, initialization, baseline backup,
> Vault/email configuration, target smoke, and controlled disabled/shadow/paper
> rollout remain. See
> [`specs/readiness.md`](./specs/readiness.md) for the full release gates.

> **Target platform: Azure-native, implemented, not yet provisioned.** The
> approved deployment plan supersedes Vercel/Supabase with a fully
> Azure-native target (ADR
> [`0008`](./specs/decisions/0008-azure-native-deployment-architecture.md)).
> The Bicep templates, GitHub Actions workflows, and application-side
> deployment code for that target all exist in this repo and are locally
> validated — see [`infra/README.md`](./infra/README.md) and
> [`specs/deployment.md`](./specs/deployment.md). **No real Azure
> environment has been provisioned and no live deploy/evidence exists
> yet**; the one-time bootstrap and GitHub Environment setup in
> `specs/deployment.md` §1–§2 are still outstanding manual prerequisites.
> See [`specs/architecture.md`](./specs/architecture.md) for diagrams,
> planned resource names, the exact current-vs-target state, and safe links
> to each existing service console.

Don't deploy blind -- there are ordered steps including bootstrap, GitHub
Environment/OIDC setup, environment/release Bicep deploys, ops-job
evidence (preflight, migration, backup, smoke, activation-check), and a
separate two-step shadow/paper promotion. Follow
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

[github.com/VeVarunSharma/project-krypto-dog](https://github.com/VeVarunSharma/project-krypto-dog)
