import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import postgres from "postgres";
import { closeDatabase } from "../src/db";
import { createAdminSessionToken } from "../src/lib/admin-auth";
import { POST as pause } from "../src/app/api/admin/pause/route";
import { POST as releaseLease } from "../src/app/api/admin/release-run-lease/route";
import { POST as unlock } from "../src/app/api/admin/unlock/route";
import { POST as dailySummary } from "../src/app/api/agent/daily-summary/route";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
process.env.CRON_SECRET = "operations-route-test-secret";
process.env.ADMIN_SESSION_SECRET = "operations-route-admin-secret";
delete process.env.AZURE_COMMUNICATION_CONNECTION_STRING;
delete process.env.AZURE_COMMUNICATION_EMAIL_SENDER;
delete process.env.ALERT_EMAIL_TO;

const sql = postgres(databaseUrl, { max: 1, prepare: false });
let adminToken = "";

function adminRequest(path: string, body?: unknown): NextRequest {
  return new NextRequest(
    new Request(`http://localhost:3000${path}`, {
      method: "POST",
      headers: {
        origin: "http://localhost:3000",
        "content-type": "application/json",
        cookie: `krypto-admin-token=${adminToken}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

async function main(): Promise<void> {
  adminToken = await createAdminSessionToken(
    "operations-route-admin-secret",
  );
  let response = await pause(
    adminRequest("/api/admin/pause", { paused: true }),
  );
  assert.equal(response.status, 200);
  const [pausedState] = await sql<
    Array<{ isOperatorPaused: boolean }>
  >`SELECT "isOperatorPaused" FROM "krypto"."AgentState" WHERE id = 'singleton'`;
  assert.equal(pausedState.isOperatorPaused, true);

  let [audit] = await sql<Array<{ event: string; paused: boolean }>>`
    SELECT
      "marketConditions"->>'event' AS event,
      ("marketConditions"->>'paused')::boolean AS paused
    FROM "krypto"."AgentJournal"
    ORDER BY "createdAt" DESC
    LIMIT 1
  `;
  assert.deepEqual(audit, { event: "operator-pause", paused: true });

  await sql`
    UPDATE "krypto"."AgentState"
    SET
      "isRunning" = true,
      "leaseOwner" = 'expired-route-test',
      "leaseExpiresAt" = NOW() - INTERVAL '1 minute'
    WHERE id = 'singleton'
  `;
  response = await releaseLease(
    adminRequest("/api/admin/release-run-lease"),
  );
  assert.equal(response.status, 200);
  const [releasedState] = await sql<Array<{ isRunning: boolean }>>`
    SELECT "isRunning" FROM "krypto"."AgentState" WHERE id = 'singleton'
  `;
  assert.equal(releasedState.isRunning, false);
  [audit] = await sql<Array<{ event: string; paused: boolean }>>`
    SELECT
      "marketConditions"->>'event' AS event,
      false AS paused
    FROM "krypto"."AgentJournal"
    ORDER BY "createdAt" DESC
    LIMIT 1
  `;
  assert.equal(audit.event, "lease-recovery");

  await sql`
    UPDATE "krypto"."AgentState"
    SET
      "isLocked" = true,
      "isOperatorPaused" = false,
      "lockReason" = 'route-test drawdown',
      "lockedAt" = NOW(),
      "leaseOwner" = NULL,
      "leaseExpiresAt" = NULL
    WHERE id = 'singleton'
  `;
  response = await unlock(
    adminRequest("/api/admin/unlock", {
      confirm: "UNLOCK",
      reason: "Reconciled the ledger and reviewed every recent execution.",
    }),
  );
  assert.equal(response.status, 200);
  const [unlocked] = await sql<
    Array<{
      isLocked: boolean;
      isOperatorPaused: boolean;
      lockReason: string | null;
    }>
  >`
    SELECT "isLocked", "isOperatorPaused", "lockReason"
    FROM "krypto"."AgentState"
    WHERE id = 'singleton'
  `;
  assert.deepEqual(unlocked, {
    isLocked: false,
    isOperatorPaused: true,
    lockReason: null,
  });
  [audit] = await sql<Array<{ event: string; paused: boolean }>>`
    SELECT
      "marketConditions"->>'event' AS event,
      true AS paused
    FROM "krypto"."AgentJournal"
    ORDER BY "createdAt" DESC
    LIMIT 1
  `;
  assert.equal(audit.event, "operator-unlock");

  await sql`
    UPDATE "krypto"."AgentState"
    SET
      "isLocked" = true,
      "leaseOwner" = 'active-route-test',
      "leaseExpiresAt" = NOW() + INTERVAL '1 minute'
    WHERE id = 'singleton'
  `;
  response = await unlock(
    adminRequest("/api/admin/unlock", {
      confirm: "UNLOCK",
      reason: "This request must be rejected while the lease is active.",
    }),
  );
  assert.equal(response.status, 409);
  const [stillLocked] = await sql<Array<{ isLocked: boolean }>>`
    SELECT "isLocked" FROM "krypto"."AgentState" WHERE id = 'singleton'
  `;
  assert.equal(stillLocked.isLocked, true);

  await sql`
    UPDATE "krypto"."AgentState"
    SET
      "isLocked" = false,
      "leaseOwner" = NULL,
      "leaseExpiresAt" = NULL
    WHERE id = 'singleton'
  `;
  response = await dailySummary(
    new NextRequest(
      new Request("http://localhost:3000/api/agent/daily-summary", {
        method: "POST",
        headers: {
          "x-cron-secret": "operations-route-test-secret",
          "x-required-rollout-mode": "disabled",
        },
      }),
    ),
  );
  assert.equal(response.status, 200);
  const summary = (await response.json()) as {
    delivery: { status: string };
    alertAuditRecorded: boolean;
  };
  assert.equal(summary.delivery.status, "skipped");
  assert.equal(summary.alertAuditRecorded, true);

  const [deliveryAudit] = await sql<
    Array<{ event: string; status: string }>
  >`
    SELECT
      "marketConditions"->>'event' AS event,
      "marketConditions"->>'status' AS status
    FROM "krypto"."AgentJournal"
    ORDER BY "createdAt" DESC
    LIMIT 1
  `;
  assert.deepEqual(deliveryAudit, {
    event: "daily-summary-delivery",
    status: "skipped",
  });

  console.log(
    "Operations route tests passed for atomic audits, safe unlock, active-lease refusal, and alert delivery evidence.",
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.all([sql.end(), closeDatabase()]);
  });
