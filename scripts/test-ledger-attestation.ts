import assert from "node:assert/strict";
import postgres from "postgres";

import { runLedgerAttestation } from "../src/deployment/ledger-attestation";
import { quarantineFailedLedgerAttestation } from "../src/deployment/ledger-quarantine";
import { DEFAULT_STRATEGY_CONFIG } from "../src/trading/strategy-config";
import { canonicalSha256 } from "../src/backtest/canonical";

const RELEASE_SHA = "a".repeat(40);
const IMAGE_DIGEST = `sha256:${"b".repeat(64)}`;

async function main(): Promise<void> {
  const directUrl = process.env.DIRECT_URL;
  const migrationUrl = process.env.MIGRATION_URL;
  if (!directUrl || !migrationUrl) {
    throw new Error("DIRECT_URL and MIGRATION_URL are required");
  }
  const admin = postgres(directUrl, { max: 1, prepare: false });
  try {
    const snapshot = async () =>
      admin`
        SELECT jsonb_build_object(
          'state', (SELECT to_jsonb(state) FROM "krypto"."AgentState" state),
          'trades', (SELECT COALESCE(jsonb_agg(to_jsonb(trade) ORDER BY trade."createdAt", trade.id), '[]'::jsonb) FROM "krypto"."TradeExecution" trade),
          'runs', (SELECT COALESCE(jsonb_agg(to_jsonb(run) ORDER BY run."startedAt", run.id), '[]'::jsonb) FROM "krypto"."AgentRun" run),
          'journals', (SELECT COALESCE(jsonb_agg(to_jsonb(journal) ORDER BY journal."createdAt", journal.id), '[]'::jsonb) FROM "krypto"."AgentJournal" journal),
          'incidents', (SELECT COALESCE(jsonb_agg(to_jsonb(incident) ORDER BY incident."persistedAt", incident."eventId"), '[]'::jsonb) FROM "krypto"."SafetyIncidentOutbox" incident)
        ) AS snapshot
      `;
    const asOf = new Date();
    const before = await snapshot();
    const options = {
      databaseUrl: directUrl,
      releaseSha: RELEASE_SHA,
      imageDigest: IMAGE_DIGEST,
      configVersion: DEFAULT_STRATEGY_CONFIG.version,
      purpose: "target-smoke" as const,
      asOf,
    };
    const first = await runLedgerAttestation(options);
    const second = await runLedgerAttestation(options);
    assert.equal(first.status, "PASS");
    assert.deepEqual(second, first);
    assert.deepEqual(await snapshot(), before);

    await admin`SET ROLE "krypto_schema_owner"`;
    await admin`
      UPDATE "krypto"."AgentState"
      SET "portfolioValueUSDDecimal" = '199.00000000'
      WHERE id = 'singleton'
    `;
    await admin`RESET ROLE`;
    const failed = await runLedgerAttestation(options);
    assert.equal(failed.status, "FAIL");
    const [stillReadOnly] = await admin<
      Array<{ status: string; incidentCount: number }>
    >`
      SELECT
        state."accountingStatus"::text AS status,
        (SELECT count(*)::int FROM "krypto"."SafetyIncidentOutbox")
          AS "incidentCount"
      FROM "krypto"."AgentState" state
      WHERE state.id = 'singleton'
    `;
    assert.equal(stillReadOnly?.status, "RECONCILED");
    assert.equal(stillReadOnly?.incidentCount, 0);

    const forged = structuredClone(failed);
    forged.checks[0].code = "FORGED_FAILURE";
    const { checksum: _ignoredChecksum, ...forgedBody } = forged;
    void _ignoredChecksum;
    forged.checksum = `sha256:${canonicalSha256(forgedBody)}`;
    await assert.rejects(
      quarantineFailedLedgerAttestation({
        migrationUrl,
        directUrl,
        report: forged,
        expectedReleaseSha: RELEASE_SHA,
        expectedImageDigest: IMAGE_DIGEST,
        occurredAt: asOf,
      }),
      /does not match a fresh read-only replay/,
    );

    const quarantined = await quarantineFailedLedgerAttestation({
      migrationUrl,
      directUrl,
      report: failed,
      expectedReleaseSha: RELEASE_SHA,
      expectedImageDigest: IMAGE_DIGEST,
      occurredAt: asOf,
    });
    assert.equal(quarantined.accountingStatus, "QUARANTINED");
    assert.equal(quarantined.created, true);
    const repeated = await quarantineFailedLedgerAttestation({
      migrationUrl,
      directUrl,
      report: failed,
      expectedReleaseSha: RELEASE_SHA,
      expectedImageDigest: IMAGE_DIGEST,
      occurredAt: asOf,
    });
    assert.equal(repeated.incidentId, quarantined.incidentId);
    assert.equal(repeated.created, false);
    const [contained] = await admin<
      Array<{ status: string; incidentCount: number }>
    >`
      SELECT
        state."accountingStatus"::text AS status,
        (SELECT count(*)::int
           FROM "krypto"."SafetyIncidentOutbox"
          WHERE "dedupKey" = ${`ledger-attestation:${failed.checksum.slice(7)}`})
          AS "incidentCount"
      FROM "krypto"."AgentState" state
      WHERE state.id = 'singleton'
    `;
    assert.equal(contained?.status, "QUARANTINED");
    assert.equal(contained?.incidentCount, 1);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
