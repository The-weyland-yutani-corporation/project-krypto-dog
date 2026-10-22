import assert from "node:assert/strict";

import postgres from "postgres";

import {
  cronSecretBinding,
  createTargetApproval,
  createTargetBinding,
  inspectTargetAfter,
  inspectTargetBefore,
} from "@/deployment/target-smoke";

const TEST_APPROVAL_SECRET = "test-approval-secret-".padEnd(40, "x");

async function main(): Promise<void> {
  const databaseUrl = process.env.DIRECT_URL;
  if (!databaseUrl) throw new Error("DIRECT_URL is required");
  const target = new URL(databaseUrl);
  assert(["postgres:", "postgresql:"].includes(target.protocol) && !target.search && !target.hash,
    "Target-smoke fixtures require a plain PostgreSQL URL without query overrides.");
  assert(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname),
    "Target-smoke fixtures require a loopback database.");
  assert.equal(target.pathname, "/operations", "Use the suite's disposable operations database only.");
  const sql = postgres(databaseUrl, {
    max: 1,
    prepare: false,
  });
  const startedAt = new Date();
  const providerMessageId = "target-smoke-provider-message";
  const keys = [
    "target-smoke-evidence-cron",
    "target-smoke-evidence-admin",
  ];
  try {
    const before = await inspectTargetBefore(databaseUrl);
    assert.equal(before.activeKryptoCronJobs, 0);
    assert.equal(before.pendingKryptoHttpRequests, 0);
    assert.equal(before.state.present, true);
    assert.equal(before.state.accountingStatus, "RECONCILED");
    assert.equal(before.state.openPosition, false);
    assert.equal(before.state.activeLease, false);

    const bindingId =
      "deployment-smoke-binding-123e4567-e89b-42d3-a456-426614174000";
    await createTargetBinding({ databaseUrl, bindingId });
    const [binding] = await sql<
      Array<{ event: string | null }>
    >`
      SELECT "marketConditions" ->> 'event' AS event
      FROM "krypto"."AgentJournal"
      WHERE id = ${bindingId}
    `;
    assert.equal(binding?.event, "deployment-smoke-binding");
    const approvalId =
      "deployment-smoke-approved-123e4567-e89b-42d3-a456-426614174001";
    const releaseSha = "c0e4ed2724a9880d5a5dfcdf954490f2d86e8e2f";
    const imageDigest =
      "sha256:d32ebcff1be028d183b8ba7ce4e1506b0adf3a7a90b02d5c6a202fabceaf1e68";
    await createTargetApproval({
      databaseUrl,
      approvalId,
      bindingId,
      targetOrigin: "https://krypto.example.com",
      cronSecret: "test-cron-secret",
      releaseSha,
      imageDigest,
      approvalSecret: TEST_APPROVAL_SECRET,
    });
    const [approval] = await sql<
      Array<{
        event: string | null;
        targetOrigin: string | null;
        cronSecretBinding: string | null;
        releaseSha: string | null;
        imageDigest: string | null;
        rolloutMode: string | null;
        approvalSignature: string | null;
      }>
    >`
      SELECT
        "marketConditions" ->> 'event' AS event,
        "marketConditions" ->> 'targetOrigin' AS "targetOrigin",
        "marketConditions" ->> 'cronSecretBinding' AS "cronSecretBinding",
        "marketConditions" ->> 'releaseSha' AS "releaseSha",
        "marketConditions" ->> 'imageDigest' AS "imageDigest",
        "marketConditions" ->> 'rolloutMode' AS "rolloutMode",
        "marketConditions" ->> 'approvalSignature' AS "approvalSignature"
      FROM "krypto"."AgentJournal"
      WHERE id = ${approvalId}
    `;
    assert.equal(approval?.event, "deployment-smoke-approved");
    assert.equal(approval?.targetOrigin, "https://krypto.example.com");
    assert.equal(
      approval?.cronSecretBinding,
      cronSecretBinding("test-cron-secret", TEST_APPROVAL_SECRET),
    );
    assert.match(approval?.cronSecretBinding ?? "", /^[a-f0-9]{64}$/);
    assert.equal(approval?.releaseSha, releaseSha);
    assert.equal(approval?.imageDigest, imageDigest);
    assert.equal(approval?.rolloutMode, "disabled");
    assert.match(approval?.approvalSignature ?? "", /^[a-f0-9]{64}$/);

    await sql`
      INSERT INTO "krypto"."AgentRun" (
        id,
        "idempotencyKey",
        "triggerSource",
        "tradingMode",
        outcome,
        "strategyVersion",
        "startedAt",
        "completedAt"
      ) VALUES
        (
          'target-smoke-evidence-cron',
          ${keys[0]},
          'cron',
          'DISABLED',
          'DISABLED',
          'target-smoke-evidence',
          NOW(),
          NOW()
        ),
        (
          'target-smoke-evidence-admin',
          ${keys[1]},
          'admin',
          'DISABLED',
          'DISABLED',
          'target-smoke-evidence',
          NOW(),
          NOW()
        )
    `;
    async function insertDeliveryAudit(
      id: string,
      detail: string | number,
      status = "sent",
      createdAt = new Date(),
    ): Promise<void> {
      await sql`
        INSERT INTO "krypto"."AgentJournal" (
          id, "entryText", "marketConditions", "createdAt"
        ) VALUES (
          ${id}, 'Disposable provider-acceptance audit.',
          ${sql.json({ event: "daily-summary-delivery", status, detail })},
          ${createdAt}
        )
      `;
    }

    await insertDeliveryAudit("unrelated-message", "another-provider-message");
    await insertDeliveryAudit("stale-message", providerMessageId, "sent",
      new Date(startedAt.getTime() - 1000));
    await insertDeliveryAudit("future-message", providerMessageId, "sent",
      new Date(Date.now() + 3_600_000));
    await insertDeliveryAudit("non-string-message", 123);
    for (const selectedId of [providerMessageId, "123"]) {
      const missing = await inspectTargetAfter({
        databaseUrl, idempotencyKeys: keys, startedAt, providerMessageId: selectedId,
      });
      assert.equal(missing.deliveryAuditCount, 0);
      assert.equal(missing.deliveryStatus, null);
      assert.equal(missing.providerMessageId, null);
    }
    await insertDeliveryAudit("target-smoke-evidence-delivery", providerMessageId);
    await insertDeliveryAudit("later-unrelated-failure", "another-provider-message", "failed");

    const after = await inspectTargetAfter({
      databaseUrl,
      idempotencyKeys: keys,
      startedAt,
      providerMessageId,
    });
    assert.equal(after.runCount, 2);
    assert.equal(after.disabledRunCount, 2);
    assert.equal(after.tradeCount, before.tradeCount);
    assert.equal(after.leaseReleased, true);
    assert.equal(after.deliveryStatus, "sent");
    assert.equal(after.providerMessageId, providerMessageId);
    assert.equal(after.deliveryAuditCount, 1);
    await insertDeliveryAudit("duplicate-message", providerMessageId);
    const duplicate = await inspectTargetAfter({
      databaseUrl, idempotencyKeys: keys, startedAt, providerMessageId,
    });
    assert.equal(duplicate.deliveryAuditCount, 2);
    console.log(
      "Target smoke evidence queries passed for database safety, disabled runs, unchanged trades, lease release, and exact email message-ID correlation rejecting unrelated, stale, future, non-string and duplicate audits. Provider acceptance is not recipient delivery.",
    );
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
