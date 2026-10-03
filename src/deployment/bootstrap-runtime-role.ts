import postgres from "postgres";

/**
 * Narrowly-scoped, idempotent bootstrap for the Azure PostgreSQL safety
 * transition (see drizzle/0007_azure_retire_supabase_http_functions.sql
 * and specs/governance.md).
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

    const [loginRoleRow] = await sql<Array<{ present: boolean }>>`
      SELECT true AS present
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

    const [membershipRow] = await sql<Array<{ isMember: boolean }>>`
      SELECT pg_has_role(${loginRole}, ${RUNTIME_ROLE_NAME}, 'MEMBER')
        AS "isMember"
    `;
    const alreadyMember = membershipRow?.isMember ?? false;

    if (!alreadyMember) {
      await sql`GRANT ${sql(RUNTIME_ROLE_NAME)} TO ${sql(loginRole)}`;
    }

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
              'ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
              target_role, pwd
            );
          ELSE
            EXECUTE format(
              'CREATE ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
              target_role, pwd
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
        isSuperuser: boolean;
        canCreateDb: boolean;
        canCreateRole: boolean;
        canReplicate: boolean;
        canBypassRls: boolean;
      }>
    >`
      SELECT
        rolcanlogin AS "canLogin",
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
      !finalRow.isSuperuser &&
      !finalRow.canCreateDb &&
      !finalRow.canCreateRole &&
      !finalRow.canReplicate &&
      !finalRow.canBypassRls;

    if (!loginRoleAttributesSafe) {
      throw new Error(
        `Post-bootstrap verification failed: ${loginRole} does not have ` +
          "the expected least-privilege LOGIN attributes (non-superuser, " +
          "non-createdb, non-createrole, non-replication, non-bypassrls).",
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
