import { GET } from "@/app/api/health/route";
import { buildHealthPayload } from "@/lib/health";

describe("health payload", () => {
  it("reports the effective disabled rollout mode with no harness mode", () => {
    expect(
      buildHealthPayload({ NODE_ENV: "development", ROLLOUT_MODE: "disabled" }),
    ).toEqual({ status: "ok", rolloutMode: "disabled", harnessMode: null });
  });

  it("surfaces the mock harness mode when set", () => {
    expect(
      buildHealthPayload({
        NODE_ENV: "development",
        ROLLOUT_MODE: "shadow",
        AGENT_HARNESS_MODE: "mock",
      }),
    ).toEqual({ status: "ok", rolloutMode: "shadow", harnessMode: "mock" });
  });

  it("only echoes known harness modes", () => {
    expect(
      buildHealthPayload({
        ROLLOUT_MODE: "disabled",
        AGENT_HARNESS_MODE: "bogus",
      }).harnessMode,
    ).toBeNull();
    expect(
      buildHealthPayload({
        ROLLOUT_MODE: "shadow",
        AGENT_HARNESS_MODE: "smoke",
      }).harnessMode,
    ).toBe("smoke");
  });

  it("never leaks secret-bearing keys", () => {
    const payload = buildHealthPayload({
      NODE_ENV: "development",
      ROLLOUT_MODE: "disabled",
      DATABASE_URL: "postgresql://u:p@localhost/db",
      ADMIN_PASSWORD: "super-secret",
      ANTHROPIC_FOUNDRY_API_KEY: "real",
    });
    expect(Object.keys(payload).sort()).toEqual([
      "harnessMode",
      "rolloutMode",
      "status",
    ]);
  });
});

describe("health route", () => {
  const originalMode = process.env.ROLLOUT_MODE;
  const originalHarness = process.env.AGENT_HARNESS_MODE;

  afterEach(() => {
    if (originalMode === undefined) delete process.env.ROLLOUT_MODE;
    else process.env.ROLLOUT_MODE = originalMode;
    if (originalHarness === undefined) delete process.env.AGENT_HARNESS_MODE;
    else process.env.AGENT_HARNESS_MODE = originalHarness;
  });

  it("returns a no-store 200 with the non-sensitive payload", async () => {
    process.env.ROLLOUT_MODE = "disabled";
    delete process.env.AGENT_HARNESS_MODE;
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      rolloutMode: "disabled",
      harnessMode: null,
    });
  });

  it("fails closed without leaking internals on invalid rollout config", async () => {
    process.env.ROLLOUT_MODE = "live";
    const response = await GET();
    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      status: "error",
      error: "Invalid rollout configuration",
    });
  });
});
