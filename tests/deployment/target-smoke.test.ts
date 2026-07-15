import {
  extractSessionCookie,
  runTargetSmoke,
  validateTargetBaseUrl,
} from "@/deployment/target-smoke";

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
  if (url.pathname === "/api/auth/login") {
    return Response.json(
      { success: true },
      {
        headers: {
          "set-cookie":
            "krypto-admin-token=token-value; Path=/; HttpOnly; SameSite=Lax",
        },
      },
    );
  }
  if (url.pathname === "/admin") {
    return new Response("admin", {
      status: headers.has("cookie") ? 200 : 401,
    });
  }
  if (url.pathname === "/api/admin/run-agent") {
    return headers.has("cookie") &&
      headers.get("x-required-rollout-mode") === "disabled"
      ? Response.json({ action: "disabled" })
      : Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (url.pathname === "/api/auth/logout") {
    return new Response(null, {
      status: 303,
      headers: {
        "set-cookie":
          "krypto-admin-token=; Path=/; Max-Age=0; HttpOnly",
      },
    });
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
  });

  afterAll(() => {
    if (originalRolloutMode === undefined) {
      delete process.env.ROLLOUT_MODE;
    } else {
      process.env.ROLLOUT_MODE = originalRolloutMode;
    }
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

  it("extracts only the admin session cookie", () => {
    const headers = new Headers({
      "set-cookie":
        "krypto-admin-token=token-value; Path=/; HttpOnly; SameSite=Lax",
    });
    expect(extractSessionCookie(headers)).toBe(
      "krypto-admin-token=token-value",
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
        adminPassword: "admin-password",
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
                runCount: 2,
                disabledRunCount: 2,
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
    expect(report.checks).toHaveLength(15);
    expect(report.checks.every((check) => check.status === "pass")).toBe(
      true,
    );
    expect(createApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        targetOrigin: "https://krypto.example.com",
        cronSecret: "cron-secret",
      }),
    );
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
        adminPassword: "admin-password",
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
        adminPassword: "admin-password",
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
        adminPassword: "admin-password",
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
        adminPassword: "admin-password",
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
                runCount: 1,
                disabledRunCount: 1,
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
});
