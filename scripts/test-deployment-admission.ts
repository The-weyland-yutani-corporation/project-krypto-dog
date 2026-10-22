import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import postgres from "postgres";

import { executeAgentRun } from "@/agent/run-flow";
import { closeDatabase } from "@/db";
import {
  runDeploymentAdmission,
  type DeploymentAdmissionOptions,
} from "@/deployment/deployment-admission";
import {
  createTargetApproval,
  createTargetBinding,
} from "@/deployment/target-smoke";
import { executePaperTrade } from "@/trading/paper-executor";
import { DEFAULT_STRATEGY_CONFIG } from "@/trading/strategy-config";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
const sql = postgres(databaseUrl, { max: 2, prepare: false });
const base: DeploymentAdmissionOptions & { action: "acquire" } = {
  action: "acquire",
  databaseUrl,
  owner: "34aa399d-f243-5b32-832f-e399e1f22b74",
  sourceReleaseSha: "a".repeat(40),
  candidateReleaseSha: "b".repeat(40),
  imageDigest: `sha256:${"c".repeat(64)}`,
  targetOrigin: "https://deployment-admission.example.com",
  cronSecret: "disposable-admission-cron-secret",
  approvalSecret: "disposable-admission-approval-secret-at-least-32",
};

async function stateSnapshot(): Promise<string> {
  const [row] = await sql<Array<{ state: string }>>`
    SELECT row_to_json(state)::text AS state
    FROM "krypto"."AgentState" state WHERE id = 'singleton'
  `;
  assert(row);
  return row.state;
}

async function fenceSnapshot(): Promise<string> {
  const [row] = await sql<Array<{ fence: string }>>`
    SELECT COALESCE(json_agg(fence ORDER BY owner), '[]'::json)::text AS fence
    FROM "krypto"."DeploymentFence" fence WHERE id = 'singleton'
  `;
  assert(row);
  return row.fence;
}

function runMaintenanceScript(script: string): void {
  execFileSync(process.execPath, ["--import", "tsx", script], {
    env: { ...process.env, DATABASE_URL: databaseUrl, DIRECT_URL: databaseUrl },
    stdio: "pipe",
  });
}

async function waitForAccountLock(count: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const [row] = await sql<Array<{ waiting: number }>>`
      SELECT COUNT(*)::int AS waiting
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND query ILIKE '%"AgentState"%'
        AND query ILIKE '%FOR UPDATE%'
    `;
    if (row.waiting >= count) return;
    await delay(20);
  }
  throw new Error(`Expected ${count} account-row lock waiters.`);
}

