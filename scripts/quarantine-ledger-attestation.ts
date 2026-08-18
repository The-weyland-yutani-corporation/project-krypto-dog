import "dotenv/config";

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { quarantineFailedLedgerAttestation } from "@/deployment/ledger-quarantine";
import type { LedgerAttestationReport } from "@/trading/ledger-attestation";

async function main(): Promise<void> {
  const [flag, path, ...remaining] = process.argv.slice(2);
  if (flag !== "--report" || !path || remaining.length !== 0) {
    throw new Error(
      "Usage: quarantine-ledger-attestation --report <failed-report.json>",
    );
  }
  const migrationUrl = process.env.MIGRATION_URL;
  const directUrl = process.env.DIRECT_URL;
  const expectedReleaseSha = process.env.RELEASE_SHA;
  const expectedImageDigest = process.env.IMAGE_DIGEST;
  if (
    !migrationUrl ||
    !directUrl ||
    !expectedReleaseSha ||
    !expectedImageDigest
  ) {
    throw new Error(
      "MIGRATION_URL, DIRECT_URL, RELEASE_SHA, and IMAGE_DIGEST are required for protected quarantine",
    );
  }
  const report = JSON.parse(
    await readFile(resolve(path), "utf8"),
  ) as LedgerAttestationReport;
  const result = await quarantineFailedLedgerAttestation({
    migrationUrl,
    directUrl,
    runtimeUrl: process.env.DATABASE_URL,
    report,
    expectedReleaseSha,
    expectedImageDigest,
    occurredAt: new Date(),
  });
  process.stdout.write(
    `${JSON.stringify({
      accountingStatus: result.accountingStatus,
      attestationChecksum: result.attestationChecksum,
      incidentId: result.incidentId,
      created: result.created,
    })}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Protected ledger quarantine failed: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
