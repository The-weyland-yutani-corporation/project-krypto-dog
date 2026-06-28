# 🐕 Project Krypto

> **Autonomous LLM-driven swing-trading agent for ETH/USDC.**
> Currently in **v2: paper trading on a $200 notional pool**, with v3 (live execution on Base L2 via Coinbase AgentKit) scoped as a separate RFC.

| | |
|---|---|
| **Status** | v2 hardening complete, deployment in progress |
| **Hosting** | Vercel + Supabase + Azure AI Foundry-hosted Anthropic + PostHog + Resend |
| **Stack** | Next.js 16 (App Router) · TypeScript · LangChain (LangGraph ReAct) · Drizzle ORM · PostgreSQL |
| **Trigger** | Supabase `pg_cron` + `pg_net` calling `/api/agent/run` hourly |
| **Spec** | [`specs/prd.md`](./specs/prd.md) (current) · [`specs/archive/`](./specs/archive/) (v1, v2 history) |
| **Deploy** | [`specs/deployment.md`](./specs/deployment.md) |
| **Decisions** | [`specs/decisions/`](./specs/decisions/) (ADRs) |
| **Future work** | [`specs/rfcs/0001-v3-live-trading.md`](./specs/rfcs/0001-v3-live-trading.md) |

## What it does

Every hour, a cron job hits `POST /api/agent/run`. The route:

1. Acquires a DB-level mutex so concurrent runs can't interleave.
2. Runs **pre-flight guardrails** — drawdown killswitch ($150 portfolio floor) and 2-hour trade cooldown.
3. Builds a context: portfolio state, the last 3 journal entries (long-term memory), and pre-computed RSI(14) + EMA(12/26) on 4h candles.
4. Hands the context to a LangGraph ReAct agent (Azure-hosted Anthropic via Azure AI Foundry's `/anthropic` API surface) with a strict system prompt and 6 tools (`safe_trade`, `get_eth_price`, `get_rsi`, `get_ema`, `get_portfolio_state`, `write_journal_entry`).
5. The agent reasons, optionally calls `safe_trade` (which enforces $50 max size, ETH/USDC whitelist, balance validation), and **always** writes a journal entry.
6. Logs everything to PostHog. Fires email alerts on guardrail trips. Writes a fallback journal entry if the model failed to journal. Releases the mutex.

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
# Fill in AZURE_OPENAI_*, POSTHOG_API_KEY, CRON_SECRET, ADMIN_PASSWORD, ADMIN_SESSION_SECRET.
# CDP_API_KEY_* must be present (validated at startup) but unused in paper trading.
# Resend vars are optional — emails fall back to console logs.

# 4. Apply schema + seed singleton
npm run db:push
npm run db:seed

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
| `npm run test:watch` | Jest watch mode |
| `npm run db:generate` | Generate Drizzle migration SQL from schema changes |
| `npm run db:push` | Apply schema to the configured `DATABASE_URL` |
| `npm run db:migrate` | Run committed migrations |
| `npm run db:studio` | Drizzle Studio (browse the DB) |
| `npm run db:seed` | Seed the `AgentState` singleton |

## Project layout

```
src/
  app/                    # Next.js App Router
    api/agent/run/        # POST /api/agent/run    — main agent loop entry
    api/agent/daily-summary/  # POST — daily PnL email
    api/auth/{login,logout}/  # Admin cookie auth
    api/admin/*              # Admin operations: run, pause, release lease
    admin/{,trades,journal,login}/  # Server-rendered dashboard
  agent/                  # LangGraph ReAct agent + system prompt
  db/                     # Drizzle schema + client
  guardrails/             # Pre-flight checks (drawdown, cooldown)
  lib/                    # Indicators, analytics, email, config, types
  tools/                  # LangChain tools the LLM can call
  middleware.ts           # Admin route protection
drizzle/                  # Generated migrations
supabase/migrations/      # Supabase-flavoured schema + seed + cron
specs/                    # Product spec, ADRs, RFCs, deployment runbook
scripts/                  # One-shot scripts (seed, etc.)
tests/                    # Jest unit + integration tests
```

## Deploying

Don't `vercel --prod` blind — there are 7 ordered steps including DB migrations, Vault secrets, smoke tests, and cron enablement. Follow [`specs/deployment.md`](./specs/deployment.md).

## Contributing / spec changes

Project Krypto uses a hybrid spec strategy (see ADR [`0004-hybrid-spec-strategy.md`](./specs/decisions/0004-hybrid-spec-strategy.md)):

- **Behaviour change** → update `specs/prd.md` in the same PR.
- **Architectural decision** → add an ADR under `specs/decisions/`.
- **Future proposal** → open an RFC under `specs/rfcs/`.

## Repository

[github.com/VeVarunSharma/project-krypto-dog](https://github.com/VeVarunSharma/project-krypto-dog)
