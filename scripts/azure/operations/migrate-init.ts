import { runCli } from "../lib/run-cli";
import type { AzureOperationContext, AzureOperationResult } from "./types";

const REQUIRED_ENV_NAMES = [
  "DIRECT_URL",
  "MIGRATION_URL",
  "DATABASE_URL",
  "KRYPTO_MIGRATOR_LOGIN_PASSWORD",
  "AZURE_RUNTIME_LOGIN_ROLE",
  "AZURE_RUNTIME_LOGIN_PASSWORD",
] as const;

/**
 * Runs the protected database-role bootstrap, the reviewed migration,
 * runtime-login-role bootstrap, and one-time paper-account initialization
 * commands, in that exact order, and emits a small success JSON:
 *
 *   1. `npx tsx scripts/bootstrap-azure-runtime-role.ts --mode database-roles`
 *      against `DIRECT_URL` -- the *only* step authenticated as the
 *      admin/operator identity. Idempotently creates or rotates the
 *      NOLOGIN `krypto_schema_owner`, `krypto_scheduler`, and
 *      `krypto_runtime` roles and the LOGIN `krypto_migrator` role (with
 *      `KRYPTO_MIGRATOR_LOGIN_PASSWORD`); on an upgrade from a
 *      pre-existing deployment, also transfers ownership of the existing
 *      `krypto` schema/objects and `drizzle` migration ledger so
 *      migration 0008 (running as krypto_migrator, which deliberately
 *      lacks CREATEROLE and role-membership authority) never needs
 *      elevated privileges of its own. See
 *      src/deployment/bootstrap-runtime-role.ts (`bootstrapDatabaseRoles`)
 *      and drizzle/0008_postgresql_trust_boundaries.sql for the full
 *      trust-boundary design (GitHub issue #133).
 *   2. `drizzle-kit migrate` against `MIGRATION_URL` -- applies reviewed
 *      migration history as the dedicated, least-privilege
 *      `krypto_migrator` role, never as the admin/operator role and never
 *      through the DATABASE_URL runtime connection.
 *   3. The database-role bootstrap runs a second time after migration. On a
 *      fresh install the now-present krypto/drizzle schemas cause it to revoke
 *      the migrator's temporary public-schema CREATE grant and remove the
 *      admin's temporary SET-role memberships. On upgrade those privileges
 *      were never needed and remain absent. Database CREATE remains because
 *      drizzle-kit checks it for CREATE SCHEMA IF NOT EXISTS on every run.
 *   4. `npx tsx scripts/bootstrap-azure-runtime-role.ts` -- creates (or
 *      safely rotates the password of) the environment-specific Azure
 *      runtime login role and grants it `krypto_runtime` membership. This
 *      step is genuinely environment-specific (the login role name and
 *      credential are not reviewed migration content) and requires
 *      DIRECT_URL, DATABASE_URL, AZURE_RUNTIME_LOGIN_ROLE, and
 *      AZURE_RUNTIME_LOGIN_PASSWORD -- all required env vars are
 *      validated up front, before any command runs, so a
 *      partially-configured environment fails closed instead of silently
 *      skipping a bootstrap step. A failure here is reported under the
 *      distinct `runtime-login-bootstrap` step so it is never confused
 *      with a role-bootstrap, migration, or seed failure.
 *   5. `npx tsx scripts/seed.ts` against `MIGRATION_URL`, with an explicit
 *      `SET ROLE krypto_schema_owner`, for one-time paper-account
 *      initialization. It never uses the runtime or server-admin identity.
 *
 * All five underlying commands are idempotent (role bootstrap, Drizzle
 * migration history, privilege finalization, runtime-login bootstrap, and an
 * `onConflictDoNothing` singleton insert), so a repeat run on an already-
 * initialized environment still reports success.
 *
 * Both the migrator and runtime login passwords are passed to the
 * bootstrap CLIs only via `process.env` (inherited by the child process);
 * neither is ever included in argv, never logged, and never included in
 * this operation's report. Command stderr is likewise never included in
 * the report or logged -- only the failing step name and exit code are
 * recorded.
 */
export async function run(
  context: AzureOperationContext,
): Promise<AzureOperationResult> {
  for (const name of REQUIRED_ENV_NAMES) {
    if (!process.env[name]) {
      throw new Error(`${name} is required for the migrate-init operation.`);
    }
  }

  const databaseRolesBootstrap = await runCli(
    "npx",
    ["tsx", "scripts/bootstrap-azure-runtime-role.ts", "--mode", "database-roles"],
    process.env,
  );
  if (databaseRolesBootstrap.exitCode !== 0) {
    return {
      passed: false,
      report: {
        operation: "migrate-init",
        success: false,
        step: "database-roles-bootstrap",
        environmentName: context.environmentName,
        releaseSha: context.releaseSha,
        exitCode: databaseRolesBootstrap.exitCode,
      },
    };
  }

  const migrate = await runCli(
    "npx",
    ["drizzle-kit", "migrate"],
    process.env,
  );
  if (migrate.exitCode !== 0) {
    return {
      passed: false,
      report: {
        operation: "migrate-init",
        success: false,
        step: "migrate",
        environmentName: context.environmentName,
        releaseSha: context.releaseSha,
        exitCode: migrate.exitCode,
      },
    };
  }

  const databaseRolesFinalize = await runCli(
    "npx",
    ["tsx", "scripts/bootstrap-azure-runtime-role.ts", "--mode", "database-roles"],
    process.env,
  );
  if (databaseRolesFinalize.exitCode !== 0) {
    return {
      passed: false,
      report: {
        operation: "migrate-init",
        success: false,
        step: "database-roles-finalize",
        environmentName: context.environmentName,
        releaseSha: context.releaseSha,
        exitCode: databaseRolesFinalize.exitCode,
      },
    };
  }

  const runtimeLoginBootstrap = await runCli(
    "npx",
    ["tsx", "scripts/bootstrap-azure-runtime-role.ts"],
    process.env,
  );
  if (runtimeLoginBootstrap.exitCode !== 0) {
    return {
      passed: false,
      report: {
        operation: "migrate-init",
        success: false,
        step: "runtime-login-bootstrap",
        environmentName: context.environmentName,
        releaseSha: context.releaseSha,
        exitCode: runtimeLoginBootstrap.exitCode,
      },
    };
  }

  const init = await runCli("npx", ["tsx", "scripts/seed.ts"], process.env);
  if (init.exitCode !== 0) {
    return {
      passed: false,
      report: {
        operation: "migrate-init",
        success: false,
        step: "init",
        environmentName: context.environmentName,
        releaseSha: context.releaseSha,
        exitCode: init.exitCode,
      },
    };
  }

  return {
    passed: true,
    report: {
      operation: "migrate-init",
      success: true,
      databaseRolesBootstrapped: true,
      migrated: true,
      runtimeLoginBootstrapped: true,
      initialized: true,
      environmentName: context.environmentName,
      releaseSha: context.releaseSha,
    },
  };
}
