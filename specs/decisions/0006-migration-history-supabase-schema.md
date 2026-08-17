# 0006 -- Single Drizzle migration history and private Supabase schema

- **Status:** Proposed
- **Date:** 2026-07-14
- **Amended:** 2026-08-16 -- item 1's "`DIRECT_URL`" migration-connection
  language is superseded by
  [0011-postgresql-trust-boundary-roles.md](./0011-postgresql-trust-boundary-roles.md):
  reviewed migrations run over the dedicated `MIGRATION_URL` as the
  least-privilege `krypto_migrator` role, never over `DIRECT_URL` as the
  admin/operator role. `DIRECT_URL` is narrowed to idempotent role/ownership
  bootstrap and privileged inventory/backup. This amendment is a source and
  design record only; see 0010's Consequences for the required attended
  per-environment upgrade procedure and current live status.
- **Deciders:** @VeVarunSharma

## Context

The v2 repository has overlapping database histories:

- `drizzle/` contains Drizzle-generated application-schema migrations.
- `supabase/migrations/` independently recreates the application tables and also
  contains Supabase-specific cron SQL.
- `specs/deployment.md` presents `drizzle-kit push` and `supabase db push` as
  interchangeable production choices.

They are not interchangeable. Each runner tracks its own history, so alternating
them can reapply overlapping schema operations or leave one history unaware of
changes applied by the other.

The existing seed file is also unsafe:
`supabase/migrations/20260322000001_seed_data.sql` begins by deleting every
`AgentJournal`, `TradeExecution`, and `AgentState` row, then inserts fabricated
history. It is both a numbered migration and the seed path in
`supabase/config.toml`.

Finally, all application tables and the privileged cron helper are created in
Supabase's exposed `public` schema. The SQL contains no RLS policies or explicit
table/function privilege revocation. The `SECURITY DEFINER` cron helper accepts
an arbitrary endpoint path.

## Decision

1. **Drizzle migrations are the only production application-schema history.**
   Production applies reviewed, committed migrations with `drizzle-kit migrate`.
   `drizzle-kit push` is limited to disposable local development.
   ([0011](./0011-postgresql-trust-boundary-roles.md) later defined the exact
   connection this uses: the dedicated `MIGRATION_URL`/`krypto_migrator`
   role, not `DIRECT_URL`; the original text here read "over `DIRECT_URL`.")

2. **The Drizzle schema remains canonical.** Table, enum, index, constraint, and
   application-function changes begin in `src/db/schema.ts` or a reviewed custom
   Drizzle migration. The legacy Supabase table-creation migrations are not an
   independent schema source.

3. **Application data moves to a private `krypto` schema.** It is not exposed by
   the Supabase Data API. Migrations explicitly revoke broad schema, table, and
   function privileges.

4. **Supabase-specific operations share the reviewed migration history.**
   Extensions and fixed cron helper functions may be added through custom
   Drizzle SQL migrations. Cron scheduling remains a separately invoked,
   post-smoke operation so a schema migration cannot silently start traffic.

5. **The arbitrary-path cron helper is removed.** It is replaced by fixed,
   parameterless functions for the agent-run and daily-summary routes.
   `EXECUTE` is revoked from `PUBLIC`, `anon`, and `authenticated`, then granted
   only to the required owner/service role.

6. **Seeds are never migrations.** The destructive SQL file is removed from all
   production migration and reset paths. Local/demo fixtures live in a dedicated
   seed file. Production account initialization is an application command using
   `INSERT ... ON CONFLICT DO NOTHING`; it never deletes history.

7. **Existing databases use expand/backfill/validate/contract migrations.**
   Before the first v2.1 migration, operators repair credentials, inventory the
   live schema/data/cron state, take a verified backup, check for an open paper
   position, and pause cron. Old columns remain available until reconciliation
   proves the new representation.

## Consequences

- Positive: One auditable migration history owns all production schema changes.
- Positive: Re-running account initialization cannot erase trades or journals.
- Positive: Application data and privileged functions are not exposed through
  Supabase's default public API surface.
- Positive: Schema changes cannot automatically enable cron traffic.
- Trade-off: Existing deployments require an explicit reconciliation and
  compatibility migration before joining the Drizzle history.
- Trade-off: Custom SQL migrations are required for Supabase extensions,
  privileges, and cron functions that Drizzle's schema DSL does not model.
- Follow-ups: remove the destructive seed path, update `drizzle.config.ts` to
  use `DIRECT_URL`, set `prepare: false` on the transaction-pooler runtime
  client, add private-schema migrations, and replace the deployment runbook.

## Alternatives considered

- **Choose Drizzle or Supabase CLI independently per database:** rejected. It
  preserves two overlapping histories and makes repository behavior depend on
  undocumented operator choice.
- **Keep application tables in `public` and rely on implicit grants:** rejected.
  Server-only trading and accounting data should not depend on Supabase API
  defaults.
- **Keep the destructive seed with a warning:** rejected. A production-dangerous
  command should not remain on a normal migration or reset path.
