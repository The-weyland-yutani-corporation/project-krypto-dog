import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "./run-cli";

export type ScratchPostgresHandle = {
  url: string;
  dataDirectory: string;
  stop: () => Promise<void>;
};

async function findLoopbackPort(): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        rejectPromise(new Error("Could not allocate a loopback port."));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) rejectPromise(error);
        else resolvePromise(port);
      });
    });
  });
}

async function verifyPostgres17(): Promise<void> {
  const result = await runCli("initdb", ["--version"], process.env);
  if (result.exitCode !== 0) {
    throw new Error(
      `Could not determine initdb version: ${result.stderr.trim()}`,
    );
  }
  if (!/\(PostgreSQL\)\s+17(\.\d+)?\b/.test(result.stdout)) {
    throw new Error(
      `Scratch restore-verification PostgreSQL must be version 17, found: ${result.stdout.trim()}`,
    );
  }
}

/**
 * Stops the scratch server and removes its data directory. Cleanup of the
 * data directory always happens (`finally`), even if `pg_ctl stop` itself
 * fails -- but a failed stop is never silently swallowed: it is surfaced
 * by throwing, so a caller can never mistake a failed shutdown for a
 * clean one.
 */
async function stopScratchPostgres(dataDirectory: string): Promise<void> {
  try {
    const stopResult = await runCli(
      "pg_ctl",
      ["-D", dataDirectory, "-m", "fast", "-w", "stop"],
      process.env,
    );
    if (stopResult.exitCode !== 0) {
      throw new Error(`pg_ctl stop failed: ${stopResult.stderr.trim()}`);
    }
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
}

/**
 * Initializes and starts a throwaway PostgreSQL 17 server bound only to
 * loopback (127.0.0.1), for restore verification. The caller must call
 * `stop()` exactly once when done; `stop()` always removes the scratch
 * data directory (even if the underlying `pg_ctl stop` fails) and always
 * surfaces a failed shutdown by throwing rather than swallowing it.
 */
export async function startScratchPostgres(): Promise<ScratchPostgresHandle> {
  await verifyPostgres17();
  const dataDirectory = await mkdtemp(
    join(tmpdir(), "krypto-ops-scratch-pg-"),
  );
  let port: number;
  try {
    port = await findLoopbackPort();
    const initResult = await runCli(
      "initdb",
      ["-D", dataDirectory, "--auth=trust", "--username=postgres"],
      process.env,
    );
    if (initResult.exitCode !== 0) {
      throw new Error(`initdb failed: ${initResult.stderr.trim()}`);
    }
    const logFile = join(dataDirectory, "postgres.log");
    const startResult = await runCli(
      "pg_ctl",
      [
        "-D",
        dataDirectory,
        "-l",
        logFile,
        "-o",
        `-F -p ${port} -h 127.0.0.1 -c unix_socket_directories=`,
        "-w",
        "start",
      ],
      process.env,
    );
    if (startResult.exitCode !== 0) {
      throw new Error(`pg_ctl start failed: ${startResult.stderr.trim()}`);
    }
  } catch (error) {
    // Nothing was successfully started at this point -- just remove the
    // temporary data directory created above.
    await rm(dataDirectory, { recursive: true, force: true });
    throw error;
  }

  const url = `postgresql://postgres@127.0.0.1:${port}/postgres`;
  let stopped = false;
  return {
    url,
    dataDirectory,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await stopScratchPostgres(dataDirectory);
    },
  };
}
