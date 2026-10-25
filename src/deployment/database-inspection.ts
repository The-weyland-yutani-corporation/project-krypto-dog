import postgres from "postgres";

import {
  isValidRoleIdentifier,
  RUNTIME_ROLE_NAME,
} from "./bootstrap-runtime-role";

export type DatabaseInspectionOptions = {
  directUrl: string;
  expectedHost: string;
  expectedDatabase: string;
  runtimeLoginRole: string;
};

export type DatabaseInspection = {
  databaseHost: string;
  databaseName: string;
  runtimeLoginRole: string;
  observedAt: string;
  readOnly: true;
  objectCount: number;
  runtimeRolePresent: boolean;
  runtimeLoginPresent: boolean;
  empty: boolean;
};

function validateConnection(options: DatabaseInspectionOptions): URL {
  let url: URL;
  try {
    url = new URL(options.directUrl);
  } catch {
    throw new Error("Database inspection requires a valid PostgreSQL URL.");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol) ||
      !/^[a-z0-9][a-z0-9.-]{0,252}$/.test(options.expectedHost) ||
      !isValidRoleIdentifier(options.expectedDatabase) ||
      !isValidRoleIdentifier(options.runtimeLoginRole) ||
      options.runtimeLoginRole === RUNTIME_ROLE_NAME ||
      url.hostname !== options.expectedHost ||
      decodeURIComponent(url.pathname) !== `/${options.expectedDatabase}` ||
      !url.username || url.hash ||
      [...url.searchParams.keys()].some((name) => name !== "sslmode") ||
      url.searchParams.getAll("sslmode").length > 1 ||
      (options.expectedHost.endsWith(".postgres.database.azure.com") &&
        ((url.port !== "" && url.port !== "5432") ||
        !["require", "verify-ca", "verify-full"].includes(
          url.searchParams.get("sslmode") ?? "",
        )))) {
    throw new Error("Database inspection connection does not match its exact target.");
  }
  return url;
}

export async function inspectEmptyDatabase(
  options: DatabaseInspectionOptions,
): Promise<DatabaseInspection> {
  const url = validateConnection(options);
  const sql = postgres(url.href, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 2,
    connection: {
      statement_timeout: 5_000,
      lock_timeout: 5_000,
      application_name: "krypto-readonly-bootstrap",
    },
  });
  try {
    return await sql.begin("isolation level repeatable read read only", async (transaction) => {
      await transaction.unsafe("SET LOCAL search_path = pg_catalog");
      const identity = await transaction.unsafe<Array<{
        database: string;
        username: string;
        readOnly: string;
      }>>(`SELECT current_database() AS database, session_user AS username,
                  current_setting('transaction_read_only') AS "readOnly"`);
      if (identity.length !== 1 ||
          identity[0].database !== options.expectedDatabase ||
          identity[0].username !== decodeURIComponent(url.username) ||
          identity[0].readOnly !== "on") {
        throw new Error("Database inspection could not establish a read-only target.");
      }

      // Extension-owned objects are platform state, not application initialization.
      const result = await transaction.unsafe<Array<{
        objectCount: number;
        runtimeRolePresent: boolean;
        runtimeLoginPresent: boolean;
        observedAt: Date;
      }>>(`
        WITH user_namespaces AS (
          SELECT oid, nspname FROM pg_namespace
          WHERE nspname NOT IN ('pg_catalog', 'information_schema')
            AND nspname !~ '^pg_(toast|temp)(_|$)'
        ), objects AS (
          SELECT 'pg_class'::regclass AS classid, c.oid AS objid
          FROM pg_class c JOIN user_namespaces n ON n.oid = c.relnamespace
          UNION ALL
          SELECT 'pg_proc'::regclass, p.oid
          FROM pg_proc p JOIN user_namespaces n ON n.oid = p.pronamespace
          UNION ALL
          SELECT 'pg_type'::regclass, t.oid
          FROM pg_type t JOIN user_namespaces n ON n.oid = t.typnamespace
          WHERE t.typtype IN ('d', 'e', 'r', 'm')
          UNION ALL
          SELECT 'pg_namespace'::regclass, n.oid
          FROM user_namespaces n WHERE n.nspname <> 'public'
        )
        SELECT
          (SELECT count(*)::integer FROM objects o
            WHERE NOT EXISTS (
              SELECT 1 FROM pg_depend d
              WHERE d.classid = o.classid AND d.objid = o.objid
                AND d.refclassid = 'pg_extension'::regclass AND d.deptype = 'e'
            )) AS "objectCount",
          EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS "runtimeRolePresent",
          EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $2) AS "runtimeLoginPresent",
          clock_timestamp() AS "observedAt"
      `, [RUNTIME_ROLE_NAME, options.runtimeLoginRole]);
      const row = result[0];
      if (result.length !== 1 || !row ||
          !Number.isSafeInteger(row.objectCount) || row.objectCount < 0 ||
          typeof row.runtimeRolePresent !== "boolean" ||
          typeof row.runtimeLoginPresent !== "boolean" ||
          !(row.observedAt instanceof Date) ||
          !Number.isFinite(row.observedAt.getTime())) {
        throw new Error("Database inspection returned incomplete catalog evidence.");
      }
      return {
        databaseHost: options.expectedHost,
        databaseName: options.expectedDatabase,
        runtimeLoginRole: options.runtimeLoginRole,
        observedAt: row.observedAt.toISOString(),
        readOnly: true as const,
        objectCount: row.objectCount,
        runtimeRolePresent: row.runtimeRolePresent,
        runtimeLoginPresent: row.runtimeLoginPresent,
        empty: row.objectCount === 0 &&
          !row.runtimeRolePresent && !row.runtimeLoginPresent,
      };
    });
  } finally {
    await sql.end({ timeout: 1 });
  }
}
