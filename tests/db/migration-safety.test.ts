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

  it("requires the direct database URL for migration commands", () => {
    const config = read("drizzle.config.ts");

    expect(config).toContain("process.env.DIRECT_URL");
    expect(config).not.toContain("process.env.DATABASE_URL");
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
