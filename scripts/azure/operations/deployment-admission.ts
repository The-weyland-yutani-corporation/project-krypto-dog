import {
  DEPLOYMENT_FENCE_SUCCESS_STATUS,
  runDeploymentAdmission,
  validateDeploymentFenceAction,
} from "@/deployment/deployment-admission";

import type { AzureOperationContext, AzureOperationResult } from "./types";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for deployment admission.`);
  return value;
}

export async function run(
  context: AzureOperationContext,
): Promise<AzureOperationResult> {
  if (context.environmentName !== "prod") {
    throw new Error("Deployment admission is restricted to the production ops job.");
  }
  const azureExecutionName = requireEnv("CONTAINER_APP_JOB_EXECUTION_NAME");
  const action = validateDeploymentFenceAction(requireEnv("DEPLOYMENT_FENCE_ACTION"));
  const binding = {
    databaseUrl: requireEnv("DIRECT_URL"),
    owner: requireEnv("DEPLOYMENT_FENCE_OWNER"),
    sourceReleaseSha: requireEnv("DEPLOYMENT_SOURCE_RELEASE_SHA"),
    candidateReleaseSha: requireEnv("DEPLOYMENT_CANDIDATE_RELEASE_SHA"),
    imageDigest: requireEnv("DEPLOYMENT_SOURCE_IMAGE_DIGEST"),
    targetOrigin: requireEnv("TARGET_ORIGIN"),
  };
  if (
    (action === "acquire" &&
      (context.releaseSha !== binding.sourceReleaseSha ||
        requireEnv("IMAGE_DIGEST") !== binding.imageDigest)) ||
    (action !== "acquire" &&
      context.releaseSha !== binding.sourceReleaseSha &&
      context.releaseSha !== binding.candidateReleaseSha)
  ) {
    throw new Error("Deployment admission job does not match the bound release.");
  }
  const report = await runDeploymentAdmission(
    action === "acquire"
      ? {
          ...binding,
          action,
          cronSecret: requireEnv("CRON_SECRET"),
          approvalSecret: requireEnv("DEPLOYMENT_APPROVAL_SECRET"),
        }
      : { ...binding, action },
  );
  return {
    passed: report.status === DEPLOYMENT_FENCE_SUCCESS_STATUS[action],
    report: {
      ...report,
      environmentName: context.environmentName,
      releaseSha: context.releaseSha,
      jobExecutionId: context.jobExecutionId,
      azureExecutionName,
    },
  };
}
