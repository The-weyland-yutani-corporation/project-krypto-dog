import { createHash, randomUUID } from "node:crypto";
import { db } from "@/db";
import { operatorAuditEvent } from "@/db/schema";
import type { AdminAction, AdminOperator } from "@/lib/admin-auth";
import {
  requestIdFromHeaders,
  resolveReleaseDeploymentCorrelation,
} from "@/lib/correlation";

type AuditWriter = Pick<typeof db, "insert">;

export async function recordOperatorAuditEvent(input: {
  writer?: AuditWriter;
  operator: AdminOperator;
  action: AdminAction;
  requestHeaders: Pick<Headers, "get">;
  requestId?: string;
  outcome: "REQUESTED" | "APPLIED" | "NO_CHANGE";
  occurredAt?: Date;
}): Promise<string> {
  const eventId = randomUUID();
  const occurredAt = input.occurredAt ?? new Date();
  const requestId =
    input.requestId ?? requestIdFromHeaders(input.requestHeaders);
  const correlation = resolveReleaseDeploymentCorrelation();
  await (input.writer ?? db).insert(operatorAuditEvent).values({
    eventId,
    requestId,
    releaseId: correlation.releaseId,
    deploymentId: correlation.deploymentId,
    action: input.action,
    outcome: input.outcome,
    operatorId: input.operator.operatorId,
    operatorName: input.operator.operatorName,
    subjectId: input.operator.subjectId,
    operatorRole: input.operator.role,
    authenticationMethod: input.operator.authenticationMethod,
    authenticationContext: input.operator.authenticationContext,
    mfaEvidence: input.operator.mfaEvidence,
    authenticatedAt: input.operator.authenticatedAt,
    tokenIssuedAt: input.operator.tokenIssuedAt,
    sessionIdHash: createHash("sha256")
      .update(input.operator.sessionId, "utf8")
      .digest("hex"),
    policyVersion: input.operator.policyVersion,
    occurredAt,
  });
  return eventId;
}
