jest.mock("@/deployment/activation-check", () => ({
  runActivationCheck: jest.fn(),
}));

import { runActivationCheck } from "@/deployment/activation-check";

import { run } from "../../../../scripts/azure/operations/activation-check";
import type { AzureOperationContext } from "../../../../scripts/azure/operations/types";

const mockedRunActivationCheck = jest.mocked(runActivationCheck);

const CONTEXT: AzureOperationContext = {
  environmentName: "prod-eastus",
  releaseSha: "f".repeat(40),
  jobExecutionId: "job-1",
  reportDirectory: "/tmp/ops-reports/prod-eastus/fff/activation-check/job-1",
};

const REQUIRED_ENV = {
  DIRECT_URL: "postgresql://user:pass@db.example.com/krypto",
  TARGET_ORIGIN: "https://prod.example.com",
  CRON_SECRET: "cron-secret-value",
  IMAGE_DIGEST: `sha256:${"1".repeat(64)}`,
  DEPLOYMENT_APPROVAL_SECRET: "b".repeat(40),
};

describe("scripts/azure/operations/activation-check", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    mockedRunActivationCheck.mockReset();
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
    "requires %s before invoking runActivationCheck",
    async (missingKey) => {
      delete process.env[missingKey];
      await expect(run(CONTEXT)).rejects.toThrow(
        /required for the activation-check operation/,
      );
      expect(mockedRunActivationCheck).not.toHaveBeenCalled();
    },
  );

  it("binds context.releaseSha and env-sourced values into runActivationCheck", async () => {
    mockedRunActivationCheck.mockResolvedValueOnce({ approved: true } as never);

    await run(CONTEXT);

    expect(mockedRunActivationCheck).toHaveBeenCalledWith({
      databaseUrl: REQUIRED_ENV.DIRECT_URL,
      releaseSha: CONTEXT.releaseSha,
      imageDigest: REQUIRED_ENV.IMAGE_DIGEST,
      targetOrigin: REQUIRED_ENV.TARGET_ORIGIN,
      cronSecret: REQUIRED_ENV.CRON_SECRET,
      approvalSecret: REQUIRED_ENV.DEPLOYMENT_APPROVAL_SECRET,
    });
  });

  it("mirrors report.approved (fail-closed) as the operation's passed result", async () => {
    mockedRunActivationCheck.mockResolvedValueOnce({ approved: false } as never);
    const result = await run(CONTEXT);
    expect(result.passed).toBe(false);
    expect(result.report).toEqual({ approved: false });
  });
});
