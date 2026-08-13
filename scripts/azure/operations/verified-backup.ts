import { join } from "node:path";

import { runCli } from "../lib/run-cli";
import { startScratchPostgres } from "../lib/scratch-postgres";
import type { AzureOperationContext, AzureOperationResult } from "./types";

/**
 * Starts a scratch, loopback-only PostgreSQL 17 server, runs the existing,
 * reviewed `deployment:backup` command against it via
 * `--restore-test-url`, and requires `restoreVerification.matched === true`
 * before reporting success. The scratch server is always stopped and its
 * data directory always removed, whether verification passes or fails.
 */
export async function run(
  context: AzureOperationContext,
): Promise<AzureOperationResult> {
  if (!process.env.DIRECT_URL || !process.env.DATABASE_URL) {
    throw new Error(
      "DIRECT_URL and DATABASE_URL are required for the verified-backup operation.",
    );
  }

  const scratch = await startScratchPostgres();
  try {
    const backupDirectory = join(context.reportDirectory, "backup");
    const result = await runCli(
      "npx",
      [
        "tsx",
        "scripts/create-verified-backup.ts",
        "--out",
        backupDirectory,
        "--restore-test-url",
        scratch.url,
      ],
      process.env,
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `deployment:backup failed with exit code ${result.exitCode}: ${result.stderr
          .trim()
          .split("\n")
          .slice(-3)
          .join(" ")}`,
      );
    }

    let manifest: unknown;
    try {
      manifest = JSON.parse(result.stdout);
    } catch {
      throw new Error("deployment:backup did not return parseable JSON.");
    }

    const restoreVerification =
      manifest !== null && typeof manifest === "object"
        ? (manifest as Record<string, unknown>).restoreVerification
        : null;
    const matched =
      restoreVerification !== null &&
      typeof restoreVerification === "object" &&
      (restoreVerification as Record<string, unknown>).matched === true;
    if (!matched) {
      throw new Error(
        "Backup restore verification did not report matched=true.",
      );
    }

    return {
      passed: true,
      report: {
        operation: "verified-backup",
        environmentName: context.environmentName,
        releaseSha: context.releaseSha,
        manifest,
      },
    };
  } finally {
    await scratch.stop();
  }
}
