import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export const DB_CONNECT_TIMEOUT_SECONDS = 5;
export const DB_IDLE_TIMEOUT_SECONDS = 20;
export const DB_MAX_LIFETIME_SECONDS = 300;
export const DB_STATEMENT_TIMEOUT_MS = 10_000;
export const DB_LOCK_TIMEOUT_MS = 2_000;
export const DB_IDLE_TRANSACTION_TIMEOUT_MS = 15_000;

export interface DatabaseRuntimeConfig {
  connectionString: string;
  poolMax: number;
}

export function resolveDatabaseRuntimeConfig(
  env: Record<string, string | undefined> = process.env,
): DatabaseRuntimeConfig {
  const connectionString = env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error("DATABASE_URL is required; database access fails closed");
  }
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    !parsed.username
  ) {
    throw new Error(
      "DATABASE_URL must identify a PostgreSQL host and runtime login",
    );
  }

  const rawPoolMax = env.DATABASE_POOL_MAX;
  const poolMax =
    rawPoolMax === undefined && env.NODE_ENV !== "production"
      ? 1
      : Number(rawPoolMax);
  if (
    !Number.isSafeInteger(poolMax) ||
    poolMax < 1 ||
    poolMax > 10 ||
    (env.NODE_ENV === "production" && poolMax !== 1)
  ) {
    throw new Error(
      "DATABASE_POOL_MAX must be exactly 1 in production",
    );
  }
  return { connectionString, poolMax };
}

const runtimeConfig = resolveDatabaseRuntimeConfig();

export const databaseClient = postgres(runtimeConfig.connectionString, {
  max: runtimeConfig.poolMax,
  idle_timeout: DB_IDLE_TIMEOUT_SECONDS,
  connect_timeout: DB_CONNECT_TIMEOUT_SECONDS,
  max_lifetime: DB_MAX_LIFETIME_SECONDS,
  prepare: false,
  connection: {
    application_name: "project-krypto-runtime",
    statement_timeout: DB_STATEMENT_TIMEOUT_MS,
    lock_timeout: DB_LOCK_TIMEOUT_MS,
    idle_in_transaction_session_timeout:
      DB_IDLE_TRANSACTION_TIMEOUT_MS,
  },
});

export const db = drizzle(databaseClient, { schema });

export async function closeDatabase(): Promise<void> {
  await databaseClient.end({ timeout: 5 });
}
