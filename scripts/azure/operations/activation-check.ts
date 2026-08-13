import { runActivationCheck } from "@/deployment/activation-check";

import type { AzureOperationContext, AzureOperationResult } from "./types";

/**
 * Runs the read-only schedule-activation verifier. Never mutates trading
 * state; `passed` mirrors the verifier's fail-closed `approved` field.
 */
export async function run(
  context: AzureOperationContext,
): Promise<AzureOperationResult> {
  const databaseUrl = process.env.DIRECT_URL;
  const targetOrigin = process.env.TARGET_ORIGIN;
  const cronSecret = process.env.CRON_SECRET;
  const imageDigest = process.env.IMAGE_DIGEST;
  const approvalSecret = process.env.DEPLOYMENT_APPROVAL_SECRET;
  if (
    !databaseUrl ||
    !targetOrigin ||
    !cronSecret ||
    !imageDigest ||
    !approvalSecret
  ) {
    throw new Error(
      "DIRECT_URL, TARGET_ORIGIN, CRON_SECRET, IMAGE_DIGEST, and DEPLOYMENT_APPROVAL_SECRET are required for the activation-check operation.",
    );
  }

  const report = await runActivationCheck({
    databaseUrl,
    releaseSha: context.releaseSha,
    imageDigest,
    targetOrigin,
    cronSecret,
    approvalSecret,
  });

  return { passed: report.approved, report };
}
