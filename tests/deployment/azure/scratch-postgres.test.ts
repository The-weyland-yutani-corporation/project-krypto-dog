jest.mock("../../../scripts/azure/lib/run-cli", () => ({
  runCli: jest.fn(),
}));

const mkdtempMock = jest.fn();
const rmMock = jest.fn();
jest.mock("node:fs/promises", () => ({
  mkdtemp: (...args: unknown[]) => mkdtempMock(...args),
  rm: (...args: unknown[]) => rmMock(...args),
}));

import { createServer } from "node:net";

import { runCli } from "../../../scripts/azure/lib/run-cli";
import { startScratchPostgres } from "../../../scripts/azure/lib/scratch-postgres";

const mockedRunCli = jest.mocked(runCli);

describe("scripts/azure/lib/scratch-postgres", () => {
  beforeEach(() => {
    mockedRunCli.mockReset();
    mkdtempMock.mockReset();
    rmMock.mockReset();
    mkdtempMock.mockResolvedValue("/tmp/krypto-ops-scratch-pg-abc123");
    rmMock.mockResolvedValue(undefined);
  });

  it("rejects a non-17 initdb version before creating any scratch state", async () => {
    mockedRunCli.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "initdb (PostgreSQL) 16.4",
      stderr: "",
    });

    await expect(startScratchPostgres()).rejects.toThrow(/must be version 17/);
    expect(mkdtempMock).not.toHaveBeenCalled();
  });

  it("rejects if initdb --version itself fails", async () => {
    mockedRunCli.mockResolvedValueOnce({
      exitCode: 1,
      stdout: "",
      stderr: "not found",
    });

    await expect(startScratchPostgres()).rejects.toThrow(
      /Could not determine initdb version/,
    );
    expect(mkdtempMock).not.toHaveBeenCalled();
  });

  it("initializes and starts a loopback-bound PostgreSQL 17, then stops and removes it", async () => {
    mockedRunCli
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "initdb (PostgreSQL) 17.2",
        stderr: "",
      }) // verifyPostgres17
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" }) // initdb -D
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" }); // pg_ctl start

    const handle = await startScratchPostgres();

    expect(handle.url).toMatch(
      /^postgresql:\/\/postgres@127\.0\.0\.1:\d+\/postgres$/,
    );
    expect(handle.dataDirectory).toBe(
      "/tmp/krypto-ops-scratch-pg-abc123",
    );

    const initdbCall = mockedRunCli.mock.calls[1];
    expect(initdbCall[0]).toBe("initdb");
    expect(initdbCall[1]).toEqual(
      expect.arrayContaining(["-D", "/tmp/krypto-ops-scratch-pg-abc123"]),
    );

    const startCall = mockedRunCli.mock.calls[2];
    expect(startCall[0]).toBe("pg_ctl");
    expect(startCall[1]).toEqual(expect.arrayContaining(["start"]));
    const hostFlagArg = (startCall[1] as string[]).find((arg) =>
      arg.includes("-h 127.0.0.1"),
    );
    expect(hostFlagArg).toBeDefined();

    mockedRunCli.mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" }); // pg_ctl stop
    await handle.stop();

    const stopCall = mockedRunCli.mock.calls[3];
    expect(stopCall[0]).toBe("pg_ctl");
    expect(stopCall[1]).toEqual(expect.arrayContaining(["stop"]));
    expect(rmMock).toHaveBeenCalledWith(
      "/tmp/krypto-ops-scratch-pg-abc123",
      { recursive: true, force: true },
    );

    // stop() is idempotent -- a second call must not re-invoke pg_ctl/rm.
    const callsBeforeSecondStop = mockedRunCli.mock.calls.length;
    const rmCallsBeforeSecondStop = rmMock.mock.calls.length;
    await handle.stop();
    expect(mockedRunCli.mock.calls.length).toBe(callsBeforeSecondStop);
    expect(rmMock.mock.calls.length).toBe(rmCallsBeforeSecondStop);
  });

  it("cleans up the scratch data directory if initdb -D fails partway", async () => {
    mockedRunCli
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "initdb (PostgreSQL) 17.0",
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: "",
        stderr: "disk full",
      });

    await expect(startScratchPostgres()).rejects.toThrow(/initdb failed/);
    expect(rmMock).toHaveBeenCalledWith(
      "/tmp/krypto-ops-scratch-pg-abc123",
      { recursive: true, force: true },
    );
  });

  it("stops the partially-started server and cleans up if pg_ctl start fails", async () => {
    mockedRunCli
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "initdb (PostgreSQL) 17.0",
        stderr: "",
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" }) // initdb -D
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: "",
        stderr: "could not bind",
      }); // pg_ctl start fails

    await expect(startScratchPostgres()).rejects.toThrow(
      /pg_ctl start failed/,
    );
    expect(rmMock).toHaveBeenCalledWith(
      "/tmp/krypto-ops-scratch-pg-abc123",
      { recursive: true, force: true },
    );
  });

  it("still removes the data directory when pg_ctl stop fails, and does not swallow the failure", async () => {
    mockedRunCli
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "initdb (PostgreSQL) 17.2",
        stderr: "",
      }) // verifyPostgres17
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" }) // initdb -D
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" }); // pg_ctl start

    const handle = await startScratchPostgres();

    mockedRunCli.mockResolvedValueOnce({
      exitCode: 1,
      stdout: "",
      stderr: "no server running",
    }); // pg_ctl stop fails

    await expect(handle.stop()).rejects.toThrow(/pg_ctl stop failed/);

    // Cleanup must still happen even though the shutdown itself failed --
    // a failed stop is surfaced, never silently treated as clean.
    expect(rmMock).toHaveBeenCalledWith(
      "/tmp/krypto-ops-scratch-pg-abc123",
      { recursive: true, force: true },
    );
  });

  it("still removes the data directory when pg_ctl stop rejects outright (not just a non-zero exit)", async () => {
    mockedRunCli
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "initdb (PostgreSQL) 17.2",
        stderr: "",
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });

    const handle = await startScratchPostgres();

    mockedRunCli.mockRejectedValueOnce(new Error("ENOENT: pg_ctl not found"));

    await expect(handle.stop()).rejects.toThrow(/pg_ctl not found/);
    expect(rmMock).toHaveBeenCalledWith(
      "/tmp/krypto-ops-scratch-pg-abc123",
      { recursive: true, force: true },
    );
  });
});

// Sanity-check that a real loopback port is even allocatable in this test
// environment (guards against the helper's `findLoopbackPort` assumptions).
describe("loopback port allocation sanity check", () => {
  it("can bind an ephemeral port on 127.0.0.1", (done) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      expect(address).not.toBeNull();
      server.close(() => done());
    });
  });
});
