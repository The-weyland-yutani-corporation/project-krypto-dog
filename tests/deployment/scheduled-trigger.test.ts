import {
  buildIdempotencyKey,
  resolveScheduledTriggerConfig,
  runScheduledTrigger,
  ScheduledTriggerConfigError,
  ScheduledTriggerRequestError,
  validateCronSecret,
  validateRolloutMode,
  validateScheduledRoute,
  validateTargetBaseUrl,
} from "@/deployment/scheduled-trigger";

const VALID_ENV = {
  TARGET_BASE_URL: "https://krypto.example.com",
  SCHEDULED_ROUTE: "/api/agent/run",
  CRON_SECRET: "trigger-secret",
  ROLLOUT_MODE: "disabled",
};

describe("validateTargetBaseUrl", () => {
  it("accepts an HTTPS base URL", () => {
    const url = validateTargetBaseUrl("https://krypto.example.com");
    expect(url.toString()).toBe("https://krypto.example.com/");
  });

  it("accepts an HTTP loopback target", () => {
    expect(() => validateTargetBaseUrl("http://localhost:3000")).not.toThrow();
    expect(() => validateTargetBaseUrl("http://127.0.0.1:3000")).not.toThrow();
    expect(() => validateTargetBaseUrl("http://[::1]:3000")).not.toThrow();
  });

  it("rejects a missing value", () => {
    expect(() => validateTargetBaseUrl(undefined)).toThrow(
      ScheduledTriggerConfigError,
    );
    expect(() => validateTargetBaseUrl("")).toThrow(
      ScheduledTriggerConfigError,
    );
  });

  it("rejects a malformed URL", () => {
    expect(() => validateTargetBaseUrl("not-a-url")).toThrow(
      ScheduledTriggerConfigError,
    );
  });

  it("rejects a non-HTTP(S) protocol", () => {
    expect(() => validateTargetBaseUrl("ftp://krypto.example.com")).toThrow(
      ScheduledTriggerConfigError,
    );
  });

  it("rejects plain HTTP against a non-loopback host", () => {
    expect(() => validateTargetBaseUrl("http://krypto.example.com")).toThrow(
      /HTTPS/,
    );
  });

  it("rejects embedded credentials, query, or fragment", () => {
    expect(() =>
      validateTargetBaseUrl("https://user:pass@krypto.example.com"),
    ).toThrow(ScheduledTriggerConfigError);
    expect(() =>
      validateTargetBaseUrl("https://krypto.example.com/?x=1"),
    ).toThrow(ScheduledTriggerConfigError);
    expect(() =>
      validateTargetBaseUrl("https://krypto.example.com/#frag"),
    ).toThrow(ScheduledTriggerConfigError);
  });

  it("rejects a non-root pathname (must be a bare origin; SCHEDULED_ROUTE supplies the path)", () => {
    expect(() =>
      validateTargetBaseUrl("https://krypto.example.com/api/agent/run"),
    ).toThrow(ScheduledTriggerConfigError);
    expect(() =>
      validateTargetBaseUrl("https://krypto.example.com/some/sub/path"),
    ).toThrow(/bare origin/);
  });

  it("accepts an explicit trailing-slash root pathname", () => {
    expect(() =>
      validateTargetBaseUrl("https://krypto.example.com/"),
    ).not.toThrow();
  });
});

describe("validateScheduledRoute", () => {
  it("accepts the two allowed routes", () => {
    expect(validateScheduledRoute("/api/agent/run")).toBe("/api/agent/run");
    expect(validateScheduledRoute("/api/agent/daily-summary")).toBe(
      "/api/agent/daily-summary",
    );
  });

  it("rejects any other route", () => {
    expect(() => validateScheduledRoute("/api/admin/run-agent")).toThrow(
      ScheduledTriggerConfigError,
    );
    expect(() => validateScheduledRoute(undefined)).toThrow(
      ScheduledTriggerConfigError,
    );
    expect(() => validateScheduledRoute("")).toThrow(
      ScheduledTriggerConfigError,
    );
    expect(() => validateScheduledRoute("/api/agent/run/")).toThrow(
      ScheduledTriggerConfigError,
    );
  });
});

describe("validateCronSecret", () => {
  it("accepts a non-empty string", () => {
    expect(validateCronSecret("s3cret")).toBe("s3cret");
  });

  it("rejects missing or blank values", () => {
    expect(() => validateCronSecret(undefined)).toThrow(
      ScheduledTriggerConfigError,
    );
    expect(() => validateCronSecret("")).toThrow(ScheduledTriggerConfigError);
    expect(() => validateCronSecret("   ")).toThrow(
      ScheduledTriggerConfigError,
    );
  });
});

describe("validateRolloutMode", () => {
  it("accepts and normalizes the three trading modes", () => {
    expect(validateRolloutMode("disabled")).toBe("disabled");
    expect(validateRolloutMode("Shadow")).toBe("shadow");
    expect(validateRolloutMode("PAPER")).toBe("paper");
  });

  it("rejects invalid or missing values", () => {
    expect(() => validateRolloutMode("live")).toThrow(
      ScheduledTriggerConfigError,
    );
    expect(() => validateRolloutMode(undefined)).toThrow(
      ScheduledTriggerConfigError,
    );
    expect(() => validateRolloutMode("")).toThrow(ScheduledTriggerConfigError);
  });
});

