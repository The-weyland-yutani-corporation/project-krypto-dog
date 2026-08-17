import {
  canonicalApprovalPayload,
  computeApprovalSignature,
  cronSecretBinding,
} from "@/deployment/target-smoke";

import {
  ACTIVATION_CHECK_SCHEMA_VERSION,
  MAX_APPROVAL_AGE_MS,
  runActivationCheck,
  type ActivationCheckOptions,
} from "@/deployment/activation-check";
import postgres from "postgres";

jest.mock("postgres", () => ({
  __esModule: true,
  default: jest.fn(),
}));

const mockedPostgres = jest.mocked(postgres);

const RELEASE_SHA = "c0e4ed2724a9880d5a5dfcdf954490f2d86e8e2f";
const IMAGE_DIGEST =
  "sha256:d32ebcff1be028d183b8ba7ce4e1506b0adf3a7a90b02d5c6a202fabceaf1e68";
const TARGET_ORIGIN = "https://krypto.example.com";
const CRON_SECRET = "cron-secret-value";
const APPROVAL_SECRET = "approval-secret-of-sufficient-length-x";
const DEFAULT_BINDING_ID =
  "deployment-smoke-binding-123e4567-e89b-42d3-a456-426614174000";
const APPROVAL_ID =
  "deployment-smoke-approved-123e4567-e89b-42d3-a456-426614174001";
const MODE_MISMATCH_EVIDENCE_ID =
  "deployment-smoke-mode-mismatch-123e4567-e89b-42d3-a456-426614174002";
const CRON_EVIDENCE_ID =
  "deployment-smoke-cron-123e4567-e89b-42d3-a456-426614174003";
const ADMIN_EVIDENCE_ID =
  "deployment-smoke-admin-123e4567-e89b-42d3-a456-426614174004";
const APPROVED_AT = "2026-08-14T00:00:00.000Z";
const CHECKED_AT = new Date("2026-08-14T01:00:00.000Z");

const BASE_OPTIONS: ActivationCheckOptions = {
  databaseUrl: "******db.example.com/postgres",
  releaseSha: RELEASE_SHA,
  imageDigest: IMAGE_DIGEST,
  targetOrigin: TARGET_ORIGIN,
  cronSecret: CRON_SECRET,
  approvalSecret: APPROVAL_SECRET,
  expectedShadowIdempotencyKey: "manual-shadow:run123-a1",
  expectedShadowStartedAfter: "2026-08-13T12:00:00Z",
};

type ApprovalRowOverrides = Partial<{
  id: string;
  createdAt: string;
  sameTimestampCount: number;
  bindingId: string | null;
  modeMismatchEvidenceId: string | null;
  cronEvidenceId: string | null;
  adminEvidenceId: string | null;
  targetOrigin: string | null;
  cronSecretBinding: string | null;
  releaseSha: string | null;
  imageDigest: string | null;
  rolloutMode: string | null;
  approvedAt: string | null;
  approvalSignature: string | null;
}>;

type AgentStateOverrides = Partial<{
  accountingStatus: string;
  ethBalance: string | null;
  isRunning: boolean;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
}>;

type ShadowRunOverrides = Partial<{
  id: string;
  idempotencyKey: string;
  triggerSource: string;
  tradingMode: string;
  outcome: string;
  startedAt: Date;
  completedAt: Date | null;
  tradeCount: number;
}>;

/**
 * Builds a fully self-consistent, genuinely-signed approval row (as if
 * `createTargetApproval` had persisted it with APPROVAL_SECRET), including
 * any requested field overrides. Tests that model post-signature tampering
 * explicitly retain the baseline signature.
 */
