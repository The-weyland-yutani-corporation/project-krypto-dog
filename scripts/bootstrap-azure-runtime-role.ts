import "dotenv/config";
import {
  bootstrapDatabaseRoles,
  bootstrapRuntimeLoginRole,
  bootstrapRuntimeRoleMembership,
} from "../src/deployment/bootstrap-runtime-role";

/**
 * Generalized CLI for the Azure PostgreSQL trust-boundary bootstrap (see
 * GitHub issue #133), wrapping the bootstrap actions in
 * ../src/deployment/bootstrap-runtime-role.ts.
 *
 * Two modes, selected by `--mode` (or MIGRATE_INIT_BOOTSTRAP_MODE):
 *
 * `--mode runtime-login` (default, preserves the pre-existing behavior) —
 * password-based or membership-only bootstrap of the environment-specific
 * Azure runtime *login* role against the pre-existing, least-privilege
 * `krypto_runtime` NOLOGIN group role created by
 * drizzle/0007_azure_retire_supabase_http_functions.sql:
 *
 *   npx tsx scripts/bootstrap-azure-runtime-role.ts \
 *     --login-role azure_app_identity --login-password "$AZURE_RUNTIME_LOGIN_PASSWORD"
 *
 *   Requires both AZURE_RUNTIME_LOGIN_ROLE (or --login-role) and
 *   AZURE_RUNTIME_LOGIN_PASSWORD (or --login-password) plus DATABASE_URL
 *   and DIRECT_URL. Creates the LOGIN role if it does not yet exist, or
 *   safely rotates its password if it does; verifies the resulting role is
 *   non-superuser/non-createdb/non-createrole/non-replication/
 *   non-bypassrls; and grants krypto_runtime membership. The password is
 *   read only from this process's argv/env, never logged, never returned
 *   in the result, and never embedded in migration history — see the doc
 *   comment on bootstrapRuntimeLoginRole for exactly how it is applied
 *   server-side without being interpolated into SQL text.
 *
 *   Membership-only path (no password) — for a login role whose credential
 *   is already provisioned by another means (for example, a
 *   managed-identity / Azure AD principal that authenticates without a
 *   static password):
 *     npx tsx scripts/bootstrap-azure-runtime-role.ts --login-role azure_app_identity
 *
 *   Used automatically whenever no login password is supplied by either
 *   --login-password or AZURE_RUNTIME_LOGIN_PASSWORD. This never creates a
 *   login role and never reads, sets, or stores a password.
 *
 * `--mode database-roles` — the protected, admin/DIRECT_URL-only bootstrap
 * of the full trust-boundary role hierarchy (`krypto_schema_owner`,
 * `krypto_migrator`, `krypto_scheduler`, `krypto_runtime`) and, on an
 * upgrade from a pre-existing deployment, the one-time ownership transfer
 * of the `krypto` schema/objects and `drizzle` migration ledger. This mode
 * must run before `drizzle-kit migrate` (see
 * scripts/azure/operations/migrate-init.ts):
 *
 *   npx tsx scripts/bootstrap-azure-runtime-role.ts --mode database-roles
 *
 *   Requires DIRECT_URL and KRYPTO_MIGRATOR_LOGIN_PASSWORD (or
 *   --migrator-password). An optional --migrator-connection-limit
 *   overrides the default connection limit applied to krypto_migrator.
 *   The migrator password is read only from argv/env, never logged, and
 *   never returned in the result.
 *
 * DIRECT_URL supplies the admin/migration connection string (same
 * convention as scripts/deployment-preflight.ts) in every mode; the
 * runtime-login password path additionally requires DATABASE_URL so its
 * username can be proven to match the target login role before anything
 * is created or altered.
 */

interface ParsedArguments {
  mode: "runtime-login" | "database-roles";
  loginRole: string | undefined;
  loginPassword: string | undefined;
  migratorPassword: string | undefined;
  migratorConnectionLimit: number | undefined;
}

function parseArguments(argv: string[]): ParsedArguments {
  let mode: "runtime-login" | "database-roles" | undefined;
  let loginRole: string | undefined;
  let loginPassword: string | undefined;
  let migratorPassword: string | undefined;
  let migratorConnectionLimit: number | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--mode") {
      const value = argv[index + 1];
      if (value !== "runtime-login" && value !== "database-roles") {
        throw new Error(
          '--mode must be "runtime-login" or "database-roles"',
        );
      }
      if (mode !== undefined) {
        throw new Error("--mode may be provided only once");
      }
      mode = value;
      index += 1;
      continue;
    }
    if (argument === "--login-role") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--login-role requires a value");
      }
      if (loginRole !== undefined) {
        throw new Error("--login-role may be provided only once");
      }
      loginRole = value;
      index += 1;
      continue;
    }
    if (argument === "--login-password") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--login-password requires a value");
      }
      if (loginPassword !== undefined) {
        throw new Error("--login-password may be provided only once");
      }
      loginPassword = value;
      index += 1;
      continue;
    }
    if (argument === "--migrator-password") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--migrator-password requires a value");
      }
      if (migratorPassword !== undefined) {
        throw new Error("--migrator-password may be provided only once");
      }
      migratorPassword = value;
      index += 1;
      continue;
    }
    if (argument === "--migrator-connection-limit") {
      const value = argv[index + 1];
      if (value === undefined || !/^-?\d+$/.test(value)) {
        throw new Error(
          "--migrator-connection-limit requires an integer value",
        );
      }
      if (migratorConnectionLimit !== undefined) {
        throw new Error(
          "--migrator-connection-limit may be provided only once",
        );
      }
      migratorConnectionLimit = Number.parseInt(value, 10);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return {
    mode: mode ?? "runtime-login",
    loginRole,
    loginPassword,
    migratorPassword,
    migratorConnectionLimit,
  };
}

async function main(): Promise<void> {
  const {
    mode,
    loginRole: argLoginRole,
    loginPassword: argLoginPassword,
    migratorPassword: argMigratorPassword,
    migratorConnectionLimit,
  } = parseArguments(process.argv.slice(2));

  if (mode === "database-roles") {
    const migratorPassword =
      argMigratorPassword ?? process.env.KRYPTO_MIGRATOR_LOGIN_PASSWORD;
    const result = await bootstrapDatabaseRoles({
      directUrl: process.env.DIRECT_URL,
      migratorPassword,
      migratorConnectionLimit,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const loginRole = argLoginRole ?? process.env.AZURE_RUNTIME_LOGIN_ROLE;
  const loginPassword =
    argLoginPassword ?? process.env.AZURE_RUNTIME_LOGIN_PASSWORD;

  // Explicit, no silent fallback: a password supplied without DATABASE_URL
  // (or vice versa) is a misconfiguration, not a signal to quietly demote
  // to the membership-only path.
  if (loginPassword && !process.env.DATABASE_URL) {
    throw new Error(
      "A login password was supplied (--login-password or " +
        "AZURE_RUNTIME_LOGIN_PASSWORD) but DATABASE_URL is not set. " +
        "DATABASE_URL is required so its username can be proven to match " +
        "the target login role before the password bootstrap runs.",
    );
  }

  const result = loginPassword
    ? await bootstrapRuntimeLoginRole({
        directUrl: process.env.DIRECT_URL,
        runtimeUrl: process.env.DATABASE_URL,
        loginRole,
        loginPassword,
      })
    : await bootstrapRuntimeRoleMembership({
        directUrl: process.env.DIRECT_URL,
        loginRole,
      });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      error:
        error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: "unknown", message: String(error) },
    }),
  );
  process.exitCode = 1;
});
