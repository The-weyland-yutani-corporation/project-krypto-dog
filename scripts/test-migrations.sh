#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMP_DIR="$(mktemp -d)"
PORT="$(node -e "const net=require('net');const server=net.createServer();server.listen(0,'127.0.0.1',()=>{console.log(server.address().port);server.close();});")"
PGDATA="$TEMP_DIR/postgres"
PGLOG="$TEMP_DIR/postgres.log"
TEST_POSTGRES_ADMIN_URL="${TEST_POSTGRES_ADMIN_URL:-}"

cleanup() {
  if [[ -f "$PGDATA/postmaster.pid" ]]; then
    pg_ctl -D "$PGDATA" -m fast -w stop >/dev/null
  fi
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

required_commands=(psql node npx pg_dump pg_restore createdb dropdb)
if [[ -z "$TEST_POSTGRES_ADMIN_URL" ]]; then
  required_commands+=(initdb pg_ctl)
fi
for command in "${required_commands[@]}"; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Missing required migration-test command: $command" >&2
    exit 1
  fi
done

cd "$ROOT_DIR"
if [[ -n "$TEST_POSTGRES_ADMIN_URL" ]]; then
  admin_url="$TEST_POSTGRES_ADMIN_URL"
  url_prefix="${admin_url%/*}"
else
  initdb -D "$PGDATA" --auth=trust --username=postgres >/dev/null
  pg_ctl -D "$PGDATA" \
    -l "$PGLOG" \
    -o "-F -p $PORT -h 127.0.0.1" \
    -w start >/dev/null
  admin_url="postgresql://postgres@127.0.0.1:$PORT/postgres"
  url_prefix="postgresql://postgres@127.0.0.1:$PORT"
fi

postgres_version_num="$(psql "$admin_url" -Atc "SHOW server_version_num;")"
if (( postgres_version_num < 170000 || postgres_version_num >= 180000 )); then
  echo "Migration tests require PostgreSQL 17.x, found server_version_num=$postgres_version_num" >&2
  exit 1
fi

fresh_url="$url_prefix/fresh"
upgrade_url="$url_prefix/upgrade"
quarantine_url="$url_prefix/quarantine"
executor_url="$url_prefix/executor"
orchestration_url="$url_prefix/orchestration"
operations_url="$url_prefix/operations"
migration_only_url="$url_prefix/migration_only"
rollout_upgrade_url="$url_prefix/rollout_upgrade"
azure_target_url="$url_prefix/azure_target"
azure_upgrade_url="$url_prefix/azure_upgrade"
trust_boundary_denial_url="$url_prefix/trust_boundary_denial"
safety_upgrade_url="$url_prefix/safety_upgrade"

create_database() {
  psql "$admin_url" -v ON_ERROR_STOP=1 \
    -c "CREATE DATABASE \"$1\";" >/dev/null
}

# Rewrites $1 (a full connection URL) to use username $2 and password $3,
# via real URL parsing rather than string substitution, so it stays correct
# regardless of the original (possibly externally-supplied,
# TEST_POSTGRES_ADMIN_URL-derived) credentials embedded in the base URL.
with_role_credentials() {
  node -e '
    const u = new URL(process.argv[1]);
    u.username = process.argv[2];
    u.password = process.argv[3];
    process.stdout.write(u.toString());
  ' "$1" "$2" "$3"
}

# Runs the protected, admin/DIRECT_URL-only database-role bootstrap (see
# GitHub issue #133 and drizzle/0008_postgresql_trust_boundaries.sql --
# creates/converges krypto_schema_owner, krypto_migrator, krypto_scheduler,
# krypto_runtime, and transfers pre-existing krypto/drizzle ownership on an
# upgrade) against $1 with krypto_migrator password $2, then migrates $1 to
# the full/default migration set authenticated as the resulting
# krypto_migrator role via its own dedicated MIGRATION_URL -- never
# DIRECT_URL and never a pooler/runtime URL. Any remaining arguments are
# forwarded to `drizzle-kit migrate` (for example `--config <path>` for a
# pinned historical migration set). Generated historical configs prefer
# MIGRATION_URL when supplied, preserving the same dedicated migrator
# boundary as the default project config. This mirrors exactly how a real
# Azure release runs migrate-init: the admin bootstrap always precedes
# drizzle-kit migrate.
bootstrap_and_migrate() {
  local direct_url="$1"
  local migrator_password="$2"
  shift 2
  DIRECT_URL="$direct_url" KRYPTO_MIGRATOR_LOGIN_PASSWORD="$migrator_password" \
    npx tsx scripts/bootstrap-azure-runtime-role.ts --mode database-roles >/dev/null
  local migration_url
  migration_url="$(with_role_credentials "$direct_url" krypto_migrator "$migrator_password")"
  DIRECT_URL="$direct_url" MIGRATION_URL="$migration_url" \
    npx drizzle-kit migrate "$@" >/dev/null
  # A second admin bootstrap is the protected post-migration finalizer: once
  # the krypto/drizzle schemas exist it revokes the migrator's temporary
  # public-schema CREATE grant and removes temporary operator memberships.
  DIRECT_URL="$direct_url" KRYPTO_MIGRATOR_LOGIN_PASSWORD="$migrator_password" \
    npx tsx scripts/bootstrap-azure-runtime-role.ts --mode database-roles >/dev/null
}

random_test_password() {
  node -e 'console.log(Math.random().toString(36).slice(2))'
}

# Builds a Drizzle config whose `out` directory only contains migrations up
# to (and including) journal index $1, tagged with suffix $2. This lets
# scenarios that intentionally exercise a specific historical migration
# state (e.g. "current as of 0006") stay pinned to that state regardless of
# which migrations have since been added to drizzle/ (such as 0007's
# retirement of the obsolete Supabase HTTP cron functions). Echoes the path
# to the generated config file.
build_through_config() {
  local max_idx="$1"
  local suffix="$2"
  local migration_dir="$TEMP_DIR/drizzle-through-$suffix"
  local config_path="$TEMP_DIR/drizzle-through-$suffix.config.ts"
  node - "$ROOT_DIR" "$migration_dir" "$config_path" "$max_idx" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const root = process.argv[2];
const migrationDir = process.argv[3];
const configPath = process.argv[4];
const maxIdx = Number(process.argv[5]);
const sourceDir = path.join(root, "drizzle");
const journal = JSON.parse(
  fs.readFileSync(path.join(sourceDir, "meta", "_journal.json"), "utf8"),
);

journal.entries = journal.entries.filter((entry) => entry.idx <= maxIdx);
fs.mkdirSync(path.join(migrationDir, "meta"), { recursive: true });
for (const entry of journal.entries) {
  fs.copyFileSync(
    path.join(sourceDir, `${entry.tag}.sql`),
    path.join(migrationDir, `${entry.tag}.sql`),
  );
  const snapshot = `${String(entry.idx).padStart(4, "0")}_snapshot.json`;
  fs.copyFileSync(
    path.join(sourceDir, "meta", snapshot),
    path.join(migrationDir, "meta", snapshot),
  );
}
fs.writeFileSync(
  path.join(migrationDir, "meta", "_journal.json"),
  JSON.stringify(journal, null, 2),
);
fs.writeFileSync(
  configPath,
  `export default {
  schema: ${JSON.stringify(path.join(root, "src", "db", "schema.ts"))},
  out: ${JSON.stringify(migrationDir)},
  dialect: "postgresql",
  dbCredentials: { url: process.env.MIGRATION_URL ?? process.env.DIRECT_URL },
};
`,
);
NODE
  echo "$config_path"
}

# Pinned to the pre-Azure-transition (0006-current) migration set. Several
# scenarios below intentionally emulate a Supabase target still relying on
# the now-retired pg_cron/pg_net HTTP-invocation functions; pinning keeps
# that emulation valid regardless of what is newest in drizzle/.
through_0006_config="$(build_through_config 6 0006)"

# The legacy hand-rolled "public" schema fixtures below (tests/fixtures/
# v2-schema.sql) predate the Drizzle migration system entirely, so their
# tables are owned by the admin identity itself, not any krypto_*
# role -- exactly like a real environment the very first time it ever
# runs `drizzle-kit migrate`, before drizzle/0008's trust boundary can
# apply (that migration only reassigns ownership of objects already
# inside the "krypto"/"drizzle" schemas, which do not exist yet here).
# These two scenarios intentionally stay pinned through 0007 and keep
# running as the admin identity directly, matching how this project's own
# history actually reached this point; the dedicated krypto_migrator
# trust-boundary proof lives in the Azure fresh-install/upgrade sections
# below instead, where "krypto"/"drizzle" already exist and ownership
# transfer is exercised for real.
through_0007_legacy_config="$(build_through_config 7 0007legacy)"
through_0009_config="$(build_through_config 9 0009)"

psql "$admin_url" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END
$$;
SQL

create_database fresh
DIRECT_URL="$fresh_url" \
  npx drizzle-kit migrate --config "$through_0006_config" >/dev/null

fresh_migration_result="$(psql "$fresh_url" -Atc \
  'SELECT (SELECT count(*) FROM drizzle.__drizzle_migrations) || '\''|'\'' ||
          (SELECT hash FROM drizzle.__drizzle_migrations
            ORDER BY created_at DESC, id DESC LIMIT 1) || '\''|'\'' ||
          (SELECT md5(prosrc) FROM pg_proc
            WHERE oid = '\''krypto.invoke_agent_run()'\''::regprocedure) || '\''|'\'' ||
          (SELECT md5(prosrc) FROM pg_proc
            WHERE oid = '\''krypto.invoke_daily_summary()'\''::regprocedure);')"
if [[ "$fresh_migration_result" != "7|a614858a8a9e85ae5ece4b9f3046e865e3ed46d780581c1a2843ff8a5ccfde3d|3cb03ace0e82bee3f8b755701a10ea6b|68aee98c8c762497b1b0cf016ea6d25d" ]]; then
  echo "Fresh migration did not install canonical 0006 functions: $fresh_migration_result" >&2
  exit 1
fi

psql "$fresh_url" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
INSERT INTO "krypto"."AgentState" (
  "id", "currentPositionETH", "currentPositionUSDC",
  "portfolioValueUSD", "isLocked", "isOperatorPaused",
  "isRunning", "currentPositionETHDecimal",
  "currentPositionUSDCDecimal", "portfolioValueUSDDecimal",
  "accountingStatus", "updatedAt"
) VALUES (
  'singleton', 0, 200, 200, false, false, false,
  0.123456789012345678, 200, 200, 'RECONCILED', NOW()
);

INSERT INTO "krypto"."AgentRun" (
  "id", "idempotencyKey", "triggerSource", "tradingMode",
  "outcome", "strategyVersion"
) VALUES (
  'fresh-run', 'fresh-idempotency-key', 'migration-test', 'PAPER',
  'EXECUTED', 'migration-test'
);

INSERT INTO "krypto"."TradeExecution" (
  "id", "direction", "asset", "amountUSD", "amountAsset",
  "executionPrice", "feesUSD", "slippage", "agentReasoning",
  "agentRunId"
) VALUES (
  'fresh-trade', 'BUY', 'ETH', 10, 0.005, 2000, 0.03, 0,
  'migration preservation sentinel', 'fresh-run'
);

INSERT INTO "krypto"."AgentJournal" (
  "id", "entryText", "marketConditions", "tradeExecutionId"
) VALUES (
  'fresh-journal', 'migration preservation sentinel', '{}'::jsonb,
  'fresh-trade'
);

DO $$
BEGIN
  BEGIN
    INSERT INTO "krypto"."AgentRun" (
      "id", "idempotencyKey", "triggerSource", "tradingMode",
      "strategyVersion"
    ) VALUES (
      'duplicate-run', 'fresh-idempotency-key', 'migration-test',
      'PAPER', 'migration-test'
    );
    RAISE EXCEPTION 'duplicate AgentRun idempotency key was accepted';
  EXCEPTION WHEN unique_violation OR check_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO "krypto"."TradeExecution" (
      "id", "direction", "asset", "amountUSD", "amountAsset",
      "executionPrice", "feesUSD", "slippage", "agentReasoning",
      "agentRunId"
    ) VALUES (
      'duplicate-trade', 'BUY', 'ETH', 10, 0.005, 2000, 0.03, 0,
      'duplicate execution sentinel', 'fresh-run'
    );
    RAISE EXCEPTION 'second execution for one AgentRun was accepted';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
END
$$;
SQL

psql "$fresh_url" -v ON_ERROR_STOP=1 \
  -f drizzle/0002_secure_private_schema.sql >/dev/null
psql "$fresh_url" -v ON_ERROR_STOP=1 \
  -f drizzle/0006_reject_null_cron_rollout_mode.sql >/dev/null

fresh_counts="$(psql "$fresh_url" -Atc \
  'SELECT (SELECT count(*) FROM "krypto"."AgentState") || '\''|'\'' ||
          (SELECT count(*) FROM "krypto"."AgentRun") || '\''|'\'' ||
          (SELECT count(*) FROM "krypto"."TradeExecution") || '\''|'\'' ||
          (SELECT count(*) FROM "krypto"."AgentJournal") || '\''|'\'' ||
          (SELECT "currentPositionETHDecimal"::text
             FROM "krypto"."AgentState"
            WHERE "id" = '\''singleton'\'');')"
if [[ "$fresh_counts" != "1|1|1|1|0.123456789012345678" ]]; then
  echo "Private-schema migration reapply did not preserve rows: $fresh_counts" >&2
  exit 1
fi

security_result="$(psql "$fresh_url" -Atc \
  'SELECT has_schema_privilege('\''anon'\'', '\''krypto'\'', '\''USAGE'\'') || '\''|'\'' ||
          has_table_privilege('\''authenticated'\'', '\''krypto."AgentState"'\'', '\''SELECT'\'') || '\''|'\'' ||
          has_function_privilege('\''anon'\'', '\''krypto.invoke_agent_run()'\'', '\''EXECUTE'\'') || '\''|'\'' ||
          has_function_privilege('\''service_role'\'', '\''krypto.invoke_agent_run()'\'', '\''EXECUTE'\'');')"
if [[ "$security_result" != "false|false|false|true" ]]; then
  echo "Private schema/function privileges are incorrect: $security_result" >&2
  exit 1
fi
mode_binding_result="$(psql "$fresh_url" -Atc \
  'SELECT (prosrc LIKE '\''%x-required-rollout-mode%'\'')::text || '\''|'\'' ||
          (prosrc LIKE '\''%krypto_rollout_mode%'\'')::text || '\''|'\'' ||
          (prosrc LIKE '\''%v_required_mode IS NULL%'\'')::text
     FROM pg_proc
    WHERE oid = '\''krypto.invoke_agent_run()'\''::regprocedure;')"
if [[ "$mode_binding_result" != "true|true|true" ]]; then
  echo "Cron function is not bound to the queued rollout mode: $mode_binding_result" >&2
  exit 1
fi

psql "$fresh_url" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
GRANT SELECT ("currentPositionUSDCDecimal")
  ON TABLE "krypto"."AgentState" TO anon;
GRANT SELECT ("portfolioValueUSDDecimal")
  ON TABLE "krypto"."AgentState" TO PUBLIC;

CREATE SCHEMA vault;
CREATE TABLE vault.secrets (
  id uuid,
  name text,
  secret text
);
CREATE VIEW vault.decrypted_secrets AS
SELECT id, name, secret AS decrypted_secret
FROM vault.secrets;
CREATE FUNCTION vault.read_secret()
RETURNS text
LANGUAGE sql
AS 'SELECT NULL::text';
CREATE PROCEDURE vault.rotate_secret()
LANGUAGE sql
AS 'SELECT 1';
CREATE SCHEMA bridge;
CREATE VIEW bridge.krypto_state_wrapper AS
SELECT "currentPositionUSDCDecimal"
FROM "krypto"."AgentState";
CREATE VIEW public.krypto_state_exposed AS
SELECT "currentPositionUSDCDecimal"
FROM bridge.krypto_state_wrapper;
CREATE FUNCTION public.read_vault_secret()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
AS 'SELECT decrypted_secret FROM "vault"."decrypted_secrets" LIMIT 1';

GRANT USAGE ON SCHEMA vault TO PUBLIC, anon, authenticated;
GRANT SELECT (secret) ON TABLE vault.secrets TO anon;
GRANT SELECT (decrypted_secret)
  ON TABLE vault.decrypted_secrets TO PUBLIC;
GRANT EXECUTE ON FUNCTION vault.read_secret()
  TO PUBLIC, authenticated;
GRANT EXECUTE ON PROCEDURE vault.rotate_secret()
  TO PUBLIC, anon;
GRANT SELECT ("currentPositionUSDCDecimal")
  ON TABLE public.krypto_state_exposed TO PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.read_vault_secret()
  TO PUBLIC, authenticated;
SQL

psql "$fresh_url" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
CREATE SCHEMA test_support;
CREATE VIEW test_support.pg_extension AS
SELECT 'pg_cron'::name AS extname
UNION ALL
SELECT 'pg_net'::name AS extname;

CREATE SCHEMA cron;
CREATE TABLE cron.job (
  jobid bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  jobname text,
  schedule text NOT NULL DEFAULT '0 * * * *',
  command text,
  active boolean NOT NULL DEFAULT true
);

CREATE SCHEMA net;
CREATE TABLE net.http_request_queue (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  url text NOT NULL
);

INSERT INTO vault.secrets (name, secret)
VALUES
  ('krypto_cron_secret', 'migration-test-secret'),
  ('krypto_vercel_url', 'https://example.test');

DO $$
DECLARE
  function_call text;
BEGIN
  FOREACH function_call IN ARRAY ARRAY[
    'krypto.invoke_agent_run()',
    'krypto.invoke_daily_summary()'
  ]
  LOOP
    BEGIN
      EXECUTE format('SELECT %s', function_call);
      RAISE EXCEPTION '% accepted an absent krypto_rollout_mode', function_call;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM IS DISTINCT FROM
        'Vault secret krypto_rollout_mode must be shadow or paper' THEN
        RAISE;
      END IF;
    END;
  END LOOP;
END
$$;
SQL

if absent_mode_error="$(PGOPTIONS="-c search_path=test_support,pg_catalog,public" \
  psql "$fresh_url" -v ON_ERROR_STOP=1 \
  -f supabase/operations/enable-krypto-cron.sql 2>&1)"; then
  echo "Cron enablement accepted an absent Vault rollout mode." >&2
  exit 1
fi
if [[ "$absent_mode_error" != *"Required Krypto Vault secrets are not configured"* ]]; then
  echo "Cron enablement did not fail closed for an absent Vault rollout mode." >&2
  exit 1
fi

psql "$fresh_url" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
INSERT INTO vault.secrets (name, secret)
VALUES ('krypto_rollout_mode', NULL);

DO $$
DECLARE
  function_call text;
BEGIN
  FOREACH function_call IN ARRAY ARRAY[
    'krypto.invoke_agent_run()',
    'krypto.invoke_daily_summary()'
  ]
  LOOP
    BEGIN
      EXECUTE format('SELECT %s', function_call);
      RAISE EXCEPTION '% accepted a NULL krypto_rollout_mode', function_call;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM IS DISTINCT FROM
        'Vault secret krypto_rollout_mode must be shadow or paper' THEN
        RAISE;
      END IF;
    END;
  END LOOP;
END
$$;
SQL

if null_mode_error="$(PGOPTIONS="-c search_path=test_support,pg_catalog,public" \
  psql "$fresh_url" -v ON_ERROR_STOP=1 \
  -f supabase/operations/enable-krypto-cron.sql 2>&1)"; then
  echo "Cron enablement accepted a NULL Vault rollout mode." >&2
  exit 1
fi
if [[ "$null_mode_error" != *"Required Krypto Vault secrets are not configured"* ]]; then
  echo "Cron enablement did not fail closed for a NULL Vault rollout mode." >&2
  exit 1
fi

psql "$fresh_url" -v ON_ERROR_STOP=1 \
  -c "DELETE FROM vault.secrets;" >/dev/null

psql "$fresh_url" -v ON_ERROR_STOP=1 \
  -f drizzle/0004_restrict_vault_access.sql >/dev/null

expanded_security_result="$(psql "$fresh_url" -Atc \
  'SELECT has_column_privilege('\''anon'\'', '\''krypto."AgentState"'\'', '\''currentPositionUSDCDecimal'\'', '\''SELECT'\'') || '\''|'\'' ||
          has_column_privilege('\''authenticated'\'', '\''krypto."AgentState"'\'', '\''portfolioValueUSDDecimal'\'', '\''SELECT'\'') || '\''|'\'' ||
          has_schema_privilege('\''anon'\'', '\''vault'\'', '\''USAGE'\'') || '\''|'\'' ||
          has_column_privilege('\''anon'\'', '\''vault.secrets'\'', '\''secret'\'', '\''SELECT'\'') || '\''|'\'' ||
          has_column_privilege('\''authenticated'\'', '\''vault.decrypted_secrets'\'', '\''decrypted_secret'\'', '\''SELECT'\'') || '\''|'\'' ||
          has_function_privilege('\''authenticated'\'', '\''vault.read_secret()'\'', '\''EXECUTE'\'') || '\''|'\'' ||
          has_function_privilege('\''anon'\'', '\''vault.rotate_secret()'\'', '\''EXECUTE'\'') || '\''|'\'' ||
          has_column_privilege('\''anon'\'', '\''public.krypto_state_exposed'\'', '\''currentPositionUSDCDecimal'\'', '\''SELECT'\'') || '\''|'\'' ||
          has_function_privilege('\''authenticated'\'', '\''public.read_vault_secret()'\'', '\''EXECUTE'\'');')"
if [[ "$expanded_security_result" != "false|false|false|false|false|false|false|false|false" ]]; then
  echo "Column-level or Vault privileges remain exposed: $expanded_security_result" >&2
  exit 1
fi

rollout_upgrade_config="$(build_through_config 5 0005)"

create_database rollout_upgrade
DIRECT_URL="$rollout_upgrade_url" \
  npx drizzle-kit migrate --config "$rollout_upgrade_config" >/dev/null

pre_0006_result="$(psql "$rollout_upgrade_url" -Atc \
  'SELECT (SELECT count(*) FROM drizzle.__drizzle_migrations) || '\''|'\'' ||
          (SELECT hash FROM drizzle.__drizzle_migrations
            ORDER BY created_at DESC, id DESC LIMIT 1) || '\''|'\'' ||
          (SELECT md5(prosrc) FROM pg_proc
            WHERE oid = '\''krypto.invoke_agent_run()'\''::regprocedure) || '\''|'\'' ||
          (SELECT md5(prosrc) FROM pg_proc
            WHERE oid = '\''krypto.invoke_daily_summary()'\''::regprocedure) || '\''|'\'' ||
          (SELECT (prosrc LIKE '\''%v_required_mode IS NULL%'\'')::text
             FROM pg_proc
            WHERE oid = '\''krypto.invoke_agent_run()'\''::regprocedure) || '\''|'\'' ||
          (SELECT (prosrc LIKE '\''%v_required_mode IS NULL%'\'')::text
             FROM pg_proc
            WHERE oid = '\''krypto.invoke_daily_summary()'\''::regprocedure);')"
if [[ "$pre_0006_result" != "6|6c2224452bafb07b0bd7ecaa3fcc6a45690abef61944b487571e900f11d7c43a|e4328c1c001787b6f0a28cd6830f7c2d|585324cdb2b9f0ddfc0d53938f791ba1|false|false" ]]; then
  echo "Original 0005 fixture is not canonical: $pre_0006_result" >&2
  exit 1
fi

# Pinned to 0006 (not the default/full migration set) so this upgrade proof
# keeps exercising exactly the 0005-to-0006 rollout-mode-binding step,
# regardless of any later migrations (such as 0007's retirement of the
# obsolete cron functions) that now also live in drizzle/.
DIRECT_URL="$rollout_upgrade_url" \
  npx drizzle-kit migrate --config "$through_0006_config" >/dev/null

post_0006_result="$(psql "$rollout_upgrade_url" -Atc \
  'SELECT (SELECT count(*) FROM drizzle.__drizzle_migrations) || '\''|'\'' ||
          (SELECT hash FROM drizzle.__drizzle_migrations
            ORDER BY created_at DESC, id DESC LIMIT 1) || '\''|'\'' ||
          (SELECT md5(prosrc) FROM pg_proc
            WHERE oid = '\''krypto.invoke_agent_run()'\''::regprocedure) || '\''|'\'' ||
          (SELECT md5(prosrc) FROM pg_proc
            WHERE oid = '\''krypto.invoke_daily_summary()'\''::regprocedure) || '\''|'\'' ||
          (SELECT (prosrc LIKE '\''%v_required_mode IS NULL%'\'')::text
             FROM pg_proc
            WHERE oid = '\''krypto.invoke_agent_run()'\''::regprocedure) || '\''|'\'' ||
          (SELECT (prosrc LIKE '\''%v_required_mode IS NULL%'\'')::text
             FROM pg_proc
            WHERE oid = '\''krypto.invoke_daily_summary()'\''::regprocedure);')"
if [[ "$post_0006_result" != "7|a614858a8a9e85ae5ece4b9f3046e865e3ed46d780581c1a2843ff8a5ccfde3d|3cb03ace0e82bee3f8b755701a10ea6b|68aee98c8c762497b1b0cf016ea6d25d|true|true" ]]; then
  echo "Drizzle upgrade from original 0005 did not install 0006: $post_0006_result" >&2
  exit 1
fi

psql "$rollout_upgrade_url" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
CREATE SCHEMA vault;
CREATE TABLE vault.secrets (
  name text,
  secret text
);
CREATE VIEW vault.decrypted_secrets AS
SELECT name, secret AS decrypted_secret
FROM vault.secrets;

INSERT INTO vault.secrets (name, secret)
VALUES
  ('krypto_cron_secret', 'migration-upgrade-secret'),
  ('krypto_vercel_url', 'https://example.test');

DO $$
DECLARE
  function_call text;
BEGIN
  FOREACH function_call IN ARRAY ARRAY[
    'krypto.invoke_agent_run()',
    'krypto.invoke_daily_summary()'
  ]
  LOOP
    BEGIN
      EXECUTE format('SELECT %s', function_call);
      RAISE EXCEPTION '% accepted an absent krypto_rollout_mode after 0006', function_call;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM IS DISTINCT FROM
        'Vault secret krypto_rollout_mode must be shadow or paper' THEN
        RAISE;
      END IF;
    END;
  END LOOP;
END
$$;

INSERT INTO vault.secrets (name, secret)
VALUES ('krypto_rollout_mode', NULL);

DO $$
DECLARE
  function_call text;
BEGIN
  FOREACH function_call IN ARRAY ARRAY[
    'krypto.invoke_agent_run()',
    'krypto.invoke_daily_summary()'
  ]
  LOOP
    BEGIN
      EXECUTE format('SELECT %s', function_call);
      RAISE EXCEPTION '% accepted a NULL krypto_rollout_mode after 0006', function_call;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM IS DISTINCT FROM
        'Vault secret krypto_rollout_mode must be shadow or paper' THEN
        RAISE;
      END IF;
    END;
  END LOOP;
END
$$;
SQL

create_database upgrade
psql "$upgrade_url" -v ON_ERROR_STOP=1 \
  -f tests/fixtures/v2-schema.sql >/dev/null
psql "$upgrade_url" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
INSERT INTO "public"."AgentState" (
  "id", "currentPositionETH", "currentPositionUSDC",
  "portfolioValueUSD", "isLocked", "isRunning", "updatedAt"
) VALUES ('singleton', 0.012, 174.865, 195, false, false, NOW());

INSERT INTO "public"."TradeExecution" (
  "id", "direction", "asset", "amountUSD", "amountAsset",
  "executionPrice", "feesUSD", "slippage", "pnlUSD",
  "agentReasoning", "createdAt"
) VALUES
  (
    'upgrade-trade-1', 'BUY', 'ETH', 20, 0.01, 2000, 0.06, 0,
    NULL, 'existing v2 first buy', '2026-01-01T00:00:00Z'
  ),
  (
    'upgrade-trade-2', 'BUY', 'ETH', 15, 0.006, 2500, 0.045, 0,
    NULL, 'existing v2 DCA buy', '2026-01-02T00:00:00Z'
  ),
  (
    'upgrade-trade-3', 'SELL', 'ETH', 10, 0.004, 2500, 0.03, 0,
    1.2, 'existing v2 partial sell', '2026-01-03T00:00:00Z'
  );

INSERT INTO "public"."AgentJournal" (
  "id", "entryText", "marketConditions", "tradeExecutionId"
) VALUES (
  'upgrade-journal', 'existing v2 preservation sentinel',
  '{}'::jsonb, 'upgrade-trade-3'
);

CREATE FUNCTION public.krypto_invoke_endpoint(endpoint_path text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN 0;
END
$$;
GRANT EXECUTE ON FUNCTION public.krypto_invoke_endpoint(text) TO PUBLIC;
SQL

legacy_backup_dir="$TEMP_DIR/legacy-verified-backup"
DIRECT_URL="$upgrade_url" DATABASE_URL="$upgrade_url" \
  npx tsx scripts/create-verified-backup.ts \
  --out "$legacy_backup_dir" \
  --restore-test-url "$admin_url" >/dev/null
node - "$legacy_backup_dir/manifest.json" <<'NODE'
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (
  manifest.verified !== true ||
  manifest.scope.publicTypes?.includes("public.TradeDirection") !== true ||
  manifest.bootstrapFiles?.length !== 1 ||
  manifest.restoreVerification?.matched !== true
) {
  throw new Error("Legacy public-schema backup is not independently restorable.");
}
NODE

DIRECT_URL="$upgrade_url" \
  npx drizzle-kit migrate --config "$through_0007_legacy_config" >/dev/null

upgrade_result="$(psql "$upgrade_url" -Atc \
  'SELECT (SELECT count(*) FROM "krypto"."AgentState") || '\''|'\'' ||
          (SELECT count(*) FROM "krypto"."TradeExecution") || '\''|'\'' ||
          (SELECT count(*) FROM "krypto"."AgentJournal") || '\''|'\'' ||
          (SELECT "isOperatorPaused"::text
             FROM "krypto"."AgentState"
            WHERE "id" = '\''singleton'\'') || '\''|'\'' ||
          (to_regclass('\''public."AgentState"'\'') IS NULL)::text || '\''|'\'' ||
          (SELECT "accountingStatus"::text
             FROM "krypto"."AgentState"
            WHERE "id" = '\''singleton'\'') || '\''|'\'' ||
          (SELECT "weightedCostBasisUSD"::text
             FROM "krypto"."AgentState"
            WHERE "id" = '\''singleton'\'') || '\''|'\'' ||
          (SELECT "dcaCount"::text
             FROM "krypto"."AgentState"
            WHERE "id" = '\''singleton'\'') || '\''|'\'' ||
          (SELECT "currentPositionETHDecimal"::text
             FROM "krypto"."AgentState"
            WHERE "id" = '\''singleton'\'') || '\''|'\'' ||
          (SELECT "drawdownPct"::text
             FROM "krypto"."AgentState"
            WHERE "id" = '\''singleton'\'') || '\''|'\'' ||
          (SELECT "referencePriceUSD"::text
             FROM "krypto"."AgentState"
            WHERE "id" = '\''singleton'\'') || '\''|'\'' ||
          (SELECT "lastBuyPriceUSD"::text
             FROM "krypto"."AgentState"
            WHERE "id" = '\''singleton'\'') || '\''|'\'' ||
          (SELECT "ethBalanceAfter"::text
             FROM "krypto"."TradeExecution"
            WHERE "id" = '\''upgrade-trade-3'\'') || '\''|'\'' ||
          (SELECT "usdcBalanceAfter"::text
             FROM "krypto"."TradeExecution"
            WHERE "id" = '\''upgrade-trade-3'\'') || '\''|'\'' ||
          (SELECT "costBasisAfterUSD"::text
             FROM "krypto"."TradeExecution"
            WHERE "id" = '\''upgrade-trade-3'\'') || '\''|'\'' ||
          (to_regprocedure('\''public.krypto_invoke_endpoint(text)'\'') IS NULL)::text;')"
if [[ "$upgrade_result" != "1|3|1|false|true|RECONCILED|2194.06250000|2|0.012000000000000000|2.50000000|2000.00000000|2500.00000000|0.012000000000000000|174.86500000|2194.06250000|true" ]]; then
  echo "Existing v2 upgrade did not preserve data or add defaults: $upgrade_result" >&2
  exit 1
fi

# --- Azure PostgreSQL safety and bounded-execution transition: fresh install ---
#
# A clean target migrated to the current (default, full) migration set must
# have both obsolete Supabase HTTP cron functions absent and the
# least-privilege krypto_runtime group role established with the exact,
# fail-closed per-table privilege matrix (no more, no less): AgentState
# SELECT+UPDATE only; AgentRun SELECT+INSERT+UPDATE; TradeExecution
# SELECT+INSERT only; AgentJournal SELECT+INSERT only. No table anywhere may
# carry a row-removal, table-clearing, TRIGGER, or REFERENCES privilege for
# krypto_runtime, and the schema has no sequences to grant.

azure_0007_hash="fdd400ff67a047a8a590be86c462bf1347a7cb36f65045d7625e89c51b5d5e71"
azure_0008_hash="0f28fce3409b92986be1fe58a82b02a90dcbb48a0cab75a1bbfb6681e200638e"
azure_0009_hash="289f3a32bdc4c47cd3c9d8c2c354226962fadc4ff5be80e9864574f8eebd42a5"
azure_0010_hash="e81e8e38bcf2e32855a4d98dd3c76950c26d0e9aeecba536adb0f12278920095"

create_database azure_target
azure_migrator_password="krypto-migrator-test-pw-$(random_test_password)"
bootstrap_and_migrate "$azure_target_url" "$azure_migrator_password"
azure_initial_migration_url="$(with_role_credentials "$azure_target_url" krypto_migrator "$azure_migrator_password")"
DIRECT_URL="$azure_target_url" MIGRATION_URL="$azure_initial_migration_url" \
  npx tsx scripts/seed.ts >/dev/null
DIRECT_URL="$azure_target_url" MIGRATION_URL="$azure_initial_migration_url" \
  npx tsx scripts/seed.ts >/dev/null
fresh_init_result="$(psql "$azure_target_url" -Atc \
  "SELECT count(*)::text || '|' ||
          (SELECT relowner::regrole::text FROM pg_class
            WHERE oid = 'krypto.\"AgentState\"'::regclass)
     FROM \"krypto\".\"AgentState\"
    WHERE \"id\" = 'singleton';")"
if [[ "$fresh_init_result" != "1|krypto_schema_owner" ]]; then
  echo "Migrator SET-ROLE singleton initialization was not idempotent or changed ownership: $fresh_init_result" >&2
  exit 1
fi
if [[ -z "$TEST_POSTGRES_ADMIN_URL" ]]; then
  # PostgreSQL roles are cluster-global. Authenticate every later database
  # scenario through scram using the same environment credential so an
  # accidental cross-database password rotation fails immediately instead of
  # being hidden by initdb's temporary trust rule.
  initial_migrator_hba="$TEMP_DIR/pg_hba.initial-migrator.conf"
  cat >"$initial_migrator_hba" <<HBA
host    all             krypto_migrator         127.0.0.1/32            scram-sha-256
HBA
  cat "$initial_migrator_hba" "$PGDATA/pg_hba.conf" >"$TEMP_DIR/pg_hba.conf.new"
  mv "$TEMP_DIR/pg_hba.conf.new" "$PGDATA/pg_hba.conf"
  pg_ctl -D "$PGDATA" reload >/dev/null
  sleep 0.2
  if ! PGPASSWORD="$azure_migrator_password" psql \
    "postgresql://krypto_migrator@127.0.0.1:$PORT/azure_target" \
    -Atc "SELECT current_user;" >/dev/null; then
    echo "Initial krypto_migrator credential did not authenticate over scram-sha-256" >&2
    exit 1
  fi
fi

azure_fresh_result="$(psql "$azure_target_url" -Atc \
  'SELECT (SELECT count(*) FROM drizzle.__drizzle_migrations) || '\''|'\'' ||
          (SELECT hash FROM drizzle.__drizzle_migrations
            ORDER BY created_at DESC, id DESC LIMIT 1) || '\''|'\'' ||
          (to_regprocedure('\''krypto.invoke_agent_run()'\'') IS NULL)::text || '\''|'\'' ||
          (to_regprocedure('\''krypto.invoke_daily_summary()'\'') IS NULL)::text || '\''|'\'' ||
          (SELECT NOT rolcanlogin FROM pg_roles
            WHERE rolname = '\''krypto_runtime'\'')::text || '\''|'\'' ||
          has_schema_privilege('\''krypto_runtime'\'', '\''krypto'\'', '\''USAGE'\'')::text || '\''|'\'' ||
          has_table_privilege('\''krypto_runtime'\'', '\''krypto."AgentState"'\'', '\''SELECT'\'')::text || '\''|'\'' ||
          has_table_privilege('\''krypto_runtime'\'', '\''krypto."AgentState"'\'', '\''UPDATE'\'')::text || '\''|'\'' ||
          has_table_privilege('\''krypto_runtime'\'', '\''krypto."AgentState"'\'', '\''INSERT'\'')::text || '\''|'\'' ||
          has_table_privilege('\''krypto_runtime'\'', '\''krypto."AgentState"'\'', '\''DELETE'\'')::text || '\''|'\'' ||
          has_table_privilege('\''krypto_runtime'\'', '\''krypto."AgentRun"'\'', '\''SELECT'\'')::text || '\''|'\'' ||
          has_table_privilege('\''krypto_runtime'\'', '\''krypto."AgentRun"'\'', '\''INSERT'\'')::text || '\''|'\'' ||
          has_table_privilege('\''krypto_runtime'\'', '\''krypto."AgentRun"'\'', '\''UPDATE'\'')::text || '\''|'\'' ||
          has_table_privilege('\''krypto_runtime'\'', '\''krypto."AgentRun"'\'', '\''DELETE'\'')::text || '\''|'\'' ||
          has_table_privilege('\''krypto_runtime'\'', '\''krypto."TradeExecution"'\'', '\''SELECT'\'')::text || '\''|'\'' ||
          has_table_privilege('\''krypto_runtime'\'', '\''krypto."TradeExecution"'\'', '\''INSERT'\'')::text || '\''|'\'' ||
          has_table_privilege('\''krypto_runtime'\'', '\''krypto."TradeExecution"'\'', '\''UPDATE'\'')::text || '\''|'\'' ||
          has_table_privilege('\''krypto_runtime'\'', '\''krypto."TradeExecution"'\'', '\''DELETE'\'')::text || '\''|'\'' ||
          has_table_privilege('\''krypto_runtime'\'', '\''krypto."TradeExecution"'\'', '\''TRUNCATE'\'')::text || '\''|'\'' ||
          has_table_privilege('\''krypto_runtime'\'', '\''krypto."TradeExecution"'\'', '\''TRIGGER'\'')::text || '\''|'\'' ||
          has_table_privilege('\''krypto_runtime'\'', '\''krypto."TradeExecution"'\'', '\''REFERENCES'\'')::text || '\''|'\'' ||
          has_table_privilege('\''krypto_runtime'\'', '\''krypto."AgentJournal"'\'', '\''SELECT'\'')::text || '\''|'\'' ||
          has_table_privilege('\''krypto_runtime'\'', '\''krypto."AgentJournal"'\'', '\''INSERT'\'')::text || '\''|'\'' ||
          has_table_privilege('\''krypto_runtime'\'', '\''krypto."AgentJournal"'\'', '\''UPDATE'\'')::text || '\''|'\'' ||
          has_table_privilege('\''krypto_runtime'\'', '\''krypto."AgentJournal"'\'', '\''DELETE'\'')::text || '\''|'\'' ||
          (NOT EXISTS (
             SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = '\''krypto'\'' AND c.relkind = '\''S'\''
          ))::text || '\''|'\'' ||
          has_schema_privilege('\''public'\'', '\''krypto'\'', '\''USAGE'\'')::text || '\''|'\'' ||
          has_schema_privilege('\''anon'\'', '\''krypto'\'', '\''USAGE'\'')::text || '\''|'\'' ||
          has_schema_privilege('\''authenticated'\'', '\''krypto'\'', '\''USAGE'\'')::text || '\''|'\'' ||
          has_table_privilege('\''krypto_runtime'\'', '\''krypto."ProviderDailyUsage"'\'', '\''SELECT'\'')::text || '\''|'\'' ||
          has_table_privilege('\''krypto_runtime'\'', '\''krypto."ProviderDailyUsage"'\'', '\''INSERT'\'')::text || '\''|'\'' ||
          has_table_privilege('\''krypto_runtime'\'', '\''krypto."ProviderDailyUsage"'\'', '\''UPDATE'\'')::text || '\''|'\'' ||
          has_table_privilege('\''krypto_runtime'\'', '\''krypto."ProviderDailyUsage"'\'', '\''DELETE'\'')::text || '\''|'\'' ||
          has_table_privilege('\''krypto_runtime'\'', '\''krypto."RuntimeContract"'\'', '\''SELECT'\'')::text || '\''|'\'' ||
          has_table_privilege('\''krypto_runtime'\'', '\''krypto."RuntimeContract"'\'', '\''INSERT'\'')::text || '\''|'\'' ||
          has_table_privilege('\''krypto_runtime'\'', '\''krypto."RuntimeContract"'\'', '\''UPDATE'\'')::text || '\''|'\'' ||
          has_schema_privilege('\''krypto_runtime'\'', '\''drizzle'\'', '\''USAGE'\'')::text || '\''|'\'' ||
          (SELECT ("schemaFingerprint" = '\''0010_safety_incidents_v1'\'')::text
             FROM "krypto"."RuntimeContract" WHERE "id" = '\''singleton'\'') || '\''|'\'' ||
          (SELECT (count(*) = 2)::text FROM pg_constraint
            WHERE conrelid = '\''krypto."AgentRun"'\''::regclass
              AND conname IN ('\''AgentRun_deadline_after_start_check'\'', '\''AgentRun_deadline_exact_check'\'')) || '\''|'\'' ||
          (SELECT (condeferrable AND condeferred)::text FROM pg_constraint
            WHERE conname = '\''TradeExecution_commit_deadline_fence'\'');')"
if [[ "$azure_fresh_result" != "11|$azure_0010_hash|true|true|true|true|true|true|false|false|true|true|true|false|true|true|false|false|false|false|false|true|true|false|false|true|false|false|false|true|true|true|false|true|false|false|false|true|true|true" ]]; then
  echo "Fresh Azure migration did not retire obsolete cron functions or establish the exact krypto_runtime privilege matrix: $azure_fresh_result" >&2
  exit 1
fi

safety_fresh_result="$(psql "$azure_target_url" -Atc \
  'SELECT
          (to_regclass('\''krypto."SafetyIncidentOutbox"'\'') IS NOT NULL)::text || '\''|'\'' ||
          (SELECT relowner::regrole::text = '\''krypto_schema_owner'\''
             FROM pg_class
            WHERE oid = '\''krypto."SafetyIncidentOutbox"'\''::regclass)::text || '\''|'\'' ||
          (NOT EXISTS (
             SELECT 1
             FROM information_schema.table_privileges
             WHERE table_schema = '\''krypto'\''
               AND table_name = '\''SafetyIncidentOutbox'\''
               AND grantee = '\''PUBLIC'\''
          ))::text || '\''|'\'' ||
          has_table_privilege('\''krypto_runtime'\'', '\''krypto."SafetyIncidentOutbox"'\'', '\''SELECT'\'')::text || '\''|'\'' ||
          has_table_privilege('\''krypto_runtime'\'', '\''krypto."SafetyIncidentOutbox"'\'', '\''INSERT'\'')::text || '\''|'\'' ||
          has_table_privilege('\''krypto_runtime'\'', '\''krypto."SafetyIncidentOutbox"'\'', '\''UPDATE'\'')::text || '\''|'\'' ||
          has_table_privilege('\''krypto_runtime'\'', '\''krypto."SafetyIncidentOutbox"'\'', '\''DELETE'\'')::text || '\''|'\'' ||
          has_table_privilege('\''krypto_runtime'\'', '\''krypto."SafetyIncidentOutbox"'\'', '\''TRUNCATE'\'')::text || '\''|'\'' ||
          has_table_privilege('\''krypto_runtime'\'', '\''krypto."SafetyIncidentOutbox"'\'', '\''TRIGGER'\'')::text || '\''|'\'' ||
          has_table_privilege('\''krypto_runtime'\'', '\''krypto."SafetyIncidentOutbox"'\'', '\''REFERENCES'\'')::text || '\''|'\'' ||
          (SELECT column_default IS NULL
             FROM information_schema.columns
            WHERE table_schema = '\''krypto'\''
              AND table_name = '\''SafetyIncidentOutbox'\''
              AND column_name = '\''eventId'\'')::text || '\''|'\'' ||
          (NOT EXISTS (
             SELECT 1
             FROM information_schema.columns
             WHERE table_schema = '\''krypto'\''
               AND table_name = '\''AgentRun'\''
               AND column_name IN ('\''requestId'\'', '\''releaseId'\'', '\''deploymentId'\'')
               AND is_nullable <> '\''NO'\''
          ))::text || '\''|'\'' ||
          (SELECT is_nullable = '\''YES'\''
             FROM information_schema.columns
            WHERE table_schema = '\''krypto'\''
              AND table_name = '\''AgentRun'\''
              AND column_name = '\''providerAttemptId'\'')::text || '\''|'\'' ||
          (SELECT ("schemaFingerprint" = '\''0010_safety_incidents_v1'\'' AND "contractVersion" = 2)::text
             FROM "krypto"."RuntimeContract"
            WHERE "id" = '\''singleton'\'') || '\''|'\'' ||
          (SELECT count(*) = 1
             FROM pg_trigger
            WHERE tgrelid = '\''krypto."SafetyIncidentOutbox"'\''::regclass
              AND tgname = '\''SafetyIncidentOutbox_append_only'\''
              AND tgenabled = '\''O'\''
              AND NOT tgisinternal)::text || '\''|'\'' ||
          (SELECT count(*) = 1
             FROM pg_trigger
            WHERE tgrelid = '\''krypto."SafetyIncidentOutbox"'\''::regclass
              AND tgname = '\''SafetyIncidentOutbox_validate_insert'\''
              AND tgenabled = '\''O'\''
              AND NOT tgisinternal)::text || '\''|'\'' ||
          (NOT EXISTS (
             SELECT 1
             FROM pg_class AS relation
             JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
             WHERE namespace.nspname = '\''krypto'\'' AND relation.relkind = '\''S'\''
          ))::text;')"
if [[ "$safety_fresh_result" != "true|true|true|true|true|false|false|false|false|false|true|true|true|true|true|true|true" ]]; then
  echo "Fresh 0010 migration did not establish the safety outbox, correlations, fingerprint, trigger, or exact privileges: $safety_fresh_result" >&2
  exit 1
fi

psql "$azure_target_url" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
BEGIN;
INSERT INTO "krypto"."AgentRun" (
  "id", "idempotencyKey", "requestId", "releaseId", "deploymentId",
  "triggerSource", "tradingMode", "strategyVersion", "startedAt", "deadlineAt"
) VALUES (
  'safety-fresh-run', 'safety-fresh-idempotency', 'safety-fresh-request',
  'release-test', 'deployment-test', 'migration-test', 'PAPER', 'migration-test',
  statement_timestamp(), statement_timestamp() + interval '180 seconds'
);

INSERT INTO "krypto"."TradeExecution" (
  "id", "direction", "asset", "amountUSD", "amountAsset",
  "executionPrice", "agentReasoning", "agentRunId"
) VALUES (
  'safety-fresh-trade', 'BUY', 'ETH', 1, 0.001, 1000,
  'safety incident migration proof', 'safety-fresh-run'
);

INSERT INTO "krypto"."SafetyIncidentOutbox" (
  "eventId", "incidentId", "eventSequence", "eventKind", "incidentType",
  "severity", "status", "dedupKey", "requestId", "agentRunId",
  "releaseId", "deploymentId", "transactionId", "redactedContext",
  "occurredAt", "persistedAt", "ownerRole", "backupRole", "runbook"
) VALUES (
  'safety-event-created', 'safety-incident-1', 1, 'CREATED',
  'PAPER_TRADE_POST_COMMIT', 'CRITICAL', 'OPEN', 'safety-dedup-1',
  'safety-fresh-request', 'safety-fresh-run', 'release-test',
  'deployment-test', 'safety-fresh-trade', '{"component":"migration-test"}',
  transaction_timestamp(), statement_timestamp(), 'incident-commander', 'operations',
  'runbooks/safety-incidents'
);

-- The CREATED-only predicate makes retries idempotent without preventing
-- delivery outcome events from carrying the same stable deduplication key.
INSERT INTO "krypto"."SafetyIncidentOutbox" (
  "eventId", "incidentId", "eventSequence", "eventKind", "incidentType",
  "severity", "status", "dedupKey", "requestId", "agentRunId",
  "releaseId", "deploymentId", "transactionId", "redactedContext",
  "occurredAt", "ownerRole", "backupRole", "runbook", "evidence"
) VALUES (
  'safety-event-delivery-failed', 'safety-incident-1', 2, 'DELIVERY_FAILED',
  'PAPER_TRADE_POST_COMMIT', 'CRITICAL', 'OPEN', 'safety-dedup-1',
  'safety-fresh-request', 'safety-fresh-run', 'release-test',
  'deployment-test', 'safety-fresh-trade', '{"component":"migration-test"}',
  transaction_timestamp(), 'incident-commander', 'operations',
  'runbooks/safety-incidents', '{"deliveryChannel":"email"}'
);

-- The latest immutable event defines whether an incident remains unresolved.
-- Historical OPEN rows remain present and must not block after RESOLVED.
INSERT INTO "krypto"."SafetyIncidentOutbox" (
  "eventId", "incidentId", "eventSequence", "eventKind", "incidentType",
  "severity", "status", "dedupKey", "requestId", "agentRunId",
  "releaseId", "deploymentId", "transactionId", "redactedContext",
  "occurredAt", "persistedAt", "acknowledgedAt", "ownerRole", "backupRole",
  "runbook", "actorId", "actorRole", "evidence"
) VALUES (
  'safety-event-acknowledged', 'safety-incident-1', 3, 'ACKNOWLEDGED',
  'PAPER_TRADE_POST_COMMIT', 'CRITICAL', 'ACKNOWLEDGED', 'safety-dedup-1',
  'safety-fresh-request', 'safety-fresh-run', 'release-test',
  'deployment-test', 'safety-fresh-trade', '{"component":"migration-test"}',
  transaction_timestamp(), statement_timestamp(), statement_timestamp(),
  'incident-commander', 'operations', 'runbooks/safety-incidents',
  'migration-release-owner', 'RELEASE_OWNER',
  '{"containmentDecision":"rollout-disabled"}'
);

INSERT INTO "krypto"."SafetyIncidentOutbox" (
  "eventId", "incidentId", "eventSequence", "eventKind", "incidentType",
  "severity", "status", "dedupKey", "requestId", "agentRunId",
  "releaseId", "deploymentId", "transactionId", "redactedContext",
  "occurredAt", "persistedAt", "acknowledgedAt", "resolvedAt", "ownerRole", "backupRole",
  "runbook", "actorId", "actorRole", "evidence"
) VALUES (
  'safety-event-resolved', 'safety-incident-1', 4, 'RESOLVED',
  'PAPER_TRADE_POST_COMMIT', 'CRITICAL', 'RESOLVED', 'safety-dedup-1',
  'safety-fresh-request', 'safety-fresh-run', 'release-test',
  'deployment-test', 'safety-fresh-trade', '{"component":"migration-test"}',
  transaction_timestamp(), statement_timestamp(), statement_timestamp(), statement_timestamp(),
  'incident-commander', 'operations', 'runbooks/safety-incidents',
  'migration-safety-approver', 'SAFETY_APPROVER',
  '{"affectedInterval":"2026-08-17T18:00:00Z/2026-08-17T19:00:00Z","cause":"test-failure","containmentDecision":"rollout-disabled","remediation":"projection-repaired","verification":"ledger-reconciled","followUpRef":"issue-test","residualRisk":"none-known","reentryDecision":"new-window-required"}'
);

DO $$
BEGIN
  BEGIN
    INSERT INTO "krypto"."SafetyIncidentOutbox" (
      "eventId", "incidentId", "eventSequence", "eventKind", "incidentType",
      "severity", "status", "dedupKey", "requestId", "releaseId",
      "deploymentId", "redactedContext", "occurredAt", "ownerRole",
      "backupRole", "runbook"
    ) VALUES (
      'duplicate-created', 'safety-incident-retry', 1, 'CREATED',
      'PAPER_TRADE_POST_COMMIT', 'CRITICAL', 'OPEN', 'safety-dedup-1',
      'safety-fresh-request', 'release-test', 'deployment-test', '{}'::jsonb,
      statement_timestamp(), 'incident-commander', 'operations',
      'runbooks/safety-incidents'
    );
    RAISE EXCEPTION 'duplicate CREATED deduplication key was accepted';
  EXCEPTION WHEN unique_violation OR check_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO "krypto"."SafetyIncidentOutbox" (
      "eventId", "incidentId", "eventSequence", "eventKind", "incidentType",
      "severity", "status", "dedupKey", "requestId", "releaseId",
      "deploymentId", "redactedContext", "occurredAt", "ownerRole",
      "backupRole", "runbook"
    ) VALUES (
      'duplicate-sequence', 'safety-incident-1', 2, 'DELIVERY_CONFIRMED',
      'PAPER_TRADE_POST_COMMIT', 'CRITICAL', 'OPEN', 'different-dedup',
      'safety-fresh-request', 'release-test', 'deployment-test', '{}'::jsonb,
      statement_timestamp(), 'incident-commander', 'operations',
      'runbooks/safety-incidents'
    );
    RAISE EXCEPTION 'duplicate incident event sequence was accepted';
  EXCEPTION WHEN unique_violation OR check_violation THEN
    NULL;
  END;

  BEGIN
    UPDATE "krypto"."SafetyIncidentOutbox"
    SET "status" = 'RESOLVED'
    WHERE "eventId" = 'safety-event-created';
    RAISE EXCEPTION 'SafetyIncidentOutbox UPDATE was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    DELETE FROM "krypto"."SafetyIncidentOutbox"
    WHERE "eventId" = 'safety-event-created';
    RAISE EXCEPTION 'SafetyIncidentOutbox DELETE was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO "krypto"."SafetyIncidentOutbox" (
      "eventId", "incidentId", "eventSequence", "eventKind", "incidentType",
      "severity", "status", "dedupKey", "requestId", "releaseId",
      "deploymentId", "redactedContext", "occurredAt", "ownerRole",
      "backupRole", "runbook"
    ) VALUES (
      'invalid-context', 'invalid-context', 0, 'CREATED',
      'TEST_FIRE_WARNING', 'WARNING', 'OPEN', 'invalid-context',
      'safety-fresh-request', 'release-test', 'deployment-test', '[]'::jsonb,
      statement_timestamp(), 'incident-commander', 'operations',
      'runbooks/safety-incidents'
    );
    RAISE EXCEPTION 'invalid safety incident context or sequence was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END
