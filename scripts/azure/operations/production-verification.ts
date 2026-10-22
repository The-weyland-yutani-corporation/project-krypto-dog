import { runProductionVerification } from "@/deployment/production-verification";
import type { AzureOperationContext, AzureOperationResult } from "./types";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for production verification.`);
  return value;
}

function positiveInteger(name: string): number {
  const value = required(name);
  if (!/^[1-9][0-9]{0,9}$/.test(value)) throw new Error(`${name} must be a positive epoch-second value.`);
  return Number(value);
}

export async function run(context: AzureOperationContext): Promise<AzureOperationResult> {
  if (context.environmentName !== "prod") {
    throw new Error("Paper-production verification requires the production ops identity.");
  }
  const phase = required("PRODUCTION_VERIFICATION_PHASE");
  if (phase !== "ready" && phase !== "scheduled") throw new Error("Unknown production verification phase.");
  const azureExecutionName = required("CONTAINER_APP_JOB_EXECUTION_NAME");
  const binding = {
    databaseUrl: required("DIRECT_URL"),
    releaseSha: context.releaseSha,
    imageDigest: required("IMAGE_DIGEST"),
    targetOrigin: required("TARGET_BASE_URL"),
    authorizationId: required("PRODUCTION_AUTHORIZATION_ID"),
    scheduleGeneration: positiveInteger("SCHEDULE_GENERATION_UNIX_SECONDS"),
    posthogApiKey: required("POSTHOG_API_KEY"),
    posthogHost: required("POSTHOG_HOST"),
    posthogEnvironment: required("POSTHOG_ENVIRONMENT"),
    approvalSecret: required("DEPLOYMENT_APPROVAL_SECRET"),
  };
  const report = await runProductionVerification(phase === "ready" ? {
    ...binding, phase,
    cronSecret: required("CRON_SECRET"),
    expectedApprovalId: required("EXPECTED_APPROVAL_ID"),
    approvalCreatedAfter: required("EXPECTED_APPROVAL_CREATED_AFTER"),
    expectedShadowIdempotencyKey: required("EXPECTED_SHADOW_IDEMPOTENCY_KEY"),
    expectedShadowStartedAfter: required("EXPECTED_SHADOW_STARTED_AFTER"),
  } : {
    ...binding, phase,
    scheduleEnabledAt: positiveInteger("SCHEDULE_ENABLED_AT_UNIX_SECONDS"),
    scheduledExecutionStartedAt: required("SCHEDULED_EXECUTION_STARTED_AT"),
  });
  return {
    passed: report.approved,
    report: {
      ...report, environmentName: context.environmentName,
      jobExecutionId: context.jobExecutionId, azureExecutionName,
    },
  };
}
