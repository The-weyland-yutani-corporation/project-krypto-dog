import { inspectEmptyDatabase } from "@/deployment/database-inspection";
import { validateImageDigest } from "@/deployment/target-smoke";

import { validateJobExecutionId } from "../lib/report-path";
import type { AzureOperationContext, AzureOperationResult } from "./types";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for database inspection.`);
  return value;
}

export async function run(
  context: AzureOperationContext,
): Promise<AzureOperationResult> {
  const imageDigest = validateImageDigest(requireEnv("OPS_IMAGE_DIGEST"));
  const azureExecutionName = validateJobExecutionId(
    requireEnv("CONTAINER_APP_JOB_EXECUTION_NAME"),
  );
  const expectedHost = requireEnv("DATABASE_INSPECTION_HOST");
  const expectedDatabase = requireEnv("DATABASE_INSPECTION_NAME");
  const runtimeLoginRole = requireEnv("AZURE_RUNTIME_LOGIN_ROLE");
  const base = {
    schemaVersion: "1.0.0",
    operation: "database-inspection",
    environmentName: context.environmentName,
    releaseSha: context.releaseSha,
    jobExecutionId: context.jobExecutionId,
    azureExecutionName,
    imageDigest,
  };
  try {
    const inspection = await inspectEmptyDatabase({
      directUrl: requireEnv("DIRECT_URL"),
      expectedHost,
      expectedDatabase,
      runtimeLoginRole,
    });
    return {
      passed: inspection.empty,
      report: {
        ...base,
        generatedAt: new Date().toISOString(),
        approved: inspection.empty,
        reason: inspection.empty ? "empty-database" : "existing-database-state",
        inspection,
      },
    };
  } catch {
    // Connection errors can contain credentials. Persist an explicit failure,
    // not raw driver diagnostics or a success-shaped empty catalog.
    return {
      passed: false,
      report: {
        ...base,
        generatedAt: new Date().toISOString(),
        approved: false,
        reason: "database-inspection-failed",
        inspection: null,
      },
    };
  }
}
