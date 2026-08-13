import { resolve, sep } from "node:path";

import { validateReleaseSha } from "@/deployment/target-smoke";

const ENVIRONMENT_NAME_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const JOB_EXECUTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export const AZURE_OPERATIONS = [
  "migrate-init",
  "preflight",
  "verified-backup",
  "target-smoke",
  "activation-check",
] as const;

export type AzureOperation = (typeof AZURE_OPERATIONS)[number];

export function isAzureOperation(value: string): value is AzureOperation {
  return (AZURE_OPERATIONS as readonly string[]).includes(value);
}

/** Validates a 2-32 char, lowercase alphanumeric/hyphen environment name. */
export function validateEnvironmentName(value: string): string {
  if (!ENVIRONMENT_NAME_PATTERN.test(value)) {
    throw new Error(
      "ENVIRONMENT_NAME must be 2-32 lowercase alphanumeric/hyphen characters, starting with a letter.",
    );
  }
  return value;
}

/** Validates a bounded, path-separator-free job execution identifier. */
export function validateJobExecutionId(value: string): string {
  if (!JOB_EXECUTION_ID_PATTERN.test(value)) {
    throw new Error(
      "JOB_EXECUTION_ID must be 1-64 alphanumeric/dot/dash/underscore characters.",
    );
  }
  return value;
}

/** Validates OPERATION against the explicit, closed operation enum. */
export function validateOperation(value: string): AzureOperation {
  if (!isAzureOperation(value)) {
    throw new Error(
      `OPERATION must be one of: ${AZURE_OPERATIONS.join(", ")}.`,
    );
  }
  return value;
}

export type ReportPathInput = {
  environmentName: string;
  releaseSha: string;
  operation: string;
  jobExecutionId: string;
  baseDirectory?: string;
};

/**
 * Derives an immutable, per-execution local report directory from exactly
 * four validated inputs: ENVIRONMENT_NAME, RELEASE_SHA, OPERATION, and
 * JOB_EXECUTION_ID. Every segment is strictly validated before use (never
 * guessed, never derived from anything else), and the final resolved path
 * is re-checked to stay inside the base directory as defense-in-depth
 * against any validation bypass.
 */
export function deriveReportDirectory(input: ReportPathInput): string {
  const environmentName = validateEnvironmentName(input.environmentName);
  const releaseSha = validateReleaseSha(input.releaseSha);
  const operation = validateOperation(input.operation);
  const jobExecutionId = validateJobExecutionId(input.jobExecutionId);

  const baseDirectory = resolve(
    input.baseDirectory ?? resolve(process.cwd(), "ops-reports"),
  );
  const directory = resolve(
    baseDirectory,
    environmentName,
    releaseSha,
    operation,
    jobExecutionId,
  );
  const baseWithSeparator = baseDirectory.endsWith(sep)
    ? baseDirectory
    : `${baseDirectory}${sep}`;
  if (directory !== baseDirectory && !directory.startsWith(baseWithSeparator)) {
    throw new Error(
      "Derived report directory escaped the reports base directory.",
    );
  }
  return directory;
}

export type EvidenceDestinationInput = {
  environmentName: string;
  releaseSha: string;
  operation: string;
  jobExecutionId: string;
};

/**
 * Derives the immutable, hierarchical evidence destination prefix
 * (`ENVIRONMENT_NAME/RELEASE_SHA/OPERATION/JOB_EXECUTION_ID`) from the same
 * four validated inputs as `deriveReportDirectory`. This is a blob-storage
 * virtual path, so segments are always joined with `/` regardless of the
 * host OS path separator, and every segment is validated (never guessed,
 * never derived from anything else) so two distinct executions can never
 * collide on the same evidence destination.
 */
export function deriveEvidenceDestinationPrefix(
  input: EvidenceDestinationInput,
): string {
  const environmentName = validateEnvironmentName(input.environmentName);
  const releaseSha = validateReleaseSha(input.releaseSha);
  const operation = validateOperation(input.operation);
  const jobExecutionId = validateJobExecutionId(input.jobExecutionId);
  return [environmentName, releaseSha, operation, jobExecutionId].join("/");
}
