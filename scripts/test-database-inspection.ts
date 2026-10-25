import assert from "node:assert/strict";
import postgres from "postgres";

import { RUNTIME_ROLE_NAME } from "../src/deployment/bootstrap-runtime-role";
import {
  inspectEmptyDatabase,
  type DatabaseInspection,
} from "../src/deployment/database-inspection";

type Fixture = [
  name: string, ddl: string, query: string, cleanup: string,
  category?: keyof DatabaseInspection["stateCounts"],
];

async function main() {
  const directUrl = process.env.DATABASE_INSPECTION_TEST_URL;
  if (!directUrl) throw new Error("DATABASE_INSPECTION_TEST_URL must name the disposable fixture database.");
  const url = new URL(directUrl);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.pathname !== "/bootstrap_inspection") {
    throw new Error("Bootstrap regression only runs against its loopback disposable fixture database.");
  }
  const sql = postgres(directUrl, { max: 1, prepare: false, connect_timeout: 10 });
  const runtimeLoginRole = "bootstrap_inspection_login";
  const options = {
    directUrl, expectedHost: url.hostname, expectedDatabase: "bootstrap_inspection", runtimeLoginRole,
  };
  const snapshot = async () => JSON.stringify({
    relations: await sql`
      SELECT n.nspname, c.relname, c.relkind FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname !~ '^pg_(toast|temp)(_|$)'
      ORDER BY n.nspname, c.relname`,
    roles: await sql`
      SELECT rolname, rolcanlogin, rolsuper, rolcreaterole, rolcreatedb
      FROM pg_roles WHERE rolname IN (${RUNTIME_ROLE_NAME}, ${runtimeLoginRole})
      ORDER BY rolname`,
    database: await sql`
      SELECT datdba, datacl, datconnlimit, datistemplate, datallowconn,
             shobj_description(oid, 'pg_database') AS description
      FROM pg_database WHERE datname = current_database()`,
    publicSchema: await sql`
      SELECT oid, nspname, nspowner, nspacl, obj_description(oid, 'pg_namespace') AS description
      FROM pg_namespace WHERE nspname = 'public'`,
    settings: await sql`
      SELECT setdatabase, setrole, setconfig FROM pg_db_role_setting
      WHERE setdatabase = 0 OR setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
      ORDER BY setdatabase, setrole`,
    largeObjects: await sql`
      SELECT oid, lomowner, lomacl FROM pg_largeobject_metadata ORDER BY oid`,
  });
  const inspect = async (expectedEmpty: boolean) => {
    const before = await snapshot();
    const result = await inspectEmptyDatabase(options);
    assert.equal(result.catalogProfile, "postgresql-17-bootstrap-v2");
    assert.equal(Math.floor(result.serverVersionNum / 10000), 17);
    assert.equal(result.readOnly, true);
    assert.equal(result.empty, expectedEmpty);
    assert.equal(result.objectCount, Object.values(result.stateCounts).reduce((sum, value) => sum + value, 0));
    assert.equal(await snapshot(), before, "Inspection changed retained objects or role attributes.");
    return result;
  };
  const fixture = async ([name, ddl, query, cleanup, category = "catalogObjects"]: Fixture) => {
    let created = false;
    try {
      await sql.unsafe(ddl);
      created = true;
      const rows = JSON.stringify(await sql.unsafe(query));
      const result = await inspect(false);
      assert.ok(result.stateCounts[category] > 0, `${name}: missing ${category} evidence.`);
      assert.equal(JSON.stringify(await sql.unsafe(query)), rows, `${name}: inspection changed fixture rows.`);
      console.log(`Native bootstrap: ${name} refused by ${category}; retained snapshot unchanged.`);
    } finally {
      if (created) await sql.unsafe(cleanup);
    }
    await inspect(true);
  };

  try {
    // Cluster-wide roles must be absent before this fixture owns their creation.
    const roles = await sql`
      SELECT rolname FROM pg_roles WHERE rolname IN (${RUNTIME_ROLE_NAME}, ${runtimeLoginRole})`;
    assert.equal(roles.length, 0, "Use a fresh disposable cluster, before application migrations create runtime roles.");
    const [prepared] = await sql`SELECT current_setting('max_prepared_transactions')::integer AS limit`;
    assert(prepared.limit > 0, "The disposable regression cluster requires max_prepared_transactions >= 1.");
    await inspect(true);
    console.log("Native bootstrap: truly empty database admitted through a read-only transaction.");

    const [extension] = await sql`SELECT oid FROM pg_extension WHERE extname = 'pgcrypto'`;
    if (!extension) await sql`CREATE EXTENSION pgcrypto`;
    try {
      await inspect(true);
      await fixture([
        "table retained inside a platform extension",
        `CREATE TABLE public.bootstrap_extension_state (balance numeric, paused boolean);
         INSERT INTO public.bootstrap_extension_state VALUES (123.456, true);
         ALTER EXTENSION pgcrypto ADD TABLE public.bootstrap_extension_state`,
        "SELECT * FROM public.bootstrap_extension_state",
        `ALTER EXTENSION pgcrypto DROP TABLE public.bootstrap_extension_state;
         DROP TABLE public.bootstrap_extension_state`,
      ]);
      await fixture([
        "application routine retained inside a platform extension",
        `CREATE FUNCTION public.bootstrap_extension_routine() RETURNS integer LANGUAGE sql AS 'SELECT 42';
         ALTER EXTENSION pgcrypto ADD FUNCTION public.bootstrap_extension_routine()`,
        "SELECT prosrc FROM pg_proc WHERE oid = 'public.bootstrap_extension_routine()'::regprocedure",
        `ALTER EXTENSION pgcrypto DROP FUNCTION public.bootstrap_extension_routine();
         DROP FUNCTION public.bootstrap_extension_routine()`,
      ]);
      await fixture([
        "changed platform extension privileges",
        "REVOKE EXECUTE ON FUNCTION public.crypt(text, text) FROM PUBLIC",
        "SELECT proacl FROM pg_proc WHERE oid = 'public.crypt(text, text)'::regprocedure",
        "GRANT EXECUTE ON FUNCTION public.crypt(text, text) TO PUBLIC",
        "privilegeChanges",
      ]);
    } finally {
      if (!extension) await sql`DROP EXTENSION pgcrypto`;
    }
    console.log("Native bootstrap: only the reviewed stateless extension footprint is admitted.");

    const fixtures: Fixture[] = [
      [
        "retained paused paper account",
        `CREATE TABLE public."AgentState" (
          id text PRIMARY KEY, balance numeric NOT NULL, paused boolean NOT NULL
        ); INSERT INTO public."AgentState" VALUES ('singleton', 200.123456789, true)`,
        `SELECT * FROM public."AgentState" ORDER BY id`,
        `DROP TABLE public."AgentState"`,
      ],
      [
        "retained active fence",
        `CREATE TABLE public."DeploymentFence" (
          id text PRIMARY KEY, status text NOT NULL, owner text NOT NULL
        ); INSERT INTO public."DeploymentFence"
          VALUES ('singleton', 'active', 'original-owner')`,
        `SELECT * FROM public."DeploymentFence" ORDER BY id`,
        `DROP TABLE public."DeploymentFence"`,
      ],
      [
        "retained incompatible fence",
        `CREATE TABLE public."DeploymentFence" (legacy_state jsonb);
         INSERT INTO public."DeploymentFence" VALUES ('{"unknownVersion":42,"stopped":true}')`,
        `SELECT * FROM public."DeploymentFence"`,
        `DROP TABLE public."DeploymentFence"`,
      ],
      [
        "retained migration history",
        `CREATE TABLE public.__drizzle_migrations (id integer, hash text);
         INSERT INTO public.__drizzle_migrations VALUES (1, 'previous-source')`,
        "SELECT * FROM public.__drizzle_migrations",
        "DROP TABLE public.__drizzle_migrations",
      ],
      [
        "legacy function",
        "CREATE FUNCTION public.bootstrap_probe_strategy() RETURNS integer LANGUAGE sql AS 'SELECT 1'",
        "SELECT prosrc FROM pg_proc WHERE oid = 'public.bootstrap_probe_strategy()'::regprocedure",
        "DROP FUNCTION public.bootstrap_probe_strategy()",
      ],
      [
        "legacy function in the system namespace",
        "CREATE FUNCTION pg_catalog.bootstrap_probe_legacy() RETURNS integer LANGUAGE sql AS 'SELECT 42'",
        "SELECT prosrc FROM pg_proc WHERE oid = 'pg_catalog.bootstrap_probe_legacy()'::regprocedure",
        "DROP FUNCTION pg_catalog.bootstrap_probe_legacy()",
      ],
      [
        "legacy enum",
        "CREATE TYPE public.bootstrap_probe_mode AS ENUM ('paused', 'shadow')",
        "SELECT enumlabel FROM pg_enum WHERE enumtypid = 'public.bootstrap_probe_mode'::regtype ORDER BY enumsortorder",
        "DROP TYPE public.bootstrap_probe_mode",
      ],
      [
        "legacy schema",
        "CREATE SCHEMA bootstrap_probe_fixture",
        "SELECT nspname FROM pg_namespace WHERE nspname = 'bootstrap_probe_fixture'",
        "DROP SCHEMA bootstrap_probe_fixture",
      ],
      [
        "user schema resembling a toast namespace",
        "CREATE SCHEMA pgxtoast_fixture",
        "SELECT nspname FROM pg_namespace WHERE nspname = 'pgxtoast_fixture'",
        "DROP SCHEMA pgxtoast_fixture",
      ],
      [
        "user schema resembling a temporary namespace",
        "CREATE SCHEMA pgxtemp_fixture",
        "SELECT nspname FROM pg_namespace WHERE nspname = 'pgxtemp_fixture'",
        "DROP SCHEMA pgxtemp_fixture",
      ],
      [
        "empty large object below the ordinary object-ID range",
        "SELECT lo_create(1234)",
        "SELECT oid, lomowner, lomacl FROM pg_largeobject_metadata WHERE oid = 1234",
        "SELECT lo_unlink(1234)",
        "largeObjects",
      ],
      [
        "large-object paper state",
        "SELECT lo_from_bytea(1235, convert_to('balance=123.456;paused=true', 'UTF8'))",
        "SELECT encode(lo_get(1235), 'hex') AS retained_bytes",
        "SELECT lo_unlink(1235)",
        "largeObjects",
      ],
      [
        "database-wide publication without tables",
        "CREATE PUBLICATION bootstrap_fixture_publication FOR ALL TABLES",
        "SELECT pubname, puballtables FROM pg_publication WHERE pubname = 'bootstrap_fixture_publication'",
        "DROP PUBLICATION bootstrap_fixture_publication",
      ],
      [
        "disabled disconnected subscription without tables",
        `CREATE SUBSCRIPTION bootstrap_fixture_subscription
         CONNECTION 'host=127.0.0.1 port=1 dbname=bootstrap_inspection'
         PUBLICATION bootstrap_fixture_source
         WITH (connect = false, enabled = false, create_slot = false, slot_name = NONE)`,
        `SELECT subname, subdbid, subenabled, subslotname, subpublications
         FROM pg_subscription WHERE subname = 'bootstrap_fixture_subscription'`,
        "DROP SUBSCRIPTION bootstrap_fixture_subscription",
      ],
      [
        "foreign data wrapper without any local relations",
        "CREATE FOREIGN DATA WRAPPER bootstrap_fixture_fdw NO HANDLER NO VALIDATOR",
        "SELECT fdwname, fdwhandler, fdwvalidator FROM pg_foreign_data_wrapper WHERE fdwname = 'bootstrap_fixture_fdw'",
        "DROP FOREIGN DATA WRAPPER bootstrap_fixture_fdw",
      ],
      [
        "legacy application role with no remaining tables",
        "CREATE ROLE bootstrap_inspection_legacy NOLOGIN",
        "SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname = 'bootstrap_inspection_legacy'",
        "DROP ROLE bootstrap_inspection_legacy",
      ],
      [
        "replication origin without a subscription or relation",
        "SELECT pg_replication_origin_create('bootstrap_fixture_origin')",
        "SELECT roident, roname FROM pg_replication_origin WHERE roname = 'bootstrap_fixture_origin'",
        "SELECT pg_replication_origin_drop('bootstrap_fixture_origin')",
      ],
      [
        "parameter privileges without any relations",
        "GRANT SET ON PARAMETER log_statement TO PUBLIC",
        "SELECT parname, paracl FROM pg_parameter_acl WHERE parname = 'log_statement'",
        "REVOKE SET ON PARAMETER log_statement FROM PUBLIC",
      ],
      [
        "prepared transaction hiding uncommitted paper state",
        `BEGIN;
         CREATE TABLE public.bootstrap_prepared_state (balance numeric, paused boolean);
         INSERT INTO public.bootstrap_prepared_state VALUES (200.1234, true);
         PREPARE TRANSACTION 'bootstrap_fixture_prepared'`,
        `SELECT gid, owner, database FROM pg_prepared_xacts WHERE gid = 'bootstrap_fixture_prepared'`,
        "ROLLBACK PREPARED 'bootstrap_fixture_prepared'",
      ],
      [
        "cast using only built-in types",
        "CREATE CAST (integer AS text) WITH INOUT",
        "SELECT castcontext, castmethod FROM pg_cast WHERE castsource = 'integer'::regtype AND casttarget = 'text'::regtype",
        "DROP CAST (integer AS text)",
      ],
      [
        "access method using a built-in handler",
        "CREATE ACCESS METHOD bootstrap_fixture_heap TYPE TABLE HANDLER pg_catalog.heap_tableam_handler",
        "SELECT amname, amhandler FROM pg_am WHERE amname = 'bootstrap_fixture_heap'",
        "DROP ACCESS METHOD bootstrap_fixture_heap",
      ],
      [
        "language using existing platform handlers",
        `CREATE LANGUAGE bootstrap_fixture_language HANDLER pg_catalog.plpgsql_call_handler
         INLINE pg_catalog.plpgsql_inline_handler VALIDATOR pg_catalog.plpgsql_validator`,
        "SELECT lanname, lanplcallfoid FROM pg_language WHERE lanname = 'bootstrap_fixture_language'",
        "DROP LANGUAGE bootstrap_fixture_language",
      ],
      [
        "shell type without a backing relation",
        "CREATE TYPE public.bootstrap_fixture_shell",
        "SELECT typname, typisdefined FROM pg_type WHERE typname = 'bootstrap_fixture_shell'",
        "DROP TYPE public.bootstrap_fixture_shell",
      ],
      [
        "collation using a built-in locale",
        'CREATE COLLATION public.bootstrap_fixture_collation FROM pg_catalog."C"',
        "SELECT collname, collprovider, collcollate FROM pg_collation WHERE collname = 'bootstrap_fixture_collation'",
        "DROP COLLATION public.bootstrap_fixture_collation",
      ],
      [
        "operator using only built-in types and functions",
        "CREATE OPERATOR public.=== (LEFTARG = integer, RIGHTARG = integer, FUNCTION = pg_catalog.int4eq)",
        "SELECT oprname, oprcode FROM pg_operator WHERE oprname = '===' AND oprnamespace = 'public'::regnamespace",
        "DROP OPERATOR public.=== (integer, integer)",
      ],
      [
        "operator family without an index or relation",
        "CREATE OPERATOR FAMILY public.bootstrap_fixture_family USING btree",
        "SELECT opfname, opfmethod FROM pg_opfamily WHERE opfname = 'bootstrap_fixture_family'",
        "DROP OPERATOR FAMILY public.bootstrap_fixture_family USING btree",
      ],
      [
        "text search configuration using a built-in parser",
        "CREATE TEXT SEARCH CONFIGURATION public.bootstrap_fixture_search (COPY = pg_catalog.simple)",
        "SELECT cfgname, cfgparser FROM pg_ts_config WHERE cfgname = 'bootstrap_fixture_search'",
        "DROP TEXT SEARCH CONFIGURATION public.bootstrap_fixture_search",
      ],
      [
        "text search dictionary using a built-in template",
        "CREATE TEXT SEARCH DICTIONARY public.bootstrap_fixture_dictionary (TEMPLATE = pg_catalog.simple)",
        "SELECT dictname, dicttemplate FROM pg_ts_dict WHERE dictname = 'bootstrap_fixture_dictionary'",
        "DROP TEXT SEARCH DICTIONARY public.bootstrap_fixture_dictionary",
      ],
      [
        "database settings without any relations",
        "ALTER DATABASE bootstrap_inspection SET statement_timeout = '333ms'",
        "SELECT setconfig FROM pg_db_role_setting WHERE setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())",
        "ALTER DATABASE bootstrap_inspection RESET statement_timeout",
        "databaseSettings",
      ],
      [
        "global login settings",
        "ALTER ROLE CURRENT_USER SET lock_timeout = '333ms'",
        "SELECT setconfig FROM pg_db_role_setting WHERE setdatabase = 0",
        "ALTER ROLE CURRENT_USER RESET lock_timeout",
        "databaseSettings",
      ],
      [
        "default privileges without any relations",
        "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO PUBLIC",
        "SELECT defaclrole, defaclnamespace, defaclobjtype, defaclacl FROM pg_default_acl",
        "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM PUBLIC",
      ],
      [
        "changed database privileges",
        "REVOKE TEMPORARY ON DATABASE bootstrap_inspection FROM PUBLIC",
        "SELECT datacl FROM pg_database WHERE datname = current_database()",
        "GRANT TEMPORARY ON DATABASE bootstrap_inspection TO PUBLIC",
        "privilegeChanges",
      ],
      [
        "changed public-schema privileges",
        "GRANT CREATE ON SCHEMA public TO PUBLIC",
        "SELECT nspacl FROM pg_namespace WHERE nspname = 'public'",
        "REVOKE CREATE ON SCHEMA public FROM PUBLIC",
        "privilegeChanges",
      ],
      [
        "database-level retained annotation",
        "COMMENT ON DATABASE bootstrap_inspection IS 'retained paper-state intent'",
        "SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = current_database()",
        "COMMENT ON DATABASE bootstrap_inspection IS NULL",
        "metadata",
      ],
      [
        "public-schema retained annotation",
        "COMMENT ON SCHEMA public IS 'retained paper-state intent'",
        "SELECT obj_description(oid, 'pg_namespace') FROM pg_namespace WHERE nspname = 'public'",
        "COMMENT ON SCHEMA public IS 'standard public schema'",
        "metadata",
      ],
    ];
    for (const entry of fixtures) await fixture(entry);

    for (const role of [runtimeLoginRole, RUNTIME_ROLE_NAME]) {
      await sql`CREATE ROLE ${sql(role)} NOLOGIN`;
      try {
        const result = await inspect(false);
        assert.equal(result.objectCount, 0, "Role-only fixture must have no application objects.");
        assert.equal(result.runtimeRolePresent, role === RUNTIME_ROLE_NAME);
        assert.equal(result.runtimeLoginPresent, role === runtimeLoginRole);
      } finally {
        await sql`DROP ROLE ${sql(role)}`;
      }
    }
    console.log("Native bootstrap: retained runtime login/group roles refused without changing role attributes.");

    const before = await snapshot();
    await assert.rejects(inspectEmptyDatabase({ ...options, expectedDatabase: "foreign" }), /exact target/);
    const unavailable = new URL(directUrl);
    unavailable.pathname = "/bootstrap_inspection_missing";
    await assert.rejects(inspectEmptyDatabase({
      ...options, directUrl: unavailable.href, expectedDatabase: "bootstrap_inspection_missing",
    }));
    assert.equal(await snapshot(), before);
    await inspect(true);
    console.log("Read-only database bootstrap native regression passed: bound target, explicit failures, unchanged snapshots.");
  } finally {
    await sql.end({ timeout: 1 });
  }
}

main().catch((error: unknown) => {
  console.error("Read-only database bootstrap native regression failed; no application target was admitted.");
  if (error instanceof assert.AssertionError) console.error(error.message);
  else if (error instanceof Error) console.error(`Failure type: ${error.name}`);
  process.exitCode = 1;
});
