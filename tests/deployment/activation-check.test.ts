import {
  canonicalApprovalPayload,
  computeApprovalSignature,
  cronSecretBinding,
} from "@/deployment/target-smoke";

import {
  ACTIVATION_CHECK_SCHEMA_VERSION,
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
const DEFAULT_BINDING_ID = "deployment-smoke-binding-uuid";

const BASE_OPTIONS: ActivationCheckOptions = {
  databaseUrl: "******db.example.com/postgres",
  releaseSha: RELEASE_SHA,
  imageDigest: IMAGE_DIGEST,
  targetOrigin: TARGET_ORIGIN,
  cronSecret: CRON_SECRET,
  approvalSecret: APPROVAL_SECRET,
};

type ApprovalRowOverrides = Partial<{
  bindingId: string | null;
  targetOrigin: string | null;
  cronSecretBinding: string | null;
  releaseSha: string | null;
  imageDigest: string | null;
  rolloutMode: string | null;
  approvalSignature: string | null;
}>;

type AgentStateOverrides = Partial<{
  accountingStatus: string;
  ethBalance: string | null;
  isRunning: boolean;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
}>;

/**
 * Builds a fully self-consistent, genuinely-signed approval row (as if
 * `createTargetApproval` had persisted it with APPROVAL_SECRET), then
 * applies field overrides on top. Overriding a field independently of the
 * signature models a row an attacker without APPROVAL_SECRET could never
 * actually produce, but lets each test isolate exactly one failing check.
 */
function buildApprovalRow(
  overrides: ApprovalRowOverrides = {},
): Record<string, unknown> {
  const bindingId =
    overrides.bindingId === undefined ? DEFAULT_BINDING_ID : overrides.bindingId;
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
  const approvalSignatureValue =
    overrides.approvalSignature === undefined
      ? computeApprovalSignature(
          canonicalApprovalPayload({
            bindingId: bindingId ?? "",
            targetOrigin: targetOrigin ?? "",
            releaseSha: releaseSha ?? "",
            imageDigest: imageDigest ?? "",
            rolloutMode: rolloutMode ?? "",
            cronSecretBinding: cronSecretBindingValue ?? "",
          }),
          APPROVAL_SECRET,
        )
      : overrides.approvalSignature;

  return {
    id: "deployment-smoke-approved-uuid",
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    bindingId,
    targetOrigin,
    cronSecretBinding: cronSecretBindingValue,
    releaseSha,
    imageDigest,
    rolloutMode,
    approvalSignature: approvalSignatureValue,
  };
}

function createSqlMock(options: {
  approval?: ApprovalRowOverrides | null;
  bindingExists?: boolean;
  agentState?: AgentStateOverrides | null;
}) {
  const calls: string[] = [];
  const {
    approval = {},
    bindingExists = true,
    agentState = {},
  } = options;
  const sql = jest.fn(
    async (
      first: TemplateStringsArray | string,
      ..._values: unknown[]
    ): Promise<unknown> => {
      const query = Array.from(first).join(" ").replace(/\s+/g, " ").trim();
      calls.push(query);
      if (
        query === "BEGIN READ ONLY" ||
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
          ? [{ event: "deployment-smoke-binding" }]
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
      throw new Error(`Unhandled SQL in test: ${query}`);
    },
  ) as jest.Mock & { end: jest.Mock; __calls: string[] };
  sql.end = jest.fn(async () => undefined);
  sql.__calls = calls;
  return sql;
}

describe("schedule-activation verifier", () => {
  beforeEach(() => {
    mockedPostgres.mockReset();
  });

  it("approves activation when every binding matches, the approval signature is valid, and state is safe", async () => {
    const sql = createSqlMock({ approval: {} });
    mockedPostgres.mockReturnValueOnce(sql as never);

    const report = await runActivationCheck(BASE_OPTIONS);

    expect(report.schemaVersion).toBe(ACTIVATION_CHECK_SCHEMA_VERSION);
    expect(report.approved).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(report.checks.every((check) => check.status === "pass")).toBe(
      true,
    );
    expect(
      report.checks.find((check) => check.id === "approval-signature-valid"),
    ).toEqual(expect.objectContaining({ status: "pass" }));
    expect(sql.__calls[0]).toBe("BEGIN READ ONLY");
    expect(sql.__calls).not.toContain("COMMIT");
    expect(sql.__calls[sql.__calls.length - 1]).toBe("ROLLBACK");
  });

  it("never emits the raw database URL, cron secret, or approval secret in the report", async () => {
    const sql = createSqlMock({ approval: {} });
    mockedPostgres.mockReturnValueOnce(sql as never);

    const report = await runActivationCheck(BASE_OPTIONS);
    const serialized = JSON.stringify(report);

    expect(serialized).not.toContain(CRON_SECRET);
    expect(serialized).not.toContain(APPROVAL_SECRET);
    expect(serialized).not.toContain(BASE_OPTIONS.databaseUrl);
  });

  it("rejects when no approval exists", async () => {
    const sql = createSqlMock({ approval: null });
    mockedPostgres.mockReturnValueOnce(sql as never);

    const report = await runActivationCheck(BASE_OPTIONS);

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

    const report = await runActivationCheck(BASE_OPTIONS);

    expect(report.approved).toBe(false);
    expect(
      report.checks.find((check) => check.id === "binding-row-present"),
    ).toEqual(expect.objectContaining({ status: "block" }));
  });

  it("rejects a target-origin mismatch", async () => {
    const sql = createSqlMock({
      approval: { targetOrigin: "https://impostor.example.com" },
    });
    mockedPostgres.mockReturnValueOnce(sql as never);

    const report = await runActivationCheck(BASE_OPTIONS);

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

    const report = await runActivationCheck(BASE_OPTIONS);

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

    const report = await runActivationCheck(BASE_OPTIONS);

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

    const report = await runActivationCheck(BASE_OPTIONS);

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

    const report = await runActivationCheck(BASE_OPTIONS);

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

    const report = await runActivationCheck(BASE_OPTIONS);

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

    const report = await runActivationCheck(BASE_OPTIONS);

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

    const report = await runActivationCheck(BASE_OPTIONS);

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

    const report = await runActivationCheck(BASE_OPTIONS);

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

    const report = await runActivationCheck(BASE_OPTIONS);

    expect(report.approved).toBe(false);
    expect(
      report.checks.find((check) => check.id === "approval-signature-valid"),
    ).toEqual(expect.objectContaining({ status: "block" }));
  });

  it("rejects when the persisted binding was signed with a different approval secret", async () => {
    const otherSecret = "a-completely-different-approval-secret-value";
    const cronBinding = cronSecretBinding(CRON_SECRET, otherSecret);
    const signature = computeApprovalSignature(
      canonicalApprovalPayload({
        bindingId: DEFAULT_BINDING_ID,
        targetOrigin: TARGET_ORIGIN,
        releaseSha: RELEASE_SHA,
        imageDigest: IMAGE_DIGEST,
        rolloutMode: "disabled",
        cronSecretBinding: cronBinding,
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

    const report = await runActivationCheck(BASE_OPTIONS);

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

      const report = await runActivationCheck({
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
});
