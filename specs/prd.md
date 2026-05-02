# Project Krypto — Product Spec

> **This document is the single source of truth for the current state of Project Krypto.**
> Historical PRDs are preserved in [`specs/archive/`](./archive/). Architectural decisions are logged in [`specs/decisions/`](./decisions/). Future proposals live in [`specs/rfcs/`](./rfcs/).

## Status

| Phase | Description | State |
|---|---|---|
| **v1** | Paper-trading scaffolding: agent loop, guardrails, schema, tools, admin dashboard | ✅ Shipped (tag `spec/v1`) |
| **v2** | Hardening: admin auth, balance validation, full PostHog/email wiring, env validation, Drizzle consolidation | ✅ Shipped (tag `spec/v2`) |
| **v2 deploy** | Vercel + Supabase production deployment with pg_cron, real PnL, runbook | 🚧 In progress |
| **v3** | Live Coinbase AgentKit execution on Base L2, sentiment, advanced orders, scaling | 📋 RFC stub only — see [`rfcs/0001-v3-live-trading.md`](./rfcs/0001-v3-live-trading.md) |

---

## 1. Vision

**Project Krypto** is an autonomous, LLM-driven cryptocurrency trading agent designed to execute swing trades on the ETH/USDC pair.

- **Phase 1 (current):** Paper trading on a strict **$200 USD** notional pool. Goal is *not* profit — it's to debug the agentic loop, refine prompt engineering, prove out execution latency, and ensure engineering guardrails operate flawlessly.
- **Phase 2 (v3+):** Once a statistically significant positive Expected Value is established, capital scales toward an end-state of **$100/day passive profit**. (Mathematically: 0.5% daily return on $20,000.)

---

## 2. Architecture

| Layer | Technology |
|---|---|
| Application | Next.js 16 (App Router), TypeScript, Node.js |
| AI orchestration | LangChain (`@langchain/langgraph` ReAct agent) |
| LLM engine | Azure AI Foundry (Azure OpenAI Service, GPT-4o) |
| Execution venue | Currently: paper trading via Coinbase Spot price API. v3: Coinbase Developer Platform via `@coinbase/agentkit-langchain` |
| Database | Supabase (PostgreSQL) via **Drizzle ORM** |
| Observability | PostHog (events) + Vercel logs + Resend (email alerts) |
| Hosting | Vercel |
| Scheduling | Supabase `pg_cron` + `pg_net` calling the Vercel endpoint hourly |
| Email | Resend |

ADR `0001-drizzle-over-prisma.md` records the Drizzle decision (Prisma was removed in v2).

---

## 3. Database schema

Source of truth: [`src/db/schema.ts`](../src/db/schema.ts). Migrations: [`drizzle/`](../drizzle/) and [`supabase/migrations/`](../supabase/migrations/).

### `AgentState` (singleton — `id = "singleton"`)

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | always `"singleton"` |
| `lastTradePrice` | `double precision` | nullable; the anchor for buy/sell triggers |
| `currentPositionETH` | `double precision` | default `0` |
| `currentPositionUSDC` | `double precision` | default `200` |
| `portfolioValueUSD` | `double precision` | default `200`; updated on each pre-flight check |
| `isLocked` | `boolean` | set true when drawdown breach occurs; manual reset only |
| `isRunning` | `boolean` | mutex flag; atomically flipped at start/end of each run |
| `lastRunAt` | `timestamp(3)` | updated on mutex release |
| `updatedAt` | `timestamp(3)` | auto on update |

### `TradeExecution`

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | UUID |
| `direction` | `TradeDirection` enum | `BUY` or `SELL` |
| `asset` | `text` | `ETH` or `USDC` |
| `amountUSD` | `double precision` | requested USD size |
| `amountAsset` | `double precision` | computed from `amountUSD / executionPrice` |
| `executionPrice` | `double precision` | spot at execution time |
| `feesUSD` | `double precision` | 0.3% modelled |
| `slippage` | `double precision` | always 0 in paper mode |
| `pnlUSD` | `double precision` | nullable; computed for SELLs as `(executionPrice − lastBuyPrice) × amountAsset − feesUSD`, where `lastBuyPrice` is the executionPrice of the most recent BUY trade (queried from `TradeExecution`, NOT taken from `agentState.lastTradePrice`) |
| `agentReasoning` | `text` | snapshot of LLM output |
| `createdAt` | `timestamp(3)` | indexed |

### `AgentJournal`

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | UUID |
| `entryText` | `text` | LLM-written reasoning |
| `marketConditions` | `jsonb` | full snapshot: `{ ethPrice, rsi, emaShort, emaLong, emaCrossover, timestamp }` |
| `tradeExecutionId` | `text` (FK, nullable) | links journal to the trade it caused, if any |
| `createdAt` | `timestamp(3)` | indexed |

