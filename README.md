# 🐕 Project Krypto

> **Autonomous LLM-driven swing-trading agent for ETH/USDC.**
> v2.1 safety core is implemented and locally verified. **NOT production-ready**
> until the target database is inventoried/backed up and target smoke,
> controlled rollout, and evidence gates pass.

| | |
|---|---|
| **Status** | v2.1 safety core verified locally -- production inventory and release gates remain |
| **Hosting** | Vercel + Supabase + Azure AI Foundry-hosted Anthropic + PostHog + Resend |
| **Stack** | Next.js 16 (App Router) · TypeScript · structured Anthropic output · deterministic policy/executor · Drizzle ORM · PostgreSQL |
| **Trigger** | Restricted fixed Supabase `pg_cron` + `pg_net` functions; scheduling remains disabled until production smoke checks pass |
| **Spec** | [`specs/prd.md`](./specs/prd.md) (current) · [`specs/archive/`](./specs/archive/) (v1, v2 history) |
| **Deploy** | [`specs/deployment.md`](./specs/deployment.md) |
| **Local test** | [`specs/local-testing.md`](./specs/local-testing.md) |
| **Monitoring** | [`specs/monitoring.md`](./specs/monitoring.md) |
| **Readiness** | [`specs/readiness.md`](./specs/readiness.md) |
| **Evaluation** | [`specs/evaluation.md`](./specs/evaluation.md) |
| **Design** | [`DESIGN.md`](./DESIGN.md) |
| **Decisions** | [`specs/decisions/`](./specs/decisions/) (ADRs) |
| **Future work** | [`specs/rfcs/`](./specs/rfcs/) (RFC 0001: v3 live trading · RFC 0002: Evidence-Grade Paper Trading) |

## What it does

Every hour, a cron job hits `POST /api/agent/run`. The route:

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
  -H "x-cron-secret: $(grep CRON_SECRET .env | cut -d= -f2-)"

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
| `npm run test:migrations` | Real-PostgreSQL migration, privilege, decimal, transaction, lease, and run-flow tests |
| `npm run db:studio` | Drizzle Studio (browse the DB) |
| `npm run smoke:llm` | Verify Foundry model access without tools or trading |
| `npm run backtest -- --scenario scenarios/dip-recovery.json` | Run deterministic paper scenario evaluation |
| `npm run backtest:all` | Emit aggregate JSON for every engineering scenario |

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
supabase/operations/      # Separate reviewed cron enable/disable operations
specs/                    # Product spec, ADRs, RFCs, deployment runbook
scripts/                  # One-shot scripts (seed, etc.)
tests/                    # Jest unit + integration tests
```

## Deploying

> **WARNING:** Do not promote the current source to production paper mode yet.
> The local safety core is verified, but the production database remains
> uninventoried because its configured credentials are stale. Target-environment
> smoke checks and controlled disabled/shadow/paper rollout also remain. See
> [`specs/readiness.md`](./specs/readiness.md) for the full release gates.

Don't `vercel --prod` blind -- there are ordered steps including backup,
schema reconciliation, reviewed Drizzle migrations, Vault secrets, smoke
tests, and cron enablement. Follow
[`specs/deployment.md`](./specs/deployment.md).

## Local testing

Use [`specs/local-testing.md`](./specs/local-testing.md) for local Postgres setup, no-LLM smoke tests, optional live local paper runs, admin dashboard checks, and the current limits of profitability testing.

## Contributing / spec changes

Project Krypto uses a hybrid spec strategy (see ADR [`0004-hybrid-spec-strategy.md`](./specs/decisions/0004-hybrid-spec-strategy.md)):

- **Behaviour change** → update `specs/prd.md` in the same PR.
- **Architectural decision** → add an ADR under `specs/decisions/`.
- **Future proposal** → open an RFC under `specs/rfcs/`.

## Repository

[github.com/VeVarunSharma/project-krypto-dog](https://github.com/VeVarunSharma/project-krypto-dog)
