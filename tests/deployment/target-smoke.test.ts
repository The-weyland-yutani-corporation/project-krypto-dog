import {
  cronSecretBinding,
  runTargetSmoke,
  validateImageDigest,
  validateReleaseSha,
  validateTargetBaseUrl,
} from "@/deployment/target-smoke";

jest.mock("@/deployment/ledger-attestation", () => ({
  runLedgerAttestation: jest.fn(async (options: {
    releaseSha: string;
    imageDigest: string;
    configVersion: string;
    purpose: string;
    asOf: Date;
  }) => ({
    status: "PASS",
    checksum: `sha256:${"a".repeat(64)}`,
    binding: {
      releaseSha: options.releaseSha,
      imageDigest: options.imageDigest,
      configVersion: options.configVersion,
      databaseIdentityHash: `sha256:${"b".repeat(64)}`,
      runtimeRole: "krypto_runtime",
      purpose: options.purpose,
      asOf: options.asOf.toISOString(),
    },
    bounds: { observedTrades: 0, maximumTrades: 10_000 },
    anchorDecision: "RESET_REQUIRED",
    paperPromotionEligible: false,
  })),
}));

const TEST_RELEASE_SHA = "c0e4ed2724a9880d5a5dfcdf954490f2d86e8e2f";
const TEST_IMAGE_DIGEST =
  "sha256:d32ebcff1be028d183b8ba7ce4e1506b0adf3a7a90b02d5c6a202fabceaf1e68";
const TEST_APPROVAL_SECRET = "approval-secret-of-sufficient-length-x";
const TEST_ADMIN_IDENTITY = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  audience: "22222222-2222-4222-8222-222222222222",
  issuer:
    "https://login.microsoftonline.com/11111111-1111-4111-8111-111111111111/v2.0",
  operatorId: "33333333-3333-4333-8333-333333333333",
  operatorRole: "RELEASE_OWNER" as const,
  mfaAuthContext: "c1",
  stepUpAuthContext: "c2",
};

