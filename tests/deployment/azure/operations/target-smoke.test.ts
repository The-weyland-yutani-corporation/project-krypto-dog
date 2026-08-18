jest.mock("@/deployment/target-smoke", () => ({
  ...jest.requireActual("@/deployment/target-smoke"),
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
  ADMIN_ENTRA_TENANT_ID: "11111111-1111-4111-8111-111111111111",
  ADMIN_ENTRA_AUDIENCE: "22222222-2222-4222-8222-222222222222",
  ADMIN_ENTRA_ISSUER:
    "https://login.microsoftonline.com/11111111-1111-4111-8111-111111111111/v2.0",
  ADMIN_ENTRA_OPERATOR_ALLOWLIST:
    '[{"id":"33333333-3333-4333-8333-333333333333","name":"Target Smoke Operator","role":"RELEASE_OWNER"}]',
  ADMIN_ENTRA_MFA_AUTH_CONTEXT: "c1",
  ADMIN_ENTRA_STEP_UP_AUTH_CONTEXT: "c2",
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
      await expect(run(CONTEXT)).rejects.toThrow(/required/);
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
        adminIdentity: {
          tenantId: REQUIRED_ENV.ADMIN_ENTRA_TENANT_ID,
          audience: REQUIRED_ENV.ADMIN_ENTRA_AUDIENCE,
          issuer: REQUIRED_ENV.ADMIN_ENTRA_ISSUER,
          operatorId: "33333333-3333-4333-8333-333333333333",
          operatorRole: "RELEASE_OWNER",
          mfaAuthContext: "c1",
          stepUpAuthContext: "c2",
        },
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