$$;
COMMIT;
SQL

safety_append_only_result="$(psql "$azure_target_url" -Atc \
  'SELECT count(*)::text || '\''|'\'' ||
          count(*) FILTER (WHERE "eventKind" = '\''CREATED'\'')::text || '\''|'\'' ||
          count(*) FILTER (WHERE "eventKind" = '\''DELIVERY_FAILED'\'')::text || '\''|'\'' ||
          count(*) FILTER (WHERE "eventKind" = '\''ACKNOWLEDGED'\'')::text || '\''|'\'' ||
          count(*) FILTER (WHERE "eventKind" = '\''RESOLVED'\'')::text
     FROM "krypto"."SafetyIncidentOutbox"
    WHERE "incidentId" = '\''safety-incident-1'\'';')"
if [[ "$safety_append_only_result" != "4|1|1|1|1" ]]; then
  echo "Safety incident append-only or deduplication invariants failed: $safety_append_only_result" >&2
  exit 1
fi


# Historical migrations are never re-applied after a later ledger entry.
# In particular, 0007's then-complete runtime grant matrix predates the
# RuntimeContract and ProviderDailyUsage tables added by 0009, and the
# SafetyIncidentOutbox added by 0010; manually replaying 0007 out of ledger
# order would intentionally fail closed by revoking access to those future
# tables. Upgrade coverage below exercises the supported ordered history.

