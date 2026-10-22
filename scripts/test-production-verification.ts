import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

import { closeDatabase } from "@/db";
import {
  runProductionVerification,
  type ProductionVerificationOptions,
} from "@/deployment/production-verification";
import { buildIdempotencyKey } from "@/deployment/scheduled-trigger";
import { createTargetApproval, createTargetBinding } from "@/deployment/target-smoke";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
const target = new URL(databaseUrl);
assert(["postgres:", "postgresql:"].includes(target.protocol) && !target.search && !target.hash,
  "Production verification fixtures require a plain PostgreSQL URL without query overrides.");
assert(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname),
  "Production verification fixtures require a loopback database.");
assert.equal(target.pathname, "/production_verification", "Use the suite's disposable database only.");
const sql = postgres(databaseUrl, { max: 1, prepare: false });
const hour = Math.floor(Date.now() / 3_600_000) * 3600;
const start = new Date(hour * 1000);
const common = {
  databaseUrl,
  releaseSha: "a".repeat(40), imageDigest: `sha256:${"b".repeat(64)}`,
  targetOrigin: "https://production-verification.example.com",
  authorizationId: "c".repeat(64), scheduleGeneration: hour - 120,
  posthogApiKey: "disposable-test-project-key", posthogHost: "https://us.i.posthog.com",
  posthogEnvironment: "prod",
  approvalSecret: "disposable-production-approval-secret-with-32-characters",
};
const scheduled: Extract<ProductionVerificationOptions, { phase: "scheduled" }> = {
  ...common, phase: "scheduled", scheduleEnabledAt: hour - 60,
  scheduledExecutionStartedAt: start.toISOString(),
};

async function snapshot(): Promise<string> {
  const [row] = await sql<Array<{ snapshot: string }>>`
    SELECT json_build_object(
      'state', (SELECT row_to_json(s) FROM "krypto"."AgentState" s WHERE id = 'singleton'),
      'runs', (SELECT json_agg(r ORDER BY id) FROM "krypto"."AgentRun" r),
      'journal', (SELECT json_agg(j ORDER BY id) FROM "krypto"."AgentJournal" j),
      'trades', (SELECT json_agg(t ORDER BY id) FROM "krypto"."TradeExecution" t),
      'fences', (SELECT json_agg(f ORDER BY owner) FROM "krypto"."DeploymentFence" f)
    )::text AS snapshot
  `;
  return row.snapshot;
}

async function verify(options: ProductionVerificationOptions, approved: boolean): Promise<void> {
  const before = await snapshot();
  const report = await runProductionVerification(options);
  assert.equal(report.approved, approved, JSON.stringify(report.blockers));
  assert.equal(report.schemaVersion, "1.1.0");
  assert.match(report.posthog.keyBinding, /^[0-9a-f]{64}$/);
  assert(!JSON.stringify(report).includes(options.posthogApiKey));
  assert(!JSON.stringify(report).includes(options.approvalSecret));
  assert.equal(await snapshot(), before, "Verification must not change ledger, journal, lease or fence state.");
}

