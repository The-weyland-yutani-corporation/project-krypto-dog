import { defineConfig } from "drizzle-kit";
import { classifyMigrationUrlSafety } from "./src/deployment/migration-url-safety";

const directUrl = process.env.DIRECT_URL;
const migrationUrl = process.env.MIGRATION_URL;
const runtimeUrl = process.env.DATABASE_URL;
const command = process.argv[2];
const offlineCommands = new Set(["generate", "check", "up"]);
const migratorOnlyCommands = new Set(["migrate"]);

let connectionUrl: string;

if (migratorOnlyCommands.has(command ?? "")) {
  // Migrations must run as the dedicated, least-privilege krypto_migrator
  // role over its own direct connection string — never DIRECT_URL (the
  // admin/operator role used only for one-time role bootstrap) and never
  // DATABASE_URL (the application runtime role). See
  // drizzle/0008_postgresql_trust_boundaries.sql and GitHub issue #133.
  if (!migrationUrl) {
    throw new Error(
      "MIGRATION_URL is required for the migrate command. Migrations must " +
        "run as the dedicated krypto_migrator role, distinct from both " +
        "DIRECT_URL (admin/operator) and DATABASE_URL (runtime). Do not " +
        "run migrations through the transaction pooler.",
    );
  }
  const safety = classifyMigrationUrlSafety({
    migrationUrl,
    directUrl,
    runtimeUrl,
    expectedUsername: "krypto_migrator",
  });
  if (!safety.safe) {
    throw new Error(
      `MIGRATION_URL failed safety validation: ${safety.reasons.join(" ")}`,
    );
  }
  connectionUrl = migrationUrl;
} else if (!offlineCommands.has(command ?? "")) {
  if (!directUrl) {
    throw new Error(
      "DIRECT_URL is required for database-connected Drizzle commands. " +
        "Do not run migrations through the transaction pooler.",
    );
  }
  connectionUrl = directUrl;
} else {
  // Offline generation still requires this config field but never connects.
  connectionUrl = "postgresql://offline.invalid/offline";
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: connectionUrl,
  },
});