const successfulFetch: typeof fetch = async (input, init) => {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input
        : input.url,
  );
  const headers = new Headers(init?.headers);
  if (url.pathname === "/api/agent/status") {
    return headers.has("x-cron-secret")
      ? Response.json({
          rolloutMode: "disabled",
          databaseBinding: headers.has("x-database-challenge")
            ? true
            : null,
        })
      : Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (url.pathname === "/api/agent/run") {
    if (!headers.has("x-cron-secret")) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (
      headers.get("x-krypto-mode-probe") === "no-mutation" &&
      headers.get("x-required-rollout-mode") === "paper"
    ) {
      return Response.json(
        {
          error: "Rollout mode changed before the run started",
          expectedMode: "paper",
          actualMode: "disabled",
        },
        { status: 409 },
      );
    }
    return headers.get("x-required-rollout-mode") === "disabled"
      ? Response.json({ action: "disabled" })
      : Response.json({ error: "Invalid mode" }, { status: 400 });
  }
  if (url.pathname === "/api/auth/login" && init?.method === "GET") {
    return new Response(null, {
      status: 307,
      headers: {
        location:
          "https://krypto.example.com/.auth/login/aad?post_login_redirect_uri=/admin",
        "cache-control": "no-store, max-age=0",
      },
    });
  }
  if (url.pathname === "/api/auth/login") {
    return Response.json(
      { error: "Password authentication is not available" },
      {
        status: 401,
        headers: { "cache-control": "no-store, max-age=0" },
      },
    );
  }
  if (url.pathname.startsWith("/api/admin/")) {
    return Response.json(
      { error: "Unauthorized" },
      {
        status: 401,
      headers: {
          "cache-control": "no-store, max-age=0",
          "content-security-policy": "default-src 'self'",
          "permissions-policy": "camera=()",
          "referrer-policy": "no-referrer",
          "strict-transport-security": "max-age=31536000",
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
        },
      },
    );
  }
  if (url.pathname === "/.auth/login/aad") {
    return new Response(null, {
      status: 302,
      headers: {
        location:
          "https://login.microsoftonline.com/11111111-1111-4111-8111-111111111111/oauth2/v2.0/authorize",
      },
    });
  }
  if (url.pathname === "/.auth/me") {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (url.pathname === "/api/agent/daily-summary") {
    return headers.has("x-cron-secret") &&
      headers.get("x-required-rollout-mode") === "disabled"
      ? Response.json({
          generated: true,
          delivery: { status: "sent", id: "email-id" },
          alertAuditRecorded: true,
        })
      : Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  throw new Error(`Unexpected request: ${url.pathname}`);
};

describe("target deployment smoke", () => {
  const originalRolloutMode = process.env.ROLLOUT_MODE;

  beforeEach(() => {
    process.env.ROLLOUT_MODE = "disabled";
    process.env.SAFETY_RELEASE_OWNER = "release-owner-test";
  });

  afterAll(() => {
    if (originalRolloutMode === undefined) {
      delete process.env.ROLLOUT_MODE;
    } else {
      process.env.ROLLOUT_MODE = originalRolloutMode;
    }
    delete process.env.SAFETY_RELEASE_OWNER;
  });

  it("validates target identity and transport", () => {
    expect(
      validateTargetBaseUrl(
        "https://krypto.example.com",
        "krypto.example.com",
      ).hostname,
    ).toBe("krypto.example.com");
    expect(() =>
      validateTargetBaseUrl(
        "http://krypto.example.com",
        "krypto.example.com",
      ),
    ).toThrow("requires HTTPS");
    expect(() =>
      validateTargetBaseUrl(
        "https://other.example.com",
        "krypto.example.com",
      ),
    ).toThrow("does not match");
  });

  it("validates an exact lowercase 40-hex release SHA and rejects everything else", () => {
    expect(validateReleaseSha(TEST_RELEASE_SHA)).toBe(TEST_RELEASE_SHA);
    expect(() => validateReleaseSha(TEST_RELEASE_SHA.toUpperCase())).toThrow(
      "40 lowercase hexadecimal",
    );
    expect(() => validateReleaseSha(TEST_RELEASE_SHA.slice(0, 39))).toThrow(
      "40 lowercase hexadecimal",
    );
    expect(() => validateReleaseSha(`${TEST_RELEASE_SHA}0`)).toThrow(
      "40 lowercase hexadecimal",
    );
    expect(() => validateReleaseSha("not-a-sha")).toThrow(
      "40 lowercase hexadecimal",
    );
  });

  it("validates an exact sha256:<64-hex> image digest and rejects everything else", () => {
    expect(validateImageDigest(TEST_IMAGE_DIGEST)).toBe(TEST_IMAGE_DIGEST);
    expect(() =>
      validateImageDigest(TEST_IMAGE_DIGEST.toUpperCase()),
    ).toThrow("sha256:<64 lowercase hex>");
    expect(() =>
      validateImageDigest(TEST_IMAGE_DIGEST.replace("sha256:", "sha1:")),
    ).toThrow("sha256:<64 lowercase hex>");
    expect(() => validateImageDigest(TEST_IMAGE_DIGEST.slice(0, -1))).toThrow(
      "sha256:<64 lowercase hex>",
    );
  });

  it("proves disabled HTTP, auth, provider, and database behavior", async () => {
    const uuids = [
      "123e4567-e89b-42d3-a456-426614174000",
      "123e4567-e89b-42d3-a456-426614174001",
      "123e4567-e89b-42d3-a456-426614174002",
      "123e4567-e89b-42d3-a456-426614174003",
      "123e4567-e89b-42d3-a456-426614174004",
    ];
    const createApproval = jest.fn(async () => undefined);
    const report = await runTargetSmoke(
      {
        baseUrl: "https://krypto.example.com",
        expectedHost: "krypto.example.com",
        databaseUrl: "postgresql://operator:secret@db.example.com/postgres",
        cronSecret: "cron-secret",
        releaseSha: TEST_RELEASE_SHA,
        imageDigest: TEST_IMAGE_DIGEST,
        approvalSecret: TEST_APPROVAL_SECRET,
        adminIdentity: TEST_ADMIN_IDENTITY,
      },
      {
        fetchImpl: successfulFetch,
        randomUuid: () => uuids.shift()!,
        now: () => new Date("2026-07-14T22:00:00.000Z"),
        inspectBefore: async () => ({
          tradeCount: 4,
          activeKryptoCronJobs: 0,
          pendingKryptoHttpRequests: 0,
          state: {
            present: true,
            accountingStatus: "RECONCILED",
            openPosition: false,
            activeLease: false,
          },
        }),
        inspectAfter: async ({ idempotencyKeys }) =>
          idempotencyKeys.length === 1 &&
          idempotencyKeys[0]?.includes("mode-mismatch")
            ? {
                runCount: 0,
                disabledRunCount: 0,
                tradeCount: 4,
                leaseReleased: true,
                deliveryStatus: null,
              }
            : {
                runCount: 1,
                disabledRunCount: 1,
                tradeCount: 4,
                leaseReleased: true,
                deliveryStatus: "sent",
              },
        createBinding: async () => undefined,
        createApproval,
        runProviders: async () => ({
          foundry: {
            latencyMs: 100,
            responseLength: 2,
            inputTokens: 5,
            outputTokens: 1,
            totalTokens: 6,
            structured: {
              latencyMs: 120,
              action: "HOLD",
              notionalUSD: null,
            },
          },
          coinbase: {
            latencyMs: 80,
            spotPriceFinite: true,
            completeCandleCount: 2,
          },
          postHog: {
            latencyMs: 20,
            flushed: true,
            smokeId: "posthog-smoke-id",
          },
        }),
      },
    );

    expect(report.passed).toBe(true);
    expect(report.schemaVersion).toBe("1.7.0");
    expect(report.checks).toHaveLength(16);
    expect(report.checks.every((check) => check.status === "pass")).toBe(
      true,
    );
    expect(createApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        targetOrigin: "https://krypto.example.com",
        cronSecret: "cron-secret",
        modeMismatchEvidenceId: report.evidenceIds.modeMismatch,
        cronEvidenceId: report.evidenceIds.cron,
        adminEvidenceId: report.evidenceIds.admin,
        releaseSha: TEST_RELEASE_SHA,
        imageDigest: TEST_IMAGE_DIGEST,
        approvalSecret: TEST_APPROVAL_SECRET,
        approvedAt: new Date("2026-07-14T22:00:00.000Z"),
      }),
    );
    expect(report.releaseSha).toBe(TEST_RELEASE_SHA);
    expect(report.imageDigest).toBe(TEST_IMAGE_DIGEST);
    expect(report.rolloutMode).toBe("disabled");
    const expectedCronSecretBinding = cronSecretBinding(
      "cron-secret",
      TEST_APPROVAL_SECRET,
    );
    expect(report.binding).toEqual({
      approvalId: report.evidenceIds.approval,
      bindingId: report.evidenceIds.databaseBinding,
      modeMismatchEvidenceId: report.evidenceIds.modeMismatch,
      cronEvidenceId: report.evidenceIds.cron,
      adminEvidenceId: report.evidenceIds.admin,
      targetOrigin: "https://krypto.example.com",
      releaseSha: TEST_RELEASE_SHA,
      imageDigest: TEST_IMAGE_DIGEST,
      ledgerAttestationChecksum: `sha256:${"a".repeat(64)}`,
      rolloutMode: "disabled",
      cronSecretBinding: expectedCronSecretBinding,
      approvedAt: "2026-07-14T22:00:00.000Z",
      approvalSignature: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    // The cron-secret binding cannot be reproduced from CRON_SECRET alone
    // (the retired MD5(cronSecret) fingerprint could be) -- it requires
    // DEPLOYMENT_APPROVAL_SECRET, which runtime/web never receives.
    expect(report.binding?.cronSecretBinding).not.toBe("cron-secret");
    expect(report.binding?.cronSecretBinding).toHaveLength(64);
  });

  it("rejects a missing or malformed release SHA and image digest before any target request", async () => {
    const fetchImpl = jest.fn();
    await expect(
      runTargetSmoke(
        {
          baseUrl: "https://krypto.example.com",
          expectedHost: "krypto.example.com",
          databaseUrl: "******db.example.com/postgres",
          cronSecret: "cron-secret",
          releaseSha: "",
          imageDigest: TEST_IMAGE_DIGEST,
          approvalSecret: TEST_APPROVAL_SECRET,
          adminIdentity: TEST_ADMIN_IDENTITY,
        },
        { fetchImpl },
      ),
    ).rejects.toThrow("RELEASE_SHA and IMAGE_DIGEST are required.");
    await expect(
      runTargetSmoke(
        {
          baseUrl: "https://krypto.example.com",
          expectedHost: "krypto.example.com",
          databaseUrl: "******db.example.com/postgres",
          cronSecret: "cron-secret",
          releaseSha: "NOT-LOWERCASE-HEX",
          imageDigest: TEST_IMAGE_DIGEST,
          approvalSecret: TEST_APPROVAL_SECRET,
          adminIdentity: TEST_ADMIN_IDENTITY,
        },
        { fetchImpl },
      ),
    ).rejects.toThrow("40 lowercase hexadecimal");
    await expect(
      runTargetSmoke(
        {
          baseUrl: "https://krypto.example.com",
          expectedHost: "krypto.example.com",
          databaseUrl: "******db.example.com/postgres",
          cronSecret: "cron-secret",
          releaseSha: TEST_RELEASE_SHA,
          imageDigest: "not-a-digest",
          approvalSecret: TEST_APPROVAL_SECRET,
          adminIdentity: TEST_ADMIN_IDENTITY,
        },
        { fetchImpl },
      ),
    ).rejects.toThrow("sha256:<64 lowercase hex>");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a missing or too-short DEPLOYMENT_APPROVAL_SECRET before any target request", async () => {
    const fetchImpl = jest.fn();
    await expect(
      runTargetSmoke(
        {
          baseUrl: "https://krypto.example.com",
          expectedHost: "krypto.example.com",
          databaseUrl: "******db.example.com/postgres",
          cronSecret: "cron-secret",
          releaseSha: TEST_RELEASE_SHA,
          imageDigest: TEST_IMAGE_DIGEST,
          approvalSecret: "",
          adminIdentity: TEST_ADMIN_IDENTITY,
        },
        { fetchImpl },
      ),
    ).rejects.toThrow("DEPLOYMENT_APPROVAL_SECRET is required.");
    await expect(
      runTargetSmoke(
        {
          baseUrl: "https://krypto.example.com",
          expectedHost: "krypto.example.com",
          databaseUrl: "******db.example.com/postgres",
          cronSecret: "cron-secret",
          releaseSha: TEST_RELEASE_SHA,
          imageDigest: TEST_IMAGE_DIGEST,
          approvalSecret: "too-short",
          adminIdentity: TEST_ADMIN_IDENTITY,
        },
        { fetchImpl },
      ),
    ).rejects.toThrow("at least 32 characters");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never persists or reports the raw cron secret or approval secret", async () => {
    const uuids = [
      "223e4567-e89b-42d3-a456-426614174000",
      "223e4567-e89b-42d3-a456-426614174001",
      "223e4567-e89b-42d3-a456-426614174002",
      "223e4567-e89b-42d3-a456-426614174003",
      "223e4567-e89b-42d3-a456-426614174004",
    ];
    const createApproval = jest.fn(async () => undefined);
    const report = await runTargetSmoke(
      {
        baseUrl: "https://krypto.example.com",
        expectedHost: "krypto.example.com",
        databaseUrl: "******db.example.com/postgres",
        cronSecret: "super-secret-cron-value",
        releaseSha: TEST_RELEASE_SHA,
        imageDigest: TEST_IMAGE_DIGEST,
        approvalSecret: TEST_APPROVAL_SECRET,
        adminIdentity: TEST_ADMIN_IDENTITY,
      },
      {
        fetchImpl: successfulFetch,
        randomUuid: () => uuids.shift()!,
        now: () => new Date("2026-07-14T22:00:00.000Z"),
        inspectBefore: async () => ({
          tradeCount: 4,
          activeKryptoCronJobs: 0,
          pendingKryptoHttpRequests: 0,
          state: {
            present: true,
            accountingStatus: "RECONCILED",
            openPosition: false,
            activeLease: false,
          },
        }),
        inspectAfter: async ({ idempotencyKeys }) =>
          idempotencyKeys.length === 1 &&
          idempotencyKeys[0]?.includes("mode-mismatch")
            ? {
                runCount: 0,
                disabledRunCount: 0,
                tradeCount: 4,
                leaseReleased: true,
                deliveryStatus: null,
              }
            : {
                runCount: 1,
                disabledRunCount: 1,
                tradeCount: 4,
                leaseReleased: true,
                deliveryStatus: "sent",
              },
        createBinding: async () => undefined,
        createApproval,
        runProviders: async () => ({
          foundry: {
            latencyMs: 100,
            responseLength: 2,
            inputTokens: 5,
            outputTokens: 1,
            totalTokens: 6,
            structured: {
              latencyMs: 120,
              action: "HOLD",
              notionalUSD: null,
            },
          },
          coinbase: {
            latencyMs: 80,
            spotPriceFinite: true,
            completeCandleCount: 2,
          },
          postHog: {
            latencyMs: 20,
            flushed: true,
            smokeId: "posthog-smoke-id",
          },
        }),
      },
    );

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("super-secret-cron-value");
    expect(serialized).not.toContain(TEST_APPROVAL_SECRET);
  });

  it("leaves binding null and skips approval persistence on a blocked run", async () => {
    const createApproval = jest.fn();
    const report = await runTargetSmoke(
      {
        baseUrl: "https://krypto.example.com",
        expectedHost: "krypto.example.com",
        databaseUrl: "******db.example.com/postgres",
        cronSecret: "cron-secret",
        releaseSha: TEST_RELEASE_SHA,
        imageDigest: TEST_IMAGE_DIGEST,
        approvalSecret: TEST_APPROVAL_SECRET,
        adminIdentity: TEST_ADMIN_IDENTITY,
      },
      {
        fetchImpl: async () =>
          Response.json({ error: "Unauthorized" }, { status: 401 }),
        createApproval,
      },
    );

    expect(report.passed).toBe(false);
    expect(report.binding).toBeNull();
    expect(report.releaseSha).toBe(TEST_RELEASE_SHA);
    expect(report.imageDigest).toBe(TEST_IMAGE_DIGEST);
    expect(createApproval).not.toHaveBeenCalled();
  });

  it("blocks before any binding mutation when ledger attestation fails", async () => {
    const createBinding = jest.fn();
    const report = await runTargetSmoke(
      {
        baseUrl: "https://krypto.example.com",
        expectedHost: "krypto.example.com",
        databaseUrl: "******db.example.com/postgres",
        cronSecret: "cron-secret",
        releaseSha: TEST_RELEASE_SHA,
        imageDigest: TEST_IMAGE_DIGEST,
        approvalSecret: TEST_APPROVAL_SECRET,
        adminIdentity: TEST_ADMIN_IDENTITY,
      },
      {
        fetchImpl: successfulFetch,
        inspectBefore: async () => ({
          tradeCount: 0,
          activeKryptoCronJobs: 0,
          pendingKryptoHttpRequests: 0,
          state: {
            present: true,
            accountingStatus: "RECONCILED",
            openPosition: false,
            activeLease: false,
          },
        }),
        runAttestation: jest.fn(async () => ({
          status: "FAIL",
          checksum: `sha256:${"f".repeat(64)}`,
          binding: {
            databaseIdentityHash: `sha256:${"b".repeat(64)}`,
            runtimeRole: "krypto_runtime",
          },
          bounds: { observedTrades: 1 },
          anchorDecision: "BLOCK",
        })) as never,
        createBinding,
      },
    );

    expect(report.passed).toBe(false);
    expect(report.binding).toBeNull();
    expect(createBinding).not.toHaveBeenCalled();
    expect(
      report.checks.find(
        (check) => check.id === "immutable-ledger-attestation",
      ),
    ).toEqual(expect.objectContaining({ status: "block" }));
  });

  it("does not invoke the agent when the target is not disabled", async () => {
    const inspectBefore = jest.fn();
    const fetchImpl: typeof fetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      return headers.has("x-cron-secret")
        ? Response.json({ rolloutMode: "paper" })
        : Response.json({ error: "Unauthorized" }, { status: 401 });
    };

    const report = await runTargetSmoke(
      {
        baseUrl: "https://krypto.example.com",
        expectedHost: "krypto.example.com",
        databaseUrl: "postgresql://operator:secret@db.example.com/postgres",
        cronSecret: "cron-secret",
        releaseSha: TEST_RELEASE_SHA,
        imageDigest: TEST_IMAGE_DIGEST,
        approvalSecret: TEST_APPROVAL_SECRET,
        adminIdentity: TEST_ADMIN_IDENTITY,
      },
      {
        fetchImpl,
        inspectBefore,
      },
    );

    expect(report.passed).toBe(false);
    expect(report.checks).toEqual([
      expect.objectContaining({
        id: "target-rollout-mode",
        status: "block",
      }),
    ]);
    expect(inspectBefore).not.toHaveBeenCalled();
  });

  it("stops before agent invocation when runtime database binding fails", async () => {
    const paths: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input
            : input.url,
      );
      paths.push(url.pathname);
      const headers = new Headers(init?.headers);
      return headers.has("x-cron-secret")
        ? Response.json({
            rolloutMode: "disabled",
            databaseBinding: headers.has("x-database-challenge")
              ? false
              : null,
          })
        : Response.json({ error: "Unauthorized" }, { status: 401 });
    };

    const report = await runTargetSmoke(
      {
        baseUrl: "https://krypto.example.com",
        expectedHost: "krypto.example.com",
        databaseUrl: "******db.example.com/postgres",
        cronSecret: "cron-secret",
        releaseSha: TEST_RELEASE_SHA,
        imageDigest: TEST_IMAGE_DIGEST,
        approvalSecret: TEST_APPROVAL_SECRET,
        adminIdentity: TEST_ADMIN_IDENTITY,
      },
      {
        fetchImpl,
        createBinding: async () => undefined,
        inspectBefore: async () => ({
          tradeCount: 0,
          activeKryptoCronJobs: 0,
          pendingKryptoHttpRequests: 0,
          state: {
            present: true,
            accountingStatus: "RECONCILED",
            openPosition: false,
            activeLease: false,
          },
        }),
      },
    );

    expect(report.passed).toBe(false);
    expect(paths).not.toContain("/api/agent/run");
    expect(
      report.checks.find((check) => check.id === "database-target-binding"),
    ).toEqual(expect.objectContaining({ status: "block" }));
  });

  it("stops before binding when a Krypto HTTP request is queued", async () => {
    const createBinding = jest.fn();
    const report = await runTargetSmoke(
      {
        baseUrl: "https://krypto.example.com",
        expectedHost: "krypto.example.com",
        databaseUrl: "******db.example.com/postgres",
        cronSecret: "cron-secret",
        releaseSha: TEST_RELEASE_SHA,
        imageDigest: TEST_IMAGE_DIGEST,
        approvalSecret: TEST_APPROVAL_SECRET,
        adminIdentity: TEST_ADMIN_IDENTITY,
      },
      {
        fetchImpl: successfulFetch,
        createBinding,
        inspectBefore: async () => ({
          tradeCount: 0,
          activeKryptoCronJobs: 0,
          pendingKryptoHttpRequests: 1,
          state: {
            present: true,
            accountingStatus: "RECONCILED",
            openPosition: false,
            activeLease: false,
          },
        }),
      },
    );

    expect(report.passed).toBe(false);
    expect(createBinding).not.toHaveBeenCalled();
    expect(
      report.checks.find((check) => check.id === "database-safety"),
    ).toEqual(expect.objectContaining({ status: "block" }));
  });

  it("does not run providers when database postconditions fail", async () => {
    const runProviders = jest.fn();
    const report = await runTargetSmoke(
      {
        baseUrl: "https://krypto.example.com",
        expectedHost: "krypto.example.com",
        databaseUrl: "******db.example.com/postgres",
        cronSecret: "cron-secret",
        releaseSha: TEST_RELEASE_SHA,
        imageDigest: TEST_IMAGE_DIGEST,
        approvalSecret: TEST_APPROVAL_SECRET,
        adminIdentity: TEST_ADMIN_IDENTITY,
      },
      {
        fetchImpl: successfulFetch,
        createBinding: async () => undefined,
        inspectBefore: async () => ({
          tradeCount: 4,
          activeKryptoCronJobs: 0,
          pendingKryptoHttpRequests: 0,
          state: {
            present: true,
            accountingStatus: "RECONCILED",
            openPosition: false,
            activeLease: false,
          },
        }),
        inspectAfter: async ({ idempotencyKeys }) =>
          idempotencyKeys.length === 1 &&
          idempotencyKeys[0]?.includes("mode-mismatch")
            ? {
                runCount: 0,
                disabledRunCount: 0,
                tradeCount: 4,
                leaseReleased: true,
                deliveryStatus: null,
              }
            : {
                runCount: 2,
                disabledRunCount: 2,
                tradeCount: 4,
                leaseReleased: true,
                deliveryStatus: "sent",
              },
        runProviders,
      },
    );

    expect(report.passed).toBe(false);
    expect(runProviders).not.toHaveBeenCalled();
    expect(
      report.checks.find((check) => check.id === "database-postconditions"),
    ).toEqual(expect.objectContaining({ status: "block" }));
  });

  it("runs final no-trade checks even when provider validation fails", async () => {
    let fullInspectionCount = 0;
    const createApproval = jest.fn();
    const report = await runTargetSmoke(
      {
        baseUrl: "https://krypto.example.com",
        expectedHost: "krypto.example.com",
        databaseUrl: "******db.example.com/postgres",
        cronSecret: "cron-secret",
        releaseSha: TEST_RELEASE_SHA,
        imageDigest: TEST_IMAGE_DIGEST,
        approvalSecret: TEST_APPROVAL_SECRET,
        adminIdentity: TEST_ADMIN_IDENTITY,
      },
      {
        fetchImpl: successfulFetch,
        createBinding: async () => undefined,
        createApproval,
        inspectBefore: async () => ({
          tradeCount: 4,
          activeKryptoCronJobs: 0,
          pendingKryptoHttpRequests: 0,
          state: {
            present: true,
            accountingStatus: "RECONCILED",
            openPosition: false,
            activeLease: false,
          },
        }),
        inspectAfter: async ({ idempotencyKeys }) => {
          if (
            idempotencyKeys.length === 1 &&
            idempotencyKeys[0]?.includes("mode-mismatch")
          ) {
            return {
              runCount: 0,
              disabledRunCount: 0,
              tradeCount: 4,
              leaseReleased: true,
              deliveryStatus: null,
            };
          }
          fullInspectionCount += 1;
          return {
            runCount: 1,
            disabledRunCount: 1,
            tradeCount: fullInspectionCount === 1 ? 4 : 5,
            leaseReleased: true,
            deliveryStatus: "sent",
          };
        },
        runProviders: async () => {
          throw new Error("Provider smoke failed");
        },
      },
    );

    expect(report.passed).toBe(false);
    expect(createApproval).not.toHaveBeenCalled();
    expect(
      report.checks.find((check) => check.id === "provider-connectivity"),
    ).toEqual(expect.objectContaining({ status: "block" }));
    expect(
      report.checks.find(
        (check) => check.id === "final-database-postconditions",
      ),
    ).toEqual(expect.objectContaining({ status: "block" }));
  });
});
