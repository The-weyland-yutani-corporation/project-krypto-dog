import { scryptSync } from "node:crypto";
import postgres from "postgres";

import {
  runActivationCheck,
  type ActivationCheckReport,
} from "@/deployment/activation-check";
import {
  runProductionVerification,
  type ProductionVerificationOptions,
} from "@/deployment/production-verification";
import { buildIdempotencyKey } from "@/deployment/scheduled-trigger";
import { OBSERVATION_TRUST, scheduledObservationFixture, verifiedCutoverFixture, verifiedScheduledFixture } from "./workflow-observation-fixture";

jest.mock("postgres", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/deployment/activation-check", () => ({ runActivationCheck: jest.fn() }));

const db = jest.mocked(postgres);
const activation = jest.mocked(runActivationCheck);
const NOW = new Date("2026-08-13T13:02:00Z");
const generation = Date.parse("2026-08-13T11:59:55Z") / 1000;
const binding = {
  databaseUrl: "postgresql://test.invalid/krypto",
  releaseSha: "a".repeat(40),
  imageDigest: `sha256:${"b".repeat(64)}`,
  targetOrigin: "https://production.example.com",
  authorizationId: "c".repeat(64),
  scheduleGeneration: generation,
  posthogApiKey: "test-only-project-key",
  posthogHost: "https://us.i.posthog.com",
  posthogEnvironment: "prod",
  approvalSecret: "test-only-approval-secret-with-sufficient-length",
};
const ready: Extract<ProductionVerificationOptions, { phase: "ready" }> = {
  ...binding,
  phase: "ready",
  cronSecret: "test-cron-secret",
  expectedApprovalId: "smoke-approval-id",
  approvalCreatedAfter: "2026-08-13T12:30:00Z",
  expectedShadowIdempotencyKey: "manual-shadow:production-test",
  expectedShadowStartedAfter: "2026-08-13T12:55:00Z",
};
let scheduled: Extract<ProductionVerificationOptions, { phase: "scheduled" }>;
const expectedKey = buildIdempotencyKey(
  "/api/agent/run", new Date("2026-08-13T13:00:01Z"),
  undefined, `${binding.imageDigest}-${generation}`,
);
const safeState = {
  accountingStatus: "RECONCILED", ethBalance: "0.000000000000000000", usdcBalance: "200.00000000",
  isOperatorPaused: false, isLocked: false, isRunning: false,
  leaseOwner: null, leaseExpiresAt: null, fenced: false,
};
const safeRun = {
  id: "paper-run-id", idempotencyKey: expectedKey, triggerSource: "cron", tradingMode: "PAPER",
  outcome: "HOLD", startedAt: new Date("2026-08-13T13:00:02Z"),
  completedAt: new Date("2026-08-13T13:00:30Z"),
  tradeCount: 0, journalCount: 1, tradeJournalCount: 0, errorType: null,
};
const approval: ActivationCheckReport = {
  schemaVersion: "1.0.0", generatedAt: NOW.toISOString(),
  targetOrigin: binding.targetOrigin, releaseSha: binding.releaseSha, imageDigest: binding.imageDigest,
  approved: true, checks: [{ id: "test-approval", status: "pass", summary: "Verified." }], blockers: [],
  shadowRun: {
    id: "shadow-run-id", idempotencyKey: ready.expectedShadowIdempotencyKey,
    outcome: "SHADOW", startedAt: "2026-08-13T12:55:01Z", completedAt: "2026-08-13T12:55:30Z",
    tradeCount: 0, errorType: null,
  },
};

function mockDatabase(
  state: Record<string, unknown> | null = safeState,
  run: Record<string, unknown> | null = safeRun,
) {
  const queries: string[] = [];
  const parameters: unknown[][] = [];
  const sql = Object.assign(jest.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.join(" ").replace(/\s+/g, " ").trim();
    queries.push(query);
    parameters.push(values);
    if (query === "BEGIN READ ONLY" || query === "ROLLBACK" || query.startsWith("SET LOCAL statement_timeout")) return [];
    if (query.includes('FROM "krypto"."AgentState"')) return state === null ? [] : [state];
    if (query.includes('FROM "krypto"."AgentRun"')) return run === null ? [] : [run];
    throw new Error(`Unexpected SQL: ${query}`);
  }), { end: jest.fn(async () => undefined) });
  db.mockReturnValue(sql as never);
  return { queries, parameters };
}

