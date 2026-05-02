## Project Krypto: Autonomous AI Trading Agent

### 1. Executive Summary & Vision

**Project Krypto** is an autonomous, LLM-driven cryptocurrency trading agent designed to execute swing trades on ETH/USDC.

- **Initial Phase (v1.0):** The system will operate with a strict **$200 USD capital pool**. The goal of v1 is _not_ massive profit, but rather to debug the Agentic Loop, refine the prompt engineering, prove out the execution latency via Coinbase AgentKit, and ensure the engineering guardrails operate flawlessly.
- **End-State Goal (v3.0+):** Once a statistically significant positive Expected Value (EV) is established, capital will be scaled. The ultimate objective is to generate **$100/day in passive profit**. _(Mathematical note: Achieving $100/day requires a 0.5% daily return on a $20,000 portfolio. The agent must be hardened to manage this scale securely)._

### 2. System Architecture & Tech Stack

- **Application Layer:** Next.js (App Router), TypeScript, Node.js.
- **AI Orchestration:** LangChain (`@langchain/openai`, `@langchain/core`) utilizing a ReAct (Reasoning and Acting) agent loop.
- **LLM Engine:** Azure AI Foundry (Azure OpenAI Service hosting GPT-4o) for enterprise-grade security and rate limiting.
- **Execution Venue:** Coinbase Developer Platform (CDP) API via **Coinbase AgentKit** (`@coinbase/agentkit-langchain`).
- **Database:** Supabase (managed PostgreSQL via Prisma ORM) for state persistence, trade logging, and context injection.
- **Observability:** PostHog for product analytics, LLM token tracking, and monitoring tool invocation drop-offs.
- **Infrastructure:** Deployed on Vercel. Cron-triggered via Supabase Cron Jobs (`pg_cron` + `pg_net` calling the Vercel API route on schedule). Secrets managed via Vercel Environment Variables.

### 3. Logic Gaps to Solve (Market Mechanics)

The agent will naturally encounter edge cases that a standard "buy the dip, sell the rip" prompt cannot handle. The system design and LangChain prompt must account for:

1.  **The "Bag Holding" Problem (Bear Markets):** If ETH drops 7%, the agent buys. If it drops another 10%, does the agent buy more (DCA) or wait? _Solution:_ The LLM must be fed historical PnL and current portfolio weighting. We must implement a LangChain tool allowing the agent to set/evaluate Stop-Losses.
2.  **The "Left Behind" Problem (Bull Parabolics):** If ETH pumps 10%, the agent sells to secure profit. If ETH continues pumping another 40%, the agent is sidelined in USDC, waiting for a dip that never comes. _Solution:_ The prompt must be instructed on trend-following metrics, and eventually, a Trailing Stop tool must be provided via AgentKit.
3.  **Anchor Price Ambiguity:** The agent must base its percentage swings on a defined anchor. _Solution:_ The database (`AgentState`) must feed the "Last Executed Trade Price" into the LangChain system prompt so the AI knows exactly what its breakeven point is.

### 4. Self-Determinism Pitfalls (AI Risks)

Giving an LLM financial autonomy introduces distinct vulnerabilities. This architecture actively mitigates:

