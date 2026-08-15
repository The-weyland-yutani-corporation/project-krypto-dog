# Local testing runbook

This runbook covers local paper-mode testing for Project Krypto. It is for
verifying the app loop, guardrails, admin controls, and reporting surfaces
without moving real funds.

Local testing has two modes:

1. **No-LLM smoke mode** — sets `ROLLOUT_MODE=disabled` so the route exercises
   auth, `AgentRun` persistence, owned lease acquire/release, telemetry, DB
   access, dashboard, and daily summary without Coinbase or Foundry.
2. **Live local shadow/paper mode** — uses the dedicated Foundry-hosted
   GPT-5.6 Luna deployment through Microsoft Entra ID plus real Coinbase
   market data. Start with `shadow`; use `paper` only when deliberate local
   execution is desired.

For running the **full app** (Postgres + schema + seed + Next.js) in an
isolated, worktree-safe way — including in parallel across multiple git
worktrees — prefer the mock-first harness in
[§0. Worktree-safe app harness](#0-worktree-safe-app-harness) below. See
[ADR 0011](./decisions/0011-mock-first-worktree-harness.md) for the rationale.

Neither mode proves the strategy can make money. Profitability requires the
evaluation methodology described in [`specs/evaluation.md`](./evaluation.md) and
the evidence gates in [`specs/readiness.md`](./readiness.md). The aligned
deterministic backtest/scenario harness is described in
[`rfcs/0002-evidence-grade-paper-trading.md`](./rfcs/0002-evidence-grade-paper-trading.md).

## Prerequisites

- Node.js 22.13.0 (see `.nvmrc`).
- Docker running locally.
- PostgreSQL 17 client tools (`psql`, `pg_dump`, and `pg_restore`) for the
  migration and verified-backup suites. The Docker Compose database also runs
  PostgreSQL 17 to match the Azure PostgreSQL target.
  On Homebrew systems where another PostgreSQL major is linked, use:
  ```bash
  export PATH="$(brew --prefix postgresql@17)/bin:$PATH"
  ```
- Supabase CLI 2.109.1 or newer only for legacy-baseline compatibility tests
  that read `supabase/config.toml`. It is not part of the Azure target. Older
  1.x clients reject the PostgreSQL 17 setting; use
  `npx --yes supabase@2.109.1 <command>` when those tests require it.
- Dependencies installed:
  ```bash
  npm install
  ```

## 0. Worktree-safe app harness

The harness (`scripts/agent-harness.ts`) boots the full app in an isolated
Docker Compose project + database + app port per worktree, so multiple
worktrees never collide. It is **mock-first**: the default `up` uses
deterministic decision and market-data providers, `AGENT_HARNESS_MODE=mock`,
`ROLLOUT_MODE=disabled`, and **no** Foundry / Coinbase / PostHog / email
credentials or external network. It never enables paper or live trading.

```bash
# Deterministic mock boot (no external network, no real credentials):
npm run harness:up

# Deterministic shadow scenario (still mock providers, no trade mutation):
npm run harness:up -- --shadow --scenario dip --decision BUY

# Inspect the running harness (ports, health, pid ownership):
npm run harness:status

# Tear down exactly this worktree's project + volumes (logs/screenshots kept):
npm run harness:down
```

`up` derives a stable id from the canonical worktree path, allocates free app
and database ports, writes an ignored `.harness/<id>/` directory with a
versioned, **secret-free** manifest and the Next dev log, runs the existing
migrations and deterministic seed against the isolated database, and waits on the
non-sensitive `GET /api/health` endpoint (`{ status, rolloutMode, harnessMode }`).
`down` verifies the recorded pid still belongs to this worktree's Next process
before signaling that exact pid, then runs `docker compose -p <project> down
--volumes`; it never kills by process name and never deletes wildcard paths.

### Real-provider smoke (opt-in, shadow, read-only)

Real-provider confidence is available only behind an explicit flag and requires
valid Azure OpenAI v1 configuration plus an attended Entra identity (`az login`).
It stays `shadow`, runs a **read-only** Azure OpenAI + Coinbase check (no PostHog
or email events, no trade execution), and refuses production-looking databases
and `NODE_ENV=production`:

```bash
# Read-only provider smoke only (Azure OpenAI + Coinbase):
npm run smoke:providers -- --allow-network-smoke

# Provider smoke + boot the app in smoke/shadow mode:
npm run harness:smoke -- --allow-network-smoke
```

### Operator-console browser validation

Browser validation runs against an **already-running** harness and asserts the
existing operator-console design surfaces the rollout mode and the
locked/paused/destructive controls without changing any UI. It uses fixture
credentials and writes artifacts under `.harness/`:

```bash
npm run harness:up        # start the mock harness first
npm run harness:browser   # Playwright (pinned Chromium) against that harness
npm run harness:down
```

## 1. Start local Postgres (single-worktree, manual)

```bash
docker compose up -d
```

The PostgreSQL 17 Compose service uses a new `pgdata17` volume so an existing
PostgreSQL 15/16 development volume is left untouched rather than opened by an
incompatible server major version.

The local database runs on:

```text
postgresql://krypto:krypto_local@localhost:5433/krypto
```

Confirm it is reachable:

```bash
docker compose exec -T db psql -U krypto -d krypto -c 'SELECT 1;'
```

## 2. Create local environment

```bash
cp .env.example .env
```

Use this baseline for **no-agent smoke mode**. Agent configuration remains
shape-valid even though disabled mode never invokes it:

```dotenv
AZURE_FOUNDRY_PROJECT_ENDPOINT=https://stub.services.ai.azure.com/api/projects/krypto-test-agents
AZURE_FOUNDRY_AGENT_NAME=krypto-test-decision
AZURE_FOUNDRY_AGENT_VERSION=1

DATABASE_URL=******localhost:5433/krypto
DIRECT_URL=******localhost:5433/krypto

POSTHOG_API_KEY=phc_local_stub
POSTHOG_HOST=https://us.i.posthog.com

CRON_SECRET=local-cron-secret

ADMIN_PASSWORD=local-admin-password
ADMIN_SESSION_SECRET=local-admin-session-secret
```

For **live local shadow/paper mode**, authenticate interactively and select
the approved subscription:

```bash
az login
az account set --subscription "Visual Studio Enterprise Subscription"
```

Set `AZURE_FOUNDRY_PROJECT_ENDPOINT` to the dev project endpoint,
`AZURE_FOUNDRY_AGENT_NAME=krypto-dev-decision`, and
`AZURE_FOUNDRY_AGENT_VERSION` to the exact attested version. Leave model and
agent API keys unset: local calls use `DefaultAzureCredential` and the attended
Azure CLI identity must have reviewed project access. Azure runtime instead sets
`AZURE_CLIENT_ID` to its user-assigned managed identity.

The optional direct-model diagnostic `npm run smoke:llm` additionally needs
`AZURE_OPENAI_BASE_URL` and `AZURE_OPENAI_DEPLOYMENT_NAME`; application runs do
not.

For optional local email delivery, set
`AZURE_COMMUNICATION_CONNECTION_STRING`,
`AZURE_COMMUNICATION_EMAIL_SENDER`, and `ALERT_EMAIL_TO`. Never copy an Azure
environment connection string into GitHub or commit it.

Do not commit `.env`.

## Validation gates

```bash
npm run lint
npm run typecheck:scripts
npm run test:coverage
npm run build
npm run test:integration
npm run deployment:preflight -- --provider azure
npm run deployment:backup -- --out deployment-evidence/local-backup
npm run smoke:target -- --base-url http://localhost:3000 --confirm-host localhost
npm run backtest:all
npm audit --omit=dev
```

The coverage command collects runtime configuration, the decision boundary,
market-data/indicator, admin-auth/route-auth/operations-health, accounting,
policy, strategy configuration, and shared paper-execution modules. Global and
critical per-module thresholds are enforced in `jest.config.ts`.

`deployment:preflight -- --provider azure` is read-only and accepts
`DIRECT_URL` plus `DATABASE_URL`. It requires both URLs to identify the same
database cluster and reports schema, row-count, position, lease, migration,
table/column ACL, protected-view, executable `SECURITY DEFINER`, and legacy
scheduler/Vault-object retirement evidence used by the Azure pre-migration
gate. It also fingerprints the ordered Drizzle history.

`deployment:backup` requires `DIRECT_URL` and `DATABASE_URL`, proves they name
the same PostgreSQL database and cluster, writes that binding into the
manifest, and refuses active Krypto cron, queued endpoint requests, or an
existing output path. Add
`--restore-test-url postgresql://postgres@127.0.0.1:<port>/postgres` to prove
the bundle in a disposable loopback database and compare critical row counts.
Legacy public-schema bundles include and automatically apply the required enum
bootstrap before restoring their custom-format table archive. A database with
only migration metadata and no Krypto application table is refused.

`smoke:target` requires an already-running application, explicit
`ROLLOUT_MODE=disabled`, `DIRECT_URL`, `CRON_SECRET`, admin credentials, and
working Luna, Coinbase, ACS Email, and PostHog configuration. It binds
`DIRECT_URL` to the deployed runtime
with a unique immutable journal challenge, requires disabled mode inside both
run requests before lease acquisition, first proves a valid mismatched mode is
rejected through a no-mutation route probe that cannot enter orchestration,
rejects queued endpoint requests, writes only smoke-evidence records, verifies
the trade count is unchanged, and accepts HTTP only for loopback targets. A
passing run finishes by recording an immutable target
origin/cron-secret-fingerprint approval that schedule activation must match.

## 3. Apply schema and seed

```bash
npm run db:migrate
npm run db:init
```

`db:migrate` uses `DIRECT_URL`. `db:init` inserts the singleton only when it is
absent and never deletes trade or journal history. Do not use `db:push` or
`supabase db push` for application schema changes.

To verify both a fresh install and adoption of the existing v2 schema against
temporary local PostgreSQL clusters:

```bash
npm run test:migrations
```

Verify the singleton:

```bash
docker compose exec -T db psql -U krypto -d krypto -c \
  'SELECT id, "currentPositionETHDecimal", "currentPositionUSDCDecimal", "portfolioValueUSDDecimal", "isLocked", "isOperatorPaused", "leaseOwner", "leaseExpiresAt" FROM "krypto"."AgentState";'
```

Expected baseline:

```text
singleton | 0 | 200 | 200 | false | false | null | null
```

## 4. No-LLM smoke test

This verifies the route and DB path without calling Coinbase or the LLM.

Set the rollout mode in `.env` and restart the app if it was already running:

```dotenv
ROLLOUT_MODE=disabled
```

Start the app in another terminal:

```bash
npm run dev
```

Trigger the agent route:

```bash
curl -i -X POST http://localhost:3000/api/agent/run \
  -H "x-cron-secret: $(grep '^CRON_SECRET=' .env | cut -d= -f2-)" \
  -H "x-required-rollout-mode: disabled" \
  -H "Content-Type: application/json"
```

Expected:

```json
{"status":"skipped","action":"disabled",...}
```

Confirm the owned lease was released and `lastRunAt` advanced:

```bash
docker compose exec -T db psql -U krypto -d krypto -c \
  'SELECT "leaseOwner", "leaseExpiresAt", "isRunning", "lastRunAt" FROM "krypto"."AgentState" WHERE id = '\''singleton'\'';'
```

## 5. Admin dashboard smoke test

Open:

```bash
open http://localhost:3000/admin/login
```

Log in with `ADMIN_PASSWORD`.

Check:

- Dashboard loads with portfolio state.
- Status badge shows the disabled rollout state after the no-LLM smoke setup.
- `Resume Agent` toggles `isOperatorPaused` to false.
- `Pause Agent` toggles it back to true.
- `Run Agent Now` is disabled while paused/locked/running and enabled otherwise.
- Trades and Journal pages render, even with no rows.
- Release Run Lease never clears an active unexpired owner; it is only an
  expired/legacy recovery path.

## 6. Daily summary smoke test

The daily summary route does not call the LLM. Outside production, omitted ACS
configuration logs a console-only path and returns an explicit skipped
delivery result. This is useful locally but cannot satisfy target smoke.

```bash
curl -i -X POST http://localhost:3000/api/agent/daily-summary \
  -H "x-cron-secret: $(grep '^CRON_SECRET=' .env | cut -d= -f2-)" \
  -H "x-required-rollout-mode: disabled" \
  -H "Content-Type: application/json"
```

Expected:

```json
{"generated":true,"delivery":{"status":"skipped","reason":"Missing ACS email configuration: ..."},"tradesCount":0,"totalPnlUSD":0}
```

Seed data or real paper runs will change the counts and PnL.

## 7. Live local paper run

Use this only after no-LLM smoke passes, `az login` is authenticated to an
identity allowed to invoke `krypto-dev-luna`, and the real Azure OpenAI v1
base URL is present in `.env`.

Reset to a clean paper account if needed:

```bash
npm run db:reset
```

First rehearse with `ROLLOUT_MODE=shadow` and a matching
`x-required-rollout-mode: shadow` header; any authorized proposal is recorded
without a trade, and HOLD/rejected proposals also remain non-mutating. Before
using the paper command below, set
`ROLLOUT_MODE=paper` in `.env` and restart the app so the deployed mode matches
the required-mode header.

If the agent is paused, resume it with **Resume Agent** on the admin dashboard.
Do not bypass the audited pause/resume path with a direct SQL update.

Trigger the run:

```bash
curl -i -X POST http://localhost:3000/api/agent/run \
  -H "x-cron-secret: $(grep '^CRON_SECRET=' .env | cut -d= -f2-)" \
  -H "x-required-rollout-mode: paper" \
  -H "Content-Type: application/json"
```

Healthy outcomes:

- `200 {"status":"executed",...}` — paper trade was recorded.
- `200 {"status":"skipped","action":"hold",...}` — model held.
- `200 {"status":"skipped","guardrailTriggered":"Execution cooldown is active"}` —
  expected after a recent trade.
- `200 {"status":"locked",...}` — drawdown lock engaged; investigate.

Verify side effects:

```bash
docker compose exec -T db psql -U krypto -d krypto -c \
  'SELECT id, direction, "amountUSD", "executionPrice", "pnlUSD", "createdAt" FROM "krypto"."TradeExecution" ORDER BY "createdAt" DESC LIMIT 5;'
docker compose exec -T db psql -U krypto -d krypto -c \
  'SELECT id, left("entryText", 160), "tradeExecutionId", "createdAt" FROM "krypto"."AgentJournal" ORDER BY "createdAt" DESC LIMIT 5;'
```

## 8. Reset between experiments

```bash
npm run db:reset
```

This clears trades and journals, resets the singleton to:

```text
0 ETH / 200 USDC / portfolio value 200 / unlocked / unpaused / not running
```

If the singleton was removed, recreate it idempotently:

```bash
npm run db:init
```

## 9. Common local failures

| Symptom | Likely cause | Fix |
|---|---|---|
| `500 AgentState singleton not found` | Singleton not initialized | `npm run db:init` |
| `409 Agent is already running` | Active owned lease | Inspect `leaseOwner`/`leaseExpiresAt`; wait for expiry or use the admin recovery path only after expiry |
| `401 Unauthorized` | Wrong or missing `x-cron-secret` | Use the exact `CRON_SECRET` from `.env` |
| `400 Required rollout mode is missing` | Scheduler request omitted its deployment binding | Send `x-required-rollout-mode` with the exact current mode |
| Rollout configuration error | Invalid `ROLLOUT_MODE` | Use `disabled`, `shadow`, or `paper` |
| LLM auth/model error | Stub endpoint, missing Azure CLI login/role, wrong Luna deployment, or wrong v1 base URL | Pause for no-LLM smoke, or authenticate and use the approved `krypto-dev-luna` deployment |
| `Execution cooldown is active` | A trade happened within 2 hours | Wait, reset DB, or test a non-trade route |
| `Account safety lock is active` or `Maximum drawdown reached (...)` | Drawdown safety threshold was reached | Inspect trades/journals, then use the audited **Clear Safety Lock** admin action with a reason |
| Coinbase API error | Network/Coinbase transient or invalid/stale candles | Retry later and inspect the typed market-data error |

## 10. Testing profitability

Do not use one-off local live-paper runs as proof of profitability. Use the
deterministic backtest runner first:

```bash
npm run backtest -- --scenario scenarios/dip-recovery.json
npm run backtest -- --scenario scenarios/sideways-chop.json
npm run backtest -- --scenario scenarios/crash-rebound.json
npm run backtest:all
```

To write a JSON artifact:

```bash
npm run backtest -- --scenario scenarios/dip-recovery.json --out backtest-output/dip-recovery.json
```

`backtest:all` emits one aggregate JSON object. Its
`engineeringAssertions` section is separate from
`financialEvidenceSummary`; the latter is explicitly classified
`engineering-fixtures-only` and states that no historical/walk-forward evidence
exists. Use `--json` for a machine-readable single-scenario result.
Use `npm run --silent backtest:all` when piping the JSON to another process so
npm's command banner is suppressed.

Backtest reports compare final equity against:

- cash baseline: starting with and holding `$200` USDC
- buy-and-hold ETH from the first scenario price

The current deterministic runner includes:

- controllable price/candle fixtures
- no-LLM deterministic policies
- production deterministic policy authorization
- the same exact fixed-point accounting and pure execution calculator as paper
  execution
- default 30 bps fees and 15 bps adverse paper slippage
- cooldown, DCA, balance, and drawdown guardrails
- post-action same-step drawdown
- comparison against cash baseline and buy-and-hold ETH
- Sharpe, Sortino, Calmar, turnover, fee efficiency, win rate, profit factor,
  benchmark alpha, total modeled slippage, and optional LLM-cost-adjusted PnL
- strategy/cost/code/schema/decision-source/dataset version metadata

`rules-basic` executes mandatory policy actions first, otherwise selects the
maximum eligible SELL before BUY, selects the maximum eligible BUY next, and
HOLDs when neither is eligible. `always-hold` suppresses optional actions but
does not suppress a mandatory production stop-loss.

These scenarios and their outcomes are engineering tests, not financial proof
or live Azure evidence.
See `specs/evaluation.md` §3 for the distinction between engineering fixtures and
financial evidence, and `specs/readiness.md` §1 for the current baseline.

Add more historical windows and avoid cherry-picking before claiming positive
expected value (see `specs/evaluation.md` §4 on cherry-picking prevention).
