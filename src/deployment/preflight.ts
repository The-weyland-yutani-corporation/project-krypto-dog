import { createHash } from "node:crypto";
import postgres from "postgres";

export const DEPLOYMENT_PREFLIGHT_SCHEMA_VERSION = "1.3.0";

export type PreflightStatus = "pass" | "warn" | "block";

export interface PreflightCheck {
  id: string;
  status: PreflightStatus;
  summary: string;
  evidence?: Record<string, unknown>;
}

export interface AgentStateInventory {
  schema: "public" | "krypto";
  present: boolean;
  ethBalance: string | null;
  usdcBalance: string | null;
  portfolioValueUSD: string | null;
  accountingStatus: string | null;
  isLocked: boolean | null;
  isOperatorPaused: boolean | null;
  isRunning: boolean | null;
  leaseOwned: boolean;
  leaseExpiresAt: string | null;
}

export interface DeploymentInventory {
  database: string | null;
  runtimeDatabase: string | null;
  serverVersion: string | null;
  directSystemIdentifier: string | null;
  runtimeSystemIdentifier: string | null;
  applicationTables: Array<{ schema: string; table: string }>;
  protectedSchemas: string[];
  protectedRelations: Array<{
    schema: "krypto" | "vault";
    name: string;
    kind: string;
  }>;
  protectedPublicViews: string[];
  rowCounts: Record<string, number>;
  agentState: AgentStateInventory | null;
  openPaperPosition: boolean | null;
  drizzleMigrationCount: number | null;
  supabaseMigrationCount: number | null;
  kryptoCronJobs: Array<{
    jobName: string;
    schedule: string;
    active: boolean;
  }>;
  pendingKryptoHttpRequests: number;
  fixedFunctions: {
    agentRun: boolean;
    dailySummary: boolean;
    integrityVerified: boolean;
  };
  legacyArbitraryFunction: boolean;
  restrictedRolePrivileges: Array<{
    role: string;
    schemaUsage: boolean;
    schemaCreate: boolean;
    exposedTables: string[];
    executableFunctions: string[];
    vaultObjects: string[];
    vaultAccess: boolean;
  }>;
  vaultSecretNames: string[];
}

export interface DeploymentPreflightReport {
  schemaVersion: string;
  generatedAt: string;
  target: {
    directUrl: string | null;
    runtimeUrl: string | null;
  };
  checks: PreflightCheck[];
  inventory: DeploymentInventory;
  blockers: string[];
  databasePreflightPassed: boolean;
  manualGatesRemaining: string[];
}

export interface DeploymentPreflightInput {
  directUrl?: string;
  runtimeUrl?: string;
  now?: Date;
}

const APPLICATION_TABLES = [
  "AgentState",
  "AgentRun",
  "TradeExecution",
  "AgentJournal",
] as const;
const LEGACY_APPLICATION_TABLES = [
  "AgentState",
  "TradeExecution",
  "AgentJournal",
] as const;
const EXPECTED_DRIZZLE_MIGRATIONS = [
  {
    createdAt: "1775960372035",
    hash: "9bf808b1f005fdd04f1111fdabe1de1f3e3ae65061df0c9404e7efe99c4d7f06",
  },
  {
    createdAt: "1777757136027",
    hash: "39d5bb9e4c7075ddea434c999f7dad05e4efff133184687336d9d0e9ba1842fe",
  },
  {
    createdAt: "1784051729303",
    hash: "9c68d9fc7c5ce804fa7efbaf57486c592a8afda965fc754ffdfab6bdd9b05aa3",
  },
  {
    createdAt: "1784054175971",
    hash: "bbf6f943d3e87a387e699e4b567ad5012bb8ee7c268c6a8c624f71dee41dcad3",
  },
  {
    createdAt: "1784074873207",
    hash: "702ff727c1fd0099e6b97bfcfc26575b86492ef0beb8d77a358922eda8d619be",
  },
  {
    createdAt: "1784123377223",
    hash: "6c2224452bafb07b0bd7ecaa3fcc6a45690abef61944b487571e900f11d7c43a",
  },
  {
    createdAt: "1784174542964",
    hash: "a614858a8a9e85ae5ece4b9f3046e865e3ed46d780581c1a2843ff8a5ccfde3d",
  },
] as const;
const EXPECTED_FUNCTION_HASHES = {
  invoke_agent_run:
    "6b4d47233622db9cbdc453735f8287f665fe9b4552fa1e68bc1dfbf31891a69b",
  invoke_daily_summary:
    "67630778c4a679858d4a94e69ceb61dbf258eab34a4b3ff9ada90517c9a205d8",
} as const;
const NULLABLE_MODE_BOUND_FUNCTION_HASHES: Record<
  keyof typeof EXPECTED_FUNCTION_HASHES,
  string
> = {
  invoke_agent_run:
    "285886232696f74e79de21b9b3b305d4016d01902bdeefc583db76598e47a80d",
  invoke_daily_summary:
    "e2cdbc1608903e7147734c9b51a79130c2a41fc47575c8979300a0f7640e78a5",
};
const LEGACY_FUNCTION_HASHES: Record<
  keyof typeof EXPECTED_FUNCTION_HASHES,
  string
> = {
  invoke_agent_run:
    "d50bca04b44a2cb0a93b3639884cc6547f3e58263cf2ab631b5e93e4ba974704",
  invoke_daily_summary:
    "7767cb8a5599b6e3173742658999ef33e0cab565b2a75347aa766caa66f26f6f",
};

function errorCode(error: unknown): string {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return error instanceof Error ? error.name : "unknown";
}

function scalar(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  return null;
}

function boolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function nonZeroDecimal(value: string | null): boolean | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed !== 0 : null;
}

function functionHash(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

export function redactPostgresUrl(value?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    url.username = "[redacted]";
    url.password = "[redacted]";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[invalid-url]";
  }
}

