import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import postgres from "postgres";

import { redactPostgresUrl } from "@/deployment/preflight";
import {
  isLoopbackPostgresHostname,
  isLoopbackPostgresUrl,
} from "@/lib/postgres-url";

const APPLICATION_TABLES = [
  "AgentState",
  "AgentRun",
  "TradeExecution",
  "AgentJournal",
] as const;
const PRIVATE_SCHEMAS = ["krypto", "drizzle"] as const;
const FORBIDDEN_CONNECTION_PARAMETERS = new Set([
  "dbname",
  "database",
  "host",
  "hostaddr",
  "passfile",
  "password",
  "port",
  "service",
  "servicefile",
  "sslpassword",
  "user",
]);

type CommandResult = {
  stdout: string;
  stderr: string;
};

type SourceInventory = {
  database: string;
  systemIdentifier: string;
  serverVersion: string;
  serverMajor: number;
  privateSchemas: string[];
  applicationTables: string[];
  publicTables: string[];
  legacyTradeDirectionLabels: string[] | null;
  rowCounts: Record<string, number>;
  activeKryptoCronJobs: number;
  pendingKryptoHttpRequests: number;
};

export type BackupArchiveManifest = {
  file: string;
  scope: string;
  bytes: number;
  sha256: string;
  listingEntryCount: number;
};

export type BackupBootstrapManifest = {
  file: string;
  scope: string;
  bytes: number;
  sha256: string;
};

export type RestoreVerification = {
  target: string;
  database: string;
  sourceRowCounts: Record<string, number>;
  restoredRowCounts: Record<string, number>;
  matched: boolean;
};

export type BackupManifest = {
  schemaVersion: "1.4.0";
  createdAt: string;
  source: {
    runtimeTarget: string;
    directTarget: string;
    database: string;
    systemIdentifier: string;
    serverVersion: string;
    activeKryptoCronJobs: number;
    pendingKryptoHttpRequests: number;
  };
  tools: {
    pgDump: string;
    pgRestore: string;
  };
  scope: {
    privateSchemas: string[];
    applicationTables: string[];
    publicTables: string[];
    publicTypes: string[];
    exclusions: string[];
  };
  bootstrapFiles: BackupBootstrapManifest[];
  archives: BackupArchiveManifest[];
  sourceRowCounts: Record<string, number>;
  restoreVerification: RestoreVerification | null;
  verified: boolean;
};

export type CreateVerifiedBackupOptions = {
  databaseUrl: string;
  runtimeDatabaseUrl: string;
  outputDirectory: string;
  restoreTestUrl?: string;
  commands?: Partial<PostgresCommands>;
};

type PostgresCommands = {
  pgDump: string;
  pgRestore: string;
  psql: string;
  createDb: string;
  dropDb: string;
};

type PostgresCommandContext = {
  passwordlessUrl: string;
  env: NodeJS.ProcessEnv;
};

const DEFAULT_COMMANDS: PostgresCommands = {
  pgDump: "pg_dump",
  pgRestore: "pg_restore",
  psql: "psql",
  createDb: "createdb",
  dropDb: "dropdb",
};

function commandError(
  command: string,
  code: number | null,
  stderr: string,
): Error {
  const detail = stderr.trim().split("\n").slice(-3).join(" ");
  return new Error(
    `${command} failed${code === null ? "" : ` with exit code ${code}`}${
      detail ? `: ${detail}` : ""
    }`,
  );
}

async function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
      } else {
        rejectPromise(commandError(command, code, stderr));
      }
    });
  });
}

function pgPassEscape(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll(":", "\\:");
}

export function scrubPostgresEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (key.startsWith("PG")) {
      delete env[key];
    }
  }
  return env;
}

function parsePostgresUrl(value: string): URL {
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("Expected a PostgreSQL connection URL.");
  }
  if (!url.hostname || !url.pathname.slice(1) || !url.username) {
    throw new Error(
      "PostgreSQL URL must include a hostname, database, and username.",
    );
  }
  for (const key of url.searchParams.keys()) {
    if (FORBIDDEN_CONNECTION_PARAMETERS.has(key.toLowerCase())) {
      throw new Error(
        `PostgreSQL URL query parameter "${key}" is not allowed.`,
      );
    }
  }
  return url;
}