---

## 4. Trading strategy

| Parameter | Value | Source |
|---|---|---|
| Pair | ETH/USDC | v1 |
| Initial capital | $200 USD | v1 |
| Buy trigger | ETH drops **3%** from `lastTradePrice` (anchor) | `BUY_TRIGGER_PCT` |
| Sell trigger | ETH rises **3%** from anchor | `SELL_TRIGGER_PCT` |
| Position sizing | $10–$50 per trade (LLM picks in range) | `MAX_TRADE_SIZE_USD = 50` |
| Stop-loss | -15% per trade | `STOP_LOSS_PCT` |
| DCA | Up to **3** consecutive buys as price falls | `MAX_DCA_COUNT` |
| Slippage tolerance | 1% | `SLIPPAGE_TOLERANCE_PCT` |
| Cooldown between trades | 2 hours, DB-enforced | `COOLDOWN_MS` |
| Persona | Balanced swing trader | system prompt |
| Indicators | RSI(14) + EMA(12/26) crossover on 4h candles | `lib/indicators.ts` |

The LLM may both **query indicators on demand** (via tools) and **read pre-computed values** (injected into the system prompt at run start). See `src/agent/prompts/system-prompt.ts`.

---

## 5. Engineering guardrails

All checks live in TypeScript middleware *before* any tool invocation reaches the execution layer.

| # | Guardrail | Implementation | Behaviour |
|---|---|---|---|
| 1 | **Pre-flight killswitch (max drawdown)** | `src/guardrails/drawdown-check.ts` | If `portfolioValueUSD < $150`, set `isLocked = true`, fire email alert, abort run. Manual DB unlock required. |
| 2 | **Anti-hyperactivity (cooldown)** | `src/guardrails/cooldown-check.ts` | If `now − lastTrade.createdAt < 2h`, skip the agent invocation entirely (no LLM cost). |
| 3 | **Max trade size** | `src/tools/safe-trade.ts` (in-tool) | Reject `amountUSD > $50` with an error string returned to the LLM (not a throw — agent can adjust). |
| 4 | **Asset whitelist** | `src/tools/safe-trade.ts` | Reject anything not in `["ETH","USDC"]`. |
| 5 | **Balance validation** | `src/tools/safe-trade.ts` | Before SELL, verify `currentPositionETH ≥ amountAsset`. Before BUY, verify `currentPositionUSDC ≥ amountUSD × 1.003` (fee buffer). Prevents phantom shorts and overdrafts. *(Added in v2.)* |
| Mutex | **Concurrent-run prevention** | `src/app/api/agent/run/route.ts` `acquireMutex()` | Atomic `UPDATE … WHERE isRunning = false RETURNING *`. Returns 409 if locked. Always released in `finally`. |

---

## 6. Self-determinism mitigations (AI risks)

| Risk | Mitigation |
|---|---|
| Hallucination liquidation (LLM invents a trade for $10k) | Hardcoded `safe_trade` tool wrapper with size + asset checks (guardrails 3 & 4) |
| Overtrading / fee bleed | DB-enforced 2h cooldown (guardrail 2) |
| Context-window amnesia | Last 3 `AgentJournal` entries injected into the system prompt every run |
| News-panic selling | v1/v2 operate purely on price action + technicals + own ledger. Sentiment deferred to v3. |
| Phantom positions | Balance validation in `safe-trade` (guardrail 5) |

---

## 7. API surface

### `POST /api/agent/run`
- **Auth:** `x-cron-secret` header matched against `CRON_SECRET`.
- **Flow:** validate env → acquire mutex → pre-flight guardrails → fetch portfolio + journal + market data → invoke LangChain agent (3 retries on Azure 429) → log analytics → release mutex.
- **Response:** `AgentRunResult` JSON (`status`, `action`, `reasoning`, `trade`, `portfolioState`, `tokenUsage`, `durationMs`).

### `POST /api/agent/daily-summary`
- Same `CRON_SECRET` auth. Aggregates last 24h trades + journals, sends Resend email via `sendDailySummary()`.

### `POST /api/auth/login`, `GET /api/auth/logout`
- Password check against `ADMIN_PASSWORD`. Sets HMAC-signed `krypto-admin-token` cookie (HTTP-only, SameSite=Lax, 24h).

### `/admin`, `/admin/trades`, `/admin/journal`
- Server-rendered dashboard. Protected by `src/middleware.ts` matcher `/admin/:path*` (excludes `/admin/login`).

---

## 8. Observability

### PostHog events (all wired in v2)

