import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  hasBlockingChecks,
  parseDeploymentProvider,
  redactPostgresUrl,
  runDeploymentPreflight,
  summarizeAgentState,
} from "@/deployment/preflight";
import postgres from "postgres";

jest.mock("postgres", () => ({
  __esModule: true,
  default: jest.fn(),
}));

const mockedPostgres = jest.mocked(postgres);
const secureSchemaMigration = readFileSync(
  "drizzle/0002_secure_private_schema.sql",
  "utf8",
);
const rolloutModeMigration = readFileSync(
  "drizzle/0005_bind_cron_rollout_mode.sql",
  "utf8",
);
const nullSafeRolloutMigration = readFileSync(
  "drizzle/0006_reject_null_cron_rollout_mode.sql",
  "utf8",
);
const canonicalMigrationRows = [
  ["drizzle/0000_powerful_thundra.sql", "1775960372035"],
  ["drizzle/0001_add_is_operator_paused.sql", "1777757136027"],
  ["drizzle/0002_secure_private_schema.sql", "1784051729303"],
  ["drizzle/0003_expand_ledger.sql", "1784054175971"],
  ["drizzle/0004_restrict_vault_access.sql", "1784074873207"],
  ["drizzle/0005_bind_cron_rollout_mode.sql", "1784123377223"],
  [
    "drizzle/0006_reject_null_cron_rollout_mode.sql",
    "1784174542964",
  ],
  [
    "drizzle/0007_azure_retire_supabase_http_functions.sql",
    "1786579433481",
  ],
].map(([path, createdAt]) => ({
  hash: createHash("sha256")
    .update(readFileSync(path!, "utf8"))
    .digest("hex"),
  createdAt: createdAt!,
}));
const trustBoundaryMigrationRow = {
  hash: createHash("sha256")
    .update(
      readFileSync(
        "drizzle/0008_postgresql_trust_boundaries.sql",
        "utf8",
      ),
    )
    .digest("hex"),
  createdAt: "1786579434481",
};
// drizzleMigrationCount reaches TRUST_BOUNDARY_MIGRATION_COUNT (9) only
// once migration 0008 (drizzle/0008_postgresql_trust_boundaries.sql) has
// been applied.
const trustBoundaryCompleteMigrationRows = [
  ...canonicalMigrationRows,
  trustBoundaryMigrationRow,
];

function installedFunctionSource(
  name: string,
  profile:
    | "null-safe"
    | "mode-bound-nullable"
    | "pre-mode-binding" = "null-safe",
): string {
  const migration =
    profile === "null-safe"
      ? nullSafeRolloutMigration
      : profile === "mode-bound-nullable"
        ? rolloutModeMigration
        : secureSchemaMigration;
  const declaration =
    `CREATE OR REPLACE FUNCTION "krypto"."${name}"()`;
  const functionStart = migration.indexOf(declaration);
  const bodyStart =
    migration.indexOf("AS $$", functionStart) + 5;
  const bodyEnd = migration.indexOf("$$;", bodyStart);
  return migration.slice(bodyStart, bodyEnd);
}