# --- Azure PostgreSQL safety transition: 0006-to-0007 upgrade, row preservation ---

create_database azure_upgrade
DIRECT_URL="$azure_upgrade_url" \
  npx drizzle-kit migrate --config "$through_0006_config" >/dev/null

psql "$azure_upgrade_url" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
INSERT INTO "krypto"."AgentState" (
  "id", "currentPositionETH", "currentPositionUSDC",
  "portfolioValueUSD", "isLocked", "isOperatorPaused",
  "isRunning", "currentPositionETHDecimal",
  "currentPositionUSDCDecimal", "portfolioValueUSDDecimal",
  "accountingStatus", "updatedAt"
) VALUES (
  'singleton', 0, 200, 200, false, false, false,
  0.123456789012345678, 200, 200, 'RECONCILED', NOW()
);

INSERT INTO "krypto"."AgentRun" (
  "id", "idempotencyKey", "triggerSource", "tradingMode",
  "outcome", "strategyVersion"
) VALUES (
  'azure-upgrade-run', 'azure-upgrade-idempotency-key', 'migration-test',
  'PAPER', 'EXECUTED', 'migration-test'
);

INSERT INTO "krypto"."TradeExecution" (
  "id", "direction", "asset", "amountUSD", "amountAsset",
  "executionPrice", "feesUSD", "slippage", "agentReasoning",
  "agentRunId"
) VALUES (
  'azure-upgrade-trade', 'BUY', 'ETH', 10, 0.005, 2000, 0.03, 0,
  'azure 0007 upgrade preservation sentinel', 'azure-upgrade-run'
);

