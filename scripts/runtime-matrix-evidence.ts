import { spawnSync } from "node:child_process";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const EXPECTED_POSTGRESQL_MAJOR = 17;

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const NPM_VERSION_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export type RuntimeMatrixCommandOutputs = {
  nodeVersion: string;
  npmVersion: string;
  postgresServerVersion: string;
  psqlVersion: string;
  pgDumpVersion: string;
};

export type RuntimeMatrixEvidence = {
  schemaVersion: 1;
  commitSha: string;
  expectations: {
    nodeExact: string;
    postgresqlMajor: number;
  };
  commands: {
    "node --version": string;
    "npm --version": string;
    "SHOW server_version": string;
    "psql --version": string;
    "pg_dump --version": string;
  };
};

type RuntimeMatrixArguments = {
  out: string;
  commitSha: string;
};

function oneLine(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) {
    throw new Error(`${label} must return exactly one non-empty line.`);
  }
  return trimmed;
}

function postgresMajor(value: string, label: string): number {
  const match = value.match(
    /^([1-9]\d*)\.\d+(?:\.\d+)?(?: \([^)]+\))?$/,
  );
  if (!match) {
    throw new Error(`${label} returned an unrecognized PostgreSQL version.`);
  }
  return Number.parseInt(match[1], 10);
}

function postgresClientVersion(
  value: string,
  command: "psql" | "pg_dump",
): string {
  const match = value.match(
    new RegExp(
      `^${command} \\(PostgreSQL\\) ([1-9]\\d*(?:\\.\\d+)+)(?: \\([^)]+\\))?$`,
    ),
  );
  if (!match) {
    throw new Error(
      `${command} --version returned an unrecognized PostgreSQL version.`,
    );
  }
  return match[1];
}

export function createRuntimeMatrixEvidence(input: {
  commitSha: string;
  expectedNodeVersion: string;
  outputs: RuntimeMatrixCommandOutputs;
}): RuntimeMatrixEvidence {
  if (!COMMIT_SHA_PATTERN.test(input.commitSha)) {
    throw new Error(
      "Commit SHA must be exactly 40 lowercase hexadecimal characters.",
    );
  }
  if (!EXACT_VERSION_PATTERN.test(input.expectedNodeVersion)) {
    throw new Error(".nvmrc must contain one exact x.y.z Node.js version.");
  }

  const nodeVersion = oneLine(input.outputs.nodeVersion, "node --version");
  const expectedNodeOutput = `v${input.expectedNodeVersion}`;
  if (nodeVersion !== expectedNodeOutput) {
    throw new Error(
      `node --version must be ${expectedNodeOutput}; received ${nodeVersion}.`,
    );
  }

  const npmVersion = oneLine(input.outputs.npmVersion, "npm --version");
  if (!NPM_VERSION_PATTERN.test(npmVersion)) {
    throw new Error("npm --version must return one exact semantic version.");
  }

  const postgresServerVersion = oneLine(
    input.outputs.postgresServerVersion,
    "SHOW server_version",
  );
  const serverMajor = postgresMajor(
    postgresServerVersion,
    "SHOW server_version",
  );
  if (serverMajor !== EXPECTED_POSTGRESQL_MAJOR) {
    throw new Error(
      `PostgreSQL server major must be ${EXPECTED_POSTGRESQL_MAJOR}; received ${serverMajor}.`,
    );
  }

  const psqlVersion = oneLine(input.outputs.psqlVersion, "psql --version");
  const pgDumpVersion = oneLine(
    input.outputs.pgDumpVersion,
    "pg_dump --version",
  );
  const psqlClientVersion = postgresClientVersion(psqlVersion, "psql");
  const pgDumpClientVersion = postgresClientVersion(pgDumpVersion, "pg_dump");
  const psqlMajor = postgresMajor(psqlClientVersion, "psql --version");
  const pgDumpMajor = postgresMajor(pgDumpClientVersion, "pg_dump --version");
  if (psqlMajor !== EXPECTED_POSTGRESQL_MAJOR) {
    throw new Error(
      `psql major must be ${EXPECTED_POSTGRESQL_MAJOR}; received ${psqlMajor}.`,
    );
  }
  if (pgDumpMajor !== EXPECTED_POSTGRESQL_MAJOR) {
    throw new Error(
      `pg_dump major must be ${EXPECTED_POSTGRESQL_MAJOR}; received ${pgDumpMajor}.`,
    );
  }
  if (psqlClientVersion !== pgDumpClientVersion) {
    throw new Error(
      `psql and pg_dump must come from the same PostgreSQL client release; received ${psqlClientVersion} and ${pgDumpClientVersion}.`,
    );
  }

  return {
    schemaVersion: 1,
    commitSha: input.commitSha,
    expectations: {
      nodeExact: input.expectedNodeVersion,
      postgresqlMajor: EXPECTED_POSTGRESQL_MAJOR,
    },
    commands: {
      "node --version": nodeVersion,
      "npm --version": npmVersion,
      "SHOW server_version": postgresServerVersion,
      "psql --version": psqlVersion,
      "pg_dump --version": pgDumpVersion,
    },
  };
}

