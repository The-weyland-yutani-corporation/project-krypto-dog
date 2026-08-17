import postgres from "postgres";

/**
 * Narrowly-scoped, idempotent bootstrap for the Azure PostgreSQL safety
 * transition (see drizzle/0007_azure_retire_supabase_http_functions.sql
 * and specs/decisions/0008-azure-native-deployment-architecture.md).
 *
 * Migration 0007 creates the least-privilege `krypto_runtime` NOLOGIN group
 * role with explicit schema/table/sequence privileges. It intentionally
 * does not grant that role to any login role — the Azure login role's
 * name (and, for a fresh deployment, its credential) is environment-
 * specific and is not reviewed migration content, and membership or
 * credential provisioning must never require embedding a password in
 * migration history.
 *
 * This module exposes two narrowly-scoped, idempotent actions:
 *
 *   - `bootstrapRuntimeRoleMembership`: grants membership in the
 *     pre-existing `krypto_runtime` group role to a pre-existing login
 *     role, by name. It never creates the login role and never reads,
 *     sets, or stores a password. Use this when the login role's
 *     credential is already provisioned by another means (for example, a
 *     managed-identity/Azure AD principal that authenticates without a
 *     static password).
 *
 *   - `bootstrapRuntimeLoginRole`: the primary Azure entry point. The
 *     application currently authenticates with a static `DATABASE_URL`
 *     (username + password), not a dynamically-refreshed managed-identity
 *     token, so a fresh Azure deployment has no way to create its runtime
 *     login role's password-based credential without this step. It
 *     creates the LOGIN role if absent, or safely rotates its password if
 *     present; verifies the role is non-superuser, non-createdb,
 *     non-createrole, non-replication, and non-bypassrls; and grants
 *     `krypto_runtime` membership. The password is never interpolated
 *     into SQL text, returned, logged, or embedded in migration history:
 *     it travels only as a bound query parameter into a transaction-local
 *     `set_config(..., true)` session setting, and is applied to the role
 *     entirely server-side inside a `DO` block via
 *     `current_setting(...)` and `format(%I, %L)`.
 */

export const RUNTIME_ROLE_NAME = "krypto_runtime";
export const DEFAULT_RUNTIME_LOGIN_CONNECTION_LIMIT = 20;

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]*$/;

const BOOTSTRAP_LOGIN_ROLE_GUC = "krypto.bootstrap_login_role";
const BOOTSTRAP_LOGIN_PASSWORD_GUC = "krypto.bootstrap_login_password";

export interface BootstrapRuntimeRoleInput {
  directUrl?: string;
  loginRole?: string;
}

export interface BootstrapRuntimeRoleResult {
  runtimeRole: string;
  loginRole: string;
  runtimeRolePresent: boolean;
  runtimeRoleIsGroupRole: boolean;
  loginRolePresent: boolean;
  alreadyMember: boolean;
  membershipGranted: boolean;
}

export function isValidRoleIdentifier(value: string): boolean {
  return IDENTIFIER_PATTERN.test(value) && value.length <= 63;
}

/**
 * Grants membership in the krypto_runtime least-privilege group role to an
 * existing Azure login role. Safe to run repeatedly: it never creates,
 * drops, or alters login credentials, and re-granting an existing
 * membership is a no-op in PostgreSQL.
 */
export async function bootstrapRuntimeRoleMembership(
  input: BootstrapRuntimeRoleInput,
): Promise<BootstrapRuntimeRoleResult> {
  const directUrl = input.directUrl?.trim();
  const loginRole = input.loginRole?.trim();

  if (!directUrl) {
    throw new Error(
      "DIRECT_URL is required to bootstrap the runtime role membership.",
    );
  }
  if (!loginRole) {
    throw new Error(
      "A target Azure login role name is required (--login-role or " +
        "AZURE_RUNTIME_LOGIN_ROLE).",
    );
  }
  if (!isValidRoleIdentifier(loginRole)) {
    throw new Error(
      `Refusing to bootstrap an unsafe or malformed role name: ${loginRole}`,
    );
  }

  const sql = postgres(directUrl, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 2,
    // This CLI's only output contract is a single redacted JSON report on
    // stdout; a default NOTICE (e.g. "role already exists, skipping")
    // would otherwise interleave with and corrupt that JSON.
    onnotice: () => {},
  });

  try {
    const [runtimeRoleRow] = await sql<
      Array<{ present: boolean; isGroupRole: boolean }>
    >`
      SELECT
        true AS present,
        NOT rolcanlogin AS "isGroupRole"
      FROM pg_roles
      WHERE rolname = ${RUNTIME_ROLE_NAME}
    `;
    const runtimeRolePresent = runtimeRoleRow?.present ?? false;
    const runtimeRoleIsGroupRole = runtimeRoleRow?.isGroupRole ?? false;

    if (!runtimeRolePresent) {
      throw new Error(
        `Role ${RUNTIME_ROLE_NAME} does not exist. Apply ` +
          "drizzle/0007_azure_retire_supabase_http_functions.sql (or a " +
          "later migration) before bootstrapping membership.",
      );
    }
    if (!runtimeRoleIsGroupRole) {
      throw new Error(
        `Role ${RUNTIME_ROLE_NAME} unexpectedly permits LOGIN; refusing ` +
          "to treat it as the least-privilege runtime group role.",
      );
    }

    const [loginRoleRow] = await sql<
      Array<{
        present: boolean;
        isSuperuser: boolean;
        canCreateDb: boolean;
        canCreateRole: boolean;
        canReplicate: boolean;
        canBypassRls: boolean;
      }>
    >`
      SELECT
        true AS present,
        rolsuper AS "isSuperuser",
        rolcreatedb AS "canCreateDb",
        rolcreaterole AS "canCreateRole",
        rolreplication AS "canReplicate",
        rolbypassrls AS "canBypassRls"
      FROM pg_roles
      WHERE rolname = ${loginRole}
    `;
    const loginRolePresent = loginRoleRow?.present ?? false;

    if (!loginRolePresent) {
      throw new Error(
        `Login role ${loginRole} does not exist. Create the Azure login ` +
          "role (managed identity / Azure AD principal) before " +
          "bootstrapping membership; this script never creates login " +
          "roles or sets passwords.",
      );
    }
    if (
      loginRoleRow.isSuperuser ||
      loginRoleRow.canCreateDb ||
      loginRoleRow.canCreateRole ||
      loginRoleRow.canReplicate ||
      loginRoleRow.canBypassRls
    ) {
      throw new Error(
        `Refusing to bootstrap ${loginRole}: it already exists with an ` +
          "elevated attribute (SUPERUSER, CREATEDB, CREATEROLE, " +
          "REPLICATION, or BYPASSRLS).",
      );
    }

    await sql`ALTER ROLE ${sql(loginRole)} WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 20`;
    await sql`ALTER ROLE ${sql(loginRole)} SET search_path TO krypto, pg_catalog`;

    const [membershipRow] = await sql<Array<{ isMember: boolean }>>`
      SELECT pg_has_role(${loginRole}, ${RUNTIME_ROLE_NAME}, 'MEMBER')
        AS "isMember"
    `;
    const alreadyMember = membershipRow?.isMember ?? false;

    if (!alreadyMember) {
      await sql`GRANT ${sql(RUNTIME_ROLE_NAME)} TO ${sql(loginRole)}`;
    }
    await revokeElevatedRoleMembershipsDefensively(sql, loginRole);

    // Defense in depth: the runtime login role must never be a member of
    // any of the elevated trust-boundary roles (see
    // drizzle/0008_postgresql_trust_boundaries.sql). Each REVOKE is a
    // no-op (a PostgreSQL WARNING, not an error) if the membership was
    // never granted.
    await revokeElevatedRoleMembershipsDefensively(sql, loginRole);

    return {
      runtimeRole: RUNTIME_ROLE_NAME,
      loginRole,
      runtimeRolePresent,
      runtimeRoleIsGroupRole,
      loginRolePresent,
      alreadyMember,
      membershipGranted: !alreadyMember,
    };
  } finally {
    await sql.end();
  }
}