INSERT INTO "krypto"."AgentJournal" (
  "id", "entryText", "marketConditions", "tradeExecutionId"
) VALUES (
  'azure-upgrade-journal', 'azure 0007 upgrade preservation sentinel',
  '{}'::jsonb, 'azure-upgrade-trade'
);
SQL

# A real upgrade to the trust boundary lands on a deployment that is
# already current as of 0007 (the prior release), migrated the old way
# (as the admin/superuser, owning everything directly) -- 0008 is the
# first migration such a deployment ever applies as krypto_migrator.
# Combining 0007+0008 into one krypto_migrator-authenticated run instead
# would incorrectly require 0007's already-shipped, unmodified SQL (never
# written to expect a non-owner runner) to also work under the new
# non-inheriting migrator, which no real upgrade ever needs.
through_0007_azure_config="$(build_through_config 7 0007azure)"
DIRECT_URL="$azure_upgrade_url" \
  npx drizzle-kit migrate --config "$through_0007_azure_config" >/dev/null

azure_upgrade_migrator_password="$azure_migrator_password"
bootstrap_and_migrate "$azure_upgrade_url" "$azure_upgrade_migrator_password"

azure_upgrade_result="$(psql "$azure_upgrade_url" -Atc \
  'SELECT (SELECT count(*) FROM drizzle.__drizzle_migrations) || '\''|'\'' ||
          (SELECT count(*) FROM "krypto"."AgentState") || '\''|'\'' ||
          (SELECT count(*) FROM "krypto"."AgentRun") || '\''|'\'' ||
          (SELECT count(*) FROM "krypto"."TradeExecution") || '\''|'\'' ||
          (SELECT count(*) FROM "krypto"."AgentJournal") || '\''|'\'' ||
          (SELECT "currentPositionETHDecimal"::text FROM "krypto"."AgentState"
            WHERE "id" = '\''singleton'\'') || '\''|'\'' ||
          (to_regprocedure('\''krypto.invoke_agent_run()'\'') IS NULL)::text || '\''|'\'' ||
          (to_regprocedure('\''krypto.invoke_daily_summary()'\'') IS NULL)::text || '\''|'\'' ||
          (SELECT NOT rolcanlogin FROM pg_roles
            WHERE rolname = '\''krypto_runtime'\'')::text || '\''|'\'' ||
          has_table_privilege('\''krypto_runtime'\'', '\''krypto."AgentState"'\'', '\''INSERT'\'')::text || '\''|'\'' ||
          has_table_privilege('\''krypto_runtime'\'', '\''krypto."TradeExecution"'\'', '\''UPDATE'\'')::text || '\''|'\'' ||
          has_table_privilege('\''krypto_runtime'\'', '\''krypto."TradeExecution"'\'', '\''DELETE'\'')::text || '\''|'\'' ||
          has_table_privilege('\''krypto_runtime'\'', '\''krypto."AgentRun"'\'', '\''UPDATE'\'')::text || '\''|'\'' ||
          (SELECT count(*)::text FROM "krypto"."RuntimeContract"
            WHERE "id" = '\''singleton'\'' AND "schemaFingerprint" = '\''0010_safety_incidents_v1'\''
              AND "contractVersion" = 2) || '\''|'\'' ||
          (SELECT count(*)::text FROM "krypto"."ProviderDailyUsage") || '\''|'\'' ||
          (SELECT count(*)::text FROM "krypto"."AgentRun"
            WHERE "deadlineAt" = "startedAt" + interval '\''180 seconds'\'');')"
