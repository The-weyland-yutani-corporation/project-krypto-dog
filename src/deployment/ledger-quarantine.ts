import { randomUUID } from "node:crypto";
import postgres from "postgres";

import { canonicalSha256 } from "@/backtest/canonical";
import { classifyMigrationUrlSafety } from "./migration-url-safety";
import { runLedgerAttestation } from "./ledger-attestation";
import type { LedgerAttestationReport } from "@/trading/ledger-attestation";
import { DEFAULT_STRATEGY_CONFIG } from "@/trading/strategy-config";

export interface QuarantineLedgerAttestationOptions {
  migrationUrl: string;
  directUrl: string;
  runtimeUrl?: string;
  report: LedgerAttestationReport;
  expectedReleaseSha: string;
  expectedImageDigest: string;
  occurredAt: Date;
}

export interface QuarantineLedgerAttestationResult {
  incidentId: string;
  attestationChecksum: string;
  accountingStatus: "QUARANTINED";
  created: boolean;
}

function verifyFailedReport(report: LedgerAttestationReport): void {
  if (
    report.status !== "FAIL" ||
    !report.checks.some((check) => check.status === "fail")
  ) {
    throw new Error(
      "Protected quarantine requires a failed ledger attestation report",
    );
  }
  const { checksum, ...body } = report;
  if (checksum !== `sha256:${canonicalSha256(body)}`) {
    throw new Error("Ledger attestation report checksum is invalid");
  }
}

/**
 * Explicit protected consumer for a failed read-only attestation. This is the
 * only mutation in the attestation workflow and requires the reviewed
 * krypto_migrator -> krypto_schema_owner SET ROLE boundary.
 */
