jest.mock("@/deployment/target-smoke", () => ({
  runTargetSmoke: jest.fn(),
  validateImageDigest: jest.fn((value: string) => value),
}));

import { runTargetSmoke, validateImageDigest } from "@/deployment/target-smoke";

import { run } from "../../../../scripts/azure/operations/target-smoke";
import type { AzureOperationContext } from "../../../../scripts/azure/operations/types";

const mockedRunTargetSmoke = jest.mocked(runTargetSmoke);
const mockedValidateImageDigest = jest.mocked(validateImageDigest);

const CONTEXT: AzureOperationContext = {
  environmentName: "prod-eastus",
  releaseSha: "d".repeat(40),
  jobExecutionId: "job-1",
  reportDirectory: "/tmp/ops-reports/prod-eastus/ddd/target-smoke/job-1",
};

const REQUIRED_ENV = {
  TARGET_BASE_URL: "https://prod.example.com",
  TARGET_CONFIRM_HOST: "prod.example.com",
  DIRECT_URL: "postgresql://user:pass@db.example.com/krypto",
  CRON_SECRET: "cron-secret-value",
  ADMIN_PASSWORD: "admin-password-value",
  IMAGE_DIGEST: `sha256:${"e".repeat(64)}`,
  DEPLOYMENT_APPROVAL_SECRET: "a".repeat(40),
};

describe("scripts/azure/operations/target-smoke", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    mockedRunTargetSmoke.mockReset();
    mockedValidateImageDigest.mockReset();
    mockedValidateImageDigest.mockImplementation((value: string) => value);
    for (const key of Object.keys(REQUIRED_ENV)) {
      savedEnv[key] = process.env[key];
      process.env[key] = REQUIRED_ENV[key as keyof typeof REQUIRED_ENV];
    }
  });

  afterEach(() => {
    for (const key of Object.keys(REQUIRED_ENV)) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it.each(Object.keys(REQUIRED_ENV))(
    "requires %s before invoking runTargetSmoke",
    async (missingKey) => {
      delete process.env[missingKey];
      await expect(run(CONTEXT)).rejects.toThrow(/required for the target-smoke operation/);
      expect(mockedRunTargetSmoke).not.toHaveBeenCalled();
    },
  );

  it("binds context.releaseSha and env-sourced values into runTargetSmoke", async () => {
    mockedRunTargetSmoke.mockResolvedValueOnce({
      passed: true,
    } as never);

    await run(CONTEXT);

    expect(mockedRunTargetSmoke).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: REQUIRED_ENV.TARGET_BASE_URL,
        expectedHost: REQUIRED_ENV.TARGET_CONFIRM_HOST,
        databaseUrl: REQUIRED_ENV.DIRECT_URL,
        cronSecret: REQUIRED_ENV.CRON_SECRET,
        adminPassword: REQUIRED_ENV.ADMIN_PASSWORD,
        releaseSha: CONTEXT.releaseSha,
        imageDigest: REQUIRED_ENV.IMAGE_DIGEST,
        approvalSecret: REQUIRED_ENV.DEPLOYMENT_APPROVAL_SECRET,
      }),
    );
  });

  it("mirrors report.passed for the operation result", async () => {
    mockedRunTargetSmoke.mockResolvedValueOnce({ passed: false } as never);
    const result = await run(CONTEXT);
    expect(result.passed).toBe(false);
    expect(result.report).toEqual({ passed: false });
  });
});
