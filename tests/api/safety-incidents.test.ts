import { readFileSync } from "node:fs";
import { NextRequest, NextResponse } from "next/server";
import { mockDb } from "../setup";

jest.mock("@/lib/admin-route-auth", () => ({
  requireAdminOperator: jest.fn(),
}));
jest.mock("@/lib/safety-incidents", () => {
  const actual = jest.requireActual("@/lib/safety-incidents");
  return {
    ...actual,
    safetyIncidentRepository: {
      createOrGet: jest.fn(),
      appendHumanLifecycle: jest.fn(),
      appendDeliveryLifecycle: jest.fn(),
      listLatest: jest.fn(),
    },
  };
});
jest.mock("@/lib/safety-roster", () => {
  const actual = jest.requireActual("@/lib/safety-roster");
  return {
    ...actual,
  };
});
jest.mock("@/lib/safety-actor-auth", () => ({
  readSafetyActorPublicKeys: jest.fn(() => ({})),
}));

import {
  GET as listSafetyIncidents,
  POST as mutateSafetyIncident,
} from "@/app/api/admin/safety-incidents/route";
import { POST as testFire } from "@/app/api/admin/safety-incidents/test-fire/route";
import { requireAdminOperator } from "@/lib/admin-route-auth";
import {
  safetyIncidentRepository,
} from "@/lib/safety-incidents";

const mockedRequireAdminOperator =
  requireAdminOperator as jest.MockedFunction<typeof requireAdminOperator>;
const mockedRepository = safetyIncidentRepository as jest.Mocked<
  typeof safetyIncidentRepository
>;
const actorAssertion = {
  signedAt: "2026-08-17T20:00:00.000Z",
  signature: `${"A".repeat(86)}==`,
};
const TEST_OPERATOR = {
  operatorId: "33333333-3333-4333-8333-333333333333",
  operatorName: "release-person",
  subjectId: "subject-release-person",
  role: "RELEASE_OWNER" as const,
  authenticationMethod: "ENTRA_MFA" as const,
  authenticationContext: "c1,c2",
  mfaEvidence: "amr:mfa",
  authenticatedAt: new Date("2026-08-17T19:59:00.000Z"),
  tokenIssuedAt: new Date("2026-08-17T19:59:00.000Z"),
  sessionId: "55555555-5555-4555-8555-555555555555",
  policyVersion: "entra-admin-v1",
};

const ORIGINAL_ENV = {
  SAFETY_PRIMARY_ON_CALL: process.env.SAFETY_PRIMARY_ON_CALL,
  SAFETY_BACKUP_ON_CALL: process.env.SAFETY_BACKUP_ON_CALL,
  SAFETY_RELEASE_OWNER: process.env.SAFETY_RELEASE_OWNER,
  SAFETY_APPROVER: process.env.SAFETY_APPROVER,
  SAFETY_EVIDENCE_CUSTODIAN: process.env.SAFETY_EVIDENCE_CUSTODIAN,
  SAFETY_ROLLBACK_OWNER: process.env.SAFETY_ROLLBACK_OWNER,
  SAFETY_INCIDENT_DRILL_ENABLED:
    process.env.SAFETY_INCIDENT_DRILL_ENABLED,
  ROLLOUT_MODE: process.env.ROLLOUT_MODE,
};

function installRoster() {
  process.env.SAFETY_PRIMARY_ON_CALL = "primary-person";
  process.env.SAFETY_BACKUP_ON_CALL = "backup-person";
  process.env.SAFETY_RELEASE_OWNER = "release-person";
  process.env.SAFETY_APPROVER = "approver-person";
  process.env.SAFETY_EVIDENCE_CUSTODIAN = "custodian-person";
  process.env.SAFETY_ROLLBACK_OWNER = "rollback-person";
}