async function main(): Promise<void> {
  const runId = randomUUID();
  const journalId = randomUUID();
  const key = buildIdempotencyKey("/api/agent/run", start, undefined,
    `${common.imageDigest}-${common.scheduleGeneration}`);
  assert(key);
  await sql`
    INSERT INTO "krypto"."AgentRun" (
      id, "idempotencyKey", "triggerSource", "tradingMode", "outcome",
      "strategyVersion", "startedAt", "completedAt"
    ) VALUES (${runId}, ${key}, 'cron', 'PAPER', 'HOLD', 'production-proof-test', ${start}, ${start})
  `;
  await verify(scheduled, false);
  await sql`
    INSERT INTO "krypto"."AgentJournal" (id, "entryText", "marketConditions", "agentRunId")
    VALUES (${journalId}, 'Disposable scheduled paper journal.', '{}'::jsonb, ${runId})
  `;
  await verify(scheduled, true);
  await sql`UPDATE "krypto"."AgentState" SET "isOperatorPaused" = true WHERE id = 'singleton'`;
  await verify(scheduled, false);
  await sql`UPDATE "krypto"."AgentState" SET "isOperatorPaused" = false WHERE id = 'singleton'`;
  await sql`
    UPDATE "krypto"."AgentState"
    SET "isRunning" = true, "leaseOwner" = 'proof-test-lease',
        "leaseExpiresAt" = clock_timestamp() + INTERVAL '1 minute'
    WHERE id = 'singleton'
  `;
  await verify(scheduled, false);
  await sql`
    UPDATE "krypto"."AgentState"
    SET "isRunning" = false, "leaseOwner" = NULL, "leaseExpiresAt" = NULL
    WHERE id = 'singleton'
  `;
  const fenceOwner = randomUUID();
  await sql`
    INSERT INTO "krypto"."DeploymentFence" (
      owner, "sourceReleaseSha", "candidateReleaseSha", "imageDigest", "targetOrigin", "expiresAt"
    ) VALUES (${fenceOwner}, ${"d".repeat(40)}, ${common.releaseSha}, ${common.imageDigest},
      ${common.targetOrigin}, clock_timestamp() + INTERVAL '1 hour')
  `;
  await verify(scheduled, false);
  await sql`
    UPDATE "krypto"."DeploymentFence" SET "releasedAt" = clock_timestamp() WHERE owner = ${fenceOwner}
  `;
  await verify(scheduled, true);

  const bindingId = `binding-${randomUUID()}`;
  const approvalId = `approval-${randomUUID()}`;
  const boundary = new Date(Date.now() - 5000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const ready: Extract<ProductionVerificationOptions, { phase: "ready" }> = {
    ...common, phase: "ready",
    cronSecret: "disposable-production-cron-secret",
    expectedApprovalId: approvalId, approvalCreatedAfter: boundary,
    expectedShadowIdempotencyKey: "manual-shadow:production-proof-test",
    expectedShadowStartedAfter: boundary,
  };
  await createTargetBinding({ databaseUrl: common.databaseUrl, bindingId });
  await createTargetApproval({
    ...common, approvalId, bindingId, cronSecret: ready.cronSecret, approvalSecret: ready.approvalSecret,
  });
  await sql`
    INSERT INTO "krypto"."AgentRun" (
      id, "idempotencyKey", "triggerSource", "tradingMode", "outcome",
      "strategyVersion", "startedAt", "completedAt"
    ) VALUES (${randomUUID()}, ${ready.expectedShadowIdempotencyKey}, 'cron', 'SHADOW',
      'SHADOW', 'production-proof-test', ${new Date(boundary)}, ${new Date(boundary)})
  `;
  await verify(ready, true);
  await sql`
    INSERT INTO "krypto"."AgentJournal" (id, "entryText", "marketConditions", "createdAt")
    SELECT ${`zz-copied-${randomUUID()}`}, "entryText", "marketConditions", clock_timestamp()
    FROM "krypto"."AgentJournal" WHERE id = ${approvalId}
  `;
  await verify(ready, false);
  const copied = await runProductionVerification(ready);
  assert(copied.checks.some((check) => check.id === "approval-signature-valid" && check.status === "pass"));
  assert(copied.checks.some((check) => check.id === "exact-approval-id" && check.status === "block"));

  const tradeId = randomUUID();
  await sql`
    INSERT INTO "krypto"."TradeExecution" (
      id, direction, asset, "amountUSD", "amountAsset", "executionPrice", "agentReasoning", "agentRunId"
    ) VALUES (${tradeId}, 'BUY', 'ETH', 20, 0.01, 2000, 'Disposable proof fixture, not an executed order.', ${runId})
  `;
  await verify(scheduled, false);
  await sql`
    UPDATE "krypto"."AgentRun" SET outcome = 'EXECUTED' WHERE id = ${runId}
  `;
  await verify(scheduled, false);
  await sql`
    UPDATE "krypto"."AgentJournal" SET "tradeExecutionId" = ${tradeId} WHERE id = ${journalId}
  `;
  await sql`
    UPDATE "krypto"."AgentState"
    SET "currentPositionETHDecimal" = 0.01, "currentPositionUSDCDecimal" = 180
    WHERE id = 'singleton'
  `;
  await verify(scheduled, true);
  console.log("Native production verification passed: exact signed approval, copied-signature replay rejection, scheduled run/journal/fill correlation, open post-fill position, stop/lease/fence controls, and unchanged database snapshots.");
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.all([sql.end(), closeDatabase()]);
  });
