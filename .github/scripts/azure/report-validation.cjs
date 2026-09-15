"use strict";

const RELEASE_SHA_PATTERN = /^[0-9a-f]{40}$/;
const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const OPERATIONS = Object.freeze([
  "migrate-init",
  "preflight",
  "verified-backup",
  "target-smoke",
  "activation-check",
]);

class EvidenceValidationError extends Error {}

function requireEvidence(condition, message) {
  if (!condition) throw new EvidenceValidationError(message);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireMatch(object, field, expected) {
  requireEvidence(isObject(object) && object[field] === expected, `Report field '${field}' is missing or mismatched.`);
}

function requirePassingChecks(report) {
  requireEvidence(
    Array.isArray(report?.checks) &&
      report.checks.length > 0 &&
      report.checks.every((check) => isObject(check) && typeof check.id === "string" && check.status === "pass") &&
      new Set(report.checks.map((check) => check.id)).size === report.checks.length,
    "Report checks are missing, duplicated, or not passing.",
  );
}

function validateOperationReport(report, {
  operation,
  releaseSha,
  imageDigest,
  environmentName,
  strict = false,
}) {
  requireEvidence(OPERATIONS.includes(operation), "Unknown evidence operation.");
  requireEvidence(RELEASE_SHA_PATTERN.test(releaseSha || ""), "Expected release SHA must be an exact 40-hex commit SHA.");
  requireEvidence(isObject(report), "Report must be a JSON object.");
  requireMatch(report, "releaseSha", releaseSha);
  if (environmentName !== undefined) {
    requireEvidence(/^[a-z][a-z0-9-]{1,31}$/.test(environmentName), "Expected environment is invalid.");
    // Target/activation reports predate the Azure envelope and bind the
    // environment through the immutable path instead of a report field.
    if (!["target-smoke", "activation-check"].includes(operation) || "environmentName" in report) {
      requireMatch(report, "environmentName", environmentName);
    }
  }
  if (!["target-smoke", "activation-check"].includes(operation)) {
    if (strict || "operation" in report) requireMatch(report, "operation", operation);
  } else {
    requireEvidence(IMAGE_DIGEST_PATTERN.test(imageDigest || ""), "Expected image digest is required for bound evidence.");
    requireMatch(report, "imageDigest", imageDigest);
  }

  switch (operation) {
    case "migrate-init":
      for (const field of ["success", "migrated", "runtimeLoginBootstrapped", "initialized"]) {
        requireMatch(report, field, true);
      }
      break;
    case "preflight":
      requireMatch(report.preflight, "databasePreflightPassed", true);
      if (strict) {
        requirePassingChecks(report.preflight);
        requireEvidence(Array.isArray(report.preflight.blockers) && report.preflight.blockers.length === 0, "Preflight has missing or nonempty blockers.");
      }
      break;
    case "verified-backup":
      requireMatch(report.manifest?.restoreVerification, "matched", true);
      break;
    case "target-smoke":
      requireMatch(report, "passed", true);
      requireMatch(report, "rolloutMode", "disabled");
      requireMatch(report.binding, "releaseSha", releaseSha);
      requireMatch(report.binding, "imageDigest", imageDigest);
      requireMatch(report.binding, "rolloutMode", "disabled");
      if (strict) {
        requireMatch(report, "schemaVersion", "1.4.0");
        requirePassingChecks(report);
        for (const field of ["cronSecretBinding", "approvalSignature"]) {
          requireEvidence(/^[0-9a-f]{64}$/.test(report.binding[field] || ""), `Target-smoke binding '${field}' is missing or malformed.`);
        }
        for (const field of ["approvalId", "bindingId", "targetOrigin"]) {
          requireEvidence(typeof report.binding[field] === "string" && report.binding[field].length > 0, `Target-smoke binding '${field}' is missing.`);
        }
      }
      break;
    case "activation-check":
      requireMatch(report, "approved", true);
      if (strict) {
        requireMatch(report, "schemaVersion", "1.0.0");
        requirePassingChecks(report);
        requireEvidence(Array.isArray(report.blockers) && report.blockers.length === 0, "Activation has missing or nonempty blockers.");
        requireEvidence(isObject(report.shadowRun) && report.shadowRun.tradeCount === 0, "Activation must prove a zero-trade shadow run.");
      }
      break;
  }
  return report;
}

module.exports = {
  EvidenceValidationError,
  IMAGE_DIGEST_PATTERN,
  OPERATIONS,
  RELEASE_SHA_PATTERN,
  isObject,
  requireEvidence,
  validateOperationReport,
};
