import {
  runDeploymentAdmission,
  type DeploymentAdmissionReport,
} from "@/deployment/deployment-admission";
import { run } from "../../../scripts/azure/operations/deployment-admission";
import type { AzureOperationContext } from "../../../scripts/azure/operations/types";

jest.mock("@/deployment/deployment-admission", () => ({
  ...jest.requireActual("@/deployment/deployment-admission"),
  runDeploymentAdmission: jest.fn(),
}));
const mockedAdmission = jest.mocked(runDeploymentAdmission);
const SOURCE = "a".repeat(40);
const CANDIDATE = "b".repeat(40);
const DIGEST = `sha256:${"c".repeat(64)}`;
const OWNER = "11111111-1111-4111-8111-111111111111";
const context: AzureOperationContext = {
  environmentName: "prod",
  releaseSha: SOURCE,
  jobExecutionId: "run1-a1-deployment-admission",
  reportDirectory: "unused",
};
const baseEnv = {
  CONTAINER_APP_JOB_EXECUTION_NAME: "execution-1",
  DIRECT_URL: "postgres://ops:secret@127.0.0.1/disposable",
  DEPLOYMENT_FENCE_ACTION: "acquire",
  DEPLOYMENT_FENCE_OWNER: OWNER,
  DEPLOYMENT_SOURCE_RELEASE_SHA: SOURCE,
  DEPLOYMENT_CANDIDATE_RELEASE_SHA: CANDIDATE,
  DEPLOYMENT_SOURCE_IMAGE_DIGEST: DIGEST,
  TARGET_ORIGIN: "https://krypto.example.com",
  IMAGE_DIGEST: DIGEST,
  CRON_SECRET: "test-cron-secret",
  DEPLOYMENT_APPROVAL_SECRET: "test-approval-secret-over-32-characters",
};
function report(status: DeploymentAdmissionReport["status"]): DeploymentAdmissionReport {
  return {
    schemaVersion: "1.0.0",
    generatedAt: new Date().toISOString(),
    operation: "deployment-admission",
    action: "acquire",
    owner: OWNER,
    sourceReleaseSha: SOURCE,
    candidateReleaseSha: CANDIDATE,
    imageDigest: DIGEST,
    targetOrigin: baseEnv.TARGET_ORIGIN,
    status,
    reason: "test",
    summary: "test",
    expiresAt: null,
  };
}

describe("production admission ops adapter", () => {
  beforeEach(() => {
    jest.replaceProperty(process, "env", { ...process.env, ...baseEnv });
    mockedAdmission.mockReset();
  });
  afterEach(() => jest.restoreAllMocks());

  it.each(["admitted", "released", "deferred", "blocked"] as const)(
    "never reports %s as an acquired fence unless it is admitted",
    async (status) => {
      mockedAdmission.mockResolvedValueOnce(report(status));
      const result = await run(context);
      expect(result.passed).toBe(status === "admitted");
      expect(result.report).toMatchObject({
        environmentName: "prod",
        releaseSha: SOURCE,
        jobExecutionId: context.jobExecutionId,
        azureExecutionName: "execution-1",
      });
    },
  );

  it("passes only the exact source binding and protected secrets to acquisition", async () => {
    mockedAdmission.mockResolvedValueOnce(report("admitted"));
    await run(context);
    expect(mockedAdmission).toHaveBeenCalledWith({
      action: "acquire",
      owner: OWNER,
      sourceReleaseSha: SOURCE,
      candidateReleaseSha: CANDIDATE,
      imageDigest: DIGEST,
      targetOrigin: baseEnv.TARGET_ORIGIN,
      databaseUrl: baseEnv.DIRECT_URL,
      cronSecret: baseEnv.CRON_SECRET,
      approvalSecret: baseEnv.DEPLOYMENT_APPROVAL_SECRET,
    });
  });

  it.each([SOURCE, CANDIDATE])("can release through only the bound source or candidate job (%s)", async (releaseSha) => {
    process.env.DEPLOYMENT_FENCE_ACTION = "release";
    delete process.env.CRON_SECRET;
    delete process.env.DEPLOYMENT_APPROVAL_SECRET;
    mockedAdmission.mockResolvedValueOnce({ ...report("released"), action: "release" });
    expect((await run({ ...context, releaseSha })).passed).toBe(true);
    expect(mockedAdmission.mock.calls[0][0]).not.toHaveProperty("approvalSecret");
  });

  it.each([
    { environmentName: "dev" },
    { releaseSha: CANDIDATE },
    { releaseSha: "d".repeat(40) },
  ])("rejects a mismatched acquisition job before database access: %j", async (overrides) => {
    await expect(run({ ...context, ...overrides })).rejects.toThrow();
    expect(mockedAdmission).not.toHaveBeenCalled();
  });

  it("rejects a source image mismatch", async () => {
    process.env.IMAGE_DIGEST = `sha256:${"d".repeat(64)}`;
    await expect(run(context)).rejects.toThrow(/bound release/);
    expect(mockedAdmission).not.toHaveBeenCalled();
  });

  it("verifies through the candidate job without acquiring or extending a fence", async () => {
    process.env.DEPLOYMENT_FENCE_ACTION = "verify";
    mockedAdmission.mockResolvedValueOnce({ ...report("held"), action: "verify" });
    expect((await run({ ...context, releaseSha: CANDIDATE })).passed).toBe(true);
    expect(mockedAdmission.mock.calls[0][0]).toMatchObject({ action: "verify", owner: OWNER });
    expect(mockedAdmission.mock.calls[0][0]).not.toHaveProperty("approvalSecret");
  });

  it("rejects a release from an unrelated ops image", async () => {
    process.env.DEPLOYMENT_FENCE_ACTION = "release";
    await expect(run({ ...context, releaseSha: "d".repeat(40) })).rejects.toThrow(/bound release/);
    expect(mockedAdmission).not.toHaveBeenCalled();
  });

  it.each(Object.keys(baseEnv))("requires %s for an acquisition", async (key) => {
    delete process.env[key];
    await expect(run(context)).rejects.toThrow(/required/);
    expect(mockedAdmission).not.toHaveBeenCalled();
  });
});
