# `src/db` — schema, migrations, seed

Scoped delta to root [`AGENTS.md`](../../AGENTS.md). Read the root safety kernel
first.

## Mission

Own the Drizzle schema (`schema.ts`, `index.ts`), generated migrations under
`drizzle/**`, and seed/reset flows. Preserve portfolio, trade, journal, and
agent-state invariants.


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
  against disposable/local targets. Production migrations and backups belong
  to the reviewed, evidence-gated native deployment workflow, never arbitrary
  model tools or ad hoc production commands. Preserve the commissioning and
  recovery gates in [`specs/operations.md`](../../specs/operations.md).
