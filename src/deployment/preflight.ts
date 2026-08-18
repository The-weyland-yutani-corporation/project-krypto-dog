import { createHash } from "node:crypto";
import postgres from "postgres";
import { classifyMigrationUrlSafety } from "./migration-url-safety";
import {
  readSafetyRoster,
  summarizeSafetyRoster,
} from "@/lib/safety-roster";
import { readSafetyActorPublicKeys } from "@/lib/safety-actor-auth";
import {
  runLedgerAttestation,
} from "@/deployment/ledger-attestation";
import type { LedgerAttestationReport } from "@/trading/ledger-attestation";
import { DEFAULT_STRATEGY_CONFIG } from "@/trading/strategy-config";

export const DEPLOYMENT_PREFLIGHT_SCHEMA_VERSION = "1.7.0";

export type PreflightStatus = "pass" | "warn" | "block";

/**
 * The database provider a preflight run targets. Explicit only: callers
 * (for example Azure deployment workflows) must pass this rather than
 * relying on inference from connection strings, and there is no silent
 * fallback for an unrecognized value — {@link parseDeploymentProvider}
 * throws instead of guessing.
 */
export type DeploymentProvider = "supabase" | "azure";

const KNOWN_DEPLOYMENT_PROVIDERS: readonly DeploymentProvider[] = [
  "supabase",
  "azure",
];

/**
 * Validates an explicit provider value (for example from a CLI flag or
 * environment variable). Returns `undefined` only when no value was given
 * at all; an unrecognized non-empty value always throws so a typo or
 * misconfigured workflow never silently falls back to legacy behavior.
 */
export function parseDeploymentProvider(
  value: string | undefined | null,
): DeploymentProvider | undefined {
  if (value === undefined || value === null || value.trim() === "") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (
    (KNOWN_DEPLOYMENT_PROVIDERS as readonly string[]).includes(normalized)
  ) {
    return normalized as DeploymentProvider;
  }
  throw new Error(
    `Unknown deployment provider: ${value}. Expected one of ${KNOWN_DEPLOYMENT_PROVIDERS.join(", ")}.`,
  );
}

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
  /** current_user on the DIRECT_URL (admin/migration) connection. */
  directCurrentUser: string | null;
  /** current_user on the DATABASE_URL (application runtime) connection. */
  runtimeCurrentUser: string | null;
  /** session_user on the DIRECT_URL (admin/operator) connection. */
  directSessionUser: string | null;
  /** session_user on the DATABASE_URL (application runtime) connection. */
  runtimeSessionUser: string | null;
  /** current_user on the MIGRATION_URL (dedicated migrator) connection. */
  migrationCurrentUser: string | null;
  /** session_user on the MIGRATION_URL (dedicated migrator) connection. */
  migrationSessionUser: string | null;
  applicationTables: Array<{ schema: string; table: string }>;
  protectedSchemas: string[];
  protectedRelations: Array<{
    schema: "krypto" | "vault";
    name: string;
    kind: string;
  }>;
  protectedPublicViews: string[];
  rowCounts: Record<string, number>;
  unresolvedCriticalSafetyIncidentCount: number | null;
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
  runtimeRole: RuntimeRoleInventory | null;
  runtimeLoginRole: RuntimeLoginRoleInventory | null;
  trustBoundary: TrustBoundaryInventory | null;
}

export interface RuntimeRoleInventory {
  name: string;
  present: boolean;
  isGroupRole: boolean;
  schemaUsage: boolean;
  missingTablePrivileges: string[];
  missingSequencePrivileges: string[];
  /**
   * Privileges granted to krypto_runtime that exceed the exact per-table
   * matrix (for example DELETE, TRUNCATE, TRIGGER, REFERENCES, or any
   * privilege on a relation not in the matrix at all). A fail-closed
   * matrix must report these as blocking, not merely note what's missing.
   */
  excessTablePrivileges: string[];
  excessSequencePrivileges: string[];
}

/**
 * Proof that the actual Azure/application login role in current_user on
 * DATABASE_URL — not just the krypto_runtime group role itself — is a
 * member of krypto_runtime and inherits exactly the matrix's privileges
 * (no more, no less). Populated only when the runtime connection captured
 * a current_user.
 */
export interface RuntimeLoginRoleInventory {
  currentUser: string | null;
  isMemberOfRuntimeRole: boolean;
  missingTablePrivileges: string[];
  missingSequencePrivileges: string[];
  excessTablePrivileges: string[];
  excessSequencePrivileges: string[];
}

/**
 * Attributes of one of the three NOLOGIN/LOGIN roles that make up the
 * PostgreSQL trust boundary (GitHub issue #133), as observed via
 * `pg_roles`.
 */
export interface TrustBoundaryRoleAttributes {
  present: boolean;
  canLogin: boolean;
  inherits: boolean;
  connectionLimit: number | null;
}

/**
 * Full observed state of the four-role PostgreSQL trust boundary
 * established by the admin database-role bootstrap
 * (src/deployment/bootstrap-runtime-role.ts) and
 * drizzle/0008_postgresql_trust_boundaries.sql. Every field here is a
 * read-only observation captured over DIRECT_URL; none of these checks
 * ever mutate state.
 */
export interface TrustBoundaryInventory {
  schemaOwnerRole: TrustBoundaryRoleAttributes;
  migratorRole: TrustBoundaryRoleAttributes;
  schedulerRole: TrustBoundaryRoleAttributes;
  runtimeGroupRole: TrustBoundaryRoleAttributes;
  runtimeLoginRole: TrustBoundaryRoleAttributes;
  /** krypto_migrator's membership in krypto_schema_owner has SET but not ADMIN. */
  migratorHasSchemaOwnerSetOption: boolean | null;
  /** krypto_migrator's membership in krypto_schema_owner has INHERIT — must be false. */
  migratorInheritsSchemaOwner: boolean | null;
  /** krypto_runtime must never be a MEMBER of any of the three elevated roles. */
  runtimeIsMemberOfSchemaOwner: boolean | null;
  runtimeIsMemberOfMigrator: boolean | null;
  runtimeIsMemberOfScheduler: boolean | null;
  runtimeLoginHasElevatedMembership: boolean | null;
  operatorHasExplicitElevatedMembership: boolean | null;
  /** Owner of the "krypto" schema itself — must equal krypto_schema_owner. */
  appSchemaOwner: string | null;
  /** Count of objects (tables/views/matviews/sequences) in "krypto" not owned by krypto_schema_owner. */
  appSchemaBadOwnerCount: number | null;
  /** Owner of the "drizzle" migration ledger schema — krypto_schema_owner or krypto_migrator are both acceptable. */
  migrationLedgerOwner: string | null;
  /** krypto_runtime must have no USAGE on the "drizzle" migration ledger schema. */
  runtimeHasMigrationLedgerAccess: boolean | null;
  /** Per legacy schema (vault/cron/net/pg_net), whether krypto_runtime can still reach it (must be false wherever the schema is present). */
  legacySchemaRuntimeAccess: Record<string, boolean>;
  /** Any table/function grant to krypto_runtime found in the "public" schema (expected to always be empty). */
  runtimePublicObjectGrants: string[];
  /** Whether the PUBLIC pseudo-role still holds CREATE on the "public" schema (a PostgreSQL 15+ default-hardened cluster reports false). */
  publicSchemaCreatableByPublic: boolean | null;
  runtimeHasPublicSchemaAccess: boolean | null;
  migratorCanCreateDatabaseObjects: boolean | null;
  migratorCanCreatePublicObjects: boolean | null;
  /** Effective `search_path` observed on each connection, keyed by "direct"/"migration"/"runtime". */
  searchPath: Record<string, string | null>;
}

export interface DeploymentPreflightReport {
  schemaVersion: string;
  generatedAt: string;
  provider: DeploymentProvider | null;
  target: {
    directUrl: string | null;
    runtimeUrl: string | null;
    migrationUrl: string | null;
  };
  checks: PreflightCheck[];
  inventory: DeploymentInventory;
  blockers: string[];
  databasePreflightPassed: boolean;
  ledgerAttestation: LedgerAttestationReport | null;
  manualGatesRemaining: string[];
}

export interface DeploymentPreflightInput {
  directUrl?: string;
  runtimeUrl?: string;
  /**
   * The dedicated migration connection string (see GitHub issue #133).
   * Optional: when omitted, migration-identity and MIGRATION_URL-safety
   * checks are reported as "not proven" (warn, or block on Azure) rather
   * than skipped silently.
   */
  migrationUrl?: string;
  now?: Date;
  /**
   * Explicit deployment provider. Pass `"azure"` from Azure workflows so
   * Azure-specific expectations apply (obsolete Supabase HTTP cron
   * functions must be absent once current; absent Vault secrets are
   * expected rather than a warning). Omit for the legacy/default
   * (Supabase-shaped) behavior — there is no inference from the
   * connection strings themselves.
   */
  provider?: DeploymentProvider;
  /** Injected only for deterministic source tests; real operations use process.env. */
  env?: Record<string, string | undefined>;
}

const APPLICATION_TABLES = [
  "AgentState",
  "AgentRun",
  "TradeExecution",
  "AgentJournal",
  "ProviderDailyUsage",
  "RuntimeContract",
  "SafetyIncidentOutbox",
] as const;
const BOUNDED_APPLICATION_TABLES = [
  "AgentState",
  "AgentRun",
  "TradeExecution",
  "AgentJournal",
  "ProviderDailyUsage",
  "RuntimeContract",
] as const;
const PRE_BOUNDED_APPLICATION_TABLES = [
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
  {
    createdAt: "1786579433481",
    hash: "fdd400ff67a047a8a590be86c462bf1347a7cb36f65045d7625e89c51b5d5e71",
  },
  {
    createdAt: "1786579434481",
    hash: "0f28fce3409b92986be1fe58a82b02a90dcbb48a0cab75a1bbfb6681e200638e",
  },
  {
    createdAt: "1786967376730",
    hash: "289f3a32bdc4c47cd3c9d8c2c354226962fadc4ff5be80e9864574f8eebd42a5",
  },
  {
    createdAt: "1786993492359",
    hash: "e81e8e38bcf2e32855a4d98dd3c76950c26d0e9aeecba536adb0f12278920095",
  },
  {
    createdAt: "1787009045958",
    hash: "7c06289622f560a11de41e48acc37fafbdb1776a76436fffc17e739881fda0e8",
  },
] as const;
/**
 * Migration count at which 0006 (the last migration that still installs
 * the fixed, parameterless Supabase HTTP-invocation cron functions) is
 * current. Below this count the functions may legitimately not exist yet;
 * at or above it (once 0007 applies) they are retired and must be absent.
 */
