"use strict";

const assert = require("node:assert/strict");

function object(value, name) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${name} must be an object.`);
  return value;
}

function equal(value, expected, name) {
  assert.equal(value, expected, `${name} does not match the expected production evidence.`);
}

function validateObservationReceipt(receipt, { purpose, workflowSha, generatedAt, digest }) {
  object(receipt, "Workflow observation receipt");
  const fields = [
    "issuer", "purpose", "observationDigest", "repositoryId", "repositoryOwnerId",
    "workflowRef", "workflowSha", "runId", "runAttempt", "observedAt", "expiresAt",
  ];
  assert(typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest) &&
    Object.keys(receipt).length === fields.length && fields.every((field) => field in receipt) &&
    receipt.issuer === "https://token.actions.githubusercontent.com" &&
    receipt.purpose === purpose && receipt.observationDigest === digest &&
    receipt.workflowSha === workflowSha &&
    typeof receipt.workflowRef === "string" &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/azure-deploy-prod\.yml@refs\/heads\/main$/.test(receipt.workflowRef) &&
    ["repositoryId", "repositoryOwnerId", "runId"].every((field) =>
      typeof receipt[field] === "string" && /^[1-9][0-9]{0,19}$/.test(receipt[field])) &&
    Number.isSafeInteger(receipt.runAttempt) && receipt.runAttempt > 0,
  "The operation lacks its exact, closed, authenticated workflow-observation receipt.");
  const observed = Date.parse(receipt.observedAt);
  const expiry = Date.parse(receipt.expiresAt);
  assert(typeof receipt.observedAt === "string" && typeof receipt.expiresAt === "string" &&
    Number.isFinite(generatedAt) && Number.isFinite(observed) && Number.isFinite(expiry) &&
    observed <= generatedAt && generatedAt - observed <= 180_000 && expiry > generatedAt,
  "The workflow observation was not fresh when the operation report was generated.");
  return receipt;
}

function validateProductionReport(report, args, now = Date.now()) {
  object(report, "Production report");
  assert.deepEqual(Object.keys(report).sort(), [
    "schemaVersion", "operation", "intendedMode", "phase", "generatedAt", "releaseSha",
    "imageDigest", "targetOrigin", "authorizationId", "scheduleGeneration", "approved",
    "checks", "blockers", "approvalId", "shadowRun", "posthog", "workflowObservation",
    "scheduledExecution", "scheduledRun", "environmentName", "jobExecutionId", "azureExecutionName",
  ].sort(), "Production reports must contain only the closed nonsecret report fields.");
  object(args, "Production report expectations");
  assert(Number.isFinite(now), "Production verification time is invalid.");
  const phase = args["production-phase"];
  const authorizationId = args["authorization-id"];
  const targetOrigin = args["target-origin"];
  const executionId = args["job-execution-id"];
  const azureExecutionName = args["azure-execution-name"];
  const generation = args["schedule-generation"];
  const releaseSha = args["release-sha"];
  const imageDigest = args["image-digest"];
  assert(["ready", "scheduled"].includes(phase), "--production-phase must be ready or scheduled.");
  assert(typeof authorizationId === "string" && /^[0-9a-f]{64}$/.test(authorizationId),
    "--authorization-id must be the readiness authorization SHA256.");
  assert(typeof generation === "string" && /^[1-9][0-9]{0,9}$/.test(generation) &&
    Number(generation) <= Math.floor(now / 1000),
  "--schedule-generation must be a positive, nonfuture epoch-second value.");
  assert(typeof releaseSha === "string" && /^[0-9a-f]{40}$/.test(releaseSha), "Exact release SHA is required.");
  assert(typeof imageDigest === "string" && /^sha256:[0-9a-f]{64}$/.test(imageDigest),
    "--image-digest is required for production verification.");
  for (const value of [executionId, azureExecutionName]) {
    assert(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value),
      "Both exact logical and Azure execution IDs are required for production verification.");
  }
  const origin = new URL(targetOrigin);
  assert(origin.protocol === "https:" && origin.origin === targetOrigin,
    "--target-origin must be a bare HTTPS origin.");
  for (const [field, expected] of Object.entries({
    schemaVersion: "1.3.0", operation: "production-verification", phase, intendedMode: "paper",
    authorizationId, releaseSha, imageDigest, targetOrigin, environmentName: "prod",
    jobExecutionId: executionId, azureExecutionName,
  })) equal(report[field], expected, field);
  equal(report.scheduleGeneration, Number(generation), "Schedule generation");
  equal(report.approved, true, "Production approval");
  assert(Array.isArray(report.checks) && report.checks.length > 0 &&
    report.checks.every((check) => check !== null && typeof check === "object" && check.status === "pass") &&
    Array.isArray(report.blockers) && report.blockers.length === 0,
  "Production evidence must contain passing checks and no blockers.");
  const requiredChecks = [
    "production-accounting-reconciled", "production-balances-valid",
    "production-stops-inactive", "production-lease-released", "production-fence-released",
    ...(phase === "ready" ? [
      "production-shadow-approval", "production-shadow-terminal-safe", "exact-approval-id", "fresh-approval",
    ] : [
      "scheduled-execution-observation", "scheduled-run-binding", "scheduled-run-terminal",
      "scheduled-run-journal", "scheduled-run-fills",
    ]),
  ];
  for (const id of requiredChecks) {
    assert.equal(report.checks.filter((check) => check.id === id && check.status === "pass").length, 1,
      `Production evidence is missing the unique passing '${id}' check.`);
  }
  const generatedAt = Date.parse(report.generatedAt);
  assert(typeof report.generatedAt === "string" && Number.isFinite(generatedAt) &&
    generatedAt <= now + 120_000 && now - generatedAt <= 600_000,
    "Production verification evidence is invalid, future-dated, or older than ten minutes.");
  const telemetry = object(report.posthog, "Production telemetry");
  assert(["https://us.i.posthog.com", "https://eu.i.posthog.com"].includes(telemetry.host) &&
    telemetry.environment === "prod" && typeof telemetry.keyBinding === "string" &&
    /^[0-9a-f]{64}$/.test(telemetry.keyBinding), "Production telemetry identity is malformed.");
  if (phase === "ready") {
    assert(typeof args["approval-id"] === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(args["approval-id"]) &&
      typeof args["expected-shadow-idempotency-key"] === "string" &&
      /^manual-shadow:[A-Za-z0-9_.-]{1,64}$/.test(args["expected-shadow-idempotency-key"]),
    "Ready evidence requires the exact smoke approval ID and manual shadow key.");
    equal(report.approvalId, args["approval-id"], "Ready approval");
    const shadow = object(report.shadowRun, "Ready shadow run");
    equal(shadow.idempotencyKey, args["expected-shadow-idempotency-key"], "Ready shadow key");
    const boundary = Date.parse(args["expected-shadow-started-after"]);
    const started = Date.parse(shadow.startedAt);
    const completed = Date.parse(shadow.completedAt);
    assert(report.scheduledRun === null && report.workflowObservation === null && report.scheduledExecution === null &&
      shadow.tradeCount === 0 && shadow.errorType === null && ["SHADOW", "HOLD", "REJECTED"].includes(shadow.outcome) &&
      Number.isFinite(boundary) && Number.isFinite(started) && Number.isFinite(completed) &&
      started >= boundary && completed >= started && completed <= generatedAt,
    "Ready proof must have a zero-fill safe shadow outcome and no scheduled run.");
  } else {
    validateObservationReceipt(report.workflowObservation, {
      purpose: "scheduled-execution", workflowSha: releaseSha, generatedAt,
      digest: args["workflow-observation-digest"],
    });
    const expectedKey = args["expected-scheduled-idempotency-key"];
    assert(typeof expectedKey === "string" && expectedKey.startsWith(`cron:${imageDigest}-${generation}:`) &&
      /:\d{4}-\d{2}-\d{2}T\d{2}$/.test(expectedKey),
    "Scheduled evidence requires the exact image/generation/hour idempotency key.");
    const scheduled = object(report.scheduledRun, "Scheduled run");
    equal(scheduled.idempotencyKey, expectedKey, "Scheduled run key");
    const execution = object(report.scheduledExecution, "Scheduled execution");
    assert.equal(Object.keys(execution).length, 9, "Scheduled execution metadata must use the closed observation shape.");
    for (const [field, expected] of Object.entries({
      id: args["scheduled-execution-resource-id"], name: args["scheduled-execution-name"],
      templateDigest: args["scheduled-execution-template-digest"], imageDigest,
      startedAt: args["scheduled-execution-started-at"], completedAt: args["scheduled-execution-completed-at"],
      scheduleEnabledAt: args["schedule-enabled-at"], status: "Succeeded",
      originAssurance: "schedule-observed-not-origin-proven",
    })) equal(execution[field], expected, `Authenticated execution ${field}`);
    assert(typeof execution.name === "string" && /^[a-z0-9][a-z0-9-]{0,127}$/.test(execution.name) &&
      typeof execution.id === "string" &&
      /^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[A-Za-z0-9_.()-]+\/providers\/Microsoft\.App\/jobs\/[a-z][a-z0-9-]{0,31}\/executions\/[a-z0-9][a-z0-9-]{0,127}$/i.test(execution.id) &&
      execution.id.endsWith(`/executions/${execution.name}`) &&
      typeof execution.templateDigest === "string" && /^[0-9a-f]{64}$/.test(execution.templateDigest),
    "The authenticated Azure execution identity or template digest is invalid.");
    for (const field of ["scheduleEnabledAt", "startedAt", "completedAt"]) {
      assert(Number.isFinite(Date.parse(execution[field])) &&
        new Date(execution[field]).toISOString() === execution[field],
      "Scheduled execution metadata must use canonical millisecond UTC timestamps.");
    }
    const enabled = Date.parse(execution.scheduleEnabledAt);
    const executionStarted = Date.parse(execution.startedAt);
    const executionCompleted = Date.parse(execution.completedAt);
    const observed = Date.parse(report.workflowObservation.observedAt);
    const firstWindow = (Math.floor(enabled / 3_600_000) + 1) * 3_600_000;
    assert(enabled >= Number(generation) * 1000 && enabled <= observed &&
      observed - enabled <= 4_800_000 && executionStarted <= generatedAt &&
      executionCompleted >= executionStarted && executionCompleted <= observed &&
      Math.floor(executionStarted / 3_600_000) * 3_600_000 === firstWindow &&
      expectedKey === `cron:${imageDigest}-${generation}:${new Date(executionStarted).toISOString().slice(0, 13)}`,
    "Scheduled proof must bind the actual first full UTC-hour execution after enablement.");
    const started = Date.parse(scheduled.startedAt);
    const completed = Date.parse(scheduled.completedAt);
    assert(typeof scheduled.id === "string" && /^[A-Za-z0-9-]{1,64}$/.test(scheduled.id) &&
      ["HOLD", "REJECTED", "EXECUTED"].includes(scheduled.outcome) &&
      Number.isSafeInteger(scheduled.journalCount) && scheduled.journalCount > 0 &&
      scheduled.tradeCount === (scheduled.outcome === "EXECUTED" ? 1 : 0) &&
      Number.isSafeInteger(scheduled.tradeJournalCount) &&
      (scheduled.outcome === "EXECUTED" ? scheduled.tradeJournalCount > 0 : scheduled.tradeJournalCount === 0) &&
      Number.isFinite(started) && Number.isFinite(completed) &&
      started >= executionStarted && completed >= started && completed <= executionCompleted &&
      report.shadowRun === null && report.approvalId === null,
    "Scheduled evidence has an invalid run, outcome, fills or journal.");
  }
  return report;
}

module.exports = { validateObservationReceipt, validateProductionReport };
