import postgres from "postgres";

import {
  DEPLOYMENT_FENCE_TIMEOUT_SECONDS,
  runDeploymentAdmission,
  validateDeploymentFenceAction,
  type DeploymentAdmissionOptions,
} from "@/deployment/deployment-admission";
import {
  canonicalApprovalPayload,
  computeApprovalSignature,
  cronSecretBinding,
} from "@/deployment/target-smoke";

jest.mock("postgres", () => {
  const actual = jest.requireActual<typeof postgres>("postgres");
  return {
    __esModule: true,
    default: Object.assign(jest.fn(), { PostgresError: actual.PostgresError }),
  };
});

const mockedPostgres = jest.mocked(postgres);
const NOW = new Date("2026-10-21T12:00:00.000Z");
const EXPIRY = new Date(NOW.getTime() + DEPLOYMENT_FENCE_TIMEOUT_SECONDS * 1000);
const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER_OWNER = "22222222-2222-4222-8222-222222222222";
const BASE: DeploymentAdmissionOptions & { action: "acquire" } = {
  action: "acquire",
  databaseUrl: "postgres://ops:secret@127.0.0.1/krypto",
  owner: OWNER,
  sourceReleaseSha: "a".repeat(40),
  candidateReleaseSha: "b".repeat(40),
  imageDigest: `sha256:${"c".repeat(64)}`,
  targetOrigin: "https://krypto.example.com",
  cronSecret: "private-cron-secret",
  approvalSecret: "private-deployment-approval-secret-32-characters",
};

function createSqlMock(options: {
  state?: Record<string, unknown> | null;
  fence?: Record<string, unknown> | null;
  approval?: Record<string, unknown> | null;
  bindingExists?: boolean;
  invalidSignature?: boolean;
  failure?: Error;
} = {}) {
  const statements: string[] = [];
  const journalRecords: unknown[] = [];
  const payload = {
    bindingId: "source-binding",
    targetOrigin: BASE.targetOrigin,
    releaseSha: BASE.sourceReleaseSha,
    imageDigest: BASE.imageDigest,
    rolloutMode: "disabled",
    cronSecretBinding: cronSecretBinding(BASE.cronSecret, BASE.approvalSecret),
  };
  const fences: Array<Record<string, unknown>> = options.fence
    ? [{
        owner: OWNER,
        sourceReleaseSha: BASE.sourceReleaseSha,
        candidateReleaseSha: BASE.candidateReleaseSha,
        imageDigest: BASE.imageDigest,
        targetOrigin: BASE.targetOrigin,
        expiresAt: EXPIRY,
        releasedAt: null,
        ...options.fence,
      }]
    : [];
  const tag = jest.fn(
    async (first: TemplateStringsArray, ...values: unknown[]) => {
      const query = Array.from(first).join(" ").replace(/\s+/g, " ").trim();
      statements.push(query);
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(query)) return [];
      if (options.failure) throw options.failure;
      if (query.startsWith("SET LOCAL")) return [];
      if (query === 'SELECT clock_timestamp() AS "observedAt"') {
        return [{ observedAt: NOW }];
      }
      if (query.includes('FROM "krypto"."AgentState"')) {
        return options.state === null
          ? []
          : [{
              accountingStatus: "RECONCILED",
              ethBalance: "0.000000000000000000",
              isOperatorPaused: false,
              isLocked: false,
              isRunning: false,
              leaseOwner: null,
              leaseExpiresAt: null,
              ...options.state,
            }];
      }
      if (query.includes('FROM "krypto"."DeploymentFence"')) {
        const match = fences.find((fence) => fence.releasedAt === null)
          ?? fences.find((fence) => fence.owner === values[0]);
        return match ? [match] : [];
      }
      if (query.includes("'deployment-smoke-approved'")) {
        return options.approval === null
          ? []
          : [{
              id: "source-approval",
              createdAt: NOW,
              ...payload,
              approvalSignature: options.invalidSignature
                ? "0".repeat(64)
                : computeApprovalSignature(
                    canonicalApprovalPayload(payload),
                    BASE.approvalSecret,
                  ),
              ...options.approval,
            }];
      }
      if (query.includes("AgentJournal") && query.startsWith("SELECT")) {
        return options.bindingExists === false
          ? []
          : [{ event: "deployment-smoke-binding" }];
      }
      if (query.startsWith('INSERT INTO "krypto"."DeploymentFence"')) {
        fences.push({
          owner: values[0],
          sourceReleaseSha: values[1],
          candidateReleaseSha: values[2],
          imageDigest: values[3],
          targetOrigin: values[4],
          expiresAt: EXPIRY,
          releasedAt: null,
        });
        return [{ expiresAt: EXPIRY }];
      }
      if (query.startsWith('UPDATE "krypto"."DeploymentFence"')) {
        const match = fences.find((fence) => fence.owner === values[0]);
        if (match) match.releasedAt = NOW;
        return [];
      }
      if (query.startsWith('INSERT INTO "krypto"."AgentJournal"')) return [];
      throw new Error(`Unhandled SQL in admission test: ${query}`);
    },
  );
  const tx = Object.assign(tag, {
    release: jest.fn(),
    json: jest.fn((value: unknown) => {
      journalRecords.push(value);
      return value;
    }),
  });
  const sql = Object.assign(jest.fn(), {
    reserve: jest.fn(async () => tx),
    end: jest.fn(async () => undefined),
  });
  mockedPostgres.mockReturnValue(sql as never);
  return {
    sql,
    fences,
    statements,
    journalRecords,
    writes: () => statements.filter((query) => /^(INSERT|UPDATE|DELETE)/.test(query)),
  };
}