export interface BootstrapRuntimeLoginInput {
  directUrl?: string;
  runtimeUrl?: string;
  loginRole?: string;
  loginPassword?: string;
}

export interface BootstrapRuntimeLoginResult {
  runtimeRole: string;
  loginRole: string;
  runtimeRolePresent: boolean;
  runtimeRoleIsGroupRole: boolean;
  runtimeUrlUsernameMatched: boolean;
  loginRoleExisted: boolean;
  loginRoleCreated: boolean;
  passwordRotated: boolean;
  loginRoleAttributesSafe: boolean;
  alreadyMember: boolean;
  membershipGranted: boolean;
}

/**
 * Creates (or, if already present, safely rotates the password of) the
 * Azure runtime login role, verifies it carries none of the elevated
 * PostgreSQL role attributes, and grants it membership in the
 * least-privilege `krypto_runtime` group role. Safe to run repeatedly.
 *
 * The password is supplied by the caller (`AZURE_RUNTIME_LOGIN_PASSWORD`
 * / `--login-password`, ultimately sourced from a secret store such as
 * Azure Key Vault — never from this script or migration history) and is
 * never interpolated into SQL text, returned in the result, or logged: it
 * travels only as a bound parameter into a transaction-local
 * `set_config(..., true)` session setting, and is applied to the role
 * entirely server-side inside a `DO` block using `current_setting(...)`
 * and `format(%I, %L)`.
 *
 * `runtimeUrl` (`DATABASE_URL`) is required so its username can be proven
 * to match `loginRole` before anything is created or altered — this
 * bootstrap must only ever touch the exact role the application's runtime
 * connection string authenticates as.
 */
