import { NextRequest, NextResponse } from "next/server";
import { z } from "zod/v4";
import { requireAdminOperator } from "@/lib/admin-route-auth";
import {
  requestIdFromHeaders,
  resolveReleaseDeploymentCorrelation,
} from "@/lib/correlation";
import { checkSameOrigin } from "@/lib/csrf";
import {
  SafetyIncidentConflictError,
  SafetyIncidentValidationError,
  safetyIncidentRepository,
} from "@/lib/safety-incidents";
import {
  SafetyRosterValidationError,
  readSafetyRoster,
  rosterAssignmentForRole,
  summarizeSafetyRoster,
} from "@/lib/safety-roster";
import { readSafetyActorPublicKeys } from "@/lib/safety-actor-auth";
import { resolveTradingMode } from "@/trading/strategy-config";
import { recordOperatorAuditEvent } from "@/lib/operator-audit";

const TestFireBody = z
  .object({
    severity: z.enum(["WARNING", "CRITICAL"]),
    dryRun: z.boolean().default(true),
    drill: z.boolean().default(false),
    drillId: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/)
      .optional(),
    actorId: z.string().trim().min(1).max(120),
    actorRole: z.enum(["RELEASE_OWNER", "SAFETY_APPROVER"]),
    reason: z.string().trim().min(3).max(240),
  })
  .strict()
  .check((ctx) => {
    if (!ctx.value.dryRun && !ctx.value.drillId) {
      ctx.issues.push({
        code: "custom",
        message: "drillId is required for a persisted test fire",
        input: ctx.value,
      });
    }
  });

export async function POST(request: NextRequest) {
  const csrf = checkSameOrigin(request);
  if (csrf) return csrf;
  const auth = await requireAdminOperator(
    request,
    "TEST_FIRE_SAFETY_INCIDENT",
  );
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid safety incident test-fire body" },
      { status: 400 },
    );
  }
  const parsed = TestFireBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid safety incident test-fire body" },
      { status: 400 },
    );
  }

  let roster;
  let authenticatorsConfigured = false;
  try {
    roster = readSafetyRoster();
    readSafetyActorPublicKeys();
    authenticatorsConfigured = true;
  } catch (error) {
    if (error instanceof SafetyRosterValidationError) {
      return NextResponse.json(
        { error: "Safety responder roster is incomplete or invalid" },
        { status: 503 },
      );
    }
    throw error;
  }
  if (
    rosterAssignmentForRole(roster, parsed.data.actorRole) !==
      parsed.data.actorId ||
    parsed.data.actorId !== auth.operator.operatorName ||
    parsed.data.actorRole !== auth.operator.role
  ) {
    return NextResponse.json(
      { error: "Actor does not match the protected roster assignment" },
      { status: 403 },
    );
  }

  const rolloutMode = resolveTradingMode();
  const correlation = resolveReleaseDeploymentCorrelation();
  const requestId = requestIdFromHeaders(request.headers);
  const incidentType =
    parsed.data.severity === "CRITICAL"
      ? "TEST_FIRE_CRITICAL"
      : "TEST_FIRE_WARNING";
  const auditEventId = await recordOperatorAuditEvent({
    operator: auth.operator,
    action: "TEST_FIRE_SAFETY_INCIDENT",
    requestHeaders: request.headers,
    requestId,
    outcome: parsed.data.dryRun ? "NO_CHANGE" : "REQUESTED",
  });

  if (parsed.data.dryRun) {
    return NextResponse.json(
      {
        dryRun: true,
        persisted: false,
        incidentType,
        severity: parsed.data.severity,
        rolloutMode,
        requestId,
        operatorAuditEventId: auditEventId,
        ...correlation,
        roster: summarizeSafetyRoster(roster, authenticatorsConfigured),
      },
      { status: 200 },
    );
  }

  if (
    !parsed.data.drill ||
    process.env.SAFETY_INCIDENT_DRILL_ENABLED !== "true"
  ) {
    return NextResponse.json(
      {
        error:
          "Persisted test fire requires the explicit request and environment drill flags",
      },
      { status: 403 },
    );
  }
  if (rolloutMode !== "disabled" && rolloutMode !== "shadow") {
    return NextResponse.json(
      {
        error:
          "Persisted test fire is forbidden unless rollout is disabled or shadow",
      },
      { status: 409 },
    );
  }

  try {
    const result = await safetyIncidentRepository.createOrGet({
      incidentType,
      severity: parsed.data.severity,
      dedupKey: `test-fire.${parsed.data.severity.toLowerCase()}.${parsed.data.drillId}`,
      requestId,
      releaseId: correlation.releaseId,
      deploymentId: correlation.deploymentId,
      redactedContext: {
        component: "operator-api",
        operation: "test-fire",
        environment: process.env.NODE_ENV ?? "local",
        rolloutMode,
        drill: true,
        scenario: parsed.data.drillId,
      },
      ownerRole: "PRIMARY_ON_CALL",
      backupRole: "BACKUP_ON_CALL",
      runbook: "specs/incident-response.md#non-trading-drills-and-game-day",
      actorId: auth.operator.operatorId,
      actorRole: parsed.data.actorRole,
      evidence: {
        summary: parsed.data.reason,
        drillScenario: parsed.data.drillId,
      },
    });
    return NextResponse.json(
      {
        dryRun: false,
        persisted: true,
        created: result.created,
        eventId: result.event.eventId,
        incidentId: result.event.incidentId,
        incidentType: result.event.incidentType,
        severity: result.event.severity,
        status: result.event.status,
        requestId: result.event.requestId,
        releaseId: result.event.releaseId,
        deploymentId: result.event.deploymentId,
      },
      { status: result.created ? 201 : 200 },
    );
  } catch (error) {
    if (error instanceof SafetyIncidentValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof SafetyIncidentConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}