async function main(): Promise<void> {
  const [target] = await sql<Array<{ database: string }>>`
    SELECT current_database() AS database
  `;
  assert.equal(target.database, "deployment_admission", "Use the suite's disposable database only.");
  process.env.ROLLOUT_MODE = "disabled";
  delete process.env.POSTHOG_API_KEY;

  const bindingId = `admission-test-binding-${randomUUID()}`;
  await createTargetBinding({ databaseUrl: base.databaseUrl, bindingId });
  await createTargetApproval({
    databaseUrl: base.databaseUrl,
    approvalId: `admission-test-approval-${randomUUID()}`,
    bindingId,
    targetOrigin: base.targetOrigin,
    cronSecret: base.cronSecret,
    approvalSecret: base.approvalSecret,
    releaseSha: base.sourceReleaseSha,
    imageDigest: base.imageDigest,
  });

  await sql`
    UPDATE "krypto"."AgentState"
    SET "currentPositionETHDecimal" = 0.000000000000000001
    WHERE id = 'singleton'
  `;
  let before = await stateSnapshot();
  assert.equal((await runDeploymentAdmission(base)).status, "deferred");
  assert.equal(await stateSnapshot(), before);

  await sql`
    UPDATE "krypto"."AgentState"
    SET "currentPositionETHDecimal" = 0,
        "leaseOwner" = 'existing-run',
        "leaseExpiresAt" = clock_timestamp() + INTERVAL '1 minute',
        "isRunning" = true
    WHERE id = 'singleton'
  `;
  before = await stateSnapshot();
  assert.equal((await runDeploymentAdmission(base)).reason, "run-lease");
  assert.equal(await stateSnapshot(), before);
  await sql`
    UPDATE "krypto"."AgentState"
    SET "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "isRunning" = false
    WHERE id = 'singleton' AND "leaseOwner" = 'existing-run'
  `;

  // Queue admission first and runtime acquisition second behind the same lock.
  // Admission does not update AgentState, so a pre-lock fence snapshot is stale.
  const blocker = await sql.reserve();
  let committed = false;
  try {
    await blocker`BEGIN`;
    await blocker`
      SELECT id FROM "krypto"."AgentState" WHERE id = 'singleton' FOR UPDATE
    `;
    const admission = runDeploymentAdmission(base);
    await waitForAccountLock(1);
    const invocation = executeAgentRun({
      triggerSource: "admin",
      idempotencyKey: "admission-row-lock-race",
    });
    await waitForAccountLock(2);
    await blocker`COMMIT`;
    committed = true;

    const [admissionResult, invocationResult] = await Promise.all([admission, invocation]);
    assert.equal(admissionResult.status, "admitted");
    assert.equal(invocationResult.kind, "mutex");
    const [conflict] = await sql<Array<{ outcome: string; errorType: string }>>`
      SELECT outcome::text, "errorType" FROM "krypto"."AgentRun"
      WHERE "idempotencyKey" = 'admission-row-lock-race'
    `;
    assert.deepEqual(conflict, { outcome: "CONFLICT", errorType: "deployment-fence" });
  } finally {
    if (!committed) await blocker`ROLLBACK`;
    blocker.release();
  }

  const competing = await runDeploymentAdmission({ ...base, owner: randomUUID() });
  assert.equal(competing.status, "blocked");
  assert.equal(competing.reason, "ownership-mismatch");

  await assert.rejects(
    sql`
      INSERT INTO "krypto"."DeploymentFence" (
        owner, "sourceReleaseSha", "candidateReleaseSha", "imageDigest",
        "targetOrigin", "expiresAt"
      )
      SELECT ${randomUUID()}, "sourceReleaseSha", "candidateReleaseSha", "imageDigest",
        "targetOrigin", "expiresAt"
      FROM "krypto"."DeploymentFence" WHERE owner = ${base.owner}
    `,
    (error: unknown) => error instanceof postgres.PostgresError && error.code === "23505",
    "The database must reject a second active owner independently of application admission.",
  );

  const seededFence = await fenceSnapshot();
  before = await stateSnapshot();
  runMaintenanceScript("scripts/seed.ts");
  assert.equal(await fenceSnapshot(), seededFence, "Idempotent seed must preserve the active fence.");
  assert.equal(await stateSnapshot(), before, "Idempotent seed must preserve the account.");

  const runtime = await sql.reserve();
  try {
    await runtime`BEGIN`;
    await runtime`SET LOCAL ROLE krypto_runtime`;
    const [readable] = await runtime<Array<{ owner: string }>>`
      SELECT owner FROM "krypto"."DeploymentFence" WHERE id = 'singleton'
    `;
    assert.equal(readable.owner, base.owner);
    await assert.rejects(
      runtime`UPDATE "krypto"."DeploymentFence" SET "releasedAt" = clock_timestamp()`,
      (error: unknown) => error instanceof postgres.PostgresError && error.code === "42501",
    );
  } finally {
    await runtime`ROLLBACK`;
    runtime.release();
  }

  const runId = randomUUID();
  await sql`
    INSERT INTO "krypto"."AgentRun" (
      id, "idempotencyKey", "triggerSource", "tradingMode", "strategyVersion"
    ) VALUES (${runId}, ${`fenced-executor-${runId}`}, 'database-test', 'PAPER', ${DEFAULT_STRATEGY_CONFIG.version})
  `;
  await sql`
    UPDATE "krypto"."AgentState"
    SET "referencePriceUSD" = 2000, "leaseOwner" = 'executor-fixture-owner',
        "leaseExpiresAt" = clock_timestamp() + INTERVAL '1 minute',
        "isRunning" = true
    WHERE id = 'singleton'
  `;
  const now = new Date();
  before = await stateSnapshot();
  await assert.rejects(
    executePaperTrade({
      agentRunId: runId,
      leaseOwner: "executor-fixture-owner",
      decision: { action: "BUY", notionalUSD: 25, reasoning: "must be fenced" },
      market: {
        spotPriceUSD: 1900,
        observedAt: now,
        rsi: 30,
        emaShort: 1950,
        emaLong: 2000,
      },
      strategy: DEFAULT_STRATEGY_CONFIG,
      now,
    }),
    /Paper execution is fenced for deployment/,
  );
  assert.equal(await stateSnapshot(), before);
  const [fills] = await sql<Array<{ count: number }>>`
    SELECT COUNT(*)::int AS count FROM "krypto"."TradeExecution"
  `;
  assert.equal(fills.count, 0);
  await sql`
    UPDATE "krypto"."AgentState"
    SET "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "isRunning" = false
    WHERE id = 'singleton' AND "leaseOwner" = 'executor-fixture-owner'
  `;
  await sql`
    UPDATE "krypto"."DeploymentFence"
    SET "expiresAt" = clock_timestamp() - INTERVAL '1 second'
    WHERE id = 'singleton' AND owner = ${base.owner}
  `;
  assert.equal((await runDeploymentAdmission(base)).reason, "expired-fence");
  assert.equal((await executeAgentRun({
    triggerSource: "admin",
    idempotencyKey: "expired-fence-still-blocks",
  })).kind, "mutex");
  assert.equal((await runDeploymentAdmission({
    ...base,
    action: "release",
    owner: randomUUID(),
  })).status, "blocked");

  await sql`
    UPDATE "krypto"."AgentState"
    SET "isOperatorPaused" = true, "isLocked" = true WHERE id = 'singleton'
  `;
  before = await stateSnapshot();
  assert.equal((await runDeploymentAdmission({ ...base, action: "release" })).status, "released");
  assert.equal(await stateSnapshot(), before, "Releasing a deployment fence must not clear either stop.");
  const [tombstone] = await sql<Array<{ owner: string; releasedAt: Date | null }>>`
    SELECT owner, "releasedAt" FROM "krypto"."DeploymentFence" WHERE id = 'singleton'
  `;
  assert.equal(tombstone.owner, base.owner);
  assert(tombstone.releasedAt);
  assert.equal((await runDeploymentAdmission({ ...base, action: "release" })).reason, "already-released");

  await sql`
    UPDATE "krypto"."AgentState"
    SET "isOperatorPaused" = false, "isLocked" = false WHERE id = 'singleton'
  `;
  const owners = [randomUUID(), randomUUID()];
  const results = await Promise.all(owners.map((owner) => runDeploymentAdmission({ ...base, owner })));
  assert.deepEqual(results.map((result) => result.status).sort(), ["admitted", "blocked"]);
  assert.equal((await runDeploymentAdmission({ ...base, action: "release" })).status, "blocked",
    "An old owner must never release a newer cutover.");
  const winner = results.find((result) => result.status === "admitted");
  assert(winner);
  assert.equal((await runDeploymentAdmission({ ...base, owner: winner.owner, action: "release" })).status, "released");
  const completedFences = await fenceSnapshot();
  assert.equal((await runDeploymentAdmission(base)).reason, "released-owner",
    "Owner A must remain consumed after owner B completes a later cutover.");
  assert.equal(await fenceSnapshot(), completedFences, "A completed-owner replay must not mutate history.");
  const [history] = await sql<Array<{ count: number }>>`
    SELECT COUNT(*)::int AS count FROM "krypto"."DeploymentFence"
    WHERE "releasedAt" IS NOT NULL
  `;
  assert.equal(history.count, 2, "Both completed owners must remain recorded.");
  await assert.rejects(
    sql`
      INSERT INTO "krypto"."DeploymentFence" (
        owner, "sourceReleaseSha", "candidateReleaseSha", "imageDigest",
        "targetOrigin", "expiresAt"
      )
      SELECT owner, "sourceReleaseSha", "candidateReleaseSha", "imageDigest",
        "targetOrigin", clock_timestamp() + INTERVAL '1 hour'
      FROM "krypto"."DeploymentFence" WHERE owner = ${base.owner}
    `,
    (error: unknown) => error instanceof postgres.PostgresError && error.code === "23505",
    "Completed owners cannot be inserted again even when no fence is active.",
  );
  const resumed = await executeAgentRun({
    triggerSource: "admin",
    idempotencyKey: "released-fence-disabled-run",
    requiredMode: "disabled",
  });
  assert.equal(resumed.kind, "ok");
  if (resumed.kind === "ok") assert.equal(resumed.result.action, "disabled");

  const resetOwner = randomUUID();
  assert.equal((await runDeploymentAdmission({ ...base, owner: resetOwner })).status, "admitted");
  const resetFence = await fenceSnapshot();
  runMaintenanceScript("scripts/seed.ts");
  assert.equal(await fenceSnapshot(), resetFence, "Seed must preserve the active owner and all completed owners.");
  runMaintenanceScript("scripts/reset-state.ts");
  assert.equal(await fenceSnapshot(), resetFence, "Local account reset must preserve the active fence and completed-owner history.");
  assert.equal((await executeAgentRun({
    triggerSource: "admin",
    idempotencyKey: "account-reset-still-fenced",
  })).kind, "mutex");
  assert.equal((await runDeploymentAdmission({ ...base, owner: resetOwner, action: "release" })).status, "released");

  console.log("Deployment admission passed: exact source binding, mutation-free deferral, native row-lock race, runtime read-only fence, executor refusal, expiry, durable owner replay protection, single-active uniqueness, stop preservation, and seed/reset history preservation.");
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.all([sql.end(), closeDatabase()]);
  });