describe("resolveScheduledTriggerConfig", () => {
  it("resolves a fully valid environment", () => {
    const config = resolveScheduledTriggerConfig(VALID_ENV);
    expect(config.route).toBe("/api/agent/run");
    expect(config.cronSecret).toBe("trigger-secret");
    expect(config.rolloutMode).toBe("disabled");
    expect(config.targetUrl.toString()).toBe("https://krypto.example.com/");
  });

  it("throws on the first invalid field", () => {
    expect(() =>
      resolveScheduledTriggerConfig({ ...VALID_ENV, CRON_SECRET: "" }),
    ).toThrow(ScheduledTriggerConfigError);
  });
});

describe("buildIdempotencyKey", () => {
  it("is stable within the same UTC hour for agent runs", () => {
    const a = buildIdempotencyKey(
      "/api/agent/run",
      new Date("2026-08-12T16:00:00.000Z"),
    );
    const b = buildIdempotencyKey(
      "/api/agent/run",
      new Date("2026-08-12T16:59:59.999Z"),
    );
    expect(a).toBe(b);
    expect(a).toBe("cron:2026-08-12T16");
  });

  it("changes across a UTC hour boundary", () => {
    const a = buildIdempotencyKey(
      "/api/agent/run",
      new Date("2026-08-12T16:59:59.999Z"),
    );
    const b = buildIdempotencyKey(
      "/api/agent/run",
      new Date("2026-08-12T17:00:00.000Z"),
    );
    expect(a).not.toBe(b);
  });

  it("is undefined for daily-summary", () => {
    expect(
      buildIdempotencyKey("/api/agent/daily-summary", new Date()),
    ).toBeUndefined();
  });
});

describe("runScheduledTrigger", () => {
  it("sends the expected headers, method, and idempotency key for agent runs", async () => {
    const fetchImpl = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(async () =>
      Response.json({ ok: true }),
    );

    const outcome = await runScheduledTrigger({
      env: VALID_ENV,
      now: new Date("2026-08-12T16:30:00.000Z"),
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [requestUrl, init] = fetchImpl.mock.calls[0];
    expect(String(requestUrl)).toBe("https://krypto.example.com/api/agent/run");
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers as HeadersInit);
    expect(headers.get("x-cron-secret")).toBe("trigger-secret");
    expect(headers.get("x-required-rollout-mode")).toBe("disabled");
    expect(headers.get("x-idempotency-key")).toBe("cron:2026-08-12T16");
    expect(init?.signal).toBeInstanceOf(AbortSignal);

    expect(outcome.status).toBe(200);
    expect(outcome.route).toBe("/api/agent/run");
    expect(outcome.idempotencyKey).toBe("cron:2026-08-12T16");
    expect(outcome.requestUrl).toBe(
      "https://krypto.example.com/api/agent/run",
    );
    expect(typeof outcome.durationMs).toBe("number");
  });

  it("omits the idempotency key header for daily-summary", async () => {
    const fetchImpl = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(async () =>
      Response.json({ ok: true }),
    );

    await runScheduledTrigger({
      env: { ...VALID_ENV, SCHEDULED_ROUTE: "/api/agent/daily-summary" },
      fetchImpl,
    });

    const [, init] = fetchImpl.mock.calls[0];
    const headers = new Headers(init?.headers as HeadersInit);
    expect(headers.has("x-idempotency-key")).toBe(false);
  });

  it("treats a non-2xx response as a failure", async () => {
    const fetchImpl = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(
      async () => new Response("unauthorized", { status: 401 }),
    );

    await expect(
      runScheduledTrigger({
        env: VALID_ENV,
        fetchImpl,
      }),
    ).rejects.toThrow(ScheduledTriggerRequestError);
  });

  it("includes the response status on request failure", async () => {
    const fetchImpl = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(
      async () => new Response("boom", { status: 500 }),
    );

    await expect(
      runScheduledTrigger({
        env: VALID_ENV,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ status: 500 });
  });

  it("wraps a network failure without leaking the cron secret", async () => {
    const fetchImpl = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(async () => {
      throw new TypeError("fetch failed");
    });

    await expect(
      runScheduledTrigger({
        env: VALID_ENV,
        fetchImpl,
      }),
    ).rejects.toThrow(ScheduledTriggerRequestError);

    try {
      await runScheduledTrigger({
        env: VALID_ENV,
        fetchImpl,
      });
      throw new Error("expected runScheduledTrigger to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ScheduledTriggerRequestError);
      expect((error as Error).message).not.toContain(VALID_ENV.CRON_SECRET);
    }
  });

  it("bounds the request with an abort signal derived from timeoutMs", async () => {
    let capturedSignal: AbortSignal | undefined;
    const fetchImpl = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(async (_url, init) => {
      capturedSignal = init?.signal as AbortSignal;
      return Response.json({ ok: true });
    });

    await runScheduledTrigger({
      env: VALID_ENV,
      fetchImpl,
      timeoutMs: 5,
    });

    expect(capturedSignal).toBeInstanceOf(AbortSignal);
  });

  it("propagates configuration errors before making any request", async () => {
    const fetchImpl = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();

    await expect(
      runScheduledTrigger({
        env: { ...VALID_ENV, SCHEDULED_ROUTE: "/api/admin/run-agent" },
        fetchImpl,
      }),
    ).rejects.toThrow(ScheduledTriggerConfigError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