function createSqlMock(
  scenario:
    | "safe"
    | "blocked"
    | "incomplete"
    | "legacy"
    | "public-incomplete"
    | "function-config"
    | "extra-krypto"
    | "missing-history"
    | "migration-drift"
    | "pre-null-rejection"
    | "pre-mode-binding"
    | "pre-vault-migration"
    | "missing-functions"
    | "pending-http"
    | "public-wrapper"
    | "public-exposed"
    | "azure-current"
    | "azure-functions-present"
    | "azure-role-incomplete"
    | "azure-role-excess"
    | "azure-role-excess-future-view"
    | "azure-role-excess-future-relation"
    | "azure-login-not-member"
    | "azure-login-excess"
    | "same-connection-role"
    | "trust-boundary-current"
    | "trust-boundary-role-login-unsafe"
    | "trust-boundary-migrator-inherits"
    | "trust-boundary-runtime-elevated"
    | "trust-boundary-bad-app-schema-owner"
    | "trust-boundary-bad-ledger-owner"
    | "trust-boundary-ledger-access-leak"
    | "trust-boundary-legacy-access-leak"
    | "trust-boundary-public-grant-leak"
    | "trust-boundary-default-privilege-leak"
    | "trust-boundary-public-schema-creatable"
    | "trust-boundary-runtime-public-schema"
    | "trust-boundary-connection-limit-unbounded"
    | "trust-boundary-runtime-login-elevated"
    | "trust-boundary-operator-elevated"
    | "trust-boundary-migrator-create"
    | "trust-boundary-search-path-unsafe" = "safe",
  systemIdentifier = "7123456789012345678",
) {
  const RUNTIME_LOGIN_CURRENT_USER = "azure_app_identity";
  const isTrustBoundaryScenario = scenario.startsWith("trust-boundary");
  const trustBoundaryRoleRows = !isTrustBoundaryScenario
    ? []
    : [
        {
          rolname: "krypto_schema_owner",
          canLogin: scenario === "trust-boundary-role-login-unsafe",
          inherits: true,
          connectionLimit: 0,
        },
        {
          rolname: "krypto_migrator",
          canLogin: true,
          inherits: scenario === "trust-boundary-migrator-inherits",
          connectionLimit:
            scenario === "trust-boundary-connection-limit-unbounded" ? -1 : 5,
        },
        {
          rolname: "krypto_scheduler",
          canLogin: false,
          inherits: true,
          connectionLimit: 0,
        },
        {
          rolname: "krypto_runtime",
          canLogin: false,
          inherits: true,
          connectionLimit: 0,
        },
        {
          rolname: RUNTIME_LOGIN_CURRENT_USER,
          canLogin: true,
          inherits: true,
          connectionLimit: 20,
        },
      ];
  const trustBoundaryMigratorMembershipRows = !isTrustBoundaryScenario
    ? []
    : [
        {
          adminOption: false,
          inheritOption: scenario === "trust-boundary-migrator-inherits",
          setOption: true,
        },
      ];
  const trustBoundaryRuntimeElevatedMembership = !isTrustBoundaryScenario
    ? { ownerMember: null, migratorMember: null, schedulerMember: null }
    : {
        ownerMember: scenario === "trust-boundary-runtime-elevated",
        migratorMember: false,
        schedulerMember: false,
      };
  const trustBoundaryAppSchemaOwner = !isTrustBoundaryScenario
    ? "postgres"
    : scenario === "trust-boundary-bad-app-schema-owner"
      ? "postgres"
      : "krypto_schema_owner";
  const trustBoundaryAppSchemaBadOwnerCount = 0;
  const trustBoundaryMigrationLedgerOwner = !isTrustBoundaryScenario
    ? "postgres"
    : scenario === "trust-boundary-bad-ledger-owner"
      ? "postgres"
      : "krypto_migrator";
  const trustBoundaryRuntimeLedgerAccess =
    scenario === "trust-boundary-ledger-access-leak";
  const trustBoundaryLegacySchemaAccess =
    scenario === "trust-boundary-legacy-access-leak";
  const trustBoundaryRuntimePublicGrants =
    scenario === "trust-boundary-public-grant-leak"
      ? [{ name: "table:krypto_state_mirror" }]
      : [];
  const trustBoundaryPublicSchemaCreatable =
    scenario === "trust-boundary-public-schema-creatable";
  const trustBoundaryDefaultAclLeaks =
    scenario === "trust-boundary-default-privilege-leak"
      ? [
          {
            defaclRole: "krypto_schema_owner",
            objType: "r",
            grantee: "PUBLIC",
          },
        ]
      : [];
  const trustBoundarySearchPath =
    scenario === "trust-boundary-search-path-unsafe"
      ? '"$user", public'
      : "pg_catalog";
  const CORRECT_TABLE_PRIVILEGE_ROWS: Record<
    string,
    {
      hasSelect: boolean;
      hasInsert: boolean;
      hasUpdate: boolean;
      hasDelete: boolean;
      hasTruncate: boolean;
      hasTrigger: boolean;
      hasReferences: boolean;
    }
  > = {
    AgentState: {
      hasSelect: true,
      hasInsert: false,
      hasUpdate: true,
      hasDelete: false,
      hasTruncate: false,
      hasTrigger: false,
      hasReferences: false,
    },
    AgentRun: {
      hasSelect: true,
      hasInsert: true,
      hasUpdate: true,
      hasDelete: false,
      hasTruncate: false,
      hasTrigger: false,
      hasReferences: false,
    },
    TradeExecution: {
      hasSelect: true,
      hasInsert: true,
      hasUpdate: false,
      hasDelete: false,
      hasTruncate: false,
      hasTrigger: false,
      hasReferences: false,
    },
    AgentJournal: {
      hasSelect: true,
      hasInsert: true,
      hasUpdate: false,
      hasDelete: false,
      hasTruncate: false,
      hasTrigger: false,
      hasReferences: false,
    },
  };
  function tablePrivilegeRows(roleName: unknown) {
    const rows = Object.entries(CORRECT_TABLE_PRIVILEGE_ROWS).map(
      ([name, privileges]) => ({ name, ...privileges }),
    );
    if (scenario === "azure-role-incomplete" && roleName === "krypto_runtime") {
      // TradeExecution is missing its required INSERT privilege.
      return rows.map((row) =>
        row.name === "TradeExecution"
          ? { ...row, hasInsert: false }
          : row,
      );
    }
    if (scenario === "azure-role-excess" && roleName === "krypto_runtime") {
      // TradeExecution unexpectedly also has UPDATE (not in the matrix).
      return rows.map((row) =>
        row.name === "TradeExecution" ? { ...row, hasUpdate: true } : row,
      );
    }
    if (
      scenario === "azure-role-excess-future-view" &&
      roleName === "krypto_runtime"
    ) {
      // A future reporting view — not in RUNTIME_TABLE_PRIVILEGE_MATRIX at
      // all — unexpectedly carries a granted SELECT. Before extending the
      // scan to relkind 'v' this would never have appeared in the scan
      // results at all (neither missing nor excess); it must now surface
      // as excess.
      return [
        ...rows,
        {
          name: "TradeExecutionSummaryView",
          hasSelect: true,
          hasInsert: false,
          hasUpdate: false,
          hasDelete: false,
          hasTruncate: false,
          hasTrigger: false,
          hasReferences: false,
        },
      ];
    }
    if (
      scenario === "azure-role-excess-future-relation" &&
      roleName === "krypto_runtime"
    ) {
      // A future partitioned parent table (relkind 'p') and a future
      // foreign table (relkind 'f') — again absent from the matrix —
      // unexpectedly carry granted privileges (INSERT and SELECT
      // respectively). Both relkinds were previously invisible to a scan
      // scoped only to relkind = 'r'.
      return [
        ...rows,
        {
          name: "TradeExecutionArchive",
          hasSelect: false,
          hasInsert: true,
          hasUpdate: false,
          hasDelete: false,
          hasTruncate: false,
          hasTrigger: false,
          hasReferences: false,
        },
        {
          name: "ExternalMarketDataFeed",
          hasSelect: true,
          hasInsert: false,
          hasUpdate: false,
          hasDelete: false,
          hasTruncate: false,
          hasTrigger: false,
          hasReferences: false,
        },
      ];
    }
    if (
      scenario === "azure-login-excess" &&
      roleName === RUNTIME_LOGIN_CURRENT_USER
    ) {
      // The login role (inherited via membership) has an excess DELETE.
      return rows.map((row) =>
        row.name === "AgentJournal" ? { ...row, hasDelete: true } : row,
      );
    }
    return rows;
  }
  const sql = jest.fn(
    async (
      first: TemplateStringsArray | string,
      ...values: unknown[]
    ): Promise<unknown> => {
      if (typeof first === "string") {
        return { identifier: first };
      }
      const query = Array.from(first).join(" ").replace(/\s+/g, " ").trim();
      if (
        query === "BEGIN READ ONLY" ||
        query.startsWith("SET LOCAL statement_timeout") ||
        query === "ROLLBACK"
      ) {
        return [];
      }
      if (query.includes("current_database() AS database")) {
        const isDirectConnection = query.includes("server_version");
        const sameRole = scenario === "same-connection-role";
        return [
          {
            database: "krypto",
            serverVersion: "14.15",
            systemIdentifier,
            currentUser: isDirectConnection
              ? "krypto_migrator"
              : sameRole
                ? "krypto_migrator"
                : RUNTIME_LOGIN_CURRENT_USER,
            sessionUser: isDirectConnection
              ? "krypto_owner"
              : RUNTIME_LOGIN_CURRENT_USER,
            searchPath: isDirectConnection
              ? trustBoundarySearchPath
              : scenario === "trust-boundary-search-path-unsafe"
                ? '"$user", public'
                : "krypto, pg_catalog",
          },
        ];
      }
      if (query.includes("krypto_runtime role inventory")) {
        const present =
          scenario === "azure-current" ||
          scenario === "azure-functions-present" ||
          scenario === "azure-role-incomplete" ||
          scenario === "azure-role-excess" ||
          scenario === "azure-role-excess-future-view" ||
          scenario === "azure-role-excess-future-relation" ||
          scenario === "azure-login-not-member" ||
          scenario === "azure-login-excess" ||
          scenario === "same-connection-role";
        return [
          {
            present,
            isGroupRole: present,
            schemaUsage: present,
          },
        ];
      }
      if (query.includes("runtime role table privilege scan")) {
        return tablePrivilegeRows(values[0]);
      }
      if (query.includes("runtime role sequence privilege scan")) {
        // The krypto schema has no sequences; nothing to report either way.
        return [];
      }
      if (query.includes("runtime login role membership check")) {
        return [
          { isMember: scenario !== "azure-login-not-member" },
        ];
      }
      if (query.includes("FROM pg_tables")) {
        const tables = [
          { schemaName: "krypto", tableName: "AgentJournal" },
          { schemaName: "krypto", tableName: "AgentRun" },
          { schemaName: "krypto", tableName: "AgentState" },
          { schemaName: "krypto", tableName: "TradeExecution" },
        ];
        if (scenario === "incomplete") {
          return tables.filter((table) => table.tableName !== "AgentRun");
        }
        if (scenario === "legacy") {
          return [
            { schemaName: "public", tableName: "AgentJournal" },
            { schemaName: "public", tableName: "AgentState" },
            { schemaName: "public", tableName: "TradeExecution" },
          ];
        }
        if (scenario === "public-incomplete") {
          return [{ schemaName: "public", tableName: "AgentState" }];
        }
        return scenario === "blocked"
          ? [
              ...tables,
              { schemaName: "public", tableName: "AgentState" },
            ]
          : tables;
      }
      if (
        query.includes("SELECT nspname AS schema") &&
        query.includes("nspname IN ('krypto', 'vault')")
      ) {
        return [{ schema: "krypto" }];
      }
      if (query.includes("relation.relkind::text AS kind")) {
        const relations = [
          { schema: "krypto", name: "AgentJournal", kind: "r" },
          { schema: "krypto", name: "AgentRun", kind: "r" },
          { schema: "krypto", name: "AgentState", kind: "r" },
          { schema: "krypto", name: "TradeExecution", kind: "r" },
        ];
        if (scenario === "legacy" || scenario === "public-incomplete") {
          return [];
        }
        return scenario === "extra-krypto"
          ? [
              ...relations,
              { schema: "krypto", name: "exposed_data", kind: "r" },
            ]
          : scenario === "incomplete"
            ? relations.filter((relation) => relation.name !== "AgentRun")
            : relations;
      }
      if (query.includes("WITH RECURSIVE protected_relation")) {
        return scenario === "public-wrapper"
          ? [{ name: "krypto_state_exposed" }]
          : [];
      }
      if (query.includes("to_jsonb(state_row)")) {
        return [
          {
            state: {
              currentPositionETHDecimal:
                scenario === "blocked" ? "0.25" : "0",
              currentPositionUSDCDecimal: "200",
              portfolioValueUSDDecimal: "200",
              accountingStatus:
                scenario === "blocked" ? "QUARANTINED" : "RECONCILED",
              isLocked: scenario === "blocked",
              isOperatorPaused: false,
              isRunning: scenario === "blocked",
              leaseOwner: scenario === "blocked" ? "active-run" : null,
              leaseExpiresAt:
                scenario === "blocked"
                  ? new Date("2026-07-14T23:00:00.000Z")
                  : null,
            },
          },
        ];
      }
      if (query.includes("drizzle.__drizzle_migrations")) {
        if (query.includes("to_regclass")) {
          return [
            {
              relation:
                scenario === "blocked" ||
                scenario === "missing-history"
                  ? null
                  : "drizzle.__drizzle_migrations",
            },
          ];
        }
        const migrations =
          scenario === "legacy"
            ? canonicalMigrationRows.slice(0, 2)
            : scenario === "pre-vault-migration"
              ? canonicalMigrationRows.slice(0, 4)
              : scenario === "pre-mode-binding"
                ? canonicalMigrationRows.slice(0, 5)
                : scenario === "pre-null-rejection"
                  ? canonicalMigrationRows.slice(0, 6)
                : scenario === "azure-current" ||
                    scenario === "azure-functions-present" ||
                    scenario === "azure-role-incomplete"
                  ? canonicalMigrationRows
                  : scenario.startsWith("trust-boundary")
                    ? trustBoundaryCompleteMigrationRows
                    : canonicalMigrationRows.slice(0, 7);
        return scenario === "migration-drift"
          ? [
              {
                ...migrations[0],
                hash: "tampered",
              },
              ...migrations.slice(1),
            ]
          : migrations;
      }
      if (query.includes("supabase_migrations.schema_migrations")) {
        return query.includes("to_regclass")
          ? [
              {
                relation:
                  scenario === "blocked"
                    ? null
                    : "supabase_migrations.schema_migrations",
              },
            ]
          : [{ count: "2" }];
      }
      if (query.includes("to_regclass('cron.job')")) {
        return [{ relation: "cron.job" }];
      }
      if (query.includes("FROM cron.job")) {
        return scenario === "blocked"
          ? [
              {
                jobName: "krypto-agent-run-hourly",
                schedule: "0 * * * *",
                active: true,
              },
            ]
          : [];
      }
      if (query.includes("to_regclass( 'net.http_request_queue' )")) {
        return [{ relation: "net.http_request_queue" }];
      }
      if (query.includes("FROM net.http_request_queue")) {
        return [{ count: scenario === "pending-http" ? "1" : "0" }];
      }
      if (query.includes("p.prosrc AS source")) {
        if (
          scenario === "missing-functions" ||
          scenario === "azure-current" ||
          scenario === "azure-role-incomplete"
        ) {
          return [];
        }
        return [
          {
            name: "invoke_agent_run",
            securityDefiner: true,
            language: "plpgsql",
            ownerMatches: true,
            configuration:
              scenario === "function-config"
                ? [
                    "search_path=pg_catalog",
                    "statement_timeout=1ms",
                  ]
                : ["search_path=pg_catalog"],
            source:
              scenario === "blocked"
                ? "unsafe"
                : installedFunctionSource(
                    "invoke_agent_run",
                    scenario === "pre-null-rejection"
                      ? "mode-bound-nullable"
                      : [
                            "pre-vault-migration",
                            "pre-mode-binding",
                          ].includes(scenario)
                        ? "pre-mode-binding"
                        : "null-safe",
                  ),
            resultType: "bigint",
          },
          {
            name: "invoke_daily_summary",
            securityDefiner: true,
            language: "plpgsql",
            ownerMatches: true,
            configuration: ["search_path=pg_catalog"],
            source: installedFunctionSource(
              "invoke_daily_summary",
              scenario === "pre-null-rejection"
                ? "mode-bound-nullable"
                : [
                      "pre-vault-migration",
                      "pre-mode-binding",
                    ].includes(scenario)
                  ? "pre-mode-binding"
                  : "null-safe",
            ),
            resultType: "bigint",
          },
        ];
      }
      if (
        query.includes(
          "public.krypto_invoke_endpoint(text)",
        )
      ) {
        return [
          {
            present: scenario === "blocked",
          },
        ];
      }
      if (query.includes("migration connection identity")) {
        return [
          {
            currentUser:
              scenario === "same-connection-role"
                ? "krypto_runtime"
                : "krypto_migrator",
            sessionUser: "krypto_migrator",
            searchPath: trustBoundarySearchPath,
          },
        ];
      }
      if (query.includes("trust boundary role attributes")) {
        return trustBoundaryRoleRows;
      }
      if (query.includes("trust boundary migrator membership options")) {
        return trustBoundaryMigratorMembershipRows;
      }
      if (query.includes("trust boundary runtime elevated membership")) {
        return [
          {
            ownerMember: trustBoundaryRuntimeElevatedMembership.ownerMember,
            migratorMember: trustBoundaryRuntimeElevatedMembership.migratorMember,
            schedulerMember: trustBoundaryRuntimeElevatedMembership.schedulerMember,
          },
        ];
      }
      if (query.includes("trust boundary explicit login memberships")) {
        return [
          {
            runtimeLoginElevated:
              scenario === "trust-boundary-runtime-login-elevated",
            operatorElevated: scenario === "trust-boundary-operator-elevated",
          },
        ];
      }
      if (query.includes("trust boundary app schema owner")) {
        return [{ owner: trustBoundaryAppSchemaOwner }];
      }
      if (query.includes("trust boundary app schema bad owner count")) {
        return [{ badOwnerCount: trustBoundaryAppSchemaBadOwnerCount }];
      }
      if (query.includes("trust boundary migration ledger owner")) {
        return [{ owner: trustBoundaryMigrationLedgerOwner }];
      }
      if (query.includes("trust boundary runtime migration ledger access")) {
        return [{ hasAccess: trustBoundaryRuntimeLedgerAccess }];
      }
      if (query.includes("trust boundary legacy schema access")) {
        return [{ hasAccess: trustBoundaryLegacySchemaAccess }];
      }
      if (query.includes("trust boundary runtime public object grants")) {
        return trustBoundaryRuntimePublicGrants;
      }
      if (query.includes("trust boundary public schema create")) {
        return [{ creatable: trustBoundaryPublicSchemaCreatable }];
      }
      if (query.includes("trust boundary runtime public schema access")) {
        return [
          {
            hasAccess: scenario === "trust-boundary-runtime-public-schema",
          },
        ];
      }
      if (query.includes("trust boundary migrator create privileges")) {
        return [
          {
            databaseCreate: true,
            publicCreate: scenario === "trust-boundary-migrator-create",
          },
        ];
      }
      if (query.includes("trust boundary default privilege leaks")) {
        return trustBoundaryDefaultAclLeaks;
      }
      if (query.includes("trust boundary search path")) {
        return [{ searchPath: trustBoundarySearchPath }];
      }
      if (query.includes("FROM pg_roles")) {
        return [{ role: "anon" }, { role: "authenticated" }];
      }
      if (query.includes("has_schema_privilege")) {
        return [
          {
            kryptoUsage: scenario === "blocked",
            kryptoCreate: scenario === "blocked",
            vaultUsage: scenario === "blocked",
            vaultCreate: scenario === "blocked",
          },
        ];
      }
      if (query.includes("has_sequence_privilege")) {
        if (scenario === "public-wrapper") {
          return [
            { schema: "public", name: "krypto_state_exposed" },
          ];
        }
        return scenario === "blocked"
          ? [
              { schema: "krypto", name: "AgentState" },
              { schema: "vault", name: "secrets" },
            ]
          : [];
      }
      if (query.includes("WITH public_privileges")) {
        return scenario === "public-exposed"
          ? [
              {
                objectType: "schema",
                objectName: "krypto",
                privilege: "USAGE",
              },
              {
                objectType: "table",
                objectName: "krypto.AgentState",
                privilege: "SELECT",
              },
              {
                objectType: "function",
                objectName: "krypto.invoke_agent_run()",
                privilege: "EXECUTE",
              },
              {
                objectType: "vault",
                objectName: "vault.decrypted_secrets",
                privilege: "SELECT",
              },
            ]
          : [];
      }
      if (query.includes("pg_get_function_identity_arguments")) {
        if (scenario === "public-wrapper") {
          return [
            {
              schema: "public",
              name: "public.read_vault_secret()",
            },
          ];
        }
        return scenario === "blocked"
          ? [
              {
                schema: "krypto",
                name: "krypto.invoke_agent_run()",
              },
              { schema: "vault", name: "vault.read_secret()" },
            ]
          : [];
      }
      if (query.includes("to_regclass('vault.secrets')")) {
        return [
          {
            relation:
              scenario === "blocked" || scenario === "azure-current"
                ? null
                : "vault.secrets",
          },
        ];
      }
      if (query.includes("FROM vault.secrets")) {
        return [
          { name: "krypto_cron_secret" },
          { name: "krypto_rollout_mode" },
          { name: "krypto_vercel_url" },
        ];
      }
      if (query.includes("SELECT count(*)::text AS count")) {
        return [{ count: "1" }];
      }
      throw new Error(`Unhandled SQL in test: ${query}`);
    },
  ) as jest.Mock & { end: jest.Mock; array: jest.Mock };
  sql.end = jest.fn(async () => undefined);
  // postgres.js's real `sql.array(...)` helper wraps a JS array as a bound
  // array parameter; this mock only ever inspects the tagged template's
  // string parts (never its interpolated values) to decide how to
  // respond, so a passthrough stub is sufficient — it just needs to exist
  // and not throw, since `sql.array(...)` is evaluated as a plain JS
  // expression before the tagged template call happens.
  sql.array = jest.fn((value: unknown) => value);
  return sql;
}

