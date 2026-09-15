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
//     [--environment-name <environment>]
//     [--image-digest <sha256:64-hex>] (required for target/activation)
//
// Exits 0 only if every required field is present and passing. Exits 1
// with a specific stderr message identifying exactly which field was
// missing, malformed, or mismatched otherwise -- never a generic failure.

import { readFileSync } from "node:fs";
import validation from "./report-validation.cjs";

const { EvidenceValidationError, IMAGE_DIGEST_PATTERN, OPERATIONS, RELEASE_SHA_PATTERN, validateOperationReport } = validation;

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
if (!operation || !OPERATIONS.includes(operation)) {
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

try {
  validateOperationReport(report, {
    operation,
    releaseSha: expectedReleaseSha,
    imageDigest: expectedImageDigest,
    environmentName: args["environment-name"],
  });
} catch (error) {
  if (!(error instanceof EvidenceValidationError)) throw error;
  fail(error.message);
}

process.stdout.write(
  `validate-report: '${operation}' report at '${reportPath}' passed schema/binding validation for releaseSha=${expectedReleaseSha}.\n`,
);
