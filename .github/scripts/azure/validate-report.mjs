#!/usr/bin/env node
// Strict, fail-closed validator for a downloaded Azure ops-job evidence
// report.json. Validates JSON parses, the operation-specific pass/approval
// field is exactly `true`, and -- for the two operations that bind a
// release/image ("target-smoke" and "activation-check") -- that the
// report's own releaseSha/imageDigest match what the caller expected,
// so a stale or mismatched evidence artifact can never be waved through
// as if it were current.
//
// Never uses eval or dynamic `import()` of operator-controlled paths; the
// report path is a literal CLI argument read with `fs.readFileSync` only.
//
// Usage:
//   node validate-report.mjs \
//     --report <path-to-report.json> \
//     --operation <migrate-init|preflight|verified-backup|target-smoke|activation-check> \
//     --release-sha <40-hex> \
//     [--image-digest <sha256:64-hex>]
//
// Exits 0 only if every required field is present and passing. Exits 1
// with a specific stderr message identifying exactly which field was
// missing, malformed, or mismatched otherwise -- never a generic failure.

import { readFileSync } from "node:fs";

const RELEASE_SHA_PATTERN = /^[0-9a-f]{40}$/;
const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const OPERATIONS = new Set([
  "migrate-init",
  "preflight",
  "verified-backup",
  "target-smoke",
  "activation-check",
  "deployment-admission",
]);

