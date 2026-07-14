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

required_commands=(psql node npx)
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

create_database() {
  psql "$admin_url" -v ON_ERROR_STOP=1 \
    -c "CREATE DATABASE \"$1\";" >/dev/null
}

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
DIRECT_URL="$fresh_url" npx drizzle-kit migrate >/dev/null

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
SQL

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
            WHERE "id" = '\''upgrade-trade-3'\'');')"
if [[ "$upgrade_result" != "1|3|1|false|true|RECONCILED|2194.06250000|2|0.012000000000000000|2.50000000|2000.00000000|2500.00000000|0.012000000000000000|174.86500000|2194.06250000" ]]; then
  echo "Existing v2 upgrade did not preserve data or add defaults: $upgrade_result" >&2
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
DIRECT_URL="$operations_url" npx drizzle-kit migrate >/dev/null
DIRECT_URL="$operations_url" npx tsx scripts/seed.ts >/dev/null
DATABASE_URL="$operations_url" npx tsx scripts/test-operations-routes.ts

echo "Migration tests passed for fresh install, private-schema security, decimal round-trip, idempotency constraints, v2 reconciliation, quarantine, transactional execution, run orchestration, and operations routes."