1.  **The Hallucination Liquidation:** The LLM might hallucinate a JSON command to buy an unsupported token or execute a trade for $10,000 (which it doesn't have). _Mitigation:_ Hardcoded TS wrappers around the AgentKit LangChain tools (see Section 5).
2.  **Overtrading to Death (Fee Bleed):** LLMs can become hyperactive, buying and selling 50 times a day for 0.05% gains. Exchange fees (0.1% - 0.5%) will drain the $200 rapidly. _Mitigation:_ A strict 2-hour database-enforced cooldown between trades.
3.  **Context Window Amnesia:** If the agent buys ETH on Monday for a specific macro reason, it may forget by Thursday why it holds that position. _Mitigation:_ The `AgentJournal` PostgreSQL table. On every run, the last 3 journal entries are retrieved and injected into the LangChain system prompt as "Memory."
4.  **News Panic Selling:** If given live news feeds, LLMs tend to overreact to negative sentiment headlines. _Mitigation:_ In v1, the agent operates purely on price action, technicals, and its own historical ledger. Sentiment analysis is deferred to v2.

### 5. Engineering Guardrails (Strict Enforcement)

The LangChain ReAct loop will output tool calls. **Before** a tool call reaches the actual Coinbase AgentKit CDP API, it must pass through these TypeScript middleware checks.

- **Guardrail 1: Pre-Flight Killswitch (Max Drawdown)**
  - _Logic:_ Fetch `current_portfolio_value = (ETH_balance * current_ETH_price) + USDC_balance`.
  - _Rule:_ `if (current_portfolio_value < 150.00) { throw new SystemLockedError() }`
  - _Action:_ LangChain execution is aborted. Alert sent to PostHog.
- **Guardrail 2: Anti-Hyperactivity (Cooldown)**
  - _Logic:_ Fetch `last_trade_timestamp` from `TradeExecution` table.
  - _Rule:_ `if (Date.now() - last_trade_timestamp < 2_HOURS) { bypass_execution() }`
  - _Action:_ Skips agent invocation entirely to save LLM compute costs.
- **Guardrail 3: Max Trade Size Wrapper (Tool Interception)**
  - _Logic:_ We do not expose the raw AgentKit `trade` tool to the LLM. We expose a custom LangChain tool `safe_trade`.
  - _Rule:_ `if (requested_trade_usd_amount > 50.00) { return "Error: Trade exceeds max limit of $50." }`
  - _Action:_ Returns the error _back to the LLM_ so the agent can reason about the failure and adjust its sizing, rather than crashing the system.
- **Guardrail 4: Asset Whitelist (Tool Interception)**
  - _Logic:_ Inside the `safe_trade` tool wrapper.
  - _Rule:_ `if (!['ETH', 'USDC'].includes(asset)) { return "Error: Unauthorized asset." }`

### 6. Step-by-Step Execution Plan

#### Phase 1: Local Simulation & Scaffolding

1.  **Database Spin-up:** Initialize Prisma and push the schema (`AgentState`, `TradeExecution`, `AgentJournal`) to a local Postgres instance.
2.  **Tool Wrapping:** Implement Coinbase AgentKit. Wrap the base trading tools in LangChain custom tools that enforce Guardrails 3 & 4.
3.  **Paper Trading Loop:** Write the Next.js API route. _Crucially, stub out the actual AgentKit execution layer to simply return "Success"_ so the LLM thinks it traded, and log it to the DB.
4.  **Prompt Tuning:** Run the cron job locally. Observe the agent's reasoning in the DB. Tweak the LangChain `ChatPromptTemplate` until the persona acts rationally with a $200 constraints.

#### Phase 2: Deployment & Supabase/Vercel Integration

1.  **Cloud Infrastructure:** Deploy the Next.js app to Vercel. Provision a Supabase project for the PostgreSQL database.
2.  **Secrets Binding:** Add CDP API keys, Azure OpenAI endpoints, PostHog keys, and `DATABASE_URL` (Supabase connection string) to Vercel Environment Variables.
3.  **Observability Check:** Ensure PostHog is capturing the custom events: `agent_run_started`, `guardrail_triggered`, `trade_executed`, and `llm_token_usage`.

#### Phase 3: Live Testing - The $200 Sandbox

1.  Fund the connected Coinbase account with exactly $200 USDC.
2.  Activate the Supabase Cron Job (running every 1 hour via `pg_cron`, calling `POST /api/agent/run` on Vercel via `pg_net`).
3.  Monitor PostHog dashboards and the `AgentJournal` table daily.
4.  Identify logic gaps (e.g., is it buying too early? Is it getting eaten by slippage?). Refine the prompt and tools accordingly.

#### Phase 4: Scaling to $100/Day (Future State)

1.  Once a consistent 30-day win rate / positive EV is proven on the $200 fund, calculate the required capital to achieve $100 daily yield based on the average daily % return.
2.  Increase capital incrementally ($1,000 -> $5,000 -> $20,000).
3.  Introduce Advanced AgentKit tools (Trailing Stops, Limit Orders instead of Market Orders to reduce CDP taker fees).
4.  Transition the cron schedule from 1-hour intervals to WebSocket-triggered events based on volatility spikes

---

### 7. Resolved Decisions

#### 7.1 Database Schema

**Status: ✅ Confirmed**

- **`AgentState`:** `id`, `lastTradePrice` (anchor), `currentPositionETH`, `currentPositionUSDC`, `portfolioValueUSD`, `isLocked`, `isRunning` (mutex for overlapping runs), `lastRunAt`, `updatedAt`.
- **`TradeExecution`:** `id`, `direction` (BUY/SELL), `asset`, `amountUSD`, `amountAsset`, `executionPrice`, `feesUSD`, `slippage`, `pnlUSD`, `agentReasoning` (snapshot of LLM output), `createdAt`.
- **`AgentJournal`:** `id`, `entryText`, `marketConditions` (JSON: price, indicators at time of entry), `tradeExecutionId` (nullable FK), `createdAt`.

#### 7.2 Market Data Source & Technical Indicators

- **Price data source:** Coinbase API directly (already integrated via AgentKit).
- **Indicators:** RSI + EMA crossovers (simple, proven for swing trading).
- **Candle timeframe:** 4h candles (better signal-to-noise for swing trades).
- **Delivery method:** LLM has LangChain tools to fetch indicators on demand. Additionally, current values are pre-injected into the system prompt for immediate context.

#### 7.3 Trading Strategy Parameters (v1 Defaults)

- **Buy trigger:** ETH drops **3%** from anchor price.
- **Sell trigger:** ETH rises **3%** from anchor price. _(±3% symmetric for quick profits and high turnover.)_
- **Position sizing:** Agent varies between **$10–$50** per trade based on conviction/signal strength. Hard cap at $50 (Guardrail 3).
- **Per-trade stop-loss:** **-15%** (gives room to recover; separate from the portfolio-level $150 killswitch).
- **DCA:** Allowed — up to **3 buys** on the same asset as price falls.

#### 7.4 LLM System Prompt

- **Persona:** Balanced swing trader (equal weight on profit and risk).
- **Data injected per run:** Portfolio state, last 3 journal entries, current ETH price, RSI/EMA indicator values, last trade price (anchor).
- **Decision output format:** LangChain tool calls directly (native ReAct pattern). The LLM reasons in natural language, then invokes `safe_trade` and other tools via the standard LangChain agent loop.
- **Prompt location:** The system prompt is runtime code and lives in the source tree (e.g., `src/agent/prompts/`), not in the specs folder.

#### 7.5 API Route & Cron Design

- **Endpoint:** `POST /api/agent/run`.
- **Cron trigger:** Supabase Cron Job (`pg_cron`) fires every hour, calling the Vercel endpoint via `pg_net` HTTP extension.
- **Overlapping run prevention:** DB-level mutex — `isRunning` flag on `AgentState`, checked and set atomically at the start of each run, cleared on completion (or failure).
- **Authentication:** API key in `x-cron-secret` header, matched against `CRON_SECRET` env var.
- **Response:** Full run summary JSON — action taken, agent reasoning, portfolio state after execution.

#### 7.6 Error Handling & Recovery

- **Mid-trade crash:** Log the failure and skip. No retry (avoids risk of double trades).
- **Coinbase API unreachable:** Abort the run, log it. Try again on the next cron cycle.
- **Azure OpenAI 429 (rate limit):** Retry up to 3 times with exponential backoff, then abort.
- **Drawdown lock (`SystemLockedError`):** Manual DB update only. Forces human review before reactivation.

#### 7.7 Coinbase Network & Wallet

- **Network:** Base L2 (much lower fees — critical at $50 trade sizes).
- **Paper trading (Phase 1):** CDP testnet for realistic testing.
- **Wallet type:** MPC wallet (recommended by AgentKit — no single point of failure).

#### 7.8 Environment Variables Inventory

**Confirmed complete:**
- `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_DEPLOYMENT_NAME`
- `CDP_API_KEY_NAME`, `CDP_API_KEY_PRIVATE_KEY`
- `DATABASE_URL` (Supabase Postgres connection string)
- `DIRECT_URL` (Supabase direct connection for Prisma migrations)
- `POSTHOG_API_KEY`, `POSTHOG_HOST`
- `CRON_SECRET` (for API route authentication)

#### 7.9 Slippage & Fee Viability

- **Slippage tolerance:** 1% on market orders.
- **Fee estimate (Base L2):** ~$0.01–$0.10 gas + ~0.3% DEX swap fee per trade. On a $50 trade, that's ~$0.15–$0.25 total fees. With ±3% triggers, a successful round-trip (buy + sell) yields ~$3.00 gross on $50, minus ~$0.50 fees = **~$2.50 net profit per round-trip**. Strategy is +EV after fees at this scale.

#### 7.10 Testing & Validation Strategy

- **Pre-live validation:** CDP testnet paper trading. Keep v1 simple — no backtesting infrastructure.
- **Automated tests:** Unit tests for all 4 guardrails + integration test for the full agent run loop.
- **Admin dashboard:** Yes — build a simple admin page to view trades, journal entries, and portfolio state. _(In addition to PostHog for analytics.)_

#### 7.11 Alerting & Notifications

- **Real-time alerts:** Email alerts when guardrails fire or the system locks.
- **Daily summary:** Yes — daily email with PnL, trades executed, and journal highlights.
