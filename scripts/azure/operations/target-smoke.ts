import { runTargetSmoke, validateImageDigest } from "@/deployment/target-smoke";

import type { AzureOperationContext, AzureOperationResult } from "./types";

/**
 * Runs the reviewed, disabled-mode `runTargetSmoke` flow against the
 * deployed Azure target, binding the release SHA (from context) and image
 * digest (required env, validated, never guessed).
 */
export async function run(
  context: AzureOperationContext,
): Promise<AzureOperationResult> {
  const baseUrl = process.env.TARGET_BASE_URL;
  const expectedHost = process.env.TARGET_CONFIRM_HOST;
  const databaseUrl = process.env.DIRECT_URL;
  const cronSecret = process.env.CRON_SECRET;
  const adminPassword = process.env.ADMIN_PASSWORD;
  const imageDigest = process.env.IMAGE_DIGEST;
  const approvalSecret = process.env.DEPLOYMENT_APPROVAL_SECRET;
  if (
    !baseUrl ||
    !expectedHost ||
    !databaseUrl ||
    !cronSecret ||
    !adminPassword ||
    !imageDigest ||
    !approvalSecret
  ) {
    throw new Error(
      "TARGET_BASE_URL, TARGET_CONFIRM_HOST, DIRECT_URL, CRON_SECRET, ADMIN_PASSWORD, IMAGE_DIGEST, and DEPLOYMENT_APPROVAL_SECRET are required for the target-smoke operation.",
    );
  }

  const report = await runTargetSmoke({
    baseUrl,
    expectedHost,
    databaseUrl,
    cronSecret,
    adminPassword,
    releaseSha: context.releaseSha,
    imageDigest: validateImageDigest(imageDigest),
    approvalSecret,
  });

  return { passed: report.passed, report };
}