function buildApprovalRow(
  overrides: ApprovalRowOverrides = {},
): Record<string, unknown> {
  const bindingId =
    overrides.bindingId === undefined ? DEFAULT_BINDING_ID : overrides.bindingId;
  const approvalId =
    overrides.id === undefined ? APPROVAL_ID : overrides.id;
  const modeMismatchEvidenceId =
    overrides.modeMismatchEvidenceId === undefined
      ? MODE_MISMATCH_EVIDENCE_ID
      : overrides.modeMismatchEvidenceId;
  const cronEvidenceId =
    overrides.cronEvidenceId === undefined
      ? CRON_EVIDENCE_ID
      : overrides.cronEvidenceId;
  const adminEvidenceId =
    overrides.adminEvidenceId === undefined
      ? ADMIN_EVIDENCE_ID
      : overrides.adminEvidenceId;
  const targetOrigin =
    overrides.targetOrigin === undefined
      ? TARGET_ORIGIN
      : overrides.targetOrigin;
  const releaseSha =
    overrides.releaseSha === undefined ? RELEASE_SHA : overrides.releaseSha;
  const imageDigest =
    overrides.imageDigest === undefined ? IMAGE_DIGEST : overrides.imageDigest;
  const rolloutMode =
    overrides.rolloutMode === undefined ? "disabled" : overrides.rolloutMode;
  const cronSecretBindingValue =
    overrides.cronSecretBinding === undefined
      ? cronSecretBinding(CRON_SECRET, APPROVAL_SECRET)
      : overrides.cronSecretBinding;
  const approvedAt =
    overrides.approvedAt === undefined ? APPROVED_AT : overrides.approvedAt;
  const approvalSignatureValue =
    overrides.approvalSignature === undefined
      ? computeApprovalSignature(
          canonicalApprovalPayload({
            approvalId,
            bindingId: bindingId ?? "",
            modeMismatchEvidenceId: modeMismatchEvidenceId ?? "",
            cronEvidenceId: cronEvidenceId ?? "",
            adminEvidenceId: adminEvidenceId ?? "",
            targetOrigin: targetOrigin ?? "",
            releaseSha: releaseSha ?? "",
            imageDigest: imageDigest ?? "",
            rolloutMode: rolloutMode ?? "",
            cronSecretBinding: cronSecretBindingValue ?? "",
            approvedAt: approvedAt ?? "",
          }),
          APPROVAL_SECRET,
        )
      : overrides.approvalSignature;

  return {
    id: approvalId,
    createdAt: overrides.createdAt ?? APPROVED_AT,
    sameTimestampCount: overrides.sameTimestampCount ?? 1,
    bindingId,
    modeMismatchEvidenceId,
    cronEvidenceId,
    adminEvidenceId,
    targetOrigin,
    cronSecretBinding: cronSecretBindingValue,
    releaseSha,
    imageDigest,
    rolloutMode,
    approvedAt,
    approvalSignature: approvalSignatureValue,
  };
}

function createSqlMock(options: {
  approval?: ApprovalRowOverrides | null;
  bindingExists?: boolean;
  bindingRowId?: string | null;
  agentState?: AgentStateOverrides | null;
  shadowRun?: ShadowRunOverrides | null;
}) {
  const calls: string[] = [];
  const {
    approval = {},
    bindingExists = true,
    bindingRowId = DEFAULT_BINDING_ID,
    agentState = {},
    shadowRun = {},
  } = options;
  const sql = jest.fn(
    async (
      first: TemplateStringsArray | string,
      ..._values: unknown[]
    ): Promise<unknown> => {
      const query = Array.from(first).join(" ").replace(/\s+/g, " ").trim();
      calls.push(query);
      if (
        query === "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" ||
        query === "SET LOCAL TIME ZONE 'UTC'" ||
        query === "SET LOCAL TIME ZONE DEFAULT" ||
        query.startsWith("SET LOCAL statement_timeout") ||
        query === "ROLLBACK"
      ) {
        return [];
      }
      if (query.includes("'deployment-smoke-approved'")) {
        if (approval === null) return [];
        return [buildApprovalRow(approval)];
      }
      if (query.includes("WHERE id =") && query.includes("AgentJournal")) {
        return bindingExists
          ? [{
              event: "deployment-smoke-binding",
              bindingId: bindingRowId,
            }]
          : [];
      }
      if (query.includes('FROM "krypto"."AgentState"')) {
        if (agentState === null) return [];
        return [
          {
            accountingStatus: agentState.accountingStatus ?? "RECONCILED",
            ethBalance:
              agentState.ethBalance === undefined
                ? "0"
                : agentState.ethBalance,
            isRunning: agentState.isRunning ?? false,
            leaseOwner:
              agentState.leaseOwner === undefined
                ? null
                : agentState.leaseOwner,
            leaseExpiresAt:
              agentState.leaseExpiresAt === undefined
                ? null
                : agentState.leaseExpiresAt,
          },
        ];
      }
      if (query.includes('FROM "krypto"."AgentRun"')) {
        if (shadowRun === null) return [];
        return [
          {
            id: shadowRun.id ?? "shadow-run-id",
            idempotencyKey:
              shadowRun.idempotencyKey ?? "manual-shadow:run123-a1",
            triggerSource: shadowRun.triggerSource ?? "cron",
            tradingMode: shadowRun.tradingMode ?? "SHADOW",
            outcome: shadowRun.outcome ?? "HOLD",
            startedAt:
              shadowRun.startedAt ?? new Date("2026-08-13T12:00:01.000Z"),
            completedAt:
              shadowRun.completedAt === undefined
                ? new Date("2026-08-13T12:00:10.000Z")
                : shadowRun.completedAt,
            tradeCount: shadowRun.tradeCount ?? 0,
          },
        ];
      }
      throw new Error(`Unhandled SQL in test: ${query}`);
    },
  ) as jest.Mock & { end: jest.Mock; __calls: string[] };
  sql.end = jest.fn(async () => undefined);
  sql.__calls = calls;
  return sql;
}