export function serializeRuntimeMatrixEvidence(
  evidence: RuntimeMatrixEvidence,
): string {
  return `${JSON.stringify(evidence, null, 2)}\n`;
}

export function parseRuntimeMatrixArguments(
  argv: string[],
): RuntimeMatrixArguments {
  let out: string | undefined;
  let commitSha: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument !== "--out" && argument !== "--commit") {
      throw new Error(`Unknown runtime matrix argument: ${argument}`);
    }
    if (!value || value.startsWith("--")) {
      throw new Error(`${argument} requires a value.`);
    }
    if (argument === "--out") {
      if (out) throw new Error("--out may be supplied only once.");
      out = value;
    } else {
      if (commitSha) throw new Error("--commit may be supplied only once.");
      commitSha = value;
    }
    index += 1;
  }

  if (!out) throw new Error("--out is required.");
  if (!commitSha) throw new Error("--commit is required.");
  return { out, commitSha };
}

function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): string {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env,
  });
  if (result.error) {
    throw new Error(`${command} could not be executed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} exited with status ${result.status ?? "unknown"}.`,
    );
  }
  return result.stdout;
}

function postgresCommandEnvironment(connectionString: string): NodeJS.ProcessEnv {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("TEST_POSTGRES_ADMIN_URL must be a valid PostgreSQL URL.");
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error("TEST_POSTGRES_ADMIN_URL must use postgresql://.");
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!url.hostname || !url.username || !database || database.includes("/")) {
    throw new Error(
      "TEST_POSTGRES_ADMIN_URL must include one host, user, and database.",
    );
  }

  return {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: database,
    PGCONNECT_TIMEOUT: "5",
    PGSSLMODE: url.searchParams.get("sslmode") || "prefer",
  };
}

export async function writeRuntimeMatrixEvidence(
  outputPath: string,
  evidence: RuntimeMatrixEvidence,
): Promise<void> {
  const resolvedPath = resolve(outputPath);
  await mkdir(dirname(resolvedPath), { recursive: true });

  let output;
  try {
    output = await open(resolvedPath, "wx");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      throw new Error(
        `Refusing to overwrite runtime matrix evidence: ${resolvedPath}`,
      );
    }
    throw error;
  }

  try {
    await output.writeFile(serializeRuntimeMatrixEvidence(evidence), "utf8");
  } finally {
    await output.close();
  }
}

async function main(): Promise<void> {
  const args = parseRuntimeMatrixArguments(process.argv.slice(2));
  const expectedNodeVersion = (await readFile(resolve(".nvmrc"), "utf8")).trim();
  const postgresUrl = process.env.TEST_POSTGRES_ADMIN_URL;
  if (!postgresUrl) {
    throw new Error("TEST_POSTGRES_ADMIN_URL is required.");
  }
  const postgresEnv = postgresCommandEnvironment(postgresUrl);
  const evidence = createRuntimeMatrixEvidence({
    commitSha: args.commitSha,
    expectedNodeVersion,
    outputs: {
      nodeVersion: runCommand("node", ["--version"]),
      npmVersion: runCommand("npm", ["--version"]),
      postgresServerVersion: runCommand(
        "psql",
        [
          "--no-psqlrc",
          "--set=ON_ERROR_STOP=1",
          "--tuples-only",
          "--no-align",
          "--command=SHOW server_version;",
        ],
        postgresEnv,
      ),
      psqlVersion: runCommand("psql", ["--version"]),
      pgDumpVersion: runCommand("pg_dump", ["--version"]),
    },
  });

  await writeRuntimeMatrixEvidence(args.out, evidence);
  process.stdout.write(serializeRuntimeMatrixEvidence(evidence));
}

const invokedScript = process.argv[1] ?? "";
if (/(^|[/\\])runtime-matrix-evidence\.[cm]?[jt]s$/.test(invokedScript)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
