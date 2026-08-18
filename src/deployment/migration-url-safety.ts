/**
 * Shared, dependency-free validation for the dedicated `MIGRATION_URL`
 * connection string (see GitHub issue #133 and
 * drizzle/0008_postgresql_trust_boundaries.sql). Migrations must run as
 * the least-privilege `krypto_migrator` role over a direct (non-pooled)
 * connection distinct from both `DIRECT_URL` (the admin/operator
 * connection) and `DATABASE_URL` (the application runtime connection).
 *
 * This module has no dependency on the `postgres` package or any other
 * project code so it can be imported directly by `drizzle.config.ts`
 * (loaded by drizzle-kit's own bundler, outside this project's normal
 * TypeScript path-alias resolution) as well as by
 * `src/deployment/preflight.ts` (which additionally verifies the
 * database-observed `current_user` against this same expected identity).
 */

export interface MigrationUrlSafetyInput {
  migrationUrl: string;
  directUrl?: string;
  runtimeUrl?: string;
  /** The exact database role migrations must authenticate as, e.g. "krypto_migrator". */
  expectedUsername?: string;
}

export interface MigrationUrlSafetyResult {
  safe: boolean;
  reasons: string[];
}

const POOLER_HOSTNAME_PATTERN = /pooler/i;
const POOLER_PORTS = new Set(["6543"]);

function tryParseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/**
 * Returns `{ safe: false, reasons: [...] }` with a human-readable reason
 * for every safety violation found, or `{ safe: true, reasons: [] }` when
 * none are found. Never throws: an invalid `MIGRATION_URL` is itself
 * reported as an unsafe reason rather than an exception, so callers can
 * decide how to fail (both current callers choose to throw).
 */
export function classifyMigrationUrlSafety(
  input: MigrationUrlSafetyInput,
): MigrationUrlSafetyResult {
  const reasons: string[] = [];

  const migration = tryParseUrl(input.migrationUrl);
  if (!migration) {
    return {
      safe: false,
      reasons: ["MIGRATION_URL is not a valid connection URL."],
    };
  }

  const migrationUsername = decodeURIComponent(migration.username);

  if (POOLER_HOSTNAME_PATTERN.test(migration.hostname)) {
    reasons.push(
      `MIGRATION_URL's host (${migration.hostname}) looks like a transaction ` +
        "pooler; migrations must run against a direct (non-pooled) connection.",
    );
  }
  if (POOLER_PORTS.has(migration.port)) {
    reasons.push(
      `MIGRATION_URL's port (${migration.port}) is a conventional pooler ` +
        "port; migrations must run against a direct (non-pooled) connection.",
    );
  }
  if (migration.searchParams.get("pgbouncer") === "true") {
    reasons.push(
      "MIGRATION_URL sets pgbouncer=true; migrations must run against a " +
        "direct (non-pooled) connection.",
    );
  }
  if (
    input.expectedUsername &&
    migrationUsername !== input.expectedUsername
  ) {
    reasons.push(
      `MIGRATION_URL's username (${migrationUsername || "<empty>"}) is not ` +
        `${input.expectedUsername}; migrations must authenticate as the ` +
        "dedicated migrator role.",
    );
  }

  if (input.directUrl) {
    const direct = tryParseUrl(input.directUrl);
    if (direct) {
      if (migration.toString() === direct.toString()) {
        reasons.push(
          "MIGRATION_URL is identical to DIRECT_URL; migrations must run " +
            "as the dedicated migrator role, not the admin/operator role.",
        );
      } else if (
        migrationUsername &&
        migrationUsername === decodeURIComponent(direct.username)
      ) {
        reasons.push(
          "MIGRATION_URL's username matches DIRECT_URL's username; " +
            "migrations must run as a distinct, least-privilege role.",
        );
      }
    }
  }

  if (input.runtimeUrl) {
    const runtime = tryParseUrl(input.runtimeUrl);
    if (runtime) {
      if (migration.toString() === runtime.toString()) {
        reasons.push(
          "MIGRATION_URL is identical to DATABASE_URL; migrations must " +
            "not run as the application runtime role.",
        );
      } else if (
        migrationUsername &&
        migrationUsername === decodeURIComponent(runtime.username)
      ) {
        reasons.push(
          "MIGRATION_URL's username matches DATABASE_URL's username; " +
            "migrations must not run as the application runtime role.",
        );
      }
    }
  }

  return { safe: reasons.length === 0, reasons };
}