if [[ "$azure_upgrade_result" != "11|1|1|1|1|0.123456789012345678|true|true|true|false|false|false|true|1|0|1" ]]; then
  echo "0006-to-0007 upgrade did not preserve rows, retire cron functions, or establish the exact krypto_runtime privilege matrix: $azure_upgrade_result" >&2
  exit 1
fi

azure_upgrade_correlation_result="$(psql "$azure_upgrade_url" -Atc \
  'SELECT "requestId" || '\''|'\'' || "releaseId" || '\''|'\'' ||
          "deploymentId" || '\''|'\'' || ("providerAttemptId" IS NULL)::text || '\''|'\'' ||
          (SELECT count(*)::text FROM "krypto"."SafetyIncidentOutbox")
     FROM "krypto"."AgentRun"
    WHERE "id" = '\''azure-upgrade-run'\'';')"
if [[ "$azure_upgrade_correlation_result" != "legacy-agent-run:azure-upgrade-run|legacy-pre-0010|legacy-pre-0010|true|0" ]]; then
  echo "0010 did not safely backfill legacy AgentRun correlations or preserve an empty incident ledger: $azure_upgrade_correlation_result" >&2
  exit 1
fi

# --- Safety incident transition: exact 0009-to-0010 upgrade and row preservation ---

create_database safety_upgrade
DIRECT_URL="$safety_upgrade_url" \
  npx drizzle-kit migrate --config "$through_0007_azure_config" >/dev/null
safety_upgrade_migrator_password="$azure_migrator_password"
bootstrap_and_migrate \
  "$safety_upgrade_url" \
  "$safety_upgrade_migrator_password" \
  --config "$through_0009_config"

psql "$safety_upgrade_url" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
INSERT INTO "krypto"."AgentRun" (
  "id", "idempotencyKey", "triggerSource", "tradingMode",
  "outcome", "strategyVersion", "startedAt", "deadlineAt"
) VALUES (
  'safety-upgrade-run', 'safety-upgrade-idempotency', 'migration-test',
  'PAPER', 'EXECUTED', 'migration-test', statement_timestamp(),
  statement_timestamp() + interval '180 seconds'
);

INSERT INTO "krypto"."TradeExecution" (
  "id", "direction", "asset", "amountUSD", "amountAsset",
  "executionPrice", "feesUSD", "slippage", "agentReasoning", "agentRunId"
) VALUES (
  'safety-upgrade-trade', 'BUY', 'ETH', 10, 0.005, 2000, 0.03, 0,
  '0010 row preservation sentinel', 'safety-upgrade-run'
);

INSERT INTO "krypto"."AgentJournal" (
  "id", "entryText", "marketConditions", "tradeExecutionId", "agentRunId"
) VALUES (
  'safety-upgrade-journal', '0010 row preservation sentinel', '{}'::jsonb,
  'safety-upgrade-trade', 'safety-upgrade-run'
);
SQL

safety_pre_upgrade_result="$(psql "$safety_upgrade_url" -Atc \
  'SELECT (SELECT count(*) FROM drizzle.__drizzle_migrations) || '\''|'\'' ||
          (SELECT "schemaFingerprint" FROM "krypto"."RuntimeContract"
            WHERE "id" = '\''singleton'\'') || '\''|'\'' ||
          (SELECT count(*) FROM "krypto"."AgentRun") || '\''|'\'' ||
          (SELECT count(*) FROM "krypto"."TradeExecution") || '\''|'\'' ||
          (SELECT count(*) FROM "krypto"."AgentJournal") || '\''|'\'' ||
          (to_regclass('\''krypto."SafetyIncidentOutbox"'\'') IS NULL)::text;')"
if [[ "$safety_pre_upgrade_result" != "10|0009_bounded_execution_v1|1|1|1|true" ]]; then
  echo "Pinned 0009 safety upgrade fixture was not established correctly: $safety_pre_upgrade_result" >&2
  exit 1
fi

bootstrap_and_migrate \
  "$safety_upgrade_url" \
  "$safety_upgrade_migrator_password"

safety_upgrade_result="$(psql "$safety_upgrade_url" -Atc \
  'SELECT (SELECT count(*) FROM drizzle.__drizzle_migrations) || '\''|'\'' ||
          (SELECT hash FROM drizzle.__drizzle_migrations
            ORDER BY created_at DESC, id DESC LIMIT 1) || '\''|'\'' ||
          (SELECT count(*) FROM "krypto"."AgentRun") || '\''|'\'' ||
          (SELECT count(*) FROM "krypto"."TradeExecution") || '\''|'\'' ||
          (SELECT count(*) FROM "krypto"."AgentJournal") || '\''|'\'' ||
          (SELECT "requestId" FROM "krypto"."AgentRun"
            WHERE "id" = '\''safety-upgrade-run'\'') || '\''|'\'' ||
          (SELECT "releaseId" FROM "krypto"."AgentRun"
            WHERE "id" = '\''safety-upgrade-run'\'') || '\''|'\'' ||
          (SELECT "deploymentId" FROM "krypto"."AgentRun"
            WHERE "id" = '\''safety-upgrade-run'\'') || '\''|'\'' ||
          (SELECT ("providerAttemptId" IS NULL)::text FROM "krypto"."AgentRun"
            WHERE "id" = '\''safety-upgrade-run'\'') || '\''|'\'' ||
          (SELECT count(*) FROM "krypto"."SafetyIncidentOutbox") || '\''|'\'' ||
          (SELECT "schemaFingerprint" || '\'':'\'' || "contractVersion"::text
             FROM "krypto"."RuntimeContract" WHERE "id" = '\''singleton'\'') || '\''|'\'' ||
          has_table_privilege('\''krypto_runtime'\'', '\''krypto."SafetyIncidentOutbox"'\'', '\''SELECT'\'')::text || '\''|'\'' ||
          has_table_privilege('\''krypto_runtime'\'', '\''krypto."SafetyIncidentOutbox"'\'', '\''INSERT'\'')::text || '\''|'\'' ||
          has_table_privilege('\''krypto_runtime'\'', '\''krypto."SafetyIncidentOutbox"'\'', '\''UPDATE'\'')::text || '\''|'\'' ||
          has_table_privilege('\''krypto_runtime'\'', '\''krypto."SafetyIncidentOutbox"'\'', '\''DELETE'\'')::text;')"
if [[ "$safety_upgrade_result" != "11|$azure_0010_hash|1|1|1|legacy-agent-run:safety-upgrade-run|legacy-pre-0010|legacy-pre-0010|true|0|0010_safety_incidents_v1:2|true|true|false|false" ]]; then
  echo "0009-to-0010 upgrade did not preserve rows, backfill safe correlations, or establish the exact safety outbox contract: $safety_upgrade_result" >&2
  exit 1
fi

# --- Azure PostgreSQL safety transition: idempotent, password-based runtime login bootstrap ---
#
# A fresh Azure deployment cannot rely on membership-only bootstrap alone:
# it must be able to create its own password-based runtime login role.
# bootstrapRuntimeLoginRole must never receive the password as anything
# other than argv/env in this process, must never write it to migration
# history, and — proven below over a real scram-sha-256-authenticated TCP
# connection when this script controls the cluster — the created
# credential must actually authenticate.

azure_login_role="azure_app_identity"
azure_login_password_v1="krypto-test-pw-$(node -e 'console.log(Math.random().toString(36).slice(2))')"
azure_login_password_v2="krypto-test-pw-$(node -e 'console.log(Math.random().toString(36).slice(2))')"
azure_runtime_url_v1="$(with_role_credentials "$azure_target_url" "$azure_login_role" "$azure_login_password_v1")"
azure_runtime_url_v2="$(with_role_credentials "$azure_target_url" "$azure_login_role" "$azure_login_password_v2")"

DIRECT_URL="$azure_target_url" DATABASE_URL="$azure_runtime_url_v1" \
  AZURE_RUNTIME_LOGIN_ROLE="$azure_login_role" \
  AZURE_RUNTIME_LOGIN_PASSWORD="$azure_login_password_v1" \
  npx tsx scripts/bootstrap-azure-runtime-role.ts >"$TEMP_DIR/bootstrap-create.json"

if grep -qF "$azure_login_password_v1" "$TEMP_DIR/bootstrap-create.json"; then
  echo "Login role bootstrap leaked the password into its own output" >&2
  exit 1
fi

bootstrap_login_result="$(psql "$azure_target_url" -Atc \
  "SELECT rolcanlogin::text || '|' ||
          rolsuper::text || '|' ||
          rolcreatedb::text || '|' ||
          rolcreaterole::text || '|' ||
          rolreplication::text || '|' ||
          rolbypassrls::text || '|' ||
          pg_has_role('$azure_login_role', 'krypto_runtime', 'MEMBER')::text
     FROM pg_roles WHERE rolname = '$azure_login_role';")"
if [[ "$bootstrap_login_result" != "true|false|false|false|false|false|true" ]]; then
  echo "Login role bootstrap did not create a least-privilege LOGIN role or grant krypto_runtime membership: $bootstrap_login_result" >&2
  exit 1
fi

# Re-running with the same password must be a safe, idempotent no-op.
DIRECT_URL="$azure_target_url" DATABASE_URL="$azure_runtime_url_v1" \
  AZURE_RUNTIME_LOGIN_ROLE="$azure_login_role" \
  AZURE_RUNTIME_LOGIN_PASSWORD="$azure_login_password_v1" \
  npx tsx scripts/bootstrap-azure-runtime-role.ts >/dev/null

# Username-mismatch must be rejected: DATABASE_URL's username must match
# AZURE_RUNTIME_LOGIN_ROLE before anything is created or altered.
mismatch_runtime_url="$(with_role_credentials "$azure_target_url" "someone_else" "x")"
if DIRECT_URL="$azure_target_url" DATABASE_URL="$mismatch_runtime_url" \
  AZURE_RUNTIME_LOGIN_ROLE="$azure_login_role" \
  AZURE_RUNTIME_LOGIN_PASSWORD="x" \
  npx tsx scripts/bootstrap-azure-runtime-role.ts >/dev/null 2>"$TEMP_DIR/bootstrap-mismatch.log"; then
  echo "Login role bootstrap did not reject a DATABASE_URL/login-role username mismatch" >&2
  exit 1
fi
if ! grep -qi "does not match the target login role" "$TEMP_DIR/bootstrap-mismatch.log"; then
  echo "Login role bootstrap rejected the username mismatch for the wrong reason: $(cat "$TEMP_DIR/bootstrap-mismatch.log")" >&2
  exit 1
