# Local testing runbook

This runbook covers local paper-mode testing for Project Krypto. It is for
verifying the app loop, guardrails, admin controls, and reporting surfaces
without moving real funds.

Local testing has two modes:

1. **No-LLM smoke mode** — uses stub LLM env values and an operator pause so the
   agent route exercises auth, env validation, mutex release, guardrail skips,
   DB access, dashboard, and daily summary without calling Azure.
2. **Live local paper mode** — uses real Azure-hosted Anthropic credentials and
   real Coinbase market data to execute the current paper-trading loop against
   local Postgres.

Neither mode proves the strategy can make money. Profitability requires the
future deterministic backtest/scenario harness described in
[`rfcs/0001-v3-live-trading.md`](./rfcs/0001-v3-live-trading.md) and the current
session plan.

## Prerequisites

- Node.js compatible with the repo toolchain.
- Docker running locally.
- Dependencies installed:
  ```bash
  npm install
  ```

## 1. Start local Postgres

```bash
docker compose up -d
```

The local database runs on:

```text
postgresql://krypto:krypto_local@localhost:5433/krypto
```

Confirm it is reachable:

```bash
docker exec -i krypto-postgres psql -U krypto -d krypto -c 'SELECT 1;'
```

## 2. Create local environment

```bash
cp .env.example .env
```

Use this baseline for **no-LLM smoke mode**:

```dotenv
AZURE_OPENAI_ENDPOINT=https://stub.openai.azure.com
AZURE_OPENAI_API_KEY=stub
AZURE_OPENAI_DEPLOYMENT_NAME=claude-sonnet-stub
AZURE_OPENAI_API_VERSION=2024-10-21

CDP_API_KEY_NAME=local-unused
CDP_API_KEY_PRIVATE_KEY=local-unused

DATABASE_URL=postgresql://krypto:krypto_local@localhost:5433/krypto
DIRECT_URL=postgresql://krypto:krypto_local@localhost:5433/krypto

POSTHOG_API_KEY=phc_local_stub
POSTHOG_HOST=https://us.i.posthog.com

CRON_SECRET=local-cron-secret

ADMIN_PASSWORD=local-admin-password
ADMIN_SESSION_SECRET=local-admin-session-secret
```

For **live local paper mode**, replace the `AZURE_OPENAI_*` values with the real
Azure-hosted Anthropic endpoint, API key, deployment name, and API version.
CDP values are still unused in v2 paper mode but must be present because env
validation requires them.

Do not commit `.env`.

## 3. Apply schema and seed

```bash
npm run db:push
npm run db:seed
```

Verify the singleton:

```bash
docker exec -i krypto-postgres psql -U krypto -d krypto -c \
  'SELECT id, "currentPositionETH", "currentPositionUSDC", "portfolioValueUSD", "isLocked", "isOperatorPaused", "isRunning" FROM "AgentState";'
```

Expected baseline:

```text
singleton | 0 | 200 | 200 | false | false | false
```

## 4. No-LLM smoke test

This verifies the route and DB path without calling the LLM. It intentionally
pauses the operator switch so pre-flight checks skip before model invocation.

Pause the agent:

```bash
docker exec -i krypto-postgres psql -U krypto -d krypto -c \
  'UPDATE "AgentState" SET "isOperatorPaused" = true WHERE id = '\''singleton'\'';'
```

Start the app in another terminal:

```bash
npm run dev
```

Trigger the agent route:

```bash
curl -i -X POST http://localhost:3000/api/agent/run \
  -H "x-cron-secret: $(grep '^CRON_SECRET=' .env | cut -d= -f2-)" \
  -H "Content-Type: application/json"
```

Expected:

```json
{"status":"skipped","guardrailTriggered":"Agent paused by operator",...}
```

Confirm the mutex was released and `lastRunAt` advanced:

```bash
docker exec -i krypto-postgres psql -U krypto -d krypto -c \
  'SELECT "isRunning", "lastRunAt" FROM "AgentState" WHERE id = '\''singleton'\'';'
```

## 5. Admin dashboard smoke test

Open:

```bash
open http://localhost:3000/admin/login
```

Log in with `ADMIN_PASSWORD`.

Check:

