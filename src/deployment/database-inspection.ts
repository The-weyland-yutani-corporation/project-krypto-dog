import postgres from "postgres";
import { z } from "zod";

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

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const stateCountsSchema = z.object({
  catalogObjects: count,
  largeObjects: count,
  databaseSettings: count,
  privilegeChanges: count,
  metadata: count,
}).strict();

export type DatabaseInspection = {
  catalogProfile: "postgresql-17-bootstrap-v2";
  serverVersionNum: number;
  databaseHost: string;
  databaseName: string;
  runtimeLoginRole: string;
  observedAt: string;
  readOnly: true;
  stateCounts: z.infer<typeof stateCountsSchema>;
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
        serverVersionNum: number;
      }>>(`SELECT current_database() AS database, session_user AS username,
                  current_setting('transaction_read_only') AS "readOnly",
                  current_setting('server_version_num')::integer AS "serverVersionNum"`);
      if (identity.length !== 1 ||
          identity[0].database !== options.expectedDatabase ||
          identity[0].username !== decodeURIComponent(url.username) ||
          identity[0].readOnly !== "on") {
        throw new Error("Database inspection could not establish a read-only target.");
      }
      if (!Number.isSafeInteger(identity[0].serverVersionNum) ||
          identity[0].serverVersionNum < 170000 || identity[0].serverVersionNum >= 180000) {
        throw new Error("Database inspection requires the validated PostgreSQL 17 catalog profile.");
      }

      // PostgreSQL 17 reserves OIDs below 16384 for initdb, not normal DDL.
      // pg_depend omits pinned references; it is not an inventory of user objects.
      const result = await transaction.unsafe<Array<{
        stateCounts: unknown;
        runtimeRolePresent: boolean;
        runtimeLoginPresent: boolean;
        observedAt: Date;
      }>>(`
        WITH inspected_database AS (
          SELECT * FROM pg_database WHERE datname = current_database()
        ), user_namespaces AS (
          SELECT oid, nspname FROM pg_namespace
          WHERE nspname !~ '^pg_(toast|temp)(_|$)'
        ), allowed_extensions AS (
          SELECT oid, extname FROM pg_extension
          WHERE (extname, extversion) IN (('plpgsql', '1.0'), ('pgcrypto', '1.3'))
            AND extconfig IS NULL AND extcondition IS NULL
        ), allowed_extension_objects AS (
          SELECT 'pg_extension'::regclass AS classid, oid AS objid
          FROM allowed_extensions
          UNION ALL
          SELECT d.classid, d.objid FROM pg_depend d
          JOIN allowed_extensions e ON d.refobjid = e.oid
          JOIN pg_proc p ON d.classid = 'pg_proc'::regclass AND p.oid = d.objid
          JOIN pg_language l ON l.oid = p.prolang
          WHERE d.refclassid = 'pg_extension'::regclass AND d.deptype = 'e'
            AND l.lanname = 'c' AND p.prokind = 'f' AND p.proconfig IS NULL
            AND ((e.extname = 'pgcrypto' AND p.probin = '$libdir/pgcrypto')
              OR (e.extname = 'plpgsql' AND p.probin = '$libdir/plpgsql'))
          UNION ALL
          SELECT d.classid, d.objid FROM pg_depend d
          JOIN allowed_extensions e ON d.refobjid = e.oid AND e.extname = 'plpgsql'
          JOIN pg_language l ON d.classid = 'pg_language'::regclass AND l.oid = d.objid
          WHERE d.refclassid = 'pg_extension'::regclass AND d.deptype = 'e'
            AND l.lanname = 'plpgsql' AND l.lanpltrusted
        ), objects AS (
          SELECT 'pg_class'::regclass AS classid, c.oid AS objid
          FROM pg_class c JOIN user_namespaces n ON n.oid = c.relnamespace
          WHERE c.oid >= 16384 AND c.relpersistence <> 't'
          UNION ALL
          SELECT 'pg_proc'::regclass, p.oid
          FROM pg_proc p JOIN user_namespaces n ON n.oid = p.pronamespace
          WHERE p.oid >= 16384
          UNION ALL
          SELECT 'pg_type'::regclass, t.oid
          FROM pg_type t JOIN user_namespaces n ON n.oid = t.typnamespace
          WHERE t.oid >= 16384
          UNION ALL
          SELECT 'pg_namespace'::regclass, n.oid
          FROM user_namespaces n WHERE n.oid >= 16384
          UNION ALL SELECT 'pg_authid'::regclass, oid FROM pg_roles
            WHERE oid >= 16384 AND rolname NOT IN (session_user, 'azure_pg_admin', 'azuresu', $1, $2)
          UNION ALL SELECT 'pg_am'::regclass, oid FROM pg_am WHERE oid >= 16384
          UNION ALL SELECT 'pg_amop'::regclass, oid FROM pg_amop WHERE oid >= 16384
          UNION ALL SELECT 'pg_amproc'::regclass, oid FROM pg_amproc WHERE oid >= 16384
          UNION ALL SELECT 'pg_attrdef'::regclass, oid FROM pg_attrdef WHERE oid >= 16384
          UNION ALL SELECT 'pg_cast'::regclass, oid FROM pg_cast WHERE oid >= 16384
          UNION ALL SELECT 'pg_collation'::regclass, oid FROM pg_collation WHERE oid >= 16384
          UNION ALL SELECT 'pg_constraint'::regclass, oid FROM pg_constraint WHERE oid >= 16384
          UNION ALL SELECT 'pg_conversion'::regclass, oid FROM pg_conversion WHERE oid >= 16384
          UNION ALL SELECT 'pg_default_acl'::regclass, oid FROM pg_default_acl
          UNION ALL SELECT 'pg_event_trigger'::regclass, oid FROM pg_event_trigger
          UNION ALL SELECT 'pg_extension'::regclass, oid FROM pg_extension
          UNION ALL SELECT 'pg_foreign_data_wrapper'::regclass, oid FROM pg_foreign_data_wrapper
          UNION ALL SELECT 'pg_foreign_server'::regclass, oid FROM pg_foreign_server
          UNION ALL SELECT 'pg_user_mapping'::regclass, oid FROM pg_user_mapping
          UNION ALL SELECT 'pg_language'::regclass, oid FROM pg_language
            WHERE oid >= 16384 OR lanname NOT IN ('internal', 'c', 'sql', 'plpgsql')
          UNION ALL SELECT 'pg_operator'::regclass, oid FROM pg_operator WHERE oid >= 16384
          UNION ALL SELECT 'pg_opclass'::regclass, oid FROM pg_opclass WHERE oid >= 16384
          UNION ALL SELECT 'pg_opfamily'::regclass, oid FROM pg_opfamily WHERE oid >= 16384
          UNION ALL SELECT 'pg_parameter_acl'::regclass, oid FROM pg_parameter_acl WHERE paracl IS NOT NULL
          UNION ALL SELECT 'pg_policy'::regclass, oid FROM pg_policy
          UNION ALL SELECT 'pg_publication'::regclass, oid FROM pg_publication
          UNION ALL SELECT 'pg_publication_namespace'::regclass, oid FROM pg_publication_namespace
          UNION ALL SELECT 'pg_publication_rel'::regclass, oid FROM pg_publication_rel
          UNION ALL SELECT 'pg_rewrite'::regclass, oid FROM pg_rewrite WHERE oid >= 16384
          UNION ALL SELECT 'pg_replication_origin'::regclass, roident FROM pg_replication_origin
          UNION ALL SELECT 'pg_statistic_ext'::regclass, oid FROM pg_statistic_ext
          UNION ALL SELECT 'pg_subscription'::regclass, oid FROM pg_subscription
            WHERE subdbid = (SELECT oid FROM inspected_database)
          UNION ALL SELECT 'pg_transform'::regclass, oid FROM pg_transform WHERE oid >= 16384
          UNION ALL SELECT 'pg_trigger'::regclass, oid FROM pg_trigger WHERE oid >= 16384
          UNION ALL SELECT 'pg_ts_config'::regclass, oid FROM pg_ts_config WHERE oid >= 16384
          UNION ALL SELECT 'pg_ts_dict'::regclass, oid FROM pg_ts_dict WHERE oid >= 16384
          UNION ALL SELECT 'pg_ts_parser'::regclass, oid FROM pg_ts_parser WHERE oid >= 16384
          UNION ALL SELECT 'pg_ts_template'::regclass, oid FROM pg_ts_template WHERE oid >= 16384
          UNION ALL SELECT 'pg_database'::regclass, (SELECT oid FROM inspected_database)
            FROM pg_prepared_xacts WHERE database = current_database()
        ), privileges AS (
          SELECT coalesce(datacl, acldefault('d', datdba)) AS actual,
                 acldefault('d', datdba) AS expected
          FROM inspected_database
          UNION ALL
          SELECT coalesce(nspacl, acldefault('n', nspowner)),
                 ARRAY['pg_database_owner=UC/pg_database_owner',
                       '=U/pg_database_owner']::aclitem[]
          FROM pg_namespace WHERE oid = 2200 AND nspname = 'public'
          UNION ALL
          SELECT coalesce(p.proacl, acldefault('f', p.proowner)),
                 coalesce(i.initprivs, acldefault('f', p.proowner))
          FROM pg_proc p
          JOIN allowed_extension_objects a ON a.classid = 'pg_proc'::regclass AND a.objid = p.oid
          LEFT JOIN pg_init_privs i ON i.classoid = 'pg_proc'::regclass
            AND i.objoid = p.oid AND i.objsubid = 0
        ), counts AS (
          SELECT
            (SELECT count(*)::integer FROM objects o WHERE NOT EXISTS (
              SELECT 1 FROM allowed_extension_objects a
              WHERE a.classid = o.classid AND a.objid = o.objid
            )) AS "catalogObjects",
            (SELECT count(*)::integer FROM pg_largeobject_metadata) AS "largeObjects",
            (SELECT count(*)::integer FROM pg_db_role_setting
              WHERE setdatabase = 0 OR setdatabase = (SELECT oid FROM inspected_database)
            ) AS "databaseSettings",
            ((SELECT count(*)::integer FROM privileges
              WHERE NOT (actual @> expected AND expected @> actual))
              + CASE WHEN EXISTS (
                SELECT 1 FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner
                WHERE n.oid = 2200 AND n.nspname = 'public' AND r.rolname = 'pg_database_owner'
              ) THEN 0 ELSE 1 END
              + CASE WHEN EXISTS (
                SELECT 1 FROM inspected_database d JOIN pg_roles r ON r.oid = d.datdba
                WHERE r.rolname IN (session_user, 'azure_pg_admin')
                  AND NOT d.datistemplate AND d.datallowconn AND d.datconnlimit = -1
              ) THEN 0 ELSE 1 END
            ) AS "privilegeChanges",
            ((SELECT count(*)::integer FROM pg_description d
              WHERE d.objoid >= 16384 AND NOT EXISTS (
                SELECT 1 FROM allowed_extension_objects a
                WHERE a.classid = d.classoid AND a.objid = d.objoid
              ))
              + (SELECT count(*)::integer FROM pg_seclabel)
              + (SELECT count(*)::integer FROM pg_shdescription
                  WHERE classoid = 'pg_database'::regclass
                    AND objoid = (SELECT oid FROM inspected_database))
              + (SELECT count(*)::integer FROM pg_shseclabel
                  WHERE classoid = 'pg_database'::regclass
                    AND objoid = (SELECT oid FROM inspected_database))
              + CASE WHEN obj_description(2200, 'pg_namespace') = 'standard public schema'
                THEN 0 ELSE 1 END
            ) AS metadata
        )
        SELECT
          row_to_json(counts) AS "stateCounts",
          EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS "runtimeRolePresent",
          EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $2) AS "runtimeLoginPresent",
          clock_timestamp() AS "observedAt"
        FROM counts
      `, [RUNTIME_ROLE_NAME, options.runtimeLoginRole]);
      const row = result[0];
      const parsedCounts = stateCountsSchema.safeParse(row?.stateCounts);
      if (result.length !== 1 || !row ||
          !parsedCounts.success ||
          typeof row.runtimeRolePresent !== "boolean" ||
          typeof row.runtimeLoginPresent !== "boolean" ||
          !(row.observedAt instanceof Date) ||
          !Number.isFinite(row.observedAt.getTime())) {
        throw new Error("Database inspection returned incomplete catalog evidence.");
      }
      const stateCounts = parsedCounts.data;
      const objectCount = Object.values(stateCounts).reduce((total, value) => total + value, 0);
      if (!Number.isSafeInteger(objectCount)) {
        throw new Error("Database inspection returned an unbounded retained-state count.");
      }
      return {
        catalogProfile: "postgresql-17-bootstrap-v2",
        serverVersionNum: identity[0].serverVersionNum,
        databaseHost: options.expectedHost,
        databaseName: options.expectedDatabase,
        runtimeLoginRole: options.runtimeLoginRole,
        observedAt: row.observedAt.toISOString(),
        readOnly: true as const,
        stateCounts,
        objectCount,
        runtimeRolePresent: row.runtimeRolePresent,
        runtimeLoginPresent: row.runtimeLoginPresent,
        empty: objectCount === 0 &&
          !row.runtimeRolePresent && !row.runtimeLoginPresent,
      };
    });
  } finally {
    await sql.end({ timeout: 1 });
  }
}