export function summarizeAgentState(
  schema: "public" | "krypto",
  state: Record<string, unknown> | null,
): AgentStateInventory {
  if (!state) {
    return {
      schema,
      present: false,
      ethBalance: null,
      usdcBalance: null,
      portfolioValueUSD: null,
      accountingStatus: null,
      isLocked: null,
      isOperatorPaused: null,
      isRunning: null,
      leaseOwned: false,
      leaseExpiresAt: null,
    };
  }

  return {
    schema,
    present: true,
    ethBalance: scalar(
      state.currentPositionETHDecimal ?? state.currentPositionETH,
    ),
    usdcBalance: scalar(
      state.currentPositionUSDCDecimal ?? state.currentPositionUSDC,
    ),
    portfolioValueUSD: scalar(
      state.portfolioValueUSDDecimal ?? state.portfolioValueUSD,
    ),
    accountingStatus: scalar(state.accountingStatus),
    isLocked: boolean(state.isLocked),
    isOperatorPaused: boolean(state.isOperatorPaused),
    isRunning: boolean(state.isRunning),
    leaseOwned:
      typeof state.leaseOwner === "string" && state.leaseOwner.length > 0,
    leaseExpiresAt:
      state.leaseExpiresAt instanceof Date
        ? state.leaseExpiresAt.toISOString()
        : scalar(state.leaseExpiresAt),
  };
}

export function hasBlockingChecks(checks: PreflightCheck[]): boolean {
  return checks.some((check) => check.status === "block");
}

function baseInventory(): DeploymentInventory {
  return {
    database: null,
    runtimeDatabase: null,
    serverVersion: null,
    directSystemIdentifier: null,
    runtimeSystemIdentifier: null,
    applicationTables: [],
    protectedSchemas: [],
    protectedRelations: [],
    protectedPublicViews: [],
    rowCounts: {},
    agentState: null,
    openPaperPosition: null,
    drizzleMigrationCount: null,
    supabaseMigrationCount: null,
    kryptoCronJobs: [],
    pendingKryptoHttpRequests: 0,
    fixedFunctions: {
      agentRun: false,
      dailySummary: false,
      integrityVerified: false,
    },
    legacyArbitraryFunction: false,
    restrictedRolePrivileges: [],
    vaultSecretNames: [],
  };
}

async function withReadOnlyTransaction<T>(
  client: ReturnType<typeof postgres>,
  operation: () => Promise<T>,
): Promise<T> {
  await client`BEGIN READ ONLY`;
  try {
    await client`SET LOCAL statement_timeout = '10s'`;
    return await operation();
  } finally {
    await client`ROLLBACK`;
  }
}

