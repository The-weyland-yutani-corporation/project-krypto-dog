import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";
import {
  sanitizeSafetyEvidence,
} from "../src/lib/safety-incidents";
import {
  readSafetyRoster,
  rosterAssignmentForRole,
  type SafetyActorRole,
} from "../src/lib/safety-roster";
import { verifySafetyActorAssertion } from "../src/lib/safety-actor-auth";

const REQUIRED_EVIDENCE = [
  "affectedInterval",
  "cause",
  "containmentDecision",
  "remediation",
  "verification",
  "followUpRef",
  "residualRisk",
  "reentryDecision",
] as const;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function resolutionInput() {
  const action = required("SAFETY_ACTION") as
    | "ACKNOWLEDGE"
    | "ESCALATE"
    | "RESOLVE";
  if (!["ACKNOWLEDGE", "ESCALATE", "RESOLVE"].includes(action)) {
    throw new Error(
      "SAFETY_ACTION must be ACKNOWLEDGE, ESCALATE, or RESOLVE",
    );
  }
  const incidentId = required("SAFETY_INCIDENT_ID");
  const actorId = required("SAFETY_ACTOR_ID");
  const actorRole = required("SAFETY_ACTOR_ROLE") as SafetyActorRole;
  const authorizedRoles = {
    ACKNOWLEDGE: ["PRIMARY_ON_CALL", "BACKUP_ON_CALL", "RELEASE_OWNER"],
    ESCALATE: [
      "PRIMARY_ON_CALL",
      "BACKUP_ON_CALL",
      "RELEASE_OWNER",
      "SAFETY_APPROVER",
    ],
    RESOLVE: ["RELEASE_OWNER", "SAFETY_APPROVER"],
  }[action] as readonly string[];
  if (!authorizedRoles.includes(actorRole)) {
    throw new Error(`${actorRole} cannot perform ${action}`);
  }
  const reason = required("SAFETY_ACTION_REASON");
  const signedAt = required("SAFETY_ACTOR_SIGNED_AT");
  const signature = required("SAFETY_ACTOR_SIGNATURE");
  let parsedEvidence: unknown;
  try {
    parsedEvidence = JSON.parse(required("SAFETY_ACTION_EVIDENCE_JSON"));
  } catch {
    throw new Error(
      "SAFETY_ACTION_EVIDENCE_JSON must be valid allowlisted JSON",
    );
  }
  const evidence = sanitizeSafetyEvidence(parsedEvidence);
  if (action === "RESOLVE") {
    for (const key of REQUIRED_EVIDENCE) {
      if (typeof evidence[key] !== "string" || evidence[key] === "") {
        throw new Error(`Resolution evidence is missing ${key}`);
      }
    }
  }
  const roster = readSafetyRoster();
  if (rosterAssignmentForRole(roster, actorRole) !== actorId) {
    throw new Error("Actor does not match the protected roster assignment");
  }
  if (
    !verifySafetyActorAssertion({
      action,
      incidentId,
      actorId,
      actorRole,
      reason,
      evidence,
      signedAt,
      signature,
    })
  ) {
    throw new Error("Safety actor assertion is invalid or expired");
  }
  return {
    incidentId,
    action,
    eventKind:
      action === "ACKNOWLEDGE"
        ? "ACKNOWLEDGED"
        : action === "ESCALATE"
          ? "ESCALATED"
          : "RESOLVED",
    status:
      action === "ACKNOWLEDGE"
        ? "ACKNOWLEDGED"
        : action === "ESCALATE"
          ? "ESCALATED"
          : "RESOLVED",
    actorId,
    actorRole,
    reason,
    evidence,
    operationId: createHash("sha256")
      .update(
        JSON.stringify({
          action,
          incidentId,
          actorId,
          actorRole,
          reason,
          evidence,
          signedAt,
        }),
        "utf8",
      )
      .digest("hex"),
  };
}

async function main(): Promise<void> {
  const directUrl = required("DIRECT_URL");
  const input = resolutionInput();
  const client = postgres(directUrl, {
    max: 1,
    prepare: false,
    connect_timeout: 5,
    connection: {
      application_name: "project-krypto-incident-resolution",
      statement_timeout: 10_000,
      lock_timeout: 2_000,
      idle_in_transaction_session_timeout: 15_000,
    },
  });
  try {
    const result = await client.begin(async (tx) => {
      await tx.unsafe('SET LOCAL ROLE "krypto_schema_owner"');
      const [existing] = await tx.unsafe<
        Array<{ eventId: string; incidentId: string }>
      >(
        `
        SELECT "eventId", "incidentId"
        FROM "krypto"."SafetyIncidentOutbox"
        WHERE "incidentId" = $1
          AND "eventKind"::text = $3
          AND "evidence" ->> 'operationId' = $2
        LIMIT 1
        `,
        [input.incidentId, input.operationId, input.eventKind],
      );
      if (existing) return { ...existing, appended: false };

      const [inserted] = await tx.unsafe<
        Array<{ eventId: string; incidentId: string }>
      >(
        `
        INSERT INTO "krypto"."SafetyIncidentOutbox" (
          "eventId", "incidentId", "eventSequence", "eventKind",
          "incidentType", "severity", "status", "dedupKey", "requestId",
          "agentRunId", "releaseId", "deploymentId", "providerAttemptId",
          "transactionId", "redactedContext", "occurredAt", "persistedAt",
          "acknowledgedAt", "escalatedAt", "resolvedAt", "ownerRole",
          "backupRole", "runbook", "actorId", "actorRole", "evidence"
        )
        SELECT
          $1, latest."incidentId",
          latest."eventSequence" + 1,
          $6::"krypto"."SafetyIncidentEventKind", latest."incidentType",
          latest."severity", $7::"krypto"."SafetyIncidentStatus",
          latest."dedupKey",
          latest."requestId", latest."agentRunId", latest."releaseId",
          latest."deploymentId", latest."providerAttemptId",
          latest."transactionId", latest."redactedContext",
          latest."occurredAt", clock_timestamp(),
          CASE WHEN $6 = 'ACKNOWLEDGED' THEN clock_timestamp()
            ELSE latest."acknowledgedAt" END,
          CASE WHEN $6 = 'ESCALATED' THEN clock_timestamp()
            ELSE latest."escalatedAt" END,
          CASE WHEN $6 = 'RESOLVED' THEN clock_timestamp()
            ELSE latest."resolvedAt" END,
          latest."ownerRole",
          latest."backupRole", latest."runbook", $3,
          $4, $5::jsonb
        FROM "krypto"."SafetyIncidentOutbox" AS latest
        WHERE latest."incidentId" = $2
        ORDER BY latest."eventSequence" DESC
        LIMIT 1
        RETURNING "eventId", "incidentId"
        `,
        [
          randomUUID(),
          input.incidentId,
          input.actorId,
          input.actorRole,
          JSON.stringify({
            ...input.evidence,
            reason: input.reason,
            operationId: input.operationId,
          }),
          input.eventKind,
          input.status,
        ],
      );
      if (!inserted) throw new Error("Safety incident was not found");
      return { ...inserted, appended: true };
    });
    console.log(
      JSON.stringify({
        eventType: "safety_incident_lifecycle_persisted",
        incidentId: result.incidentId,
        eventId: result.eventId,
        appended: result.appended,
      }),
    );
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch(() => {
  console.error(
    JSON.stringify({
      eventType: "safety_incident_resolution_failed",
      failureCode: "protected-operation-failed",
    }),
  );
  process.exitCode = 1;
});
