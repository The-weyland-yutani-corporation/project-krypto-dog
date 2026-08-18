# 0011 — Mock-first, per-worktree application harness

- **Status:** Accepted
- **Date:** 2026-08-10
- **Deciders:** @VeVarunSharma

## Context

Project Krypto is developed across multiple git worktrees in parallel (one per
in-flight change). Bringing the full application up locally — Postgres, schema,
seed, and the Next.js server — historically relied on a single fixed Docker
Compose project with a hard-coded `container_name` (`krypto-postgres`) and a
fixed host port (`5433`). Two worktrees could not run the app at the same time
without colliding on the container name, the host database port, the app port,
and the shared Compose volume.

The app also has real external dependencies — Foundry-hosted Azure OpenAI v1,
Coinbase market data, PostHog analytics, and ACS Email — plus the trading
safety kernel (`AGENTS.md`): paper-only execution, a read-only model boundary,
deterministic authorization, drawdown lock, cooldown, operator pause, owned
leases, and journaling. Any local harness must be **structurally incapable** of
weakening those, must never require or persist production secrets, and must
never enable paper or live execution.

We already have the seams to do this safely without new runtime dependencies:
`resolveDecisionProvider` (deterministic fixture decisions in validated
non-production harness mode), `getMarketDataProvider` /
`createFixtureMarketDataProvider` (fixture market data), the existing
`db:migrate` / `db:init` scripts, and the read-only provider smoke functions
(`smokeFoundry` / `smokeCoinbase`).

## Decision

Add a single worktree-safe orchestrator (`scripts/agent-harness.ts`) with
explicit `up` / `status` / `down` / `smoke` lifecycle subcommands, plus a
parameterized `docker-compose.yml`, a minimal non-sensitive health endpoint
(`/api/health`), and Playwright operator-console validation kept outside the
Jest roots. The harness is governed by these binding rules:

1. **Mock by default.** `up` defaults to `NODE_ENV=development`,
   `AGENT_HARNESS_MODE=mock`, `ROLLOUT_MODE=disabled`, deterministic decision and
   market-data providers, and **no** Foundry / Coinbase / PostHog / email
   credentials or external network. `up --shadow --scenario <steady|dip|crash>
   --decision <HOLD|BUY|SELL>` may use deterministic providers under
   `ROLLOUT_MODE=shadow`, still with no external network and no trade mutation.
   Paper and live rollout are rejected in harness options.

2. **Unique resources per worktree.** A safe, stable id is derived from the
   canonical repository path. The Compose project name, database name, host app
   and database ports, and the ignored `.harness/<id>/` artifact directory are
   all derived from that id. The fixed `container_name` is removed and volumes /
   networks are scoped by the Compose project name, so two worktrees never
   collide.

3. **Shadow-only real smoke.** Real-provider validation exists only behind the
   explicit `smoke` subcommand, which requires `--allow-network-smoke`, valid
   Azure OpenAI v1 configuration, and an attended Entra identity; forces
   `AGENT_HARNESS_MODE=smoke` + `ROLLOUT_MODE=shadow`; runs a **read-only**
   Azure OpenAI + Coinbase smoke (reusing `smokeFoundry` / `smokeCoinbase`; it
   never emits PostHog or email events); never invokes trade execution; and
   refuses production-looking database hosts/URLs and `NODE_ENV=production`.

4. **No production credentials, ever.** The harness sets only local fixture
   `CRON_SECRET` / `ADMIN_PASSWORD` / `ADMIN_SESSION_SECRET` values, never reads
   or writes real secrets, and the persisted manifest records only non-sensitive
   scalars (pid, timestamps, ports, project/database names, mode, rollout, and
   artifact paths) — never credentials or connection strings.

5. **Read-only evidence and exact-resource cleanup.** The versioned manifest and
   captured logs/screenshots are evidence only. `down` reads the manifest,
   verifies the recorded pid still belongs to *this* worktree's Next process
   before signaling that exact pid, then runs `docker compose -p <exact project>
   down --volumes`. It never kills by process name and never deletes wildcard
   paths; logs and screenshots are preserved and the manifest is marked stopped.
   On `up` failure the harness cleans only the resources that invocation created.

## Consequences

- Positive: Multiple worktrees can run the full app in parallel with no manual
  port/name bookkeeping and no cross-contamination.
- Positive: The default developer path performs no external calls and cannot
  touch real money, real analytics, or real email; the safety kernel is
  protected structurally rather than by convention.
- Positive: Real-provider confidence is still available on demand, but only
  read-only, shadow, credential-gated, and never against production.
- Negative / trade-offs: Playwright adds one pinned dev dependency and a browser
  download in CI setup; browser validation requires an already-running harness.
- Follow-ups required: Any future live-execution path remains a separate,
  accepted RFC + release plan; the harness must never be the vehicle for it.

## Alternatives considered

- **Keep one fixed Compose project and serialize worktrees** — rejected. It
  blocks parallel development and invites accidental cross-worktree data
  clobbering through the shared volume.
- **Let the harness read the developer's real `.env`** — rejected. That would
  risk booting the app with production secrets and non-mock providers; the
  harness instead constructs an explicit, redaction-safe environment.
- **Run browser specs inside Jest** — rejected. Playwright needs its own runner
  and a live server; mixing it into the Jest roots would make unit tests depend
  on a browser and a running app.
