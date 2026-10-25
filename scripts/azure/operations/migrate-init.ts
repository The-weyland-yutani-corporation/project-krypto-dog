import { timingSafeEqual } from "node:crypto";

import { inspectEmptyDatabase } from "@/deployment/database-inspection";

import { runCli } from "../lib/run-cli";
import type { AzureOperationContext, AzureOperationResult } from "./types";

const REQUIRED_ENV_NAMES = [
  "DIRECT_URL",
  "DATABASE_URL",
  "AZURE_RUNTIME_LOGIN_ROLE",
  "AZURE_RUNTIME_LOGIN_PASSWORD",
] as const;

/**
 * Runs the reviewed migration, runtime-login-role bootstrap, and one-time
 * paper-account initialization commands, in that exact order, and emits a
 * small success JSON:
 *
 *   1. `drizzle-kit migrate` against `DIRECT_URL` -- applies reviewed
 *      migration history, including the least-privilege `krypto_runtime`
 *      group role created by
 *      drizzle/0007_azure_retire_supabase_http_functions.sql.
 *   2. `npx tsx scripts/bootstrap-azure-runtime-role.ts` -- creates (or
 *      safely rotates the password of) the environment-specific Azure
 *      runtime login role and grants it `krypto_runtime` membership. This
 *      step is genuinely environment-specific (the login role name and
 *      credential are not reviewed migration content) and requires
 *      DIRECT_URL, DATABASE_URL, AZURE_RUNTIME_LOGIN_ROLE, and
 *      AZURE_RUNTIME_LOGIN_PASSWORD -- all four are required up front,
 *      before any command runs, so a partially-configured environment
 *      fails closed instead of silently skipping the bootstrap. A
 *      failure here is reported under the distinct
 *      `runtime-login-bootstrap` step so it is never confused with a
 *      migration or seed failure.
 *   3. `npx tsx scripts/seed.ts` against `DATABASE_URL` -- one-time paper
 *      account initialization.
 *
 * All three underlying commands are idempotent (Drizzle migration
 * history, a safe create-or-rotate role bootstrap, and an
 * `onConflictDoNothing` singleton insert), so a repeat run on an
 * already-initialized environment still reports success on the owned existing-
 * release path. The explicit fresh mode rejects any retained state instead of
 * using idempotency as permission to resume an unknown initialization.
 *
 * The runtime login password is passed to the bootstrap CLI only via
 * `process.env` (inherited by the child process); it is never included
 * in argv, never logged, and never included in this operation's report.
 * Command stderr is likewise never included in the report or logged --
 * only the failing step name and exit code are recorded.
 */
export async function run(
  context: AzureOperationContext,
): Promise<AzureOperationResult> {
  for (const name of REQUIRED_ENV_NAMES) {
    if (!process.env[name]) {
      throw new Error(`${name} is required for the migrate-init operation.`);
    }
  }

  if (process.env.MIGRATION_REQUIRE_EMPTY_DATABASE !== undefined) {
    if (process.env.MIGRATION_REQUIRE_EMPTY_DATABASE !== "true" ||
        context.environmentName !== "prod") {
      throw new Error("Fresh database initialization requires the explicit production admission mode.");
    }
    const failure = (reason: string): AzureOperationResult => ({
      passed: false,
      report: {
        operation: "migrate-init",
        success: false,
        step: "fresh-database-admission",
        environmentName: context.environmentName,
        releaseSha: context.releaseSha,
        reason,
      },
    });
    try {
      const directUrl = process.env.DIRECT_URL;
      const runtimeUrl = process.env.DATABASE_URL;
      const runtimeLoginRole = process.env.AZURE_RUNTIME_LOGIN_ROLE;
      const runtimePassword = process.env.AZURE_RUNTIME_LOGIN_PASSWORD;
      const expectedHost = process.env.DATABASE_INSPECTION_HOST;
      const expectedDatabase = process.env.DATABASE_INSPECTION_NAME;
      if (!directUrl || !runtimeUrl || !runtimeLoginRole || !runtimePassword ||
          !expectedHost || !expectedDatabase) {
        return failure("missing-fresh-database-binding");
      }
      const runtime = new URL(runtimeUrl);
      const suppliedPassword = Buffer.from(decodeURIComponent(runtime.password));
      const expectedPassword = Buffer.from(runtimePassword);
      if (!["postgres:", "postgresql:"].includes(runtime.protocol) ||
          runtime.hostname !== expectedHost ||
          decodeURIComponent(runtime.pathname) !== `/${expectedDatabase}` ||
          decodeURIComponent(runtime.username) !== runtimeLoginRole ||
          (runtime.port !== "" && runtime.port !== "5432") ||
          runtime.hash ||
          !["require", "verify-ca", "verify-full"].includes(runtime.searchParams.get("sslmode") ?? "") ||
          [...runtime.searchParams.keys()].some((name) => name !== "sslmode") ||
          runtime.searchParams.getAll("sslmode").length !== 1 ||
          suppliedPassword.length !== expectedPassword.length ||
          !timingSafeEqual(suppliedPassword, expectedPassword)) {
        return failure("runtime-database-binding-mismatch");
      }
      const inspection = await inspectEmptyDatabase({
        directUrl, expectedHost, expectedDatabase, runtimeLoginRole,
      });
      if (!inspection.empty) return failure("existing-database-state");
    } catch {
      // Driver/URL errors can contain credentials; persist only the fixed failure.
      return failure("database-inspection-failed");
    }
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
      migrated: true,
      runtimeLoginBootstrapped: true,
      initialized: true,
      environmentName: context.environmentName,
      releaseSha: context.releaseSha,
    },
  };
}
