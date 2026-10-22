import type postgres from "postgres";

import {
  canonicalApprovalPayload,
  computeApprovalSignature,
  constantTimeEqual,
} from "@/deployment/target-smoke";

export type LatestApprovalRow = {
  id: string;
  createdAt: Date;
  bindingId: string | null;
  targetOrigin: string | null;
  cronSecretBinding: string | null;
  releaseSha: string | null;
  imageDigest: string | null;
  rolloutMode: string | null;
  approvalSignature: string | null;
};

export async function loadLatestApproval(
  sql: postgres.Sql,
): Promise<LatestApprovalRow | undefined> {
  const [row] = await sql<LatestApprovalRow[]>`
    SELECT
      id,
      "createdAt",
      "marketConditions" ->> 'bindingId' AS "bindingId",
      "marketConditions" ->> 'targetOrigin' AS "targetOrigin",
      "marketConditions" ->> 'cronSecretBinding' AS "cronSecretBinding",
      "marketConditions" ->> 'releaseSha' AS "releaseSha",
      "marketConditions" ->> 'imageDigest' AS "imageDigest",
      "marketConditions" ->> 'rolloutMode' AS "rolloutMode",
      "marketConditions" ->> 'approvalSignature' AS "approvalSignature"
    FROM "krypto"."AgentJournal"
    WHERE "marketConditions" ->> 'event' = 'deployment-smoke-approved'
    ORDER BY "createdAt" DESC, id DESC
    LIMIT 1
  `;
  return row;
}

export async function bindingRowExists(
  sql: postgres.Sql,
  bindingId: string,
): Promise<boolean> {
  const [row] = await sql<Array<{ event: string | null }>>`
    SELECT "marketConditions" ->> 'event' AS event
    FROM "krypto"."AgentJournal"
    WHERE id = ${bindingId}
    LIMIT 1
  `;
  return row?.event === "deployment-smoke-binding";
}

export function approvalSignatureIsValid(
  approval: LatestApprovalRow | undefined,
  approvalSecret: string,
): boolean {
  if (
    !approval ||
    typeof approval.bindingId !== "string" ||
    typeof approval.targetOrigin !== "string" ||
    typeof approval.releaseSha !== "string" ||
    typeof approval.imageDigest !== "string" ||
    typeof approval.rolloutMode !== "string" ||
    typeof approval.cronSecretBinding !== "string"
  ) {
    return false;
  }
  const expected = computeApprovalSignature(
    canonicalApprovalPayload({
      bindingId: approval.bindingId,
      targetOrigin: approval.targetOrigin,
      releaseSha: approval.releaseSha,
      imageDigest: approval.imageDigest,
      rolloutMode: approval.rolloutMode,
      cronSecretBinding: approval.cronSecretBinding,
    }),
    approvalSecret,
  );
  return constantTimeEqual(expected, approval.approvalSignature);
}