describe("read-only paper production verification", () => {
  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(NOW);
    db.mockReset();
    activation.mockReset().mockResolvedValue(structuredClone(approval));
    const defaults = scheduledObservationFixture({}, NOW);
    scheduled = {
      ...binding, phase: "scheduled", opsImageDigest: defaults.opsImageDigest,
      observation: await verifiedScheduledFixture({
        workflow: { ...OBSERVATION_TRUST, sha: binding.releaseSha, runId: "9876", runAttempt: 1 },
        releaseSha: binding.releaseSha, imageDigest: binding.imageDigest, targetOrigin: binding.targetOrigin,
        scheduleGeneration: generation, scheduleEnabledAt: "2026-08-13T12:00:05.000Z",
        execution: { ...defaults.execution, imageDigest: binding.imageDigest },
      }, NOW),
    };
  });
  afterEach(() => jest.useRealTimers());

  it("requires exact fresh smoke approval and shadow proof without a mutation", async () => {
    const { queries } = mockDatabase();
    const report = await runProductionVerification(ready);
    expect(report.approved).toBe(true);
    expect(activation).toHaveBeenCalledWith(expect.objectContaining({
      approvalProof: {
        approvalId: ready.expectedApprovalId, createdAfter: ready.approvalCreatedAfter, maxAgeSeconds: 3600,
      },
    }));
    expect(report).toMatchObject({ intendedMode: "paper", approvalId: ready.expectedApprovalId, scheduledRun: null });
    expect(queries[0]).toBe("BEGIN READ ONLY");
    expect(queries).toContain("ROLLBACK");
    expect(queries.every((query) => !/\b(INSERT|UPDATE|DELETE|COMMIT)\b/.test(query))).toBe(true);
    expect(JSON.stringify(report)).not.toContain(binding.posthogApiKey);
    expect(JSON.stringify(report)).not.toContain(binding.approvalSecret);
    expect(report.schemaVersion).toBe("1.3.0");
    expect(report.workflowObservation).toBeNull();
    expect(report.scheduledExecution).toBeNull();
    expect(report.posthog).not.toHaveProperty("keySha256");
    expect(report.posthog.keyBinding).toBe(scryptSync(
      binding.posthogApiKey,
      JSON.stringify(["production-posthog-key-binding", 2, binding.posthogHost, binding.approvalSecret]),
      32,
      { cost: 131_072, blockSize: 8, parallelization: 1, maxmem: 256 * 1024 * 1024 },
    ).toString("hex"));
  });

  it("binds telemetry to the ops-only secret, host and project key consistently across phases", async () => {
    mockDatabase();
    const initial = (await runProductionVerification(ready)).posthog.keyBinding;
    expect((await runProductionVerification(scheduled)).posthog.keyBinding).toBe(initial);
    for (const overrides of [
      { approvalSecret: "a-different-test-only-approval-secret-of-sufficient-length" },
      { posthogHost: "https://eu.i.posthog.com" },
      { posthogApiKey: "another-test-only-project-key" },
    ]) {
      const report = await runProductionVerification({ ...scheduled, ...overrides });
      expect(report.posthog.keyBinding).toMatch(/^[0-9a-f]{64}$/);
      expect(report.posthog.keyBinding).not.toBe(initial);
    }
  });

  it.each([
    ["ready", ""], ["ready", "too-short"], ["scheduled", ""], ["scheduled", "too-short"],
  ])("requires the ops-only binding secret before reading either phase (%s)", async (phase, approvalSecret) => {
    const options = { ...(phase === "ready" ? ready : scheduled), approvalSecret };
    await expect(runProductionVerification(options)).rejects.toThrow("DEPLOYMENT_APPROVAL_SECRET");
    expect(db).not.toHaveBeenCalled();
    expect(activation).not.toHaveBeenCalled();
  });

  it.each([
    { approved: false }, { checks: [] }, { blockers: ["blocked"] }, { shadowRun: undefined },
    { shadowRun: { ...approval.shadowRun!, outcome: "LOCKED" } },
    { shadowRun: { ...approval.shadowRun!, tradeCount: 1 } },
    { shadowRun: { ...approval.shadowRun!, errorType: "journal-failed" } },
    { shadowRun: { ...approval.shadowRun!, completedAt: "2026-08-13T14:00:00Z" } },
    { shadowRun: { ...approval.shadowRun!, startedAt: "2026-08-13T12:54:59Z" } },
  ])("never treats an incomplete activation result as production-ready: %j", async (overrides) => {
    mockDatabase();
    activation.mockResolvedValue({ ...approval, ...overrides });
    expect((await runProductionVerification(ready)).approved).toBe(false);
  });

  it.each(["HOLD", "REJECTED"])("accepts a real scheduled %s without requiring a fill", async (outcome) => {
    const { queries, parameters } = mockDatabase(safeState, { ...safeRun, outcome });
    const report = await runProductionVerification(scheduled);
    expect(report.approved).toBe(true);
    expect(report.scheduledRun).toMatchObject({ id: safeRun.id, idempotencyKey: expectedKey, outcome, tradeCount: 0 });
    expect(expectedKey).toBe(`cron:${binding.imageDigest}-${generation}:2026-08-13T13`);
    expect(parameters.flat()).toContain(expectedKey);
    expect(queries.join(" ")).not.toContain(expectedKey);
    expect(activation).not.toHaveBeenCalled();
    expect(report.workflowObservation).toEqual(scheduled.observation.receipt);
    expect(report.scheduledExecution).toMatchObject({
      originAssurance: "schedule-observed-not-origin-proven",
      scheduleEnabledAt: "2026-08-13T12:00:05.000Z",
    });
  });

  it("accepts a journaled scheduled paper BUY without wrongly requiring a flat post-run position", async () => {
    mockDatabase(
      { ...safeState, ethBalance: "0.005000000000000001", usdcBalance: "180.00000000" },
      { ...safeRun, outcome: "EXECUTED", tradeCount: 1, tradeJournalCount: 1 },
    );
    expect((await runProductionVerification(scheduled)).approved).toBe(true);
  });

  it("rejects a copied verification object before reading the database", async () => {
    await expect(runProductionVerification({ ...scheduled, observation: { ...scheduled.observation } }))
      .rejects.toThrow("cryptographically verified");
    expect(db).not.toHaveBeenCalled();
  });

  it("rejects a valid proof for another purpose before reading the database", async () => {
    await expect(runProductionVerification({
      ...scheduled, observation: await verifiedCutoverFixture({}, NOW),
    })).rejects.toThrow("exact production release");
    expect(db).not.toHaveBeenCalled();
  });

  it.each([
    { outcome: "RUNNING", completedAt: null }, { outcome: "LOCKED" },
    { outcome: "INTERNAL_ERROR" }, { outcome: "DISABLED" }, { tradingMode: "SHADOW" },
    { triggerSource: "admin" }, { idempotencyKey: "cron:old-image:2026-08-13T13" },
    { completedAt: new Date("2026-08-13T13:03:00Z") },
    { startedAt: new Date("2026-08-13T12:59:59Z") },
    { completedAt: new Date("2026-08-13T13:00:00Z") },
    { completedAt: new Date("2026-08-13T13:00:31Z") },
    { tradeCount: 1 }, { journalCount: 0 }, { errorType: "journal-failed" },
    { outcome: "EXECUTED", tradeCount: 1, tradeJournalCount: 0 },
    { outcome: "EXECUTED", tradeCount: 0 },
  ])("rejects invalid scheduled-run proof: %j", async (overrides) => {
    mockDatabase(safeState, { ...safeRun, ...overrides });
    expect((await runProductionVerification(scheduled)).approved).toBe(false);
  });

  it.each([
    { accountingStatus: "QUARANTINED" }, { ethBalance: null }, { usdcBalance: null },
    { ethBalance: "-0.000000000000000001" }, { usdcBalance: "0.000000001" },
    { ethBalance: "0e-300" }, { isOperatorPaused: true }, { isOperatorPaused: null },
    { isLocked: true }, { isRunning: true }, { leaseOwner: "another-run" },
    { leaseExpiresAt: new Date("2026-08-13T10:00:00Z") }, { fenced: true },
  ])("blocks unsafe or unverifiable post-run state: %j", async (overrides) => {
    mockDatabase({ ...safeState, ...overrides });
    expect((await runProductionVerification(scheduled)).approved).toBe(false);
  });

  it("blocks missing state and missing run independently", async () => {
    mockDatabase(null);
    expect((await runProductionVerification(scheduled)).approved).toBe(false);
    mockDatabase(safeState, null);
    expect((await runProductionVerification(scheduled)).approved).toBe(false);
  });

  it("turns a database failure into explicit blocked evidence without leaking its message", async () => {
    db.mockImplementation(() => { throw new Error("connection failed with private credential"); });
    const report = await runProductionVerification(scheduled);
    expect(report.approved).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "production-database-read", status: "block" }));
    expect(JSON.stringify(report)).not.toContain("private credential");
  });

  it.each([
    { authorizationId: "" }, { scheduleGeneration: 0 }, { scheduleGeneration: NOW.getTime() },
    { posthogApiKey: "" }, { posthogEnvironment: "dev" }, { posthogHost: "https://collector.example.com" },
    { targetOrigin: "http://production.example.com" },
    { releaseSha: "f".repeat(40) }, { imageDigest: `sha256:${"f".repeat(64)}` },
    { opsImageDigest: `sha256:${"f".repeat(64)}` }, { scheduleGeneration: generation + 1 },
    { authorizationId: "f".repeat(64) }, { targetOrigin: "https://another.example.com" },
  ])("rejects unbound production inputs before a database read: %j", async (overrides) => {
    await expect(runProductionVerification({ ...scheduled, ...overrides })).rejects.toThrow();
    expect(db).not.toHaveBeenCalled();
  });

  it("rejects legacy caller-only timestamps without a verified observation", async () => {
    await expect(Reflect.apply(runProductionVerification, undefined, [{
      ...binding, phase: "scheduled", scheduleEnabledAt: generation + 10,
      scheduledExecutionStartedAt: "2026-08-13T13:00:01Z",
    }])).rejects.toThrow("cryptographically verified");
    expect(db).not.toHaveBeenCalled();
  });

  it("rechecks signed-proof freshness after a slow database read", async () => {
    const database = mockDatabase();
    db.mockImplementationOnce(() => {
      jest.setSystemTime(new Date(NOW.getTime() + 181_000));
      return Object.assign(jest.fn(async (parts: TemplateStringsArray) => {
        const query = parts.join(" ");
        if (query.includes('FROM "krypto"."AgentState"')) return [safeState];
        if (query.includes('FROM "krypto"."AgentRun"')) return [safeRun];
        return [];
      }), { end: jest.fn(async () => undefined) }) as never;
    });
    await expect(runProductionVerification(scheduled)).rejects.toThrow("expired");
    expect(database.queries).toEqual([]);
  });
});