function runCheck(
  options: ActivationCheckOptions = BASE_OPTIONS,
  checkedAt: Date = CHECKED_AT,
) {
  return runActivationCheck(options, {
    now: () => new Date(checkedAt),
  });
}

describe("schedule-activation verifier", () => {
  beforeEach(() => {
    mockedPostgres.mockReset();
  });

  it("approves activation when every binding matches, the approval signature is valid, and state is safe", async () => {
    const sql = createSqlMock({ approval: {} });
    mockedPostgres.mockReturnValueOnce(sql as never);

    const report = await runCheck();

    expect(report.schemaVersion).toBe(ACTIVATION_CHECK_SCHEMA_VERSION);
    expect(report.approved).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(report.checks.every((check) => check.status === "pass")).toBe(
      true,
    );
    expect(
      report.checks.find((check) => check.id === "approval-signature-valid"),
    ).toEqual(expect.objectContaining({ status: "pass" }));
    expect(report.approval).toEqual({
      id: APPROVAL_ID,
      bindingId: DEFAULT_BINDING_ID,
      modeMismatchEvidenceId: MODE_MISMATCH_EVIDENCE_ID,
      cronEvidenceId: CRON_EVIDENCE_ID,
      adminEvidenceId: ADMIN_EVIDENCE_ID,
      approvedAt: APPROVED_AT,
      expiresAt: new Date(
        new Date(APPROVED_AT).getTime() + MAX_APPROVAL_AGE_MS,
      ).toISOString(),
    });
    expect(sql.__calls[0]).toBe(
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    expect(sql.__calls).toContain("SET LOCAL TIME ZONE 'UTC'");
    expect(sql.__calls).toContain("SET LOCAL TIME ZONE DEFAULT");
    expect(sql.__calls).not.toContain("COMMIT");
    expect(sql.__calls[sql.__calls.length - 1]).toBe("ROLLBACK");
  });

  it("accepts an approval at the exact 24-hour boundary", async () => {
    const sql = createSqlMock({ approval: {} });
    mockedPostgres.mockReturnValueOnce(sql as never);

    const report = await runCheck(
      BASE_OPTIONS,
      new Date(new Date(APPROVED_AT).getTime() + MAX_APPROVAL_AGE_MS),
    );

    expect(report.approved).toBe(true);
    expect(
      report.checks.find(
        (check) => check.id === "approval-within-24-hours",
      ),
    ).toEqual(expect.objectContaining({ status: "pass" }));
  });

  it("accepts an approval at the exact not-before boundary", async () => {
    const sql = createSqlMock({ approval: {} });
    mockedPostgres.mockReturnValueOnce(sql as never);

    const report = await runCheck(BASE_OPTIONS, new Date(APPROVED_AT));

    expect(report.approved).toBe(true);
    expect(
      report.checks.find((check) => check.id === "approval-not-in-future"),
    ).toEqual(expect.objectContaining({ status: "pass" }));
  });

  it("rejects an approval one millisecond beyond 24 hours", async () => {
    const sql = createSqlMock({ approval: {} });
    mockedPostgres.mockReturnValueOnce(sql as never);

    const report = await runCheck(
      BASE_OPTIONS,
      new Date(new Date(APPROVED_AT).getTime() + MAX_APPROVAL_AGE_MS + 1),
    );

    expect(report.approved).toBe(false);
    expect(
      report.checks.find(
        (check) => check.id === "approval-within-24-hours",
      ),
    ).toEqual(expect.objectContaining({ status: "block" }));
  });

  it("rejects a future-dated approval", async () => {
    const sql = createSqlMock({ approval: {} });
    mockedPostgres.mockReturnValueOnce(sql as never);

    const report = await runCheck(
      BASE_OPTIONS,
      new Date(new Date(APPROVED_AT).getTime() - 1),
    );

    expect(report.approved).toBe(false);
    expect(
      report.checks.find((check) => check.id === "approval-not-in-future"),
    ).toEqual(expect.objectContaining({ status: "block" }));
  });

  it("rejects a malformed signed approval timestamp", async () => {
    const malformed = "2026-08-14T00:00:00Z";
    const sql = createSqlMock({
      approval: {
        approvedAt: malformed,
        createdAt: malformed,
      },
    });
    mockedPostgres.mockReturnValueOnce(sql as never);

    const report = await runCheck();

    expect(report.approved).toBe(false);
    expect(
      report.checks.find((check) => check.id === "approval-timestamp-valid"),
    ).toEqual(expect.objectContaining({ status: "block" }));
  });

  it("rejects a signed timestamp that differs from the persisted row timestamp", async () => {
    const sql = createSqlMock({
      approval: {
        createdAt: "2026-08-14T00:00:00.001Z",
      },
    });
    mockedPostgres.mockReturnValueOnce(sql as never);

    const report = await runCheck();

    expect(report.approved).toBe(false);
    expect(
      report.checks.find((check) => check.id === "approval-timestamp-valid"),
    ).toEqual(expect.objectContaining({ status: "block" }));
  });

  it("rejects concurrent approvals with the same latest timestamp", async () => {
    const sql = createSqlMock({
      approval: { sameTimestampCount: 2 },
    });
    mockedPostgres.mockReturnValueOnce(sql as never);

    const report = await runCheck();

    expect(report.approved).toBe(false);
    expect(
      report.checks.find(
        (check) => check.id === "approval-order-unambiguous",
      ),
    ).toEqual(expect.objectContaining({ status: "block" }));
  });

  it.each([
    [
      "approval ID",
      { id: "deployment-smoke-approved-not-a-uuid" },
      DEFAULT_BINDING_ID,
    ],
    [
      "binding ID",
      { bindingId: "deployment-smoke-binding-not-a-uuid" },
      "deployment-smoke-binding-not-a-uuid",
    ],
    [
      "mode-mismatch evidence ID",
      {
        modeMismatchEvidenceId:
          "deployment-smoke-mode-mismatch-not-a-uuid",
      },
      DEFAULT_BINDING_ID,
    ],
    [
      "cron evidence ID",
      { cronEvidenceId: "deployment-smoke-cron-not-a-uuid" },
      DEFAULT_BINDING_ID,
    ],
    [
      "admin evidence ID",
      { adminEvidenceId: "deployment-smoke-admin-not-a-uuid" },
      DEFAULT_BINDING_ID,
    ],
  ] as Array<[string, ApprovalRowOverrides, string]>)(
    "rejects a malformed persisted %s even when its signature and binding row are self-consistent",
    async (_field, approval, bindingRowId) => {
      const sql = createSqlMock({ approval, bindingRowId });
      mockedPostgres.mockReturnValueOnce(sql as never);

      const report = await runCheck();

      expect(report.approved).toBe(false);
      expect(
        report.checks.find(
          (check) => check.id === "approval-identifiers-valid",
        ),
      ).toEqual(expect.objectContaining({ status: "block" }));
      expect(
        report.checks.find((check) => check.id === "approval-signature-valid"),
      ).toEqual(expect.objectContaining({ status: "pass" }));
    },
  );

  it("never emits the raw database URL, cron secret, or approval secret in the report", async () => {
    const sql = createSqlMock({ approval: {} });
    mockedPostgres.mockReturnValueOnce(sql as never);

    const report = await runCheck();
    const serialized = JSON.stringify(report);

    expect(serialized).not.toContain(CRON_SECRET);
    expect(serialized).not.toContain(APPROVAL_SECRET);
    expect(serialized).not.toContain(BASE_OPTIONS.databaseUrl);
  });

  it("binds activation to a new terminal zero-trade manual shadow run", async () => {
    const sql = createSqlMock({ approval: {}, shadowRun: {} });
    mockedPostgres.mockReturnValueOnce(sql as never);

    const report = await runCheck({
      ...BASE_OPTIONS,
      expectedShadowIdempotencyKey: "manual-shadow:run123-a1",
      expectedShadowStartedAfter: "2026-08-13T12:00:00Z",
    });

    expect(report.approved).toBe(true);
    expect(report.shadowRun).toMatchObject({
      id: "shadow-run-id",
      idempotencyKey: "manual-shadow:run123-a1",
      outcome: "HOLD",
      tradeCount: 0,
    });
    expect(
      report.checks.filter((check) => check.id.startsWith("manual-shadow")),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "manual-shadow-run-present",
          status: "pass",
        }),
        expect.objectContaining({
          id: "manual-shadow-run-no-trade",
          status: "pass",
        }),
      ]),
    );
  });

  it("rejects a replayed or trading manual shadow run", async () => {
    const sql = createSqlMock({
      approval: {},
      shadowRun: {
        startedAt: new Date("2026-08-13T11:59:59.000Z"),
        tradeCount: 1,
      },
    });
    mockedPostgres.mockReturnValueOnce(sql as never);

    const report = await runCheck({
      ...BASE_OPTIONS,
      expectedShadowIdempotencyKey: "manual-shadow:run123-a1",
      expectedShadowStartedAfter: "2026-08-13T12:00:00Z",
    });

    expect(report.approved).toBe(false);
    expect(
      report.checks.find(
        (check) => check.id === "manual-shadow-run-started-after-boundary",
      ),
    ).toEqual(expect.objectContaining({ status: "block" }));
    expect(
      report.checks.find(
        (check) => check.id === "manual-shadow-run-no-trade",
      ),
    ).toEqual(expect.objectContaining({ status: "block" }));
  });

  it("rejects when no approval exists", async () => {
    const sql = createSqlMock({ approval: null });
    mockedPostgres.mockReturnValueOnce(sql as never);

    const report = await runCheck();

    expect(report.approved).toBe(false);
    expect(
      report.checks.find((check) => check.id === "latest-approval-present"),
    ).toEqual(expect.objectContaining({ status: "block" }));
  });

  it("rejects when the referenced binding row is missing", async () => {
    const sql = createSqlMock({
      approval: {},
      bindingExists: false,
    });
    mockedPostgres.mockReturnValueOnce(sql as never);

    const report = await runCheck();

    expect(report.approved).toBe(false);
    expect(
      report.checks.find((check) => check.id === "binding-row-present"),
    ).toEqual(expect.objectContaining({ status: "block" }));
  });

  it.each([null, "different-binding-id"])(
    "rejects a missing or mismatched persisted evidence binding ID (%s)",
    async (bindingRowId) => {
      const sql = createSqlMock({
        approval: {},
        bindingRowId,
      });
      mockedPostgres.mockReturnValueOnce(sql as never);

      const report = await runCheck();

      expect(report.approved).toBe(false);
      expect(
        report.checks.find((check) => check.id === "binding-id-match"),
      ).toEqual(expect.objectContaining({ status: "block" }));
    },
  );

  it("rejects a target-origin mismatch", async () => {
    const sql = createSqlMock({
      approval: { targetOrigin: "https://impostor.example.com" },
    });
    mockedPostgres.mockReturnValueOnce(sql as never);

    const report = await runCheck();

    expect(report.approved).toBe(false);
    expect(
      report.checks.find((check) => check.id === "target-origin-match"),
    ).toEqual(expect.objectContaining({ status: "block" }));
  });

  it("rejects a release SHA mismatch", async () => {
    const sql = createSqlMock({
      approval: { releaseSha: "f".repeat(40) },
    });
    mockedPostgres.mockReturnValueOnce(sql as never);

    const report = await runCheck();

    expect(report.approved).toBe(false);
    expect(
      report.checks.find((check) => check.id === "release-sha-match"),
    ).toEqual(expect.objectContaining({ status: "block" }));
  });

  it("rejects an image digest mismatch", async () => {
    const sql = createSqlMock({
      approval: { imageDigest: `sha256:${"f".repeat(64)}` },
    });
    mockedPostgres.mockReturnValueOnce(sql as never);

    const report = await runCheck();

    expect(report.approved).toBe(false);
    expect(
      report.checks.find((check) => check.id === "image-digest-match"),
    ).toEqual(expect.objectContaining({ status: "block" }));
  });

  it("rejects a non-disabled persisted smoke rollout mode", async () => {
    const sql = createSqlMock({
      approval: { rolloutMode: "paper" },
    });
    mockedPostgres.mockReturnValueOnce(sql as never);

    const report = await runCheck();

    expect(report.approved).toBe(false);
    expect(
      report.checks.find(
        (check) => check.id === "smoke-rollout-mode-disabled",
      ),
    ).toEqual(expect.objectContaining({ status: "block" }));
  });

  it("rejects an active run lease", async () => {
    const sql = createSqlMock({
      approval: {},
      agentState: { isRunning: true, leaseOwner: "some-run" },
    });
    mockedPostgres.mockReturnValueOnce(sql as never);

    const report = await runCheck();

    expect(report.approved).toBe(false);
    expect(
      report.checks.find((check) => check.id === "no-active-lease"),
    ).toEqual(expect.objectContaining({ status: "block" }));
  });

  it("rejects an unreconciled/quarantined accounting status", async () => {
    const sql = createSqlMock({
      approval: {},
      agentState: { accountingStatus: "QUARANTINED" },
    });
    mockedPostgres.mockReturnValueOnce(sql as never);

    const report = await runCheck();

    expect(report.approved).toBe(false);
    expect(
      report.checks.find((check) => check.id === "accounting-reconciled"),
    ).toEqual(expect.objectContaining({ status: "block" }));
  });

  it("rejects an open paper position", async () => {
    const sql = createSqlMock({
      approval: {},
      agentState: { ethBalance: "0.5" },
    });
    mockedPostgres.mockReturnValueOnce(sql as never);

    const report = await runCheck();

    expect(report.approved).toBe(false);
    expect(
      report.checks.find(
        (check) => check.id === "no-open-paper-position",
      ),
    ).toEqual(expect.objectContaining({ status: "block" }));
  });

  it("rejects a cron-secret binding that does not match (e.g. produced without the approval secret)", async () => {
    // Simulates the retired forgery vector: something that only knows
    // CRON_SECRET (but not APPROVAL_SECRET) inserting a value it *could*
    // compute alone -- it will never equal the real keyed HMAC binding.
    const sql = createSqlMock({
      approval: { cronSecretBinding: "0".repeat(64) },
    });
    mockedPostgres.mockReturnValueOnce(sql as never);

    const report = await runCheck();

    expect(report.approved).toBe(false);
    expect(
      report.checks.find(
        (check) => check.id === "cron-secret-binding-match",
      ),
    ).toEqual(expect.objectContaining({ status: "block" }));
  });

  it("rejects a legacy row with no cron-secret binding or approval signature at all", async () => {
    const sql = createSqlMock({
      approval: { cronSecretBinding: null, approvalSignature: null },
    });
    mockedPostgres.mockReturnValueOnce(sql as never);

    const report = await runCheck();

    expect(report.approved).toBe(false);
    expect(
      report.checks.find(
        (check) => check.id === "cron-secret-binding-match",
      ),
    ).toEqual(expect.objectContaining({ status: "block" }));
    expect(
      report.checks.find((check) => check.id === "approval-signature-valid"),
    ).toEqual(expect.objectContaining({ status: "block" }));
  });

  it("rejects a tampered approval signature even when every other field matches", async () => {
    const sql = createSqlMock({
      approval: { approvalSignature: "1".repeat(64) },
    });
    mockedPostgres.mockReturnValueOnce(sql as never);

    const report = await runCheck();

    expect(report.approved).toBe(false);
    expect(
      report.checks.find((check) => check.id === "approval-signature-valid"),
    ).toEqual(expect.objectContaining({ status: "block" }));
  });

  it.each([
    ["approval ID", { id: "deployment-smoke-approved-replayed" }],
    ["binding ID", { bindingId: "deployment-smoke-binding-replayed" }],
    [
      "mode-mismatch evidence ID",
      { modeMismatchEvidenceId: "deployment-smoke-mode-mismatch-replayed" },
    ],
    ["cron evidence ID", { cronEvidenceId: "deployment-smoke-cron-replayed" }],
    [
      "admin evidence ID",
      { adminEvidenceId: "deployment-smoke-admin-replayed" },
    ],
    ["target origin", { targetOrigin: "https://other.example.com" }],
    ["release SHA", { releaseSha: "e".repeat(40) }],
    ["image digest", { imageDigest: `sha256:${"e".repeat(64)}` }],
    ["rollout mode", { rolloutMode: "shadow" }],
    ["cron-secret binding", { cronSecretBinding: "e".repeat(64) }],
    ["approval timestamp", { approvedAt: "2026-08-14T00:00:01.000Z" }],
  ] as Array<[string, ApprovalRowOverrides]>)(
    "invalidates the signed approval when its attributed %s changes",
    async (_field, override) => {
      const baseSignature = buildApprovalRow().approvalSignature as string;
      const sql = createSqlMock({
        approval: {
          ...override,
          approvalSignature: baseSignature,
        },
      });
      mockedPostgres.mockReturnValueOnce(sql as never);

      const report = await runCheck();

      expect(report.approved).toBe(false);
      expect(
        report.checks.find((check) => check.id === "approval-signature-valid"),
      ).toEqual(expect.objectContaining({ status: "block" }));
    },
  );

  it.each([
    ["approval ID", { id: "" }],
    ["binding ID", { bindingId: null }],
    ["mode-mismatch evidence ID", { modeMismatchEvidenceId: null }],
    ["cron evidence ID", { cronEvidenceId: null }],
    ["admin evidence ID", { adminEvidenceId: null }],
    ["target origin", { targetOrigin: null }],
    ["release SHA", { releaseSha: null }],
    ["image digest", { imageDigest: null }],
    ["rollout mode", { rolloutMode: null }],
    ["cron-secret binding", { cronSecretBinding: null }],
    ["approval timestamp", { approvedAt: null }],
    ["approval signature", { approvalSignature: null }],
  ] as Array<[string, ApprovalRowOverrides]>)(
    "rejects a missing attributed %s",
    async (_field, override) => {
      const sql = createSqlMock({ approval: override });
      mockedPostgres.mockReturnValueOnce(sql as never);

      const report = await runCheck();

      expect(report.approved).toBe(false);
      expect(
        report.checks.find((check) => check.id === "approval-binding-complete"),
      ).toEqual(expect.objectContaining({ status: "block" }));
    },
  );

  it("rejects when the persisted binding was signed with a different approval secret", async () => {
    const otherSecret = "a-completely-different-approval-secret-value";
    const cronBinding = cronSecretBinding(CRON_SECRET, otherSecret);
    const signature = computeApprovalSignature(
      canonicalApprovalPayload({
        approvalId: APPROVAL_ID,
        bindingId: DEFAULT_BINDING_ID,
        modeMismatchEvidenceId: MODE_MISMATCH_EVIDENCE_ID,
        cronEvidenceId: CRON_EVIDENCE_ID,
        adminEvidenceId: ADMIN_EVIDENCE_ID,
        targetOrigin: TARGET_ORIGIN,
        releaseSha: RELEASE_SHA,
        imageDigest: IMAGE_DIGEST,
        rolloutMode: "disabled",
        cronSecretBinding: cronBinding,
        approvedAt: APPROVED_AT,
      }),
      otherSecret,
    );
    const sql = createSqlMock({
      approval: {
        cronSecretBinding: cronBinding,
        approvalSignature: signature,
      },
    });
    mockedPostgres.mockReturnValueOnce(sql as never);

    const report = await runCheck();

    expect(report.approved).toBe(false);
    expect(
      report.checks.find(
        (check) => check.id === "cron-secret-binding-match",
      ),
    ).toEqual(expect.objectContaining({ status: "block" }));
    expect(
      report.checks.find((check) => check.id === "approval-signature-valid"),
    ).toEqual(expect.objectContaining({ status: "block" }));
  });

  it("fails closed on a malformed release SHA without touching the database", async () => {
    await expect(
      runActivationCheck({ ...BASE_OPTIONS, releaseSha: "not-a-sha" }),
    ).rejects.toThrow("40 lowercase hexadecimal");
    expect(mockedPostgres).not.toHaveBeenCalled();
  });

  it("fails closed on a malformed image digest without touching the database", async () => {
    await expect(
      runActivationCheck({ ...BASE_OPTIONS, imageDigest: "not-a-digest" }),
    ).rejects.toThrow("sha256:<64 lowercase hex>");
    expect(mockedPostgres).not.toHaveBeenCalled();
  });

  it("fails closed on a target origin with credentials or a path", async () => {
    const originWithCredentials =
      "https://" + "svc" + ":" + "tokenvalue" + "@krypto.example.com/admin";
    await expect(
      runActivationCheck({
        ...BASE_OPTIONS,
        targetOrigin: originWithCredentials,
      }),
    ).rejects.toThrow("bare http(s) origin");
    expect(mockedPostgres).not.toHaveBeenCalled();
  });

  it("fails closed on a non-HTTPS target origin that is not an explicit loopback address", async () => {
    await expect(
      runActivationCheck({
        ...BASE_OPTIONS,
        targetOrigin: "http://krypto.example.com",
      }),
    ).rejects.toThrow(
      "must use HTTPS unless it is an explicit loopback address",
    );
    expect(mockedPostgres).not.toHaveBeenCalled();
  });

  it.each(["http://localhost", "http://127.0.0.1", "http://[::1]"])(
    "permits an explicit loopback target origin over HTTP (%s)",
    async (loopbackOrigin) => {
      const expectedOrigin = new URL(loopbackOrigin).origin;
      const sql = createSqlMock({
        approval: { targetOrigin: expectedOrigin },
      });
      mockedPostgres.mockReturnValueOnce(sql as never);

      const report = await runCheck({
        ...BASE_OPTIONS,
        targetOrigin: loopbackOrigin,
      });

      expect(report.approved).toBe(true);
      expect(report.targetOrigin).toBe(expectedOrigin);
    },
  );

  it("fails closed when any required option is missing", async () => {
    await expect(
      runActivationCheck({ ...BASE_OPTIONS, cronSecret: "" }),
    ).rejects.toThrow(
      "DIRECT_URL, RELEASE_SHA, IMAGE_DIGEST, TARGET_ORIGIN, CRON_SECRET, and DEPLOYMENT_APPROVAL_SECRET are required.",
    );
    expect(mockedPostgres).not.toHaveBeenCalled();
  });

  it("fails closed when DEPLOYMENT_APPROVAL_SECRET is missing", async () => {
    await expect(
      runActivationCheck({ ...BASE_OPTIONS, approvalSecret: "" }),
    ).rejects.toThrow(
      "DIRECT_URL, RELEASE_SHA, IMAGE_DIGEST, TARGET_ORIGIN, CRON_SECRET, and DEPLOYMENT_APPROVAL_SECRET are required.",
    );
    expect(mockedPostgres).not.toHaveBeenCalled();
  });

  it("fails closed when DEPLOYMENT_APPROVAL_SECRET is too short", async () => {
    await expect(
      runActivationCheck({ ...BASE_OPTIONS, approvalSecret: "too-short" }),
    ).rejects.toThrow("at least 32 characters");
    expect(mockedPostgres).not.toHaveBeenCalled();
  });

  it("requires the exact manual shadow proof inputs", async () => {
    await expect(
      runActivationCheck({
        ...BASE_OPTIONS,
        expectedShadowIdempotencyKey: "",
      }),
    ).rejects.toThrow("EXPECTED_SHADOW_IDEMPOTENCY_KEY");
    await expect(
      runActivationCheck({
        ...BASE_OPTIONS,
        expectedShadowStartedAfter: "",
      }),
    ).rejects.toThrow("EXPECTED_SHADOW_STARTED_AFTER");
    expect(mockedPostgres).not.toHaveBeenCalled();
  });
});
