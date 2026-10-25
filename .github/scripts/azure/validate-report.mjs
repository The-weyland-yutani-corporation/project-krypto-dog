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
  "production-verification",
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

function requireWorkflowObservation(purpose, workflowSha, generatedAt) {
  const digest = args["workflow-observation-digest"];
  const receipt = requireField(report, "workflowObservation", "object");
  const fields = [
    "issuer", "purpose", "observationDigest", "repositoryId", "repositoryOwnerId",
    "workflowRef", "workflowSha", "runId", "runAttempt", "observedAt", "expiresAt",
  ];
  if (!/^[0-9a-f]{64}$/.test(digest ?? "") ||
      Object.keys(receipt).length !== fields.length || !fields.every((field) => field in receipt) ||
      receipt.issuer !== "https://token.actions.githubusercontent.com" ||
      receipt.purpose !== purpose || receipt.observationDigest !== digest ||
      receipt.workflowSha !== workflowSha ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/azure-deploy-prod\.yml@refs\/heads\/main$/.test(receipt.workflowRef) ||
      !["repositoryId", "repositoryOwnerId", "runId"].every((field) =>
        typeof receipt[field] === "string" && /^[1-9][0-9]{0,19}$/.test(receipt[field])) ||
      !Number.isSafeInteger(receipt.runAttempt) || receipt.runAttempt < 1) {
    fail("The operation lacks its exact, closed, authenticated workflow-observation receipt.");
  }
  const observed = Date.parse(receipt.observedAt);
  const expiry = Date.parse(receipt.expiresAt);
  if (!Number.isFinite(observed) || !Number.isFinite(expiry) ||
      observed > generatedAt || generatedAt - observed > 180_000 || expiry <= generatedAt) {
    fail("The workflow observation was not fresh when the operation report was generated.");
  }
}

