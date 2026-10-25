import assert from "node:assert/strict";
import postgres from "postgres";

import { RUNTIME_ROLE_NAME } from "../src/deployment/bootstrap-runtime-role";
import { inspectEmptyDatabase } from "../src/deployment/database-inspection";

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
  });
  const inspect = async (expectedEmpty: boolean) => {
    const before = await snapshot();
    const result = await inspectEmptyDatabase(options);
    assert.equal(result.readOnly, true);
    assert.equal(result.empty, expectedEmpty);
    assert.equal(await snapshot(), before, "Inspection changed retained objects or role attributes.");
    return result;
  };

  try {
    // Cluster-wide roles must be absent before this fixture owns their creation.
    const roles = await sql`
      SELECT rolname FROM pg_roles WHERE rolname IN (${RUNTIME_ROLE_NAME}, ${runtimeLoginRole})`;
    assert.equal(roles.length, 0, "Use a fresh disposable cluster, before application migrations create runtime roles.");
    await inspect(true);
    console.log("Native bootstrap: truly empty database admitted through a read-only transaction.");

    const [extension] = await sql`SELECT oid FROM pg_extension WHERE extname = 'pgcrypto'`;
    if (!extension) await sql`CREATE EXTENSION pgcrypto`;
    try {
      await inspect(true);
    } finally {
      if (!extension) await sql`DROP EXTENSION pgcrypto`;
    }
    console.log("Native bootstrap: platform-owned extension objects do not impersonate application state.");

    for (const [name, ddl, query, cleanup] of [
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
    ]) {
      let created = false;
      try {
        await sql.unsafe(ddl);
        created = true;
        const rows = JSON.stringify(await sql.unsafe(query));
        const result = await inspect(false);
        assert.ok(result.objectCount > 0);
        assert.equal(JSON.stringify(await sql.unsafe(query)), rows, `${name}: inspection changed fixture rows.`);
        console.log(`Native bootstrap: ${name} refused; retained snapshot unchanged.`);
      } finally {
        if (created) await sql.unsafe(cleanup);
      }
    }

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
