jest.mock("../../../../scripts/azure/lib/run-cli", () => ({
  runCli: jest.fn(),
}));
jest.mock("../../../../scripts/azure/lib/scratch-postgres", () => ({
  startScratchPostgres: jest.fn(),
}));

import { runCli } from "../../../../scripts/azure/lib/run-cli";
import { startScratchPostgres } from "../../../../scripts/azure/lib/scratch-postgres";
import { run } from "../../../../scripts/azure/operations/verified-backup";
import type { AzureOperationContext } from "../../../../scripts/azure/operations/types";

const mockedRunCli = jest.mocked(runCli);
const mockedStartScratchPostgres = jest.mocked(startScratchPostgres);

const CONTEXT: AzureOperationContext = {
  environmentName: "prod-eastus",
  releaseSha: "c".repeat(40),
  jobExecutionId: "job-1",
  reportDirectory: "/tmp/ops-reports/prod-eastus/ccc/verified-backup/job-1",
};

describe("scripts/azure/operations/verified-backup", () => {
  const originalDirectUrl = process.env.DIRECT_URL;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const stopMock = jest.fn(async () => undefined);

  beforeEach(() => {
    mockedRunCli.mockReset();
    mockedStartScratchPostgres.mockReset();
    stopMock.mockClear();
    process.env.DIRECT_URL = "postgresql://user:pass@db.example.com/krypto";
    process.env.DATABASE_URL = "postgresql://user:pass@db.example.com/krypto";
    mockedStartScratchPostgres.mockResolvedValue({
      url: "postgresql://postgres@127.0.0.1:55432/postgres",
      dataDirectory: "/tmp/krypto-ops-scratch-pg-xyz",
      stop: stopMock,
    });
  });

  afterAll(() => {
    process.env.DIRECT_URL = originalDirectUrl;
    process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("requires DIRECT_URL and DATABASE_URL before starting scratch postgres", async () => {
    delete process.env.DIRECT_URL;
    await expect(run(CONTEXT)).rejects.toThrow(
      /DIRECT_URL and DATABASE_URL are required/,
    );
    expect(mockedStartScratchPostgres).not.toHaveBeenCalled();
  });

  it("runs deployment:backup with --restore-test-url pointed at the scratch server", async () => {
    mockedRunCli.mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({ restoreVerification: { matched: true } }),
      stderr: "",
    });

    await run(CONTEXT);

    expect(mockedRunCli).toHaveBeenCalledWith(
      "npx",
      [
        "tsx",
        "scripts/create-verified-backup.ts",
        "--out",
        "/tmp/ops-reports/prod-eastus/ccc/verified-backup/job-1/backup",
        "--restore-test-url",
        "postgresql://postgres@127.0.0.1:55432/postgres",
      ],
      process.env,
    );
  });

  it("passes and stops the scratch server when restoreVerification.matched is true", async () => {
    mockedRunCli.mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({ restoreVerification: { matched: true } }),
      stderr: "",
    });

    const result = await run(CONTEXT);

    expect(result.passed).toBe(true);
    expect(stopMock).toHaveBeenCalledTimes(1);
  });

  it("throws and still stops the scratch server when restoreVerification.matched is false", async () => {
    mockedRunCli.mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({ restoreVerification: { matched: false } }),
      stderr: "",
    });

    await expect(run(CONTEXT)).rejects.toThrow(/did not report matched=true/);
    expect(stopMock).toHaveBeenCalledTimes(1);
  });

  it("throws and still stops the scratch server when restoreVerification is missing entirely", async () => {
    mockedRunCli.mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({ ok: true }),
      stderr: "",
    });

    await expect(run(CONTEXT)).rejects.toThrow(/did not report matched=true/);
    expect(stopMock).toHaveBeenCalledTimes(1);
  });

  it("throws and still stops the scratch server when the backup command exits non-zero", async () => {
    mockedRunCli.mockResolvedValueOnce({
      exitCode: 1,
      stdout: "",
      stderr: "line1\nline2\ndisk full",
    });

    await expect(run(CONTEXT)).rejects.toThrow(/deployment:backup failed/);
    expect(stopMock).toHaveBeenCalledTimes(1);
  });

  it("throws and still stops the scratch server when stdout is not parseable JSON", async () => {
    mockedRunCli.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "not json",
      stderr: "",
    });

    await expect(run(CONTEXT)).rejects.toThrow(
      /did not return parseable JSON/,
    );
    expect(stopMock).toHaveBeenCalledTimes(1);
  });
});