export function isLoopbackHostname(hostname: string): boolean {
  return isLoopbackPostgresHostname(hostname);
}

export function passwordlessPostgresUrl(value: string): string {
  const url = parsePostgresUrl(value);
  url.password = "";
  url.hash = "";
  return url.toString();
}

async function commandContext(
  value: string,
  passwordFile: string,
): Promise<PostgresCommandContext> {
  const url = parsePostgresUrl(value);
  const database = decodeURIComponent(url.pathname.slice(1));
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const port = url.port || "5432";
  const passLine = [
    url.hostname,
    port,
    database,
    username,
    password,
  ]
    .map(pgPassEscape)
    .join(":");
  await writeFile(passwordFile, `${passLine}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(passwordFile, 0o600);
  const env = scrubPostgresEnvironment(process.env);
  return {
    passwordlessUrl: passwordlessPostgresUrl(value),
    env: {
      ...env,
      PGPASSFILE: passwordFile,
    },
  };
}

async function withReadOnlyTransaction<T>(
  databaseUrl: string,
  operation: (sql: postgres.Sql) => Promise<T>,
): Promise<T> {
  const sql = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
  });
  try {
    await sql`BEGIN READ ONLY`;
    await sql`SET LOCAL statement_timeout = '15s'`;
    return await operation(sql);
  } finally {
    try {
      await sql`ROLLBACK`;
    } finally {
      await sql.end({ timeout: 5 });
    }
  }
}

async function readSourceInventory(
  sql: postgres.Sql,
): Promise<SourceInventory> {
  const [metadata] = await sql<
    Array<{
      database: string;
      systemIdentifier: string;
      serverVersion: string;
      serverVersionNum: string;
    }>
  >`
    SELECT
      current_database() AS database,
      system_identifier::text AS "systemIdentifier",
      current_setting('server_version') AS "serverVersion",
      current_setting('server_version_num') AS "serverVersionNum"
    FROM pg_control_system()
  `;
  if (!metadata) {
    throw new Error("Could not read database metadata.");
  }

  const schemaRows = await sql<Array<{ schema: string }>>`
    SELECT schema_name AS schema
    FROM information_schema.schemata
    WHERE schema_name = ANY(${PRIVATE_SCHEMAS as readonly string[]})
    ORDER BY schema_name
  `;
  const tableRows = await sql<Array<{ schema: string; table: string }>>`
    SELECT table_schema AS schema, table_name AS table
    FROM information_schema.tables
    WHERE table_type = 'BASE TABLE'
      AND (
        (
          table_schema IN ('public', 'krypto')
          AND table_name = ANY(${APPLICATION_TABLES as readonly string[]})
        )
        OR (
          table_schema = 'drizzle'
          AND table_name = '__drizzle_migrations'
        )
      )
    ORDER BY table_schema, table_name
  `;
  const legacyEnumRows = await sql<Array<{ label: string }>>`
    SELECT enum_value.enumlabel AS label
    FROM pg_type AS type
    JOIN pg_namespace AS namespace
      ON namespace.oid = type.typnamespace
    JOIN pg_enum AS enum_value
      ON enum_value.enumtypid = type.oid
    WHERE namespace.nspname = 'public'
      AND type.typname = 'TradeDirection'
    ORDER BY enum_value.enumsortorder
  `;
  const publicTables = tableRows
    .filter((row) => row.schema === "public")
    .map((row) => row.table);
  const applicationTables = tableRows
    .filter(
      (row) =>
        (row.schema === "public" || row.schema === "krypto") &&
        APPLICATION_TABLES.includes(
          row.table as (typeof APPLICATION_TABLES)[number],
        ),
    )
    .map((row) => `${row.schema}.${row.table}`);
  if (
    publicTables.includes("TradeExecution") &&
    legacyEnumRows.length === 0
  ) {
    throw new Error(
      "Legacy public TradeExecution exists without public.TradeDirection.",
    );
  }

  const rowCounts: Record<string, number> = {};
  for (const table of tableRows) {
    const [count] = await sql.unsafe<Array<{ count: string }>>(
      `SELECT COUNT(*)::text AS count FROM ${qualifiedSqlIdentifier(
        table.schema,
        table.table,
      )}`,
    );
    rowCounts[`${table.schema}.${table.table}`] = Number(count?.count ?? 0);
  }

  const [cronAvailability] = await sql<Array<{ available: boolean }>>`
    SELECT to_regclass('cron.job') IS NOT NULL AS available
  `;
  let activeKryptoCronJobs = 0;
  if (cronAvailability?.available) {
    const [cronCount] = await sql<Array<{ count: string }>>`
      SELECT COUNT(*)::text AS count
      FROM cron.job
      WHERE active
        AND (
          COALESCE(jobname, '') ILIKE 'krypto%'
          OR COALESCE(command, '') ILIKE '%krypto%'
          OR COALESCE(command, '') ~* '/api/agent/(run|daily-summary)'
          OR COALESCE(command, '') ~* 'invoke_(agent_run|daily_summary)'
          OR COALESCE(command, '') ILIKE '%krypto_invoke_endpoint%'
        )
    `;
    activeKryptoCronJobs = Number(cronCount?.count ?? 0);
  }
  const [httpQueueAvailability] = await sql<
    Array<{ available: boolean }>
  >`
    SELECT to_regclass(
      'net.http_request_queue'
    ) IS NOT NULL AS available
  `;
  let pendingKryptoHttpRequests = 0;
  if (httpQueueAvailability?.available) {
    const [pendingCount] = await sql<Array<{ count: string }>>`
      SELECT COUNT(*)::text AS count
      FROM net.http_request_queue
      WHERE url ~* '/api/agent/(run|daily-summary)'
    `;
    pendingKryptoHttpRequests = Number(pendingCount?.count ?? 0);
  }

  return {
    database: metadata.database,
    systemIdentifier: metadata.systemIdentifier,
    serverVersion: metadata.serverVersion,
    serverMajor: Math.floor(Number(metadata.serverVersionNum) / 10000),
    privateSchemas: schemaRows.map((row) => row.schema),
    applicationTables,
    publicTables,
    legacyTradeDirectionLabels:
      publicTables.includes("TradeExecution")
        ? legacyEnumRows.map((row) => row.label)
        : null,
    rowCounts,
    activeKryptoCronJobs,
    pendingKryptoHttpRequests,
  };
}

async function sourceInventory(
  databaseUrl: string,
): Promise<SourceInventory> {
  return withReadOnlyTransaction(databaseUrl, async (sql) => {
    return readSourceInventory(sql);
  });
}

async function databaseIdentity(
  databaseUrl: string,
): Promise<Pick<SourceInventory, "database" | "systemIdentifier">> {
  return withReadOnlyTransaction(databaseUrl, async (sql) => {
    const [identity] = await sql<
      Array<{ database: string; systemIdentifier: string }>
    >`
      SELECT
        current_database() AS database,
        system_identifier::text AS "systemIdentifier"
      FROM pg_control_system()
    `;
    if (!identity) {
      throw new Error("Could not read PostgreSQL target identity.");
    }
    return identity;
  });
}

async function withExportedSnapshot<T>(
  databaseUrl: string,
  operation: (
    source: SourceInventory,
    snapshot: string,
  ) => Promise<T>,
): Promise<T> {
  const sql = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
  });
  try {
    await sql`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`;
    await sql`SET LOCAL statement_timeout = '15s'`;
    const [snapshotRow] = await sql<Array<{ snapshot: string }>>`
      SELECT pg_export_snapshot() AS snapshot
    `;
    if (!snapshotRow) {
      throw new Error("Could not export a consistent backup snapshot.");
    }
    const source = await readSourceInventory(sql);
    return await operation(source, snapshotRow.snapshot);
  } finally {
    try {
      await sql`ROLLBACK`;
    } finally {
      await sql.end({ timeout: 5 });
    }
  }
}

function toolMajor(versionOutput: string): number {
  const match = versionOutput.match(/(\d+)(?:\.\d+)?/);
  if (!match) {
    throw new Error(`Could not parse PostgreSQL tool version: ${versionOutput}`);
  }
  return Number(match[1]);
}

function quotedPatternIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function qualifiedSqlIdentifier(schema: string, table: string): string {
  return `${quotedPatternIdentifier(schema)}.${quotedPatternIdentifier(table)}`;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  const input = createReadStream(path);
  await new Promise<void>((resolvePromise, rejectPromise) => {
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", rejectPromise);
    input.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function createLegacyTypeBootstrap(
  file: string,
  labels: string[],
): Promise<BackupBootstrapManifest> {
  const sql = [
    "CREATE TYPE public.\"TradeDirection\" AS ENUM (",
    `  ${labels.map(sqlStringLiteral).join(", ")}`,
    ");",
    "",
  ].join("\n");
  await writeFile(file, sql, { encoding: "utf8", mode: 0o600 });
  const fileStat = await stat(file);
  return {
    file: basename(file),
    scope: "legacy public TradeDirection enum",
    bytes: fileStat.size,
    sha256: await sha256File(file),
  };
}

function archiveEntries(listing: string): number {
  return listing
    .split("\n")
    .filter((line) => line.trim() && !line.trimStart().startsWith(";")).length;
}

async function createArchive(
  scope: string,
  file: string,
  dumpArgs: string[],
  snapshot: string,
  context: PostgresCommandContext,
  commands: PostgresCommands,
): Promise<BackupArchiveManifest> {
  await runCommand(
    commands.pgDump,
    [
      `--dbname=${context.passwordlessUrl}`,
      "--format=custom",
      "--no-owner",
      "--lock-wait-timeout=10s",
      `--snapshot=${snapshot}`,
      `--file=${file}`,
      ...dumpArgs,
    ],
    context.env,
  );
  const listing = await runCommand(
    commands.pgRestore,
    ["--list", file],
    context.env,
  );
  const fileStat = await stat(file);
  return {
    file: basename(file),
    scope,
    bytes: fileStat.size,
    sha256: await sha256File(file),
    listingEntryCount: archiveEntries(listing.stdout),
  };
}

function databaseUrl(value: string, database: string): string {
  const url = parsePostgresUrl(value);
  url.pathname = `/${encodeURIComponent(database)}`;
  return url.toString();
}

async function verifyRestore(
  restoreTestUrl: string,
  source: SourceInventory,
  bootstrapFiles: BackupBootstrapManifest[],
  archives: BackupArchiveManifest[],
  bundleDirectory: string,
  commands: PostgresCommands,
  passwordFile: string,
): Promise<RestoreVerification> {
  const restoreUrl = parsePostgresUrl(restoreTestUrl);
  if (!isLoopbackPostgresUrl(restoreUrl.toString())) {
    throw new Error(
      "Restore verification is restricted to a loopback PostgreSQL server.",
    );
  }
  const restoreServer = await sourceInventory(restoreTestUrl);
  if (restoreServer.serverMajor < source.serverMajor) {
    throw new Error(
      `Restore server PostgreSQL ${restoreServer.serverMajor} is older than source PostgreSQL ${source.serverMajor}.`,
    );
  }

  const context = await commandContext(restoreTestUrl, passwordFile);
  const temporaryDatabase = `krypto_restore_${Date.now()}_${randomBytes(4).toString("hex")}`;
  await runCommand(
    commands.createDb,
    [
      `--maintenance-db=${context.passwordlessUrl}`,
      "--template=template0",
      temporaryDatabase,
    ],
    context.env,
  );

  try {
    const targetUrl = databaseUrl(restoreTestUrl, temporaryDatabase);
    const targetContext = await commandContext(
      targetUrl,
      `${passwordFile}.target`,
    );
    for (const bootstrapFile of bootstrapFiles) {
      await runCommand(
        commands.psql,
        [
          `--dbname=${targetContext.passwordlessUrl}`,
          "--no-psqlrc",
          "--set=ON_ERROR_STOP=1",
          `--file=${join(bundleDirectory, bootstrapFile.file)}`,
        ],
        targetContext.env,
      );
    }
    for (const archive of archives) {
      await runCommand(
        commands.pgRestore,
        [
          `--dbname=${targetContext.passwordlessUrl}`,
          "--no-owner",
          "--no-privileges",
          "--exit-on-error",
          join(bundleDirectory, archive.file),
        ],
        targetContext.env,
      );
    }
    const restored = await sourceInventory(targetUrl);
    const matched =
      JSON.stringify(source.rowCounts) ===
      JSON.stringify(restored.rowCounts);
    if (!matched) {
      throw new Error("Restored critical row counts do not match the source.");
    }
    return {
      target: redactPostgresUrl(restoreTestUrl) ?? "[invalid-url]",
      database: temporaryDatabase,
      sourceRowCounts: source.rowCounts,
      restoredRowCounts: restored.rowCounts,
      matched,
    };
  } finally {
    await runCommand(
      commands.dropDb,
      [
        `--maintenance-db=${context.passwordlessUrl}`,
        "--if-exists",
        "--force",
        temporaryDatabase,
      ],
      context.env,
    );
  }
}

export async function createVerifiedBackup(
  options: CreateVerifiedBackupOptions,
): Promise<BackupManifest> {
  parsePostgresUrl(options.databaseUrl);
  parsePostgresUrl(options.runtimeDatabaseUrl);
  const outputDirectory = resolve(options.outputDirectory);
  const parentDirectory = dirname(outputDirectory);
  const temporaryDirectory = join(
    parentDirectory,
    `.${basename(outputDirectory)}-${randomBytes(6).toString("hex")}.tmp`,
  );
  const commands = { ...DEFAULT_COMMANDS, ...options.commands };
  const secretDirectory = await mkdtemp(join(tmpdir(), "krypto-backup-"));
  const sourcePasswordFile = join(secretDirectory, "source.pgpass");
  const restorePasswordFile = join(secretDirectory, "restore.pgpass");

  try {
    await stat(outputDirectory).then(
      () => {
        throw new Error(`Backup output already exists: ${outputDirectory}`);
      },
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      },
    );
    await mkdir(parentDirectory, { recursive: true });
    await mkdir(temporaryDirectory);

    const [dumpVersion, restoreVersion] = await Promise.all([
      runCommand(commands.pgDump, ["--version"], process.env),
      runCommand(commands.pgRestore, ["--version"], process.env),
    ]);
    const runtimeIdentity = await databaseIdentity(
      options.runtimeDatabaseUrl,
    );
    const sourceContext = await commandContext(
      options.databaseUrl,
      sourcePasswordFile,
    );
    const { source, bootstrapFiles, archives } = await withExportedSnapshot(
      options.databaseUrl,
      async (snapshotSource, snapshot) => {
        if (
          runtimeIdentity.database !== snapshotSource.database ||
          runtimeIdentity.systemIdentifier !==
            snapshotSource.systemIdentifier
        ) {
          throw new Error(
            "DATABASE_URL and DIRECT_URL do not target the same PostgreSQL database and cluster.",
          );
        }
        if (toolMajor(dumpVersion.stdout) < snapshotSource.serverMajor) {
          throw new Error(
            `pg_dump ${toolMajor(dumpVersion.stdout)} is older than source PostgreSQL ${snapshotSource.serverMajor}.`,
          );
        }
        if (snapshotSource.activeKryptoCronJobs > 0) {
          throw new Error(
            "Active Krypto cron jobs must be disabled before backup.",
          );
        }
        if (snapshotSource.pendingKryptoHttpRequests > 0) {
          throw new Error(
            "Pending Krypto HTTP requests must drain before backup.",
          );
        }
        if (snapshotSource.applicationTables.length === 0) {
          throw new Error(
            "No Krypto application tables were found to back up.",
          );
        }

        const snapshotBootstrapFiles: BackupBootstrapManifest[] = [];
        if (snapshotSource.legacyTradeDirectionLabels) {
          snapshotBootstrapFiles.push(
            await createLegacyTypeBootstrap(
              join(temporaryDirectory, "legacy-public-types.sql"),
              snapshotSource.legacyTradeDirectionLabels,
            ),
          );
        }
        const snapshotArchives: BackupArchiveManifest[] = [];
        if (snapshotSource.privateSchemas.length > 0) {
          const privateFile = join(
            temporaryDirectory,
            "private-schemas.dump",
          );
          snapshotArchives.push(
            await createArchive(
              "private application and migration schemas",
              privateFile,
              snapshotSource.privateSchemas.map(
                (schema) => `--schema=${schema}`,
              ),
              snapshot,
              sourceContext,
              commands,
            ),
          );
        }
        if (snapshotSource.publicTables.length > 0) {
          const publicFile = join(
            temporaryDirectory,
            "legacy-public-tables.dump",
          );
          snapshotArchives.push(
            await createArchive(
              "legacy public application tables",
              publicFile,
              snapshotSource.publicTables.map(
                (table) =>
                  `--table=${quotedPatternIdentifier("public")}.${
                    quotedPatternIdentifier(table)
                  }`,
              ),
              snapshot,
              sourceContext,
              commands,
            ),
          );
        }
        return {
          source: snapshotSource,
          bootstrapFiles: snapshotBootstrapFiles,
          archives: snapshotArchives,
        };
      },
    );

    const restoreVerification = options.restoreTestUrl
      ? await verifyRestore(
          options.restoreTestUrl,
          source,
          bootstrapFiles,
          archives,
          temporaryDirectory,
          commands,
          restorePasswordFile,
        )
      : null;
    const manifest: BackupManifest = {
      schemaVersion: "1.4.0",
      createdAt: new Date().toISOString(),
      source: {
        runtimeTarget:
          redactPostgresUrl(options.runtimeDatabaseUrl) ??
          "[invalid-url]",
        directTarget:
          redactPostgresUrl(options.databaseUrl) ?? "[invalid-url]",
        database: source.database,
        systemIdentifier: source.systemIdentifier,
        serverVersion: source.serverVersion,
        activeKryptoCronJobs: source.activeKryptoCronJobs,
        pendingKryptoHttpRequests:
          source.pendingKryptoHttpRequests,
      },
      tools: {
        pgDump: dumpVersion.stdout.trim(),
        pgRestore: restoreVersion.stdout.trim(),
      },
      scope: {
        privateSchemas: source.privateSchemas,
        applicationTables: source.applicationTables,
        publicTables: source.publicTables,
        publicTypes: source.legacyTradeDirectionLabels
          ? ["public.TradeDirection"]
          : [],
        exclusions: [
          "Provider-managed service schemas and extension state",
          "External secret values and secret-store contents",
          "Database roles and server-level configuration",
        ],
      },
      bootstrapFiles,
      archives,
      sourceRowCounts: source.rowCounts,
      restoreVerification,
      verified:
        archives.length > 0 &&
        archives.every(
          (archive) =>
            archive.bytes > 0 &&
            archive.sha256.length === 64 &&
            archive.listingEntryCount > 0,
        ) &&
        bootstrapFiles.every(
          (file) => file.bytes > 0 && file.sha256.length === 64,
        ) &&
        (restoreVerification === null || restoreVerification.matched),
    };
    if (!manifest.verified) {
      throw new Error("Backup verification did not complete successfully.");
    }

    await writeFile(
      join(temporaryDirectory, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    await rename(temporaryDirectory, outputDirectory);
    return manifest;
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(secretDirectory, { recursive: true, force: true });
  }
}
