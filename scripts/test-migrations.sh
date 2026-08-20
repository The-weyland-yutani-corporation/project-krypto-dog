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
  dbCredentials: { url: process.env.DIRECT_URL },
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
  EXCEPTION WHEN unique_violation THEN
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

DIRECT_URL="$upgrade_url" npx drizzle-kit migrate >/dev/null

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

# --- Azure PostgreSQL safety transition (drizzle/0007): fresh install ---
#
# A clean target migrated to the current (default, full) migration set must
# have both obsolete Supabase HTTP cron functions absent and the
# least-privilege krypto_runtime group role established with the exact,
# fail-closed per-table privilege matrix (no more, no less): AgentState
# SELECT+UPDATE only; AgentRun SELECT+INSERT+UPDATE; TradeExecution
# SELECT+INSERT only; AgentJournal SELECT+INSERT only. No table anywhere may
# carry a row-removal, table-clearing, TRIGGER, or REFERENCES privilege for
# krypto_runtime, and the schema has no sequences to grant.

latest_migration_hash="6b393d6ea01caf3a5b5addf8e939e7e22f3b38706b088caee6f0eb304b7e10d7"

create_database azure_target
DIRECT_URL="$azure_target_url" npx drizzle-kit migrate >/dev/null

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
          has_schema_privilege('\''authenticated'\'', '\''krypto'\'', '\''USAGE'\'')::text;')"
if [[ "$azure_fresh_result" != "9|$latest_migration_hash|true|true|true|true|true|true|false|false|true|true|true|false|true|true|false|false|false|false|false|true|true|false|false|true|false|false|false" ]]; then
  echo "Fresh Azure migration did not retire obsolete cron functions or establish the exact krypto_runtime privilege matrix: $azure_fresh_result" >&2
  exit 1
fi


# Reapplying 0007 directly must remain idempotent (guarded role creation,
# IF EXISTS drops, additive grants/revokes).
psql "$azure_target_url" -v ON_ERROR_STOP=1 \
  -f drizzle/0007_azure_retire_supabase_http_functions.sql >/dev/null
psql "$azure_target_url" -v ON_ERROR_STOP=1 \
  -f drizzle/0007_azure_retire_supabase_http_functions.sql >/dev/null

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

DIRECT_URL="$azure_upgrade_url" npx drizzle-kit migrate >/dev/null

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
          (SELECT ("portfolioValuationPriceUSD" IS NULL)::text FROM "krypto"."AgentState"
            WHERE "id" = '\''singleton'\'');')"
if [[ "$azure_upgrade_result" != "9|1|1|1|1|0.123456789012345678|true|true|true|false|false|false|true|true" ]]; then
  echo "0006-to-current upgrade did not preserve rows, leave nullable valuation provenance empty, retire cron functions, or establish the exact krypto_runtime privilege matrix: $azure_upgrade_result" >&2
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

DIRECT_URL="$quarantine_url" npx drizzle-kit migrate >/dev/null

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
DIRECT_URL="$executor_url" npx drizzle-kit migrate >/dev/null
DIRECT_URL="$executor_url" npx tsx scripts/seed.ts >/dev/null
DATABASE_URL="$executor_url" npx tsx scripts/test-paper-executor.ts

create_database orchestration
DIRECT_URL="$orchestration_url" npx drizzle-kit migrate >/dev/null
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
psql "$operations_url" -v ON_ERROR_STOP=1 \
  -c 'ALTER TABLE "krypto"."AgentState" ADD COLUMN "portfolioValuationPriceUSD" numeric(20, 8) DEFAULT NULL;' \
  >/dev/null
DIRECT_URL="$operations_url" npx tsx scripts/seed.ts >/dev/null
DATABASE_URL="$operations_url" npx tsx scripts/test-operations-routes.ts
DIRECT_URL="$operations_url" npx tsx scripts/test-target-smoke-evidence.ts
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

echo "Migration tests passed for fresh install, original-0005-to-0006 rollout upgrade, private-schema security, cron rollout-mode fail-closed validation, decimal round-trip, idempotency constraints, v2 reconciliation, quarantine, transactional execution, run orchestration, operations routes, target-smoke evidence, deployment preflight, verified backup restoration, and the Azure PostgreSQL safety transition (0007 fresh install and 0006-to-0007 upgrade with row preservation, retirement of the obsolete Supabase HTTP cron functions, the exact fail-closed per-table krypto_runtime privilege matrix with no excess grants, idempotent password-based runtime-login bootstrap with real scram-sha-256 authentication and rotation proof where the cluster is self-managed, username-mismatch and elevated-role rejection, and the idempotent password-free membership-only bootstrap path)."
