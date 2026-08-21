# `src/db` — schema, migrations, seed

Scoped delta to root [`AGENTS.md`](../../AGENTS.md). Read the root safety kernel
first.

## Mission

Own the Drizzle schema (`schema.ts`, `index.ts`), generated migrations under
`drizzle/**`, and seed/reset flows. Preserve portfolio, trade, journal, and
agent-state invariants.

## Non-negotiables (delta)

- Prefer additive, reversible schema changes. Call out destructive migrations or
  data backfills explicitly.
- Keep schema, migrations, seed scripts, and tests aligned; do not hand-edit
  generated migration history to diverge from `schema.ts`.
- Preserve private-schema, cron, and vault access restrictions established by
  existing migrations (e.g. `0002`, `0004`, `0005`).
- Run `npm run db:migrate` and `npm run db:init` only against disposable/local
  databases — never a production or shared target.

## Validation

- `npm run db:migrate` (disposable DB) and `npm run db:init`.
- `npm run test:migrations` and relevant DB/seed suites under `tests/`.
- The app harness (`npm run harness:up`) runs these same migrations and the
  deterministic seed against an isolated, per-worktree database; never point it
  at a shared or production target.
- `npm run lint`.

## Escalation / non-goals

- Schema/migration paths route to **trading safety review** (see
  `specialistRouting.tradingSafety` in
  [`.github/agentic-policy.json`](../../.github/agentic-policy.json)).
- Agents may implement and test database, backup, and inventory automation
  against disposable/local targets. Executing any production database
  operation remains human-only — see
  [`specs/deployment.md`](../../specs/deployment.md).