fi

# A pre-existing elevated role must be refused, never silently demoted.
psql "$azure_target_url" -v ON_ERROR_STOP=1 \
  -c "CREATE ROLE azure_elevated_identity LOGIN SUPERUSER PASSWORD 'x';" >/dev/null
elevated_runtime_url="$(with_role_credentials "$azure_target_url" "azure_elevated_identity" "x")"
if DIRECT_URL="$azure_target_url" DATABASE_URL="$elevated_runtime_url" \
  AZURE_RUNTIME_LOGIN_ROLE="azure_elevated_identity" \
  AZURE_RUNTIME_LOGIN_PASSWORD="y" \
  npx tsx scripts/bootstrap-azure-runtime-role.ts >/dev/null 2>"$TEMP_DIR/bootstrap-elevated.log"; then
  echo "Login role bootstrap did not refuse a pre-existing elevated role" >&2
  exit 1
fi
if ! grep -qi "already exists with an elevated attribute" "$TEMP_DIR/bootstrap-elevated.log"; then
  echo "Login role bootstrap rejected the elevated role for the wrong reason: $(cat "$TEMP_DIR/bootstrap-elevated.log")" >&2
  exit 1
fi
psql "$azure_target_url" -v ON_ERROR_STOP=1 \
  -c "DROP ROLE azure_elevated_identity;" >/dev/null

if [[ -z "$TEST_POSTGRES_ADMIN_URL" ]]; then
  # This script controls the cluster (its own initdb'd PGDATA), so it can
  # require real scram-sha-256 password authentication over TCP for the
  # created login role and prove rotation actually invalidates the old
  # password — a meaningful test of the credential, not just the role's
  # catalog attributes. (The `local`/unix-socket admin connections used
  # elsewhere in this script are left on trust.)
  # These must be prepended (not appended): pg_hba.conf uses first-match,
  # and initdb's default `host all all 127.0.0.1/32 trust` line would
  # otherwise shadow anything appended after it for the same address.
  hba_override="$TEMP_DIR/pg_hba.override.conf"
  cat >"$hba_override" <<HBA
host    all             $azure_login_role        127.0.0.1/32            scram-sha-256
HBA
  cat "$hba_override" "$PGDATA/pg_hba.conf" >"$TEMP_DIR/pg_hba.conf.new"
  mv "$TEMP_DIR/pg_hba.conf.new" "$PGDATA/pg_hba.conf"
  pg_ctl -D "$PGDATA" reload >/dev/null
  sleep 0.2

  if ! PGPASSWORD="$azure_login_password_v1" psql \
    "postgresql://$azure_login_role@127.0.0.1:$PORT/azure_target" \
    -Atc "SELECT current_user;" >/dev/null 2>"$TEMP_DIR/auth-v1.log"; then
    echo "Bootstrapped login role's initial password did not authenticate over TCP: $(cat "$TEMP_DIR/auth-v1.log")" >&2
    exit 1
  fi

  # Rotate the password and prove the old one no longer authenticates.
  DIRECT_URL="$azure_target_url" DATABASE_URL="$azure_runtime_url_v2" \
    AZURE_RUNTIME_LOGIN_ROLE="$azure_login_role" \
    AZURE_RUNTIME_LOGIN_PASSWORD="$azure_login_password_v2" \
    npx tsx scripts/bootstrap-azure-runtime-role.ts >"$TEMP_DIR/bootstrap-rotate.json"
  if grep -qF "$azure_login_password_v2" "$TEMP_DIR/bootstrap-rotate.json"; then
    echo "Login role rotation leaked the new password into its own output" >&2
    exit 1
  fi

  if PGPASSWORD="$azure_login_password_v1" psql \
    "postgresql://$azure_login_role@127.0.0.1:$PORT/azure_target" \
    -Atc "SELECT 1;" >/dev/null 2>"$TEMP_DIR/auth-old-after-rotate.log"; then
    echo "Old password still authenticated after rotation" >&2
    exit 1
  fi
  if ! PGPASSWORD="$azure_login_password_v2" psql \
    "postgresql://$azure_login_role@127.0.0.1:$PORT/azure_target" \
    -Atc "SELECT current_user;" >/dev/null 2>"$TEMP_DIR/auth-v2.log"; then
    echo "Rotated password did not authenticate over TCP: $(cat "$TEMP_DIR/auth-v2.log")" >&2
    exit 1
  fi

  # The runtime login role must inherit exactly the matrix via membership,
  # and nothing more: it must not be able to remove rows.
  if PGPASSWORD="$azure_login_password_v2" psql \
    "postgresql://$azure_login_role@127.0.0.1:$PORT/azure_target" \
    -Atc 'DELETE FROM "krypto"."AgentJournal";' >/dev/null 2>"$TEMP_DIR/delete-attempt.log"; then
    echo "Runtime login role was able to remove rows; least-privilege boundary is not enforced" >&2
    exit 1
  fi
  if ! grep -qi "permission denied" "$TEMP_DIR/delete-attempt.log"; then
    echo "Runtime login role's row-removal attempt failed for an unexpected reason: $(cat "$TEMP_DIR/delete-attempt.log")" >&2
    exit 1
  fi
fi
azure_runtime_url_current="$azure_runtime_url_v1"
azure_runtime_password_current="$azure_login_password_v1"
if [[ -z "$TEST_POSTGRES_ADMIN_URL" ]]; then
  azure_runtime_url_current="$azure_runtime_url_v2"
  azure_runtime_password_current="$azure_login_password_v2"
fi

# Prove the real runtime LOGIN (not only the NOLOGIN group's catalog ACLs)
# can perform every required operation and cannot cross into DDL. Run inside
# a transaction and roll it back so the permission proof never leaves fixture
# rows behind.
psql "$azure_runtime_url_current" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
BEGIN;
SELECT "id" FROM "krypto"."AgentState" WHERE "id" = 'singleton';
UPDATE "krypto"."AgentState"
   SET "updatedAt" = "updatedAt"
 WHERE "id" = 'singleton';
INSERT INTO "krypto"."AgentRun" (
  "id", "idempotencyKey", "requestId", "releaseId", "deploymentId",
  "triggerSource", "tradingMode", "strategyVersion", "startedAt", "deadlineAt"
) VALUES (
  'runtime-permission-proof', 'runtime-permission-proof',
  'runtime-permission-request', 'runtime-permission-release',
  'runtime-permission-deployment', 'test', 'DISABLED', 'test',
  statement_timestamp(), statement_timestamp() + interval '180 seconds'
);
UPDATE "krypto"."AgentRun"
   SET "outcome" = 'DISABLED'
 WHERE "id" = 'runtime-permission-proof';
INSERT INTO "krypto"."TradeExecution" (
  "id", "direction", "asset", "amountUSD", "amountAsset",
  "executionPrice", "agentReasoning", "agentRunId"
) VALUES (
  'runtime-permission-trade', 'BUY', 'ETH', 1, 0.001,
  1000, 'permission proof only', 'runtime-permission-proof'
);
INSERT INTO "krypto"."AgentJournal" (
  "id", "entryText", "marketConditions", "tradeExecutionId", "agentRunId"
) VALUES (
  'runtime-permission-journal', 'permission proof only', '{}'::jsonb,
  'runtime-permission-trade', 'runtime-permission-proof'
);
INSERT INTO "krypto"."SafetyIncidentOutbox" (
  "eventId", "incidentId", "eventSequence", "eventKind", "incidentType",
  "severity", "status", "dedupKey", "requestId", "agentRunId",
  "releaseId", "deploymentId", "transactionId", "redactedContext",
  "occurredAt", "persistedAt", "ownerRole", "backupRole", "runbook"
) VALUES (
  'runtime-permission-event', 'runtime-permission-incident', 1, 'CREATED',
  'TEST_FIRE_WARNING', 'WARNING', 'OPEN', 'runtime-permission-dedup',
  'runtime-permission-request', 'runtime-permission-proof',
  'runtime-permission-release', 'runtime-permission-deployment',
  'runtime-permission-trade', '{}'::jsonb, statement_timestamp(),
  statement_timestamp(),
  'operations', 'incident-commander', 'runbooks/safety-incidents'
);
SELECT "eventId" FROM "krypto"."SafetyIncidentOutbox"
 WHERE "eventId" = 'runtime-permission-event';
SELECT "schemaFingerprint" FROM "krypto"."RuntimeContract"
 WHERE "id" = 'singleton';
INSERT INTO "krypto"."ProviderDailyUsage" (
  "usageDate", "provider", "requestCount"
) VALUES (
  current_date, 'coinbase', 1
);
UPDATE "krypto"."ProviderDailyUsage"
   SET "requestCount" = "requestCount" + 1
 WHERE "usageDate" = current_date AND "provider" = 'coinbase';
ROLLBACK;
SQL
if psql "$azure_runtime_url_current" \
  -Atc 'UPDATE "krypto"."SafetyIncidentOutbox" SET "status" = '\''RESOLVED'\'' WHERE "eventId" = '\''safety-event-created'\'';' \
  >/dev/null 2>"$TEMP_DIR/runtime-safety-update.log"; then
  echo "Runtime login role updated append-only safety incident evidence" >&2
  exit 1
fi
if ! grep -qi "permission denied" "$TEMP_DIR/runtime-safety-update.log"; then
  echo "Runtime safety incident UPDATE failed for an unexpected reason: $(cat "$TEMP_DIR/runtime-safety-update.log")" >&2
  exit 1
fi
if psql "$azure_runtime_url_current" -Atc '
  INSERT INTO "krypto"."SafetyIncidentOutbox" (
    "eventId", "incidentId", "eventSequence", "eventKind", "incidentType",
    "severity", "status", "dedupKey", "requestId", "agentRunId",
    "releaseId", "deploymentId", "providerAttemptId", "transactionId",
    "redactedContext", "occurredAt", "persistedAt", "resolvedAt",
    "ownerRole", "backupRole", "runbook", "actorId", "actorRole", "evidence"
  )
  SELECT
    '\''runtime-forged-resolution'\'', origin."incidentId", 5, '\''RESOLVED'\'',
    origin."incidentType", origin."severity", '\''RESOLVED'\'',
    origin."dedupKey", origin."requestId", origin."agentRunId",
    origin."releaseId", origin."deploymentId", origin."providerAttemptId",
    origin."transactionId", origin."redactedContext", origin."occurredAt",
    statement_timestamp(), statement_timestamp(), origin."ownerRole",
    origin."backupRole", origin."runbook", '\''forged-runtime'\'',
    '\''SAFETY_APPROVER'\'',
    '\''{"affectedInterval":"test","cause":"test","containmentDecision":"test","remediation":"test","verification":"test","followUpRef":"test","residualRisk":"test","reentryDecision":"test"}'\''::jsonb
  FROM "krypto"."SafetyIncidentOutbox" AS origin
  WHERE origin."eventId" = '\''safety-event-created'\'';
' >/dev/null 2>"$TEMP_DIR/runtime-safety-resolve.log"; then
  echo "Runtime login role forged a RESOLVED safety incident event" >&2
  exit 1
fi
if ! grep -qi "cannot append human incident lifecycle events" "$TEMP_DIR/runtime-safety-resolve.log"; then
  echo "Runtime forged resolution failed for an unexpected reason: $(cat "$TEMP_DIR/runtime-safety-resolve.log")" >&2
  exit 1
fi
if psql "$azure_runtime_url_current" \
  -Atc 'DELETE FROM "krypto"."SafetyIncidentOutbox" WHERE "eventId" = '\''safety-event-created'\'';' \
  >/dev/null 2>"$TEMP_DIR/runtime-safety-delete.log"; then
  echo "Runtime login role deleted append-only safety incident evidence" >&2
  exit 1
fi
if ! grep -qi "permission denied" "$TEMP_DIR/runtime-safety-delete.log"; then
  echo "Runtime safety incident DELETE failed for an unexpected reason: $(cat "$TEMP_DIR/runtime-safety-delete.log")" >&2
  exit 1
fi
if psql "$azure_runtime_url_current" \
  -Atc 'CREATE TABLE "krypto"."runtime_ddl_must_fail" (id integer);' \
  >/dev/null 2>"$TEMP_DIR/runtime-ddl-attempt.log"; then
  echo "Runtime login role created an application object; DDL boundary is not enforced" >&2
  exit 1
fi
if ! grep -qi "permission denied" "$TEMP_DIR/runtime-ddl-attempt.log"; then
  echo "Runtime DDL attempt failed for an unexpected reason: $(cat "$TEMP_DIR/runtime-ddl-attempt.log")" >&2
  exit 1
fi

# --- Azure PostgreSQL safety transition: idempotent, password-free membership bootstrap ---
#
# The membership-only path remains available for a login role whose
# credential is provisioned by another means (for example managed
# identity); it must never create a role or touch a password.

psql "$azure_target_url" -v ON_ERROR_STOP=1 \
  -c "CREATE ROLE azure_managed_identity LOGIN;" >/dev/null

DIRECT_URL="$azure_target_url" AZURE_RUNTIME_LOGIN_ROLE="azure_managed_identity" \
  npx tsx scripts/bootstrap-azure-runtime-role.ts >/dev/null

bootstrap_membership_result="$(psql "$azure_target_url" -Atc \
  "SELECT pg_has_role('azure_managed_identity', 'krypto_runtime', 'MEMBER')::text;")"
if [[ "$bootstrap_membership_result" != "true" ]]; then
  echo "Role bootstrap did not grant krypto_runtime membership: $bootstrap_membership_result" >&2
  exit 1
fi

# Re-running the bootstrap must be a safe no-op (no password is ever read,
# set, or stored, and re-granting an existing membership does not error).
DIRECT_URL="$azure_target_url" AZURE_RUNTIME_LOGIN_ROLE="azure_managed_identity" \
  npx tsx scripts/bootstrap-azure-runtime-role.ts >/dev/null

bootstrap_membership_result_second="$(psql "$azure_target_url" -Atc \
  "SELECT pg_has_role('azure_managed_identity', 'krypto_runtime', 'MEMBER')::text;")"
if [[ "$bootstrap_membership_result_second" != "true" ]]; then
  echo "Repeated role bootstrap lost krypto_runtime membership: $bootstrap_membership_result_second" >&2
  exit 1
fi