function restoreEnvironment() {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function request(
  url: string,
  body?: unknown,
  origin = "http://localhost:3000",
): NextRequest {
  const headers: Record<string, string> = { origin };
  if (body !== undefined) headers["content-type"] = "application/json";
  return new NextRequest(url, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function incidentEvent() {
  return {
    eventId: "00000000-0000-4000-a000-000000000002",
    incidentId: "00000000-0000-4000-a000-000000000001",
    eventSequence: 1,
    eventKind: "CREATED" as const,
    incidentType: "TEST_FIRE_WARNING" as const,
    severity: "WARNING" as const,
    status: "OPEN" as const,
    dedupKey: "test-fire.warning.drill-42",
    requestId: "request-42",
    agentRunId: null,
    releaseId: "local-release",
    deploymentId: "local-deployment",
    providerAttemptId: null,
    transactionId: null,
    redactedContext: { operation: "test-fire" },
    occurredAt: new Date("2026-08-17T19:00:00.000Z"),
    persistedAt: new Date("2026-08-17T19:00:00.000Z"),
    acknowledgedAt: null,
    resolvedAt: null,
    escalatedAt: null,
    ownerRole: "PRIMARY_ON_CALL",
    backupRole: "BACKUP_ON_CALL",
    runbook: "specs/incident-response.md",
    actorId: "release-person",
    actorRole: "RELEASE_OWNER",
    evidence: { drillScenario: "drill-42" },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  installRoster();
  process.env.ROLLOUT_MODE = "shadow";
  delete process.env.SAFETY_INCIDENT_DRILL_ENABLED;
  mockedRequireAdminOperator.mockResolvedValue({
    ok: true,
    operator: TEST_OPERATOR,
  });
  mockedRepository.listLatest.mockResolvedValue([]);
  mockedRepository.appendHumanLifecycle.mockResolvedValue({
    ...incidentEvent(),
    eventSequence: 2,
    eventKind: "ACKNOWLEDGED",
    status: "ACKNOWLEDGED",
    acknowledgedAt: new Date("2026-08-17T19:01:00.000Z"),
    actorId: "release-person",
    actorRole: "RELEASE_OWNER",
  });
});

afterAll(restoreEnvironment);

describe("admin safety incident routes", () => {
  it("protects list and mutation with admin auth and same-origin checks", async () => {
    mockedRequireAdminOperator.mockResolvedValueOnce({
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });
    const list = await listSafetyIncidents(
      request("http://localhost:3000/api/admin/safety-incidents"),
    );
    expect(list.status).toBe(401);

    const mutation = await mutateSafetyIncident(
      request(
        "http://localhost:3000/api/admin/safety-incidents",
        {
          action: "ACKNOWLEDGE",
          incidentId: "incident-42",
          actorId: "release-person",
          actorRole: "RELEASE_OWNER",
          reason: "Containment started",
        },
        "https://evil.example.test",
      ),
    );
    expect(mutation.status).toBe(403);
    expect(mockedRepository.appendHumanLifecycle).not.toHaveBeenCalled();
  });

  it("lists latest incidents without requesting context by default", async () => {
    const response = await listSafetyIncidents(
      request(
        "http://localhost:3000/api/admin/safety-incidents?limit=20&status=OPEN",
      ),
    );
    expect(response.status).toBe(200);
    expect(mockedRepository.listLatest).toHaveBeenCalledWith({
      limit: 20,
      status: "OPEN",
    });
  });

  it("uses strict lifecycle bodies and protected roster assignments", async () => {
    const invalid = await mutateSafetyIncident(
      request("http://localhost:3000/api/admin/safety-incidents", {
        action: "ACKNOWLEDGE",
        incidentId: "incident-42",
        actorId: "release-person",
        actorRole: "RELEASE_OWNER",
        reason: "Containment started",
        ...actorAssertion,
        rawPrompt: "must never be accepted",
      }),
    );
    expect(invalid.status).toBe(400);

    const mismatch = await mutateSafetyIncident(
      request("http://localhost:3000/api/admin/safety-incidents", {
        action: "ACKNOWLEDGE",
        incidentId: "incident-42",
        actorId: "different-person",
        actorRole: "RELEASE_OWNER",
        reason: "Containment started",
        ...actorAssertion,
      }),
    );
    expect(mismatch.status).toBe(503);
    expect(mockedRepository.appendHumanLifecycle).not.toHaveBeenCalled();
  });

  it("keeps human lifecycle changes out of the web runtime", async () => {
    const response = await mutateSafetyIncident(
      request("http://localhost:3000/api/admin/safety-incidents", {
        action: "ACKNOWLEDGE",
        incidentId: "incident-42",
        actorId: "release-person",
        actorRole: "RELEASE_OWNER",
        reason: "Containment started",
        evidence: { containmentDecision: "rollout-disabled" },
        ...actorAssertion,
      }),
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error:
        "Human lifecycle changes remain unavailable through the web runtime; use the protected signed owner/migrator operation.",
    });
    expect(mockedRepository.appendHumanLifecycle).not.toHaveBeenCalled();
  });

  it("fails closed instead of resolving through a shared admin identity", async () => {
    const response = await mutateSafetyIncident(
      request("http://localhost:3000/api/admin/safety-incidents", {
        action: "RESOLVE",
        incidentId: "incident-42",
        actorId: "release-person",
        actorRole: "RELEASE_OWNER",
        reason: "Retry succeeded",
        evidence: { retryOutcome: "SUCCESS" },
        ...actorAssertion,
      }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error:
        "Human lifecycle changes remain unavailable through the web runtime; use the protected signed owner/migrator operation.",
    });
    expect(mockedRepository.appendHumanLifecycle).not.toHaveBeenCalled();
  });
});

describe("admin safety incident test fire", () => {
  const baseBody = {
    severity: "WARNING",
    actorId: "release-person",
    actorRole: "RELEASE_OWNER",
    reason: "Warning delivery drill",
  };

  it("is dry-run by default and does not persist", async () => {
    const response = await testFire(
      request(
        "http://localhost:3000/api/admin/safety-incidents/test-fire",
        baseBody,
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      dryRun: true,
      persisted: false,
      incidentType: "TEST_FIRE_WARNING",
      rolloutMode: "shadow",
    });
    expect(mockedRepository.createOrGet).not.toHaveBeenCalled();
    expect(mockDb._insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "TEST_FIRE_SAFETY_INCIDENT",
        operatorId: TEST_OPERATOR.operatorId,
        outcome: "NO_CHANGE",
      }),
    );
  });

  it("supports a critical dry-run fixture without persistence", async () => {
    const response = await testFire(
      request(
        "http://localhost:3000/api/admin/safety-incidents/test-fire",
        {
          ...baseBody,
          severity: "CRITICAL",
          reason: "Critical delivery drill",
        },
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      dryRun: true,
      persisted: false,
      incidentType: "TEST_FIRE_CRITICAL",
      severity: "CRITICAL",
    });
    expect(mockedRepository.createOrGet).not.toHaveBeenCalled();
  });

  it("requires both drill flags before persistence", async () => {
    const response = await testFire(
      request(
        "http://localhost:3000/api/admin/safety-incidents/test-fire",
        {
          ...baseBody,
          dryRun: false,
          drill: true,
          drillId: "warning-42",
        },
      ),
    );
    expect(response.status).toBe(403);
    expect(mockedRepository.createOrGet).not.toHaveBeenCalled();
  });

  it("persists only in disabled or shadow rollout without invoking trading", async () => {
    process.env.SAFETY_INCIDENT_DRILL_ENABLED = "true";
    mockedRepository.createOrGet.mockResolvedValue({
      created: true,
      event: incidentEvent(),
    });
    const response = await testFire(
      request(
        "http://localhost:3000/api/admin/safety-incidents/test-fire",
        {
          ...baseBody,
          dryRun: false,
          drill: true,
          drillId: "drill-42",
        },
      ),
    );
    expect(response.status).toBe(201);
    expect(mockedRepository.createOrGet).toHaveBeenCalledWith(
      expect.objectContaining({
        incidentType: "TEST_FIRE_WARNING",
        severity: "WARNING",
        dedupKey: "test-fire.warning.drill-42",
        redactedContext: expect.objectContaining({
          operation: "test-fire",
          rolloutMode: "shadow",
          drill: true,
        }),
      }),
    );

    process.env.ROLLOUT_MODE = "paper";
    mockedRepository.createOrGet.mockClear();
    const forbidden = await testFire(
      request(
        "http://localhost:3000/api/admin/safety-incidents/test-fire",
        {
          ...baseBody,
          dryRun: false,
          drill: true,
          drillId: "paper-forbidden",
        },
      ),
    );
    expect(forbidden.status).toBe(409);
    expect(mockedRepository.createOrGet).not.toHaveBeenCalled();
  });

  it("has no run, executor, model, provider, state, trade, or Azure dependency", () => {
    const source = readFileSync(
      "src/app/api/admin/safety-incidents/test-fire/route.ts",
      "utf8",
    );
    expect(source).not.toMatch(
      /run-flow|paper-executor|foundry-agent|market-data-provider|AgentState|TradeExecution|@azure\//,
    );
  });
});
