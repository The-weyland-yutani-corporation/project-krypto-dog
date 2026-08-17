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
//     [--image-digest <sha256:64-hex>] \
//     [--now <canonical-UTC-timestamp-for-tests>]
//
// Exits 0 only if every required field is present and passing. Exits 1
// with a specific stderr message identifying exactly which field was
// missing, malformed, or mismatched otherwise -- never a generic failure.

import { readFileSync } from "node:fs";

const RELEASE_SHA_PATTERN = /^[0-9a-f]{40}$/;
const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const HEX_64_PATTERN = /^[0-9a-f]{64}$/;
const APPROVAL_ID_PATTERN =
  /^deployment-smoke-approved-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BINDING_ID_PATTERN =
  /^deployment-smoke-binding-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MODE_MISMATCH_EVIDENCE_ID_PATTERN =
  /^deployment-smoke-mode-mismatch-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CRON_EVIDENCE_ID_PATTERN =
  /^deployment-smoke-cron-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ADMIN_EVIDENCE_ID_PATTERN =
  /^deployment-smoke-admin-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_APPROVAL_AGE_MS = 24 * 60 * 60 * 1_000;
const OPERATIONS = new Set([
  "migrate-init",
  "preflight",
  "verified-backup",
  "target-smoke",
  "activation-check",
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
const validationTimeInput = args["now"];

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
let validationTime = new Date();
if (validationTimeInput) {
  validationTime = new Date(validationTimeInput);
  if (
    Number.isNaN(validationTime.getTime()) ||
    validationTime.toISOString() !== validationTimeInput
  ) {
    fail("--now must be a canonical UTC timestamp.");
  }
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
  if (expectedType === "object" && Array.isArray(value)) {
    fail(`Report field '${field}' must be an object.`);
  }
  if (expectedType === "array" && !Array.isArray(value)) {
    fail(`Report field '${field}' must be an array.`);
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

function requirePattern(object, field, pattern, context) {
  const value = requireField(object, field, "string");
  if (!pattern.test(value)) {
    fail(`${context}: field '${field}' is malformed.`);
  }
  return value;
}

function canonicalTimestamp(object, field, context) {
  const value = requireField(object, field, "string");
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    fail(`${context}: field '${field}' must be a canonical UTC timestamp.`);
  }
  return parsed;
}

function requirePassingCheck(reportObject, id) {
  const checks = requireField(reportObject, "checks", "array");
  const matches = checks.filter(
    (value) =>
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      value.id === id,
  );
  if (matches.length !== 1 || matches[0].status !== "pass") {
    fail(`activation-check report must contain one passing '${id}' check.`);
  }
}

switch (operation) {
  case "migrate-init": {
    requireTrue(report, "success", "migrate-init report");
    requireTrue(report, "databaseRolesBootstrapped", "migrate-init report");
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
    requireMatch(report, "schemaVersion", "1.6.0", "target-smoke report");
    const generatedAt = canonicalTimestamp(
      report,
      "generatedAt",
      "target-smoke report",
    );
    requireTrue(report, "passed", "target-smoke report");
    const checks = requireField(report, "checks", "array");
    const safetyChecks = checks.filter(
      (check) =>
        check !== null &&
        typeof check === "object" &&
        check.id === "safety-incident-test-fire-dry-run",
    );
    if (
      safetyChecks.length !== 1 ||
      safetyChecks[0].status !== "pass" ||
      safetyChecks[0].evidence?.persisted !== false ||
      safetyChecks[0].evidence?.rosterComplete !== true ||
      safetyChecks[0].evidence?.authenticatorsConfigured !== true
    ) {
      fail(
        "Target-smoke report must contain exactly one passing, non-persisted safety-incident test-fire dry run with a complete authenticated roster.",
      );
    }
    requireMatch(report, "releaseSha", expectedReleaseSha, "target-smoke report");
    if (expectedImageDigest) {
      requireMatch(report, "imageDigest", expectedImageDigest, "target-smoke report");
    }
    requireMatch(report, "rolloutMode", "disabled", "target-smoke report");
    const evidenceIds = requireField(report, "evidenceIds", "object");
    const binding = requireField(report, "binding", "object");
    const approvalId = requirePattern(
      binding,
      "approvalId",
      APPROVAL_ID_PATTERN,
      "target-smoke report binding",
    );
    const bindingId = requirePattern(
      binding,
      "bindingId",
      BINDING_ID_PATTERN,
      "target-smoke report binding",
    );
    const modeMismatchEvidenceId = requirePattern(
      binding,
      "modeMismatchEvidenceId",
      MODE_MISMATCH_EVIDENCE_ID_PATTERN,
      "target-smoke report binding",
    );
    const cronEvidenceId = requirePattern(
      binding,
      "cronEvidenceId",
      CRON_EVIDENCE_ID_PATTERN,
      "target-smoke report binding",
    );
    const adminEvidenceId = requirePattern(
      binding,
      "adminEvidenceId",
      ADMIN_EVIDENCE_ID_PATTERN,
      "target-smoke report binding",
    );
    requireMatch(
      evidenceIds,
      "approval",
      approvalId,
      "target-smoke report evidence IDs",
    );
    requireMatch(
      evidenceIds,
      "modeMismatch",
      modeMismatchEvidenceId,
      "target-smoke report evidence IDs",
    );
    requireMatch(
      evidenceIds,
      "cron",
      cronEvidenceId,
      "target-smoke report evidence IDs",
    );
    requireMatch(
      evidenceIds,
      "admin",
      adminEvidenceId,
      "target-smoke report evidence IDs",
    );
    requireMatch(
      evidenceIds,
      "databaseBinding",
      bindingId,
      "target-smoke report evidence IDs",
    );
    const target = requireField(report, "target", "string");
    let targetOrigin;
    try {
      targetOrigin = new URL(target).origin;
    } catch {
      fail("target-smoke report field 'target' must be an absolute URL.");
    }
    requireMatch(
      binding,
      "targetOrigin",
      targetOrigin,
      "target-smoke report binding",
    );
    requireMatch(binding, "releaseSha", expectedReleaseSha, "target-smoke report binding");
    if (expectedImageDigest) {
      requireMatch(binding, "imageDigest", expectedImageDigest, "target-smoke report binding");
    }
    requireMatch(binding, "rolloutMode", "disabled", "target-smoke report binding");
    requirePattern(
      binding,
      "cronSecretBinding",
      HEX_64_PATTERN,
      "target-smoke report binding",
    );
    requirePattern(
      binding,
      "approvalSignature",
      HEX_64_PATTERN,
      "target-smoke report binding",
    );
    const approvedAt = canonicalTimestamp(
      binding,
      "approvedAt",
      "target-smoke report binding",
    );
    if (approvedAt.getTime() !== generatedAt.getTime()) {
      fail(
        "target-smoke report binding approvedAt must equal the report generatedAt timestamp.",
      );
    }
    break;
  }
  case "activation-check": {
    requireMatch(
      report,
      "schemaVersion",
      "1.1.0",
      "activation-check report",
    );
    const generatedAt = canonicalTimestamp(
      report,
      "generatedAt",
      "activation-check report",
    );
    requireTrue(report, "approved", "activation-check report");
    requireMatch(report, "releaseSha", expectedReleaseSha, "activation-check report");
    if (expectedImageDigest) {
      requireMatch(report, "imageDigest", expectedImageDigest, "activation-check report");
    }
    const approval = requireField(report, "approval", "object");
    requirePattern(
      approval,
      "id",
      APPROVAL_ID_PATTERN,
      "activation-check approval",
    );
    requirePattern(
      approval,
      "bindingId",
      BINDING_ID_PATTERN,
      "activation-check approval",
    );
    requirePattern(
      approval,
      "modeMismatchEvidenceId",
      MODE_MISMATCH_EVIDENCE_ID_PATTERN,
      "activation-check approval",
    );
    requirePattern(
      approval,
      "cronEvidenceId",
      CRON_EVIDENCE_ID_PATTERN,
      "activation-check approval",
    );
    requirePattern(
      approval,
      "adminEvidenceId",
      ADMIN_EVIDENCE_ID_PATTERN,
      "activation-check approval",
    );
    const approvedAt = canonicalTimestamp(
      approval,
      "approvedAt",
      "activation-check approval",
    );
    const expiresAt = canonicalTimestamp(
      approval,
      "expiresAt",
      "activation-check approval",
    );
    if (expiresAt.getTime() - approvedAt.getTime() !== MAX_APPROVAL_AGE_MS) {
      fail("activation-check approval expiry must be exactly 24 hours.");
    }
    if (generatedAt.getTime() < approvedAt.getTime()) {
      fail(
        "activation-check report was generated before its approval timestamp.",
      );
    }
    if (
      validationTime.getTime() < generatedAt.getTime() ||
      validationTime.getTime() > expiresAt.getTime()
    ) {
      fail("activation-check approval is not valid at validation time.");
    }
    for (const checkId of [
      "manual-shadow-run-present",
      "manual-shadow-run-started-after-boundary",
      "manual-shadow-run-mode",
      "manual-shadow-run-terminal",
      "manual-shadow-run-no-trade",
      "latest-approval-present",
      "approval-order-unambiguous",
      "approval-identifiers-valid",
      "binding-row-present",
      "binding-id-match",
      "target-origin-match",
      "cron-secret-binding-match",
      "approval-binding-complete",
      "approval-signature-valid",
      "approval-timestamp-valid",
      "approval-not-in-future",
      "approval-within-24-hours",
      "release-sha-match",
      "image-digest-match",
      "smoke-rollout-mode-disabled",
      "no-active-lease",
      "accounting-reconciled",
      "no-open-paper-position",
    ]) {
      requirePassingCheck(report, checkId);
    }
    break;
  }
  default:
    fail(`Unhandled operation: ${operation}`);
}

process.stdout.write(
  `validate-report: '${operation}' report at '${reportPath}' passed schema/binding validation for releaseSha=${expectedReleaseSha}.\n`,
);
