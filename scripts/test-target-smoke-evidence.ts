import assert from "node:assert/strict";

import postgres from "postgres";

import {
  createTargetApproval,
  createTargetBinding,
  inspectTargetAfter,
  inspectTargetBefore,
} from "@/deployment/target-smoke";

async function main(): Promise<void> {
  const databaseUrl = process.env.DIRECT_URL;
  if (!databaseUrl) throw new Error("DIRECT_URL is required");
  const sql = postgres(databaseUrl, {
    max: 1,
    prepare: false,
  });
  const startedAt = new Date();
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
    await createTargetApproval({
      databaseUrl,
      approvalId,
      bindingId,
      targetOrigin: "https://krypto.example.com",
      cronSecret: "test-cron-secret",
    });
    const [approval] = await sql<
      Array<{
        event: string | null;
        targetOrigin: string | null;
        cronSecretMd5: string | null;
      }>
    >`
      SELECT
        "marketConditions" ->> 'event' AS event,
        "marketConditions" ->> 'targetOrigin' AS "targetOrigin",
        "marketConditions" ->> 'cronSecretMd5' AS "cronSecretMd5"
      FROM "krypto"."AgentJournal"
      WHERE id = ${approvalId}
    `;
    assert.equal(approval?.event, "deployment-smoke-approved");
    assert.equal(approval?.targetOrigin, "https://krypto.example.com");
    assert.match(approval?.cronSecretMd5 ?? "", /^[a-f0-9]{32}$/);

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
    await sql`
      INSERT INTO "krypto"."AgentJournal" (
        id,
        "entryText",
        "marketConditions",
        "createdAt"
      ) VALUES (
        'target-smoke-evidence-delivery',
        'Target smoke delivery sent.',
        ${sql.json({
          event: "daily-summary-delivery",
          status: "sent",
        })},
        NOW()
      )
    `;

    const after = await inspectTargetAfter({
      databaseUrl,
      idempotencyKeys: keys,
      startedAt,
    });
    assert.equal(after.runCount, 2);
    assert.equal(after.disabledRunCount, 2);
    assert.equal(after.tradeCount, before.tradeCount);
    assert.equal(after.leaseReleased, true);
    assert.equal(after.deliveryStatus, "sent");
    console.log(
      "Target smoke evidence queries passed for database safety, disabled runs, unchanged trades, lease release, and email audit.",
    );
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
