import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../src/db/schema";
import {
  SafetyIncidentValidationError,
  createSafetyIncidentRepository,
  type CreateSafetyIncidentInput,
  type SafetyIncidentSeverity,
  type SafetyIncidentStatus,
} from "../src/lib/safety-incidents";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

const capturedQueries: Array<{
  query: string;
  parameters: readonly unknown[];
}> = [];
const client = postgres(url, {
  max: 1,
  prepare: false,
  debug(_connection, query, parameters) {
    capturedQueries.push({ query, parameters });
  },
});
const database = drizzle(client, { schema });

let now = new Date("2026-08-18T07:00:00.000Z");
let uuidCounter = 1;
const repository = createSafetyIncidentRepository(database, {
  now: () => new Date(now),
  uuid: () => {
    const suffix = String(uuidCounter++).padStart(12, "0");
    return `00000000-0000-4000-a000-${suffix}`;
  },
  logger: { error() {}, warn() {} },
});

function setNow(iso: string): void {
  now = new Date(iso);
}

async function createIncident(
  label: string,
  severity: SafetyIncidentSeverity,
) {
  const input: CreateSafetyIncidentInput = {
    incidentType: "POST_COMMIT_FAILURE",
    severity,
    dedupKey: `listing.${label}`,
    requestId: `request-${label}`,
    releaseId: "a".repeat(40),
    deploymentId: "listing-test",
    redactedContext: {
      component: "incident-listing-test",
      operation: "projection",
      scenario: label,
    },
    occurredAt: new Date(now),
    ownerRole: "PRIMARY_ON_CALL",
    backupRole: "BACKUP_ON_CALL",
    runbook: "specs/incident-response.md#scenario-actions",
  };
  return (await repository.createOrGet(input)).event;
}

const COMPLETE_RESOLUTION_EVIDENCE = {
  affectedInterval: "2026-08-18T07:00:00Z/2026-08-18T07:05:00Z",
  cause: "listing-test",
  containmentDecision: "rollout-disabled",
  remediation: "projection-verified",
  verification: "latest-event-query",
  followUpRef: "issue-125",
  residualRisk: "none-known",
  reentryDecision: "test-complete",
};

try {
  const resolvedCritical = await createIncident("resolved-critical", "CRITICAL");
  const acknowledgedWarning = await createIncident(
    "acknowledged-warning",
    "WARNING",
  );

  setNow("2026-08-18T07:01:00.000Z");
  await repository.appendHumanLifecycle({
    incidentId: resolvedCritical.incidentId,
    eventKind: "ACKNOWLEDGED",
    actorId: "release-owner-person",
    actorRole: "RELEASE_OWNER",
    reason: "Containment recorded",
    evidence: { containmentDecision: "rollout-disabled" },
  });

  setNow("2026-08-18T07:02:00.000Z");
  await repository.appendHumanLifecycle({
    incidentId: resolvedCritical.incidentId,
    eventKind: "RESOLVED",
    actorId: "safety-approver-person",
    actorRole: "SAFETY_APPROVER",
    reason: "Independent verification complete",
    evidence: COMPLETE_RESOLUTION_EVIDENCE,
  });

  setNow("2026-08-18T07:03:00.000Z");
  await repository.appendHumanLifecycle({
    incidentId: acknowledgedWarning.incidentId,
    eventKind: "ACKNOWLEDGED",
    actorId: "primary-person",
    actorRole: "PRIMARY_ON_CALL",
    reason: "Primary responder acknowledged",
  });

  setNow("2026-08-18T07:04:00.000Z");
  const openCriticalA = await createIncident("open-critical-a", "CRITICAL");
  const openCriticalB = await createIncident("open-critical-b", "CRITICAL");

  setNow("2026-08-18T07:05:00.000Z");
  const openWarning = await createIncident("open-warning", "WARNING");

  const bounded = await repository.listLatest({ limit: 2 });
  assert.equal(bounded.length, 2);
  assert.equal(bounded[0]?.incidentId, openWarning.incidentId);
  assert.equal(
    bounded[1]?.incidentId,
    [openCriticalA.incidentId, openCriticalB.incidentId].sort()[0],
  );
  assert.equal("redactedContext" in bounded[0], false);

  const openOnly = await repository.listLatest({
    limit: 10,
    status: "OPEN",
  });
  assert.deepEqual(
    new Set(openOnly.map((row) => row.incidentId)),
    new Set([
      openWarning.incidentId,
      openCriticalA.incidentId,
      openCriticalB.incidentId,
    ]),
  );
  assert.equal(
    openOnly.some((row) => row.incidentId === resolvedCritical.incidentId),
    false,
    "a stale OPEN origin must not survive a current RESOLVED event",
  );
  assert.equal(
    openOnly.some((row) => row.incidentId === acknowledgedWarning.incidentId),
    false,
    "a stale OPEN origin must not survive a current ACKNOWLEDGED event",
  );

  const criticalOpen = await repository.listLatest({
    limit: 10,
    severity: "CRITICAL",
    status: "OPEN",
  });
  assert.deepEqual(
    criticalOpen.map((row) => row.incidentId),
    [openCriticalA.incidentId, openCriticalB.incidentId].sort(),
  );

  const acknowledged = await repository.listLatest({
    limit: 10,
    status: "ACKNOWLEDGED",
    includeContext: true,
  });
  assert.equal(acknowledged.length, 1);
  assert.equal(acknowledged[0]?.incidentId, acknowledgedWarning.incidentId);
  assert.deepEqual(acknowledged[0]?.redactedContext, {
    component: "incident-listing-test",
    operation: "projection",
    scenario: "acknowledged-warning",
  });

  const resolved = await repository.listLatest({
    limit: 10,
    status: "RESOLVED",
  });
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]?.incidentId, resolvedCritical.incidentId);
  assert.equal(resolved[0]?.eventSequence, 3);

  const listQueries = capturedQueries.filter((entry) =>
    entry.query.includes("latest_safety_incident_event"),
  );
  assert.ok(listQueries.length >= 5);
  const filteredQuery = listQueries.find(
    (entry) =>
      entry.parameters.includes("CRITICAL") &&
      entry.parameters.includes("OPEN"),
  );
  assert.ok(filteredQuery);
  assert.match(filteredQuery.query, /select distinct on/i);
  assert.match(
    filteredQuery.query,
    /\) "latest_safety_incident_event" where/i,
    "severity/status filters must apply after the latest-event subquery",
  );
  assert.match(filteredQuery.query, / limit \$\d+$/i);
  assert.equal(Number(filteredQuery.parameters.at(-1)), 10);

  const queryCountBeforeInvalidInput = capturedQueries.length;
  await assert.rejects(
    repository.listLatest({
      limit: 10,
      status: "OPEN' OR 1=1 --" as SafetyIncidentStatus,
    }),
    SafetyIncidentValidationError,
  );
  assert.equal(capturedQueries.length, queryCountBeforeInvalidInput);

  console.log(
    "Safety incident listing tests passed for SQL-bounded latest-event projection, post-projection filters, stable ties, redaction, and parameter safety.",
  );
} finally {
  await client.end({ timeout: 5 });
}
