#!/usr/bin/env node
// Executable, dependency-free regression test harness for
// validate-report.mjs, focused on the "Fix 6" security-review
// requirement: a promotion rollout's imageDigest must be confirmed equal
// to the validated target-smoke report's digest before any rollout, and
// a release-SHA mismatch, a not-passed report, a non-'disabled'
// rolloutMode, or a binding/top-level digest disagreement must all fail
// closed.
//
// Spawns the real validate-report.mjs as a subprocess against fixture
// report.json files under tests/fixtures/reports/ and asserts the exit
// code (0 = accept, 1 = reject) matches expectation -- never re-implements
// or mocks the validator's logic.
//
// Usage: node test-validate-report.mjs

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import { mkdtempSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { validateDisabledRollout } from "../validate-disabled-rollout.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(__dirname, "..", "validate-report.mjs");
const fixturesDir = path.join(__dirname, "fixtures", "reports");

const RELEASE_SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const RELEASE_SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const DIGEST_1 =
  "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const DIGEST_2 =
  "sha256:2222222222222222222222222222222222222222222222222222222222222222";

let passCount = 0;
let failCount = 0;

function run(fixtureName, args, expectAccept, description) {
  const reportPath = path.join(fixturesDir, fixtureName);
  const result = spawnSync(
    process.execPath,
    [scriptPath, "--report", reportPath, ...args],
    { encoding: "utf8" },
  );
  const accepted = result.status === 0;
  const ok = accepted === expectAccept;
  const label = expectAccept ? "ACCEPT" : "REJECT";
  if (ok) {
    passCount += 1;
    console.log(`PASS  ${description}  [expect ${label}, got exit=${result.status}]`);
  } else {
    failCount += 1;
    console.log(`FAIL  ${description}  [expect ${label}, got exit=${result.status}]`);
    console.log(`      stdout: ${result.stdout.trim()}`);
    console.log(`      stderr: ${result.stderr.trim()}`);
  }
}

// --- Baseline: a fully consistent, passed target-smoke report is accepted. ---
run(
  "target-smoke-pass.json",
  ["--operation", "target-smoke", "--release-sha", RELEASE_SHA_A, "--image-digest", DIGEST_1],
  true,
  "consistent passed target-smoke report (releaseSha + imageDigest match)",
);

// --- Fix 6 core case: rollout imageDigest input must equal the report's digest. ---
run(
  "target-smoke-pass.json",
  ["--operation", "target-smoke", "--release-sha", RELEASE_SHA_A, "--image-digest", DIGEST_2],
  false,
  "rollout image_digest input does NOT match report's top-level imageDigest -- must reject",
);

run(
  "target-smoke-digest-mismatch.json",
  ["--operation", "target-smoke", "--release-sha", RELEASE_SHA_A, "--image-digest", DIGEST_1],
  false,
  "report's own top-level imageDigest differs from the expected digest -- must reject",
);

run(
  "target-smoke-binding-digest-mismatch.json",
  ["--operation", "target-smoke", "--release-sha", RELEASE_SHA_A, "--image-digest", DIGEST_1],
  false,
  "report.binding.imageDigest disagrees with report.imageDigest -- must reject (binding checked independently)",
);

// --- Release SHA binding must also match exactly. ---
run(
  "target-smoke-sha-mismatch.json",
  ["--operation", "target-smoke", "--release-sha", RELEASE_SHA_A, "--image-digest", DIGEST_1],
  false,
  "report's releaseSha does not match the expected release_sha input -- must reject",
);

run(
  "target-smoke-sha-mismatch.json",
  ["--operation", "target-smoke", "--release-sha", RELEASE_SHA_B, "--image-digest", DIGEST_1],
  true,
  "report's releaseSha DOES match when the expected SHA is the fixture's own SHA (sanity check)",
);

// --- Only a `passed: true` report may be used for promotion. ---
run(
  "target-smoke-not-passed.json",
  ["--operation", "target-smoke", "--release-sha", RELEASE_SHA_A, "--image-digest", DIGEST_1],
  false,
  "report has passed=false -- must reject even with matching sha/digest",
);

// --- rolloutMode must be 'disabled' (a target-smoke run is never itself a live rollout). ---
run(
  "target-smoke-not-disabled.json",
  ["--operation", "target-smoke", "--release-sha", RELEASE_SHA_A, "--image-digest", DIGEST_1],
  false,
  "report has rolloutMode != 'disabled' -- must reject",
);

// --- Omitting --image-digest entirely still requires releaseSha/passed to match (no bypass of those). ---
run(
  "target-smoke-not-passed.json",
  ["--operation", "target-smoke", "--release-sha", RELEASE_SHA_A],
  false,
  "omitting --image-digest does not bypass the passed=true requirement",
);

const admissionDirectory = mkdtempSync(path.join(tmpdir(), "admission-report-test-"));
try {
  const owner = "11111111-1111-4111-8111-111111111111";
  const baseAdmission = {
    schemaVersion: "1.0.0",
    operation: "deployment-admission",
    action: "acquire",
    status: "admitted",
    reason: "fence-acquired",
    generatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    owner,
    sourceReleaseSha: RELEASE_SHA_A,
    candidateReleaseSha: RELEASE_SHA_B,
    releaseSha: RELEASE_SHA_A,
    imageDigest: DIGEST_1,
    targetOrigin: "https://krypto.example.com",
    environmentName: "prod",
    jobExecutionId: "run1-a1-deployment-admission",
    azureExecutionName: "execution-1",
  };
  const admissionArgs = [
    "--operation", "deployment-admission",
    "--release-sha", RELEASE_SHA_A,
    "--image-digest", DIGEST_1,
    "--admission-action", "acquire",
    "--fence-owner", owner,
    "--source-release-sha", RELEASE_SHA_A,
    "--candidate-release-sha", RELEASE_SHA_B,
    "--target-origin", baseAdmission.targetOrigin,
    "--job-execution-id", baseAdmission.jobExecutionId,
    "--azure-execution-name", baseAdmission.azureExecutionName,
    "--allow-deferred", "true",
  ];
  for (const [overrides, expectedStatus, description] of [
    [{}, 0, "current owned admission"],
    [{ schemaVersion: "1.1.0", workflowObservation: null }, 0, "current schema admission"],
    [{ schemaVersion: "1.1.0", workflowObservation: {} }, 1, "acquisition cannot claim release evidence"],
    [{ owner: "22222222-2222-4222-8222-222222222222" }, 1, "different owner"],
    [{ candidateReleaseSha: RELEASE_SHA_A }, 1, "different candidate"],
    [{ sourceReleaseSha: RELEASE_SHA_B }, 1, "different source"],
    [{ releaseSha: RELEASE_SHA_B }, 1, "different executing job release"],
    [{ jobExecutionId: "run1-a2-deployment-admission" }, 1, "different workflow attempt"],
    [{ azureExecutionName: "execution-2" }, 1, "different Azure execution"],
    [{ targetOrigin: "https://another.example.com" }, 1, "different target"],
    [{ imageDigest: DIGEST_2 }, 1, "different image"],
    [{ environmentName: "dev" }, 1, "different environment"],
    [{ status: "blocked" }, 1, "blocked admission"],
    [{ expiresAt: new Date(Date.now() - 1000).toISOString() }, 1, "expired fence"],
    [{ generatedAt: new Date(Date.now() - 31 * 60_000).toISOString() }, 1, "stale report"],
    [{ status: "deferred", reason: "open-position", expiresAt: null }, 75, "explicit position deferral"],
    [{ status: "deferred", reason: "run-lease", expiresAt: null }, 75, "explicit lease deferral"],
    [{ status: "deferred", reason: "database-error", expiresAt: null }, 1, "failure disguised as deferral"],
    [{ status: "deferred", reason: "run-lease" }, 1, "deferral claiming an acquired fence"],
  ]) {
    const reportPath = path.join(admissionDirectory, "report.json");
    writeFileSync(reportPath, JSON.stringify({ ...baseAdmission, ...overrides }));
    const result = spawnSync(process.execPath, [scriptPath, "--report", reportPath, ...admissionArgs], { encoding: "utf8" });
    assert.equal(result.status, expectedStatus, `${description}: ${result.stderr}`);
    passCount += 1;
  }
  for (const [action, status, expiresAt, expectedStatus] of [
    ["verify", "held", baseAdmission.expiresAt, 0],
    ["verify", "held", new Date(Date.now() - 1000).toISOString(), 1],
    ["verify", "admitted", baseAdmission.expiresAt, 1],
    ["release", "released", new Date(Date.now() - 1000).toISOString(), 1],
    ["release", "deferred", null, 1],
  ]) {
    const reportPath = path.join(admissionDirectory, "report.json");
    writeFileSync(reportPath, JSON.stringify({ ...baseAdmission, action, status, expiresAt }));
    const result = spawnSync(process.execPath, [
      scriptPath, "--report", reportPath, ...admissionArgs, "--admission-action", action,
    ], { encoding: "utf8" });
    assert.equal(result.status, expectedStatus, `${action}/${status}: ${result.stderr}`);
    passCount += 1;
  }
  const workflowObservation = {
    issuer: "https://token.actions.githubusercontent.com",
    purpose: "cutover-release",
    observationDigest: "d".repeat(64),
    repositoryId: "456",
    repositoryOwnerId: "789",
    workflowRef: "owner/project/.github/workflows/azure-deploy-prod.yml@refs/heads/main",
    workflowSha: RELEASE_SHA_B,
    runId: "123",
    runAttempt: 1,
    observedAt: new Date(Date.parse(baseAdmission.generatedAt) - 1000).toISOString(),
    expiresAt: new Date(Date.parse(baseAdmission.generatedAt) + 120_000).toISOString(),
  };
  const attested = {
    ...baseAdmission, schemaVersion: "1.1.0", action: "release", status: "released",
    expiresAt: new Date(Date.now() - 1000).toISOString(), workflowObservation,
  };
  for (const [overrides, expectedStatus, description] of [
    [{}, 0, "fresh attested release can compensate an expired fence"],
    [{ schemaVersion: "1.0.0" }, 1, "legacy release cannot use the new receipt"],
    [{ workflowObservation: null }, 1, "missing receipt"],
    [{ workflowObservation: [] }, 1, "array instead of receipt"],
    ...Object.keys(workflowObservation).map((field) => [
      { workflowObservation: Object.fromEntries(Object.entries(workflowObservation).filter(([key]) => key !== field)) },
      1, `receipt is missing ${field}`,
    ]),
    ...[
      { issuer: "https://untrusted.example.com" }, { purpose: "scheduled-execution" },
      { observationDigest: "e".repeat(64) }, { workflowSha: RELEASE_SHA_A },
      { repositoryId: 456 }, { repositoryOwnerId: "0" }, { runId: "123; echo bad" },
      { runAttempt: 0 }, { runAttempt: "1" },
      { workflowRef: "owner/project/.github/workflows/untrusted.yml@refs/heads/main" },
      { token: "raw-proof-must-not-be-in-a-report" },
      { observedAt: new Date(Date.parse(baseAdmission.generatedAt) - 180_001).toISOString() },
      { observedAt: new Date(Date.parse(baseAdmission.generatedAt) + 1000).toISOString() },
      { expiresAt: baseAdmission.generatedAt },
    ].map((change) => [{ workflowObservation: { ...workflowObservation, ...change } }, 1, JSON.stringify(change)]),
  ]) {
    const reportPath = path.join(admissionDirectory, "report.json");
    writeFileSync(reportPath, JSON.stringify({ ...attested, ...overrides }));
    const result = spawnSync(process.execPath, [
      scriptPath, "--report", reportPath, ...admissionArgs, "--admission-action", "release",
      "--workflow-observation-digest", workflowObservation.observationDigest,
    ], { encoding: "utf8" });
    assert.equal(result.status, expectedStatus, `attested release ${description}: ${result.stderr}`);
    passCount += 1;
  }
  for (const [reportOwner, expectedStatus] of [
    ["34aa399d-f243-5b32-832f-e399e1f22b74", 0],
    ["11111111-1111-1111-8111-111111111111", 1],
    ["11111111-1111-5111-1111-111111111111", 1],
    ["34AA399D-F243-5B32-832F-E399E1F22B74", 1],
  ]) {
    const reportPath = path.join(admissionDirectory, "report.json");
    writeFileSync(reportPath, JSON.stringify({ ...baseAdmission, owner: reportOwner }));
    const result = spawnSync(process.execPath, [
      scriptPath, "--report", reportPath, ...admissionArgs, "--fence-owner", reportOwner,
    ], { encoding: "utf8" });
    assert.equal(result.status, expectedStatus, `UUID owner ${reportOwner}: ${result.stderr}`);
    passCount += 1;
  }
} finally {
  rmSync(path.join(admissionDirectory, "report.json"), { force: true });
  rmdirSync(admissionDirectory);
}

const productionDirectory = mkdtempSync(path.join(tmpdir(), "production-report-test-"));
try {
  const now = Date.now();
  const hour = Math.floor((now - 10_000) / 3_600_000) * 3_600_000;
  const enabled = hour / 1000 - 20;
  const generation = enabled - 60;
  const start = new Date(hour).toISOString();
  const scheduledKey = `cron:${DIGEST_1}-${generation}:${start.slice(0, 13)}`;
  const commonChecks = [
    "production-accounting-reconciled", "production-balances-valid",
    "production-stops-inactive", "production-lease-released", "production-fence-released",
  ];
  const readyChecks = [
    ...commonChecks, "production-shadow-approval", "production-shadow-terminal-safe",
    "exact-approval-id", "fresh-approval",
  ];
  const scheduledChecks = [
    ...commonChecks, "scheduled-execution-observation", "scheduled-run-binding", "scheduled-run-terminal",
    "scheduled-run-journal", "scheduled-run-fills",
  ];
  const base = {
    schemaVersion: "1.3.0", operation: "production-verification", phase: "ready",
    intendedMode: "paper", generatedAt: new Date().toISOString(),
    releaseSha: RELEASE_SHA_A, imageDigest: DIGEST_1, targetOrigin: "https://krypto.example.com",
    authorizationId: "d".repeat(64), scheduleGeneration: generation, approved: true,
    checks: readyChecks.map((id) => ({ id, status: "pass", summary: "verified" })), blockers: [],
    approvalId: "approval-1",
    shadowRun: {
      id: "shadow-run-1", idempotencyKey: "manual-shadow:run-1", outcome: "SHADOW",
      startedAt: start, completedAt: start, tradeCount: 0, errorType: null,
    },
    scheduledRun: null, workflowObservation: null, scheduledExecution: null,
    posthog: { host: "https://us.i.posthog.com", environment: "prod", keyBinding: "a".repeat(64) },
    environmentName: "prod", jobExecutionId: "run1-a1-ready", azureExecutionName: "execution-1",
  };
  const scheduled = {
    ...base, phase: "scheduled", approvalId: null, shadowRun: null,
    checks: scheduledChecks.map((id) => ({ id, status: "pass", summary: "verified" })),
    scheduledRun: {
      id: "paper-run-1", idempotencyKey: scheduledKey, outcome: "HOLD",
      startedAt: start, completedAt: start, tradeCount: 0, journalCount: 1, tradeJournalCount: 0,
    },
    workflowObservation: {
      issuer: "https://token.actions.githubusercontent.com", purpose: "scheduled-execution",
      observationDigest: "e".repeat(64), repositoryId: "123", repositoryOwnerId: "456",
      workflowRef: "owner/project/.github/workflows/azure-deploy-prod.yml@refs/heads/main",
      workflowSha: RELEASE_SHA_A, runId: "1001", runAttempt: 1,
      observedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 120_000).toISOString(),
    },
    scheduledExecution: {
      id: "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-prod/providers/Microsoft.App/jobs/caj-hourly/executions/hourly-observed",
      name: "hourly-observed", status: "Succeeded", imageDigest: DIGEST_1, templateDigest: "f".repeat(64),
      startedAt: start, completedAt: start, scheduleEnabledAt: new Date(enabled * 1000).toISOString(),
      originAssurance: "schedule-observed-not-origin-proven",
    },
  };
  const args = [
    "--operation", "production-verification", "--release-sha", RELEASE_SHA_A, "--image-digest", DIGEST_1,
    "--authorization-id", base.authorizationId, "--schedule-generation", String(generation),
    "--target-origin", base.targetOrigin, "--job-execution-id", base.jobExecutionId,
    "--azure-execution-name", base.azureExecutionName, "--approval-id", base.approvalId,
    "--expected-shadow-idempotency-key", base.shadowRun.idempotencyKey,
    "--expected-shadow-started-after", start,
    "--expected-scheduled-idempotency-key", scheduledKey,
    "--schedule-enabled-at", scheduled.scheduledExecution.scheduleEnabledAt,
    "--scheduled-execution-started-at", start, "--scheduled-execution-completed-at", start,
    "--scheduled-execution-resource-id", scheduled.scheduledExecution.id,
    "--scheduled-execution-name", scheduled.scheduledExecution.name,
    "--scheduled-execution-template-digest", scheduled.scheduledExecution.templateDigest,
    "--workflow-observation-digest", scheduled.workflowObservation.observationDigest,
  ];
  for (const [report, overrides, expectedStatus] of [
    [base, {}, 0], [scheduled, {}, 0],
    [scheduled, { scheduledRun: { ...scheduled.scheduledRun, outcome: "EXECUTED", tradeCount: 1, tradeJournalCount: 1 } }, 0],
    ...[base, scheduled].flatMap((report) => [
      [report, { schemaVersion: "1.0.0" }, 1],
      [report, { schemaVersion: "1.1.0" }, 1],
      [report, { schemaVersion: "1.2.0" }, 1],
      [report, { posthog: { host: base.posthog.host, environment: "prod", keySha256: "a".repeat(64) } }, 1],
      [report, { posthog: { ...base.posthog, keyBinding: null } }, 1],
      [report, { posthog: { ...base.posthog, keyBinding: ["a".repeat(64)] } }, 1],
      [report, { posthog: { ...base.posthog, keyBinding: "a".repeat(63) } }, 1],
      [report, { approved: false }, 1],
      [report, { checks: [] }, 1],
      [report, { checks: [...report.checks, report.checks[0]] }, 1],
      [report, { blockers: ["denied"] }, 1],
      [report, { authorizationId: "c".repeat(64) }, 1],
      [report, { scheduleGeneration: generation + 1 }, 1],
      [report, { environmentName: "dev" }, 1],
      [report, { azureExecutionName: "different-execution" }, 1],
      [report, { intendedMode: "live" }, 1],
      [report, { generatedAt: new Date(Date.now() - 601_000).toISOString() }, 1],
      [report, { generatedAt: new Date(Date.now() + 600_000).toISOString() }, 1],
    ]),
    [base, { approvalId: "copied-approval" }, 1],
    [base, { workflowObservation: scheduled.workflowObservation }, 1],
    [base, { scheduledExecution: scheduled.scheduledExecution }, 1],
    [base, { shadowRun: { ...base.shadowRun, outcome: "LOCKED" } }, 1],
    [base, { shadowRun: { ...base.shadowRun, tradeCount: 1 } }, 1],
    [base, { shadowRun: { ...base.shadowRun, errorType: "journal-failed" } }, 1],
    [base, { shadowRun: { ...base.shadowRun, completedAt: null } }, 1],
    [scheduled, { scheduledRun: { ...scheduled.scheduledRun, outcome: "RUNNING" } }, 1],
    [scheduled, { scheduledRun: { ...scheduled.scheduledRun, journalCount: 0 } }, 1],
    [scheduled, { scheduledRun: { ...scheduled.scheduledRun, tradeCount: 1 } }, 1],
    [scheduled, { scheduledRun: { ...scheduled.scheduledRun, outcome: "EXECUTED", tradeCount: 1 } }, 1],
    [scheduled, { scheduledRun: { ...scheduled.scheduledRun, completedAt: null } }, 1],
    [scheduled, { scheduledRun: { ...scheduled.scheduledRun, completedAt: new Date(hour + 1).toISOString() } }, 1],
    [scheduled, { scheduledRun: { ...scheduled.scheduledRun, idempotencyKey: scheduledKey.replace("sha256:", "old:") } }, 1],
    [scheduled, { workflowObservation: null }, 1],
    [scheduled, { scheduledExecution: null }, 1],
    ...[
      { purpose: "cutover-release" }, { observationDigest: "a".repeat(64) },
      { workflowSha: "b".repeat(40) }, { repositoryId: "0" }, { runAttempt: 0 },
      { observedAt: new Date(now - 181_000).toISOString() }, { expiresAt: new Date(now - 1).toISOString() },
      { token: "must-not-be-in-public-evidence" },
    ].map((change) => [scheduled, { workflowObservation: { ...scheduled.workflowObservation, ...change } }, 1]),
    ...[
      { id: "unbound" }, { name: base.azureExecutionName }, { imageDigest: DIGEST_2 },
      { templateDigest: "a".repeat(64) }, { status: "Running" },
      { originAssurance: "scheduler-origin-proven" }, { unknownField: true },
      { startedAt: new Date(hour + 1).toISOString() }, { completedAt: new Date(hour + 1).toISOString() },
      { scheduleEnabledAt: start },
    ].map((change) => [scheduled, { scheduledExecution: { ...scheduled.scheduledExecution, ...change } }, 1]),
  ]) {
    const reportPath = path.join(productionDirectory, "report.json");
    writeFileSync(reportPath, JSON.stringify({ ...report, ...overrides }));
    const result = spawnSync(process.execPath, [
      scriptPath, "--report", reportPath, ...args, "--production-phase", report.phase,
    ], { encoding: "utf8" });
    assert.equal(result.status, expectedStatus, `${report.phase}/${JSON.stringify(overrides)}: ${result.stderr}`);
    passCount += 1;
  }
  for (const flag of [
    "--workflow-observation-digest", "--schedule-enabled-at", "--scheduled-execution-started-at",
    "--scheduled-execution-completed-at", "--scheduled-execution-resource-id",
    "--scheduled-execution-name", "--scheduled-execution-template-digest",
  ]) {
    const reportPath = path.join(productionDirectory, "report.json");
    writeFileSync(reportPath, JSON.stringify(scheduled));
    const index = args.indexOf(flag);
    const result = spawnSync(process.execPath, [
      scriptPath, "--report", reportPath, ...args.filter((_value, offset) => offset !== index && offset !== index + 1),
      "--production-phase", "scheduled",
    ], { encoding: "utf8" });
    assert.equal(result.status, 1, `missing ${flag}: ${result.stderr}`);
    passCount += 1;
  }
} finally {
  rmSync(path.join(productionDirectory, "report.json"), { force: true });
  rmdirSync(productionDirectory);
}

