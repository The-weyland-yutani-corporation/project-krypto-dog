# 0001 — Drizzle ORM over Prisma

- **Status:** Accepted
- **Date:** 2026-03-22
- **Deciders:** @VeVarunSharma

## Context

The v1 PRD specified Prisma as the ORM ("Supabase managed PostgreSQL via Prisma ORM"). During v1 implementation both `prisma/schema.prisma` and `src/db/schema.ts` (Drizzle) ended up in the tree, with runtime code already using Drizzle and `prisma/seed.ts` carrying broken type imports (`TradeDirection` did not exist on the Prisma client). The `db:seed` script in `package.json` pointed at the broken Prisma seed file.

Two PRD-compliant resolutions were possible: complete the Prisma migration (delete Drizzle, fix seed) or commit to Drizzle (delete Prisma).

## Decision

**Drizzle is the sole ORM.** Prisma is fully removed.

- `src/db/schema.ts` — Drizzle schema is the canonical schema definition.
- `drizzle/` — generated migrations (committed).
- `scripts/seed.ts` — Drizzle-based seeding for the `AgentState` singleton.
- Supabase migrations in `supabase/migrations/` mirror the Drizzle output for `supabase db push` workflows.

## Consequences

- **Positive:** Single ORM, no schema drift risk; Drizzle's native SQL feels closer to the Postgres mental model already used in `pg_cron` migrations; smaller dependency footprint (no Prisma client codegen step).
- **Trade-off:** Lose Prisma Studio (mitigated by `drizzle-kit studio` and Supabase Studio).
- **Follow-up:** v1 PRD text mentions Prisma; the master `specs/prd.md` reflects Drizzle as current. `prisma/` directory deleted.

## Alternatives considered

- **Stay on Prisma, fix seed:** rejected — runtime had already been written against Drizzle and rewriting all DB calls was a larger blast radius than just removing Prisma.
- **Use both (Prisma for migrations, Drizzle for runtime):** rejected — schema drift is inevitable when two systems own the schema definition.
