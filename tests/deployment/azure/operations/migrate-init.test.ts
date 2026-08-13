jest.mock("../../../../scripts/azure/lib/run-cli", () => ({
  runCli: jest.fn(),
}));

import { runCli } from "../../../../scripts/azure/lib/run-cli";
import { run } from "../../../../scripts/azure/operations/migrate-init";
import type { AzureOperationContext } from "../../../../scripts/azure/operations/types";

const mockedRunCli = jest.mocked(runCli);

const CONTEXT: AzureOperationContext = {
  environmentName: "prod-eastus",
  releaseSha: "a".repeat(40),
  jobExecutionId: "job-1",
  reportDirectory: "/tmp/ops-reports/prod-eastus/aaa/migrate-init/job-1",
};

const REQUIRED_ENV_NAMES = [
  "DIRECT_URL",
  "DATABASE_URL",
  "AZURE_RUNTIME_LOGIN_ROLE",
  "AZURE_RUNTIME_LOGIN_PASSWORD",
] as const;

const RUNTIME_LOGIN_PASSWORD_VALUE = "correct-horse-battery-staple";

function setAllRequiredEnv(): void {
  process.env.DIRECT_URL = "postgres://admin@db.example.com/krypto";
  process.env.DATABASE_URL = "postgres://runtime@db.example.com/krypto";
  process.env.AZURE_RUNTIME_LOGIN_ROLE = "azure_app_identity";
  process.env.AZURE_RUNTIME_LOGIN_PASSWORD = RUNTIME_LOGIN_PASSWORD_VALUE;
}

describe("scripts/azure/operations/migrate-init", () => {
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    mockedRunCli.mockReset();
    for (const name of REQUIRED_ENV_NAMES) {
      originalEnv[name] = process.env[name];
    }
    setAllRequiredEnv();
  });

  afterEach(() => {
    for (const name of REQUIRED_ENV_NAMES) {
      if (originalEnv[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = originalEnv[name];
      }
    }
  });

  it.each(REQUIRED_ENV_NAMES)(
    "requires %s up front before running any command",
    async (name) => {
      delete process.env[name];
      await expect(run(CONTEXT)).rejects.toThrow(
        new RegExp(`${name} is required`),
      );
      expect(mockedRunCli).not.toHaveBeenCalled();
    },
  );

  it("runs migrate, then runtime-login bootstrap, then seed, in that exact order", async () => {
    mockedRunCli.mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
    mockedRunCli.mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
    mockedRunCli.mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });

    const result = await run(CONTEXT);

    expect(mockedRunCli).toHaveBeenNthCalledWith(
      1,
      "npx",
      ["drizzle-kit", "migrate"],
      process.env,
    );
    expect(mockedRunCli).toHaveBeenNthCalledWith(
      2,
      "npx",
      ["tsx", "scripts/bootstrap-azure-runtime-role.ts"],
      process.env,
    );
    expect(mockedRunCli).toHaveBeenNthCalledWith(
      3,
      "npx",
      ["tsx", "scripts/seed.ts"],
      process.env,
    );
    expect(result).toEqual({
      passed: true,
      report: {
        operation: "migrate-init",
        success: true,
        migrated: true,
        runtimeLoginBootstrapped: true,
        initialized: true,
        environmentName: "prod-eastus",
        releaseSha: "a".repeat(40),
      },
    });
  });

  it("never places the runtime login password in an argv entry", async () => {
    mockedRunCli.mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
    mockedRunCli.mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
    mockedRunCli.mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });

    await run(CONTEXT);

    for (const call of mockedRunCli.mock.calls) {
      const [, args] = call;
      for (const arg of args) {
        expect(arg).not.toContain(RUNTIME_LOGIN_PASSWORD_VALUE);
      }
    }
  });

  it("reports failure and never runs the runtime-login bootstrap or seed if migrate fails", async () => {
    mockedRunCli.mockResolvedValueOnce({
      exitCode: 1,
      stdout: "",
      stderr: "migration error",
    });

    const result = await run(CONTEXT);

    expect(mockedRunCli).toHaveBeenCalledTimes(1);
    expect(result.passed).toBe(false);
    expect(result.report).toEqual({
      operation: "migrate-init",
      success: false,
      step: "migrate",
      environmentName: "prod-eastus",
      releaseSha: "a".repeat(40),
      exitCode: 1,
    });
  });

  it("reports failure under the distinct runtime-login-bootstrap step, and never runs seed, if the bootstrap fails", async () => {
    mockedRunCli.mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
    mockedRunCli.mockResolvedValueOnce({
      exitCode: 1,
      stdout: "",
      stderr: `bootstrap failed for password ${RUNTIME_LOGIN_PASSWORD_VALUE}`,
    });

    const result = await run(CONTEXT);

    expect(mockedRunCli).toHaveBeenCalledTimes(2);
    expect(result.passed).toBe(false);
    expect(result.report).toEqual({
      operation: "migrate-init",
      success: false,
      step: "runtime-login-bootstrap",
      environmentName: "prod-eastus",
      releaseSha: "a".repeat(40),
      exitCode: 1,
    });
  });

  it("never leaks the runtime login password or raw stderr into the report when the bootstrap fails", async () => {
    mockedRunCli.mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
    mockedRunCli.mockResolvedValueOnce({
      exitCode: 1,
      stdout: "",
      stderr: `bootstrap failed for password ${RUNTIME_LOGIN_PASSWORD_VALUE}`,
    });

    const result = await run(CONTEXT);

    const serialized = JSON.stringify(result.report);
    expect(serialized).not.toContain(RUNTIME_LOGIN_PASSWORD_VALUE);
    expect(serialized).not.toContain("bootstrap failed for password");
    expect(serialized).not.toContain("stderr");
  });

  it("reports failure and never runs the runtime-login bootstrap again after seed fails, having already bootstrapped", async () => {
    mockedRunCli.mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
    mockedRunCli.mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
    mockedRunCli.mockResolvedValueOnce({
      exitCode: 1,
      stdout: "",
      stderr: "seed error",
    });

    const result = await run(CONTEXT);

    expect(mockedRunCli).toHaveBeenCalledTimes(3);
    expect(result.passed).toBe(false);
    expect(result.report).toEqual({
      operation: "migrate-init",
      success: false,
      step: "init",
      environmentName: "prod-eastus",
      releaseSha: "a".repeat(40),
      exitCode: 1,
    });
  });
});