switch (operation) {
  case "production-verification": {
    const phase = args["production-phase"];
    const authorizationId = args["authorization-id"];
    const targetOrigin = args["target-origin"];
    const executionId = args["job-execution-id"];
    const azureExecutionName = args["azure-execution-name"];
    const generation = args["schedule-generation"];
    if (!["ready", "scheduled"].includes(phase)) fail("--production-phase must be ready or scheduled.");
    if (!/^[0-9a-f]{64}$/.test(authorizationId ?? "")) fail("--authorization-id must be the readiness authorization SHA256.");
    if (!/^[1-9][0-9]{0,9}$/.test(generation ?? "") || Number(generation) > Math.floor(Date.now() / 1000)) {
      fail("--schedule-generation must be a positive, nonfuture epoch-second value.");
    }
    if (!expectedImageDigest) fail("--image-digest is required for production verification.");
    for (const value of [executionId, azureExecutionName]) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value ?? "")) {
        fail("Both exact logical and Azure execution IDs are required for production verification.");
      }
    }
    let origin;
    try {
      origin = new URL(targetOrigin);
    } catch {
      fail("--target-origin must be a bare HTTPS origin.");
    }
    if (origin.protocol !== "https:" || origin.origin !== targetOrigin) fail("--target-origin must be a bare HTTPS origin.");
    for (const [field, expected] of Object.entries({
      schemaVersion: "1.3.0", operation, phase, intendedMode: "paper",
      authorizationId, releaseSha: expectedReleaseSha, imageDigest: expectedImageDigest,
      targetOrigin, environmentName: "prod", jobExecutionId: executionId, azureExecutionName,
    })) requireMatch(report, field, expected, "production-verification report");
    if (report.scheduleGeneration !== Number(generation)) fail("Production schedule generation does not match.");
    requireTrue(report, "approved", "production-verification report");
    if (!Array.isArray(report.checks) || report.checks.length === 0 ||
        !report.checks.every((check) => check !== null && typeof check === "object" && check.status === "pass") ||
        !Array.isArray(report.blockers) || report.blockers.length !== 0) {
      fail("Production evidence must contain passing checks and no blockers.");
    }
    const requiredChecks = [
      "production-accounting-reconciled", "production-balances-valid",
      "production-stops-inactive", "production-lease-released", "production-fence-released",
      ...(phase === "ready" ? [
        "production-shadow-approval", "production-shadow-terminal-safe",
        "exact-approval-id", "fresh-approval",
      ] : [
        "scheduled-execution-observation", "scheduled-run-binding", "scheduled-run-terminal",
        "scheduled-run-journal", "scheduled-run-fills",
      ]),
    ];
    for (const id of requiredChecks) {
      if (report.checks.filter((check) => check.id === id && check.status === "pass").length !== 1) {
        fail(`Production evidence is missing the unique passing '${id}' check.`);
      }
    }
    const generatedAt = Date.parse(requireField(report, "generatedAt", "string"));
    if (!Number.isFinite(generatedAt) || generatedAt > Date.now() + 120_000 || Date.now() - generatedAt > 600_000) {
      fail("Production verification evidence is invalid, future-dated, or older than ten minutes.");
    }
    const telemetry = requireField(report, "posthog", "object");
    if (!["https://us.i.posthog.com", "https://eu.i.posthog.com"].includes(telemetry.host) ||
        telemetry.environment !== "prod" || typeof telemetry.keyBinding !== "string" ||
        !/^[0-9a-f]{64}$/.test(telemetry.keyBinding)) {
      fail("Production telemetry identity is malformed.");
    }
    if (phase === "ready") {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(args["approval-id"] ?? "") ||
          !/^manual-shadow:[A-Za-z0-9_.-]{1,64}$/.test(args["expected-shadow-idempotency-key"] ?? "")) {
        fail("Ready evidence requires the exact smoke approval ID and manual shadow key.");
      }
      requireMatch(report, "approvalId", args["approval-id"], "ready approval");
      const shadow = requireField(report, "shadowRun", "object");
      requireMatch(shadow, "idempotencyKey", args["expected-shadow-idempotency-key"], "ready shadow run");
      const boundary = Date.parse(args["expected-shadow-started-after"]);
      const started = Date.parse(shadow.startedAt);
      const completed = Date.parse(shadow.completedAt);
      if (report.scheduledRun !== null || report.workflowObservation !== null || report.scheduledExecution !== null ||
          shadow.tradeCount !== 0 || shadow.errorType !== null ||
          !["SHADOW", "HOLD", "REJECTED"].includes(shadow.outcome) ||
          !Number.isFinite(boundary) || !Number.isFinite(started) || !Number.isFinite(completed) ||
          started < boundary || completed < started || completed > generatedAt) {
        fail("Ready proof must have a zero-fill safe shadow outcome and no scheduled run.");
      }
    } else {
      requireWorkflowObservation("scheduled-execution", expectedReleaseSha, generatedAt);
      const expectedKey = args["expected-scheduled-idempotency-key"];
      if (!expectedKey || !expectedKey.startsWith(`cron:${expectedImageDigest}-${generation}:`) ||
          !/:\d{4}-\d{2}-\d{2}T\d{2}$/.test(expectedKey)) {
        fail("Scheduled evidence requires the exact image/generation/hour idempotency key.");
      }
      const scheduled = requireField(report, "scheduledRun", "object");
      requireMatch(scheduled, "idempotencyKey", expectedKey, "scheduled run");
      const execution = requireField(report, "scheduledExecution", "object");
      if (Object.keys(execution).length !== 9) fail("Scheduled execution metadata must use the closed observation shape.");
      for (const [field, expected] of Object.entries({
        id: args["scheduled-execution-resource-id"], name: args["scheduled-execution-name"],
        templateDigest: args["scheduled-execution-template-digest"], imageDigest: expectedImageDigest,
        startedAt: args["scheduled-execution-started-at"], completedAt: args["scheduled-execution-completed-at"],
        scheduleEnabledAt: args["schedule-enabled-at"], status: "Succeeded",
        originAssurance: "schedule-observed-not-origin-proven",
      })) requireMatch(execution, field, expected, "authenticated Azure execution");
      if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(execution.name) ||
          !/^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[A-Za-z0-9_.()-]+\/providers\/Microsoft\.App\/jobs\/[a-z][a-z0-9-]{0,31}\/executions\/[a-z0-9][a-z0-9-]{0,127}$/i.test(execution.id) ||
          !execution.id.endsWith(`/executions/${execution.name}`) ||
          !/^[0-9a-f]{64}$/.test(execution.templateDigest)) {
        fail("The authenticated Azure execution identity or template digest is invalid.");
      }
      for (const field of ["scheduleEnabledAt", "startedAt", "completedAt"]) {
        const value = execution[field];
        if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
          fail("Scheduled execution metadata must use canonical millisecond UTC timestamps.");
        }
      }
      const enabled = Date.parse(execution.scheduleEnabledAt);
      const executionStarted = Date.parse(args["scheduled-execution-started-at"]);
      const executionCompleted = Date.parse(execution.completedAt);
      const observed = Date.parse(report.workflowObservation.observedAt);
      const firstWindow = (Math.floor(enabled / 3_600_000) + 1) * 3_600_000;
      if (!Number.isFinite(enabled) || enabled < Number(generation) * 1000 ||
          enabled > observed || observed - enabled > 4_800_000 ||
          !Number.isFinite(executionStarted) || executionStarted > generatedAt ||
          !Number.isFinite(executionCompleted) || executionCompleted < executionStarted ||
          executionCompleted > observed ||
          Math.floor(executionStarted / 3_600_000) * 3_600_000 !== firstWindow ||
          expectedKey !== `cron:${expectedImageDigest}-${generation}:${new Date(executionStarted).toISOString().slice(0, 13)}`) {
        fail("Scheduled proof must bind the actual first full UTC-hour execution after enablement.");
      }
      const started = Date.parse(scheduled.startedAt);
      const completed = Date.parse(scheduled.completedAt);
      if (!/^[A-Za-z0-9-]{1,64}$/.test(scheduled.id ?? "") ||
          !["HOLD", "REJECTED", "EXECUTED"].includes(scheduled.outcome) ||
          !Number.isSafeInteger(scheduled.journalCount) || scheduled.journalCount < 1 ||
          scheduled.tradeCount !== (scheduled.outcome === "EXECUTED" ? 1 : 0) ||
          !Number.isSafeInteger(scheduled.tradeJournalCount) ||
          (scheduled.outcome === "EXECUTED" ? scheduled.tradeJournalCount < 1 : scheduled.tradeJournalCount !== 0) ||
          !Number.isFinite(started) || !Number.isFinite(completed) ||
          started < executionStarted || completed < started || completed > executionCompleted ||
          report.shadowRun !== null || report.approvalId !== null) {
        fail("Scheduled evidence has an invalid run, outcome, fills or journal.");
      }
    }
    break;
  }
  case "deployment-admission": {
    const action = args["admission-action"];
    const owner = args["fence-owner"];
    const sourceSha = args["source-release-sha"];
    const candidateSha = args["candidate-release-sha"];
    const targetOrigin = args["target-origin"];
    const executionId = args["job-execution-id"];
    const azureExecutionName = args["azure-execution-name"];
    if (!["acquire", "verify", "release"].includes(action)) fail("--admission-action must be acquire, verify, or release.");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(owner ?? "")) {
      fail("--fence-owner must be a lowercase UUID v4 or v5.");
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
    // Older source ops may acquire/verify during their first upgrade, never release.
    if (!(action === "release" ? ["1.1.0"] : ["1.0.0", "1.1.0"]).includes(report.schemaVersion)) {
      fail("Unsupported admission schema; fence release requires attested schema 1.1.0.");
    }
    for (const [field, expected] of Object.entries({
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
    if (action === "release") {
      requireWorkflowObservation("cutover-release", candidateSha, generatedAt);
    } else if (report.schemaVersion === "1.1.0" && report.workflowObservation !== null) {
      fail("Non-release admission cannot claim a workflow-observation receipt.");
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
