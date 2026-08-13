import "dotenv/config";

import { mkdir, open, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { runTargetSmoke } from "@/deployment/target-smoke";

type Arguments = {
  baseUrl: string;
  confirmHost: string;
  releaseSha: string;
  imageDigest: string;
  out?: string;
};

function parseArguments(argv: string[]): Arguments {
  let baseUrl: string | undefined;
  let confirmHost: string | undefined;
  let releaseSha: string | undefined;
  let imageDigest: string | undefined;
  let out: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (
      [
        "--base-url",
        "--confirm-host",
        "--release-sha",
        "--image-digest",
        "--out",
      ].includes(argument) &&
      (!value || value.startsWith("--"))
    ) {
      throw new Error(`${argument} requires a value.`);
    }
    if (argument === "--base-url") {
      baseUrl = value;
      index += 1;
    } else if (argument === "--confirm-host") {
      confirmHost = value;
      index += 1;
    } else if (argument === "--release-sha") {
      releaseSha = value;
      index += 1;
    } else if (argument === "--image-digest") {
      imageDigest = value;
      index += 1;
    } else if (argument === "--out") {
      out = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!baseUrl || !confirmHost) {
    throw new Error(
      "--base-url <url> and --confirm-host <hostname> are required.",
    );
  }
  releaseSha = releaseSha ?? process.env.RELEASE_SHA;
  imageDigest = imageDigest ?? process.env.IMAGE_DIGEST;
  if (!releaseSha || !imageDigest) {
    throw new Error(
      "--release-sha (or RELEASE_SHA) and --image-digest (or IMAGE_DIGEST) are required.",
    );
  }
  return { baseUrl, confirmHost, releaseSha, imageDigest, out };
}

async function main(): Promise<void> {
  const arguments_ = parseArguments(process.argv.slice(2));
  const databaseUrl = process.env.DIRECT_URL;
  const cronSecret = process.env.CRON_SECRET;
  const adminPassword = process.env.ADMIN_PASSWORD;
  const approvalSecret = process.env.DEPLOYMENT_APPROVAL_SECRET;
  if (!databaseUrl || !cronSecret || !adminPassword || !approvalSecret) {
    throw new Error(
      "DIRECT_URL, CRON_SECRET, ADMIN_PASSWORD, and DEPLOYMENT_APPROVAL_SECRET are required.",
    );
  }
  const outputPath = arguments_.out
    ? resolve(arguments_.out)
    : undefined;
  let outputReserved = false;
  if (outputPath) {
    await mkdir(dirname(outputPath), { recursive: true });
    const handle = await open(outputPath, "wx");
    await handle.close();
    outputReserved = true;
  }
  let report: Awaited<ReturnType<typeof runTargetSmoke>>;
  try {
    report = await runTargetSmoke({
      baseUrl: arguments_.baseUrl,
      expectedHost: arguments_.confirmHost,
      databaseUrl,
      cronSecret,
      adminPassword,
      releaseSha: arguments_.releaseSha,
      imageDigest: arguments_.imageDigest,
      approvalSecret,
    });
  } catch (error) {
    if (outputPath && outputReserved) {
      await rm(outputPath, { force: true });
    }
    throw error;
  }
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) {
    try {
      await writeFile(outputPath, json, "utf8");
    } catch (error) {
      await rm(outputPath, { force: true });
      throw error;
    }
  }
  process.stdout.write(json);
  if (!report.passed) {
    process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Target smoke failed: ${message}\n`);
  process.exitCode = 1;
});
