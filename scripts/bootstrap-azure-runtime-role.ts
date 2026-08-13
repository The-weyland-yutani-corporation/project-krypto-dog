import "dotenv/config";
import {
  bootstrapRuntimeLoginRole,
  bootstrapRuntimeRoleMembership,
} from "../src/deployment/bootstrap-runtime-role";

/**
 * Narrowly-scoped CLI for the Azure PostgreSQL safety transition, wrapping
 * the two bootstrap actions in ../src/deployment/bootstrap-runtime-role.ts
 * against the pre-existing, least-privilege `krypto_runtime` NOLOGIN group
 * role created by drizzle/0007_azure_retire_supabase_http_functions.sql.
 *
 * Primary Azure path — password-based login role bootstrap:
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
 * Membership-only path (no password) — for a login role whose credential
 * is already provisioned by another means (for example, a managed-identity
 * / Azure AD principal that authenticates without a static password):
 *   npx tsx scripts/bootstrap-azure-runtime-role.ts --login-role azure_app_identity
 *
 *   Used automatically whenever no login password is supplied by either
 *   --login-password or AZURE_RUNTIME_LOGIN_PASSWORD. This never creates a
 *   login role and never reads, sets, or stores a password.
 *
 * DIRECT_URL supplies the admin/migration connection string (same
 * convention as scripts/deployment-preflight.ts) in both paths; the
 * password path additionally requires DATABASE_URL so its username can be
 * proven to match the target login role before anything is created or
 * altered.
 */

interface ParsedArguments {
  loginRole: string | undefined;
  loginPassword: string | undefined;
}

function parseArguments(argv: string[]): ParsedArguments {
  let loginRole: string | undefined;
  let loginPassword: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
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
    throw new Error(`Unknown argument: ${argument}`);
  }
  return { loginRole, loginPassword };
}

async function main(): Promise<void> {
  const { loginRole: argLoginRole, loginPassword: argLoginPassword } =
    parseArguments(process.argv.slice(2));
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