# --- PostgreSQL trust boundary (drizzle/0008): ownership, membership,
# migration-only isolation, denial matrix, and preflight proof ---
#
# azure_target is already fully migrated to 0008 above. This section proves
# the exact object-ownership, role-attribute, membership/SET-ROLE-boundary,
# and access-denial invariants required by GitHub issue #133, over and
# above the per-table krypto_runtime privilege matrix already asserted in
# azure_fresh_result/azure_upgrade_result.

# 1. Object ownership: krypto_schema_owner (NOLOGIN) must own the krypto
# schema and every app table/index within it; the drizzle migration ledger
# may remain krypto_migrator-owned (it is the role that ran every
# migration, fresh or upgraded).
ownership_result="$(psql "$azure_target_url" -Atc \
  "SELECT
     (SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname = 'krypto') || '|' ||
     (SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname = 'drizzle') || '|' ||
     (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'krypto' AND c.relowner::regrole::text <> 'krypto_schema_owner')::text;")"
if [[ "$ownership_result" != "krypto_schema_owner|krypto_migrator|0" ]]; then
  echo "Trust boundary ownership is not as required (krypto -> schema owner, drizzle -> migrator, zero stray-owned krypto objects): $ownership_result" >&2
  exit 1
fi

# 2. Role attributes: exact LOGIN/NOLOGIN, NOINHERIT, and connection-limit
# matrix for all four roles. krypto_migrator alone may log in, must be
# NOINHERIT, and gets a small bounded (not unlimited) connection limit; the
# other three are NOLOGIN with a connection limit of zero (defense in
# depth -- they can never be connected to directly regardless of LOGIN).
role_attrs_result="$(psql "$azure_target_url" -Atc \
  "SELECT string_agg(rolname || ':' || rolcanlogin::text || ':' || rolinherit::text || ':' || rolconnlimit::text, ',' ORDER BY rolname)
     FROM pg_roles
    WHERE rolname IN ('krypto_schema_owner', 'krypto_migrator', 'krypto_scheduler', 'krypto_runtime');")"
if [[ "$role_attrs_result" != "krypto_migrator:true:false:5,krypto_runtime:false:true:0,krypto_scheduler:false:true:0,krypto_schema_owner:false:true:0" ]]; then
  echo "Trust boundary role attributes/connection limits are not as required: $role_attrs_result" >&2
  exit 1
fi

# 3. Membership and SET-ROLE-only boundary: krypto_migrator's only path to
# krypto_schema_owner is an explicit SET ROLE, never automatic inheritance;
# krypto_migrator is never a member of krypto_scheduler; krypto_runtime
# (and the runtime login role that only inherits krypto_runtime) are never
# members of any of the three elevated roles.
membership_result="$(psql "$azure_target_url" -Atc \
  "SELECT
     pg_has_role('krypto_migrator', 'krypto_schema_owner', 'USAGE')::text || '|' ||
     pg_has_role('krypto_migrator', 'krypto_schema_owner', 'SET')::text || '|' ||
     pg_has_role('krypto_migrator', 'krypto_scheduler', 'MEMBER')::text || '|' ||
     pg_has_role('krypto_runtime', 'krypto_schema_owner', 'MEMBER')::text || '|' ||
     pg_has_role('krypto_runtime', 'krypto_migrator', 'MEMBER')::text || '|' ||
     pg_has_role('krypto_runtime', 'krypto_scheduler', 'MEMBER')::text || '|' ||
     pg_has_role('$azure_login_role', 'krypto_schema_owner', 'MEMBER')::text || '|' ||
     pg_has_role('$azure_login_role', 'krypto_migrator', 'MEMBER')::text || '|' ||
     pg_has_role('$azure_login_role', 'krypto_scheduler', 'MEMBER')::text || '|' ||
     pg_has_role('$azure_login_role', 'krypto_runtime', 'MEMBER')::text;")"
if [[ "$membership_result" != "false|true|false|false|false|false|false|false|false|true" ]]; then
  echo "Trust boundary membership/SET-ROLE boundary is not as required (migrator: SET-only to owner, never a scheduler member; runtime and its login role: never members of owner/migrator/scheduler, runtime login inherits only krypto_runtime): $membership_result" >&2
  exit 1
fi

# 4. Migration-only access: connecting directly as krypto_migrator (no SET
# ROLE) must be unable to read or write any krypto-schema application
# table, and must not even hold USAGE on the schema -- its only access is
# via the SET-only path proven above, exercised transiently inside
# migrations themselves.
migrator_direct_url="$(with_role_credentials "$azure_target_url" krypto_migrator "$azure_migrator_password")"
if PGPASSWORD="$azure_migrator_password" psql "$migrator_direct_url" \
  -Atc 'SELECT 1 FROM "krypto"."AgentState";' >/dev/null 2>"$TEMP_DIR/migrator-direct-select.log"; then
  echo "krypto_migrator was able to read krypto.AgentState without SET ROLE; the NOINHERIT migration-only boundary is not enforced" >&2
  exit 1
fi
if ! grep -qi "permission denied" "$TEMP_DIR/migrator-direct-select.log"; then
  echo "krypto_migrator's direct read attempt failed for an unexpected reason: $(cat "$TEMP_DIR/migrator-direct-select.log")" >&2
  exit 1
fi
migrator_usage_result="$(psql "$azure_target_url" -Atc \
  "SELECT has_schema_privilege('krypto_migrator', 'krypto', 'USAGE')::text;")"
if [[ "$migrator_usage_result" != "false" ]]; then
  echo "krypto_migrator unexpectedly holds direct USAGE on schema krypto: $migrator_usage_result" >&2
  exit 1
fi

# 5. krypto_runtime must have no access whatsoever to the drizzle
# migration ledger (schema, tables, or sequences) -- migration history is
# strictly off-limits to the runtime identity.
runtime_ledger_result="$(psql "$azure_target_url" -Atc \
  "SELECT
     has_schema_privilege('krypto_runtime', 'drizzle', 'USAGE')::text || '|' ||
     has_table_privilege('krypto_runtime', 'drizzle.__drizzle_migrations', 'SELECT')::text;")"
if [[ "$runtime_ledger_result" != "false|false" ]]; then
  echo "krypto_runtime unexpectedly has access to the drizzle migration ledger: $runtime_ledger_result" >&2
  exit 1
fi

# 6. Denial matrix for legacy/unrelated Supabase-style schemas: on a
# separate scratch database, establish real pre-existing krypto_runtime
# and PUBLIC grants on vault/cron/net/pg_net schemas *before* the admin
# bootstrap runs, so the revoke-if-present logic has genuine grants to
# revoke rather than a vacuous no-op over schemas that were never present.
#
# This must model a genuine upgrade, not a from-scratch install: a real
# database that already carries legacy vault/cron/net/pg_net schemas is,
# by definition, one with real migration history already applied as the
# admin identity (mirroring how migration 0004 -- which predates issue
# #133 and reaches into "vault" directly -- was actually deployed). Migrate
# through 0007 as admin first, exactly like azure_upgrade above, then add
# the legacy schemas/grants, then let the admin bootstrap + krypto_migrator
# apply only the new trust-boundary migration (0008), which never touches
# vault/cron/net/pg_net at all.
create_database trust_boundary_denial
DIRECT_URL="$trust_boundary_denial_url" \
  npx drizzle-kit migrate --config "$through_0007_azure_config" >/dev/null
# krypto_runtime is cluster-global (roles are not per-database) and was
# already created by an earlier scenario's bootstrap in this same run;
# reuse it rather than re-creating it.
psql "$trust_boundary_denial_url" -v ON_ERROR_STOP=1 \
  -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'krypto_runtime') THEN CREATE ROLE krypto_runtime NOLOGIN; END IF; END \$\$;" \
  >/dev/null
psql "$trust_boundary_denial_url" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
CREATE SCHEMA vault; CREATE TABLE vault.secrets (id serial PRIMARY KEY, secret text);
CREATE SCHEMA cron; CREATE TABLE cron.job (jobid serial PRIMARY KEY, command text);
CREATE SCHEMA net; CREATE TABLE net.http_request_queue (id serial PRIMARY KEY, url text);
-- The "pg_" namespace prefix is normally reserved for system schemas; a
-- superuser can still create one (mirroring how some legacy Supabase
-- deployments installed pg_net directly into a schema literally named
-- "pg_net") only with this escape hatch set for the session.
SET allow_system_table_mods = on;
CREATE SCHEMA pg_net; CREATE TABLE pg_net.http_response (id serial PRIMARY KEY, body text);
CREATE TABLE public.unrelated_runtime_secret (secret text);
GRANT USAGE ON SCHEMA vault, cron, net, pg_net TO krypto_runtime, PUBLIC;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA vault TO krypto_runtime, PUBLIC;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA cron TO krypto_runtime, PUBLIC;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA net TO krypto_runtime, PUBLIC;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA pg_net TO krypto_runtime, PUBLIC;
GRANT SELECT ON public.unrelated_runtime_secret TO PUBLIC;
SQL

denial_migrator_password="$azure_migrator_password"
bootstrap_and_migrate "$trust_boundary_denial_url" "$denial_migrator_password"

denial_result="$(psql "$trust_boundary_denial_url" -Atc \
  "SELECT
     has_schema_privilege('krypto_runtime', 'vault', 'USAGE')::text || '|' ||
     has_schema_privilege('krypto_runtime', 'cron', 'USAGE')::text || '|' ||
     has_schema_privilege('krypto_runtime', 'net', 'USAGE')::text || '|' ||
     has_schema_privilege('krypto_runtime', 'pg_net', 'USAGE')::text || '|' ||
     has_table_privilege('krypto_runtime', 'vault.secrets', 'SELECT')::text || '|' ||
     has_table_privilege('krypto_runtime', 'cron.job', 'SELECT')::text || '|' ||
     has_table_privilege('krypto_runtime', 'net.http_request_queue', 'SELECT')::text || '|' ||
     has_table_privilege('krypto_runtime', 'pg_net.http_response', 'SELECT')::text;")"
if [[ "$denial_result" != "false|false|false|false|false|false|false|false" ]]; then
  echo "Pre-existing krypto_runtime access to legacy vault/cron/net/pg_net schemas was not fully revoked: $denial_result" >&2
  exit 1
fi

denial_runtime_url="$(with_role_credentials "$trust_boundary_denial_url" "$azure_login_role" \
  "$azure_runtime_password_current")"
for denied_query in \
  'SELECT * FROM vault.secrets' \
  'SELECT * FROM cron.job' \
  'SELECT * FROM net.http_request_queue' \
  'SELECT * FROM pg_net.http_response' \
  'SELECT * FROM public.unrelated_runtime_secret' \
  'SELECT * FROM drizzle.__drizzle_migrations'; do
  if psql "$denial_runtime_url" -Atc "$denied_query" >/dev/null \
    2>"$TEMP_DIR/runtime-denial-attempt.log"; then
    echo "Runtime login unexpectedly succeeded: $denied_query" >&2
    exit 1
  fi
  if ! grep -qi "permission denied" "$TEMP_DIR/runtime-denial-attempt.log"; then
    echo "Runtime denial failed for an unexpected reason ($denied_query): $(cat "$TEMP_DIR/runtime-denial-attempt.log")" >&2
    exit 1
  fi
done

# The admin bootstrap CLI's own JSON report must name every legacy schema
# it found and revoked, so an operator/CI log has an explicit record.
denial_bootstrap_report="$(DIRECT_URL="$trust_boundary_denial_url" \
  KRYPTO_MIGRATOR_LOGIN_PASSWORD="$denial_migrator_password" \
  npx tsx scripts/bootstrap-azure-runtime-role.ts --mode database-roles)"
node - "$denial_bootstrap_report" <<'NODE'
const report = JSON.parse(process.argv[2]);
const expected = ["vault", "cron", "net", "pg_net"];
const revoked = report.legacySchemasRevoked ?? [];
for (const schemaName of expected) {
  if (!revoked.includes(schemaName)) {
    throw new Error(
      `Admin bootstrap did not report revoking legacy schema ${schemaName}: ${JSON.stringify(report)}`,
    );
  }
}
NODE

# 7. krypto_migrator password rotation: the admin bootstrap must be able to
# rotate the migrator's credential without ever leaking it, and the old
# credential must stop working while the new one starts working.
azure_migrator_password_v2="krypto-migrator-test-pw-$(random_test_password)"
DIRECT_URL="$azure_target_url" KRYPTO_MIGRATOR_LOGIN_PASSWORD="$azure_migrator_password_v2" \
  npx tsx scripts/bootstrap-azure-runtime-role.ts --mode database-roles \
  >"$TEMP_DIR/migrator-rotate.json"
if grep -qF "$azure_migrator_password_v2" "$TEMP_DIR/migrator-rotate.json"; then
  echo "krypto_migrator rotation leaked the new password into its own output" >&2
  exit 1
fi

if [[ -z "$TEST_POSTGRES_ADMIN_URL" ]]; then
  # This script controls the cluster, so it can require real
  # scram-sha-256 password authentication over TCP and prove rotation
  # actually invalidates the old credential, exactly as for the runtime
  # login role above.
  migrator_hba_override="$TEMP_DIR/pg_hba.migrator.conf"
  cat >"$migrator_hba_override" <<HBA
host    all             krypto_migrator        127.0.0.1/32            scram-sha-256
HBA
  cat "$migrator_hba_override" "$PGDATA/pg_hba.conf" >"$TEMP_DIR/pg_hba.conf.new"
  mv "$TEMP_DIR/pg_hba.conf.new" "$PGDATA/pg_hba.conf"
  pg_ctl -D "$PGDATA" reload >/dev/null
  sleep 0.2

  if PGPASSWORD="$azure_migrator_password" psql \
    "postgresql://krypto_migrator@127.0.0.1:$PORT/azure_target" \
    -Atc "SELECT 1;" >/dev/null 2>"$TEMP_DIR/migrator-auth-old-after-rotate.log"; then
    echo "krypto_migrator's old password still authenticated after rotation" >&2
    exit 1
  fi
  if ! PGPASSWORD="$azure_migrator_password_v2" psql \
    "postgresql://krypto_migrator@127.0.0.1:$PORT/azure_target" \
    -Atc "SELECT current_user;" >/dev/null 2>"$TEMP_DIR/migrator-auth-new.log"; then
    echo "krypto_migrator's rotated password did not authenticate over TCP: $(cat "$TEMP_DIR/migrator-auth-new.log")" >&2
    exit 1
  fi
fi
azure_migrator_password="$azure_migrator_password_v2"