- Dashboard loads with portfolio state.
- Status badge shows `Paused` after the no-LLM smoke setup.
- `Resume Agent` toggles `isOperatorPaused` to false.
- `Pause Agent` toggles it back to true.
- `Run Agent Now` is disabled while paused/locked/running and enabled otherwise.
- Trades and Journal pages render, even with no rows.
- Release Run Lease button is disabled unless `isRunning = true`.

## 6. Daily summary smoke test

The daily summary route does not call the LLM. With no Resend config it logs a
no-op email path to the server console.

```bash
curl -i -X POST http://localhost:3000/api/agent/daily-summary \
  -H "x-cron-secret: $(grep '^CRON_SECRET=' .env | cut -d= -f2-)" \
  -H "Content-Type: application/json"
```

Expected:

```json
{"success":true,"tradesCount":0,"totalPnlUSD":0}
```

Seed data or real paper runs will change the counts and PnL.

## 7. Live local paper run

Use this only after no-LLM smoke passes and real Azure-hosted Anthropic
credentials are present in `.env`.

Resume the agent:

```bash
docker exec -i krypto-postgres psql -U krypto -d krypto -c \
  'UPDATE "AgentState" SET "isOperatorPaused" = false WHERE id = '\''singleton'\'';'
```

Reset to a clean paper account if needed:

```bash
npm run db:reset
```

Trigger the run:

```bash
curl -i -X POST http://localhost:3000/api/agent/run \
  -H "x-cron-secret: $(grep '^CRON_SECRET=' .env | cut -d= -f2-)" \
  -H "Content-Type: application/json"
```

Healthy outcomes:

- `200 {"status":"executed",...}` — paper trade was recorded.
- `200 {"status":"skipped","action":"hold",...}` — model held.
- `200 {"status":"skipped","guardrailTriggered":"Cooldown active..."}` —
  expected after a recent trade.
- `200 {"status":"locked",...}` — drawdown lock engaged; investigate.

Verify side effects:

```bash
docker exec -i krypto-postgres psql -U krypto -d krypto -c \
  'SELECT id, direction, "amountUSD", "executionPrice", "pnlUSD", "createdAt" FROM "TradeExecution" ORDER BY "createdAt" DESC LIMIT 5;'

docker exec -i krypto-postgres psql -U krypto -d krypto -c \
  'SELECT id, left("entryText", 160), "tradeExecutionId", "createdAt" FROM "AgentJournal" ORDER BY "createdAt" DESC LIMIT 5;'
```

## 8. Reset between experiments

```bash
npm run db:reset
```

This clears trades and journals, resets the singleton to:

```text
0 ETH / 200 USDC / portfolio value 200 / unlocked / unpaused / not running
```

If you need seeded historical-looking demo rows instead, rerun:

```bash
npm run db:seed
```

## 9. Common local failures

| Symptom | Likely cause | Fix |
|---|---|---|
| `500 AgentState singleton not found` | Singleton not seeded | `npm run db:seed` |
| `409 Agent is already running` | Stale mutex | `UPDATE "AgentState" SET "isRunning" = false WHERE id = 'singleton';` |
| `401 Unauthorized` | Wrong or missing `x-cron-secret` | Use the exact `CRON_SECRET` from `.env` |
| `Invalid environment variables` | Required env missing | Fill all required vars, including dummy CDP and PostHog values locally |
| LLM auth/model error | Stub Azure values used while unpaused | Pause for no-LLM smoke, or provide real Azure-hosted Anthropic values |
| `Cooldown active` | A trade happened within 2 hours | Wait, reset DB, or test a non-trade route |
| `System locked` | Portfolio fell below `$150` | Inspect trades/journals before manually clearing `isLocked` |
| Coinbase API error | Network/Coinbase transient | Retry later; deterministic market-data provider is future work |

## 10. Testing profitability

Do not use one-off local live-paper runs as proof of profitability. To claim net
gains, the next build should add deterministic backtesting with:

- controllable price/candle fixtures
- no-LLM deterministic policies
- weighted-average cost basis
- fees and slippage
- cooldown, DCA, balance, and drawdown guardrails
- comparison against cash baseline and buy-and-hold ETH

Until that harness exists, local testing can prove the app runs correctly, but
not that the strategy has positive expected value.