const NULL_SAFE_CRON_FUNCTIONS_MIGRATION_COUNT = 7;
const MODE_BOUND_NULLABLE_CRON_FUNCTIONS_MIGRATION_COUNT = 6;
/**
 * Migration count at which 0007 (drizzle/0007_azure_retire_supabase_http_functions.sql)
 * is applied and the obsolete Supabase HTTP-invocation cron functions are
 * dropped in favor of Azure Container Apps Jobs calling the application's
 * HTTP routes directly. See specs/decisions/0008-azure-native-deployment-architecture.md.
 */
const CRON_FUNCTIONS_RETIRED_MIGRATION_COUNT = 8;
/**
 * Migration count at which 0008
 * (drizzle/0008_postgresql_trust_boundaries.sql) is applied and the
 * four-role PostgreSQL trust boundary (GitHub issue #133) --
 * krypto_schema_owner, krypto_migrator, krypto_scheduler, krypto_runtime
 * -- is fully established. Below this count the additional roles may
 * legitimately not exist yet.
 */
const TRUST_BOUNDARY_MIGRATION_COUNT = 9;
const RUNTIME_ROLE_NAME = "krypto_runtime";
const SCHEMA_OWNER_ROLE_NAME = "krypto_schema_owner";
const MIGRATOR_ROLE_NAME = "krypto_migrator";
const SCHEDULER_ROLE_NAME = "krypto_scheduler";
const APP_SCHEMA_NAME = "krypto";
const MIGRATION_LEDGER_SCHEMA_NAME = "drizzle";
/**
 * Schemas that predate the Azure migration (Supabase Vault, pg_cron,
 * pg_net) and must never be reachable by krypto_runtime. Existence-guarded
 * everywhere these are checked so a fresh Azure install (where none of
 * these exist at all) never reports a false denial-matrix violation.
 */
const LEGACY_UNRELATED_SCHEMAS = ["vault", "cron", "net", "pg_net"] as const;
/**
 * Exact, fail-closed per-table privilege matrix for krypto_runtime (and,
 * transitively via membership, for the Azure application login role).
 * Anything granted beyond this list — including any privilege on a
 * relation not listed here at all, such as a future table, partitioned
 * table, view, materialized view, or foreign table, or a future sequence —
 * is reported as an excess/blocking privilege rather than silently
 * accepted; future migrations must grant new relations' privileges
 * explicitly rather than relying on a default. Only the named base tables
 * below are ever allowed any privilege at all; every other current
 * or future relation kind the scan inspects (see
 * {@link RUNTIME_SCANNED_TABLE_RELKINDS}) has an implicit empty allow-list,
 * so any grant on it — of any kind — is excess.
 */
const RUNTIME_TABLE_PRIVILEGE_MATRIX: Readonly<Record<string, readonly string[]>> = {
  AgentState: ["SELECT", "UPDATE"],
  AgentRun: ["SELECT", "INSERT", "UPDATE"],
  TradeExecution: ["SELECT", "INSERT"],
  AgentJournal: ["SELECT", "INSERT"],
  ProviderDailyUsage: ["SELECT", "INSERT", "UPDATE"],
  RuntimeContract: ["SELECT"],
  SafetyIncidentOutbox: ["SELECT", "INSERT"],
};
/**
 * Sequences currently have no entries in the matrix because the krypto
 * schema has no sequence-backed columns (all primary keys are
 * application-generated text). If a future migration introduces one, it
 * must appear here with its exact required privileges before the scan
 * below will accept it — until then any granted sequence privilege is
 * reported as excess.
 */
const RUNTIME_SEQUENCE_PRIVILEGE_MATRIX: Readonly<
  Record<string, readonly string[]>
> = {};
const RUNTIME_TABLE_PRIVILEGE_KINDS = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "TRIGGER",
  "REFERENCES",
] as const;
const RUNTIME_SEQUENCE_PRIVILEGE_KINDS = ["USAGE", "SELECT", "UPDATE"] as const;
/**
 * Every non-sequence relation kind the table-privilege scan inspects:
 * ordinary tables (`r`), partitioned tables (`p`), views (`v`), materialized
 * views (`m`), and foreign tables (`f`). All of these support table-style
 * ACLs (`has_table_privilege` never errors on any of them, unlike
 * sequences), and — because none of them except the four named base tables
 * appear in {@link RUNTIME_TABLE_PRIVILEGE_MATRIX} — any krypto_runtime
 * privilege found on any of them is reported as excess. This closes the gap
 * where a future partitioned table, view, materialized view, or foreign
 * table could carry an unreviewed grant invisible to a scan scoped only to
 * `relkind = 'r'`.
 */
const RUNTIME_SCANNED_TABLE_RELKINDS = ["r", "p", "v", "m", "f"] as const;

interface RuntimePrivilegeScanResult {
  missingTablePrivileges: string[];
  missingSequencePrivileges: string[];
  excessTablePrivileges: string[];
  excessSequencePrivileges: string[];
}

/**
 * Scans every relation in the krypto schema and diffs the privileges
 * actually granted to `roleName` (directly or via role membership)
 * against {@link RUNTIME_TABLE_PRIVILEGE_MATRIX} /
 * {@link RUNTIME_SEQUENCE_PRIVILEGE_MATRIX}. Reusable for both the
 * krypto_runtime group role itself and, for requirement #3, the actual
 * Azure application login role's current_user — proving the runtime
 * login inherits exactly the intended privileges, no more and no less.
 *
 * The table-style scan covers every relkind in
 * {@link RUNTIME_SCANNED_TABLE_RELKINDS} (tables, partitioned tables,
 * views, materialized views, and foreign tables), not just ordinary
 * tables, so a privilege quietly granted on a future view or partitioned
 * table cannot slip past as neither missing nor excess.
 */
