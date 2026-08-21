import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import postgres from "postgres";
import { closeDatabase } from "../src/db";
import { POST as pause } from "../src/app/api/admin/pause/route";
import { POST as releaseLease } from "../src/app/api/admin/release-run-lease/route";
import { POST as unlock } from "../src/app/api/admin/unlock/route";
import { POST as dailySummary } from "../src/app/api/agent/daily-summary/route";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
process.env.CRON_SECRET = "operations-route-test-secret";
process.env.ADMIN_IDENTITY_MODE = "entra";
process.env.ADMIN_PLATFORM_AUTH = "azure-container-apps";
process.env.ADMIN_ENTRA_TENANT_ID =
  "11111111-1111-4111-8111-111111111111";
process.env.ADMIN_ENTRA_CLIENT_ID =
  "22222222-2222-4222-8222-222222222222";
process.env.ADMIN_ENTRA_AUDIENCE =
  "22222222-2222-4222-8222-222222222222";
process.env.ADMIN_ENTRA_ISSUER =
  "https://login.microsoftonline.com/11111111-1111-4111-8111-111111111111/v2.0";
process.env.ADMIN_ENTRA_OPERATOR_ALLOWLIST = JSON.stringify([
  {
    id: "33333333-3333-4333-8333-333333333333",
    name: "Operations Route Test",
    role: "RELEASE_OWNER",
  },
]);
process.env.ADMIN_ENTRA_MFA_AUTH_CONTEXT = "c1";
process.env.ADMIN_ENTRA_STEP_UP_AUTH_CONTEXT = "c2";
process.env.ADMIN_AUTH_NOT_BEFORE = "1970-01-01T00:00:00.000Z";
process.env.ADMIN_AUTH_POLICY_VERSION = "operations-route-test-v1";
delete process.env.AZURE_COMMUNICATION_CONNECTION_STRING;
delete process.env.AZURE_COMMUNICATION_EMAIL_SENDER;
delete process.env.ALERT_EMAIL_TO;

const sql = postgres(databaseUrl, { max: 1, prepare: false });
function adminPrincipalHeader(): string {
  const now = Math.floor(Date.now() / 1000);
  return Buffer.from(
    JSON.stringify({
      auth_typ: "aad",
      name_typ: "name",
      role_typ: "roles",
      claims: [
        {
          typ: "aud",
          val: "22222222-2222-4222-8222-222222222222",
        },
        {
          typ: "iss",
          val: "https://login.microsoftonline.com/11111111-1111-4111-8111-111111111111/v2.0",
        },
        { typ: "iat", val: String(now - 30) },
        { typ: "nbf", val: String(now - 30) },
        { typ: "exp", val: String(now + 3600) },
        {
          typ: "oid",
          val: "33333333-3333-4333-8333-333333333333",
        },
        { typ: "sub", val: "operations-route-test-subject" },
        {
          typ: "tid",
          val: "11111111-1111-4111-8111-111111111111",
        },
        {
          typ: "sid",
          val: "55555555-5555-4555-8555-555555555555",
        },
        { typ: "auth_time", val: String(now - 30) },
        { typ: "amr", val: "mfa" },
        { typ: "acrs", val: "c1" },
        { typ: "acrs", val: "c2" },
        { typ: "roles", val: "Krypto.Admin.ReleaseOwner" },
      ],
    }),
    "utf8",
  ).toString("base64");
}

function adminRequest(path: string, body?: unknown): NextRequest {
  return new NextRequest(
    new Request(`http://localhost:3000${path}`, {
      method: "POST",
      headers: {
        origin: "http://localhost:3000",
        "content-type": "application/json",
        "x-ms-client-principal": adminPrincipalHeader(),
        "x-ms-client-principal-id":
          "33333333-3333-4333-8333-333333333333",
        "x-ms-client-principal-idp": "aad",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

async function main(): Promise<void> {
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
