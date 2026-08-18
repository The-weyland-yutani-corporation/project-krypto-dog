import "dotenv/config";

import { mkdir, open, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { runLedgerAttestation } from "@/deployment/ledger-attestation";
import type { LedgerAttestationPurpose } from "@/trading/ledger-attestation";
import { DEFAULT_STRATEGY_CONFIG } from "@/trading/strategy-config";

function argument(
  name: string,
  argv: string[],
  required = true,
): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) {
    if (required) throw new Error(`${name} is required`);
    return undefined;
  }
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const purpose = argument("--purpose", argv) as LedgerAttestationPurpose;
  if (!["preflight", "target-smoke", "pre-paper"].includes(purpose)) {
    throw new Error("--purpose must be preflight, target-smoke, or pre-paper");
  }
  const releaseSha = argument("--release-sha", argv, false) ??
    process.env.RELEASE_SHA;
  const imageDigest = argument("--image-digest", argv, false) ??
    process.env.IMAGE_DIGEST;
  const out = argument("--out", argv, false);
  const allowed = new Set([
    "--purpose",
    "--release-sha",
    "--image-digest",
    "--out",
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    if (!allowed.has(argv[index]) || argv[index + 1] === undefined) {
      throw new Error(`Unknown or incomplete argument: ${argv[index]}`);
    }
  }
  if (!releaseSha || !imageDigest) {
    throw new Error("RELEASE_SHA and IMAGE_DIGEST are required");
  }
  const databaseUrl = process.env.DIRECT_URL;
  if (!databaseUrl) {
    throw new Error("DIRECT_URL is required for read-only ledger attestation");
  }

  const report = await runLedgerAttestation({
    databaseUrl,
    releaseSha,
    imageDigest,
    configVersion: DEFAULT_STRATEGY_CONFIG.version,
    purpose,
    asOf: new Date(),
  });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (out) {
    const path = resolve(out);
    await mkdir(dirname(path), { recursive: true });
    const handle = await open(path, "wx");
    await handle.close();
    try {
      await writeFile(path, json, "utf8");
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    }
  }
  process.stdout.write(json);
  if (report.status !== "PASS") process.exitCode = 2;
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Ledger attestation failed: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