async function scanRuntimeRolePrivileges(
  sql: postgres.Sql,
  roleName: string,
): Promise<RuntimePrivilegeScanResult> {
  const tableRows = await sql<
    Array<{
      name: string;
      hasSelect: boolean;
      hasInsert: boolean;
      hasUpdate: boolean;
      hasDelete: boolean;
      hasTruncate: boolean;
      hasTrigger: boolean;
      hasReferences: boolean;
    }>
  >`
    -- runtime role table privilege scan
    SELECT
      relation.relname AS name,
      has_table_privilege(${roleName}, relation.oid, 'SELECT') AS "hasSelect",
      has_table_privilege(${roleName}, relation.oid, 'INSERT') AS "hasInsert",
      has_table_privilege(${roleName}, relation.oid, 'UPDATE') AS "hasUpdate",
      has_table_privilege(${roleName}, relation.oid, 'DELETE') AS "hasDelete",
      has_table_privilege(${roleName}, relation.oid, 'TRUNCATE') AS "hasTruncate",
      has_table_privilege(${roleName}, relation.oid, 'TRIGGER') AS "hasTrigger",
      has_table_privilege(${roleName}, relation.oid, 'REFERENCES') AS "hasReferences"
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'krypto'
      AND relation.relkind = ANY(${sql.array([
        ...RUNTIME_SCANNED_TABLE_RELKINDS,
      ])})
    ORDER BY name
  `;
  const sequenceRows = await sql<
    Array<{
      name: string;
      hasUsage: boolean;
      hasSelect: boolean;
      hasUpdate: boolean;
    }>
  >`
    -- runtime role sequence privilege scan
    SELECT
      relation.relname AS name,
      has_sequence_privilege(${roleName}, relation.oid, 'USAGE') AS "hasUsage",
      has_sequence_privilege(${roleName}, relation.oid, 'SELECT') AS "hasSelect",
      has_sequence_privilege(${roleName}, relation.oid, 'UPDATE') AS "hasUpdate"
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'krypto' AND relation.relkind = 'S'
    ORDER BY name
  `;

  const missingTablePrivileges: string[] = [];
  const excessTablePrivileges: string[] = [];
  for (const row of tableRows) {
    const expected = RUNTIME_TABLE_PRIVILEGE_MATRIX[row.name] ?? [];
    const granted: Record<(typeof RUNTIME_TABLE_PRIVILEGE_KINDS)[number], boolean> = {
      SELECT: row.hasSelect,
      INSERT: row.hasInsert,
      UPDATE: row.hasUpdate,
      DELETE: row.hasDelete,
      TRUNCATE: row.hasTruncate,
      TRIGGER: row.hasTrigger,
      REFERENCES: row.hasReferences,
    };
    for (const kind of RUNTIME_TABLE_PRIVILEGE_KINDS) {
      const isExpected = (expected as readonly string[]).includes(kind);
      const isGranted = granted[kind];
      if (isExpected && !isGranted) {
        missingTablePrivileges.push(`${row.name}:${kind}`);
      } else if (!isExpected && isGranted) {
        excessTablePrivileges.push(`${row.name}:${kind}`);
      }
    }
  }

  const missingSequencePrivileges: string[] = [];
  const excessSequencePrivileges: string[] = [];
  for (const row of sequenceRows) {
    const expected = RUNTIME_SEQUENCE_PRIVILEGE_MATRIX[row.name] ?? [];
    const granted: Record<(typeof RUNTIME_SEQUENCE_PRIVILEGE_KINDS)[number], boolean> = {
      USAGE: row.hasUsage,
      SELECT: row.hasSelect,
      UPDATE: row.hasUpdate,
    };
    for (const kind of RUNTIME_SEQUENCE_PRIVILEGE_KINDS) {
      const isExpected = (expected as readonly string[]).includes(kind);
      const isGranted = granted[kind];
      if (isExpected && !isGranted) {
        missingSequencePrivileges.push(`${row.name}:${kind}`);
      } else if (!isExpected && isGranted) {
        excessSequencePrivileges.push(`${row.name}:${kind}`);
      }
    }
  }

  return {
    missingTablePrivileges,
    missingSequencePrivileges,
    excessTablePrivileges,
    excessSequencePrivileges,
  };
}
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
    directCurrentUser: null,
    runtimeCurrentUser: null,
    directSessionUser: null,
    runtimeSessionUser: null,
    migrationCurrentUser: null,
    migrationSessionUser: null,
    applicationTables: [],
    protectedSchemas: [],
    protectedRelations: [],
    protectedPublicViews: [],
    rowCounts: {},
    unresolvedCriticalSafetyIncidentCount: null,
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
    runtimeRole: null,
    runtimeLoginRole: null,
    trustBoundary: null,
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
  const provider = input.provider;
  const checks: PreflightCheck[] = [];
  const inventory = baseInventory();
  const directUrl = input.directUrl?.trim();
  const runtimeUrl = input.runtimeUrl?.trim();
  const migrationUrl = input.migrationUrl?.trim();
  let runtimeSearchPath: string | null = null;
  let migrationSearchPath: string | null = null;
  let ledgerAttestation: LedgerAttestationReport | null = null;

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
          Array<{
            database: string;
            systemIdentifier: string;
            currentUser: string;
            sessionUser: string;
            searchPath: string;
          }>
        >`
          SELECT
            current_database() AS database,
            system_identifier::text AS "systemIdentifier",
            current_user AS "currentUser",
            session_user AS "sessionUser",
            current_setting('search_path') AS "searchPath"
          FROM pg_control_system()
        `;
        inventory.runtimeDatabase = identity?.database ?? null;
        inventory.runtimeSystemIdentifier =
          identity?.systemIdentifier ?? null;
        inventory.runtimeCurrentUser = identity?.currentUser ?? null;
        inventory.runtimeSessionUser = identity?.sessionUser ?? null;
        runtimeSearchPath = identity?.searchPath ?? null;
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

  // Dedicated MIGRATION_URL connectivity, identity, and safety checks (see
  // GitHub issue #133 and drizzle/0008_postgresql_trust_boundaries.sql).
  // Migrations must run as krypto_migrator over a direct connection
  // distinct from both DIRECT_URL (admin/operator) and DATABASE_URL
  // (runtime) -- see src/deployment/migration-url-safety.ts for the exact
  // rules. Fail closed on Azure when MIGRATION_URL is missing, unsafe, or
  // authenticates as an unexpected identity.
  if (migrationUrl) {
    const migration = postgres(migrationUrl, {
      max: 1,
      prepare: false,
      connect_timeout: 10,
      idle_timeout: 2,
    });
    try {
      await withReadOnlyTransaction(migration, async () => {
        const [identity] = await migration<
          Array<{ currentUser: string; sessionUser: string; searchPath: string }>
        >`
          -- migration connection identity
          SELECT
            current_user AS "currentUser",
            session_user AS "sessionUser",
            current_setting('search_path') AS "searchPath"
        `;
        inventory.migrationCurrentUser = identity?.currentUser ?? null;
        inventory.migrationSessionUser = identity?.sessionUser ?? null;
        migrationSearchPath = identity?.searchPath ?? null;
      });
      checks.push({
        id: "migration-connectivity",
        status: "pass",
        summary: "MIGRATION_URL accepted a read-only query.",
        evidence: {
          currentUser: inventory.migrationCurrentUser,
          sessionUser: inventory.migrationSessionUser,
        },
      });
    } catch (error) {
      checks.push({
        id: "migration-connectivity",
        status: "block",
        summary: "MIGRATION_URL could not execute a read-only query.",
        evidence: { errorCode: errorCode(error) },
      });
    } finally {
      await migration.end();
    }
  }
  // When MIGRATION_URL itself is missing, whether that blocks or merely
  // warns depends on whether this environment's applied migration history
  // has reached TRUST_BOUNDARY_MIGRATION_COUNT yet (MIGRATION_URL only
  // became a hard requirement as of migration 0008) -- so these three
  // "missing" checks are deferred and pushed after the DIRECT_URL
  // inventory below has populated inventory.drizzleMigrationCount. A
  // MIGRATION_URL that *is* provided but fails to connect, fails safety
  // validation, or authenticates as the wrong identity is a live problem
  // and always blocks immediately, regardless of migration history.
  if (migrationUrl) {
    const migrationUrlSafety = classifyMigrationUrlSafety({
      migrationUrl,
      directUrl,
      runtimeUrl,
      expectedUsername: MIGRATOR_ROLE_NAME,
    });
    checks.push({
      id: "migration-url-safety",
      status: migrationUrlSafety.safe ? "pass" : "block",
      summary: migrationUrlSafety.safe
        ? "MIGRATION_URL is a direct, distinct connection correctly identified as the dedicated migrator role."
        : `MIGRATION_URL failed safety validation: ${migrationUrlSafety.reasons.join(" ")}`,
      evidence: { reasons: migrationUrlSafety.reasons },
    });

    if (inventory.migrationCurrentUser !== null) {
      const migrationIdentityCorrect =
        inventory.migrationCurrentUser === MIGRATOR_ROLE_NAME;
      checks.push({
        id: "migration-identity",
        status: migrationIdentityCorrect ? "pass" : "block",
        summary: migrationIdentityCorrect
          ? `MIGRATION_URL's current_user is exactly ${MIGRATOR_ROLE_NAME}.`
          : `MIGRATION_URL's current_user (${inventory.migrationCurrentUser}) is not ${MIGRATOR_ROLE_NAME}.`,
        evidence: { migrationCurrentUser: inventory.migrationCurrentUser },
      });
    } else {
      // Connectivity already failed and blocked above; a missing
      // current_user here is a symptom of that same failure, not an
      // independent not-yet-migrated state.
      checks.push({
        id: "migration-identity",
        status: "block",
        summary:
          "Could not capture current_user on MIGRATION_URL to prove the migrator identity.",
        evidence: { migrationCurrentUser: null },
      });
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
            currentUser: string;
            sessionUser: string;
            searchPath: string;
          }>
        >`
          SELECT
            current_database() AS database,
            current_setting('server_version') AS "serverVersion",
            system_identifier::text AS "systemIdentifier",
            current_user AS "currentUser",
            session_user AS "sessionUser",
            current_setting('search_path') AS "searchPath"
          FROM pg_control_system()
        `;
        inventory.database = server?.database ?? null;
        inventory.serverVersion = server?.serverVersion ?? null;
        inventory.directSystemIdentifier =
          server?.systemIdentifier ?? null;
        inventory.directCurrentUser = server?.currentUser ?? null;
        inventory.directSessionUser = server?.sessionUser ?? null;
        const directSearchPath = server?.searchPath ?? null;
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
        const hasKryptoSafetyIncidentOutbox = tableKeys.has(
          "krypto.SafetyIncidentOutbox",
        );
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
        const exactCurrentPrivateLayout =
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
        const exactBoundedPrivateLayout =
          publicTables.size === 0 &&
          kryptoTables.size === BOUNDED_APPLICATION_TABLES.length &&
          kryptoRelations.length === BOUNDED_APPLICATION_TABLES.length &&
          BOUNDED_APPLICATION_TABLES.every((table) =>
            kryptoTables.has(table),
          ) &&
          kryptoRelations.every(
            (relation) =>
              relation.kind === "r" &&
              BOUNDED_APPLICATION_TABLES.includes(
                relation.name as (typeof BOUNDED_APPLICATION_TABLES)[number],
              ),
          );
        const exactPreBoundedPrivateLayout =
          publicTables.size === 0 &&
          kryptoTables.size === PRE_BOUNDED_APPLICATION_TABLES.length &&
          kryptoRelations.length ===
            PRE_BOUNDED_APPLICATION_TABLES.length &&
          PRE_BOUNDED_APPLICATION_TABLES.every((table) =>
            kryptoTables.has(table),
          ) &&
          kryptoRelations.every(
            (relation) =>
              relation.kind === "r" &&
              PRE_BOUNDED_APPLICATION_TABLES.includes(
                relation.name as (typeof PRE_BOUNDED_APPLICATION_TABLES)[number],
              ),
          );
        const exactPrivateLayout =
          exactCurrentPrivateLayout ||
          exactBoundedPrivateLayout ||
          exactPreBoundedPrivateLayout;
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

        if (hasKryptoSafetyIncidentOutbox) {
          const [row] = await sql<Array<{ count: string }>>`
            -- unresolved critical safety incident count only; no context leaves the database
            SELECT count(*)::text AS count
            FROM (
              SELECT DISTINCT ON ("incidentId")
                "severity",
                "status"
              FROM "krypto"."SafetyIncidentOutbox"
              ORDER BY "incidentId", "eventSequence" DESC
            ) AS latest_incident
            WHERE latest_incident."severity" = 'CRITICAL'
              AND latest_incident."status" <> 'RESOLVED'
          `;
          inventory.unresolvedCriticalSafetyIncidentCount = Number(
            row?.count ?? 0,
          );
          checks.push({
            id: "unresolved-critical-safety-incidents",
            status:
              inventory.unresolvedCriticalSafetyIncidentCount === 0
                ? "pass"
                : "block",
            summary:
              inventory.unresolvedCriticalSafetyIncidentCount === 0
                ? "No unresolved critical safety incident is recorded."
                : "One or more unresolved critical safety incidents block deployment.",
            evidence: {
              count: inventory.unresolvedCriticalSafetyIncidentCount,
            },
          });
        } else {
          checks.push({
            id: "unresolved-critical-safety-incidents",
            status: "warn",
            summary:
              "Safety incident blocking inventory is unavailable until migration 0010 is applied.",
          });
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
              observedTail: migrations.slice(-2),
              expectedTail: EXPECTED_DRIZZLE_MIGRATIONS.slice(-2),
            },
          });
          const migrationLayoutMatches =
            (exactCurrentPrivateLayout &&
              inventory.drizzleMigrationCount >=
                EXPECTED_DRIZZLE_MIGRATIONS.length - 1 &&
              inventory.drizzleMigrationCount <=
                EXPECTED_DRIZZLE_MIGRATIONS.length) ||
            (exactBoundedPrivateLayout &&
              inventory.drizzleMigrationCount ===
                EXPECTED_DRIZZLE_MIGRATIONS.length - 2) ||
            (exactPreBoundedPrivateLayout &&
              inventory.drizzleMigrationCount >= 4 &&
              inventory.drizzleMigrationCount <
                EXPECTED_DRIZZLE_MIGRATIONS.length - 2) ||
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
              exactBoundedPrivateLayout,
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
          NULL_SAFE_CRON_FUNCTIONS_MIGRATION_COUNT
            ? EXPECTED_FUNCTION_HASHES
            : inventory.drizzleMigrationCount ===
                MODE_BOUND_NULLABLE_CRON_FUNCTIONS_MIGRATION_COUNT
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
        const cronFunctionsRetired =
          inventory.drizzleMigrationCount !== null &&
          inventory.drizzleMigrationCount >=
            CRON_FUNCTIONS_RETIRED_MIGRATION_COUNT;
        const fixedFunctionsExpected =
          inventory.drizzleMigrationCount !== null &&
          inventory.drizzleMigrationCount >= 3 &&
          !cronFunctionsRetired;
        checks.push({
          id: "fixed-cron-functions",
          status: cronFunctionsRetired
            ? installedFunctionCount === 0
              ? "pass"
              : "block"
            : inventory.fixedFunctions.agentRun &&
                inventory.fixedFunctions.dailySummary
              ? "pass"
              : fixedFunctionsExpected
                ? "block"
                : "warn",
          summary: cronFunctionsRetired
            ? installedFunctionCount === 0
              ? "Obsolete Supabase HTTP cron functions were retired by the reviewed migration (0007)."
              : "Applied migration history requires the obsolete Supabase HTTP cron functions to be retired, but at least one is still installed."
            : inventory.fixedFunctions.agentRun &&
                inventory.fixedFunctions.dailySummary
              ? "Fixed parameterless Krypto cron functions are installed."
              : fixedFunctionsExpected
                ? "Applied migration history requires both fixed Krypto cron functions."
                : "Fixed Krypto cron functions are not yet fully installed.",
          evidence: inventory.fixedFunctions,
        });
        checks.push({
          id: "fixed-cron-function-integrity",
          status: cronFunctionsRetired
            ? installedFunctionCount === 0
              ? "pass"
              : "block"
            : installedFunctionCount === 0
              ? fixedFunctionsExpected
                ? "block"
                : "warn"
              : inventory.fixedFunctions.integrityVerified
                ? "pass"
                : "block",
          summary: cronFunctionsRetired
            ? installedFunctionCount === 0
              ? "Fixed cron functions were retired by the reviewed migration; no legacy definition remains to verify."
              : "A retired fixed cron function is still installed after the migration that should have dropped it."
            : installedFunctionCount === 0
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
            definitionProfile: cronFunctionsRetired
              ? "retired"
              : expectedFunctionHashes === EXPECTED_FUNCTION_HASHES
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
        if (provider === "azure") {
          const azureFunctionsAbsent =
            !inventory.fixedFunctions.agentRun &&
            !inventory.fixedFunctions.dailySummary;
          checks.push({
            id: "azure-legacy-cron-functions-retired",
            status:
              inventory.drizzleMigrationCount === null
                ? "warn"
                : !cronFunctionsRetired
                  ? "warn"
                  : azureFunctionsAbsent
                    ? "pass"
                    : "block",
            summary:
              inventory.drizzleMigrationCount === null
                ? "Migration history could not be determined for this Azure target."
                : !cronFunctionsRetired
                  ? "Azure target migration history predates the obsolete Supabase HTTP cron function retirement (0007); apply pending migrations."
                  : azureFunctionsAbsent
                    ? "Obsolete Supabase HTTP cron functions are absent, as required for a fully current Azure migration history."
                    : "A fully current Azure migration history must not retain the obsolete Supabase HTTP cron functions.",
            evidence: {
              migrationCount: inventory.drizzleMigrationCount,
              agentRunPresent: inventory.fixedFunctions.agentRun,
              dailySummaryPresent: inventory.fixedFunctions.dailySummary,
            },
          });
        }


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

        const [runtimeRoleRow] = await sql<
          Array<{ present: boolean; isGroupRole: boolean; schemaUsage: boolean }>
        >`
          -- krypto_runtime role inventory
          SELECT
            EXISTS (
              SELECT 1 FROM pg_roles WHERE rolname = ${RUNTIME_ROLE_NAME}
            ) AS present,
            COALESCE(
              (
                SELECT NOT rolcanlogin
                FROM pg_roles
                WHERE rolname = ${RUNTIME_ROLE_NAME}
              ),
              false
            ) AS "isGroupRole",
            CASE
              WHEN EXISTS (
                SELECT 1 FROM pg_roles WHERE rolname = ${RUNTIME_ROLE_NAME}
              ) AND to_regnamespace('krypto') IS NOT NULL
                THEN has_schema_privilege(
                  ${RUNTIME_ROLE_NAME},
                  'krypto',
                  'USAGE'
                )
              ELSE false
            END AS "schemaUsage"
        `;
        const runtimeRolePresent = runtimeRoleRow?.present ?? false;
        const runtimeRoleScan: RuntimePrivilegeScanResult = runtimeRolePresent
          ? await scanRuntimeRolePrivileges(sql, RUNTIME_ROLE_NAME)
          : {
              missingTablePrivileges: [],
              missingSequencePrivileges: [],
              excessTablePrivileges: [],
              excessSequencePrivileges: [],
            };
        inventory.runtimeRole = {
          name: RUNTIME_ROLE_NAME,
          present: runtimeRolePresent,
          isGroupRole: runtimeRoleRow?.isGroupRole ?? false,
          schemaUsage: runtimeRoleRow?.schemaUsage ?? false,
          ...runtimeRoleScan,
        };
        const runtimeRoleExpected =
          inventory.drizzleMigrationCount !== null &&
          inventory.drizzleMigrationCount >=
            CRON_FUNCTIONS_RETIRED_MIGRATION_COUNT;
        const runtimeRoleCorrect =
          runtimeRolePresent &&
          inventory.runtimeRole.isGroupRole &&
          inventory.runtimeRole.schemaUsage &&
          runtimeRoleScan.missingTablePrivileges.length === 0 &&
          runtimeRoleScan.missingSequencePrivileges.length === 0 &&
          runtimeRoleScan.excessTablePrivileges.length === 0 &&
          runtimeRoleScan.excessSequencePrivileges.length === 0;
        const runtimeRoleHasExcess =
          runtimeRoleScan.excessTablePrivileges.length > 0 ||
          runtimeRoleScan.excessSequencePrivileges.length > 0;
        checks.push({
          id: "runtime-role",
          status: runtimeRoleCorrect
            ? "pass"
            // Excess privilege always blocks — it is a live security
            // exposure regardless of the current environment's migration
            // history. Missing-only privileges only block once the
            // environment's own applied migration history requires
            // krypto_runtime to exist (mid-rollout / not-yet-migrated
            // targets legitimately have no grants yet, and warn instead —
            // this also avoids false blocks when krypto_runtime happens to
            // be visible cluster-wide from a sibling database/environment
            // that shares the same PostgreSQL server but has not itself
            // been granted anything).
            : runtimeRoleHasExcess || runtimeRoleExpected
              ? "block"
              : "warn",
          summary: runtimeRoleCorrect
            ? "Least-privilege krypto_runtime group role has exactly the required NOLOGIN, schema, and per-table privilege matrix — nothing missing, nothing excess."
            : runtimeRolePresent
              ? runtimeRoleHasExcess
                ? "krypto_runtime holds one or more privileges beyond the exact fail-closed matrix (excess privilege); this blocks regardless of whether required privileges are also present."
                : "krypto_runtime is present but is missing an expected NOLOGIN, schema-usage, or per-table privilege."
              : runtimeRoleExpected
                ? "Applied migration history requires the least-privilege krypto_runtime group role."
                : "The least-privilege krypto_runtime group role is not yet installed.",
          evidence: { ...inventory.runtimeRole },
        });

        // Requirement #3: prove the *actual* Azure application login role
        // (current_user on DATABASE_URL) — not merely the krypto_runtime
        // group role itself — is a member of krypto_runtime and inherits
        // exactly the matrix's privileges, no more and no less. Both
        // current_user values are captured unconditionally above; the
        // pass/warn/block severity of these proof checks is provider-
        // gated so legacy (non-Azure) targets remain warn-only.
        const runtimeCurrentUser = inventory.runtimeCurrentUser;
        const directCurrentUser = inventory.directCurrentUser;
        const connectionRolesDistinct =
          runtimeCurrentUser !== null &&
          directCurrentUser !== null &&
          runtimeCurrentUser !== directCurrentUser;
        checks.push({
          id: "connection-roles-distinct",
          status: connectionRolesDistinct
            ? "pass"
            : provider === "azure"
              ? "block"
              : "warn",
          summary: connectionRolesDistinct
            ? "DATABASE_URL and DIRECT_URL authenticate as distinct database roles."
            : runtimeCurrentUser === null || directCurrentUser === null
              ? "Could not capture current_user on one or both connections."
              : "DATABASE_URL and DIRECT_URL authenticate as the same database role; the application runtime should use a least-privilege role distinct from the migration/admin role.",
          evidence: { directCurrentUser, runtimeCurrentUser },
        });

        let runtimeLoginRoleScan: RuntimePrivilegeScanResult | null = null;
        let isMemberOfRuntimeRole = false;
        // pg_has_role() raises an error (not false) when its role argument
        // does not exist, so this membership/privilege proof is only
        // meaningful — and only attempted — once krypto_runtime itself is
        // present. On a legacy/pre-Azure-transition database (krypto_runtime
        // not yet installed) this must fall through to the "not proven"
        // warn/block branch below rather than throw and abort the entire
        // inventory.
        if (runtimeCurrentUser !== null && runtimeRolePresent) {
          const [membershipRow] = await sql<Array<{ isMember: boolean }>>`
            -- runtime login role membership check
            SELECT pg_has_role(${runtimeCurrentUser}, ${RUNTIME_ROLE_NAME}, 'MEMBER')
              AS "isMember"
          `;
          isMemberOfRuntimeRole = membershipRow?.isMember ?? false;
          runtimeLoginRoleScan = await scanRuntimeRolePrivileges(
            sql,
            runtimeCurrentUser,
          );
          inventory.runtimeLoginRole = {
            currentUser: runtimeCurrentUser,
            isMemberOfRuntimeRole,
            ...runtimeLoginRoleScan,
          };
        }
        const runtimeLoginRoleBoundaryProven =
          runtimeLoginRoleScan !== null &&
          isMemberOfRuntimeRole &&
          runtimeLoginRoleScan.missingTablePrivileges.length === 0 &&
          runtimeLoginRoleScan.missingSequencePrivileges.length === 0 &&
          runtimeLoginRoleScan.excessTablePrivileges.length === 0 &&
          runtimeLoginRoleScan.excessSequencePrivileges.length === 0;
        checks.push({
          id: "runtime-login-role-boundary",
          status: runtimeLoginRoleBoundaryProven
            ? "pass"
            : provider === "azure"
              ? "block"
              : "warn",
          summary: runtimeLoginRoleBoundaryProven
            ? `DATABASE_URL's current_user (${runtimeCurrentUser}) is a member of krypto_runtime and inherits exactly the intended per-table privilege matrix, with no excess privilege.`
            : runtimeCurrentUser === null
              ? "Could not capture current_user on DATABASE_URL to prove runtime login role privilege boundaries."
              : !isMemberOfRuntimeRole
                ? `DATABASE_URL's current_user (${runtimeCurrentUser}) is not a member of krypto_runtime.`
                : "DATABASE_URL's current_user has a missing or excess privilege relative to the exact per-table matrix.",
          evidence: (inventory.runtimeLoginRole ?? {
            currentUser: runtimeCurrentUser,
          }) as Record<string, unknown>,
        });

        // PostgreSQL trust boundary (GitHub issue #133): the four-role
        // hierarchy established by src/deployment/bootstrap-runtime-role.ts
        // (bootstrapDatabaseRoles) and
        // drizzle/0008_postgresql_trust_boundaries.sql. Every observation
        // below is read-only over DIRECT_URL. Genuinely exploitable live
        // exposures (excess membership, wrong ownership, leaked default
        // privileges, reachable legacy schemas) always block regardless of
        // provider; "trust boundary not migrated yet" is provider-gated
        // warn/block, mirroring the existing runtime-role pattern.
        const trustBoundaryExpected =
          inventory.drizzleMigrationCount !== null &&
          inventory.drizzleMigrationCount >= TRUST_BOUNDARY_MIGRATION_COUNT;
        const notYetMigratedStatus: PreflightCheck["status"] =
          provider === "azure" ? "block" : "warn";

        const roleAttributeRows = await sql<
          Array<{
            rolname: string;
            canLogin: boolean;
            inherits: boolean;
            connectionLimit: number;
          }>
        >`
          -- trust boundary role attributes
          SELECT
            rolname,
            rolcanlogin AS "canLogin",
            rolinherit AS "inherits",
            rolconnlimit AS "connectionLimit"
          FROM pg_roles
          WHERE rolname IN (${SCHEMA_OWNER_ROLE_NAME}, ${MIGRATOR_ROLE_NAME}, ${SCHEDULER_ROLE_NAME}, ${RUNTIME_ROLE_NAME}, ${runtimeCurrentUser ?? ""})
        `;
        const roleAttributeByName = new Map(
          roleAttributeRows.map((row) => [row.rolname, row]),
        );
        const toRoleAttributes = (
          roleName: string,
        ): TrustBoundaryRoleAttributes => {
          const row = roleAttributeByName.get(roleName);
          return row
            ? {
                present: true,
                canLogin: row.canLogin,
                inherits: row.inherits,
                connectionLimit: row.connectionLimit,
              }
            : { present: false, canLogin: false, inherits: false, connectionLimit: null };
        };
        const schemaOwnerRole = toRoleAttributes(SCHEMA_OWNER_ROLE_NAME);
        const migratorRole = toRoleAttributes(MIGRATOR_ROLE_NAME);
        const schedulerRole = toRoleAttributes(SCHEDULER_ROLE_NAME);
        const runtimeGroupRole = toRoleAttributes(RUNTIME_ROLE_NAME);
        const runtimeLoginTrustRole = runtimeCurrentUser
          ? toRoleAttributes(runtimeCurrentUser)
          : { present: false, canLogin: false, inherits: false, connectionLimit: null };

        const [migratorMembership] = await sql<
          Array<{ adminOption: boolean; inheritOption: boolean; setOption: boolean }>
        >`
          -- trust boundary migrator membership options
          SELECT
            am.admin_option AS "adminOption",
            am.inherit_option AS "inheritOption",
            am.set_option AS "setOption"
          FROM pg_auth_members am
          JOIN pg_roles m ON m.oid = am.member
          JOIN pg_roles r ON r.oid = am.roleid
          WHERE m.rolname = ${MIGRATOR_ROLE_NAME} AND r.rolname = ${SCHEMA_OWNER_ROLE_NAME}
        `;
        const migratorHasSchemaOwnerSetOption =
          migratorMembership?.setOption ?? false;
        const migratorInheritsSchemaOwner =
          migratorMembership?.inheritOption ?? false;
        const migratorHasSchemaOwnerAdminOption =
          migratorMembership?.adminOption ?? false;

        const [runtimeMembership] = await sql<
          Array<{
            ownerMember: boolean | null;
            migratorMember: boolean | null;
            schedulerMember: boolean | null;
          }>
        >`
          -- trust boundary runtime elevated membership
          SELECT
            CASE
              WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${RUNTIME_ROLE_NAME})
               AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${SCHEMA_OWNER_ROLE_NAME})
              THEN pg_has_role(${RUNTIME_ROLE_NAME}, ${SCHEMA_OWNER_ROLE_NAME}, 'MEMBER')
            END AS "ownerMember",
            CASE
              WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${RUNTIME_ROLE_NAME})
               AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${MIGRATOR_ROLE_NAME})
              THEN pg_has_role(${RUNTIME_ROLE_NAME}, ${MIGRATOR_ROLE_NAME}, 'MEMBER')
            END AS "migratorMember",
            CASE
              WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${RUNTIME_ROLE_NAME})
               AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${SCHEDULER_ROLE_NAME})
              THEN pg_has_role(${RUNTIME_ROLE_NAME}, ${SCHEDULER_ROLE_NAME}, 'MEMBER')
            END AS "schedulerMember"
        `;
        const runtimeIsMemberOfSchemaOwner =
          runtimeMembership?.ownerMember ?? null;
        const runtimeIsMemberOfMigrator =
          runtimeMembership?.migratorMember ?? null;
        const runtimeIsMemberOfScheduler =
          runtimeMembership?.schedulerMember ?? null;

        const [explicitMembershipRow] = await sql<
          Array<{ runtimeLoginElevated: boolean; operatorElevated: boolean }>
        >`-- trust boundary explicit login memberships
          SELECT
            EXISTS (
              SELECT 1
              FROM pg_auth_members am
              JOIN pg_roles member_role ON member_role.oid = am.member
              JOIN pg_roles granted_role ON granted_role.oid = am.roleid
              WHERE member_role.rolname = ${runtimeCurrentUser ?? ""}
                AND granted_role.rolname IN (${SCHEMA_OWNER_ROLE_NAME}, ${MIGRATOR_ROLE_NAME}, ${SCHEDULER_ROLE_NAME})
            ) AS "runtimeLoginElevated",
            EXISTS (
              SELECT 1
              FROM pg_auth_members am
              JOIN pg_roles member_role ON member_role.oid = am.member
              JOIN pg_roles granted_role ON granted_role.oid = am.roleid
              WHERE member_role.rolname = ${directCurrentUser ?? ""}
                AND granted_role.rolname IN (${SCHEMA_OWNER_ROLE_NAME}, ${MIGRATOR_ROLE_NAME})
            ) AS "operatorElevated"`;
        const runtimeLoginHasElevatedMembership =
          explicitMembershipRow?.runtimeLoginElevated ?? null;
        const operatorHasExplicitElevatedMembership =
          explicitMembershipRow?.operatorElevated ?? null;

        const [appSchemaOwnerRow] = await sql<
          Array<{ owner: string | null }>
        >`
          -- trust boundary app schema owner
          SELECT nspowner::regrole::text AS owner
          FROM pg_namespace
          WHERE nspname = ${APP_SCHEMA_NAME}
        `;
        const appSchemaOwner = appSchemaOwnerRow?.owner ?? null;

        const [appSchemaBadOwnerRow] = await sql<
          Array<{ badOwnerCount: number }>
        >`
          -- trust boundary app schema bad owner count
          SELECT count(*)::int AS "badOwnerCount"
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = ${APP_SCHEMA_NAME}
            AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
            AND c.relowner::regrole::text <> ${SCHEMA_OWNER_ROLE_NAME}
        `;
        const appSchemaBadOwnerCount =
          appSchemaBadOwnerRow?.badOwnerCount ?? null;

        const [migrationLedgerOwnerRow] = await sql<
          Array<{ owner: string | null }>
        >`
          -- trust boundary migration ledger owner
          SELECT nspowner::regrole::text AS owner
          FROM pg_namespace
          WHERE nspname = ${MIGRATION_LEDGER_SCHEMA_NAME}
        `;
        const migrationLedgerOwner = migrationLedgerOwnerRow?.owner ?? null;
        const migrationLedgerOwnerAcceptable =
          migrationLedgerOwner === null ||
          migrationLedgerOwner === SCHEMA_OWNER_ROLE_NAME ||
          migrationLedgerOwner === MIGRATOR_ROLE_NAME;

        const [runtimeLedgerAccessRow] = await sql<
          Array<{ hasAccess: boolean | null }>
        >`
          -- trust boundary runtime migration ledger access
          SELECT
            CASE
              WHEN to_regnamespace(${MIGRATION_LEDGER_SCHEMA_NAME}) IS NOT NULL
               AND ${runtimeCurrentUser ?? ""} <> ''
              THEN
                has_schema_privilege(${runtimeCurrentUser ?? ""}, ${MIGRATION_LEDGER_SCHEMA_NAME}, 'USAGE')
                OR EXISTS (
                  SELECT 1
                  FROM pg_class c
                  JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = ${MIGRATION_LEDGER_SCHEMA_NAME}
                    AND CASE WHEN c.relkind = 'S' THEN
                      (
                        has_sequence_privilege(${runtimeCurrentUser ?? ""}, c.oid, 'USAGE')
                        OR has_sequence_privilege(${runtimeCurrentUser ?? ""}, c.oid, 'SELECT')
                        OR has_sequence_privilege(${runtimeCurrentUser ?? ""}, c.oid, 'UPDATE')
                      )
                    ELSE
                      (
                        has_table_privilege(${runtimeCurrentUser ?? ""}, c.oid, 'SELECT')
                        OR has_table_privilege(${runtimeCurrentUser ?? ""}, c.oid, 'INSERT')
                        OR has_table_privilege(${runtimeCurrentUser ?? ""}, c.oid, 'UPDATE')
                        OR has_table_privilege(${runtimeCurrentUser ?? ""}, c.oid, 'DELETE')
                        OR has_table_privilege(${runtimeCurrentUser ?? ""}, c.oid, 'TRUNCATE')
                        OR has_table_privilege(${runtimeCurrentUser ?? ""}, c.oid, 'REFERENCES')
                        OR has_table_privilege(${runtimeCurrentUser ?? ""}, c.oid, 'TRIGGER')
                      )
                    END
                )
            END AS "hasAccess"
        `;
        const runtimeHasMigrationLedgerAccess =
          runtimeLedgerAccessRow?.hasAccess ?? null;

        const legacySchemaRuntimeAccess: Record<string, boolean> = {};
        for (const legacySchema of LEGACY_UNRELATED_SCHEMAS) {
          const [legacyRow] = await sql<
            Array<{ hasAccess: boolean | null }>
          >`
            -- trust boundary legacy schema access
            SELECT
              CASE
                WHEN to_regnamespace(${legacySchema}) IS NOT NULL
                   AND ${runtimeCurrentUser ?? ""} <> ''
                  THEN
                    has_schema_privilege(${runtimeCurrentUser ?? ""}, ${legacySchema}, 'USAGE')
                    OR EXISTS (
                      SELECT 1
                      FROM pg_class c
                      JOIN pg_namespace n ON n.oid = c.relnamespace
                      WHERE n.nspname = ${legacySchema}
                        AND CASE WHEN c.relkind = 'S' THEN
                          (
                            has_sequence_privilege(${runtimeCurrentUser ?? ""}, c.oid, 'USAGE')
                            OR has_sequence_privilege(${runtimeCurrentUser ?? ""}, c.oid, 'SELECT')
                            OR has_sequence_privilege(${runtimeCurrentUser ?? ""}, c.oid, 'UPDATE')
                          )
                        ELSE (
                          has_table_privilege(${runtimeCurrentUser ?? ""}, c.oid, 'SELECT')
                          OR has_table_privilege(${runtimeCurrentUser ?? ""}, c.oid, 'INSERT')
                          OR has_table_privilege(${runtimeCurrentUser ?? ""}, c.oid, 'UPDATE')
                          OR has_table_privilege(${runtimeCurrentUser ?? ""}, c.oid, 'DELETE')
                        ) END
                    )
              END AS "hasAccess"
          `;
          legacySchemaRuntimeAccess[legacySchema] =
            legacyRow?.hasAccess ?? false;
        }
        const legacySchemaViolations = LEGACY_UNRELATED_SCHEMAS.filter(
          (legacySchema) => legacySchemaRuntimeAccess[legacySchema],
        );

        const runtimePublicGrantRows = await sql<Array<{ name: string }>>`
          -- trust boundary runtime public object grants
          SELECT 'relation:' || c.relname AS name
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND c.relkind <> 'S'
            AND ${runtimeCurrentUser ?? ""} <> ''
            AND (
              has_table_privilege(${runtimeCurrentUser ?? ""}, c.oid, 'SELECT')
              OR has_table_privilege(${runtimeCurrentUser ?? ""}, c.oid, 'INSERT')
              OR has_table_privilege(${runtimeCurrentUser ?? ""}, c.oid, 'UPDATE')
              OR has_table_privilege(${runtimeCurrentUser ?? ""}, c.oid, 'DELETE')
              OR has_table_privilege(${runtimeCurrentUser ?? ""}, c.oid, 'TRUNCATE')
              OR has_table_privilege(${runtimeCurrentUser ?? ""}, c.oid, 'REFERENCES')
              OR has_table_privilege(${runtimeCurrentUser ?? ""}, c.oid, 'TRIGGER')
            )
          UNION ALL
          SELECT 'sequence:' || c.relname AS name
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND c.relkind = 'S'
            AND ${runtimeCurrentUser ?? ""} <> ''
            AND (
              has_sequence_privilege(${runtimeCurrentUser ?? ""}, c.oid, 'USAGE')
              OR has_sequence_privilege(${runtimeCurrentUser ?? ""}, c.oid, 'SELECT')
              OR has_sequence_privilege(${runtimeCurrentUser ?? ""}, c.oid, 'UPDATE')
            )
          UNION ALL
          SELECT 'routine:' || p.proname AS name
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public'
            AND ${runtimeCurrentUser ?? ""} <> ''
            AND has_function_privilege(${runtimeCurrentUser ?? ""}, p.oid, 'EXECUTE')
        `;
        const runtimePublicObjectGrants = runtimePublicGrantRows.map(
          (row) => row.name,
        );

        const [publicSchemaAclRow] = await sql<
          Array<{ creatable: boolean }>
        >`-- trust boundary public schema create
          SELECT has_schema_privilege('public', 'public', 'CREATE') AS creatable`;
        const publicSchemaCreatableByPublic =
          publicSchemaAclRow?.creatable ?? null;
        const [runtimePublicSchemaAccessRow] = await sql<
          Array<{ hasAccess: boolean | null }>
        >`-- trust boundary runtime public schema access
          SELECT CASE
            WHEN ${runtimeCurrentUser ?? ""} <> ''
              THEN has_schema_privilege(${runtimeCurrentUser ?? ""}, 'public', 'USAGE')
            END AS "hasAccess"`;
        const runtimeHasPublicSchemaAccess =
          runtimePublicSchemaAccessRow?.hasAccess ?? null;

        const [migratorCreatePrivilegesRow] = await sql<
          Array<{ databaseCreate: boolean | null; publicCreate: boolean | null }>
        >`-- trust boundary migrator create privileges
          SELECT
            CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${MIGRATOR_ROLE_NAME})
              THEN has_database_privilege(${MIGRATOR_ROLE_NAME}, current_database(), 'CREATE')
            END AS "databaseCreate",
            CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${MIGRATOR_ROLE_NAME})
              THEN has_schema_privilege(${MIGRATOR_ROLE_NAME}, 'public', 'CREATE')
            END AS "publicCreate"`;
        const migratorCanCreateDatabaseObjects =
          migratorCreatePrivilegesRow?.databaseCreate ?? null;
        const migratorCanCreatePublicObjects =
          migratorCreatePrivilegesRow?.publicCreate ?? null;

        const defaultAclLeakRows = await sql<
          Array<{ defaclRole: string; objType: string; grantee: string | null }>
        >`
          -- trust boundary default privilege leaks
          SELECT
            r.rolname AS "defaclRole",
            da.defaclobjtype AS "objType",
            acl.grantee::regrole::text AS grantee
          FROM pg_default_acl da
          JOIN pg_roles r ON r.oid = da.defaclrole
          LEFT JOIN pg_namespace n ON n.oid = da.defaclnamespace
          CROSS JOIN LATERAL aclexplode(da.defaclacl) AS acl
          WHERE r.rolname IN (${SCHEMA_OWNER_ROLE_NAME}, ${MIGRATOR_ROLE_NAME})
            AND (da.defaclnamespace = 0 OR n.nspname = ${APP_SCHEMA_NAME})
            AND acl.grantee <> da.defaclrole
        `;

        inventory.trustBoundary = {
          schemaOwnerRole,
          migratorRole,
          schedulerRole,
          runtimeGroupRole,
          runtimeLoginRole: runtimeLoginTrustRole,
          migratorHasSchemaOwnerSetOption,
          migratorInheritsSchemaOwner,
          runtimeIsMemberOfSchemaOwner,
          runtimeIsMemberOfMigrator,
          runtimeIsMemberOfScheduler,
          runtimeLoginHasElevatedMembership,
          operatorHasExplicitElevatedMembership,
          appSchemaOwner,
          appSchemaBadOwnerCount,
          migrationLedgerOwner,
          runtimeHasMigrationLedgerAccess,
          legacySchemaRuntimeAccess,
          runtimePublicObjectGrants,
          publicSchemaCreatableByPublic,
          runtimeHasPublicSchemaAccess,
          migratorCanCreateDatabaseObjects,
          migratorCanCreatePublicObjects,
          searchPath: {
            direct: directSearchPath,
            migration: migrationSearchPath,
            runtime: runtimeSearchPath,
          },
        };

        // A live security exposure -- a role that already exists but is
        // configured unsafely (able to log in when it must not be, or
        // otherwise misconfigured) -- always blocks, independent of
        // whether the environment's migration history has reached
        // TRUST_BOUNDARY_MIGRATION_COUNT yet.
        const roleAttributesLiveExposure =
          (schemaOwnerRole.present && schemaOwnerRole.canLogin) ||
          (schedulerRole.present && schedulerRole.canLogin) ||
          (migratorRole.present &&
            (!migratorRole.canLogin || migratorRole.inherits)) ||
          (runtimeGroupRole.present &&
            (runtimeGroupRole.canLogin || runtimeGroupRole.connectionLimit !== 0)) ||
          (trustBoundaryExpected &&
            runtimeLoginTrustRole.present &&
            (!runtimeLoginTrustRole.canLogin ||
              !runtimeLoginTrustRole.inherits ||
              runtimeLoginTrustRole.connectionLimit !== 20));
        const roleAttributesProven =
          schemaOwnerRole.present &&
          !schemaOwnerRole.canLogin &&
          migratorRole.present &&
          migratorRole.canLogin &&
          !migratorRole.inherits &&
          schedulerRole.present &&
          !schedulerRole.canLogin &&
          runtimeGroupRole.present &&
          !runtimeGroupRole.canLogin &&
          runtimeGroupRole.connectionLimit === 0 &&
          runtimeLoginTrustRole.present &&
          runtimeLoginTrustRole.canLogin &&
          runtimeLoginTrustRole.inherits &&
          runtimeLoginTrustRole.connectionLimit === 20;
        checks.push({
          id: "trust-boundary-role-attributes",
          status: roleAttributesProven
            ? "pass"
            : roleAttributesLiveExposure || trustBoundaryExpected
              ? "block"
              : "warn",
          summary: roleAttributesProven
            ? "Owner, scheduler, runtime group, migrator, and runtime login roles have the exact LOGIN/NOLOGIN, inheritance, and connection-limit posture."
            : !schemaOwnerRole.present && !migratorRole.present && !schedulerRole.present
              ? "krypto_schema_owner/krypto_migrator/krypto_scheduler do not exist yet; the trust boundary has not been migrated."
              : `krypto_schema_owner is ${schemaOwnerRole.present ? (schemaOwnerRole.canLogin ? "LOGIN (unsafe)" : "NOLOGIN") : "missing"}; krypto_migrator is ${migratorRole.present ? (migratorRole.canLogin && !migratorRole.inherits ? "LOGIN+NOINHERIT" : "misconfigured") : "missing"}; krypto_scheduler is ${schedulerRole.present ? (schedulerRole.canLogin ? "LOGIN (unsafe)" : "NOLOGIN") : "missing"}.`,
          evidence: {
            schemaOwnerRole,
            migratorRole,
            schedulerRole,
            runtimeGroupRole,
            runtimeLoginRole: runtimeLoginTrustRole,
          },
        });

        const migratorSetOnlyProven =
          migratorRole.present &&
          migratorHasSchemaOwnerSetOption &&
          !migratorInheritsSchemaOwner;
        // A misconfigured membership on an already-created migrator role
        // (inheriting instead of SET-only, or no path at all) is a live
        // exposure and always blocks; a migrator that simply does not
        // exist yet only blocks once the environment's own migration
        // history says it should.
        const migratorSetOnlyLiveExposure =
          migratorRole.present && !migratorSetOnlyProven;
        checks.push({
          id: "trust-boundary-migrator-set-role-path",
          status: migratorSetOnlyProven
            ? "pass"
            : migratorSetOnlyLiveExposure || trustBoundaryExpected
              ? "block"
              : "warn",
          summary: migratorSetOnlyProven
            ? "krypto_migrator has SET (not INHERIT) membership in krypto_schema_owner: it must explicitly SET ROLE to create/alter schema objects."
            : !migratorRole.present
              ? "krypto_migrator does not exist yet."
              : migratorInheritsSchemaOwner
                ? "krypto_migrator INHERITs krypto_schema_owner; it must be SET-only (NOINHERIT membership)."
                : "krypto_migrator lacks a SET-ROLE path to krypto_schema_owner; migrations cannot create schema-owned objects.",
          evidence: {
            migratorHasSchemaOwnerSetOption,
            migratorInheritsSchemaOwner,
            migratorHasSchemaOwnerAdminOption,
          },
        });

        const runtimeElevatedMembershipViolations = [
          runtimeIsMemberOfSchemaOwner === true ? SCHEMA_OWNER_ROLE_NAME : null,
          runtimeIsMemberOfMigrator === true ? MIGRATOR_ROLE_NAME : null,
          runtimeIsMemberOfScheduler === true ? SCHEDULER_ROLE_NAME : null,
          runtimeLoginHasElevatedMembership === true
            ? "runtime-login-explicit-membership"
            : null,
        ].filter((value): value is string => value !== null);
        checks.push({
          id: "trust-boundary-runtime-not-elevated",
          // Always block regardless of provider: an observed elevated
          // membership is a live security exposure, not merely a
          // not-yet-migrated state.
          status:
            runtimeElevatedMembershipViolations.length > 0 ? "block" : "pass",
          summary:
            runtimeElevatedMembershipViolations.length > 0
              ? `krypto_runtime is a member of elevated role(s): ${runtimeElevatedMembershipViolations.join(", ")}.`
              : "Neither krypto_runtime nor the DATABASE_URL login is a member of krypto_schema_owner, krypto_migrator, or krypto_scheduler.",
          evidence: {
            runtimeIsMemberOfSchemaOwner,
            runtimeIsMemberOfMigrator,
            runtimeIsMemberOfScheduler,
            runtimeLoginHasElevatedMembership,
          },
        });

        checks.push({
          id: "trust-boundary-operator-membership",
          status:
            operatorHasExplicitElevatedMembership === false
              ? "pass"
              : trustBoundaryExpected
                ? "block"
                : "warn",
          summary:
            operatorHasExplicitElevatedMembership === false
              ? "DIRECT_URL's operator has no persistent explicit membership in schema-owner or migrator roles."
              : "DIRECT_URL's operator retains an explicit elevated membership after bootstrap finalization.",
          evidence: { operatorHasExplicitElevatedMembership },
        });

        const appSchemaOwnershipProven =
          appSchemaOwner === SCHEMA_OWNER_ROLE_NAME &&
          (appSchemaBadOwnerCount ?? 0) === 0;
        checks.push({
          id: "trust-boundary-app-schema-ownership",
          status: appSchemaOwnershipProven
            ? "pass"
            : appSchemaOwner === null
              ? "warn"
              : trustBoundaryExpected
                ? "block"
                : "warn",
          summary:
            appSchemaOwner === null
              ? `The "${APP_SCHEMA_NAME}" schema does not exist yet.`
              : appSchemaOwnershipProven
                ? `The "${APP_SCHEMA_NAME}" schema and all its tables/views/sequences are owned by ${SCHEMA_OWNER_ROLE_NAME}.`
                : appSchemaOwner !== SCHEMA_OWNER_ROLE_NAME
                  ? `The "${APP_SCHEMA_NAME}" schema is owned by ${appSchemaOwner}, not ${SCHEMA_OWNER_ROLE_NAME}.`
                  : `${appSchemaBadOwnerCount} object(s) in "${APP_SCHEMA_NAME}" are not owned by ${SCHEMA_OWNER_ROLE_NAME}.`,
          evidence: { appSchemaOwner, appSchemaBadOwnerCount },
        });

        checks.push({
          id: "trust-boundary-migration-ledger-ownership",
          status: migrationLedgerOwnerAcceptable
            ? "pass"
            : trustBoundaryExpected
              ? "block"
              : "warn",
          summary:
            migrationLedgerOwner === null
              ? `The "${MIGRATION_LEDGER_SCHEMA_NAME}" migration ledger schema does not exist yet.`
              : migrationLedgerOwnerAcceptable
                ? `The "${MIGRATION_LEDGER_SCHEMA_NAME}" migration ledger schema is owned by ${migrationLedgerOwner}.`
                : `The "${MIGRATION_LEDGER_SCHEMA_NAME}" migration ledger schema is owned by ${migrationLedgerOwner}, expected ${SCHEMA_OWNER_ROLE_NAME} or ${MIGRATOR_ROLE_NAME}.`,
          evidence: { migrationLedgerOwner },
        });

        const runtimeDenialViolation =
          runtimeHasMigrationLedgerAccess === true ||
          legacySchemaViolations.length > 0 ||
          runtimePublicObjectGrants.length > 0;
        checks.push({
          id: "trust-boundary-runtime-denial-matrix",
          // Once 0008 is applied, any reachable ledger/legacy/public object
          // blocks. Before 0008, report it as rollout evidence without
          // retroactively making the legacy pre-migration inventory unusable.
          status: runtimeDenialViolation
            ? trustBoundaryExpected
              ? "block"
              : "warn"
            : "pass",
          summary:
            runtimeHasMigrationLedgerAccess === true
              ? `krypto_runtime has USAGE on the "${MIGRATION_LEDGER_SCHEMA_NAME}" migration ledger schema.`
              : legacySchemaViolations.length > 0
                ? `krypto_runtime can still reach legacy schema(s): ${legacySchemaViolations.join(", ")}.`
                : runtimePublicObjectGrants.length > 0
                  ? `krypto_runtime holds unexpected public-schema grant(s): ${runtimePublicObjectGrants.join(", ")}.`
                  : "krypto_runtime has no access to the drizzle migration ledger, legacy vault/cron/net/pg_net schemas, or unrelated public-schema objects.",
          evidence: {
            runtimeHasMigrationLedgerAccess,
            legacySchemaRuntimeAccess,
            runtimePublicObjectGrants,
          },
        });

        checks.push({
          id: "trust-boundary-default-privileges",
          // Always block: a default-privilege leak grants access to every
          // future object, not just existing ones.
          status: defaultAclLeakRows.length > 0 ? "block" : "pass",
          summary:
            defaultAclLeakRows.length > 0
              ? `Default privileges for krypto_schema_owner/krypto_migrator in "${APP_SCHEMA_NAME}" leak access to unexpected grantee(s): ${Array.from(new Set(defaultAclLeakRows.map((row) => row.grantee ?? "PUBLIC"))).join(", ")}.`
              : `No default-privilege leaks found for future objects created by krypto_schema_owner/krypto_migrator in "${APP_SCHEMA_NAME}".`,
          evidence: { leaks: defaultAclLeakRows },
        });

        checks.push({
          id: "trust-boundary-public-schema-create",
          status:
            publicSchemaCreatableByPublic === null
              ? notYetMigratedStatus
              : publicSchemaCreatableByPublic
                ? "block"
                : "pass",
          summary:
            publicSchemaCreatableByPublic === null
              ? 'Could not evaluate PUBLIC\'s CREATE privilege on the "public" schema.'
              : publicSchemaCreatableByPublic
                ? 'The PUBLIC pseudo-role still holds CREATE on the "public" schema (search-path-hijack exposure).'
                : 'The PUBLIC pseudo-role has no CREATE privilege on the "public" schema.',
          evidence: { publicSchemaCreatableByPublic },
        });

        checks.push({
          id: "trust-boundary-runtime-public-schema",
          status:
            runtimeHasPublicSchemaAccess === false
              ? "pass"
              : trustBoundaryExpected
                ? "block"
                : "warn",
          summary:
            runtimeHasPublicSchemaAccess === false
              ? "DATABASE_URL has no USAGE on the unrelated public schema."
              : "DATABASE_URL can resolve unrelated objects in the public schema.",
          evidence: { runtimeHasPublicSchemaAccess },
        });

        const migratorConnectionLimitBounded =
          migratorRole.present &&
          migratorRole.connectionLimit !== null &&
          migratorRole.connectionLimit >= 1 &&
          migratorRole.connectionLimit <= 1000;
        checks.push({
          id: "trust-boundary-migrator-connection-limit",
          status: migratorConnectionLimitBounded
            ? "pass"
            : !migratorRole.present && !trustBoundaryExpected
              ? "warn"
              : "block",
          summary: !migratorRole.present
            ? "krypto_migrator does not exist yet."
            : migratorConnectionLimitBounded
              ? `krypto_migrator has a bounded connection limit (${migratorRole.connectionLimit}).`
              : `krypto_migrator has an unbounded or unsafe connection limit (${migratorRole.connectionLimit}).`,
          evidence: { connectionLimit: migratorRole.connectionLimit },
        });

        const migratorCreatePrivilegesRestricted =
          migratorCanCreateDatabaseObjects === true &&
          migratorCanCreatePublicObjects === false;
        checks.push({
          id: "trust-boundary-migrator-create-boundary",
          status: migratorCreatePrivilegesRestricted
            ? "pass"
            : !trustBoundaryExpected
              ? "warn"
              : "block",
          summary: migratorCreatePrivilegesRestricted
            ? "krypto_migrator has the database CREATE required by drizzle-kit, cannot create objects in public, and can alter application objects only after explicit SET ROLE."
            : "krypto_migrator is missing drizzle-kit's required database CREATE or retains unsafe public-schema CREATE.",
          evidence: {
            databaseCreate: migratorCanCreateDatabaseObjects,
            publicCreate: migratorCanCreatePublicObjects,
          },
        });

        const searchPathsSafe =
          directSearchPath === "pg_catalog" &&
          migrationSearchPath === "pg_catalog" &&
          runtimeSearchPath === "krypto, pg_catalog";
        checks.push({
          id: "trust-boundary-search-path",
          status: searchPathsSafe
            ? "pass"
            : trustBoundaryExpected
              ? "block"
              : "warn",
          summary: searchPathsSafe
            ? "DIRECT_URL and MIGRATION_URL use pg_catalog-only search paths; DATABASE_URL uses krypto, pg_catalog with public excluded."
            : "One or more database identities has a missing or unsafe search_path; public and $user must not participate in name resolution.",
          evidence: {
            direct: directSearchPath,
            migration: migrationSearchPath,
            runtime: runtimeSearchPath,
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
        const azureVaultAbsenceExpected =
          provider === "azure" &&
          !vaultRelation?.relation &&
          inventory.vaultSecretNames.length === 0;
        checks.push({
          id: "vault-secrets",
          status:
            inventory.vaultSecretNames.length === 3 ||
            azureVaultAbsenceExpected
              ? "pass"
              : "warn",
          summary: azureVaultAbsenceExpected
            ? "Supabase Vault is not part of the Azure target; its absence is expected, not missing configuration."
            : inventory.vaultSecretNames.length === 3
              ? "Required Krypto Vault secret names are present."
              : "Required Krypto Vault secrets are not yet fully configured.",
          evidence: {
            configuredNames: inventory.vaultSecretNames,
            vaultPresent: Boolean(vaultRelation?.relation),
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

  if (!migrationUrl) {
    // MIGRATION_URL only became a hard requirement as of migration 0008
    // (drizzle/0008_postgresql_trust_boundaries.sql); before an
    // environment's applied migration history reaches
    // TRUST_BOUNDARY_MIGRATION_COUNT, its absence is an expected
    // not-yet-migrated state (warn), not a live problem.
    const trustBoundaryMigrationExpected =
      inventory.drizzleMigrationCount !== null &&
      inventory.drizzleMigrationCount >= TRUST_BOUNDARY_MIGRATION_COUNT;
    const missingMigrationUrlStatus: PreflightCheck["status"] =
      trustBoundaryMigrationExpected ? "block" : "warn";
    checks.push({
      id: "migration-connectivity",
      status: missingMigrationUrlStatus,
      summary:
        "MIGRATION_URL is missing; the dedicated migrator identity cannot be proven.",
    });
    checks.push({
      id: "migration-url-safety",
      status: missingMigrationUrlStatus,
      summary: "MIGRATION_URL is missing; its safety cannot be validated.",
    });
    checks.push({
      id: "migration-identity",
      status: missingMigrationUrlStatus,
      summary:
        "Could not capture current_user on MIGRATION_URL to prove the migrator identity.",
    });
  }

  if (provider === "azure") {
    try {
      const roster = readSafetyRoster(input.env ?? process.env);
      readSafetyActorPublicKeys(input.env ?? process.env);
      checks.push({
        id: "safety-responder-roster",
        status: "pass",
        summary:
          "Primary/backup on-call, release, safety, evidence, and rollback roles are assigned.",
        evidence: { ...summarizeSafetyRoster(roster, true) },
      });
    } catch {
      checks.push({
        id: "safety-responder-roster",
        status: "block",
        summary:
          "The production-paper safety responder roster is missing, invalid, placeholder-based, or violates role independence.",
        evidence: { complete: false },
      });
    }
  }

  const attestationEnvironment = { ...process.env, ...input.env };
  const attestationReleaseSha = attestationEnvironment.RELEASE_SHA;
  const attestationImageDigest = attestationEnvironment.IMAGE_DIGEST;
  if (directUrl && attestationReleaseSha && attestationImageDigest) {
    try {
      ledgerAttestation = await runLedgerAttestation({
        databaseUrl: directUrl,
        releaseSha: attestationReleaseSha,
        imageDigest: attestationImageDigest,
        configVersion: DEFAULT_STRATEGY_CONFIG.version,
        purpose: "preflight",
        asOf: now,
      });
      checks.push({
        id: "immutable-ledger-attestation",
        status: ledgerAttestation.status === "PASS" ? "pass" : "block",
        summary:
          ledgerAttestation.status === "PASS"
            ? "Immutable paper ledger and anchor state attest exactly."
            : "Immutable paper ledger or anchor state failed deterministic attestation.",
        evidence: {
          checksum: ledgerAttestation.checksum,
          databaseIdentityHash:
            ledgerAttestation.binding.databaseIdentityHash,
          runtimeRole: ledgerAttestation.binding.runtimeRole,
          observedTrades: ledgerAttestation.bounds.observedTrades,
        },
      });
    } catch (error) {
      checks.push({
        id: "immutable-ledger-attestation",
        status: "block",
        summary: "Immutable paper ledger attestation could not run.",
        evidence: { errorCode: errorCode(error) },
      });
    }
  } else {
    checks.push({
      id: "immutable-ledger-attestation",
      status: provider === "azure" ? "block" : "warn",
      summary:
        "RELEASE_SHA and IMAGE_DIGEST are required to bind ledger attestation evidence.",
    });
  }

  const blockers = checks
    .filter((check) => check.status === "block")
    .map((check) => check.id);

  return {
    schemaVersion: DEPLOYMENT_PREFLIGHT_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    provider: provider ?? null,
    target: {
      directUrl: redactPostgresUrl(directUrl),
      runtimeUrl: redactPostgresUrl(runtimeUrl),
      migrationUrl: redactPostgresUrl(migrationUrl),
    },
    checks,
    inventory,
    blockers,
    databasePreflightPassed: !hasBlockingChecks(checks),
    ledgerAttestation,
    manualGatesRemaining: [
      "Create and verify a point-in-time backup.",
      "Record operator approval for the observed state.",
      "Keep rollout mode disabled until target smoke checks pass.",
      "Retain live warning/critical delivery, acknowledgment, escalation, and game-day evidence in issue #76 before #75.",
    ],
  };
}