describe("deployment preflight helpers", () => {
  beforeEach(() => {
    mockedPostgres.mockReset();
  });

  it("redacts credentials and query parameters from database URLs", () => {
    expect(
      redactPostgresUrl(
        "postgresql://user:secret@db.example.com:5432/postgres?sslmode=require",
      ),
    ).toBe(
      "postgresql://%5Bredacted%5D:%5Bredacted%5D@db.example.com:5432/postgres",
    );
    expect(redactPostgresUrl(undefined)).toBeNull();
    expect(redactPostgresUrl("not-a-url")).toBe("[invalid-url]");
  });

  it("summarizes numeric and legacy account state without copying raw data", () => {
    expect(
      summarizeAgentState("krypto", {
        currentPositionETHDecimal: "0.125000000000000000",
        currentPositionUSDCDecimal: "175.00000000",
        portfolioValueUSDDecimal: "205.00000000",
        accountingStatus: "RECONCILED",
        isLocked: false,
        isOperatorPaused: true,
        isRunning: false,
        leaseOwner: null,
        leaseExpiresAt: null,
        strategySnapshot: { ignored: true },
      }),
    ).toEqual({
      schema: "krypto",
      present: true,
      ethBalance: "0.125000000000000000",
      usdcBalance: "175.00000000",
      portfolioValueUSD: "205.00000000",
      accountingStatus: "RECONCILED",
      isLocked: false,
      isOperatorPaused: true,
      isRunning: false,
      leaseOwned: false,
      leaseExpiresAt: null,
    });
  });

  it("detects blocking checks", () => {
    expect(
      hasBlockingChecks([
        { id: "one", status: "pass", summary: "ok" },
        { id: "two", status: "warn", summary: "review" },
      ]),
    ).toBe(false);
    expect(
      hasBlockingChecks([
        { id: "one", status: "block", summary: "stop" },
      ]),
    ).toBe(true);
  });

  it("builds a passing report from a complete read-only inventory", async () => {
    const runtimeSql = createSqlMock();
    const directSql = createSqlMock();
    mockedPostgres
      .mockReturnValueOnce(runtimeSql as never)
      .mockReturnValueOnce(directSql as never);

    const report = await runDeploymentPreflight({
      directUrl:
        "postgresql://operator:secret@db.example.com:5432/postgres?sslmode=require",
      runtimeUrl:
        "postgresql://operator:secret@pooler.example.com:6543/postgres?pgbouncer=true",
      now: new Date("2026-07-14T22:00:00.000Z"),
    });

    expect(report.blockers).toEqual([]);
    expect(report.databasePreflightPassed).toBe(true);
    expect(report.inventory.database).toBe("krypto");
    expect(report.inventory.drizzleMigrationCount).toBe(7);
    expect(report.inventory.supabaseMigrationCount).toBe(2);
    expect(report.inventory.openPaperPosition).toBe(false);
    expect(report.inventory.restrictedRolePrivileges).toHaveLength(2);
    expect(report.inventory.vaultSecretNames).toEqual([
      "krypto_cron_secret",
      "krypto_rollout_mode",
      "krypto_vercel_url",
    ]);
    expect(runtimeSql.end).toHaveBeenCalled();
    expect(directSql.end).toHaveBeenCalled();
  });

  it("classifies unsafe legacy state as blocking without mutating it", async () => {
    const runtimeSql = createSqlMock();
    const directSql = createSqlMock("blocked");
    mockedPostgres
      .mockReturnValueOnce(runtimeSql as never)
      .mockReturnValueOnce(directSql as never);

    const report = await runDeploymentPreflight({
      directUrl: "postgresql://operator:secret@db.example.com/postgres",
      runtimeUrl: "postgresql://operator:secret@pooler.example.com/postgres",
    });

    expect(report.databasePreflightPassed).toBe(false);
    expect(report.blockers).toEqual(
      expect.arrayContaining([
        "schema-layout",
        "open-position",
        "run-lease",
        "accounting-state",
        "cron-state",
        "legacy-arbitrary-function",
        "restricted-role-privileges",
      ]),
    );
    expect(report.inventory.openPaperPosition).toBe(true);
    expect(report.inventory.legacyArbitraryFunction).toBe(true);
    expect(report.inventory.drizzleMigrationCount).toBeNull();
    expect(report.inventory.vaultSecretNames).toEqual([]);
  });

  it("reports missing connection URLs before attempting database access", async () => {
    const report = await runDeploymentPreflight({});

    expect(report.blockers).toEqual(["direct-url", "runtime-url"]);
    expect(mockedPostgres).not.toHaveBeenCalled();
  });

  it("blocks runtime and direct URLs that identify different clusters", async () => {
    mockedPostgres
      .mockReturnValueOnce(
        createSqlMock("safe", "runtime-cluster") as never,
      )
      .mockReturnValueOnce(
        createSqlMock("safe", "direct-cluster") as never,
      );

    const report = await runDeploymentPreflight({
      directUrl: "postgresql://operator:secret@db.example.com/postgres",
      runtimeUrl: "postgresql://operator:secret@pooler.example.com/postgres",
    });

    expect(report.blockers).toContain("database-target-match");
  });

  it("blocks an incomplete private application schema", async () => {
    mockedPostgres
      .mockReturnValueOnce(createSqlMock("safe") as never)
      .mockReturnValueOnce(createSqlMock("incomplete") as never);

    const report = await runDeploymentPreflight({
      directUrl: "postgresql://operator:secret@db.example.com/postgres",
      runtimeUrl: "postgresql://operator:secret@pooler.example.com/postgres",
    });

    expect(report.blockers).toContain("schema-layout");
  });

  it("blocks privileges granted through PUBLIC", async () => {
    mockedPostgres
      .mockReturnValueOnce(createSqlMock("safe") as never)
      .mockReturnValueOnce(createSqlMock("public-exposed") as never);

    const report = await runDeploymentPreflight({
      directUrl: "postgresql://operator:secret@db.example.com/postgres",
      runtimeUrl: "postgresql://operator:secret@pooler.example.com/postgres",
    });

    expect(report.blockers).toContain("restricted-role-privileges");
    expect(report.inventory.restrictedRolePrivileges).toContainEqual({
      role: "PUBLIC",
      schemaUsage: true,
      schemaCreate: false,
      exposedTables: ["krypto.AgentState"],
      executableFunctions: ["krypto.invoke_agent_run()"],
      vaultObjects: ["vault.decrypted_secrets"],
      vaultAccess: true,
    });
  });

  it("accepts only the complete three-table legacy public layout", async () => {
    mockedPostgres
      .mockReturnValueOnce(createSqlMock("safe") as never)
      .mockReturnValueOnce(createSqlMock("legacy") as never);

    const report = await runDeploymentPreflight({
      directUrl: "postgresql://operator:secret@db.example.com/postgres",
      runtimeUrl: "postgresql://operator:secret@pooler.example.com/postgres",
    });

    expect(report.blockers).not.toContain("schema-layout");
    expect(report.blockers).not.toContain(
      "migration-schema-consistency",
    );
    expect(
      report.checks.find((check) => check.id === "schema-layout"),
    ).toEqual(expect.objectContaining({ status: "warn" }));
  });

  it("blocks an incomplete legacy public schema", async () => {
    mockedPostgres
      .mockReturnValueOnce(createSqlMock("safe") as never)
      .mockReturnValueOnce(createSqlMock("public-incomplete") as never);

    const report = await runDeploymentPreflight({
      directUrl: "postgresql://operator:secret@db.example.com/postgres",
      runtimeUrl: "postgresql://operator:secret@pooler.example.com/postgres",
    });

    expect(report.blockers).toContain("schema-layout");
  });

  it("blocks additional fixed-function settings", async () => {
    mockedPostgres
      .mockReturnValueOnce(createSqlMock("safe") as never)
      .mockReturnValueOnce(createSqlMock("function-config") as never);

    const report = await runDeploymentPreflight({
      directUrl: "postgresql://operator:secret@db.example.com/postgres",
      runtimeUrl: "postgresql://operator:secret@pooler.example.com/postgres",
    });

    expect(report.blockers).toContain(
      "fixed-cron-function-integrity",
    );
  });

  it("blocks extra relations in the private schema", async () => {
    mockedPostgres
      .mockReturnValueOnce(createSqlMock("safe") as never)
      .mockReturnValueOnce(createSqlMock("extra-krypto") as never);

    const report = await runDeploymentPreflight({
      directUrl: "postgresql://operator:secret@db.example.com/postgres",
      runtimeUrl: "postgresql://operator:secret@pooler.example.com/postgres",
    });

    expect(report.blockers).toContain("schema-layout");
  });

  it("blocks a private layout without Drizzle history", async () => {
    mockedPostgres
      .mockReturnValueOnce(createSqlMock("safe") as never)
      .mockReturnValueOnce(createSqlMock("missing-history") as never);

    const report = await runDeploymentPreflight({
      directUrl: "postgresql://operator:secret@db.example.com/postgres",
      runtimeUrl: "postgresql://operator:secret@pooler.example.com/postgres",
    });

    expect(report.blockers).toContain("drizzle-history");
  });

  it("blocks migration hashes that differ from the reviewed history", async () => {
    mockedPostgres
      .mockReturnValueOnce(createSqlMock("safe") as never)
      .mockReturnValueOnce(createSqlMock("migration-drift") as never);

    const report = await runDeploymentPreflight({
      directUrl: "postgresql://operator:secret@db.example.com/postgres",
      runtimeUrl: "postgresql://operator:secret@pooler.example.com/postgres",
    });

    expect(report.blockers).toContain("drizzle-history-integrity");
  });

  it("recognizes the exact pre-Vault-hardening migration prefix", async () => {
    mockedPostgres
      .mockReturnValueOnce(createSqlMock("safe") as never)
      .mockReturnValueOnce(
        createSqlMock("pre-vault-migration") as never,
      );

    const report = await runDeploymentPreflight({
      directUrl: "postgresql://operator:secret@db.example.com/postgres",
      runtimeUrl: "postgresql://operator:secret@pooler.example.com/postgres",
    });

    expect(report.blockers).not.toContain("drizzle-history-integrity");
    expect(report.blockers).not.toContain(
      "migration-schema-consistency",
    );
    expect(
      report.checks.find((check) => check.id === "migration-current"),
    ).toEqual(expect.objectContaining({ status: "warn" }));
  });

  it("recognizes canonical functions before mode binding is applied", async () => {
    mockedPostgres
      .mockReturnValueOnce(createSqlMock("safe") as never)
      .mockReturnValueOnce(
        createSqlMock("pre-mode-binding") as never,
      );

    const report = await runDeploymentPreflight({
      directUrl: "******db.example.com/postgres",
      runtimeUrl: "******pooler.example.com/postgres",
    });

    expect(report.blockers).not.toContain(
      "fixed-cron-function-integrity",
    );
    expect(
      report.checks.find((check) => check.id === "migration-current"),
    ).toEqual(expect.objectContaining({ status: "warn" }));
  });

  it("recognizes the original 0005 prefix before NULL rejection is applied", async () => {
    mockedPostgres
      .mockReturnValueOnce(createSqlMock("safe") as never)
      .mockReturnValueOnce(
        createSqlMock("pre-null-rejection") as never,
      );

    const report = await runDeploymentPreflight({
      directUrl: "******db.example.com/postgres",
      runtimeUrl: "******pooler.example.com/postgres",
    });

    expect(report.blockers).not.toContain(
      "drizzle-history-integrity",
    );
    expect(report.blockers).not.toContain(
      "fixed-cron-function-integrity",
    );
    expect(
      report.checks.find((check) => check.id === "migration-current"),
    ).toEqual(expect.objectContaining({ status: "warn" }));
  });

  it("blocks public views and security-definer routines that expose protected data", async () => {
    mockedPostgres
      .mockReturnValueOnce(createSqlMock("safe") as never)
      .mockReturnValueOnce(createSqlMock("public-wrapper") as never);

    const report = await runDeploymentPreflight({
      directUrl: "postgresql://operator:secret@db.example.com/postgres",
      runtimeUrl: "postgresql://operator:secret@pooler.example.com/postgres",
    });

    expect(report.blockers).toContain("restricted-role-privileges");
    expect(report.inventory.protectedPublicViews).toEqual([
      "krypto_state_exposed",
    ]);
  });

  it("blocks missing fixed functions after their migration is applied", async () => {
    mockedPostgres
      .mockReturnValueOnce(createSqlMock("safe") as never)
      .mockReturnValueOnce(createSqlMock("missing-functions") as never);

    const report = await runDeploymentPreflight({
      directUrl: "postgresql://operator:secret@db.example.com/postgres",
      runtimeUrl: "postgresql://operator:secret@pooler.example.com/postgres",
    });

    expect(report.blockers).toEqual(
      expect.arrayContaining([
        "fixed-cron-functions",
        "fixed-cron-function-integrity",
      ]),
    );
  });

  it("blocks queued Krypto HTTP requests", async () => {
    mockedPostgres
      .mockReturnValueOnce(createSqlMock("safe") as never)
      .mockReturnValueOnce(createSqlMock("pending-http") as never);

    const report = await runDeploymentPreflight({
      directUrl: "******db.example.com/postgres",
      runtimeUrl: "******pooler.example.com/postgres",
    });

    expect(report.blockers).toContain("pending-http-requests");
    expect(report.inventory.pendingKryptoHttpRequests).toBe(1);
  });

  it("parses an explicit deployment provider without silent fallback", () => {
    expect(parseDeploymentProvider(undefined)).toBeUndefined();
    expect(parseDeploymentProvider("")).toBeUndefined();
    expect(parseDeploymentProvider("azure")).toBe("azure");
    expect(parseDeploymentProvider("AZURE")).toBe("azure");
    expect(parseDeploymentProvider("supabase")).toBe("supabase");
    expect(() => parseDeploymentProvider("aws")).toThrow(
      /unknown deployment provider/i,
    );
  });

  it("passes a fully current Azure target with the obsolete cron functions retired", async () => {
    mockedPostgres
      .mockReturnValueOnce(createSqlMock("safe") as never)
      .mockReturnValueOnce(createSqlMock("azure-current") as never);

    const report = await runDeploymentPreflight({
      directUrl: "******db.example.com/postgres",
      runtimeUrl: "******pooler.example.com/postgres",
      provider: "azure",
    });

    expect(report.provider).toBe("azure");
    expect(report.databasePreflightPassed).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(report.inventory.drizzleMigrationCount).toBe(8);
    expect(report.inventory.fixedFunctions.agentRun).toBe(false);
    expect(report.inventory.fixedFunctions.dailySummary).toBe(false);
    expect(report.inventory.runtimeRole).toEqual(
      expect.objectContaining({
        name: "krypto_runtime",
        present: true,
        isGroupRole: true,
        schemaUsage: true,
        missingTablePrivileges: [],
        missingSequencePrivileges: [],
      }),
    );
    expect(
      report.checks.find(
        (check) => check.id === "azure-legacy-cron-functions-retired",
      ),
    ).toEqual(expect.objectContaining({ status: "pass" }));
    expect(
      report.checks.find((check) => check.id === "runtime-role"),
    ).toEqual(expect.objectContaining({ status: "pass" }));
    const vaultCheck = report.checks.find(
      (check) => check.id === "vault-secrets",
    );
    expect(vaultCheck).toEqual(
      expect.objectContaining({
        status: "pass",
        summary: expect.stringMatching(/not part of the azure target/i),
      }),
    );
  });

  it("treats the same absent-vault data as a warning off of Azure", async () => {
    mockedPostgres
      .mockReturnValueOnce(createSqlMock("safe") as never)
      .mockReturnValueOnce(createSqlMock("azure-current") as never);

    const report = await runDeploymentPreflight({
      directUrl: "******db.example.com/postgres",
      runtimeUrl: "******pooler.example.com/postgres",
    });

    expect(report.provider).toBeNull();
    expect(
      report.checks.find((check) => check.id === "vault-secrets"),
    ).toEqual(expect.objectContaining({ status: "warn" }));
  });

  it("warns when an Azure target has not yet reached the retirement migration", async () => {
    mockedPostgres
      .mockReturnValueOnce(createSqlMock("safe") as never)
      .mockReturnValueOnce(createSqlMock("safe") as never);

    const report = await runDeploymentPreflight({
      directUrl: "******db.example.com/postgres",
      runtimeUrl: "******pooler.example.com/postgres",
      provider: "azure",
    });

    expect(report.provider).toBe("azure");
    expect(
      report.checks.find(
        (check) => check.id === "azure-legacy-cron-functions-retired",
      ),
    ).toEqual(expect.objectContaining({ status: "warn" }));
    expect(report.blockers).not.toContain(
      "azure-legacy-cron-functions-retired",
    );
  });

  it("blocks an Azure target whose migration history is current but still retains the obsolete cron functions", async () => {
    mockedPostgres
      .mockReturnValueOnce(createSqlMock("safe") as never)
      .mockReturnValueOnce(
        createSqlMock("azure-functions-present") as never,
      );

    const report = await runDeploymentPreflight({
      directUrl: "******db.example.com/postgres",
      runtimeUrl: "******pooler.example.com/postgres",
      provider: "azure",
    });

    expect(report.databasePreflightPassed).toBe(false);
    expect(report.blockers).toEqual(
      expect.arrayContaining([
        "azure-legacy-cron-functions-retired",
        "fixed-cron-functions",
        "fixed-cron-function-integrity",
      ]),
    );
  });

  it("blocks a runtime role that is present but missing required table privileges", async () => {
    mockedPostgres
      .mockReturnValueOnce(createSqlMock("safe") as never)
      .mockReturnValueOnce(
        createSqlMock("azure-role-incomplete") as never,
      );

    const report = await runDeploymentPreflight({
      directUrl: "******db.example.com/postgres",
      runtimeUrl: "******pooler.example.com/postgres",
      provider: "azure",
    });

    expect(report.blockers).toContain("runtime-role");
    expect(report.inventory.runtimeRole?.missingTablePrivileges).toEqual([
      "TradeExecution:INSERT",
    ]);
    expect(report.inventory.runtimeRole?.excessTablePrivileges).toEqual([]);
  });

  it("blocks a runtime role that holds an excess privilege beyond the exact matrix", async () => {
    mockedPostgres
      .mockReturnValueOnce(createSqlMock("safe") as never)
      .mockReturnValueOnce(createSqlMock("azure-role-excess") as never);

    const report = await runDeploymentPreflight({
      directUrl: "******db.example.com/postgres",
      runtimeUrl: "******pooler.example.com/postgres",
      provider: "azure",
    });

    expect(report.blockers).toContain("runtime-role");
    expect(report.inventory.runtimeRole?.missingTablePrivileges).toEqual([]);
    expect(report.inventory.runtimeRole?.excessTablePrivileges).toEqual([
      "TradeExecution:UPDATE",
    ]);
  });

  it("blocks a runtime role privilege granted on a future view, not just ordinary tables", async () => {
    mockedPostgres
      .mockReturnValueOnce(createSqlMock("safe") as never)
      .mockReturnValueOnce(
        createSqlMock("azure-role-excess-future-view") as never,
      );

    const report = await runDeploymentPreflight({
      directUrl: "******db.example.com/postgres",
      runtimeUrl: "******pooler.example.com/postgres",
      provider: "azure",
    });

    expect(report.blockers).toContain("runtime-role");
    expect(report.inventory.runtimeRole?.missingTablePrivileges).toEqual([]);
    expect(report.inventory.runtimeRole?.excessTablePrivileges).toEqual([
      "TradeExecutionSummaryView:SELECT",
    ]);
  });

  it("blocks a runtime role privilege granted on a future partitioned or foreign relation", async () => {
    mockedPostgres
      .mockReturnValueOnce(createSqlMock("safe") as never)
      .mockReturnValueOnce(
        createSqlMock("azure-role-excess-future-relation") as never,
      );

    const report = await runDeploymentPreflight({
      directUrl: "******db.example.com/postgres",
      runtimeUrl: "******pooler.example.com/postgres",
      provider: "azure",
    });

    expect(report.blockers).toContain("runtime-role");
    expect(report.inventory.runtimeRole?.missingTablePrivileges).toEqual([]);
    expect(report.inventory.runtimeRole?.excessTablePrivileges).toEqual([
      "TradeExecutionArchive:INSERT",
      "ExternalMarketDataFeed:SELECT",
    ]);
  });

  it("captures current_user on both connections and requires them to differ", async () => {
    mockedPostgres
      .mockReturnValueOnce(createSqlMock("same-connection-role") as never)
      .mockReturnValueOnce(createSqlMock("same-connection-role") as never);

    const report = await runDeploymentPreflight({
      directUrl: "******db.example.com/postgres",
      runtimeUrl: "******pooler.example.com/postgres",
      provider: "azure",
    });

    expect(report.inventory.directCurrentUser).toBe("krypto_migrator");
    expect(report.inventory.runtimeCurrentUser).toBe("krypto_migrator");
    expect(
      report.checks.find(
        (check) => check.id === "connection-roles-distinct",
      ),
    ).toEqual(expect.objectContaining({ status: "block" }));
    expect(report.blockers).toContain("connection-roles-distinct");
  });

  it("warns (not blocks) on a legacy target when connections share a role", async () => {
    mockedPostgres
      .mockReturnValueOnce(createSqlMock("same-connection-role") as never)
      .mockReturnValueOnce(createSqlMock("same-connection-role") as never);

    const report = await runDeploymentPreflight({
      directUrl: "******db.example.com/postgres",
      runtimeUrl: "******pooler.example.com/postgres",
    });

    expect(
      report.checks.find(
        (check) => check.id === "connection-roles-distinct",
      ),
    ).toEqual(expect.objectContaining({ status: "warn" }));
    expect(report.blockers).not.toContain("connection-roles-distinct");
  });

  it("blocks when the runtime login role is not a member of krypto_runtime on Azure", async () => {
    mockedPostgres
      .mockReturnValueOnce(createSqlMock("safe") as never)
      .mockReturnValueOnce(createSqlMock("azure-login-not-member") as never);

    const report = await runDeploymentPreflight({
      directUrl: "******db.example.com/postgres",
      runtimeUrl: "******pooler.example.com/postgres",
      provider: "azure",
    });

    expect(report.inventory.runtimeLoginRole?.isMemberOfRuntimeRole).toBe(
      false,
    );
    expect(
      report.checks.find(
        (check) => check.id === "runtime-login-role-boundary",
      ),
    ).toEqual(expect.objectContaining({ status: "block" }));
    expect(report.blockers).toContain("runtime-login-role-boundary");
  });

  it("blocks when the runtime login role inherits an excess privilege on Azure", async () => {
    mockedPostgres
      .mockReturnValueOnce(createSqlMock("safe") as never)
      .mockReturnValueOnce(createSqlMock("azure-login-excess") as never);

    const report = await runDeploymentPreflight({
      directUrl: "******db.example.com/postgres",
      runtimeUrl: "******pooler.example.com/postgres",
      provider: "azure",
    });

    expect(
      report.inventory.runtimeLoginRole?.excessTablePrivileges,
    ).toEqual(["AgentJournal:DELETE"]);
    expect(
      report.checks.find(
        (check) => check.id === "runtime-login-role-boundary",
      ),
    ).toEqual(expect.objectContaining({ status: "block" }));
    expect(report.blockers).toContain("runtime-login-role-boundary");
  });

  it("warns (not blocks) on a legacy target when the runtime login role fails the privilege boundary proof", async () => {
    mockedPostgres
      .mockReturnValueOnce(createSqlMock("safe") as never)
      .mockReturnValueOnce(createSqlMock("azure-login-not-member") as never);

    const report = await runDeploymentPreflight({
      directUrl: "******db.example.com/postgres",
      runtimeUrl: "******pooler.example.com/postgres",
    });

    expect(
      report.checks.find(
        (check) => check.id === "runtime-login-role-boundary",
      ),
    ).toEqual(expect.objectContaining({ status: "warn" }));
    expect(report.blockers).not.toContain("runtime-login-role-boundary");
  });

  describe("PostgreSQL trust boundary (GitHub issue #133)", () => {
    it("passes a fully compliant trust boundary with a correct MIGRATION_URL", async () => {
      mockedPostgres
        .mockReturnValueOnce(createSqlMock("safe") as never)
        .mockReturnValueOnce(createSqlMock("trust-boundary-current") as never)
        .mockReturnValueOnce(createSqlMock("trust-boundary-current") as never);

      const report = await runDeploymentPreflight({
        directUrl: "postgresql://postgres@db.example.com:5432/postgres",
        runtimeUrl:
          "postgresql://azure_app_identity@pooler.example.com:6543/postgres",
        migrationUrl:
          "postgresql://krypto_migrator@migrator-host.example.com:5432/postgres",
      });

      expect(report.inventory.drizzleMigrationCount).toBe(9);
      for (const id of [
        "trust-boundary-role-attributes",
        "trust-boundary-migrator-set-role-path",
        "trust-boundary-runtime-not-elevated",
        "trust-boundary-operator-membership",
        "trust-boundary-app-schema-ownership",
        "trust-boundary-migration-ledger-ownership",
        "trust-boundary-runtime-denial-matrix",
        "trust-boundary-default-privileges",
        "trust-boundary-public-schema-create",
        "trust-boundary-runtime-public-schema",
        "trust-boundary-migrator-connection-limit",
        "trust-boundary-migrator-create-boundary",
        "trust-boundary-search-path",
        "migration-connectivity",
        "migration-url-safety",
        "migration-identity",
      ]) {
        expect(report.checks.find((check) => check.id === id)).toEqual(
          expect.objectContaining({ status: "pass" }),
        );
      }
      expect(
        report.blockers.filter((id) => id.startsWith("trust-boundary")),
      ).toEqual([]);
      expect(
        report.blockers.filter((id) => id.startsWith("migration-")),
      ).toEqual([]);
    });

    it("warns (does not block) when the trust boundary has not been migrated yet", async () => {
      mockedPostgres
        .mockReturnValueOnce(createSqlMock("safe") as never)
        .mockReturnValueOnce(createSqlMock("safe") as never);

      const report = await runDeploymentPreflight({
        directUrl: "******db.example.com/postgres",
        runtimeUrl: "******pooler.example.com/postgres",
      });

      expect(report.inventory.drizzleMigrationCount).toBe(7);
      expect(report.blockers).toEqual([]);
      expect(
        report.checks.find(
          (check) => check.id === "trust-boundary-role-attributes",
        ),
      ).toEqual(expect.objectContaining({ status: "warn" }));
      expect(
        report.checks.find((check) => check.id === "migration-connectivity"),
      ).toEqual(expect.objectContaining({ status: "warn" }));
    });

    it("blocks when krypto_schema_owner or krypto_scheduler can log in", async () => {
      mockedPostgres
        .mockReturnValueOnce(createSqlMock("safe") as never)
        .mockReturnValueOnce(
          createSqlMock("trust-boundary-role-login-unsafe") as never,
        );

      const report = await runDeploymentPreflight({
        directUrl: "******db.example.com/postgres",
        runtimeUrl: "******pooler.example.com/postgres",
      });

      expect(report.blockers).toContain("trust-boundary-role-attributes");
    });

    it("blocks when krypto_migrator inherits krypto_schema_owner instead of SET-only", async () => {
      mockedPostgres
        .mockReturnValueOnce(createSqlMock("safe") as never)
        .mockReturnValueOnce(
          createSqlMock("trust-boundary-migrator-inherits") as never,
        );

      const report = await runDeploymentPreflight({
        directUrl: "******db.example.com/postgres",
        runtimeUrl: "******pooler.example.com/postgres",
      });

      expect(report.blockers).toContain(
        "trust-boundary-migrator-set-role-path",
      );
    });

    it("always blocks (regardless of provider) when krypto_runtime is a member of an elevated role", async () => {
      mockedPostgres
        .mockReturnValueOnce(createSqlMock("safe") as never)
        .mockReturnValueOnce(
          createSqlMock("trust-boundary-runtime-elevated") as never,
        );

      const report = await runDeploymentPreflight({
        directUrl: "******db.example.com/postgres",
        runtimeUrl: "******pooler.example.com/postgres",
      });

      expect(
        report.checks.find(
          (check) => check.id === "trust-boundary-runtime-not-elevated",
        ),
      ).toEqual(
        expect.objectContaining({
          status: "block",
          evidence: expect.objectContaining({
            runtimeIsMemberOfSchemaOwner: true,
          }),
        }),
      );
      expect(report.blockers).toContain(
        "trust-boundary-runtime-not-elevated",
      );
    });

    it("blocks a migrated environment whose krypto schema is not owned by krypto_schema_owner", async () => {
      mockedPostgres
        .mockReturnValueOnce(createSqlMock("safe") as never)
        .mockReturnValueOnce(
          createSqlMock("trust-boundary-bad-app-schema-owner") as never,
        );

      const report = await runDeploymentPreflight({
        directUrl: "******db.example.com/postgres",
        runtimeUrl: "******pooler.example.com/postgres",
      });

      expect(report.blockers).toContain(
        "trust-boundary-app-schema-ownership",
      );
    });

    it("blocks a migrated environment whose drizzle ledger is not owned by krypto_schema_owner or krypto_migrator", async () => {
      mockedPostgres
        .mockReturnValueOnce(createSqlMock("safe") as never)
        .mockReturnValueOnce(
          createSqlMock("trust-boundary-bad-ledger-owner") as never,
        );

      const report = await runDeploymentPreflight({
        directUrl: "******db.example.com/postgres",
        runtimeUrl: "******pooler.example.com/postgres",
      });

      expect(report.blockers).toContain(
        "trust-boundary-migration-ledger-ownership",
      );
    });

    it("always blocks when krypto_runtime can still reach the drizzle migration ledger", async () => {
      mockedPostgres
        .mockReturnValueOnce(createSqlMock("safe") as never)
        .mockReturnValueOnce(
          createSqlMock("trust-boundary-ledger-access-leak") as never,
        );

      const report = await runDeploymentPreflight({
        directUrl: "******db.example.com/postgres",
        runtimeUrl: "******pooler.example.com/postgres",
      });

      expect(
        report.checks.find(
          (check) => check.id === "trust-boundary-runtime-denial-matrix",
        ),
      ).toEqual(expect.objectContaining({ status: "block" }));
      expect(report.blockers).toContain(
        "trust-boundary-runtime-denial-matrix",
      );
    });

    it("always blocks when krypto_runtime can still reach a legacy vault/cron/net/pg_net schema", async () => {
      mockedPostgres
        .mockReturnValueOnce(createSqlMock("safe") as never)
        .mockReturnValueOnce(
          createSqlMock("trust-boundary-legacy-access-leak") as never,
        );

      const report = await runDeploymentPreflight({
        directUrl: "******db.example.com/postgres",
        runtimeUrl: "******pooler.example.com/postgres",
      });

      expect(report.blockers).toContain(
        "trust-boundary-runtime-denial-matrix",
      );
    });

    it("always blocks when krypto_runtime holds an unexpected public-schema grant", async () => {
      mockedPostgres
        .mockReturnValueOnce(createSqlMock("safe") as never)
        .mockReturnValueOnce(
          createSqlMock("trust-boundary-public-grant-leak") as never,
        );

      const report = await runDeploymentPreflight({
        directUrl: "******db.example.com/postgres",
        runtimeUrl: "******pooler.example.com/postgres",
      });

      expect(
        report.checks.find(
          (check) => check.id === "trust-boundary-runtime-denial-matrix",
        ),
      ).toEqual(
        expect.objectContaining({
          evidence: expect.objectContaining({
            runtimePublicObjectGrants: ["table:krypto_state_mirror"],
          }),
        }),
      );
      expect(report.blockers).toContain(
        "trust-boundary-runtime-denial-matrix",
      );
    });

    it("always blocks on a default-privilege leak for krypto_schema_owner/krypto_migrator", async () => {
      mockedPostgres
        .mockReturnValueOnce(createSqlMock("safe") as never)
        .mockReturnValueOnce(
          createSqlMock("trust-boundary-default-privilege-leak") as never,
        );

      const report = await runDeploymentPreflight({
        directUrl: "******db.example.com/postgres",
        runtimeUrl: "******pooler.example.com/postgres",
      });

      expect(report.blockers).toContain("trust-boundary-default-privileges");
    });

    it("always blocks when the PUBLIC pseudo-role still holds CREATE on the public schema", async () => {
      mockedPostgres
        .mockReturnValueOnce(createSqlMock("safe") as never)
        .mockReturnValueOnce(
          createSqlMock("trust-boundary-public-schema-creatable") as never,
        );

      const report = await runDeploymentPreflight({
        directUrl: "******db.example.com/postgres",
        runtimeUrl: "******pooler.example.com/postgres",
      });

      expect(report.blockers).toContain(
        "trust-boundary-public-schema-create",
      );
    });

    it("blocks when the runtime login can use the unrelated public schema", async () => {
      mockedPostgres
        .mockReturnValueOnce(createSqlMock("safe") as never)
        .mockReturnValueOnce(
          createSqlMock("trust-boundary-runtime-public-schema") as never,
        );

      const report = await runDeploymentPreflight({
        directUrl: "******db.example.com/postgres",
        runtimeUrl: "******pooler.example.com/postgres",
      });

      expect(report.blockers).toContain(
        "trust-boundary-runtime-public-schema",
      );
    });

    it("blocks a migrated environment whose krypto_migrator has an unbounded connection limit", async () => {
      mockedPostgres
        .mockReturnValueOnce(createSqlMock("safe") as never)
        .mockReturnValueOnce(
          createSqlMock("trust-boundary-connection-limit-unbounded") as never,
        );

      const report = await runDeploymentPreflight({
        directUrl: "******db.example.com/postgres",
        runtimeUrl: "******pooler.example.com/postgres",
      });

      expect(report.blockers).toContain(
        "trust-boundary-migrator-connection-limit",
      );
    });

    it("blocks explicit elevated membership on either runtime login or operator", async () => {
        for (const scenario of [
          "trust-boundary-runtime-login-elevated",
          "trust-boundary-operator-elevated",
        ] as const) {
          mockedPostgres.mockReset();
          mockedPostgres
            .mockReturnValueOnce(createSqlMock("safe") as never)
            .mockReturnValueOnce(createSqlMock(scenario) as never);

          const report = await runDeploymentPreflight({
            directUrl: "******db.example.com/postgres",
            runtimeUrl: "******pooler.example.com/postgres",
          });

          expect(report.blockers).toContain(
            scenario === "trust-boundary-runtime-login-elevated"
              ? "trust-boundary-runtime-not-elevated"
              : "trust-boundary-operator-membership",
          );
        }
    });

    it("blocks migrator CREATE outside SET ROLE and unsafe search paths", async () => {
        for (const [scenario, blocker] of [
          [
            "trust-boundary-migrator-create",
            "trust-boundary-migrator-create-boundary",
          ],
          ["trust-boundary-search-path-unsafe", "trust-boundary-search-path"],
        ] as const) {
          mockedPostgres.mockReset();
          mockedPostgres
            .mockReturnValueOnce(createSqlMock("safe") as never)
            .mockReturnValueOnce(createSqlMock(scenario) as never);

          const report = await runDeploymentPreflight({
            directUrl: "******db.example.com/postgres",
            runtimeUrl: "******pooler.example.com/postgres",
          });

          expect(report.blockers).toContain(blocker);
        }
    });

    it("blocks a fully migrated environment missing MIGRATION_URL", async () => {
      mockedPostgres
        .mockReturnValueOnce(createSqlMock("safe") as never)
        .mockReturnValueOnce(createSqlMock("trust-boundary-current") as never);

      const report = await runDeploymentPreflight({
        directUrl: "******db.example.com/postgres",
        runtimeUrl: "******pooler.example.com/postgres",
      });

      expect(report.blockers).toContain("migration-connectivity");
      expect(report.blockers).toContain("migration-url-safety");
      expect(report.blockers).toContain("migration-identity");
    });

    it("blocks when MIGRATION_URL authenticates as the wrong identity", async () => {
      mockedPostgres
        .mockReturnValueOnce(createSqlMock("safe") as never)
        .mockReturnValueOnce(
          createSqlMock("same-connection-role") as never,
        )
        .mockReturnValueOnce(createSqlMock("trust-boundary-current") as never);

      const report = await runDeploymentPreflight({
        directUrl: "postgresql://postgres@db.example.com:5432/postgres",
        runtimeUrl:
          "postgresql://azure_app_identity@pooler.example.com:6543/postgres",
        migrationUrl:
          "postgresql://krypto_migrator@migrator-host.example.com:5432/postgres",
      });

      expect(
        report.checks.find((check) => check.id === "migration-identity"),
      ).toEqual(expect.objectContaining({ status: "block" }));
      expect(report.blockers).toContain("migration-identity");
    });

    it("blocks when MIGRATION_URL collides with DATABASE_URL", async () => {
      mockedPostgres
        .mockReturnValueOnce(createSqlMock("safe") as never)
        .mockReturnValueOnce(createSqlMock("trust-boundary-current") as never)
        .mockReturnValueOnce(createSqlMock("trust-boundary-current") as never);

      const report = await runDeploymentPreflight({
        directUrl: "postgresql://postgres@db.example.com:5432/postgres",
        runtimeUrl:
          "postgresql://azure_app_identity@pooler.example.com:6543/postgres",
        migrationUrl:
          "postgresql://azure_app_identity@pooler.example.com:6543/postgres",
      });

      expect(
        report.checks.find((check) => check.id === "migration-url-safety"),
      ).toEqual(expect.objectContaining({ status: "block" }));
      expect(report.blockers).toContain("migration-url-safety");
    });
  });
});
