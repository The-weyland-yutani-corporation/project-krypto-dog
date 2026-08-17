#!/usr/bin/env node
import postgres from "postgres";

export const SAFETY_INCIDENT_EXPORT_PREFIX = "[safety-incident-export]";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const EVENT_KINDS = new Set([
  "CREATED",
  "ACKNOWLEDGED",
  "ESCALATED",
  "RESOLVED",
  "DELIVERY_CONFIRMED",
  "DELIVERY_FAILED",
]);
const SEVERITIES = new Set(["WARNING", "CRITICAL"]);
const STATUSES = new Set(["OPEN", "ACKNOWLEDGED", "ESCALATED", "RESOLVED"]);

export interface SafetyIncidentRelayRow {
  eventId: string;
  incidentId: string;
  eventSequence: number;
  eventKind: string;
  incidentType: string;
  severity: string;
  status: string;
  requestId: string;
  agentRunId: string | null;
  releaseId: string;
  deploymentId: string;
  providerAttemptId: string | null;
  transactionId: string | null;
  occurredAt: Date;
  persistedAt: Date;
  acknowledgedAt: Date | null;
  escalatedAt: Date | null;
  resolvedAt: Date | null;
  deliveryAttemptId: string | null;
}

export interface SafetyIncidentRelayDependencies {
  loadLatest?: () => Promise<SafetyIncidentRelayRow[]>;
  now?: () => Date;
  logger?: Pick<Console, "log">;
  env?: Record<string, string | undefined>;
}

function assertSafeId(value: string | null, field: string): void {
  if (
    value !== null &&
    (!SAFE_ID.test(value) ||
      /(?:secret|password|token|credential|https?:|postgres)/i.test(value))
  ) {
    throw new Error(`${field} is not a safe structured identifier`);
  }
}

function validateRow(row: SafetyIncidentRelayRow): void {
  for (const [field, value] of [
    ["eventId", row.eventId],
    ["incidentId", row.incidentId],
    ["incidentType", row.incidentType],
    ["requestId", row.requestId],
    ["agentRunId", row.agentRunId],
    ["releaseId", row.releaseId],
    ["deploymentId", row.deploymentId],
    ["providerAttemptId", row.providerAttemptId],
    ["transactionId", row.transactionId],
    ["deliveryAttemptId", row.deliveryAttemptId],
  ] as const) {
    assertSafeId(value, field);
  }
  if (
    !Number.isSafeInteger(row.eventSequence) ||
    row.eventSequence < 1 ||
    !EVENT_KINDS.has(row.eventKind) ||
    !SEVERITIES.has(row.severity) ||
    !STATUSES.has(row.status) ||
    Number.isNaN(row.occurredAt.getTime()) ||
    Number.isNaN(row.persistedAt.getTime())
  ) {
    throw new Error("Safety incident relay row failed its allowlist");
  }
}

async function loadLatestFromDatabase(
  env: Record<string, string | undefined>,
): Promise<SafetyIncidentRelayRow[]> {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for the safety incident relay");
  }
  const client = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    connect_timeout: 5,
    idle_timeout: 5,
    connection: {
      application_name: "project-krypto-safety-relay",
      statement_timeout: 10_000,
      lock_timeout: 2_000,
      default_transaction_read_only: true,
    },
  });
  try {
    return await client<SafetyIncidentRelayRow[]>`
      SELECT DISTINCT ON (incident."incidentId")
        incident."eventId",
        incident."incidentId",
        incident."eventSequence",
        incident."eventKind"::text AS "eventKind",
        incident."incidentType"::text AS "incidentType",
        incident."severity"::text AS "severity",
        incident."status"::text AS "status",
        incident."requestId",
        incident."agentRunId",
        incident."releaseId",
        incident."deploymentId",
        incident."providerAttemptId",
        incident."transactionId",
        incident."occurredAt",
        incident."persistedAt",
        incident."acknowledgedAt",
        incident."escalatedAt",
        incident."resolvedAt",
        (
          SELECT attempt."evidence" ->> 'deliveryAttemptId'
          FROM "krypto"."SafetyIncidentOutbox" AS attempt
          WHERE attempt."incidentId" = incident."incidentId"
            AND attempt."evidence" ->> 'deliveryAttemptId' IS NOT NULL
          ORDER BY attempt."eventSequence" DESC
          LIMIT 1
        ) AS "deliveryAttemptId"
      FROM "krypto"."SafetyIncidentOutbox" AS incident
      ORDER BY incident."incidentId", incident."eventSequence" DESC
    `;
  } finally {
    await client.end({ timeout: 5 });
  }
}

export async function runSafetyIncidentRelay(
  dependencies: SafetyIncidentRelayDependencies = {},
): Promise<{ exported: number }> {
  const env = dependencies.env ?? process.env;
  const now = dependencies.now?.() ?? new Date();
  const logger = dependencies.logger ?? console;
  if (Number.isNaN(now.getTime())) {
    throw new Error("Safety incident relay clock is invalid");
  }
  const rows = await (dependencies.loadLatest
    ? dependencies.loadLatest()
    : loadLatestFromDatabase(env));
  for (const row of rows) {
    validateRow(row);
    logger.log(
      `${SAFETY_INCIDENT_EXPORT_PREFIX} ${JSON.stringify({
        eventType: "safety_incident_export",
        eventId: row.eventId,
        incidentId: row.incidentId,
        eventSequence: row.eventSequence,
        eventKind: row.eventKind,
        incidentType: row.incidentType,
        severity: row.severity,
        status: row.status,
        requestId: row.requestId,
        agentRunId: row.agentRunId,
        releaseId: row.releaseId,
        deploymentId: row.deploymentId,
        providerAttemptId: row.providerAttemptId,
        transactionId: row.transactionId,
        occurredAt: row.occurredAt.toISOString(),
        persistedAt: row.persistedAt.toISOString(),
        acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
        escalatedAt: row.escalatedAt?.toISOString() ?? null,
        resolvedAt: row.resolvedAt?.toISOString() ?? null,
        deliveryAttemptId: row.deliveryAttemptId,
        pendingAgeSeconds: Math.max(
          0,
          Math.floor((now.getTime() - row.occurredAt.getTime()) / 1_000),
        ),
        exportedAt: now.toISOString(),
      })}`,
    );
  }
  logger.log(
    JSON.stringify({
      eventType: "safety_incident_relay_scan",
      exported: rows.length,
      completedAt: now.toISOString(),
    }),
  );
  return { exported: rows.length };
}

export async function main(): Promise<void> {
  await runSafetyIncidentRelay();
}