# 8. deployment-preflight.ts end-to-end pass/fail proof against the fully
# migrated, rotated azure_target: it must pass cleanly with a correct,
# distinct MIGRATION_URL, and fail closed (block) the moment MIGRATION_URL
# is absent or points at the wrong identity.
azure_migration_url="$(with_role_credentials "$azure_target_url" krypto_migrator "$azure_migrator_password")"
pass_report="$TEMP_DIR/trust-boundary-pass-preflight.json"
set +e
DIRECT_URL="$azure_target_url" DATABASE_URL="$azure_runtime_url_current" \
  MIGRATION_URL="$azure_migration_url" \
  npx tsx scripts/deployment-preflight.ts --out "$pass_report" >/dev/null
pass_preflight_status=$?
set -e
node - "$pass_report" <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!report.databasePreflightPassed) {
  throw new Error(`Preflight did not pass with a correct MIGRATION_URL: ${JSON.stringify(report.blockers)}`);
}
const trustBoundaryBlockers = report.blockers.filter(
  (id) => id.startsWith("trust-boundary") || id.startsWith("migration-"),
);
if (trustBoundaryBlockers.length > 0) {
  throw new Error(`Preflight reported unexpected trust-boundary blockers: ${JSON.stringify(trustBoundaryBlockers)}`);
}
NODE
if [[ "$pass_preflight_status" -ne 0 ]]; then
  echo "Deployment preflight with the correct trust boundary returned $pass_preflight_status, expected 0." >&2
  exit 1
fi

missing_migration_report="$TEMP_DIR/trust-boundary-missing-migration-url.json"
set +e
DIRECT_URL="$azure_target_url" DATABASE_URL="$azure_runtime_url_current" \
  npx tsx scripts/deployment-preflight.ts --out "$missing_migration_report" >/dev/null
missing_migration_status=$?
set -e
if [[ "$missing_migration_status" -ne 2 ]]; then
  echo "Deployment preflight without MIGRATION_URL returned $missing_migration_status, expected 2 (fail closed)." >&2
  exit 1
fi
node - "$missing_migration_report" <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!report.blockers.includes("migration-connectivity")) {
  throw new Error(`Preflight did not fail closed on a missing MIGRATION_URL: ${JSON.stringify(report.blockers)}`);
}
NODE

wrong_identity_migration_url="$(with_role_credentials "$azure_target_url" postgres "")"
wrong_identity_report="$TEMP_DIR/trust-boundary-wrong-identity.json"
set +e
DIRECT_URL="$azure_target_url" DATABASE_URL="$azure_runtime_url_current" \
  MIGRATION_URL="$wrong_identity_migration_url" \
  npx tsx scripts/deployment-preflight.ts --out "$wrong_identity_report" >/dev/null
wrong_identity_status=$?
set -e
if [[ "$wrong_identity_status" -ne 2 ]]; then
  echo "Deployment preflight with a same-role (admin-as-migration) MIGRATION_URL returned $wrong_identity_status, expected 2 (fail closed)." >&2
  exit 1
fi
node - "$wrong_identity_report" <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!report.blockers.includes("migration-url-safety") && !report.blockers.includes("migration-identity")) {
  throw new Error(`Preflight did not fail closed on an unsafe/wrong-identity MIGRATION_URL: ${JSON.stringify(report.blockers)}`);
}
NODE

create_database quarantine
psql "$quarantine_url" -v ON_ERROR_STOP=1 \
  -f tests/fixtures/v2-schema.sql >/dev/null
psql "$quarantine_url" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
INSERT INTO "public"."AgentState" (
  "id", "currentPositionETH", "currentPositionUSDC",
  "portfolioValueUSD", "isLocked", "isRunning", "updatedAt"
) VALUES ('singleton', 0.02, 179.94, 195, false, false, NOW());

INSERT INTO "public"."TradeExecution" (
  "id", "direction", "asset", "amountUSD", "amountAsset",
  "executionPrice", "feesUSD", "slippage", "agentReasoning"
) VALUES (
  'quarantine-trade', 'BUY', 'ETH', 20, 0.01, 2000, 0.06, 0,
  'inconsistent legacy balance sentinel'
);
SQL

DIRECT_URL="$quarantine_url" \
  npx drizzle-kit migrate --config "$through_0007_legacy_config" >/dev/null

quarantine_result="$(psql "$quarantine_url" -Atc \
  'SELECT "accountingStatus"::text || '\''|'\'' ||
          ("accountingIssue" LIKE '\''legacy ETH balance mismatch:%'\'')::text
     FROM "krypto"."AgentState"
    WHERE "id" = '\''singleton'\'';')"
if [[ "$quarantine_result" != "QUARANTINED|true" ]]; then
  echo "Unreconciled legacy account was not quarantined: $quarantine_result" >&2
  exit 1
fi

create_database executor
bootstrap_and_migrate "$executor_url" "krypto-migrator-test-pw-$(random_test_password)"
DIRECT_URL="$executor_url" npx tsx scripts/seed.ts >/dev/null
DATABASE_URL="$executor_url" npx tsx scripts/test-paper-executor.ts

create_database orchestration
bootstrap_and_migrate "$orchestration_url" "krypto-migrator-test-pw-$(random_test_password)"
DIRECT_URL="$orchestration_url" npx tsx scripts/seed.ts >/dev/null
DATABASE_URL="$orchestration_url" npx tsx scripts/test-run-flow.ts

create_database operations
# Pinned to 0006 (see through_0006_config above): this database exercises
# the legacy Supabase pg_cron/pg_net HTTP-invocation functions extensively
# below (cron enable/disable SQL, function-integrity preflight checks, the
# unowned scripts/test-deployment-preflight.ts harness), which 0007
# permanently retires.
DIRECT_URL="$operations_url" \
  npx drizzle-kit migrate --config "$through_0006_config" >/dev/null
DIRECT_URL="$operations_url" npx tsx scripts/seed.ts >/dev/null

# Current application routes require the durable 0010 safety outbox. Keep the
# legacy 0006 database above only for retired Supabase function/preflight
# compatibility checks; never add a runtime fallback for a missing outbox.
create_database current_routes
bootstrap_and_migrate "$current_routes_url" "krypto-migrator-test-pw-$(random_test_password)"
DIRECT_URL="$current_routes_url" npx tsx scripts/seed.ts >/dev/null
DATABASE_URL="$current_routes_url" npx tsx scripts/test-operations-routes.ts
DIRECT_URL="$operations_url" DATABASE_URL="$operations_url" \
  npx tsx scripts/test-target-smoke-evidence.ts
DIRECT_URL="$operations_url" DATABASE_URL="$operations_url" \
  npx tsx scripts/test-deployment-preflight.ts

create_database migration_only
psql "$migration_only_url" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
CREATE SCHEMA drizzle;
CREATE TABLE drizzle.__drizzle_migrations (
  id serial PRIMARY KEY,
  hash text NOT NULL,
  created_at bigint
);
SQL
if DIRECT_URL="$operations_url" DATABASE_URL="$migration_only_url" \
  npx tsx scripts/create-verified-backup.ts \
  --out "$TEMP_DIR/mismatched-target-backup" >/dev/null 2>&1; then
  echo "Backup unexpectedly accepted different runtime/direct targets." >&2
  exit 1
fi
if DIRECT_URL="$migration_only_url" DATABASE_URL="$migration_only_url" \
  npx tsx scripts/create-verified-backup.ts \
  --out "$TEMP_DIR/migration-only-backup" >/dev/null 2>&1; then
  echo "Backup unexpectedly verified a migration-only database." >&2
  exit 1
fi

psql "$operations_url" -v ON_ERROR_STOP=1 \
  -c "ALTER FUNCTION krypto.invoke_agent_run() SET statement_timeout = '1ms';" \
  >/dev/null
if config_error="$(psql "$operations_url" -v ON_ERROR_STOP=1 \
  -f supabase/operations/enable-krypto-cron.sql 2>&1)"; then
  echo "Cron enablement accepted an additional function setting." >&2
  exit 1
fi
if [[ "$config_error" != *"Agent-run cron function failed integrity verification"* ]]; then
  echo "Cron enablement did not reject non-canonical function settings." >&2
  exit 1
fi
config_report="$TEMP_DIR/function-config-preflight.json"
set +e
DIRECT_URL="$operations_url" DATABASE_URL="$operations_url" \
  npx tsx scripts/deployment-preflight.ts \
  --out "$config_report" >/dev/null
config_status=$?
set -e
if [[ "$config_status" -ne 2 ]]; then
  echo "Function-config preflight returned $config_status, expected 2." >&2
  exit 1
fi
node - "$config_report" <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!report.blockers.includes("fixed-cron-function-integrity")) {
  throw new Error("Preflight accepted additional function settings.");
}
NODE
psql "$operations_url" -v ON_ERROR_STOP=1 \
  -c "ALTER FUNCTION krypto.invoke_agent_run() RESET statement_timeout;" \
  >/dev/null
DIRECT_URL="$operations_url" DATABASE_URL="$operations_url" \
  npx tsx scripts/test-deployment-preflight.ts

psql "$operations_url" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
GRANT SELECT ON TABLE "krypto"."AgentState" TO PUBLIC;
CREATE OR REPLACE FUNCTION "krypto"."invoke_agent_run"()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  RETURN 0;
END
$$;
SQL
if tamper_error="$(psql "$operations_url" -v ON_ERROR_STOP=1 \
  -f supabase/operations/enable-krypto-cron.sql 2>&1)"; then
  echo "Cron enablement accepted a tampered invocation function." >&2
  exit 1
fi
if [[ "$tamper_error" != *"Agent-run cron function failed integrity verification"* ]]; then
  echo "Cron enablement failed before proving function-integrity rejection." >&2
  exit 1
fi
tampered_report="$TEMP_DIR/tampered-preflight.json"
set +e
DIRECT_URL="$operations_url" DATABASE_URL="$operations_url" \
  npx tsx scripts/deployment-preflight.ts \
  --out "$tampered_report" >/dev/null
tampered_status=$?
set -e
if [[ "$tampered_status" -ne 2 ]]; then
  echo "Tampered deployment preflight returned $tampered_status, expected 2." >&2
  exit 1
fi
node - "$tampered_report" <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
for (const blocker of [
  "fixed-cron-function-integrity",
  "restricted-role-privileges",
]) {
  if (!report.blockers.includes(blocker)) {
    throw new Error(`Tampered preflight did not report ${blocker}.`);
  }
}
NODE
psql "$operations_url" -v ON_ERROR_STOP=1 \
  -f drizzle/0002_secure_private_schema.sql >/dev/null
psql "$operations_url" -v ON_ERROR_STOP=1 \
  -f drizzle/0006_reject_null_cron_rollout_mode.sql >/dev/null
DIRECT_URL="$operations_url" DATABASE_URL="$operations_url" \
  npx tsx scripts/test-deployment-preflight.ts

psql "$operations_url" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
CREATE SCHEMA cron;
CREATE TABLE cron.job (
  jobid bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  jobname text,
  schedule text NOT NULL DEFAULT '0 * * * *',
  command text,
  active boolean NOT NULL
);
CREATE FUNCTION cron.unschedule(target_jobid bigint)
RETURNS boolean
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM cron.job WHERE jobid = target_jobid;
  RETURN FOUND;
END
$$;
INSERT INTO cron.job (jobname, command, active)
VALUES (
  'hourly-http-job',
  'SELECT net.http_post(url := ''https://example.test/api/agent/run'');',
  true
);
SQL
if DIRECT_URL="$operations_url" DATABASE_URL="$operations_url" \
  npx tsx scripts/create-verified-backup.ts \
  --out "$TEMP_DIR/active-cron-backup" >/dev/null 2>&1; then
  echo "Backup unexpectedly succeeded while Krypto cron was active." >&2
  exit 1
fi
psql "$operations_url" -v ON_ERROR_STOP=1 \
  -c "UPDATE cron.job SET active = false;" >/dev/null

psql "$operations_url" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
CREATE SCHEMA net;
CREATE TABLE net.http_request_queue (
  id bigint GENERATED ALWAYS AS IDENTITY,
  url text NOT NULL
);
INSERT INTO net.http_request_queue (url)
VALUES ('https://example.test/api/agent/run');
SQL
pending_report="$TEMP_DIR/pending-http-preflight.json"
set +e
DIRECT_URL="$operations_url" DATABASE_URL="$operations_url" \
  npx tsx scripts/deployment-preflight.ts \
  --out "$pending_report" >/dev/null
pending_status=$?
set -e
if [[ "$pending_status" -ne 2 ]]; then
  echo "Pending-request preflight returned $pending_status, expected 2." >&2
  exit 1
fi
node - "$pending_report" <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!report.blockers.includes("pending-http-requests")) {
  throw new Error("Preflight accepted a queued Krypto HTTP request.");
}
NODE
if DIRECT_URL="$operations_url" DATABASE_URL="$operations_url" \
  npx tsx scripts/create-verified-backup.ts \
  --out "$TEMP_DIR/pending-http-backup" >/dev/null 2>&1; then
  echo "Backup unexpectedly succeeded with a queued Krypto request." >&2
  exit 1
fi
psql "$operations_url" -v ON_ERROR_STOP=1 \
  -f supabase/operations/disable-krypto-cron.sql >/dev/null
disabled_result="$(psql "$operations_url" -Atc \
  'SELECT (SELECT count(*) FROM cron.job) || '\''|'\'' ||
          (SELECT count(*) FROM net.http_request_queue);')"
if [[ "$disabled_result" != "0|0" ]]; then
  echo "Disable operation left cron or queued HTTP work: $disabled_result" >&2
  exit 1
fi

backup_dir="$TEMP_DIR/verified-backup"
DIRECT_URL="$operations_url" DATABASE_URL="$operations_url" \
  npx tsx scripts/create-verified-backup.ts \
  --out "$backup_dir" \
  --restore-test-url "$admin_url" >/dev/null
node - "$backup_dir/manifest.json" <<'NODE'
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (
  manifest.schemaVersion !== "1.3.0" ||
  manifest.verified !== true ||
  !manifest.source?.systemIdentifier ||
  !manifest.source?.runtimeTarget ||
  !manifest.source?.directTarget ||
  manifest.archives.length === 0 ||
  manifest.restoreVerification?.matched !== true
) {
  throw new Error("Verified backup manifest is incomplete.");
}
NODE

echo "Migration tests passed for PostgreSQL 17 fresh install and upgrades, schema security, transactional paper execution, run orchestration, operations, preflight, backup restoration, the PostgreSQL trust boundary, bounded execution 0009, and append-only safety incidents 0010 (0009 row preservation, safe AgentRun correlation backfills, CREATED deduplication, immutable evidence triggers, contract v2 fingerprint, and exact runtime grants/denials)."