export async function runDeploymentPreflight(
  input: DeploymentPreflightInput,
): Promise<DeploymentPreflightReport> {
  const now = input.now ?? new Date();
  const checks: PreflightCheck[] = [];
  const inventory = baseInventory();
  const directUrl = input.directUrl?.trim();
  const runtimeUrl = input.runtimeUrl?.trim();

  if (!directUrl) {
    checks.push({
      id: "direct-url",
      status: "block",
      summary: "DIRECT_URL is missing; remote inventory cannot run.",
    });
  }
  if (!runtimeUrl) {
    checks.push({
      id: "runtime-url",
      status: "block",
      summary: "DATABASE_URL is missing; runtime connectivity cannot be proven.",
    });
  }

  if (runtimeUrl) {
    const runtime = postgres(runtimeUrl, {
      max: 1,
      prepare: false,
      connect_timeout: 10,
      idle_timeout: 2,
    });
    try {
      await withReadOnlyTransaction(runtime, async () => {
        const [identity] = await runtime<
          Array<{ database: string; systemIdentifier: string }>
        >`
          SELECT
            current_database() AS database,
            system_identifier::text AS "systemIdentifier"
          FROM pg_control_system()
        `;
        inventory.runtimeDatabase = identity?.database ?? null;
        inventory.runtimeSystemIdentifier =
          identity?.systemIdentifier ?? null;
      });
      checks.push({
        id: "runtime-connectivity",
        status: "pass",
        summary: "DATABASE_URL accepted a read-only query.",
        evidence: {
          database: inventory.runtimeDatabase,
          systemIdentifier: inventory.runtimeSystemIdentifier,
        },
      });
    } catch (error) {
      checks.push({
        id: "runtime-connectivity",
        status: "block",
        summary: "DATABASE_URL could not execute a read-only query.",
        evidence: { errorCode: errorCode(error) },
      });
    } finally {
      await runtime.end();
    }
  }

  if (directUrl) {
    const direct = postgres(directUrl, {
      max: 1,
      prepare: false,
      connect_timeout: 10,
      idle_timeout: 2,
    });
    try {
      await withReadOnlyTransaction(direct, async () => {
        const sql = direct;
        const [server] = await sql<
          Array<{
            database: string;
            serverVersion: string;
            systemIdentifier: string;
          }>
        >`
          SELECT
            current_database() AS database,
            current_setting('server_version') AS "serverVersion",
            system_identifier::text AS "systemIdentifier"
          FROM pg_control_system()
        `;
        inventory.database = server?.database ?? null;
        inventory.serverVersion = server?.serverVersion ?? null;
        inventory.directSystemIdentifier =
          server?.systemIdentifier ?? null;
        checks.push({
          id: "direct-connectivity",
          status: "pass",
          summary: "DIRECT_URL accepted a read-only transaction.",
          evidence: {
            database: inventory.database,
            serverVersion: inventory.serverVersion,
            systemIdentifier: inventory.directSystemIdentifier,
          },
        });
        const databaseTargetMatches =
          inventory.runtimeDatabase !== null &&
          inventory.runtimeSystemIdentifier !== null &&
          inventory.runtimeDatabase === inventory.database &&
          inventory.runtimeSystemIdentifier ===
            inventory.directSystemIdentifier;
        checks.push({
          id: "database-target-match",
          status: databaseTargetMatches ? "pass" : "block",
          summary: databaseTargetMatches
            ? "Runtime and direct connections target the same database cluster."
            : "DATABASE_URL and DIRECT_URL do not prove the same database target.",
          evidence: {
            runtimeDatabase: inventory.runtimeDatabase,
            directDatabase: inventory.database,
            runtimeSystemIdentifier:
              inventory.runtimeSystemIdentifier,
            directSystemIdentifier:
              inventory.directSystemIdentifier,
          },
        });

        const tables = await sql<
          Array<{ schemaName: string; tableName: string }>
        >`
          SELECT
            schemaname AS "schemaName",
            tablename AS "tableName"
          FROM pg_tables
          WHERE schemaname IN ('public', 'krypto')
            AND tablename = ANY(${[...APPLICATION_TABLES]})
          ORDER BY schemaname, tablename
        `;
        inventory.applicationTables = tables.map((table) => ({
          schema: table.schemaName,
          table: table.tableName,
        }));
        const protectedSchemas = await sql<Array<{ schema: string }>>`
          SELECT nspname AS schema
          FROM pg_namespace
          WHERE nspname IN ('krypto', 'vault')
          ORDER BY nspname
        `;
        inventory.protectedSchemas = protectedSchemas.map(
          (schema) => schema.schema,
        );
        const protectedRelations = await sql<
          Array<{
            schema: "krypto" | "vault";
            name: string;
            kind: string;
          }>
        >`
          SELECT
            namespace.nspname AS schema,
            relation.relname AS name,
            relation.relkind::text AS kind
          FROM pg_class AS relation
          JOIN pg_namespace AS namespace
            ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname IN ('krypto', 'vault')
            AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
          ORDER BY namespace.nspname, relation.relname
        `;
        inventory.protectedRelations = protectedRelations;
        const protectedPublicViews = await sql<Array<{ name: string }>>`
          WITH RECURSIVE protected_relation AS (
            SELECT relation.oid
            FROM pg_class AS relation
            JOIN pg_namespace AS namespace
              ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname IN ('krypto', 'vault')
              AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')

            UNION

            SELECT wrapper.oid
            FROM protected_relation AS protected
            JOIN pg_depend AS dependency
              ON dependency.refobjid = protected.oid
             AND dependency.classid = 'pg_rewrite'::regclass
            JOIN pg_rewrite AS rewrite
              ON rewrite.oid = dependency.objid
            JOIN pg_class AS wrapper
              ON wrapper.oid = rewrite.ev_class
            WHERE wrapper.relkind IN ('v', 'm')
          )
          SELECT relation.relname AS name
          FROM protected_relation AS protected
          JOIN pg_class AS relation
            ON relation.oid = protected.oid
          JOIN pg_namespace AS namespace
            ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'public'
          ORDER BY relation.relname
        `;
        inventory.protectedPublicViews = protectedPublicViews.map(
          (view) => view.name,
        );

        const tableKeys = new Set(
          inventory.applicationTables.map(
            (table) => `${table.schema}.${table.table}`,
          ),
        );
        const hasPublicState = tableKeys.has("public.AgentState");
        const hasKryptoState = tableKeys.has("krypto.AgentState");
        const schemasByTable = new Map<string, Set<string>>();
        for (const table of inventory.applicationTables) {
          const schemas =
            schemasByTable.get(table.table) ?? new Set<string>();
          schemas.add(table.schema);
          schemasByTable.set(table.table, schemas);
        }
        const duplicateTables = [...schemasByTable.entries()]
          .filter(([, schemas]) => schemas.size > 1)
          .map(([table]) => table);
        const applicationSchemas = new Set(
          inventory.applicationTables.map((table) => table.schema),
        );
        const publicTables = new Set(
          inventory.applicationTables
            .filter((table) => table.schema === "public")
            .map((table) => table.table),
        );
        const kryptoTables = new Set(
          inventory.applicationTables
            .filter((table) => table.schema === "krypto")
            .map((table) => table.table),
        );
        const kryptoRelations = inventory.protectedRelations.filter(
          (relation) => relation.schema === "krypto",
        );
        const exactLegacyLayout =
          kryptoRelations.length === 0 &&
          publicTables.size === LEGACY_APPLICATION_TABLES.length &&
          LEGACY_APPLICATION_TABLES.every((table) =>
            publicTables.has(table),
          );
        const exactPrivateLayout =
          publicTables.size === 0 &&
          kryptoTables.size === APPLICATION_TABLES.length &&
          kryptoRelations.length === APPLICATION_TABLES.length &&
          APPLICATION_TABLES.every((table) =>
            kryptoTables.has(table),
          ) &&
          kryptoRelations.every(
            (relation) =>
              relation.kind === "r" &&
              APPLICATION_TABLES.includes(
                relation.name as (typeof APPLICATION_TABLES)[number],
              ),
          );
        const emptyLayout =
          inventory.applicationTables.length === 0 &&
          kryptoRelations.length === 0;
        const missingKryptoTables = APPLICATION_TABLES.filter(
          (table) => !tableKeys.has(`krypto.${table}`),
        );
        const missingPublicTables = LEGACY_APPLICATION_TABLES.filter(
          (table) => !tableKeys.has(`public.${table}`),
        );
        checks.push(
          exactPrivateLayout
            ? {
                id: "schema-layout",
                status: "pass",
                summary:
                  "Complete private krypto application schema is present.",
              }
            : exactLegacyLayout
              ? {
                  id: "schema-layout",
                  status: "warn",
                  summary:
                    "Complete legacy public application schema requires the reviewed adoption migration.",
                }
              : emptyLayout
                ? {
                    id: "schema-layout",
                    status: "warn",
                    summary:
                      "No application tables exist; confirm this is an intentionally fresh database.",
                  }
                : {
                    id: "schema-layout",
                    status: "block",
                    summary:
                      "Application tables do not match a complete fresh, legacy, or private layout.",
                    evidence: {
                      schemas: [...applicationSchemas].sort(),
                      duplicateTables: duplicateTables.sort(),
                      missingKryptoTables,
                      missingPublicTables,
                      kryptoRelations,
                    },
                  },
        );

        for (const table of inventory.applicationTables) {
          const [row] = await sql<Array<{ count: string }>>`
            SELECT count(*)::text AS count
            FROM ${sql(table.schema)}.${sql(table.table)}
          `;
          inventory.rowCounts[`${table.schema}.${table.table}`] = Number(
            row?.count ?? 0,
          );
        }

        const stateSchema = hasKryptoState
          ? "krypto"
          : hasPublicState
            ? "public"
            : null;
        if (stateSchema) {
          const [row] = await sql<
            Array<{ state: Record<string, unknown> }>
          >`
            SELECT to_jsonb(state_row) AS state
            FROM ${sql(stateSchema)}.${sql("AgentState")} AS state_row
            WHERE id = 'singleton'
            LIMIT 1
          `;
          inventory.agentState = summarizeAgentState(
            stateSchema,
            row?.state ?? null,
          );
          inventory.openPaperPosition = nonZeroDecimal(
            inventory.agentState.ethBalance,
          );

          if (!inventory.agentState.present) {
            checks.push({
              id: "singleton-state",
              status: "warn",
              summary:
                "AgentState exists but the singleton row is absent; initialization is required after migration.",
            });
          } else {
            checks.push({
              id: "singleton-state",
              status: "pass",
              summary: "AgentState singleton was inventoried.",
              evidence: {
                schema: stateSchema,
                ethBalance: inventory.agentState.ethBalance,
                accountingStatus: inventory.agentState.accountingStatus,
                isLocked: inventory.agentState.isLocked,
                isOperatorPaused: inventory.agentState.isOperatorPaused,
                isRunning: inventory.agentState.isRunning,
                leaseOwned: inventory.agentState.leaseOwned,
              },
            });
          }

          if (inventory.openPaperPosition === true) {
            checks.push({
              id: "open-position",
              status: "block",
              summary:
                "A non-zero paper ETH position exists; record and reconcile it before migration.",
              evidence: {
                ethBalance: inventory.agentState.ethBalance,
              },
            });
          } else if (inventory.openPaperPosition === false) {
            checks.push({
              id: "open-position",
              status: "pass",
              summary: "No open paper ETH position was detected.",
            });
          } else {
            checks.push({
              id: "open-position",
              status: "warn",
              summary: "Paper ETH position could not be determined.",
            });
          }

          if (
            inventory.agentState.isRunning === true ||
            inventory.agentState.leaseOwned
          ) {
            checks.push({
              id: "run-lease",
              status: "block",
              summary:
                "AgentState indicates an active or owned run; do not migrate until it is safely resolved.",
            });
          } else {
            checks.push({
              id: "run-lease",
              status: "pass",
              summary: "No active owned run lease was detected.",
            });
          }

          if (inventory.agentState.accountingStatus === "QUARANTINED") {
            checks.push({
              id: "accounting-state",
              status: "block",
              summary:
                "The account is quarantined and must be reconciled before rollout.",
            });
          } else if (stateSchema === "krypto") {
            checks.push({
              id: "accounting-state",
              status:
                inventory.agentState.accountingStatus === "RECONCILED"
                  ? "pass"
                  : "warn",
              summary:
                inventory.agentState.accountingStatus === "RECONCILED"
                  ? "Accounting state is reconciled."
                  : "Accounting reconciliation is not yet proven.",
              evidence: {
                accountingStatus: inventory.agentState.accountingStatus,
              },
            });
          }
        }

        const [drizzleRelation] = await sql<
          Array<{ relation: string | null }>
        >`SELECT to_regclass('drizzle.__drizzle_migrations')::text AS relation`;
        if (drizzleRelation?.relation) {
          const migrations = await sql<
            Array<{ hash: string; createdAt: string }>
          >`
            SELECT
              hash,
              created_at::text AS "createdAt"
            FROM drizzle.__drizzle_migrations
            ORDER BY created_at, id
          `;
          inventory.drizzleMigrationCount = migrations.length;
          const matchesKnownPrefix =
            migrations.length <= EXPECTED_DRIZZLE_MIGRATIONS.length &&
            migrations.every(
              (migration, index) =>
                migration.hash ===
                  EXPECTED_DRIZZLE_MIGRATIONS[index]?.hash &&
                migration.createdAt ===
                  EXPECTED_DRIZZLE_MIGRATIONS[index]?.createdAt,
            );
          checks.push({
            id: "drizzle-history",
            status: "pass",
            summary: "Drizzle migration history is present.",
            evidence: {
              migrationCount: inventory.drizzleMigrationCount,
            },
          });
          checks.push({
            id: "drizzle-history-integrity",
            status: matchesKnownPrefix ? "pass" : "block",
            summary: matchesKnownPrefix
              ? "Drizzle migration history matches a canonical ordered prefix."
              : "Drizzle migration hashes, timestamps, or order differ from the reviewed history.",
            evidence: {
              migrationCount: inventory.drizzleMigrationCount,
              matchesKnownPrefix,
            },
          });
          const migrationLayoutMatches =
            (exactPrivateLayout &&
              inventory.drizzleMigrationCount >= 4 &&
              inventory.drizzleMigrationCount <=
                EXPECTED_DRIZZLE_MIGRATIONS.length) ||
            (exactLegacyLayout &&
              inventory.drizzleMigrationCount <= 2) ||
            (emptyLayout && inventory.drizzleMigrationCount === 0);
          checks.push({
            id: "migration-schema-consistency",
            status:
              matchesKnownPrefix && migrationLayoutMatches
                ? "pass"
                : "block",
            summary:
              matchesKnownPrefix && migrationLayoutMatches
              ? "Drizzle migration history is consistent with the observed schema layout."
              : "Drizzle migration history contradicts the observed schema layout.",
            evidence: {
              migrationCount: inventory.drizzleMigrationCount,
              exactPrivateLayout,
              exactLegacyLayout,
              emptyLayout,
            },
          });
          const migrationCurrent =
            migrations.length === EXPECTED_DRIZZLE_MIGRATIONS.length;
          checks.push({
            id: "migration-current",
            status:
              matchesKnownPrefix && migrationCurrent ? "pass" : "warn",
            summary:
              matchesKnownPrefix && migrationCurrent
                ? "All reviewed migrations are applied."
                : matchesKnownPrefix
                  ? "The database matches a known pre-current migration prefix."
                  : "Migration currency cannot be established until history integrity is repaired.",
            evidence: {
              applied: migrations.length,
              expected: EXPECTED_DRIZZLE_MIGRATIONS.length,
            },
          });
        } else {
          checks.push({
            id: "drizzle-history",
            status: exactPrivateLayout ? "block" : "warn",
            summary: exactPrivateLayout
              ? "Private application tables exist without Drizzle migration history."
              : "Drizzle migration history is absent; determine whether this is a legacy or fresh database.",
          });
        }

        const [supabaseRelation] = await sql<
          Array<{ relation: string | null }>
        >`
          SELECT to_regclass(
            'supabase_migrations.schema_migrations'
          )::text AS relation
        `;
        if (supabaseRelation?.relation) {
          const [row] = await sql<Array<{ count: string }>>`
            SELECT count(*)::text AS count
            FROM supabase_migrations.schema_migrations
          `;
          inventory.supabaseMigrationCount = Number(row?.count ?? 0);
        }

        const [cronRelation] = await sql<
          Array<{ relation: string | null }>
        >`SELECT to_regclass('cron.job')::text AS relation`;
        if (cronRelation?.relation) {
          const jobs = await sql<
            Array<{ jobName: string; schedule: string; active: boolean }>
          >`
            SELECT
              jobname AS "jobName",
              schedule,
              active
            FROM cron.job
            WHERE jobname IN (
              'krypto-agent-run-hourly',
              'krypto-daily-summary'
            )
               OR COALESCE(jobname, '') ILIKE 'krypto%'
               OR COALESCE(command, '') ILIKE '%krypto%'
               OR COALESCE(command, '') ~* '/api/agent/(run|daily-summary)'
               OR COALESCE(command, '') ~* 'invoke_(agent_run|daily_summary)'
               OR COALESCE(command, '') ILIKE '%krypto_invoke_endpoint%'
            ORDER BY jobname
          `;
          inventory.kryptoCronJobs = jobs;
        }
        const activeCronJobs = inventory.kryptoCronJobs.filter(
          (job) => job.active,
        );
        checks.push({
          id: "cron-state",
          status: activeCronJobs.length > 0 ? "block" : "pass",
          summary:
            activeCronJobs.length > 0
              ? "Krypto cron jobs are active and must be paused before migration."
              : "No active Krypto cron jobs were detected.",
          evidence: {
            jobs: inventory.kryptoCronJobs,
          },
        });

        const [httpQueueRelation] = await sql<
          Array<{ relation: string | null }>
        >`
          SELECT to_regclass(
            'net.http_request_queue'
          )::text AS relation
        `;
        if (httpQueueRelation?.relation) {
          const [pendingRequests] = await sql<
            Array<{ count: string }>
          >`
            SELECT count(*)::text AS count
            FROM net.http_request_queue
            WHERE url ~* '/api/agent/(run|daily-summary)'
          `;
          inventory.pendingKryptoHttpRequests = Number(
            pendingRequests?.count ?? 0,
          );
        }
        checks.push({
          id: "pending-http-requests",
          status:
            inventory.pendingKryptoHttpRequests > 0
              ? "block"
              : "pass",
          summary:
            inventory.pendingKryptoHttpRequests > 0
              ? "Queued Krypto HTTP requests must drain or be removed before deployment."
              : "No queued Krypto HTTP requests were detected.",
          evidence: {
            count: inventory.pendingKryptoHttpRequests,
          },
        });

        const functions = await sql<
          Array<{
            name: keyof typeof EXPECTED_FUNCTION_HASHES;
            securityDefiner: boolean;
            language: string;
            ownerMatches: boolean;
            configuration: string[] | null;
            source: string;
            resultType: string;
          }>
        >`
          SELECT
            p.proname AS name,
            p.prosecdef AS "securityDefiner",
            language.lanname AS language,
            pg_get_userbyid(p.proowner) = current_user AS "ownerMatches",
            p.proconfig AS configuration,
            p.prosrc AS source,
            pg_get_function_result(p.oid) AS "resultType"
          FROM pg_proc AS p
          JOIN pg_namespace AS namespace
            ON namespace.oid = p.pronamespace
          JOIN pg_language AS language
            ON language.oid = p.prolang
          WHERE namespace.nspname = 'krypto'
            AND p.proname IN (
              'invoke_agent_run',
              'invoke_daily_summary'
            )
            AND p.pronargs = 0
          ORDER BY p.proname
        `;
        const functionByName = new Map(
          functions.map((function_) => [function_.name, function_]),
        );
        const agentRunFunction =
          functionByName.get("invoke_agent_run");
        const dailySummaryFunction =
          functionByName.get("invoke_daily_summary");
        const expectedFunctionHashes =
          inventory.drizzleMigrationCount ===
          EXPECTED_DRIZZLE_MIGRATIONS.length
            ? EXPECTED_FUNCTION_HASHES
            : inventory.drizzleMigrationCount ===
                EXPECTED_DRIZZLE_MIGRATIONS.length - 1
              ? NULLABLE_MODE_BOUND_FUNCTION_HASHES
              : LEGACY_FUNCTION_HASHES;
        inventory.fixedFunctions = {
          agentRun: agentRunFunction !== undefined,
          dailySummary: dailySummaryFunction !== undefined,
          integrityVerified: functions.every(
            (function_) =>
              function_.securityDefiner &&
              function_.language === "plpgsql" &&
              function_.ownerMatches &&
              function_.resultType === "bigint" &&
              function_.configuration?.length === 1 &&
              function_.configuration[0] ===
                "search_path=pg_catalog" &&
              functionHash(function_.source) ===
                expectedFunctionHashes[function_.name],
          ) &&
            functions.length === 2,
        };
        const [legacyFunction] = await sql<
          Array<{ present: boolean }>
        >`
          SELECT to_regprocedure(
            'public.krypto_invoke_endpoint(text)'
          ) IS NOT NULL AS present
        `;
        inventory.legacyArbitraryFunction =
          legacyFunction?.present ?? false;
        const installedFunctionCount = functions.length;
        const fixedFunctionsExpected =
          inventory.drizzleMigrationCount !== null &&
          inventory.drizzleMigrationCount >= 3;
        checks.push({
          id: "fixed-cron-functions",
          status:
            inventory.fixedFunctions.agentRun &&
            inventory.fixedFunctions.dailySummary
              ? "pass"
              : fixedFunctionsExpected
                ? "block"
                : "warn",
          summary:
            inventory.fixedFunctions.agentRun &&
            inventory.fixedFunctions.dailySummary
              ? "Fixed parameterless Krypto cron functions are installed."
              : fixedFunctionsExpected
                ? "Applied migration history requires both fixed Krypto cron functions."
                : "Fixed Krypto cron functions are not yet fully installed.",
          evidence: inventory.fixedFunctions,
        });
        checks.push({
          id: "fixed-cron-function-integrity",
          status:
            installedFunctionCount === 0
              ? fixedFunctionsExpected
                ? "block"
                : "warn"
              : inventory.fixedFunctions.integrityVerified
                ? "pass"
                : "block",
          summary:
            installedFunctionCount === 0
              ? fixedFunctionsExpected
                ? "Applied migration history requires canonical fixed cron functions."
                : "Fixed cron function integrity is pending migration."
              : inventory.fixedFunctions.integrityVerified
                ? "Fixed cron functions match the reviewed owner, security, search-path, result, and body definitions."
                : "An installed fixed cron function differs from the reviewed definition.",
          evidence: {
            installedFunctionCount,
            integrityVerified:
              inventory.fixedFunctions.integrityVerified,
            definitionProfile:
              expectedFunctionHashes === EXPECTED_FUNCTION_HASHES
                ? "mode-bound-null-safe"
                : expectedFunctionHashes ===
                    NULLABLE_MODE_BOUND_FUNCTION_HASHES
                  ? "mode-bound-nullable"
                  : "pre-mode-binding",
          },
        });
        checks.push({
          id: "legacy-arbitrary-function",
          status: inventory.legacyArbitraryFunction ? "block" : "pass",
          summary: inventory.legacyArbitraryFunction
            ? "Unsafe legacy arbitrary-path invocation function is still installed."
            : "Unsafe legacy arbitrary-path invocation function is absent.",
        });

        const roles = await sql<Array<{ role: string }>>`
          SELECT rolname AS role
          FROM pg_roles
          WHERE rolname IN ('anon', 'authenticated')
          ORDER BY rolname
        `;
        for (const { role } of roles) {
          const [schemaPrivileges] = await sql<
            Array<{
              kryptoUsage: boolean;
              kryptoCreate: boolean;
              vaultUsage: boolean;
              vaultCreate: boolean;
            }>
          >`
            SELECT
              CASE
                WHEN to_regnamespace('krypto') IS NULL THEN false
                ELSE has_schema_privilege(
                  ${role},
                  'krypto',
                  'USAGE'
                )
              END AS "kryptoUsage",
              CASE
                WHEN to_regnamespace('krypto') IS NULL THEN false
                ELSE has_schema_privilege(
                  ${role},
                  'krypto',
                  'CREATE'
                )
              END AS "kryptoCreate",
              CASE
                WHEN to_regnamespace('vault') IS NULL THEN false
                ELSE has_schema_privilege(
                  ${role},
                  'vault',
                  'USAGE'
                )
              END AS "vaultUsage",
              CASE
                WHEN to_regnamespace('vault') IS NULL THEN false
                ELSE has_schema_privilege(
                  ${role},
                  'vault',
                  'CREATE'
                )
              END AS "vaultCreate"
          `;
          const exposedRelations = await sql<
            Array<{
              schema: "public" | "krypto" | "vault";
              name: string;
            }>
          >`
            SELECT
              namespace.nspname AS schema,
              relation.relname AS name
            FROM pg_class AS relation
            JOIN pg_namespace AS namespace
              ON namespace.oid = relation.relnamespace
            WHERE (
                namespace.nspname IN ('krypto', 'vault')
                OR (
                  namespace.nspname = 'public'
                  AND (
                    relation.relname = ANY(
                      ${[...APPLICATION_TABLES]}
                    )
                    OR relation.relname = ANY(
                      ${inventory.protectedPublicViews}
                    )
                  )
                )
              )
              AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
              AND CASE
                WHEN relation.relkind = 'S' THEN
                  has_sequence_privilege(
                    ${role},
                    relation.oid,
                    'USAGE'
                  )
                  OR has_sequence_privilege(
                    ${role},
                    relation.oid,
                    'SELECT'
                  )
                  OR has_sequence_privilege(
                    ${role},
                    relation.oid,
                    'UPDATE'
                  )
                ELSE
                  has_table_privilege(
                    ${role},
                    relation.oid,
                    'SELECT'
                  )
                  OR has_table_privilege(
                    ${role},
                    relation.oid,
                    'INSERT'
                  )
                  OR has_table_privilege(
                    ${role},
                    relation.oid,
                    'UPDATE'
                  )
                  OR has_table_privilege(
                    ${role},
                    relation.oid,
                    'DELETE'
                  )
                  OR has_table_privilege(
                    ${role},
                    relation.oid,
                    'TRUNCATE'
                  )
                  OR has_table_privilege(
                    ${role},
                    relation.oid,
                    'REFERENCES'
                  )
                  OR has_table_privilege(
                    ${role},
                    relation.oid,
                    'TRIGGER'
                  )
                  OR has_any_column_privilege(
                    ${role},
                    relation.oid,
                    'SELECT'
                  )
                  OR has_any_column_privilege(
                    ${role},
                    relation.oid,
                    'INSERT'
                  )
                  OR has_any_column_privilege(
                    ${role},
                    relation.oid,
                    'UPDATE'
                  )
                  OR has_any_column_privilege(
                    ${role},
                    relation.oid,
                    'REFERENCES'
                  )
              END
            ORDER BY namespace.nspname, relation.relname
          `;
          const executableRoutines = await sql<
            Array<{
              schema: "public" | "krypto" | "vault";
              name: string;
            }>
          >`
            SELECT
              namespace.nspname AS schema,
              namespace.nspname || '.'
              || p.proname
              || '('
              || pg_get_function_identity_arguments(p.oid)
              || ')' AS name
            FROM pg_proc AS p
            JOIN pg_namespace AS namespace
              ON namespace.oid = p.pronamespace
            WHERE (
                namespace.nspname IN ('krypto', 'vault')
                OR (
                  namespace.nspname = 'public'
                  AND (
                    p.proname = 'krypto_invoke_endpoint'
                    OR p.prosecdef
                  )
                )
              )
              AND has_function_privilege(
                ${role},
                p.oid,
                'EXECUTE'
              )
            ORDER BY namespace.nspname, name
          `;
          const exposedTables = exposedRelations
            .filter((relation) => relation.schema !== "vault")
            .map(
              (relation) => `${relation.schema}.${relation.name}`,
            );
          const executableFunctions = executableRoutines
            .filter((routine) => routine.schema !== "vault")
            .map((routine) => routine.name);
          const vaultObjects = [
            ...(schemaPrivileges?.vaultUsage
              ? ["vault schema USAGE"]
              : []),
            ...(schemaPrivileges?.vaultCreate
              ? ["vault schema CREATE"]
              : []),
            ...exposedRelations
              .filter((relation) => relation.schema === "vault")
              .map((relation) => `vault.${relation.name}`),
            ...executableRoutines
              .filter((routine) => routine.schema === "vault")
              .map((routine) => routine.name),
          ];
          inventory.restrictedRolePrivileges.push({
            role,
            schemaUsage: schemaPrivileges?.kryptoUsage ?? false,
            schemaCreate: schemaPrivileges?.kryptoCreate ?? false,
            exposedTables,
            executableFunctions,
            vaultObjects,
            vaultAccess: vaultObjects.length > 0,
          });
        }
        const publicPrivileges = await sql<
          Array<{
            objectType: "schema" | "table" | "function" | "vault";
            objectName: string;
            privilege: string;
          }>
        >`
          WITH public_privileges AS (
            SELECT
              CASE
                WHEN namespace.nspname = 'vault'
                  THEN 'vault'
                ELSE 'schema'
              END AS object_type,
              namespace.nspname AS object_name,
              acl.privilege_type AS privilege
            FROM pg_namespace AS namespace
            CROSS JOIN LATERAL aclexplode(
              COALESCE(
                namespace.nspacl,
                acldefault('n', namespace.nspowner)
              )
            ) AS acl
            WHERE namespace.nspname IN ('krypto', 'vault')
              AND acl.grantee = 0

            UNION ALL

            SELECT
              CASE
                WHEN namespace.nspname = 'vault'
                  THEN 'vault'
                ELSE 'table'
              END AS object_type,
              namespace.nspname || '.' || relation.relname
                AS object_name,
              acl.privilege_type AS privilege
            FROM pg_class AS relation
            JOIN pg_namespace AS namespace
              ON namespace.oid = relation.relnamespace
            CROSS JOIN LATERAL aclexplode(
              COALESCE(
                relation.relacl,
                acldefault(
                  CASE
                    WHEN relation.relkind = 'S' THEN 's'
                    ELSE 'r'
                  END::"char",
                  relation.relowner
                )
              )
            ) AS acl
            WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
              AND (
                namespace.nspname IN ('krypto', 'vault')
                OR (
                  namespace.nspname = 'public'
                  AND (
                    relation.relname = ANY(
                      ${[...APPLICATION_TABLES]}
                    )
                    OR relation.relname = ANY(
                      ${inventory.protectedPublicViews}
                    )
                  )
                )
              )
              AND acl.grantee = 0

            UNION ALL

            SELECT
              CASE
                WHEN namespace.nspname = 'vault'
                  THEN 'vault'
                ELSE 'table'
              END AS object_type,
              namespace.nspname
                || '.'
                || relation.relname
                || '.'
                || attribute.attname AS object_name,
              acl.privilege_type AS privilege
            FROM pg_attribute AS attribute
            JOIN pg_class AS relation
              ON relation.oid = attribute.attrelid
            JOIN pg_namespace AS namespace
              ON namespace.oid = relation.relnamespace
            CROSS JOIN LATERAL aclexplode(attribute.attacl) AS acl
            WHERE attribute.attnum > 0
              AND NOT attribute.attisdropped
              AND attribute.attacl IS NOT NULL
              AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
              AND (
                namespace.nspname IN ('krypto', 'vault')
                OR (
                  namespace.nspname = 'public'
                  AND (
                    relation.relname = ANY(
                      ${[...APPLICATION_TABLES]}
                    )
                    OR relation.relname = ANY(
                      ${inventory.protectedPublicViews}
                    )
                  )
                )
              )
              AND acl.grantee = 0

            UNION ALL

            SELECT
              CASE
                WHEN namespace.nspname = 'vault'
                  THEN 'vault'
                ELSE 'function'
              END AS object_type,
              namespace.nspname
                || '.'
                || function_.proname
                || '('
                || pg_get_function_identity_arguments(function_.oid)
                || ')' AS object_name,
              acl.privilege_type AS privilege
            FROM pg_proc AS function_
            JOIN pg_namespace AS namespace
              ON namespace.oid = function_.pronamespace
            CROSS JOIN LATERAL aclexplode(
              COALESCE(
                function_.proacl,
                acldefault('f', function_.proowner)
              )
            ) AS acl
            WHERE (
                namespace.nspname IN ('krypto', 'vault')
                OR (
                  namespace.nspname = 'public'
                  AND (
                    function_.proname = 'krypto_invoke_endpoint'
                    OR function_.prosecdef
                  )
                )
              )
              AND acl.grantee = 0
          )
          SELECT
            object_type AS "objectType",
            object_name AS "objectName",
            privilege
          FROM public_privileges
          ORDER BY object_type, object_name, privilege
        `;
        if (publicPrivileges.length > 0) {
          inventory.restrictedRolePrivileges.push({
            role: "PUBLIC",
            schemaUsage: publicPrivileges.some(
              (row) =>
                row.objectType === "schema" &&
                row.privilege === "USAGE",
            ),
            schemaCreate: publicPrivileges.some(
              (row) =>
                row.objectType === "schema" &&
                row.privilege === "CREATE",
            ),
            exposedTables: [
              ...new Set(
                publicPrivileges
                  .filter((row) => row.objectType === "table")
                  .map((row) => row.objectName),
              ),
            ],
            executableFunctions: [
              ...new Set(
                publicPrivileges
                  .filter((row) => row.objectType === "function")
                  .map((row) => row.objectName),
              ),
            ],
            vaultObjects: [
              ...new Set(
                publicPrivileges
                  .filter((row) => row.objectType === "vault")
                  .map((row) => row.objectName),
              ),
            ],
            vaultAccess: publicPrivileges.some(
              (row) => row.objectType === "vault",
            ),
          });
        }
        const exposedRole = inventory.restrictedRolePrivileges.find(
          (privileges) =>
            privileges.schemaUsage ||
            privileges.schemaCreate ||
            privileges.exposedTables.length > 0 ||
            privileges.executableFunctions.length > 0 ||
            privileges.vaultObjects.length > 0 ||
            privileges.vaultAccess,
        );
        checks.push({
          id: "restricted-role-privileges",
          status: exposedRole ? "block" : "pass",
          summary: exposedRole
            ? "PUBLIC, anonymous, or authenticated access remains on application, function, schema, or Vault objects."
            : "PUBLIC, anonymous, and authenticated access is absent from application, function, schema, and Vault objects.",
          evidence: {
            roles: inventory.restrictedRolePrivileges,
          },
        });

        const [vaultRelation] = await sql<
          Array<{ relation: string | null }>
        >`SELECT to_regclass('vault.secrets')::text AS relation`;
        if (vaultRelation?.relation) {
          const secrets = await sql<Array<{ name: string }>>`
            SELECT name
            FROM vault.secrets
            WHERE name IN (
              'krypto_cron_secret',
              'krypto_vercel_url',
              'krypto_rollout_mode'
            )
            ORDER BY name
          `;
          inventory.vaultSecretNames = secrets.map((secret) => secret.name);
        }
        checks.push({
          id: "vault-secrets",
          status:
            inventory.vaultSecretNames.length === 3 ? "pass" : "warn",
          summary:
            inventory.vaultSecretNames.length === 3
              ? "Required Krypto Vault secret names are present."
              : "Required Krypto Vault secrets are not yet fully configured.",
          evidence: {
            configuredNames: inventory.vaultSecretNames,
          },
        });
      });
    } catch (error) {
      if (!checks.some((check) => check.id === "direct-connectivity")) {
        checks.push({
          id: "direct-connectivity",
          status: "block",
          summary: "DIRECT_URL could not complete the read-only inventory.",
          evidence: { errorCode: errorCode(error) },
        });
      } else {
        checks.push({
          id: "inventory-completion",
          status: "block",
          summary:
            "Remote inventory stopped before all safety checks completed.",
          evidence: { errorCode: errorCode(error) },
        });
      }
    } finally {
      await direct.end();
    }
  }

  const blockers = checks
    .filter((check) => check.status === "block")
    .map((check) => check.id);

  return {
    schemaVersion: DEPLOYMENT_PREFLIGHT_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    target: {
      directUrl: redactPostgresUrl(directUrl),
      runtimeUrl: redactPostgresUrl(runtimeUrl),
    },
    checks,
    inventory,
    blockers,
    databasePreflightPassed: !hasBlockingChecks(checks),
    manualGatesRemaining: [
      "Create and verify a point-in-time backup.",
      "Record operator approval for the observed state.",
      "Keep rollout mode disabled until target smoke checks pass.",
    ],
  };
}