function fail(message) {
  process.stderr.write(`validate-report: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) fail(`Unexpected argument: ${key}`);
    const name = key.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      fail(`${key} requires a value`);
    }
    args[name] = value;
    i += 1;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

const reportPath = args["report"];
const operation = args["operation"];
const expectedReleaseSha = args["release-sha"];
const expectedImageDigest = args["image-digest"];

if (!reportPath) fail("--report is required.");
if (!operation || !OPERATIONS.has(operation)) {
  fail(`--operation must be one of: ${[...OPERATIONS].join(", ")}.`);
}
if (!expectedReleaseSha || !RELEASE_SHA_PATTERN.test(expectedReleaseSha)) {
  fail("--release-sha must be an exact 40-hex commit SHA.");
}
if (expectedImageDigest && !IMAGE_DIGEST_PATTERN.test(expectedImageDigest)) {
  fail("--image-digest must be an exact sha256:<64-hex> digest.");
}

let raw;
try {
  raw = readFileSync(reportPath, "utf8");
} catch (error) {
  fail(`Unable to read report file '${reportPath}': ${error.message}`);
}

let report;
try {
  report = JSON.parse(raw);
} catch (error) {
  fail(`Report file '${reportPath}' is not valid JSON: ${error.message}`);
}

if (report === null || typeof report !== "object") {
  fail("Report must be a JSON object.");
}

function requireField(object, field, expectedType) {
  if (!(field in object)) {
    fail(`Report is missing required field '${field}'.`);
  }
  const value = object[field];
  if (expectedType === "boolean" && typeof value !== "boolean") {
    fail(`Report field '${field}' must be a boolean.`);
  }
  if (expectedType === "string" && typeof value !== "string") {
    fail(`Report field '${field}' must be a string.`);
  }
  if (expectedType === "object" && (value === null || typeof value !== "object")) {
    fail(`Report field '${field}' must be an object.`);
  }
  return value;
}

function requireTrue(object, field, context) {
  const value = requireField(object, field, "boolean");
  if (value !== true) {
    fail(`${context}: field '${field}' must be true (got ${JSON.stringify(value)}).`);
  }
}

function requireMatch(object, field, expected, context) {
  const value = requireField(object, field, "string");
  if (value !== expected) {
    fail(
      `${context}: field '${field}' was '${value}', expected '${expected}' -- refusing to treat this evidence as current.`,
    );
  }
}

switch (operation) {
  case "deployment-admission": {
    const action = args["admission-action"];
    const owner = args["fence-owner"];
    const sourceSha = args["source-release-sha"];
    const candidateSha = args["candidate-release-sha"];
    const targetOrigin = args["target-origin"];
    const executionId = args["job-execution-id"];
    const azureExecutionName = args["azure-execution-name"];
    if (!["acquire", "verify", "release"].includes(action)) fail("--admission-action must be acquire, verify, or release.");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(owner ?? "")) {
      fail("--fence-owner must be a lowercase random UUID.");
    }
    if (!RELEASE_SHA_PATTERN.test(sourceSha ?? "") || !RELEASE_SHA_PATTERN.test(candidateSha ?? "")) {
      fail("Both source and candidate release SHAs are required.");
    }
    if (!expectedImageDigest) fail("--image-digest is required for admission.");
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(executionId ?? "")) {
      fail("--job-execution-id is required for admission.");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(azureExecutionName ?? "")) {
      fail("--azure-execution-name is required for admission.");
    }
    let origin;
    try {
      origin = new URL(targetOrigin);
    } catch {
      fail("--target-origin must be a bare HTTPS origin.");
    }
    if (origin.protocol !== "https:" || origin.origin !== targetOrigin) {
      fail("--target-origin must be a bare HTTPS origin.");
    }
    for (const [field, expected] of Object.entries({
      schemaVersion: "1.0.0",
      operation,
      action,
      owner,
      sourceReleaseSha: sourceSha,
      candidateReleaseSha: candidateSha,
      releaseSha: expectedReleaseSha,
      imageDigest: expectedImageDigest,
      targetOrigin,
      environmentName: "prod",
      jobExecutionId: executionId,
      azureExecutionName,
    })) {
      requireMatch(report, field, expected, "deployment-admission report");
    }
    const now = Date.now();
    const generatedAt = Date.parse(requireField(report, "generatedAt", "string"));
    if (!Number.isFinite(generatedAt) || generatedAt > now + 120_000 || now - generatedAt > 30 * 60_000) {
      fail("Admission evidence is invalid, future-dated, or older than 30 minutes.");
    }
    if (report.status === "deferred" && args["allow-deferred"] === "true" && action === "acquire") {
      if (
        !["open-position", "run-lease", "database-busy"].includes(report.reason) ||
        report.expiresAt !== null
      ) {
        fail("Deferred admission has an invalid reason or claims an acquired fence.");
      }
      process.stdout.write("validate-report: deployment DEFERRED; the source release was not changed.\n");
      process.exit(75);
    }
    requireMatch(report, "status", { acquire: "admitted", verify: "held", release: "released" }[action], "deployment-admission report");
    const expiresAt = Date.parse(requireField(report, "expiresAt", "string"));
    if (
      !Number.isFinite(expiresAt) ||
      (action !== "release" && (expiresAt <= now || expiresAt - generatedAt > 6 * 60 * 60_000 + 120_000))
    ) {
      fail("The admission fence deadline is invalid or expired.");
    }
    break;
  }
  case "migrate-init": {
    requireTrue(report, "success", "migrate-init report");
    requireTrue(report, "migrated", "migrate-init report");
    requireTrue(report, "runtimeLoginBootstrapped", "migrate-init report");
    requireTrue(report, "initialized", "migrate-init report");
    requireMatch(report, "releaseSha", expectedReleaseSha, "migrate-init report");
    break;
  }
  case "preflight": {
    const preflight = requireField(report, "preflight", "object");
    requireTrue(preflight, "databasePreflightPassed", "preflight report");
    requireMatch(report, "releaseSha", expectedReleaseSha, "preflight report");
    break;
  }
  case "verified-backup": {
    const manifest = requireField(report, "manifest", "object");
    const restoreVerification = requireField(
      manifest,
      "restoreVerification",
      "object",
    );
    requireTrue(restoreVerification, "matched", "verified-backup report");
    requireMatch(report, "releaseSha", expectedReleaseSha, "verified-backup report");
    break;
  }
  case "target-smoke": {
    requireTrue(report, "passed", "target-smoke report");
    requireMatch(report, "releaseSha", expectedReleaseSha, "target-smoke report");
    if (expectedImageDigest) {
      requireMatch(report, "imageDigest", expectedImageDigest, "target-smoke report");
    }
    requireMatch(report, "rolloutMode", "disabled", "target-smoke report");
    const binding = requireField(report, "binding", "object");
    requireMatch(binding, "releaseSha", expectedReleaseSha, "target-smoke report binding");
    if (expectedImageDigest) {
      requireMatch(binding, "imageDigest", expectedImageDigest, "target-smoke report binding");
    }
    requireMatch(binding, "rolloutMode", "disabled", "target-smoke report binding");
    break;
  }
  case "activation-check": {
    requireTrue(report, "approved", "activation-check report");
    requireMatch(report, "releaseSha", expectedReleaseSha, "activation-check report");
    if (expectedImageDigest) {
      requireMatch(report, "imageDigest", expectedImageDigest, "activation-check report");
    }
    break;
  }
  default:
    fail(`Unhandled operation: ${operation}`);
}

process.stdout.write(
  `validate-report: '${operation}' report at '${reportPath}' passed schema/binding validation for releaseSha=${expectedReleaseSha}.\n`,
);
