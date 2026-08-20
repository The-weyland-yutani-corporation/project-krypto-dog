jest.mock("../../../../scripts/azure/lib/run-cli", () => ({
  runCli: jest.fn(),
}));

import { runCli } from "../../../../scripts/azure/lib/run-cli";
import { run } from "../../../../scripts/azure/operations/preflight";
import type { AzureOperationContext } from "../../../../scripts/azure/operations/types";

const mockedRunCli = jest.mocked(runCli);

const CONTEXT: AzureOperationContext = {
  environmentName: "prod-eastus",
  releaseSha: "b".repeat(40),
  jobExecutionId: "job-1",
  reportDirectory: "/tmp/ops-reports/prod-eastus/bbb/preflight/job-1",
};

describe("scripts/azure/operations/preflight", () => {
  beforeEach(() => {
    mockedRunCli.mockReset();
  });

  it("invokes the inherently Azure-only deployment preflight", async () => {
    mockedRunCli.mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({ passed: true }),
      stderr: "",
    });

    await run(CONTEXT);

    expect(mockedRunCli).toHaveBeenCalledWith(
      "npx",
      ["tsx", "scripts/deployment-preflight.ts"],
      process.env,
    );
  });

  it("reports passed=true when preflight exits 0", async () => {
    mockedRunCli.mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({ passed: true, checks: [] }),
      stderr: "",
    });

    const result = await run(CONTEXT);

    expect(result.passed).toBe(true);
    expect(result.report).toMatchObject({
      operation: "preflight",
      provider: "azure",
      environmentName: "prod-eastus",
      releaseSha: "b".repeat(40),
      preflight: { passed: true, checks: [] },
    });
  });

  it("reports passed=false (but does not throw) when preflight exits 2 (blocked)", async () => {
    mockedRunCli.mockResolvedValueOnce({
      exitCode: 2,
      stdout: JSON.stringify({ passed: false, blockers: ["x"] }),
      stderr: "",
    });

    const result = await run(CONTEXT);

    expect(result.passed).toBe(false);
    expect(result.report).toMatchObject({
      preflight: { passed: false, blockers: ["x"] },
    });
  });

  it("throws for any other exit code", async () => {
    mockedRunCli.mockResolvedValueOnce({
      exitCode: 1,
      stdout: JSON.stringify({ passed: false }),
      stderr: "crash",
    });

    await expect(run(CONTEXT)).rejects.toThrow(/exit code 1/);
  });

  it("throws if preflight does not return parseable JSON", async () => {
    mockedRunCli.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "not json",
      stderr: "",
    });

    await expect(run(CONTEXT)).rejects.toThrow(/did not return parseable JSON/);
  });
});
