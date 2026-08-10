import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  hasBlockingChecks,
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
].map(([path, createdAt]) => ({
  hash: createHash("sha256")
    .update(readFileSync(path!, "utf8"))
    .digest("hex"),
  createdAt: createdAt!,
}));

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
    | "public-exposed" = "safe",
  systemIdentifier = "7123456789012345678",
) {
  const sql = jest.fn(
    async (
      first: TemplateStringsArray | string,
      ..._values: unknown[]
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
        return [
          {
            database: "krypto",
            serverVersion: "14.15",
            systemIdentifier,
          },
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
            : canonicalMigrationRows;
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
        if (scenario === "missing-functions") return [];
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
            relation: scenario === "blocked" ? null : "vault.secrets",
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
  ) as jest.Mock & { end: jest.Mock };
  sql.end = jest.fn(async () => undefined);
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
});