export async function bootstrapRuntimeLoginRole(
  input: BootstrapRuntimeLoginInput,
): Promise<BootstrapRuntimeLoginResult> {
  const directUrl = input.directUrl?.trim();
  const runtimeUrl = input.runtimeUrl?.trim();
  const loginRole = input.loginRole?.trim();
  const loginPassword = input.loginPassword;

  if (!directUrl) {
    throw new Error(
      "DIRECT_URL is required to bootstrap the runtime login role.",
    );
  }
  if (!runtimeUrl) {
    throw new Error(
      "DATABASE_URL is required to bootstrap the runtime login role, so " +
        "its username can be proven to match the target login role " +
        "before anything is created or altered.",
    );
  }
  if (!loginRole) {
    throw new Error(
      "A target Azure login role name is required (--login-role or " +
        "AZURE_RUNTIME_LOGIN_ROLE).",
    );
  }
  if (!isValidRoleIdentifier(loginRole)) {
    throw new Error(
      `Refusing to bootstrap an unsafe or malformed role name: ${loginRole}`,
    );
  }
  if (!loginPassword) {
    throw new Error(
      "A login password is required (--login-password or " +
        "AZURE_RUNTIME_LOGIN_PASSWORD) to create or rotate the runtime " +
        "login role's credential. This script never fabricates or " +
        "infers a password.",
    );
  }

  let runtimeUsername: string;
  try {
    runtimeUsername = decodeURIComponent(new URL(runtimeUrl).username);
  } catch {
    throw new Error(
      "DATABASE_URL is not a valid connection URL; cannot verify its " +
        "username matches the target login role.",
    );
  }
  const runtimeUrlUsernameMatched = runtimeUsername === loginRole;
  if (!runtimeUrlUsernameMatched) {
    throw new Error(
      `DATABASE_URL's username (${runtimeUsername || "<empty>"}) does ` +
        `not match the target login role (${loginRole}); refusing to ` +
        "bootstrap a role the runtime connection string does not " +
        "reference.",
    );
  }

  const sql = postgres(directUrl, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    // This CLI's only output contract is a single redacted JSON report on
    // stdout; a default NOTICE (e.g. "role already exists, skipping")
    // would otherwise interleave with and corrupt that JSON.
    onnotice: () => {},
  });

  try {
    const [runtimeRoleRow] = await sql<
      Array<{ present: boolean; isGroupRole: boolean }>
    >`
      SELECT
        true AS present,
        NOT rolcanlogin AS "isGroupRole"
      FROM pg_roles
      WHERE rolname = ${RUNTIME_ROLE_NAME}
    `;
    const runtimeRolePresent = runtimeRoleRow?.present ?? false;
    const runtimeRoleIsGroupRole = runtimeRoleRow?.isGroupRole ?? false;

    if (!runtimeRolePresent) {
      throw new Error(
        `Role ${RUNTIME_ROLE_NAME} does not exist. Apply ` +
          "drizzle/0007_azure_retire_supabase_http_functions.sql (or a " +
          "later migration) before bootstrapping the login role.",
      );
    }
    if (!runtimeRoleIsGroupRole) {
      throw new Error(
        `Role ${RUNTIME_ROLE_NAME} unexpectedly permits LOGIN; refusing ` +
          "to treat it as the least-privilege runtime group role.",
      );
    }

    const [existingRow] = await sql<
      Array<{
        present: boolean;
        isSuperuser: boolean;
        canCreateDb: boolean;
        canCreateRole: boolean;
        canReplicate: boolean;
        canBypassRls: boolean;
      }>
    >`
      SELECT
        true AS present,
        rolsuper AS "isSuperuser",
        rolcreatedb AS "canCreateDb",
        rolcreaterole AS "canCreateRole",
        rolreplication AS "canReplicate",
        rolbypassrls AS "canBypassRls"
      FROM pg_roles
      WHERE rolname = ${loginRole}
    `;
    const loginRoleExisted = existingRow?.present ?? false;

    if (
      loginRoleExisted &&
      (existingRow?.isSuperuser ||
        existingRow?.canCreateDb ||
        existingRow?.canCreateRole ||
        existingRow?.canReplicate ||
        existingRow?.canBypassRls)
    ) {
      throw new Error(
        `Refusing to bootstrap ${loginRole}: it already exists with an ` +
          "elevated attribute (SUPERUSER, CREATEDB, CREATEROLE, " +
          "REPLICATION, or BYPASSRLS). The Azure runtime login role must " +
          "be least-privilege; demote it manually before bootstrapping.",
      );
    }

    // The login role name and password are set as transaction-local
    // session settings — bound parameters, never string-concatenated
    // into SQL text — and applied server-side inside a DO block via
    // current_setting(...) and format(%I, %L). Neither value is ever
    // interpolated into the query text itself, so neither appears in
    // migration history, this script's output, or logs of the query
    // text; is_local = true means the setting evaporates at the end of
    // this transaction regardless of outcome. (PostgreSQL's DO blocks
    // accept no arguments of their own, which is why both values are
    // threaded through current_setting(...) rather than interpolated
    // directly into the DO block's body.)
    await sql`BEGIN`;
    try {
      await sql`SELECT set_config(${BOOTSTRAP_LOGIN_ROLE_GUC}, ${loginRole}, true)`;
      await sql`SELECT set_config(${BOOTSTRAP_LOGIN_PASSWORD_GUC}, ${loginPassword}, true)`;
      await sql`
        DO $$
        DECLARE
          target_role text := current_setting('krypto.bootstrap_login_role', true);
          pwd text := current_setting('krypto.bootstrap_login_password', true);
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
            EXECUTE format(
              'ALTER ROLE %I WITH LOGIN INHERIT PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT %s',
              target_role, pwd, 20
            );
          ELSE
            EXECUTE format(
              'CREATE ROLE %I WITH LOGIN INHERIT PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT %s',
              target_role, pwd, 20
            );
          END IF;
        END
        $$;
      `;
      await sql`COMMIT`;
    } catch (error) {
      await sql`ROLLBACK`;
      throw error;
    }

    const [finalRow] = await sql<
      Array<{
        canLogin: boolean;
        inherits: boolean;
        connectionLimit: number;
        isSuperuser: boolean;
        canCreateDb: boolean;
        canCreateRole: boolean;
        canReplicate: boolean;
        canBypassRls: boolean;
      }>
    >`
      SELECT
        rolcanlogin AS "canLogin",
        rolinherit AS "inherits",
        rolconnlimit AS "connectionLimit",
        rolsuper AS "isSuperuser",
        rolcreatedb AS "canCreateDb",
        rolcreaterole AS "canCreateRole",
        rolreplication AS "canReplicate",
        rolbypassrls AS "canBypassRls"
      FROM pg_roles
      WHERE rolname = ${loginRole}
    `;
    const loginRoleAttributesSafe =
      !!finalRow &&
      finalRow.canLogin &&
      finalRow.inherits &&
      finalRow.connectionLimit === DEFAULT_RUNTIME_LOGIN_CONNECTION_LIMIT &&
      !finalRow.isSuperuser &&
      !finalRow.canCreateDb &&
      !finalRow.canCreateRole &&
      !finalRow.canReplicate &&
      !finalRow.canBypassRls;

    if (!loginRoleAttributesSafe) {
      throw new Error(
        `Post-bootstrap verification failed: ${loginRole} does not have ` +
          "the expected least-privilege LOGIN+INHERIT attributes, bounded " +
          `connection limit (${DEFAULT_RUNTIME_LOGIN_CONNECTION_LIMIT}), and ` +
          "non-superuser/non-createdb/non-createrole/non-replication/non-bypassrls posture.",
      );
    }

    const [membershipRow] = await sql<Array<{ isMember: boolean }>>`
      SELECT pg_has_role(${loginRole}, ${RUNTIME_ROLE_NAME}, 'MEMBER')
        AS "isMember"
    `;
    const alreadyMember = membershipRow?.isMember ?? false;

    if (!alreadyMember) {
      await sql`GRANT ${sql(RUNTIME_ROLE_NAME)} TO ${sql(loginRole)}`;
    }

    await sql`ALTER ROLE ${sql(loginRole)} SET search_path TO krypto, pg_catalog`;

    // Defense in depth: the runtime login role must never be a member of
    // any of the elevated trust-boundary roles (see
    // drizzle/0008_postgresql_trust_boundaries.sql). Each REVOKE is a
    // no-op (a PostgreSQL WARNING, not an error) if the membership was
    // never granted.
    await revokeElevatedRoleMembershipsDefensively(sql, loginRole);

    return {
      runtimeRole: RUNTIME_ROLE_NAME,
      loginRole,
      runtimeRolePresent,
      runtimeRoleIsGroupRole,
      runtimeUrlUsernameMatched,
      loginRoleExisted,
      loginRoleCreated: !loginRoleExisted,
      passwordRotated: loginRoleExisted,
      loginRoleAttributesSafe,
      alreadyMember,
      membershipGranted: !alreadyMember,
    };
  } finally {
    await sql.end();
  }
}