const inspectionDirectory = mkdtempSync(path.join(tmpdir(), "database-inspection-report-test-"));
try {
  const now = Date.now();
  const report = {
    schemaVersion: "2.0.0", operation: "database-inspection", environmentName: "prod",
    releaseSha: RELEASE_SHA_A, imageDigest: DIGEST_1, approved: true, reason: "empty-database",
    jobExecutionId: "run1-a1-database-inspection-check-release",
    azureExecutionName: "inspection-1",
    generatedAt: new Date(now).toISOString(),
    inspection: {
      catalogProfile: "postgresql-17-bootstrap-v2", serverVersionNum: 170005,
      stateCounts: {
        catalogObjects: 0, largeObjects: 0, databaseSettings: 0, privilegeChanges: 0, metadata: 0,
      },
      databaseHost: "psql-krypto-prod02.postgres.database.azure.com",
      databaseName: "postgres", runtimeLoginRole: "krypto_app",
      observedAt: new Date(now - 1000).toISOString(), readOnly: true, empty: true,
      objectCount: 0, runtimeRolePresent: false, runtimeLoginPresent: false,
    },
  };
  const inspectionArgs = [
    "--operation", "database-inspection", "--release-sha", RELEASE_SHA_A,
    "--image-digest", DIGEST_1, "--job-execution-id", report.jobExecutionId,
    "--azure-execution-name", report.azureExecutionName,
    "--database-host", report.inspection.databaseHost,
    "--database-name", report.inspection.databaseName,
    "--runtime-login-role", report.inspection.runtimeLoginRole,
  ];
  const variants = [
    [{}, 0],
    ...[
      { approved: false }, { reason: "database-inspection-failed" }, { inspection: null },
      { schemaVersion: "1.0.0" },
      { operation: "migrate-init" }, { releaseSha: RELEASE_SHA_B }, { imageDigest: DIGEST_2 },
      { environmentName: "dev" }, { azureExecutionName: "another-execution" },
      { jobExecutionId: "another-attempt" }, { token: "must-not-be-published" },
      { generatedAt: new Date(now + 30_000).toISOString() }, { generatedAt: "invalid" },
    ].map((change) => [change, 1]),
    ...[
      { empty: false }, { readOnly: false }, { objectCount: 1 }, { objectCount: "0" },
      { runtimeRolePresent: true }, { runtimeLoginPresent: true }, { runtimeLoginPresent: null },
      { databaseHost: "foreign.example.com" }, { databaseName: "other" },
      { runtimeLoginRole: "other" }, { unknown: true },
      { catalogProfile: "postgresql-17-bootstrap-v1" },
      { catalogProfile: undefined }, { serverVersionNum: "170005" },
      { serverVersionNum: 160005 }, { serverVersionNum: 180000 }, { serverVersionNum: 170000.5 },
      { stateCounts: null }, { stateCounts: [] }, { stateCounts: {} },
      { stateCounts: { ...report.inspection.stateCounts, unknown: 0 } },
      { observedAt: new Date(now - 181_000).toISOString() },
      { observedAt: new Date(now + 30_000).toISOString() },
    ].map((change) => [{ inspection: { ...report.inspection, ...change } }, 1]),
    ...Object.keys(report.inspection.stateCounts).flatMap((category) =>
      [1, -1, "0", null, undefined].map((value) => [{
        inspection: {
          ...report.inspection,
          stateCounts: { ...report.inspection.stateCounts, [category]: value },
        },
      }, 1])),
  ];
  for (const [change, expectedStatus] of variants) {
    const reportPath = path.join(inspectionDirectory, "report.json");
    writeFileSync(reportPath, JSON.stringify({ ...report, ...change }));
    const result = spawnSync(process.execPath, [
      scriptPath, "--report", reportPath, ...inspectionArgs,
    ], { encoding: "utf8" });
    assert.equal(result.status, expectedStatus, `inspection/${JSON.stringify(change)}: ${result.stderr}`);
    passCount += 1;
  }
  for (let index = 0; index < inspectionArgs.length; index += 2) {
    const reportPath = path.join(inspectionDirectory, "report.json");
    writeFileSync(reportPath, JSON.stringify(report));
    const result = spawnSync(process.execPath, [
      scriptPath, "--report", reportPath,
      ...inspectionArgs.filter((_value, offset) => offset !== index && offset !== index + 1),
    ], { encoding: "utf8" });
    assert.equal(result.status, 1, `missing ${inspectionArgs[index]}: ${result.stderr}`);
    passCount += 1;
  }
} finally {
  rmSync(path.join(inspectionDirectory, "report.json"), { force: true });
  rmdirSync(inspectionDirectory);
}

