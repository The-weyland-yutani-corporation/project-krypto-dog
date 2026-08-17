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
    const releaseSha = "c0e4ed2724a9880d5a5dfcdf954490f2d86e8e2f";
    const imageDigest =
      "sha256:d32ebcff1be028d183b8ba7ce4e1506b0adf3a7a90b02d5c6a202fabceaf1e68";
    const approvedAt = new Date("2026-08-14T00:00:00.000Z");
    await createTargetApproval({
      databaseUrl,
      approvalId,
      bindingId,
      modeMismatchEvidenceId:
        "deployment-smoke-mode-mismatch-123e4567-e89b-42d3-a456-426614174002",
      cronEvidenceId:
        "deployment-smoke-cron-123e4567-e89b-42d3-a456-426614174003",
      adminEvidenceId:
        "deployment-smoke-admin-123e4567-e89b-42d3-a456-426614174004",
      targetOrigin: "https://krypto.example.com",
      cronSecret: "test-cron-secret",
      releaseSha,
      imageDigest,
      approvalSecret: TEST_APPROVAL_SECRET,
      approvedAt,
    });
    const [approval] = await sql<
      Array<{
        event: string | null;
        modeMismatchEvidenceId: string | null;
        cronEvidenceId: string | null;
        adminEvidenceId: string | null;
        targetOrigin: string | null;
        cronSecretBinding: string | null;
        releaseSha: string | null;
        imageDigest: string | null;
        rolloutMode: string | null;
        approvedAt: string | null;
        createdAt: string;
        approvalSignature: string | null;
      }>
    >`
      SELECT
        "marketConditions" ->> 'event' AS event,
        "marketConditions" ->> 'modeMismatchEvidenceId' AS "modeMismatchEvidenceId",
        "marketConditions" ->> 'cronEvidenceId' AS "cronEvidenceId",
        "marketConditions" ->> 'adminEvidenceId' AS "adminEvidenceId",
        "marketConditions" ->> 'targetOrigin' AS "targetOrigin",
        "marketConditions" ->> 'cronSecretBinding' AS "cronSecretBinding",
        "marketConditions" ->> 'releaseSha' AS "releaseSha",
        "marketConditions" ->> 'imageDigest' AS "imageDigest",
        "marketConditions" ->> 'rolloutMode' AS "rolloutMode",
        "marketConditions" ->> 'approvedAt' AS "approvedAt",
        "marketConditions" ->> 'approvalSignature' AS "approvalSignature",
        to_char(
          "createdAt",
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) AS "createdAt"
      FROM "krypto"."AgentJournal"
      WHERE id = ${approvalId}
    `;
    assert.equal(approval?.event, "deployment-smoke-approved");
    assert.equal(
      approval?.modeMismatchEvidenceId,
      "deployment-smoke-mode-mismatch-123e4567-e89b-42d3-a456-426614174002",
    );
    assert.equal(
      approval?.cronEvidenceId,
      "deployment-smoke-cron-123e4567-e89b-42d3-a456-426614174003",
    );
    assert.equal(
      approval?.adminEvidenceId,
      "deployment-smoke-admin-123e4567-e89b-42d3-a456-426614174004",
    );
    assert.equal(approval?.targetOrigin, "https://krypto.example.com");
    assert.equal(
      approval?.cronSecretBinding,
      cronSecretBinding("test-cron-secret", TEST_APPROVAL_SECRET),
    );
    assert.match(approval?.cronSecretBinding ?? "", /^[a-f0-9]{64}$/);
    assert.equal(approval?.releaseSha, releaseSha);
    assert.equal(approval?.imageDigest, imageDigest);
    assert.equal(approval?.rolloutMode, "disabled");
    assert.equal(approval?.approvedAt, approvedAt.toISOString());
    assert.equal(approval?.createdAt, approvedAt.toISOString());
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