/**
 * Trust-boundary role hierarchy (see GitHub issue #133 and
 * drizzle/0008_postgresql_trust_boundaries.sql):
 *
 *   - `krypto_schema_owner` (NOLOGIN): owns the `krypto` schema and every
 *     table/type/sequence/function in it. Never granted LOGIN, never
 *     granted to the runtime.
 *   - `krypto_migrator` (LOGIN, NOINHERIT): the only role migrations run
 *     as, via the dedicated `MIGRATION_URL`. NOINHERIT means it never
 *     automatically has schema owner's privileges; it can only reach
 *     them with an explicit `SET ROLE`, which migration 0008 uses to
 *     reassert the runtime grant matrix and default privileges after
 *     transferring ownership.
 *   - `krypto_scheduler` (NOLOGIN): reserved for future
 *     `SECURITY DEFINER` function ownership. Never granted to the
 *     runtime and never assumable by it.
 *   - `krypto_runtime` (NOLOGIN, unchanged from migration 0007): the
 *     application's least-privilege table/sequence grant matrix. Pre-
 *     created here (rather than left to migration 0007's own
 *     `CREATE ROLE IF NOT EXISTS`) because `krypto_migrator` deliberately
 *     lacks CREATEROLE.
 *
 * All four are fixed, hardcoded names -- unlike the environment-specific
 * Azure login role bootstrapped by `bootstrapRuntimeLoginRole`, above,
 * these are baked into migration SQL and must exist under these exact
 * names before `drizzle-kit migrate` runs.
 */

export const SCHEMA_OWNER_ROLE_NAME = "krypto_schema_owner";
export const MIGRATOR_ROLE_NAME = "krypto_migrator";
export const SCHEDULER_ROLE_NAME = "krypto_scheduler";
export const APP_SCHEMA_NAME = "krypto";
export const MIGRATION_LEDGER_SCHEMA_NAME = "drizzle";

/**
 * Supabase-legacy schemas that must never be reachable by
 * `krypto_runtime` -- or, defense in depth, by PUBLIC (and therefore
 * every other role, including `krypto_runtime`'s own login role via
 * PostgreSQL's implicit "every role has whatever PUBLIC has" rule).
 * Revoked defensively, and only if present, so this is a no-op on a
 * from-scratch Azure deployment where none of these exist.
 */
const LEGACY_UNRELATED_SCHEMAS = ["vault", "cron", "net", "pg_net"] as const;

const BOOTSTRAP_MIGRATOR_PASSWORD_GUC = "krypto.bootstrap_migrator_password";

const DEFAULT_SCHEMA_OWNER_CONNECTION_LIMIT = 0;
const DEFAULT_SCHEDULER_CONNECTION_LIMIT = 0;
const DEFAULT_RUNTIME_CONNECTION_LIMIT = 0;
const DEFAULT_MIGRATOR_CONNECTION_LIMIT = 5;

function isSafeConnectionLimit(value: number): boolean {
  return Number.isInteger(value) && value >= -1 && value <= 1000;
}

type Sql = ReturnType<typeof postgres>;

/**
 * Defense in depth: revokes membership in each of the three elevated
 * trust-boundary roles from `roleName`, if held. Guarded so this is
 * always safe to call unconditionally after granting `krypto_runtime`
 * membership to a login role -- including in an environment where
 * migration 0008's role hierarchy has not been bootstrapped yet (the
 * elevated roles do not exist), where an unguarded REVOKE would raise
 * "role does not exist" rather than silently succeeding. When an
 * elevated role does exist, revoking a membership it never granted is
 * itself a no-op (a PostgreSQL WARNING, not an error).
 */
