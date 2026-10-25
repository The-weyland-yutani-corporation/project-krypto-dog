import {
  inspectEmptyDatabase,
  type DatabaseInspection,
} from "@/deployment/database-inspection";
import { run } from "../../../scripts/azure/operations/database-inspection";

jest.mock("@/deployment/database-inspection", () => ({
  inspectEmptyDatabase: jest.fn(),
}));
const inspect = jest.mocked(inspectEmptyDatabase);
const context = {
  environmentName: "prod",
  releaseSha: "a".repeat(40),
  jobExecutionId: "run1-a1-database-inspection",
  reportDirectory: "unused",
};
const env = {
  OPS_IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
  CONTAINER_APP_JOB_EXECUTION_NAME: "native-execution-1",
  DIRECT_URL: "postgresql://owner:fixture-password@localhost/disposable",
  DATABASE_INSPECTION_HOST: "localhost",
  DATABASE_INSPECTION_NAME: "disposable",
  AZURE_RUNTIME_LOGIN_ROLE: "krypto_app",
};
const empty: DatabaseInspection = {
  databaseHost: "localhost",
  databaseName: "disposable",
  runtimeLoginRole: "krypto_app",
  observedAt: new Date().toISOString(),
  readOnly: true,
  objectCount: 0,
  runtimeRolePresent: false,
  runtimeLoginPresent: false,
  empty: true,
};

describe("database inspection ops adapter", () => {
  beforeEach(() => {
    jest.replaceProperty(process, "env", { ...process.env, ...env });
    inspect.mockReset();
    inspect.mockResolvedValue(empty);
  });
  afterEach(() => jest.restoreAllMocks());

  it("binds the exact configured target and actual execution without reporting credentials", async () => {
    const result = await run(context);
    expect(inspect).toHaveBeenCalledWith({
      directUrl: env.DIRECT_URL,
      expectedHost: "localhost",
      expectedDatabase: "disposable",
      runtimeLoginRole: "krypto_app",
    });
    expect(result).toMatchObject({
      passed: true,
      report: {
        schemaVersion: "1.0.0",
        operation: "database-inspection",
        environmentName: "prod",
        releaseSha: context.releaseSha,
        jobExecutionId: context.jobExecutionId,
        azureExecutionName: env.CONTAINER_APP_JOB_EXECUTION_NAME,
        imageDigest: env.OPS_IMAGE_DIGEST,
        approved: true,
        reason: "empty-database",
        inspection: empty,
      },
    });
    expect(JSON.stringify(result)).not.toContain("fixture-password");
  });

  it("publishes an explicit blocked outcome for retained database or role state", async () => {
    inspect.mockResolvedValue({ ...empty, objectCount: 4, empty: false });
    await expect(run(context)).resolves.toMatchObject({
      passed: false,
      report: { approved: false, reason: "existing-database-state" },
    });
  });

  it("publishes read failures without credential-bearing driver diagnostics", async () => {
    inspect.mockRejectedValue(new Error(`connection failed: ${env.DIRECT_URL}`));
    const result = await run(context);
    expect(result).toMatchObject({
      passed: false,
      report: {
        approved: false,
        reason: "database-inspection-failed",
        inspection: null,
      },
    });
    expect(JSON.stringify(result)).not.toContain("fixture-password");
    expect(JSON.stringify(result)).not.toContain(env.DIRECT_URL);
  });

  it.each([
    "OPS_IMAGE_DIGEST", "CONTAINER_APP_JOB_EXECUTION_NAME",
    "DATABASE_INSPECTION_HOST", "DATABASE_INSPECTION_NAME", "AZURE_RUNTIME_LOGIN_ROLE",
  ])("refuses missing %s before inspecting", async (name) => {
    delete process.env[name];
    await expect(run(context)).rejects.toThrow(name);
    expect(inspect).not.toHaveBeenCalled();
  });
});
