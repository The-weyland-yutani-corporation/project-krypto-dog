import { defineConfig } from "drizzle-kit";

const directUrl = process.env.DIRECT_URL;
const command = process.argv[2];
const offlineCommands = new Set(["generate", "check", "up"]);

if (!directUrl && !offlineCommands.has(command ?? "")) {
  throw new Error(
    "DIRECT_URL is required for database-connected Drizzle commands. " +
      "Do not run migrations through the transaction pooler.",
  );
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    // Offline generation still requires this config field but never connects.
    url: directUrl ?? "postgresql://offline.invalid/offline",
  },
});