async function revokeElevatedRoleMembershipsDefensively(
  sql: Sql,
  roleName: string,
): Promise<void> {
  if (!isValidRoleIdentifier(roleName)) {
    throw new Error(`Refusing an unsafe or malformed role name: ${roleName}`);
  }

  const elevatedRoleNames = [
    SCHEMA_OWNER_ROLE_NAME,
    MIGRATOR_ROLE_NAME,
    SCHEDULER_ROLE_NAME,
  ];

  for (const elevatedRoleName of elevatedRoleNames) {
    await sql.unsafe(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${elevatedRoleName}')
          AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${roleName}')
        THEN
          EXECUTE format('REVOKE %I FROM %I', '${elevatedRoleName}', '${roleName}');
        END IF;
      END
      $$;
    `);
  }
}

/**
 * Creates a NOLOGIN role if absent, or converges its attributes if
 * present. Idempotent drift-correction, mirroring the existing
 * `CREATE ROLE IF NOT EXISTS` / grant-matrix-reassertion style already
 * used by migration 0007. `roleName` must be one of this module's fixed
 * exported role-name constants (never externally supplied), but is still
 * validated defensively before being embedded in generated SQL text.
 */
async function createOrConvergeNoLoginRole(
  sql: Sql,
  roleName: string,
  connectionLimit: number,
): Promise<boolean> {
  if (!isValidRoleIdentifier(roleName)) {
    throw new Error(`Refusing an unsafe or malformed role name: ${roleName}`);
  }
  if (!isSafeConnectionLimit(connectionLimit)) {
    throw new Error(
      `Refusing an unsafe connection limit for ${roleName}: ${connectionLimit}`,
    );
  }

  const [existingRow] = await sql<Array<{ present: boolean }>>`
    SELECT true AS present FROM pg_roles WHERE rolname = ${roleName}
  `;
  const existed = existingRow?.present ?? false;

  await sql.unsafe(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${roleName}') THEN
        EXECUTE format(
          'ALTER ROLE %I WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT %s',
          '${roleName}', ${connectionLimit}
        );
      ELSE
        EXECUTE format(
          'CREATE ROLE %I WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT %s',
          '${roleName}', ${connectionLimit}
        );
      END IF;
    END
    $$;
  `);

  return !existed;
}

/**
 * Transfers ownership of every table/sequence/type/function in
 * `schemaName`, then the schema itself, from whatever role currently
 * owns it (the current session, i.e. the admin/DIRECT_URL identity) to
 * `targetOwnerRole`. Guarded to be a no-op if the schema is missing (a
 * from-scratch install has not created it yet -- migration 0008 owns
 * that fresh-install transfer itself, since `krypto_migrator` creates
 * the schema in that case) or already owned by `targetOwnerRole` (an
 * upgrade this has already run against, or a fresh install where
 * migration 0008 already completed the transfer).
 *
 * `ALTER ... OWNER TO` requires the current session to already own the
 * object and be able to `SET ROLE` to the new owner (PostgreSQL 17
 * docs, GRANT on Roles): the caller must have already granted the admin
 * identity SET-only membership in `targetOwnerRole` before calling this.
 * Owned (SERIAL / IDENTITY) sequences are excluded from the explicit
 * sequence loop: PostgreSQL disallows changing their owner directly, and
 * they follow their owning table's ownership automatically.
 */
async function transferSchemaOwnershipIfNeeded(
  sql: Sql,
  schemaName: string,
  targetOwnerRole: string,
): Promise<boolean> {
  if (
    !isValidRoleIdentifier(schemaName) ||
    !isValidRoleIdentifier(targetOwnerRole)
  ) {
    throw new Error(
      `Refusing an unsafe schema or role name: ${schemaName} / ${targetOwnerRole}`,
    );
  }

  const [row] = await sql<Array<{ owner: string | null }>>`
    SELECT nspowner::regrole::text AS owner
    FROM pg_namespace
    WHERE nspname = ${schemaName}
  `;
  if (!row || row.owner === targetOwnerRole) {
    return false;
  }

  await sql.unsafe(`
    DO $$
    DECLARE
      relation_record record;
      type_record record;
      function_record record;
    BEGIN
      IF (
        SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname = '${schemaName}'
      ) = '${targetOwnerRole}' THEN
        RETURN;
      END IF;

      GRANT CREATE, USAGE ON SCHEMA "${schemaName}" TO "${targetOwnerRole}";

      FOR relation_record IN
        SELECT relation.oid, relation.relname, relation.relkind
        FROM pg_class AS relation
        JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = '${schemaName}'
          AND relation.relkind IN ('r', 'p', 'v', 'm', 'S')
          AND relation.relowner::regrole::text = current_user
          AND NOT (
            relation.relkind = 'S'
            AND EXISTS (
              SELECT 1 FROM pg_depend dependency
              WHERE dependency.objid = relation.oid
                AND dependency.deptype IN ('a', 'i')
            )
          )
      LOOP
        IF relation_record.relkind = 'S' THEN
          EXECUTE format(
            'ALTER SEQUENCE "${schemaName}".%I OWNER TO "${targetOwnerRole}"',
            relation_record.relname
          );
        ELSE
          EXECUTE format(
            'ALTER TABLE "${schemaName}".%I OWNER TO "${targetOwnerRole}"',
            relation_record.relname
          );
        END IF;
      END LOOP;

      FOR type_record IN
        SELECT type.typname
        FROM pg_type AS type
        JOIN pg_namespace AS namespace ON namespace.oid = type.typnamespace
        WHERE namespace.nspname = '${schemaName}'
          AND type.typtype IN ('e', 'c', 'd')
          AND type.typowner::regrole::text = current_user
      LOOP
        EXECUTE format(
          'ALTER TYPE "${schemaName}".%I OWNER TO "${targetOwnerRole}"',
          type_record.typname
        );
      END LOOP;

      FOR function_record IN
        SELECT routine.oid::regprocedure::text AS signature
        FROM pg_proc AS routine
        JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
        WHERE namespace.nspname = '${schemaName}'
          AND routine.proowner::regrole::text = current_user
      LOOP
        EXECUTE format(
          'ALTER FUNCTION %s OWNER TO "${targetOwnerRole}"',
          function_record.signature
        );
      END LOOP;

      ALTER SCHEMA "${schemaName}" OWNER TO "${targetOwnerRole}";
    END
    $$;
  `);

  return true;
}

/**
 * Defensively revokes `krypto_runtime`'s *and PUBLIC's* access to a
 * Supabase-legacy schema, only if that schema exists. PUBLIC is included
 * because a lingering `GRANT ... TO PUBLIC` (common on
 * Supabase-provisioned `vault`/`cron`/`net`/`pg_net` schemas) would
 * otherwise leave every role -- including `krypto_runtime` and its login
 * role -- with implicit access regardless of any revoke targeted at
 * `krypto_runtime` specifically. A no-op (and no permission check is even
 * attempted) on a from-scratch Azure deployment, where none of
 * `LEGACY_UNRELATED_SCHEMAS` exist. This can only be done here, by the
 * admin/DIRECT_URL identity: `krypto_migrator` does not own these
 * schemas and has no grantor history on them, so it cannot revoke
 * privileges on them (REVOKE requires object ownership or having been
 * the original grantor).
 */
async function revokeRuntimeAccessToLegacySchemaIfPresent(
  sql: Sql,
  schemaName: string,
): Promise<boolean> {
  const [row] = await sql<Array<{ present: boolean }>>`
    SELECT to_regnamespace(${schemaName}) IS NOT NULL AS present
  `;
  if (!row?.present) {
    return false;
  }

  for (const granteeSql of [`"${RUNTIME_ROLE_NAME}"`, "PUBLIC"]) {
    await sql.unsafe(`
      REVOKE ALL ON SCHEMA "${schemaName}" FROM ${granteeSql};
      REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA "${schemaName}" FROM ${granteeSql};
      REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA "${schemaName}" FROM ${granteeSql};
      REVOKE EXECUTE ON ALL ROUTINES IN SCHEMA "${schemaName}" FROM ${granteeSql};
    `);
  }
  return true;
}

export interface BootstrapDatabaseRolesInput {
  directUrl?: string;
  migratorPassword?: string;
  migratorConnectionLimit?: number;
  schemaOwnerConnectionLimit?: number;
  schedulerConnectionLimit?: number;
  runtimeConnectionLimit?: number;
}

export interface BootstrapDatabaseRolesResult {
  adminRole: string;
  schemaOwnerRole: string;
  migratorRole: string;
  schedulerRole: string;
  runtimeRole: string;
  schemaOwnerCreated: boolean;
  schedulerCreated: boolean;
  runtimeCreated: boolean;
  migratorExisted: boolean;
  migratorCreated: boolean;
  migratorPasswordRotated: boolean;
  migratorAttributesSafe: boolean;
  appSchemaOwnershipTransferred: boolean;
  migrationLedgerOwnershipTransferred: boolean;
  legacySchemasRevoked: string[];
}

/**
 * Protected admin bootstrap for the four-role PostgreSQL trust boundary
 * (see GitHub issue #133). Must run against `DIRECT_URL` (an
 * administrative connection with CREATEROLE) before `drizzle-kit
 * migrate` runs against the dedicated `MIGRATION_URL`. Idempotent and
 * safe to run on every deploy:
 *
 *   - Creates or converges the three NOLOGIN roles
 *     (`krypto_schema_owner`, `krypto_scheduler`, `krypto_runtime`).
 *     `krypto_runtime` is pre-created here (not left to migration
 *     0007's own guarded `CREATE ROLE`) because `krypto_migrator`
 *     deliberately lacks CREATEROLE.
 *   - Creates `krypto_migrator` (LOGIN, NOINHERIT) if absent, or safely
 *     rotates its password if present, using the same bound-parameter /
 *     DO-block pattern as `bootstrapRuntimeLoginRole` -- the password
 *     is never interpolated into SQL text, returned, logged, or
 *     embedded in migration history.
 *   - Grants `krypto_migrator` SET-only (not INHERIT) membership in
 *     `krypto_schema_owner`, so migrations can reach the schema owner's
 *     privileges only via an explicit `SET ROLE`.
 *   - Grants the connecting admin identity itself SET-only membership
 *     in both `krypto_schema_owner` and `krypto_migrator`, exactly long
 *     enough to perform the ownership transfers below on an upgrade;
 *     this makes the admin's pre-existing implicit authority over these
 *     objects (it created them under the single-role model this
 *     replaces) explicit rather than relying on ambient superuser
 *     behavior.
 *   - On an upgrade from a pre-existing deployment (never on a
 *     from-scratch install, where `krypto_migrator` creates these
 *     schemas itself while running migrations and migration 0008
 *     transfers them directly), transfers ownership of the `krypto`
 *     schema and its objects to `krypto_schema_owner`, and the `drizzle`
 *     migration ledger to `krypto_migrator` -- both guarded to be a
 *     no-op if the schema does not exist yet or is already owned by the
 *     target role.
 *   - Defensively revokes `krypto_runtime`'s access to any Supabase-
 *     legacy `vault`/`cron`/`net`/`pg_net` schema, only if present.
 *
 * Every step fails closed: an unexpected condition (a missing
 * `MIGRATION_URL`/`DIRECT_URL`, an unsafe role or connection-limit
 * value, an ownership-transfer prerequisite that does not hold) throws
 * rather than silently skipping or falling back.
 */
export async function bootstrapDatabaseRoles(
  input: BootstrapDatabaseRolesInput,
): Promise<BootstrapDatabaseRolesResult> {
  const directUrl = input.directUrl?.trim();
  const migratorPassword = input.migratorPassword;

  if (!directUrl) {
    throw new Error(
      "DIRECT_URL is required to bootstrap the database role hierarchy.",
    );
  }
  if (!migratorPassword) {
    throw new Error(
      "A migrator password is required (--migrator-password or " +
        `KRYPTO_MIGRATOR_LOGIN_PASSWORD) to create or rotate ` +
        `${MIGRATOR_ROLE_NAME}'s credential. This script never ` +
        "fabricates or infers a password.",
    );
  }

  const schemaOwnerConnectionLimit =
    input.schemaOwnerConnectionLimit ?? DEFAULT_SCHEMA_OWNER_CONNECTION_LIMIT;
  const schedulerConnectionLimit =
    input.schedulerConnectionLimit ?? DEFAULT_SCHEDULER_CONNECTION_LIMIT;
  const runtimeConnectionLimit =
    input.runtimeConnectionLimit ?? DEFAULT_RUNTIME_CONNECTION_LIMIT;
  const migratorConnectionLimit =
    input.migratorConnectionLimit ?? DEFAULT_MIGRATOR_CONNECTION_LIMIT;
  for (const [roleName, connectionLimit] of [
    [SCHEMA_OWNER_ROLE_NAME, schemaOwnerConnectionLimit],
    [SCHEDULER_ROLE_NAME, schedulerConnectionLimit],
    [RUNTIME_ROLE_NAME, runtimeConnectionLimit],
    [MIGRATOR_ROLE_NAME, migratorConnectionLimit],
  ] as const) {
    if (!isSafeConnectionLimit(connectionLimit)) {
      throw new Error(
        `Refusing an unsafe connection limit for ${roleName}: ${connectionLimit}`,
      );
    }
  }

  const sql = postgres(directUrl, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    // This CLI's only output contract is a single redacted JSON report on
    // stdout; a default NOTICE (e.g. "role already exists, skipping")
    // would otherwise interleave with and corrupt that JSON.
    onnotice: () => {},
  });

  try {
    const [adminRow] = await sql<Array<{ adminRole: string }>>`
      SELECT current_user AS "adminRole"
    `;
    const adminRole = adminRow.adminRole;
    if (!isValidRoleIdentifier(adminRole)) {
      throw new Error(
        `Refusing to bootstrap: the connecting admin identity (${adminRole}) ` +
          "is not a safe role identifier.",
      );
    }

    await sql`ALTER ROLE ${sql(adminRole)} SET search_path TO pg_catalog`;

    const schemaOwnerCreated = await createOrConvergeNoLoginRole(
      sql,
      SCHEMA_OWNER_ROLE_NAME,
      schemaOwnerConnectionLimit,
    );
    const schedulerCreated = await createOrConvergeNoLoginRole(
      sql,
      SCHEDULER_ROLE_NAME,
      schedulerConnectionLimit,
    );
    const runtimeCreated = await createOrConvergeNoLoginRole(
      sql,
      RUNTIME_ROLE_NAME,
      runtimeConnectionLimit,
    );
    await sql`ALTER ROLE ${sql(SCHEMA_OWNER_ROLE_NAME)} SET search_path TO pg_catalog`;
    await sql`ALTER ROLE ${sql(SCHEDULER_ROLE_NAME)} SET search_path TO pg_catalog`;
    await sql`ALTER ROLE ${sql(RUNTIME_ROLE_NAME)} SET search_path TO krypto, pg_catalog`;

    const [existingMigratorRow] = await sql<Array<{ present: boolean }>>`
      SELECT true AS present FROM pg_roles WHERE rolname = ${MIGRATOR_ROLE_NAME}
    `;
    const migratorExisted = existingMigratorRow?.present ?? false;

    // See bootstrapRuntimeLoginRole's doc comment for exactly why the
    // password and role name are threaded through transaction-local
    // set_config(..., true) session settings rather than interpolated
    // into the query text: neither ever appears in migration history,
    // this script's output, or logs of the query text.
    await sql`BEGIN`;
    try {
      await sql`SELECT set_config(${BOOTSTRAP_MIGRATOR_PASSWORD_GUC}, ${migratorPassword}, true)`;
      await sql.unsafe(`
        DO $$
        DECLARE
          pwd text := current_setting('${BOOTSTRAP_MIGRATOR_PASSWORD_GUC}', true);
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${MIGRATOR_ROLE_NAME}') THEN
            EXECUTE format(
              'ALTER ROLE %I WITH LOGIN NOINHERIT PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT %s',
              '${MIGRATOR_ROLE_NAME}', pwd, ${migratorConnectionLimit}
            );
          ELSE
            EXECUTE format(
              'CREATE ROLE %I WITH LOGIN NOINHERIT PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT %s',
              '${MIGRATOR_ROLE_NAME}', pwd, ${migratorConnectionLimit}
            );
          END IF;
        END
        $$;
      `);
      await sql`COMMIT`;
    } catch (error) {
      await sql`ROLLBACK`;
      throw error;
    }

    const [migratorFinalRow] = await sql<
      Array<{
        canLogin: boolean;
        inherits: boolean;
        isSuperuser: boolean;
        canCreateDb: boolean;
        canCreateRole: boolean;
        canReplicate: boolean;
        canBypassRls: boolean;
      }>
    >`
      SELECT
        rolcanlogin AS "canLogin",
        rolinherit AS "inherits",
        rolsuper AS "isSuperuser",
        rolcreatedb AS "canCreateDb",
        rolcreaterole AS "canCreateRole",
        rolreplication AS "canReplicate",
        rolbypassrls AS "canBypassRls"
      FROM pg_roles
      WHERE rolname = ${MIGRATOR_ROLE_NAME}
    `;
    const migratorAttributesSafe =
      !!migratorFinalRow &&
      migratorFinalRow.canLogin &&
      !migratorFinalRow.inherits &&
      !migratorFinalRow.isSuperuser &&
      !migratorFinalRow.canCreateDb &&
      !migratorFinalRow.canCreateRole &&
      !migratorFinalRow.canReplicate &&
      !migratorFinalRow.canBypassRls;

    if (!migratorAttributesSafe) {
      throw new Error(
        `Post-bootstrap verification failed: ${MIGRATOR_ROLE_NAME} does not have ` +
          "the expected LOGIN, NOINHERIT, least-privilege attributes.",
      );
    }
    await sql`ALTER ROLE ${sql(MIGRATOR_ROLE_NAME)} SET search_path TO pg_catalog`;

    // krypto_migrator must be able to CREATE SCHEMA "krypto" and
    // "drizzle" (migrations 0000/0002 on a fresh install) and CREATE
    // TABLE directly in "public" (migration 0000, before migration 0002
    // moves those tables into "krypto"). Neither is possible for a
    // non-owner role without an explicit database-level CREATE grant --
    // this is a pre-existing PostgreSQL requirement independent of the
    // PostgreSQL 15+ change that additionally revokes CREATE on the
    // "public" *schema* from PUBLIC by default. Harmless and idempotent
    // to (re-)grant on every bootstrap, including on an upgrade where
    // migration 0000 has already run and the schemas already exist.
    const [{ databaseName }] = await sql<Array<{ databaseName: string }>>`
      SELECT current_database() AS "databaseName"
    `;
    const [bootstrapSchemaState] = await sql<
      Array<{ kryptoPresent: boolean; drizzlePresent: boolean }>
    >`
      SELECT
        to_regnamespace(${APP_SCHEMA_NAME}) IS NOT NULL AS "kryptoPresent",
        to_regnamespace(${MIGRATION_LEDGER_SCHEMA_NAME}) IS NOT NULL AS "drizzlePresent"
    `;
    const freshInstallBootstrap =
      !bootstrapSchemaState?.kryptoPresent ||
      !bootstrapSchemaState?.drizzlePresent;
    // drizzle-kit executes CREATE SCHEMA IF NOT EXISTS for its ledger on every
    // migrate invocation, and PostgreSQL checks database CREATE even when the
    // schema already exists. This is therefore a required migrator privilege,
    // not a temporary bootstrap grant.
    await sql`GRANT CREATE ON DATABASE ${sql(databaseName)} TO ${sql(MIGRATOR_ROLE_NAME)}`;
    if (freshInstallBootstrap) {
      await sql`GRANT CREATE, USAGE ON SCHEMA public TO ${sql(MIGRATOR_ROLE_NAME)}`;
    } else {
      await sql`REVOKE ALL ON SCHEMA public FROM PUBLIC`;
      await sql`REVOKE ALL ON SCHEMA public FROM ${sql(RUNTIME_ROLE_NAME)}`;
      await sql`REVOKE ALL ON SCHEMA public FROM ${sql(MIGRATOR_ROLE_NAME)}`;
      await sql`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC`;
      await sql`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${sql(RUNTIME_ROLE_NAME)}`;
      await sql`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC`;
      await sql`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${sql(RUNTIME_ROLE_NAME)}`;
      await sql`REVOKE EXECUTE ON ALL ROUTINES IN SCHEMA public FROM PUBLIC`;
      await sql`REVOKE EXECUTE ON ALL ROUTINES IN SCHEMA public FROM ${sql(RUNTIME_ROLE_NAME)}`;
    }

    // krypto_migrator's only path to krypto_schema_owner's privileges is
    // an explicit SET ROLE -- never automatic inheritance.
    await sql`GRANT ${sql(SCHEMA_OWNER_ROLE_NAME)} TO ${sql(MIGRATOR_ROLE_NAME)} WITH INHERIT FALSE, SET TRUE`;

    // Grant the admin identity itself SET-only membership in both
    // targets, exactly long enough to perform the ownership transfers
    // below on an upgrade.
    await sql`GRANT ${sql(SCHEMA_OWNER_ROLE_NAME)} TO ${sql(adminRole)} WITH INHERIT FALSE, SET TRUE`;
    await sql`GRANT ${sql(MIGRATOR_ROLE_NAME)} TO ${sql(adminRole)} WITH INHERIT FALSE, SET TRUE`;

    const appSchemaOwnershipTransferred = await transferSchemaOwnershipIfNeeded(
      sql,
      APP_SCHEMA_NAME,
      SCHEMA_OWNER_ROLE_NAME,
    );
    const migrationLedgerOwnershipTransferred =
      await transferSchemaOwnershipIfNeeded(
        sql,
        MIGRATION_LEDGER_SCHEMA_NAME,
        MIGRATOR_ROLE_NAME,
      );

    const legacySchemasRevoked: string[] = [];
    for (const schemaName of LEGACY_UNRELATED_SCHEMAS) {
      const revoked = await revokeRuntimeAccessToLegacySchemaIfPresent(
        sql,
        schemaName,
      );
      if (revoked) {
        legacySchemasRevoked.push(schemaName);
      }
    }

    // Defense in depth: krypto_runtime must never be a member of any of
    // the three elevated roles. Each REVOKE below is a no-op (a
    // PostgreSQL WARNING, not an error) if the membership was never
    // granted. This requires ADMIN OPTION on the target role, which
    // krypto_migrator never holds by design -- only the admin identity
    // (via CREATEROLE) can do this, which is why it lives here rather
    // than in migration 0008.
    await sql`REVOKE ${sql(SCHEMA_OWNER_ROLE_NAME)} FROM ${sql(RUNTIME_ROLE_NAME)}`;
    await sql`REVOKE ${sql(MIGRATOR_ROLE_NAME)} FROM ${sql(RUNTIME_ROLE_NAME)}`;
    await sql`REVOKE ${sql(SCHEDULER_ROLE_NAME)} FROM ${sql(RUNTIME_ROLE_NAME)}`;
    await sql`REVOKE ${sql(SCHEMA_OWNER_ROLE_NAME)} FROM ${sql(adminRole)}`;
    await sql`REVOKE ${sql(MIGRATOR_ROLE_NAME)} FROM ${sql(adminRole)}`;

    return {
      adminRole,
      schemaOwnerRole: SCHEMA_OWNER_ROLE_NAME,
      migratorRole: MIGRATOR_ROLE_NAME,
      schedulerRole: SCHEDULER_ROLE_NAME,
      runtimeRole: RUNTIME_ROLE_NAME,
      schemaOwnerCreated,
      schedulerCreated,
      runtimeCreated,
      migratorExisted,
      migratorCreated: !migratorExisted,
      migratorPasswordRotated: migratorExisted,
      migratorAttributesSafe,
      appSchemaOwnershipTransferred,
      migrationLedgerOwnershipTransferred,
      legacySchemasRevoked,
    };
  } finally {
    await sql.end();
  }
}