| Event | Trigger |
|---|---|
| `agent_run_started` | Top of `POST /api/agent/run` |
| `agent_run_completed` | After agent returns (success / skipped / locked) |
| `guardrail_triggered` | Cooldown or drawdown skip |
| `trade_executed` | After `safe_trade` succeeds |
| `llm_token_usage` | When LangChain returns `usage_metadata` |

### Email alerts (Resend)

- `sendGuardrailAlert(...)` — fired from `checkDrawdown` when system locks.
- `sendDailySummary(...)` — fired from the daily-summary cron route.

If `RESEND_API_KEY` / `ALERT_EMAIL_*` are missing, both helpers degrade to console logs.

### Vercel logs
- Default function logs for everything else (errors, retries, mutex release failures).

---

## 9. Environment variables

Production requires *all* of the following (see [`.env.example`](../.env.example)):

| Variable | Purpose | Required |
|---|---|---|
| `AZURE_OPENAI_ENDPOINT` | LLM endpoint URL | yes |
| `AZURE_OPENAI_API_KEY` | LLM API key | yes |
| `AZURE_OPENAI_DEPLOYMENT_NAME` | GPT-4o deployment name | yes |
| `CDP_API_KEY_NAME` | Coinbase CDP key (v3) | yes (declared, unused in v2) |
| `CDP_API_KEY_PRIVATE_KEY` | Coinbase CDP private key (v3) | yes (declared, unused in v2) |
| `DATABASE_URL` | Supabase Postgres URL (use `?pgbouncer=true` for runtime) | yes |
| `POSTHOG_API_KEY` | PostHog ingest key | yes |
| `POSTHOG_HOST` | PostHog host | optional, default `https://us.i.posthog.com` |
| `CRON_SECRET` | Auth header for cron-triggered routes | yes |
| `RESEND_API_KEY` | Resend API key for emails | optional (no-op if absent) |
| `ALERT_EMAIL_TO` | Recipient for guardrail/daily emails | optional |
| `ALERT_EMAIL_FROM` | Verified sender domain | optional |
| `ADMIN_PASSWORD` | Admin dashboard password | yes |
| `ADMIN_SESSION_SECRET` | HMAC key for admin cookies | yes (falls back to `CRON_SECRET` with deprecation warning) |

Validation happens at run start via `validateEnv()` in `src/lib/config.ts` (Zod schema).

---

## 10. Deployment model

- **Hosting:** Vercel (linked project, `develop/v2` → `main` branch deploys to prod).
- **Database:** Supabase Postgres. Migrations applied via `supabase db push` or `npm run db:push`.
- **Singleton seeding:** `npm run db:seed` (one-shot before the first cron run, otherwise `checkDrawdown` 500s).
- **Cron:** Supabase `pg_cron` + `pg_net`, scheduled via `supabase/migrations/20260322000002_cron_schedule.sql`. Two jobs:
  - hourly → `POST https://<vercel-host>/api/agent/run`
  - daily 00:00 UTC → `POST https://<vercel-host>/api/agent/daily-summary`
- **Smoke test + rollback:** see [`specs/deployment.md`](./deployment.md).

ADR `0003-pg-cron-over-vercel-cron.md` records why we chose Supabase `pg_cron` over Vercel Cron.

---

## 11. Error handling & recovery

| Failure mode | Behaviour |
|---|---|
| Mid-trade crash | Log + skip. No retry (avoids double trades). |
| Coinbase API unreachable | Abort run with HTTP 502; next cron tick retries naturally. |
| Azure OpenAI 429 | Retry up to 3× with exponential backoff (1s, 2s, 4s). |
| Drawdown breach | Lock + alert. Manual DB `UPDATE "AgentState" SET "isLocked" = false WHERE id = 'singleton'` to resume. |
| Mutex stuck (e.g. crashed mid-run) | Manual `UPDATE "AgentState" SET "isRunning" = false WHERE id = 'singleton'`. |
| Cron HTTP timeout | Vercel kills > 60s; `pg_net` records the response status — see Supabase `net._http_response`. |

---

## 12. Testing

- Unit: all 4 guardrails, `safe_trade` size/asset/balance checks, seed data shape.
- Integration: `tests/agent/agent-run.integration.test.ts` exercises the route handler (in-progress: should un-mock `runAgent` and only stub external HTTP — tracked separately).
- Run with `npm test`. CI: `.github/workflows/ci.yml` runs lint + test on PRs.

---

## 13. Out of scope

The following are explicitly deferred to v3 (see [`rfcs/0001-v3-live-trading.md`](./rfcs/0001-v3-live-trading.md)):

- Live Coinbase AgentKit execution on Base L2.
- Sentiment / news feeds.
- Advanced order types (trailing stops, limit orders).
- Capital scaling beyond $200.
- WebSocket-triggered runs (volatility-based).
- Backtesting infrastructure.
- Multi-user admin auth, SSO.
