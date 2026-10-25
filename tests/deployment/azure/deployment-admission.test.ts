import {
  runDeploymentAdmission,
  type DeploymentAdmissionReport,
} from "@/deployment/deployment-admission";
import { run } from "../../../scripts/azure/operations/deployment-admission";
import type { AzureOperationContext } from "../../../scripts/azure/operations/types";
import { verifyWorkflowObservation, type CutoverObservation } from "@/deployment/workflow-observation";
import { signedCutoverFixture, OBSERVATION_TRUST } from "../workflow-observation-fixture";

jest.mock("@/deployment/deployment-admission", () => ({
  ...jest.requireActual("@/deployment/deployment-admission"),
  runDeploymentAdmission: jest.fn(),
}));
jest.mock("@/deployment/workflow-observation", () => ({
  ...jest.requireActual("@/deployment/workflow-observation"),
  verifyWorkflowObservation: jest.fn(),
}));
const mockedAdmission = jest.mocked(runDeploymentAdmission);
const mockedVerify = jest.mocked(verifyWorkflowObservation);
const actualObservation = jest.requireActual<typeof import("@/deployment/workflow-observation")>(
  "@/deployment/workflow-observation",
);
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
    schemaVersion: "1.1.0",
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
    workflowObservation: null,
  };
}

async function prepareRelease(releaseSha = CANDIDATE, overrides: Partial<CutoverObservation> = {}) {
  const now = new Date();
  const fixture = await signedCutoverFixture({ releaseSha, imageDigest: DIGEST, ...overrides }, now);
  Object.assign(process.env, {
    DEPLOYMENT_FENCE_ACTION: "release-attested-v1",
    DEPLOYMENT_WORKFLOW_OBSERVATION: fixture.proof,
    DEPLOYMENT_REPOSITORY: OBSERVATION_TRUST.repository,
    DEPLOYMENT_REPOSITORY_ID: OBSERVATION_TRUST.repositoryId,
    DEPLOYMENT_REPOSITORY_OWNER_ID: OBSERVATION_TRUST.repositoryOwnerId,
    OPS_IMAGE_DIGEST: fixture.observation.opsImageDigest,
  });
  mockedVerify.mockImplementation((input, expected) => actualObservation.verifyWorkflowObservation(
    input, expected, { now, keys: fixture.keys },
  ));
  return fixture;
}

describe("production admission ops adapter", () => {
  beforeEach(() => {
    jest.replaceProperty(process, "env", { ...process.env, ...baseEnv });
    mockedAdmission.mockReset();
    mockedVerify.mockReset();
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
    const fixture = await prepareRelease(releaseSha);
    delete process.env.CRON_SECRET;
    delete process.env.DEPLOYMENT_APPROVAL_SECRET;
    mockedAdmission.mockResolvedValueOnce({ ...report("released"), action: "release" });
    expect((await run({ ...context, releaseSha })).passed).toBe(true);
    expect(mockedAdmission.mock.calls[0][0]).not.toHaveProperty("approvalSecret");
    expect(mockedVerify).toHaveBeenCalledWith(fixture.proof, fixture.expected);
    expect(process.env.DEPLOYMENT_WORKFLOW_OBSERVATION).toBeUndefined();
    expect(JSON.stringify(mockedAdmission.mock.calls[0][0])).not.toContain(fixture.token);
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
    process.env.DEPLOYMENT_FENCE_ACTION = "release-attested-v1";
    await expect(run({ ...context, releaseSha: "d".repeat(40) })).rejects.toThrow(/bound release/);
    expect(mockedAdmission).not.toHaveBeenCalled();
  });

  it.each(Object.keys(baseEnv))("requires %s for an acquisition", async (key) => {
    delete process.env[key];
    await expect(run(context)).rejects.toThrow(/required/);
    expect(mockedAdmission).not.toHaveBeenCalled();
  });

  it.each([
    "DEPLOYMENT_WORKFLOW_OBSERVATION", "DEPLOYMENT_REPOSITORY",
    "DEPLOYMENT_REPOSITORY_ID", "DEPLOYMENT_REPOSITORY_OWNER_ID", "OPS_IMAGE_DIGEST",
  ])("requires trusted release evidence input %s before database mutation", async (name) => {
    await prepareRelease();
    delete process.env[name];
    await expect(run({ ...context, releaseSha: CANDIDATE })).rejects.toThrow();
    expect(mockedAdmission).not.toHaveBeenCalled();
  });

  it.each([
    ["IMAGE_DIGEST", `sha256:${"f".repeat(64)}`],
    ["OPS_IMAGE_DIGEST", `sha256:${"f".repeat(64)}`],
    ["TARGET_ORIGIN", "https://another.example.com"],
    ["DEPLOYMENT_REPOSITORY_ID", "9999"],
    ["DEPLOYMENT_WORKFLOW_OBSERVATION", '{"observation":{},"token":"caller-input"}'],
  ])("rejects altered release evidence/context %s before database mutation", async (name, value) => {
    await prepareRelease();
    process.env[name] = value;
    await expect(run({ ...context, releaseSha: CANDIDATE })).rejects.toThrow();
    expect(mockedAdmission).not.toHaveBeenCalled();
  });

  it("does not admit the old unsigned wire action", async () => {
    process.env.DEPLOYMENT_FENCE_ACTION = "release";
    await expect(run(context)).rejects.toThrow(/Legacy unsigned/);
    expect(mockedAdmission).not.toHaveBeenCalled();
  });

  it("can compensate a disabled source using the new candidate ops image", async () => {
    await prepareRelease(SOURCE);
    process.env.IMAGE_DIGEST = `sha256:${"d".repeat(64)}`;
    mockedAdmission.mockResolvedValue({ ...report("released"), action: "release" });
    expect(await run({ ...context, releaseSha: CANDIDATE })).toMatchObject({ passed: true });
  });

  it.each([DIGEST, `sha256:${"d".repeat(64)}`])(
    "handles source compensation or a rebuilt candidate at the same source/candidate SHA (%s)",
    async (imageDigest) => {
      await prepareRelease(CANDIDATE, { sourceReleaseSha: CANDIDATE, imageDigest });
      process.env.DEPLOYMENT_SOURCE_RELEASE_SHA = CANDIDATE;
      process.env.IMAGE_DIGEST = `sha256:${"d".repeat(64)}`;
      mockedAdmission.mockResolvedValue({ ...report("released"), action: "release" });
      expect(await run({ ...context, releaseSha: CANDIDATE })).toMatchObject({ passed: true });
      expect(mockedAdmission.mock.calls[0][0]).toMatchObject({
        sourceReleaseSha: CANDIDATE, candidateReleaseSha: CANDIDATE, imageDigest: DIGEST,
      });
    },
  );
});
