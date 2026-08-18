import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const root = path.resolve(__dirname, "../..");
const drizzleDir = path.join(root, "drizzle");
const supabaseMigrationDir = path.join(root, "supabase", "migrations");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

describe("production migration safety", () => {
  const migrationFiles = fs
    .readdirSync(drizzleDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  it("uses only the Drizzle production migration history", () => {
    const supabaseSqlFiles = fs.existsSync(supabaseMigrationDir)
      ? fs
          .readdirSync(supabaseMigrationDir)
          .filter((file) => file.endsWith(".sql"))
      : [];

    expect(migrationFiles.length).toBeGreaterThan(0);
    expect(supabaseSqlFiles).toEqual([]);
  });

  it.each(migrationFiles)("%s contains no destructive data operation", (file) => {
    const sql = fs.readFileSync(path.join(drizzleDir, file), "utf8");

    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/\bDROP\s+TABLE\b/i);
  });

  it("adopts a pre-existing v2 schema idempotently", () => {
    const baseline = read("drizzle/0000_powerful_thundra.sql");
    const operatorPause = read("drizzle/0001_add_is_operator_paused.sql");

    expect(baseline).toMatch(/CREATE TABLE IF NOT EXISTS/);
    expect(baseline).toContain("AgentJournal_tradeExecutionId_fkey");
    expect(operatorPause).toMatch(/ADD COLUMN IF NOT EXISTS/);
  });

  it("moves application data out of the exposed public schema", () => {
    const secureSchema = read("drizzle/0002_secure_private_schema.sql");
    const restrictedAccess = read(
      "drizzle/0004_restrict_vault_access.sql",
    );
    const rolloutBinding = read(
      "drizzle/0005_bind_cron_rollout_mode.sql",
    );
    const nullSafeRollout = read(
      "drizzle/0006_reject_null_cron_rollout_mode.sql",
    );

    expect(secureSchema).toContain('CREATE SCHEMA IF NOT EXISTS "krypto"');
    expect(secureSchema).toContain('SET SCHEMA "krypto"');
    expect(secureSchema).toContain(
      'REVOKE ALL ON SCHEMA "krypto" FROM PUBLIC',
    );
    expect(secureSchema).toContain(
      'REVOKE ALL ON FUNCTION "krypto"."invoke_agent_run"() FROM PUBLIC',
    );
    expect(rolloutBinding).toContain(
      "'x-required-rollout-mode', v_required_mode",
    );
    expect(rolloutBinding).toContain(
      "WHERE name = 'krypto_rollout_mode'",
    );
    expect(
      createHash("sha256").update(rolloutBinding).digest("hex"),
    ).toBe(
      "6c2224452bafb07b0bd7ecaa3fcc6a45690abef61944b487571e900f11d7c43a",
    );
    expect(rolloutBinding).not.toContain(
      "v_required_mode IS NULL",
    );
    expect(nullSafeRollout).toContain(
      "'x-required-rollout-mode', v_required_mode",
    );
    expect(
      nullSafeRollout.match(
        /IF v_required_mode IS NULL\s+OR v_required_mode NOT IN \('shadow', 'paper'\) THEN/g,
      ),
    ).toHaveLength(2);
    expect(secureSchema).toContain(
      "REVOKE ALL PRIVILEGES ON TABLE vault.decrypted_secrets FROM PUBLIC",
    );
    expect(secureSchema).not.toMatch(
      /FUNCTION\s+"?public"?\."?krypto_invoke_endpoint"?\s*\(\s*[^)]/i,
    );
    expect(restrictedAccess).toContain(
      "REVOKE EXECUTE ON ALL ROUTINES IN SCHEMA",
    );
    expect(restrictedAccess).toContain(
      'DROP FUNCTION IF EXISTS "public"."krypto_invoke_endpoint"(text)',
    );
    expect(restrictedAccess).toContain(
      "REVOKE ALL PRIVILEGES (%s) ON TABLE",
    );
    expect(restrictedAccess).toContain(
      "ARRAY['krypto', 'vault']",
    );
    expect(restrictedAccess).toContain(
      "WITH RECURSIVE protected_relation",
    );
    expect(restrictedAccess).toContain("routine.prosecdef");
  });

  it("keeps cron activation separate and fixed-path", () => {
    const enableCron = read("supabase/operations/enable-krypto-cron.sql");

    expect(enableCron).toContain("SELECT krypto.invoke_agent_run();");
    expect(enableCron).toContain("SELECT krypto.invoke_daily_summary();");
    expect(enableCron).toContain(
      "md5(v_source) <> '3cb03ace0e82bee3f8b755701a10ea6b'",
    );
    expect(enableCron).toContain(
      "md5(v_source) <> '68aee98c8c762497b1b0cf016ea6d25d'",
    );
    expect(enableCron).toMatch(
      /OR v_required_mode IS NULL\s+OR v_required_mode NOT IN \('shadow', 'paper'\) THEN/,
    );
    expect(enableCron).toContain("v_owner <> current_user");
    expect(enableCron).toContain(
      "v_configuration IS DISTINCT FROM",
    );
    expect(enableCron).toContain("ARRAY['search_path=pg_catalog']");
    expect(enableCron).toContain("extname = 'pg_cron'");
    expect(enableCron).toContain("extname = 'pg_net'");
    expect(enableCron).toContain("deployment-smoke-approved");
    expect(enableCron).toContain(
      "Vault cron configuration is not bound to a passing target smoke",
    );
    expect(enableCron).toMatch(/^--[\s\S]*\nBEGIN;/);
    expect(enableCron.trimEnd()).toMatch(/COMMIT;$/);
    expect(enableCron).toContain(
      "Krypto cron jobs failed final definition verification",
    );
    expect(enableCron).toContain(
      "Unexpected active Krypto cron job must be removed before activation",
    );
    expect(enableCron).toContain(
      "Pending Krypto HTTP requests must drain before cron activation",
    );
    expect(enableCron).toContain(
      "~* '/api/agent/(run|daily-summary)'",
    );
    expect(enableCron).toContain(
      "~* 'invoke_(agent_run|daily_summary)'",
    );
    expect(enableCron).not.toMatch(/CREATE\s+EXTENSION/i);
    expect(enableCron).not.toContain("endpoint_path");
    expect(enableCron).toContain(
      "ILIKE '%krypto_invoke_endpoint%'",
    );
    expect(enableCron).not.toMatch(
      /SELECT\s+(?:public\.)?krypto_invoke_endpoint\s*\(/i,
    );

    const disableCron = read(
      "supabase/operations/disable-krypto-cron.sql",
    );
    expect(disableCron).toMatch(/^BEGIN;/);
    expect(disableCron.trimEnd()).toMatch(/COMMIT;$/);
    expect(disableCron).toContain(
      "~* '/api/agent/(run|daily-summary)'",
    );
    expect(disableCron).toContain(
      "DELETE FROM net.http_request_queue",
    );
    expect(disableCron).toContain(
      "Krypto schedules or queued HTTP requests remain active",
    );
  });

  it("expands the ledger with decimal and idempotency boundaries", () => {
    const ledger = read("drizzle/0003_expand_ledger.sql");

    expect(ledger).toContain('CREATE TABLE "krypto"."AgentRun"');
    expect(ledger).toContain("numeric(28, 18)");
    expect(ledger).toContain("AgentRun_idempotencyKey_uidx");
    expect(ledger).toContain("TradeExecution_agentRunId_uidx");
    expect(ledger).toContain("'QUARANTINED'");
    expect(ledger).toContain("legacy ETH balance mismatch");
    expect(ledger).not.toMatch(/\bDELETE\s+FROM\b/i);
  });

  it("adds the reviewed append-only safety incident outbox without weakening role boundaries", () => {
    const migration = read("drizzle/0010_safety_incidents.sql");
    const journal = JSON.parse(
      read("drizzle/meta/_journal.json"),
    ) as {
      entries: Array<{ idx: number; when: number; tag: string }>;
    };

    expect(
      createHash("sha256").update(migration).digest("hex"),
    ).toBe(
      "e81e8e38bcf2e32855a4d98dd3c76950c26d0e9aeecba536adb0f12278920095",
    );
    expect(journal.entries.at(-3)).toEqual(
      expect.objectContaining({
        idx: 10,
        when: 1786993492359,
        tag: "0010_safety_incidents",
      }),
    );
    expect(migration).toContain('SET ROLE "krypto_schema_owner"');
    expect(migration).toContain(
      'CREATE TABLE "krypto"."SafetyIncidentOutbox"',
    );
    expect(migration).toContain('"eventId" text PRIMARY KEY NOT NULL');
    expect(migration).not.toMatch(/\b(?:serial|bigserial)\b/i);
    expect(migration).toContain(
      '"SafetyIncidentOutbox_incidentId_eventSequence_uidx"',
    );
    expect(migration).toContain(
      '"SafetyIncidentOutbox_created_dedupKey_uidx"',
    );
    expect(migration).toContain(
      `WHERE "eventKind" = 'CREATED'`,
    );
    expect(migration).toContain(
      'REFERENCES "krypto"."AgentRun"("id") ON DELETE restrict',
    );
    expect(migration).toContain(
      'REFERENCES "krypto"."TradeExecution"("id") ON DELETE restrict',
    );
    expect(migration).toContain(
      'BEFORE UPDATE OR DELETE ON "krypto"."SafetyIncidentOutbox"',
    );
    expect(migration).toContain(
      '"SafetyIncidentOutbox_validate_insert"',
    );
    expect(migration).toContain(
      "Runtime identity cannot resolve safety incidents",
    );
    expect(migration).toContain(
      "Resolution requires a distinct complementary role",
    );
    expect(migration).toContain(
      'REVOKE ALL PRIVILEGES ON TABLE "krypto"."SafetyIncidentOutbox" FROM PUBLIC',
    );
    expect(migration).toContain(
      'GRANT SELECT, INSERT ON TABLE "krypto"."SafetyIncidentOutbox" TO "krypto_runtime"',
    );
    expect(migration).not.toMatch(
      /GRANT[^;]*(?:UPDATE|DELETE|TRUNCATE|TRIGGER|REFERENCES)[^;]*ON TABLE "krypto"\."SafetyIncidentOutbox"/i,
    );
    const backfillIndex = migration.indexOf(
      `UPDATE "krypto"."AgentRun"`,
    );
    for (const column of ["requestId", "releaseId", "deploymentId"]) {
      expect(migration).toContain(
        `ALTER TABLE "krypto"."AgentRun" ADD COLUMN "${column}" text`,
      );
      expect(migration.indexOf(
        `ALTER COLUMN "${column}" SET NOT NULL`,
      )).toBeGreaterThan(backfillIndex);
    }
    expect(migration).toContain("'legacy-agent-run:' || \"id\"");
    expect(migration).toContain(
      `"schemaFingerprint" = '0010_safety_incidents_v1'`,
    );
    expect(migration).toContain('"contractVersion" = 2');
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(migration).not.toMatch(/\bTRUNCATE\b/i);
    expect(migration).not.toMatch(/\bDROP\s+TABLE\b/i);
  });

  it("adds anchor provenance without resetting ledger or position history", () => {
    const migration = read("drizzle/0011_ledger_attestation_anchors.sql");
    const journal = JSON.parse(
      read("drizzle/meta/_journal.json"),
    ) as {
      entries: Array<{ idx: number; when: number; tag: string }>;
    };
    expect(journal.entries.at(-2)).toEqual(
      expect.objectContaining({
        idx: 11,
        when: 1787009045958,
        tag: "0011_ledger_attestation_anchors",
      }),
    );
    expect(migration).toContain(
      'ADD COLUMN "referencePriceAnchor" jsonb',
    );
    expect(migration).toContain("'legacy-migration-0011'");
    expect(migration).toContain("'maxAgeSeconds', 3600");
    expect(migration).toContain(
      `"schemaFingerprint" = '0011_ledger_attestation_anchors_v1'`,
    );
    expect(migration).toContain('"contractVersion" = 3');
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(migration).not.toMatch(/\bTRUNCATE\b/i);
    expect(migration).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(migration).not.toMatch(
      /UPDATE\s+"krypto"\."TradeExecution"/i,
    );
  });

  it("adds immutable named-operator provenance with an exact runtime grant", () => {
    const migration = read("drizzle/0012_operator_admin_identity.sql");
    const journal = JSON.parse(
      read("drizzle/meta/_journal.json"),
    ) as {
      entries: Array<{ idx: number; when: number; tag: string }>;
    };
    expect(journal.entries.at(-1)).toEqual(
      expect.objectContaining({
        idx: 12,
        when: 1787015085502,
        tag: "0012_operator_admin_identity",
      }),
    );
    expect(migration).toContain('SET ROLE "krypto_schema_owner"');
    expect(migration).toContain(
      'CREATE TABLE "krypto"."OperatorAuditEvent"',
    );
    expect(migration).toContain(
      'BEFORE UPDATE OR DELETE ON "krypto"."OperatorAuditEvent"',
    );
    expect(migration).toContain(
      'GRANT SELECT, INSERT ON TABLE "krypto"."OperatorAuditEvent" TO "krypto_runtime"',
    );
    expect(migration).toContain(
      `"persistedAt" + interval '60 seconds' >= "krypto"."OperatorAuditEvent"."occurredAt"`,
    );
    expect(migration).toContain(
      `"occurredAt" + interval '60 seconds' >= "krypto"."OperatorAuditEvent"."persistedAt"`,
    );
    expect(migration).not.toMatch(
      /GRANT[^;]*(?:UPDATE|DELETE|TRUNCATE|TRIGGER|REFERENCES)[^;]*ON TABLE "krypto"\."OperatorAuditEvent"/i,
    );
    expect(migration).toContain(
      `"schemaFingerprint" = '0012_operator_admin_identity_v1'`,
    );
    expect(migration).toContain('"contractVersion" = 4');
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(migration).not.toMatch(/\bTRUNCATE\b/i);
    expect(migration).not.toMatch(/\bDROP\s+TABLE\b/i);
  });

  it("does not expose an evidence-reset override after incident evidence exists", () => {
    const reset = read("scripts/reset-state.ts");
    expect(reset).toContain("safetyIncidentOutbox");
    expect(reset).toContain(
      "There is no evidence-reset override",
    );
    expect(reset).not.toContain("ALLOW_DESTRUCTIVE_RESET");
    expect(reset).not.toMatch(/delete\(safetyIncidentOutbox\)/);
  });

  it("keeps resolution in the protected owner lane rather than runtime/admin", () => {
    const operation = read("scripts/resolve-safety-incident.ts");
    const adminRoute = read(
      "src/app/api/admin/safety-incidents/route.ts",
    );
    expect(operation).toContain('required("DIRECT_URL")');
    expect(operation).toContain(
      'SET LOCAL ROLE "krypto_schema_owner"',
    );
    expect(operation).toContain("verifySafetyActorAssertion");
    expect(operation).toContain("REQUIRED_EVIDENCE");
    expect(adminRoute).toContain(
      "Human lifecycle changes remain unavailable through the web runtime",
    );
  });

  it("requires the direct database URL for non-migration database commands", () => {
    const config = read("drizzle.config.ts");

    expect(config).toContain("process.env.DIRECT_URL");
  });

  it("requires a dedicated, distinct MIGRATION_URL for the migrate command", () => {
    const config = read("drizzle.config.ts");

    expect(config).toContain("process.env.MIGRATION_URL");
    expect(config).toContain('migratorOnlyCommands.has(command ?? "")');
    expect(config).toContain("MIGRATION_URL is required for the migrate command");
    expect(config).toContain("classifyMigrationUrlSafety");
    expect(config).toContain('expectedUsername: "krypto_migrator"');
    // DATABASE_URL is read only to prove MIGRATION_URL is distinct from it;
    // it must never be assigned as the connection Drizzle actually uses.
    expect(config).not.toMatch(/url:\s*(directUrl|migrationUrl|runtimeUrl)\s*\?\?[^,]*runtimeUrl/);
    expect(config).not.toContain("url: runtimeUrl");
    expect(config).not.toContain("url: process.env.DATABASE_URL");
  });

  it("retires the obsolete Supabase HTTP cron functions and establishes a least-privilege runtime role", () => {
    const retirement = read(
      "drizzle/0007_azure_retire_supabase_http_functions.sql",
    );

    expect(retirement).toContain(
      'DROP FUNCTION IF EXISTS "krypto"."invoke_agent_run"()',
    );
    expect(retirement).toContain(
      'DROP FUNCTION IF EXISTS "krypto"."invoke_daily_summary"()',
    );
    expect(retirement).toContain('CREATE ROLE "krypto_runtime" NOLOGIN');
    expect(retirement).toContain(
      'GRANT USAGE ON SCHEMA "krypto" TO "krypto_runtime"',
    );
    expect(retirement).toContain('REVOKE ALL ON SCHEMA "krypto" FROM PUBLIC');
    expect(retirement).toContain(
      'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA "krypto" FROM PUBLIC',
    );
    expect(retirement).toContain(
      'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA "krypto" FROM PUBLIC',
    );

    // Fail-closed, table-specific grants only: no blanket ON ALL TABLES /
    // ON ALL SEQUENCES grant, and no blanket default privileges for future
    // tables — future migrations must grant explicitly. (REVOKE statements
    // legitimately use "ON ALL TABLES"/"ON ALL SEQUENCES ... FROM"; only a
    // "... TO krypto_runtime" grant of that shape is disallowed.)
    expect(retirement).not.toMatch(
      /ON ALL TABLES IN SCHEMA "krypto" TO "krypto_runtime"/,
    );
    expect(retirement).not.toMatch(
      /ON ALL SEQUENCES IN SCHEMA "krypto" TO "krypto_runtime"/,
    );
    expect(retirement).not.toMatch(
      /ALTER DEFAULT PRIVILEGES IN SCHEMA "krypto"\s+GRANT/,
    );
    // Existing privileges are revoked before the exact grants are applied,
    // so reapplying this migration (or correcting prior drift) converges
    // on the same matrix instead of accumulating privileges.
    const revokeTablesIndex = retirement.indexOf(
      'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA "krypto" FROM "krypto_runtime"',
    );
    const revokeSequencesIndex = retirement.indexOf(
      'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA "krypto" FROM "krypto_runtime"',
    );
    const revokeDefaultTablesIndex = retirement.indexOf(
      'REVOKE ALL PRIVILEGES ON TABLES FROM "krypto_runtime"',
    );
    const revokeDefaultSequencesIndex = retirement.indexOf(
      'REVOKE ALL PRIVILEGES ON SEQUENCES FROM "krypto_runtime"',
    );
    const grantSchemaIndex = retirement.indexOf(
      'GRANT USAGE ON SCHEMA "krypto" TO "krypto_runtime"',
    );
    expect(revokeTablesIndex).toBeGreaterThan(-1);
    expect(revokeSequencesIndex).toBeGreaterThan(-1);
    expect(revokeDefaultTablesIndex).toBeGreaterThan(-1);
    expect(revokeDefaultSequencesIndex).toBeGreaterThan(-1);
    expect(revokeTablesIndex).toBeLessThan(grantSchemaIndex);
    expect(revokeSequencesIndex).toBeLessThan(grantSchemaIndex);
    expect(revokeDefaultTablesIndex).toBeLessThan(grantSchemaIndex);
    expect(revokeDefaultSequencesIndex).toBeLessThan(grantSchemaIndex);

    // Exact, table-specific privilege matrix.
    expect(retirement).toContain(
      'GRANT SELECT, UPDATE ON TABLE "krypto"."AgentState" TO "krypto_runtime"',
    );
    expect(retirement).toContain(
      'GRANT SELECT, INSERT, UPDATE ON TABLE "krypto"."AgentRun" TO "krypto_runtime"',
    );
    expect(retirement).toContain(
      'GRANT SELECT, INSERT ON TABLE "krypto"."TradeExecution" TO "krypto_runtime"',
    );
    expect(retirement).toContain(
      'GRANT SELECT, INSERT ON TABLE "krypto"."AgentJournal" TO "krypto_runtime"',
    );
    // TradeExecution and AgentJournal are immutable history: never UPDATE.
    expect(retirement).not.toMatch(
      /GRANT[^;]*UPDATE[^;]*ON TABLE "krypto"\."TradeExecution"/i,
    );
    expect(retirement).not.toMatch(
      /GRANT[^;]*UPDATE[^;]*ON TABLE "krypto"\."AgentJournal"/i,
    );
    // AgentState is never inserted by the application.
    expect(retirement).not.toMatch(
      /GRANT[^;]*INSERT[^;]*ON TABLE "krypto"\."AgentState"/i,
    );
    // No table grant anywhere includes DELETE, TRUNCATE, TRIGGER, or
    // REFERENCES for krypto_runtime.
    expect(retirement).not.toMatch(/GRANT[^;]*\bDELETE\b[^;]*"krypto_runtime"/i);
    expect(retirement).not.toMatch(
      /GRANT[^;]*\bTRUNCATE\b[^;]*"krypto_runtime"/i,
    );
    expect(retirement).not.toMatch(
      /GRANT[^;]*\bTRIGGER\b[^;]*"krypto_runtime"/i,
    );
    expect(retirement).not.toMatch(
      /GRANT[^;]*\bREFERENCES\b[^;]*"krypto_runtime"/i,
    );

    // Additive and reversible: no trading table or row is touched.
    expect(retirement).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(retirement).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(retirement).not.toMatch(/\bTRUNCATE\b/i);
    expect(retirement).not.toMatch(/\bALTER\s+TABLE\b/i);
    // No password is embedded anywhere in the migration's executable SQL.
    expect(retirement).not.toMatch(/PASSWORD\s+'/i);
    expect(retirement).not.toMatch(/\bWITH\s+PASSWORD\b/i);
    // Guarded role creation is idempotent, unlike a bare CREATE ROLE.
    expect(retirement).toContain(
      "IF NOT EXISTS (\n\t\tSELECT 1 FROM pg_roles WHERE rolname = 'krypto_runtime'",
    );
  });

  it("establishes the trust-boundary role hierarchy without touching trading rows", () => {
    const trustBoundaries = read(
      "drizzle/0008_postgresql_trust_boundaries.sql",
    );

    // Fail-closed prerequisite verification runs before any structural change.
    expect(trustBoundaries).toContain(
      "IF current_user <> 'krypto_migrator' THEN",
    );
    expect(trustBoundaries).toContain(
      "WHERE rolname = 'krypto_schema_owner'",
    );
    expect(trustBoundaries).toContain("WHERE rolname = 'krypto_scheduler'");
    expect(trustBoundaries).toContain("WHERE rolname = 'krypto_runtime'");
    expect(trustBoundaries).toContain(
      "pg_has_role(current_user, 'krypto_schema_owner', 'SET')",
    );

    // Ownership transfer order: objects before the schema itself.
    const grantSchemaOwnerCreateIndex = trustBoundaries.indexOf(
      'GRANT CREATE, USAGE ON SCHEMA "krypto" TO "krypto_schema_owner"',
    );
    const alterSchemaOwnerIndex = trustBoundaries.indexOf(
      'ALTER SCHEMA "krypto" OWNER TO "krypto_schema_owner"',
    );
    expect(grantSchemaOwnerCreateIndex).toBeGreaterThan(-1);
    expect(alterSchemaOwnerIndex).toBeGreaterThan(grantSchemaOwnerCreateIndex);

    // Auto-owned (SERIAL/IDENTITY) sequences are excluded from the explicit
    // ownership-transfer loop; PostgreSQL cascades their ownership from the
    // owning table automatically and errors if this is attempted directly.
    expect(trustBoundaries).toContain("dependency.deptype IN ('a', 'i')");

    // The exact krypto_runtime grant matrix is unchanged from migration 0007.
    expect(trustBoundaries).toContain(
      'GRANT SELECT, UPDATE ON TABLE "krypto"."AgentState" TO "krypto_runtime"',
    );
    expect(trustBoundaries).toContain(
      'GRANT SELECT, INSERT, UPDATE ON TABLE "krypto"."AgentRun" TO "krypto_runtime"',
    );
    expect(trustBoundaries).toContain(
      'GRANT SELECT, INSERT ON TABLE "krypto"."TradeExecution" TO "krypto_runtime"',
    );
    expect(trustBoundaries).toContain(
      'GRANT SELECT, INSERT ON TABLE "krypto"."AgentJournal" TO "krypto_runtime"',
    );
    expect(trustBoundaries).not.toMatch(
      /GRANT[^;]*UPDATE[^;]*ON TABLE "krypto"\."TradeExecution"/i,
    );
    expect(trustBoundaries).not.toMatch(
      /GRANT[^;]*UPDATE[^;]*ON TABLE "krypto"\."AgentJournal"/i,
    );

    // Default privileges are locked down for both the schema owner and the
    // migrator identity, for both krypto_runtime and PUBLIC, so a future
    // migration that forgets `SET ROLE krypto_schema_owner` never leaks a
    // wider-than-intended default grant.
    for (const grantor of ["krypto_schema_owner", "krypto_migrator"]) {
      for (const grantee of ['"krypto_runtime"', "PUBLIC"]) {
        expect(trustBoundaries).toContain(
          `ALTER DEFAULT PRIVILEGES FOR ROLE "${grantor}" IN SCHEMA "krypto"\n\tREVOKE ALL PRIVILEGES ON TABLES FROM ${grantee}`,
        );
        expect(trustBoundaries).toContain(
          `ALTER DEFAULT PRIVILEGES FOR ROLE "${grantor}" IN SCHEMA "krypto"\n\tREVOKE ALL PRIVILEGES ON SEQUENCES FROM ${grantee}`,
        );
      }
    }

    // The drizzle migration ledger is revoked from krypto_runtime and
    // PUBLIC, guarded so it safely no-ops if the schema is absent.
    expect(trustBoundaries).toContain("IF to_regnamespace('drizzle') IS NULL THEN");
    expect(trustBoundaries).toContain(
      'REVOKE ALL ON SCHEMA "drizzle" FROM "krypto_runtime"',
    );
    expect(trustBoundaries).toContain(
      'REVOKE ALL ON SCHEMA "drizzle" FROM PUBLIC',
    );

    // Final fail-closed self-verification: ownership and the "runtime is
    // never a member of an elevated role" invariant are both enforced.
    expect(trustBoundaries).toContain(
      "relation.relowner::regrole::text <> 'krypto_schema_owner'",
    );
    expect(trustBoundaries).toContain(
      "pg_has_role('krypto_runtime', 'krypto_schema_owner', 'MEMBER')",
    );
    expect(trustBoundaries).toContain(
      "pg_has_role('krypto_runtime', 'krypto_migrator', 'MEMBER')",
    );
    expect(trustBoundaries).toContain(
      "pg_has_role('krypto_runtime', 'krypto_scheduler', 'MEMBER')",
    );

    // Additive, reversible, never touches trading rows or history, and no
    // role-membership grant/revoke (which requires ADMIN OPTION the
    // migrator role never holds) is attempted from migration SQL.
    expect(trustBoundaries).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(trustBoundaries).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(trustBoundaries).not.toMatch(/\bTRUNCATE\b/i);
    expect(trustBoundaries).not.toMatch(/^\s*GRANT\s+"?krypto_/im);
    expect(trustBoundaries).not.toMatch(/^\s*REVOKE\s+"?krypto_[a-z_]+"?\s+FROM/im);
    expect(trustBoundaries).not.toMatch(/PASSWORD\s+'/i);
    expect(trustBoundaries).not.toMatch(/\bWITH\s+PASSWORD\b/i);
  });

  it("keeps Supabase reset from loading application fixtures", () => {
    const config = read("supabase/config.toml");

    expect(config).toMatch(/\[db\.seed\][\s\S]*enabled = false/);
    expect(config).not.toMatch(/sql_paths\s*=/);
  });

  it("keeps initialization idempotent and non-destructive", () => {
    const initializer = read("scripts/seed.ts");

    expect(initializer).toContain(".onConflictDoNothing()");
    expect(initializer).not.toMatch(/\.delete\s*\(/);
    expect(initializer).not.toMatch(/\bDELETE\s+FROM\b/i);
  });
});
