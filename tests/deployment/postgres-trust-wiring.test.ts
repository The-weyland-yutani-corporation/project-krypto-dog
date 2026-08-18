import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function moduleBlock(source: string, name: string, nextName?: string): string {
  const start = source.indexOf(`module ${name} `);
  const end = nextName
    ? source.indexOf(`module ${nextName} `, start + 1)
    : source.length;
  if (start < 0 || end < 0) {
    throw new Error(`Could not isolate Bicep module ${name}.`);
  }
  return source.slice(start, end);
}

describe("PostgreSQL trust-boundary release wiring", () => {
  const release = read("infra/release.bicep");

  it("stores independently supplied runtime, migration, and operator credentials", () => {
    for (const parameter of [
      "param databaseUrl string",
      "param directUrl string",
      "param migrationUrl string",
      "param runtimeDatabasePassword string",
      "param migratorDatabasePassword string",
    ]) {
      expect(release).toContain(parameter);
    }
    expect(release).toContain("name: 'migration-url'");
    expect(release).toContain("name: 'migrator-database-password'");

    for (const environment of ["dev", "prod"]) {
      const params = read(`infra/params/release.${environment}.bicepparam`);
      const suffix = environment.toUpperCase();
      expect(params).toContain(
        `param migrationUrl = readEnvironmentVariable('MIGRATION_URL_${suffix}')`,
      );
      expect(params).toContain(
        `param migratorDatabasePassword = readEnvironmentVariable('MIGRATOR_DATABASE_PASSWORD_${suffix}')`,
      );
    }
  });

  it("keeps migration credentials out of web, scheduler, backup, smoke, and activation", () => {
    const forbiddenBlocks = [
      moduleBlock(release, "webApp", "hourlyAgentRunJob"),
      moduleBlock(release, "hourlyAgentRunJob", "dailySummaryJob"),
      moduleBlock(release, "dailySummaryJob", "migrateInitJob"),
      moduleBlock(release, "verifiedBackupJob", "targetSmokeJob"),
      moduleBlock(release, "targetSmokeJob", "activationCheckJob"),
      moduleBlock(release, "activationCheckJob"),
    ];
    for (const block of forbiddenBlocks) {
      expect(block).not.toContain("MIGRATION_URL");
      expect(block).not.toContain("KRYPTO_MIGRATOR_LOGIN_PASSWORD");
      expect(block).not.toContain("migrationUrlSecret.properties.secretUri");
      expect(block).not.toContain(
        "migratorDatabasePasswordSecret.properties.secretUri",
      );
    }
  });

  it("mounts the migrator password only on migrate-init and the URL on read-only preflight", () => {
    const migrate = moduleBlock(release, "migrateInitJob", "preflightJob");
    expect(migrate).toContain("{ name: 'MIGRATION_URL'");
    expect(migrate).toContain("{ name: 'KRYPTO_MIGRATOR_LOGIN_PASSWORD'");

    const preflight = moduleBlock(
      release,
      "preflightJob",
      "verifiedBackupJob",
    );
    expect(preflight).toContain("{ name: 'MIGRATION_URL'");
    expect(preflight).not.toContain("KRYPTO_MIGRATOR_LOGIN_PASSWORD");
  });

  it("requires protected workflow secrets and reapplies credential rotation before smoke", () => {
    const workflows = [
      read(".github/workflows/azure-deploy-dev.yml"),
      read(".github/workflows/azure-deploy-prod.yml"),
      read(".github/workflows/azure-rotate-secrets.yml"),
    ];
    for (const workflow of workflows) {
      expect(workflow).toContain("secrets.MIGRATION_URL");
      expect(workflow).toContain("secrets.MIGRATOR_DATABASE_PASSWORD");
    }

    const rotation = workflows[2];
    expect(rotation.indexOf("Apply migrator and runtime database credential rotation"))
      .toBeLessThan(rotation.indexOf("Run target-smoke"));
    expect(rotation).toContain('--operation migrate-init');
  });

  it("provides inert offline Bicep compiler stubs for the new secret inputs", () => {
    const validation = read(".github/workflows/azure-infra-validate.yml");
    for (const name of [
      "MIGRATION_URL_DEV",
      "MIGRATION_URL_PROD",
      "MIGRATOR_DATABASE_PASSWORD_DEV",
      "MIGRATOR_DATABASE_PASSWORD_PROD",
    ]) {
      expect(validation).toContain(`${name}: stub-inert-value`);
    }
  });

  it("makes database-role bootstrap part of retained migrate-init evidence", () => {
    const validator = read(".github/scripts/azure/validate-report.mjs");
    expect(validator).toContain(
      'requireTrue(report, "databaseRolesBootstrapped", "migrate-init report")',
    );
  });
});