const expectedImage = `registry.azurecr.io/krypto-web@${DIGEST_1}`;
function disabledSnapshot() {
  const template = { containers: [{ image: expectedImage, env: [{ name: "ROLLOUT_MODE", value: "disabled" }] }] };
  return {
    web: { properties: {
      provisioningState: "Succeeded",
      configuration: { activeRevisionsMode: "Single" },
      latestRevisionName: "new-revision",
      latestReadyRevisionName: "new-revision",
      template: structuredClone(template),
    } },
    revisions: [
      { name: "old-revision", properties: { active: false, replicas: 0 } },
      { name: "new-revision", properties: {
        active: true,
        provisioningState: "Provisioned",
        healthState: "Healthy",
        template: structuredClone(template),
      } },
    ],
    hourly: { properties: {
      provisioningState: "Succeeded",
      configuration: { triggerType: "Manual" },
      template: structuredClone(template),
    } },
    daily: { properties: {
      provisioningState: "Succeeded",
      configuration: { triggerType: "Manual" },
      template: structuredClone(template),
    } },
    hourlyExecutions: [{ properties: { status: "Succeeded" } }],
    dailyExecutions: [],
  };
}
validateDisabledRollout(disabledSnapshot(), expectedImage);
passCount += 1;
for (const mutate of [
  (value) => { value.web.properties.latestReadyRevisionName = "old-revision"; },
  (value) => { value.revisions[0].properties.active = true; },
  (value) => { value.revisions[0].properties.replicas = 1; },
  (value) => { delete value.revisions[0].properties.replicas; },
  (value) => { value.revisions[0].properties.provisioningState = "Deprovisioning"; },
  (value) => { value.revisions[1].properties.healthState = "Unhealthy"; },
  (value) => { value.revisions[1].properties.template.containers[0].env[0].value = "paper"; },
  (value) => { value.hourly.properties.configuration.triggerType = "Schedule"; },
  (value) => { value.daily.properties.configuration.scheduleTriggerConfig = {}; },
  (value) => { value.hourly.properties.template.containers[0].image = "registry.azurecr.io/krypto-web:latest"; },
  (value) => { value.hourlyExecutions[0].properties.status = "Running"; },
  (value) => { value.hourlyExecutions[0].properties.status = "Unknown"; },
  (value) => { value.dailyExecutions = null; },
  (value) => { value.web.properties.provisioningState = "Updating"; },
  (value) => { value.web.properties.configuration.activeRevisionsMode = "Multiple"; },
]) {
  const snapshot = disabledSnapshot();
  mutate(snapshot);
  assert.throws(() => validateDisabledRollout(snapshot, expectedImage));
  passCount += 1;
}

console.log(`\n${passCount + failCount} assertions run, ${passCount} passed, ${failCount} failed.`);
process.exit(failCount === 0 ? 0 : 1);