export async function quarantineFailedLedgerAttestation(
  options: QuarantineLedgerAttestationOptions,
): Promise<QuarantineLedgerAttestationResult> {
  verifyFailedReport(options.report);
  if (
    options.report.binding.releaseSha !== options.expectedReleaseSha ||
    options.report.binding.imageDigest !== options.expectedImageDigest ||
    options.report.binding.configVersion !==
      DEFAULT_STRATEGY_CONFIG.version ||
    options.report.binding.runtimeRole !== "krypto_runtime"
  ) {
    throw new Error(
      "Failed attestation report does not match the protected release, image, config, and runtime-role boundary",
    );
  }
  if (
    !(options.occurredAt instanceof Date) ||
    Number.isNaN(options.occurredAt.getTime())
  ) {
    throw new Error("Quarantine occurrence time is invalid");
  }
  const reportAsOf = new Date(options.report.binding.asOf);
  if (
    Number.isNaN(reportAsOf.getTime()) ||
    reportAsOf.toISOString() !== options.report.binding.asOf
  ) {
    throw new Error("Failed attestation report has an invalid as-of time");
  }
  const safety = classifyMigrationUrlSafety({
    migrationUrl: options.migrationUrl,
    directUrl: options.directUrl,
    runtimeUrl: options.runtimeUrl,
    expectedUsername: "krypto_migrator",
  });
  if (!safety.safe) {
    throw new Error(
      `MIGRATION_URL failed protected quarantine validation: ${safety.reasons.join(" ")}`,
    );
  }

  const sql = postgres(options.migrationUrl, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
  });
  const dedupKey = `ledger-attestation:${options.report.checksum.slice(7)}`;
  const generatedIncidentId = randomUUID();
  const generatedEventId = randomUUID();
  try {
    await sql`SET ROLE "krypto_schema_owner"`;
    const [existingContainment] = await sql<
      Array<{ incidentId: string; accountingStatus: string }>
    >`
      SELECT
        incident."incidentId",
        state."accountingStatus"::text AS "accountingStatus"
      FROM "krypto"."SafetyIncidentOutbox" incident
      CROSS JOIN "krypto"."AgentState" state
      WHERE incident."dedupKey" = ${dedupKey}
        AND incident."eventKind" = 'CREATED'
        AND state.id = 'singleton'
      LIMIT 1
    `;
    if (
      existingContainment &&
      existingContainment.accountingStatus === "QUARANTINED"
    ) {
      return {
        incidentId: existingContainment.incidentId,
        attestationChecksum: options.report.checksum,
        accountingStatus: "QUARANTINED",
        created: false,
      };
    }

    const liveReport = await runLedgerAttestation({
      databaseUrl: options.directUrl,
      releaseSha: options.report.binding.releaseSha,
      imageDigest: options.report.binding.imageDigest,
      configVersion: options.report.binding.configVersion,
      purpose: options.report.binding.purpose,
      asOf: reportAsOf,
      runtimeRole: options.report.binding.runtimeRole,
      maxTrades: options.report.bounds.maximumTrades,
    });
    verifyFailedReport(liveReport);
    if (liveReport.checksum !== options.report.checksum) {
      throw new Error(
        "Failed attestation report does not match a fresh read-only replay of the bound database",
      );
    }

    return await sql.begin(async (tx) => {
      const transaction = tx as unknown as postgres.Sql;
      await transaction`SET LOCAL statement_timeout = '10s'`;
      const [state] = await transaction<
        Array<{ accountingStatus: string }>
      >`
        UPDATE "krypto"."AgentState"
        SET
          "accountingStatus" = 'QUARANTINED',
          "accountingIssue" = CASE
            WHEN "accountingStatus" = 'QUARANTINED'
              THEN "accountingIssue"
            ELSE 'Deterministic immutable-ledger attestation failed; inspect the checksum-addressed safety incident.'
          END
        WHERE id = 'singleton'
        RETURNING "accountingStatus"::text AS "accountingStatus"
      `;
      if (state?.accountingStatus !== "QUARANTINED") {
        throw new Error("AgentState singleton could not be quarantined");
      }

      const inserted = await transaction<
        Array<{ incidentId: string }>
      >`
        INSERT INTO "krypto"."SafetyIncidentOutbox" (
          "eventId",
          "incidentId",
          "eventSequence",
          "eventKind",
          "incidentType",
          severity,
          status,
          "dedupKey",
          "requestId",
          "releaseId",
          "deploymentId",
          "redactedContext",
          "occurredAt",
          "ownerRole",
          "backupRole",
          runbook,
          evidence
        ) VALUES (
          ${generatedEventId},
          ${generatedIncidentId},
          1,
          'CREATED',
          'RECONCILIATION_QUARANTINE',
          'CRITICAL',
          'OPEN',
          ${dedupKey},
          ${`ledger-attestation-${options.report.checksum.slice(7, 27)}`},
          ${options.report.binding.releaseSha},
          ${options.report.binding.imageDigest},
          ${transaction.json({
            component: "ledger-attestation",
            operation: "protected-quarantine",
            failureCode: "immutable-ledger-attestation-failed",
            accountingStatus: "QUARANTINED",
            outcome: "blocked",
          })},
          ${options.occurredAt},
          'PRIMARY_ON_CALL',
          'SAFETY_APPROVER',
          'specs/incident-response.md#ledger-attestation-quarantine',
          ${transaction.json({
            artifactRef: `ledger-attestation:${options.report.checksum}`,
            verification: "checksum-verified-failed-attestation",
            containmentDecision: "quarantine-and-block-paper",
          })}
        )
        ON CONFLICT ("dedupKey") WHERE "eventKind" = 'CREATED'
        DO NOTHING
        RETURNING "incidentId"
      `;
      let incidentId = inserted[0]?.incidentId;
      if (!incidentId) {
        const [existing] = await transaction<Array<{ incidentId: string }>>`
          SELECT "incidentId"
          FROM "krypto"."SafetyIncidentOutbox"
          WHERE "dedupKey" = ${dedupKey}
            AND "eventKind" = 'CREATED'
          LIMIT 1
        `;
        incidentId = existing?.incidentId;
      }
      if (!incidentId) {
        throw new Error("Quarantine safety incident was not persisted");
      }
      return {
        incidentId,
        attestationChecksum: options.report.checksum,
        accountingStatus: "QUARANTINED" as const,
        created: inserted.length === 1,
      };
    });
  } finally {
    try {
      await sql`RESET ROLE`;
    } finally {
      await sql.end({ timeout: 5 });
    }
  }
}
