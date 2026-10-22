import "dotenv/config";

import { mkdir, open, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { validateReleaseSha } from "@/deployment/target-smoke";

import { uploadEvidence } from "./lib/evidence-upload";
import {
  deriveEvidenceDestinationPrefix,
  deriveReportDirectory,
  validateEnvironmentName,
  validateJobExecutionId,
  validateOperation,
  type AzureOperation,
} from "./lib/report-path";
import * as activationCheck from "./operations/activation-check";
import * as deploymentAdmission from "./operations/deployment-admission";
import * as migrateInit from "./operations/migrate-init";
import * as preflight from "./operations/preflight";
import type {
  AzureOperationContext,
  AzureOperationResult,
} from "./operations/types";
import * as targetSmoke from "./operations/target-smoke";
import * as verifiedBackup from "./operations/verified-backup";

/**
 * Strict Azure ops job entrypoint. OPERATION is dispatched through an
 * explicit case/enum below -- never `eval`, never a dynamically built
 * `import()` path, and never an arbitrary shell command. Every operation
 * module receives only a validated, immutable context.
 */
async function dispatch(
  operation: AzureOperation,
  context: AzureOperationContext,
): Promise<AzureOperationResult> {
  switch (operation) {
    case "migrate-init":
      return migrateInit.run(context);
    case "preflight":
      return preflight.run(context);
    case "verified-backup":
      return verifiedBackup.run(context);
    case "target-smoke":
      return targetSmoke.run(context);
    case "activation-check":
      return activationCheck.run(context);
    case "deployment-admission":
      return deploymentAdmission.run(context);
    /* istanbul ignore next -- exhaustiveness guard, unreachable after validateOperation */
    default: {
      const exhaustive: never = operation;
      throw new Error(`Unhandled operation: ${String(exhaustive)}`);
    }
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

async function main(): Promise<void> {
  const environmentName = validateEnvironmentName(
    requireEnv("ENVIRONMENT_NAME"),
  );
  const releaseSha = validateReleaseSha(requireEnv("RELEASE_SHA"));
  const operation = validateOperation(requireEnv("OPERATION"));
  const jobExecutionId = validateJobExecutionId(
    requireEnv("JOB_EXECUTION_ID"),
  );
  // Required upfront (fail fast) so a passing operation is never left
  // without an evidence destination after the fact.
  const evidenceContainerUrl = requireEnv("EVIDENCE_CONTAINER_URL");
  // Ops jobs run with a user-assigned managed identity only (no
  // system-assigned identity exists), so the identity's client ID must be
  // present up front too -- deep GUID-format validation happens inside
  // uploadEvidence, mirroring how EVIDENCE_CONTAINER_URL's own format is
  // validated there.
  const msiClientId = requireEnv("AZCOPY_MSI_CLIENT_ID");

  const reportDirectory = deriveReportDirectory({
    environmentName,
    releaseSha,
    operation,
    jobExecutionId,
    baseDirectory: process.env.REPORTS_BASE_DIR,
  });
  await mkdir(reportDirectory, { recursive: true });
  const reportPath = join(reportDirectory, "report.json");
  // Reserve the path so this immutable, per-execution report can never be
  // silently overwritten by a repeat/duplicate invocation.
  const handle = await open(reportPath, "wx");
  await handle.close();

  const context: AzureOperationContext = {
    environmentName,
    releaseSha,
    jobExecutionId,
    reportDirectory,
  };

  const result = await dispatch(operation, context);
  const json = `${JSON.stringify(result.report, null, 2)}\n`;
  await writeFile(reportPath, json, "utf8");
  process.stdout.write(json);

  // Evidence is uploaded for both pass and fail outcomes -- a failed
  // preflight/smoke/etc. report is an audit record and must never vanish
  // with the ephemeral local report directory. The report content itself
  // (result.report / result.passed) is what distinguishes pass from
  // fail; the upload path and destination prefix are identical either
  // way. The entire per-execution report directory (including any
  // nested backup archive/checksum files) is uploaded recursively to a
  // validated, immutable destination prefix -- never just the root
  // report.json, which would otherwise collide across executions and
  // drop the backup evidence.
  const destinationPrefix = deriveEvidenceDestinationPrefix({
    environmentName,
    releaseSha,
    operation,
    jobExecutionId,
  });
  await uploadEvidence({
    reportDirectory,
    containerUrl: evidenceContainerUrl,
    destinationPrefix,
    msiClientId,
  });

  // A failed operation is never reported as success-shaped: exitCode is
  // set to a nonzero, distinct value (2) only *after* its failure
  // evidence has been durably uploaded. If the upload itself throws
  // (network/auth/azcopy failure), that propagates to main().catch below
  // and is preserved as a hard failure (exitCode 1) -- never silently
  // swallowed, and the process never exits 0 for a failed operation
  // regardless of what happens to the upload.
  if (!result.passed) {
    process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Azure ops job failed: ${message}\n`);
  process.exitCode = 1;
});
