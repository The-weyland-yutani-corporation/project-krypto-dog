## Project Krypto v2: Hardening & Completeness

### 1. Overview

PRD v2 addresses all incomplete items, missing wiring, and architectural concerns identified after the v1 implementation. The goal is to bring the existing paper-trading agent to a **production-ready state** — fully wired observability, proper guardrails, admin security, and database hygiene — **without** moving to live Coinbase AgentKit execution (which remains planned for v3).

**Scope:** Fix what's broken, wire what's stubbed, test what's untested. No new features beyond what v1 specified but failed to complete.

---

### 2. Work Items

#### 2.1 Pre-Inject RSI/EMA into Agent Run Context

**Problem:** The `/api/agent/run` route hardcodes `rsi: null`, `emaShort: null`, `emaLong: null` in `MarketData` (route.ts:157-165). The system prompt displays "unavailable" for all indicators, forcing the agent to manually call tools every run — wasting tokens and adding latency.

**Fix:**
- Before invoking the agent, call the same Coinbase Exchange candle endpoint used by the tools (`fetchCandles()`) and compute RSI/EMA server-side.
- Populate `currentMarketData` with real values.
- Extract `calculateRSI` and `calculateEMA` from `src/tools/market-data.ts` into a shared `src/lib/indicators.ts` so both the route and the tools can reuse them without duplication.

---

#### 2.2 Balance Validation Before SELL

**Problem:** `safe-trade.ts` allows SELL trades even when the agent holds 0 ETH. This would result in a negative ETH balance in the DB — a phantom short position the system doesn't support.

**Fix:**
- In `safeTradeHandler`, before executing a SELL:
  - Fetch current `AgentState` singleton.
  - Calculate `amountAsset = amountUSD / executionPrice`.
  - If `state.currentPositionETH < amountAsset`, return an error string back to the LLM: `"Error: Insufficient ETH balance. You hold X ETH but this trade requires Y ETH."`
- Similarly, for BUY: check `state.currentPositionUSDC >= amountUSD + feesUSD`.

---

#### 2.3 Wire Email Alerts into Guardrails & Run Route

**Problem:** `src/lib/email.ts` has fully-implemented `sendGuardrailAlert()` and `sendDailySummary()` functions, but they're never called anywhere.

**Fix:**
- **Guardrail alerts:** In `src/guardrails/drawdown-check.ts`, call `sendGuardrailAlert("Max Drawdown", { portfolioValue })` when the system locks.
- **In the run route:** Call `sendGuardrailAlert()` when cooldown or drawdown skips a run.
- **Daily summary:** Create a new API route `POST /api/agent/daily-summary` that:
  - Queries last 24h of trades and journal entries.
  - Calls `sendDailySummary()` with the aggregated data.
  - Protected by the same `CRON_SECRET` auth header.
  - Intended to be triggered by a separate daily cron job.

---

#### 2.4 Wire PostHog Analytics (Complete Coverage)

**Problem:** `trackAgentRunCompleted` and `trackLLMTokenUsage` are defined in `analytics.ts` but never called. Only `trackAgentRunStarted`, `trackTradeExecuted`, and `trackGuardrailTriggered` are partially wired.

**Fix:**
- In `/api/agent/run` route:
  - Call `trackAgentRunCompleted(agentResult)` after the agent finishes (success or skip).
  - Call `trackLLMTokenUsage(agentResult.tokenUsage)` when token data is available.
- Ensure all `try/catch {}` wrappers around analytics calls at least log errors (not swallow silently).

---

#### 2.5 Enrich Journal Tool with Full Market Context

**Problem:** `journal.ts` only captures `{ ethPrice, timestamp }` in `marketConditions`. The PRD v1 specifies the journal should store "JSON: price, indicators at time of entry."

**Fix:**
- Update `fetchMarketSnapshot()` in `journal.ts` to also compute RSI and EMA (using the shared `src/lib/indicators.ts` from item 2.1).
- Store the full `MarketData`-shaped object: `{ ethPrice, rsi, emaShort, emaLong, emaCrossover, timestamp }`.

---

#### 2.6 Admin Route Authentication

**Problem:** All admin pages (`/admin`, `/admin/trades`, `/admin/journal`) are publicly accessible. Anyone with the URL can view portfolio state and trade history.

**Fix:**
- Implement a Next.js middleware (`src/middleware.ts`) that protects all `/admin/*` routes.
- Use a simple password-based approach:
  - Check for an `ADMIN_PASSWORD` env var.
  - On first visit, show a login form. On submit, set an HTTP-only cookie with a signed token.
  - Middleware validates the cookie on subsequent requests.
