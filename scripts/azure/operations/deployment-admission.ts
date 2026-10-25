import {
  DEPLOYMENT_FENCE_SUCCESS_STATUS,
  runDeploymentAdmission,
  validateDeploymentFenceAction,
  type DeploymentAdmissionOptions,
} from "@/deployment/deployment-admission";
import {
  verifyWorkflowObservation,
  workflowObservationTrustFromEnv,
} from "@/deployment/workflow-observation";

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
  const wireAction = requireEnv("DEPLOYMENT_FENCE_ACTION");
  if (wireAction === "release") {
    throw new Error("Legacy unsigned fence release is unsupported; use the attested release protocol.");
  }
  const action = validateDeploymentFenceAction(wireAction === "release-attested-v1" ? "release" : wireAction);
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
  let options: DeploymentAdmissionOptions;
  if (action === "acquire") {
    options = {
      ...binding, action,
      cronSecret: requireEnv("CRON_SECRET"),
      approvalSecret: requireEnv("DEPLOYMENT_APPROVAL_SECRET"),
    };
  } else if (action === "verify") {
    options = { ...binding, action };
  } else {
    const proof = requireEnv("DEPLOYMENT_WORKFLOW_OBSERVATION");
    delete process.env.DEPLOYMENT_WORKFLOW_OBSERVATION;
    const observation = await verifyWorkflowObservation(proof, {
      ...workflowObservationTrustFromEnv(process.env),
      purpose: "cutover-release",
      workflowSha: binding.candidateReleaseSha,
      operationExecutionId: context.jobExecutionId,
    });
    const readback = observation.observation;
    const candidateImage = readback.releaseSha === binding.candidateReleaseSha &&
      context.releaseSha === binding.candidateReleaseSha && readback.imageDigest === requireEnv("IMAGE_DIGEST");
    const sourceImage = readback.releaseSha === binding.sourceReleaseSha && readback.imageDigest === binding.imageDigest;
    if ((!candidateImage && !sourceImage) ||
        observation.observation.opsImageDigest !== requireEnv("OPS_IMAGE_DIGEST") ||
        observation.observation.targetOrigin !== binding.targetOrigin) {
      throw new Error("Workflow readback does not match this exact operations release and target.");
    }
    options = {
      ...binding, action, observation,
      releaseImageDigest: candidateImage ? requireEnv("IMAGE_DIGEST") : binding.imageDigest,
    };
  }
  const report = await runDeploymentAdmission(options);
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
