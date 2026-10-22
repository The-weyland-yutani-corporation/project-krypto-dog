import { runProductionVerification, type ProductionVerificationReport } from "@/deployment/production-verification";
import { run } from "../../../scripts/azure/operations/production-verification";

jest.mock("@/deployment/production-verification", () => ({ runProductionVerification: jest.fn() }));

const verify = jest.mocked(runProductionVerification);
const context = {
  environmentName: "prod", releaseSha: "a".repeat(40),
  jobExecutionId: "run1-a1-ready", reportDirectory: "unused",
};
const report: ProductionVerificationReport = {
  schemaVersion: "1.0.0", operation: "production-verification", phase: "ready", intendedMode: "paper",
  generatedAt: "2026-10-22T00:01:00Z", releaseSha: context.releaseSha, imageDigest: `sha256:${"b".repeat(64)}`,
  targetOrigin: "https://production.example.com", authorizationId: "c".repeat(64), scheduleGeneration: 1792620000,
  approved: true, checks: [], blockers: [], approvalId: "approval-1", shadowRun: null, scheduledRun: null,
  posthog: { environment: "prod", host: "https://us.i.posthog.com", keySha256: "d".repeat(64) },
};
const env = {
  PRODUCTION_VERIFICATION_PHASE: "ready",
  CONTAINER_APP_JOB_EXECUTION_NAME: "azure-execution-1",
  DIRECT_URL: "postgresql://test.invalid/krypto", IMAGE_DIGEST: report.imageDigest,
  TARGET_BASE_URL: report.targetOrigin, CRON_SECRET: "test-only-cron-secret",
  DEPLOYMENT_APPROVAL_SECRET: "test-only-long-approval-secret",
  PRODUCTION_AUTHORIZATION_ID: report.authorizationId,
  SCHEDULE_GENERATION_UNIX_SECONDS: String(report.scheduleGeneration),
  EXPECTED_APPROVAL_ID: "approval-1", EXPECTED_APPROVAL_CREATED_AFTER: "2026-10-22T00:00:00Z",
  EXPECTED_SHADOW_IDEMPOTENCY_KEY: "manual-shadow:run-1", EXPECTED_SHADOW_STARTED_AFTER: "2026-10-22T00:00:00Z",
  POSTHOG_API_KEY: "test-only-project-key", POSTHOG_HOST: report.posthog.host, POSTHOG_ENVIRONMENT: "prod",
};

describe("production verification ops adapter", () => {
  beforeEach(() => {
    jest.replaceProperty(process, "env", { ...env });
    verify.mockReset().mockResolvedValue(report);
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([true, false])("preserves the explicit pass/fail result and Azure's builtin execution identity (%s)", async (approved) => {
    verify.mockResolvedValue({ ...report, approved });
    const result = await run(context);
    expect(result).toMatchObject({
      passed: approved,
      report: {
        approved, environmentName: "prod", jobExecutionId: context.jobExecutionId,
        azureExecutionName: env.CONTAINER_APP_JOB_EXECUTION_NAME,
      },
    });
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({
      phase: "ready", expectedApprovalId: env.EXPECTED_APPROVAL_ID,
      approvalCreatedAfter: env.EXPECTED_APPROVAL_CREATED_AFTER,
      expectedShadowIdempotencyKey: env.EXPECTED_SHADOW_IDEMPOTENCY_KEY,
    }));
  });

  it("passes the actual enablement and execution boundaries without consulting unused shadow credentials", async () => {
    process.env.PRODUCTION_VERIFICATION_PHASE = "scheduled";
    process.env.SCHEDULE_ENABLED_AT_UNIX_SECONDS = "1792620005";
    process.env.SCHEDULED_EXECUTION_STARTED_AT = "2026-10-22T01:00:01Z";
    delete process.env.CRON_SECRET;
    delete process.env.DEPLOYMENT_APPROVAL_SECRET;
    delete process.env.EXPECTED_SHADOW_IDEMPOTENCY_KEY;
    await run(context);
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({
      phase: "scheduled", scheduleEnabledAt: 1792620005,
      scheduledExecutionStartedAt: "2026-10-22T01:00:01Z",
    }));
    expect(verify.mock.calls[0][0]).not.toHaveProperty("cronSecret");
  });

  it.each([
    "CONTAINER_APP_JOB_EXECUTION_NAME", "DIRECT_URL", "PRODUCTION_AUTHORIZATION_ID",
    "EXPECTED_APPROVAL_ID", "EXPECTED_SHADOW_STARTED_AFTER", "POSTHOG_API_KEY",
  ])("rejects missing %s rather than substituting caller identity or a default", async (name) => {
    delete process.env[name];
    await expect(run(context)).rejects.toThrow(name);
    expect(verify).not.toHaveBeenCalled();
  });

  it.each(["0", "1.5", "01", "1e9", "99999999999"])("rejects malformed generation %s", async (value) => {
    process.env.SCHEDULE_GENERATION_UNIX_SECONDS = value;
    await expect(run(context)).rejects.toThrow("positive epoch-second");
    expect(verify).not.toHaveBeenCalled();
  });

  it("rejects another environment or an unknown operation phase", async () => {
    await expect(run({ ...context, environmentName: "dev" })).rejects.toThrow("production ops identity");
    process.env.PRODUCTION_VERIFICATION_PHASE = "live";
    await expect(run(context)).rejects.toThrow("Unknown production");
    expect(verify).not.toHaveBeenCalled();
  });
});