describe("owned deployment cutover admission", () => {
  beforeEach(() => mockedPostgres.mockReset());

  it("locks state before reading the fence, then atomically acquires and journals it", async () => {
    const mock = createSqlMock();
    const result = await runDeploymentAdmission(BASE);

    expect(result).toMatchObject({
      status: "admitted",
      reason: "fence-acquired",
      owner: OWNER,
      expiresAt: EXPIRY.toISOString(),
    });
    const stateIndex = mock.statements.findIndex((query) => query.includes('FROM "krypto"."AgentState"'));
    const fenceIndex = mock.statements.findIndex((query) => query.includes('FROM "krypto"."DeploymentFence"'));
    expect(mock.statements[stateIndex]).toContain("FOR UPDATE");
    expect(fenceIndex).toBeGreaterThan(stateIndex);
    expect(mock.writes()).toHaveLength(2);
    expect(mock.writes()[0]).toContain('"DeploymentFence"');
    expect(mock.writes()[1]).toContain('"AgentJournal"');
    expect(mock.journalRecords[0]).toMatchObject({
      event: "deployment-fence-acquired",
      owner: OWNER,
      candidateReleaseSha: BASE.candidateReleaseSha,
    });
    expect(mock.sql.end).toHaveBeenCalled();
    expect(mock.statements.at(-1)).toBe("COMMIT");
    expect(JSON.stringify(result)).not.toContain(BASE.cronSecret);
    expect(JSON.stringify(result)).not.toContain(BASE.approvalSecret);
    expect(JSON.stringify(result)).not.toContain(BASE.databaseUrl);
  });

  it.each([
    ["open-position", { ethBalance: "0.000000000000000001" }],
    ["run-lease", {
      isRunning: true,
      leaseOwner: "busy",
      leaseExpiresAt: new Date(NOW.getTime() + 60_000),
    }],
  ])("defers %s before any database mutation", async (reason, state) => {
    const mock = createSqlMock({ state });
    expect(await runDeploymentAdmission(BASE)).toMatchObject({ status: "deferred", reason });
    expect(mock.writes()).toEqual([]);
  });

  it("supports the same UUID v5 owner through acquisition, verification, and release", async () => {
    const mock = createSqlMock();
    const binding = { ...BASE, owner: "34aa399d-f243-5b32-832f-e399e1f22b74" };
    expect((await runDeploymentAdmission(binding)).status).toBe("admitted");
    expect((await runDeploymentAdmission({ ...binding, action: "verify" })).status).toBe("held");
    expect((await runDeploymentAdmission({ ...binding, action: "release" })).status).toBe("released");
    const writes = mock.writes().length;
    expect((await runDeploymentAdmission(binding)).reason).toBe("released-owner");
    expect(mock.writes()).toHaveLength(writes);
  });

  it.each([
    ["stop-control", { isOperatorPaused: true }],
    ["stop-control", { isLocked: true }],
    ["stop-control", { isOperatorPaused: null }],
    ["stop-control", { isLocked: undefined }],
    ["stop-control", { isLocked: 0 }],
    ["stop-control", { isOperatorPaused: "false" }],
    ["accounting", { accountingStatus: "QUARANTINED" }],
    ["accounting", { accountingStatus: "UNINITIALIZED" }],
    ["invalid-position", { ethBalance: null }],
    ["invalid-position", { ethBalance: "NaN" }],
    ["invalid-position", { ethBalance: "Infinity" }],
    ["invalid-position", { ethBalance: "" }],
    ["invalid-position", { ethBalance: "-0.000000000000000001" }],
    ["invalid-position", { ethBalance: "0.0000000000000000001" }],
    ["invalid-lease", { isRunning: null }],
    ["invalid-lease", { isRunning: "false" }],
    ["invalid-lease", { isRunning: true }],
    ["invalid-lease", { leaseOwner: "busy" }],
    ["invalid-lease", { leaseExpiresAt: new Date(NOW.getTime() - 1000) }],
    ["invalid-lease", {
      isRunning: true,
      leaseOwner: "busy",
      leaseExpiresAt: new Date("invalid"),
    }],
    ["expired-lease", {
      isRunning: true,
      leaseOwner: "expired",
      leaseExpiresAt: NOW,
    }],
  ])("blocks unsafe state %s without mutating it", async (reason, state) => {
    const mock = createSqlMock({ state });
    expect(await runDeploymentAdmission(BASE)).toMatchObject({ status: "blocked", reason });
    expect(mock.writes()).toEqual([]);
  });

  it("blocks missing state", async () => {
    const mock = createSqlMock({ state: null });
    expect(await runDeploymentAdmission(BASE)).toMatchObject({ status: "blocked", reason: "missing-state" });
    expect(mock.writes()).toEqual([]);
  });

  it.each([
    { approval: null },
    { approval: { releaseSha: "d".repeat(40) } },
    { approval: { imageDigest: `sha256:${"e".repeat(64)}` } },
    { approval: { targetOrigin: "https://elsewhere.example.com" } },
    { approval: { rolloutMode: "paper" } },
    { approval: { cronSecretBinding: "invalid" } },
    { approval: { approvalSignature: null } },
    { bindingExists: false },
    { invalidSignature: true },
  ])("requires a genuine exact-source database binding: %j", async (options) => {
    const mock = createSqlMock(options);
    expect(await runDeploymentAdmission(BASE)).toMatchObject({
      status: "blocked",
      reason: "source-binding",
    });
    expect(mock.writes()).toEqual([]);
  });

  it("reuses only its exact unexpired fence without extending its deadline", async () => {
    const mock = createSqlMock({ fence: {} });
    expect(await runDeploymentAdmission(BASE)).toMatchObject({
      status: "admitted",
      reason: "already-owned",
      expiresAt: EXPIRY.toISOString(),
    });
    expect(mock.writes()).toEqual([]);
  });

  it.each([
    { owner: OTHER_OWNER },
    { candidateReleaseSha: "e".repeat(40) },
    { sourceReleaseSha: "d".repeat(40) },
    { imageDigest: `sha256:${"f".repeat(64)}` },
    { targetOrigin: "https://elsewhere.example.com" },
  ])("never steals or rebinds an active fence: %j", async (fence) => {
    const mock = createSqlMock({ fence });
    expect(await runDeploymentAdmission(BASE)).toMatchObject({
      status: "blocked",
      reason: "ownership-mismatch",
    });
    expect(mock.writes()).toEqual([]);
  });

  it.each([OWNER, OTHER_OWNER])("never expires or steals owner %s automatically", async (owner) => {
    const mock = createSqlMock({ fence: { owner, expiresAt: NOW } });
    expect(await runDeploymentAdmission(BASE)).toMatchObject({
      status: "blocked",
      reason: "expired-fence",
    });
    expect(mock.writes()).toEqual([]);
  });

  it("will not re-arm the same completed owner", async () => {
    const mock = createSqlMock({ fence: { releasedAt: NOW } });
    expect(await runDeploymentAdmission(BASE)).toMatchObject({ status: "blocked", reason: "released-owner" });
    expect(mock.writes()).toEqual([]);
  });

  it("retains the previous tombstone when a fresh owner acquires", async () => {
    const mock = createSqlMock({ fence: { owner: OTHER_OWNER, releasedAt: NOW } });
    expect(await runDeploymentAdmission(BASE)).toMatchObject({ status: "admitted" });
    expect(mock.writes()[0]).not.toContain("ON CONFLICT");
    expect(mock.fences).toHaveLength(2);
    expect(mock.fences[0]).toMatchObject({ owner: OTHER_OWNER, releasedAt: NOW });
  });

  it("rejects completed-owner replay even after a different cutover has completed", async () => {
    const mock = createSqlMock();
    expect((await runDeploymentAdmission(BASE)).status).toBe("admitted");
    expect((await runDeploymentAdmission({ ...BASE, action: "release" })).status).toBe("released");
    expect((await runDeploymentAdmission({ ...BASE, owner: OTHER_OWNER })).status).toBe("admitted");
    expect((await runDeploymentAdmission({ ...BASE, owner: OTHER_OWNER, action: "release" })).status).toBe("released");
    const writes = mock.writes().length;
    expect(await runDeploymentAdmission(BASE)).toMatchObject({
      status: "blocked", reason: "released-owner",
    });
    expect(mock.writes()).toHaveLength(writes);
    expect(mock.fences).toHaveLength(2);
    expect(mock.fences.every((fence) => fence.releasedAt === NOW)).toBe(true);
  });

  it("does not mistake an old tombstone for permission to release a newer active owner", async () => {
    createSqlMock();
    await runDeploymentAdmission(BASE);
    await runDeploymentAdmission({ ...BASE, action: "release" });
    await runDeploymentAdmission({ ...BASE, owner: OTHER_OWNER });
    expect(await runDeploymentAdmission({ ...BASE, action: "release" })).toMatchObject({
      status: "blocked", reason: "ownership-mismatch",
    });
  });

  it("verifies a held fence without writes or extending its deadline", async () => {
    const mock = createSqlMock({ fence: {} });
    expect(await runDeploymentAdmission({ ...BASE, action: "verify" })).toMatchObject({
      status: "held",
      expiresAt: EXPIRY.toISOString(),
    });
    expect(mock.writes()).toEqual([]);
  });

  it.each([null, { owner: OTHER_OWNER }, { releasedAt: NOW }, { expiresAt: NOW }])(
    "does not verify a missing, foreign, released, or expired fence: %j",
    async (fence) => {
      const mock = createSqlMock({ fence });
      expect(await runDeploymentAdmission({ ...BASE, action: "verify" })).toMatchObject({ status: "blocked" });
      expect(mock.writes()).toEqual([]);
    },
  );

  it("does not verify a fence after an operator stop", async () => {
    const mock = createSqlMock({ fence: {}, state: { isOperatorPaused: true } });
    expect(await runDeploymentAdmission({ ...BASE, action: "verify" })).toMatchObject({
      status: "blocked", reason: "stop-control",
    });
    expect(mock.writes()).toEqual([]);
  });

  it("releases only its fence, retaining stop controls and the ownership tombstone", async () => {
    const mock = createSqlMock({
      fence: {},
      state: { isOperatorPaused: true, isLocked: true },
    });
    const result = await runDeploymentAdmission({ ...BASE, action: "release" });
    expect(result).toMatchObject({ status: "released", reason: "fence-released" });
    expect(mock.writes()).toHaveLength(2);
    expect(mock.writes()[0]).toContain('SET "releasedAt" = clock_timestamp()');
    expect(mock.writes().join(" ")).not.toMatch(/UPDATE "krypto"\."AgentState"|DELETE/);
    expect(mock.journalRecords[0]).toMatchObject({ event: "deployment-fence-released", owner: OWNER });
  });

  it("allows owned compensation after expiry, but does not remove the tombstone", async () => {
    const mock = createSqlMock({ fence: { expiresAt: NOW } });
    expect(await runDeploymentAdmission({ ...BASE, action: "release" })).toMatchObject({ status: "released" });
    expect(mock.writes()[0]).toContain("UPDATE");
    expect(mock.writes().join(" ")).not.toContain("DELETE");
  });

  it.each([null, { owner: OTHER_OWNER }, { candidateReleaseSha: "e".repeat(40) }])(
    "rejects a missing or differently owned release: %j",
    async (fence) => {
      const mock = createSqlMock({ fence });
      expect(await runDeploymentAdmission({ ...BASE, action: "release" })).toMatchObject({
        status: "blocked",
        reason: "ownership-mismatch",
      });
      expect(mock.writes()).toEqual([]);
    },
  );

  it("makes a repeated exact release idempotent without new writes", async () => {
    const mock = createSqlMock({ fence: { releasedAt: NOW } });
    expect(await runDeploymentAdmission({ ...BASE, action: "release" })).toMatchObject({
      status: "released",
      reason: "already-released",
    });
    expect(mock.writes()).toEqual([]);
  });

  it.each([
    { ethBalance: "1" },
    { leaseOwner: "still-running" },
    { accountingStatus: "QUARANTINED" },
  ])("does not release a fence over unsafe trading state: %j", async (state) => {
    const mock = createSqlMock({ fence: {}, state });
    expect(await runDeploymentAdmission({ ...BASE, action: "release" })).toMatchObject({ status: "blocked" });
    expect(mock.writes()).toEqual([]);
  });

  it("reports database failures without leaking connection or secret text", async () => {
    const mock = createSqlMock({ failure: new Error(BASE.databaseUrl) });
    const result = await runDeploymentAdmission(BASE);
    expect(result).toMatchObject({ status: "blocked", reason: "database-error" });
    expect(JSON.stringify(result)).not.toContain(BASE.databaseUrl);
    expect(mock.sql.end).toHaveBeenCalled();
    expect(mock.statements.at(-1)).toBe("ROLLBACK");
  });

  it.each(["acquire", "release"] as const)("does not report %s lock timeout as successful ownership", async (action) => {
    const failure = new Error("lock not available");
    Object.setPrototypeOf(failure, postgres.PostgresError.prototype);
    Object.assign(failure, { code: "55P03" });
    createSqlMock({ failure });
    expect(await runDeploymentAdmission({ ...BASE, action })).toMatchObject({
      status: action === "acquire" ? "deferred" : "blocked",
      reason: "database-busy",
    });
  });

  it.each([
    { owner: "../owner" },
    { owner: OWNER.toUpperCase().replace("11111111", "AAAAAAAA") },
    { sourceReleaseSha: "main" },
    { candidateReleaseSha: "short" },
    { imageDigest: "latest" },
    { targetOrigin: "http://remote.example.com" },
    { targetOrigin: "https://krypto.example.com/path" },
    { approvalSecret: "short" },
    { cronSecret: "" },
    { databaseUrl: "" },
  ])("rejects malformed invocation inputs before connecting: %j", async (overrides) => {
    await expect(runDeploymentAdmission({ ...BASE, ...overrides })).rejects.toThrow();
    expect(mockedPostgres).not.toHaveBeenCalled();
  });

  it("does not accept an arbitrary operation action", () => {
    expect(() => validateDeploymentFenceAction("unpause")).toThrow(/acquire, verify, or release/);
  });
});
