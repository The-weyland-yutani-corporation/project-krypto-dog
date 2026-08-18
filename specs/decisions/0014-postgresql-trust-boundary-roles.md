# 0014 — PostgreSQL trust-boundary roles: owner, schema owner, migrator, scheduler, runtime

- **Status:** Accepted (source implemented; no live role migration performed by this ADR)
- **Date:** 2026-08-16
- **Deciders:** @VeVarunSharma

## Context

[GitHub issue #133](https://github.com/The-weyland-yutani-corporation/project-krypto-dog/issues/133)
(normative control **DB-01** in
[`specs/production-readiness-prd.v1.md`](../production-readiness-prd.v1.md))
found that the runtime and migration connections shared one privileged
PostgreSQL identity: `DIRECT_URL`, the server administrator, was also used to
run migrations, and no dedicated least-privilege application role existed.
Because PostgreSQL object owners bypass ordinary `GRANT`/`REVOKE` ACLs, a
compromised web runtime running as (or inheriting) that identity could alter
schema, rewrite migration history, or reach objects with no business
relationship to serving trades.

[ADR 0006](./0006-migration-history-supabase-schema.md) (2026-07-14, still
**Proposed**) already required a private `krypto` schema with explicit
privilege revocation, but it described migrations running "over `DIRECT_URL`"
with `drizzle-kit migrate` — i.e., as the admin/operator identity. That is
exactly the shared-identity problem DB-01 requires fixing.
[ADR 0008](./0008-azure-native-deployment-architecture.md) accepted the
Azure Database for PostgreSQL Flexible Server 17 target and said the
"owner/migrator/scheduler/runtime separation" from ADR 0006 "continues to
apply on the Azure-hosted server," but ADR 0006 had not yet defined that
separation concretely — only the schema-privacy half of it.

This ADR defines the concrete four-plus-one role trust boundary and amends
ADR 0006's `DIRECT_URL`-for-migrations language accordingly. It is a **design
and source-implementation record**: `drizzle/0008_postgresql_trust_boundaries.sql`,
`src/deployment/bootstrap-runtime-role.ts`, `src/deployment/migration-url-safety.ts`,
the extended `src/deployment/preflight.ts`, and the updated
`drizzle.config.ts`/`scripts/seed.ts`/`scripts/azure/operations/migrate-init.ts`
all exist in this repository now. **No target role migration has occurred as
a result of this ADR or its issue.** Live dev remains shadow/scheduled and
live prod remains disabled/manual, both still running their existing,
pre-trust-boundary database role configuration (see
[`specs/readiness.md`](../readiness.md) and
[`specs/deployment.md`](../deployment.md)) until an operator runs the
attended upgrade procedure in this ADR's Consequences section against each
live environment and retains its evidence.

## Decision

### Role hierarchy

| Role | Login | Attributes | Connection limit | Purpose |
|---|---|---|---|---|
| `krypto_owner` | LOGIN | Azure Flexible Server administrator (environment-specific name; `krypto_owner` is the committed default in `infra/environment.bicep`) | Azure-managed default (`-1` unless the operator narrows it) | The **only** identity authenticated over the protected `DIRECT_URL`. Performs only idempotent role/ownership bootstrap (`bootstrap-azure-runtime-role.ts --mode database-roles`) and privileged inventory/backup (`deployment-preflight.ts`, `create-verified-backup.ts`). Never runs `drizzle-kit migrate` — `drizzle.config.ts` requires `MIGRATION_URL` for the `migrate` command and refuses to fall back to `DIRECT_URL`. |
| `krypto_schema_owner` | NOLOGIN | `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS` | `0` | Owns the `krypto` schema and every table, sequence, type, and function inside it. Never granted `LOGIN`; never granted to the runtime. |
| `krypto_migrator` | LOGIN, `NOINHERIT` | same non-superuser/createdb/createrole/replication/bypassrls set | `5` | The only role that authenticates over the dedicated `MIGRATION_URL` (a direct, non-pooled connection distinct from both `DIRECT_URL` and `DATABASE_URL`). Owns the `drizzle` migration ledger. Holds database `CREATE` because `drizzle-kit migrate` executes `CREATE SCHEMA IF NOT EXISTS` for its ledger on every run, but has no `CREATE` on `public`. Holds `SET`-only (not `INHERIT`, not `ADMIN`) membership in `krypto_schema_owner`, so it must explicitly `SET ROLE "krypto_schema_owner"` to create or alter schema-owned objects or to run the one-time singleton init in `scripts/seed.ts` — it never automatically has the schema owner's privileges. |
| `krypto_scheduler` | NOLOGIN | same non-superuser/createdb/createrole/replication/bypassrls set | `0` | Reserved for future `SECURITY DEFINER` function ownership (the fixed `invoke_agent_run`/`invoke_daily_summary` helpers from ADR 0006). Azure scheduling is external — Container Apps Jobs cron defined in Bicep (ADR 0008 item 10) — so nothing in this repository ever authenticates as, inherits, or assumes `krypto_scheduler`; the runtime specifically cannot. |
| `krypto_runtime` | NOLOGIN | same non-superuser/createdb/createrole/replication/bypassrls set | `0` | Exact least-privilege table/sequence grant matrix (unchanged from migration 0007, reasserted by migration 0008 as `krypto_schema_owner`): `USAGE` on schema `krypto`; `SELECT, UPDATE` on `AgentState`; `SELECT, INSERT, UPDATE` on `AgentRun`; `SELECT, INSERT` on `TradeExecution`; `SELECT, INSERT` on `AgentJournal`. No `CREATE`/DDL, no role-membership authority, no migration-ledger access, no Vault/`pg_cron`/`pg_net` access, and no `public`-schema usage. |
| `krypto_app` (environment-specific login name; `krypto_app` is the committed default in `infra/release.bicep`) | LOGIN | non-superuser/createdb/createrole/replication/bypassrls; `INHERIT` | `20` | The only role the running application authenticates as, over `DATABASE_URL`. Its **only** membership is `krypto_runtime` — `bootstrap-runtime-role.ts` grants that membership and defensively revokes any membership in `krypto_schema_owner`, `krypto_migrator`, or `krypto_scheduler` every time it runs, even against an environment where those roles do not exist yet. |

### Default privileges fail closed

Migration 0008 installs `ALTER DEFAULT PRIVILEGES` for **both** `krypto_schema_owner`
and `krypto_migrator` as creators (a future migration author can forget the
`SET ROLE` boundary and create an object directly as `krypto_migrator`), on
tables, sequences, and functions, revoking all privileges from `krypto_runtime`
and from `PUBLIC`. A future `krypto`-schema object therefore starts with no
runtime or public access by default; access must be an explicit, reviewed
grant.

### `search_path` is not a security boundary here

The bootstrap sets `search_path=pg_catalog` for the owner, migrator, scheduler,
and operator roles, and `search_path=krypto,pg_catalog` for the runtime group
and runtime login. Application and migration SQL also fully qualify the schema (`kryptoSchema =
pgSchema("krypto")` in `src/db/schema.ts`; every migration statement
qualifies `"krypto"."..."`), so an unqualified-name resolution attack has no
target regardless of the connection's effective `search_path`. The intended,
safe effective `search_path` for defense in depth is `pg_catalog` alone for
`krypto_owner`/`krypto_migrator`/`krypto_scheduler` (none of them need
unqualified resolution into `krypto` or `public`) and `krypto,pg_catalog` for
the runtime login (matching its narrow grants, with `public` excluded).
`preflight.ts` records the effective `search_path` on all three connections and
fails closed after migration 0008 if any path differs; `public` and `$user`
must never participate in name resolution.

### Credential custody

Three connection strings, three independently custodied and rotated
credentials:

| Connection | Role | Password source | Never mounted on |
|---|---|---|---|
| `DATABASE_URL` | `krypto_app` | `RUNTIME_DATABASE_PASSWORD` GitHub secret → Key Vault `runtime-database-password` (`AZURE_RUNTIME_LOGIN_PASSWORD` in `migrate-init`; the runtime container reads `DATABASE_URL` directly) | migration or admin identity |
| `MIGRATION_URL` | `krypto_migrator` | `MIGRATOR_DATABASE_PASSWORD` GitHub secret → Key Vault `migrator-database-password` (`KRYPTO_MIGRATOR_LOGIN_PASSWORD` container env) | web, scheduler, `verified-backup`, `target-smoke`, `activation-check` |
| `DIRECT_URL` | `krypto_owner` | `POSTGRES_ADMIN_PASSWORD` GitHub secret (`environment.bicep`-time only) | web, scheduler |

`KRYPTO_MIGRATOR_LOGIN_PASSWORD` is granted **only** to the `migrate-init` ops
job. The credential-bearing `MIGRATION_URL` is mounted only on `migrate-init`
and the protected `preflight` job; preflight opens an explicit read-only
transaction to prove migrator identity and safety. `MIGRATION_URL` is never
mounted on the web Container App, the
hourly/daily scheduler jobs, `verified-backup`, `target-smoke`, or
`activation-check`. `src/deployment/migration-url-safety.ts` — a
dependency-free module shared by `drizzle.config.ts`, `scripts/seed.ts`, and
`preflight.ts` — rejects a `MIGRATION_URL` that looks like a transaction
pooler (hostname/port/`pgbouncer=true`), that is identical to `DIRECT_URL` or
`DATABASE_URL`, or whose username matches either of theirs.

### Protected `migrate-init` order

`scripts/azure/operations/migrate-init.ts` runs, in this exact order, and
never deletes or resets `TradeExecution`/`AgentState`/`AgentRun`/`AgentJournal`
rows at any step:

1. **Admin bootstrap** (`bootstrap-azure-runtime-role.ts --mode database-roles`
   over `DIRECT_URL`, as `krypto_owner` only) — idempotently creates or
   converges `krypto_schema_owner`, `krypto_scheduler`, `krypto_runtime`
   (`NOLOGIN`), and `krypto_migrator` (`LOGIN NOINHERIT`, rotated from
   `KRYPTO_MIGRATOR_LOGIN_PASSWORD`); on an upgrade from a pre-existing
   deployment, also transfers ownership of the existing `krypto`
   schema/objects and `drizzle` ledger, because `ALTER ... OWNER TO` requires
   the *current* session to already own the object.
2. **Migration** (`drizzle-kit migrate` over `MIGRATION_URL`, as
   `krypto_migrator`) — applies reviewed migration history, including
   `0008_postgresql_trust_boundaries.sql`'s fresh-install ownership transfer
   and fail-closed self-verification.
3. **Post-migration finalization** (the admin bootstrap rerun over `DIRECT_URL`)
   — revokes all `public`-schema access from `PUBLIC`, the runtime, and the
   migrator after the temporary `CREATE` needed only by historical
   fresh-install migrations and removes the operator's temporary explicit
   memberships in owner/migrator roles. Database `CREATE` remains because
   `drizzle-kit` requires it for `CREATE SCHEMA IF NOT EXISTS drizzle`.
4. **Runtime login bootstrap** (`bootstrap-azure-runtime-role.ts` default mode,
   over `DIRECT_URL` + `DATABASE_URL`) — creates or safely rotates the
   environment-specific Azure login role (`krypto_app` by convention) and
   grants it `krypto_runtime` membership only.
5. **Idempotent singleton init** (`scripts/seed.ts` over `MIGRATION_URL`, with
   an explicit `SET ROLE "krypto_schema_owner"` / `RESET ROLE`) —
   `INSERT ... ON CONFLICT DO NOTHING` for the paper `AgentState` singleton.

All five steps are idempotent; re-running `migrate-init` against an
already-initialized environment reports success without changing existing
rows.

### Preflight evidence

`deployment-preflight.ts` records, per the `trust-boundary-*` check family:
session/`current_user` identity on each of `DIRECT_URL`/`MIGRATION_URL`/
`DATABASE_URL`; `krypto_schema_owner`/`krypto_migrator`/`krypto_scheduler`
role attributes (`trust-boundary-role-attributes`); the migrator's SET-only,
non-inheriting path to the schema owner
(`trust-boundary-migrator-set-role-path`); the runtime's freedom from any
elevated membership (`trust-boundary-runtime-not-elevated`); exact schema and
migration-ledger ownership (`trust-boundary-app-schema-ownership`,
`trust-boundary-migration-ledger-ownership`); the denial matrix — no runtime
access to the migration ledger, legacy `vault`/`cron`/`net`/`pg_net` schemas,
or unrelated `public`-schema grants (`trust-boundary-runtime-denial-matrix`);
effective `public`-schema usage (`trust-boundary-runtime-public-schema`);
default-privilege leaks (`trust-boundary-default-privileges`); whether
`PUBLIC` can still `CREATE` in `public` (`trust-boundary-public-schema-create`);
the migrator's bounded connection limit and required database/no-public CREATE
boundary (`trust-boundary-migrator-connection-limit` and
`trust-boundary-migrator-create-boundary`); and fail-closed connection
`search_path` (`trust-boundary-search-path`). Every trust-boundary check
blocks deployment (fails closed) once the environment's migration history has
reached migration 0008, rather than merely warning.

## Consequences

- **Positive:** A compromised web runtime (`krypto_app`/`krypto_runtime`) can
  read/write only the four application tables it needs, cannot alter schema,
  cannot read or tamper with migration history, cannot reach Vault/cron/`pg_net`
  objects, and cannot assume the scheduler or schema-owner identity.
- **Positive:** The admin/operator (`krypto_owner`/`DIRECT_URL`) is narrowed to
  idempotent bootstrap and inventory/backup; it is no longer the identity that
  runs migrations.
- **Positive:** Default privileges fail closed for both intended
  (`krypto_schema_owner`) and accidental (`krypto_migrator`) object creators,
  so a future migration cannot silently widen runtime access.
- **Positive:** Real-PostgreSQL tests (`scripts/test-migrations.sh`) prove
  this exact matrix, both role attributes/connection limits and explicit
  denials, for a fresh install and for the 0006/0007-to-0008 upgrade path with
  row preservation.
- **Trade-off:** A pre-existing (pre-#133) deployment requires the attended
  upgrade procedure below before its live database matches this design; until
  that runs, its `DIRECT_URL` identity remains whatever it already was.
- **Trade-off:** `krypto_scheduler` exists with no assigned owner today (it
  is reserved for the fixed cron helper functions); a future migration must
  explicitly `ALTER FUNCTION ... OWNER TO krypto_scheduler` before it is
  meaningful, rather than this ADR doing so retroactively.
- **Follow-ups required (operator, attended, per environment):**
  1. Pause/confirm the target environment is not mid-execution (dev and prod
     both already run with schedules `Manual` or disabled per current live
     state; do not proceed if a schedule is active without first pausing it).
  2. Run and retain a verified backup (`verified-backup` ops job) against the
     current release before mutating any role or ownership.
  3. Set the protected GitHub Environment secrets `MIGRATION_URL` and
     `MIGRATOR_DATABASE_PASSWORD` (in addition to the existing `DIRECT_URL`,
     `DATABASE_URL`, `RUNTIME_DATABASE_PASSWORD`, `POSTGRES_ADMIN_PASSWORD`)
     for the target environment. Never commit real values.
  4. Deploy this source (the release carrying migration
     `0008_postgresql_trust_boundaries.sql` and the updated `migrate-init`
     job) to that environment via the existing gated `azure-deploy-dev.yml` /
     `azure-deploy-prod.yml` workflow.
  5. Run `migrate-init` and retain its immutable evidence — this performs the
     upgrade-path ownership transfer (step 1 above) before applying migration
     0008.
  6. Run `preflight` and retain its immutable evidence, confirming every
     `trust-boundary-*` check passes.
  7. Run `target-smoke` and retain its immutable evidence, confirming the
     application still functions end to end against the narrowed runtime
     role.
  8. **Dev first**, then prod, exactly as every other release change in this
     repository is sequenced. Do this only after dev's own upgrade evidence
     passes.
  9. No step in this procedure deletes, truncates, or resets any
     `TradeExecution`, `AgentRun`, `AgentJournal`, or `AgentState` row; all
     five steps of `migrate-init` are idempotent.
  10. This procedure never changes a live schedule from `Manual`/disabled to
      `Schedule`. Schedule activation remains a fully separate, already
      gated procedure (ADR 0008 items 12–13); running this upgrade does not
      imply or authorize it.
  11. If any step fails or produces an unexpected `trust-boundary-*` block,
      roll back to the prior release exactly as any other failed deployment
      (ADR 0008 rollback path) and do not proceed to the next environment.
  12. Rotate `MIGRATOR_DATABASE_PASSWORD` and `RUNTIME_DATABASE_PASSWORD`
      independently going forward, using the existing
      `azure-rotate-secrets.yml` rotation workflow, which now re-runs
      `migrate-init` (rotating/reasserting both the migrator and runtime
      credentials) before its `target-smoke` re-run, and leaves the
      environment disabled/manual afterward exactly as before.

### Evidence contract for issue #76

Completing DB-01 requires indexing, in #76, per environment:

- a **redacted role matrix** (role name, LOGIN/NOLOGIN, attributes, connection
  limit, memberships, `SET`/`INHERIT` boundary — no passwords or connection
  strings);
- a **GitHub Environment secret inventory** proving `MIGRATION_URL` and
  `MIGRATOR_DATABASE_PASSWORD` are present only where this ADR specifies
  (`migrate-init`, and credential-bearing `MIGRATION_URL` additionally on the
  protected read-only `preflight` job) and
  absent from the web/scheduler runtime and from `verified-backup`/
  `target-smoke`/`activation-check`;
- a **migration attestation** — the exact migration history hash/count
  including `0008_postgresql_trust_boundaries.sql`, and the `migrate-init`
  evidence for that environment's own upgrade run;
- a **denial transcript** — the `trust-boundary-runtime-denial-matrix`,
  `trust-boundary-migrator-set-role-path`, and
  `trust-boundary-runtime-not-elevated` preflight evidence for that
  environment, proving the runtime cannot reach the migration ledger, legacy
  Vault/cron/net/`pg_net` schemas, or an elevated role; and
- a **fresh-install and upgrade test transcript** — the
  `scripts/test-migrations.sh` run proving the exact fail-closed
  `krypto_runtime` privilege matrix, the full role-attribute/connection-limit
  matrix, the migrator's `SET`-only path, the denial matrix against real
  pre-existing legacy grants, migrator/runtime password rotation, and
  `deployment-preflight.ts` passing end to end and failing closed on a
  missing or unsafe `MIGRATION_URL`, for both a fresh install and the
  upgrade path.

Repository ownership, GitHub organization, and all identity/subscription IDs
referenced by this ADR are unchanged by it.

Each Project Krypto environment owns a separate PostgreSQL Flexible Server
cluster (`psql-krypto-dev` and `psql-krypto-prod` through the environment
templates). The fixed role names in this ADR are cluster-global PostgreSQL
roles, so two independently credentialed Project Krypto environments must
never share one server. The real-PostgreSQL suite deliberately reuses one
migrator password across its multiple databases on one ephemeral cluster and
enforces SCRAM authentication, matching that cluster-global rule rather than
masking it with per-database passwords.

## Alternatives considered

- **Keep migrations on `DIRECT_URL`/`krypto_owner` and rely only on ADR
  0006's schema privacy:** rejected — the admin identity would remain able to
  bypass every ACL in `krypto` as its owner, and a runtime compromise sharing
  that credential (or a credential with the same blast radius) could rewrite
  migration history.
- **Grant `krypto_migrator` `INHERIT` membership in `krypto_schema_owner`:**
  rejected — inheritance would make every migrator connection automatically
  hold schema-owner privilege for its entire session, defeating the purpose
  of a narrow, explicit `SET ROLE` boundary that is easy to audit in
  migration SQL.
- **Let `krypto_app` connect directly as `krypto_runtime`:** rejected —
  `krypto_runtime` is `NOLOGIN` by design; a group role, not a login role,
  keeps the login credential and the privilege set independently rotatable
  and lets a future second login role (e.g., a different workload) share the
  same grant matrix without a new migration.
- **Assign `krypto_scheduler` ownership of the cron helper functions now:**
  deferred, not rejected — Azure scheduling is Container Apps Jobs (Bicep),
  not database-side `pg_cron`, so there is no current caller that needs
  `krypto_scheduler` to own anything yet; reserving the role avoids a future
  migration needing to invent it under time pressure.
- **Perform the live role migration as part of this ADR/PR:** rejected — this
  is a documentation-and-design change; the Non-goal in issue #133 is
  explicit that no target migration occurs merely by completing this
  design/implementation. The attended upgrade procedure above is required
  and separately evidenced per environment.