- Add `ADMIN_PASSWORD` to `.env.example`.

---

#### 2.7 Call `validateEnv()` at Startup

**Problem:** `src/lib/config.ts` defines a `validateEnv()` function with a comprehensive Zod schema, but it's never called. Bad env vars cause cryptic runtime errors instead of clean startup failures.

**Fix:**
- Call `validateEnv()` at the top of the agent run route (or in a shared initialization path).
- Add `ADMIN_PASSWORD` and email-related vars to the env schema.
- Consider calling it in `next.config.ts` for build-time validation as well.

---

#### 2.8 Consolidate Prisma/Drizzle Mismatch

**Problem:** The project has both `prisma/schema.prisma` and `src/db/schema.ts` (Drizzle). Runtime uses Drizzle exclusively, but `prisma/seed.ts` has broken imports (`TradeDirection` type doesn't exist). The `db:seed` script in `package.json` runs the Prisma seed file.

**Fix:**
- Remove `prisma/schema.prisma` (Drizzle is the source of truth).
- Rewrite `prisma/seed.ts` → `scripts/seed.ts` using Drizzle imports (fix the broken `TradeDirection` reference).
- Update `package.json` scripts: `db:seed` and `db:reseed` to point at `scripts/seed.ts`.
- Keep Prisma as a devDependency only if needed; otherwise remove it.

---

#### 2.9 Generate Drizzle Migrations

**Problem:** `drizzle.config.ts` is configured but no `drizzle/` output folder exists — migrations were never generated.

**Fix:**
- Run `npx drizzle-kit generate` to produce the migration SQL files.
- Verify the generated SQL matches the Supabase migration (`supabase/migrations/20260322000000_init_schema.sql`).
- Add the `drizzle/` folder to version control.

---

#### 2.10 Fix Supabase Config

**Problem:** `supabase/config.toml` references a `./seed.sql` file that doesn't exist.

**Fix:**
- Either create `supabase/seed.sql` that sources the seed migration, or update `config.toml` to point at `supabase/migrations/20260322000001_seed_data.sql`.

---

#### 2.11 Fix Integration Test

**Problem:** `tests/agent/agent-run.integration.test.ts` mocks the very function it claims to test — it doesn't actually test the integration.

**Fix:**
- Rewrite as a proper integration test that:
  - Uses a test database (or mocks only the external HTTP calls — Coinbase API, Azure OpenAI).
  - Actually exercises the route handler logic: mutex acquire → pre-flight → agent run → mutex release.
  - Verifies DB state changes (trade logged, journal written, agent state updated).
- Add test utilities for DB setup/teardown.

---

#### 2.12 Populate `next.config.ts`

**Problem:** `next.config.ts` is empty (just exports `{}`). This means no `serverExternalPackages` are configured, which can cause issues with packages like `postgres` in the Edge runtime.

**Fix:**
- Add `serverExternalPackages: ['postgres']` to avoid bundling issues.
- Add any other relevant Next.js config (e.g., `experimental` flags if needed).

---

### 3. Out of Scope (Deferred to v3)

- Live Coinbase AgentKit execution (real trades on Base L2)
- Sentiment analysis / news feeds
- Advanced order types (trailing stops, limit orders)
- Capital scaling beyond $200
- WebSocket-triggered runs
- Backtesting infrastructure

---

### 4. Environment Variable Additions

| Variable | Purpose | Required |
|---|---|---|
| `ADMIN_PASSWORD` | Password for admin dashboard access | Yes |

All other env vars remain as defined in v1.

---

### 5. Success Criteria

- [ ] Agent run route injects real RSI/EMA values into the system prompt
- [ ] SELL trades fail gracefully when insufficient ETH balance
- [ ] BUY trades fail gracefully when insufficient USDC balance
- [ ] Email alerts fire on guardrail triggers
- [ ] Daily summary email route exists and works
- [ ] PostHog tracks all 5 event types (started, completed, guardrail, trade, token usage)
- [ ] Journal entries store full market snapshot (price + RSI + EMA)
- [ ] Admin routes require authentication
- [ ] `validateEnv()` runs at startup
- [ ] Prisma schema removed; seed script uses Drizzle
- [ ] Drizzle migrations generated and committed
- [ ] Supabase config points at valid seed file
- [ ] Integration test exercises real route logic
- [ ] `next.config.ts` properly configured
