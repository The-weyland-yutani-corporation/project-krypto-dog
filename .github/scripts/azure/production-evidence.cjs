"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { loadRunArchive } = require("../agentic-receipt.cjs");

const RELEASE_WORKFLOW = "azure-deploy-prod.yml";
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const EXECUTION = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const RELEASE_JOBS = Object.freeze([
  "gate", "force-disable-rollout", "deploy-environment", "build-images",
  "deploy-release", "migrate-backup", "release-cutover-fence",
  "target-smoke", "verify-final-state",
]);
const POST_ADMISSION_JOBS = RELEASE_JOBS.slice(2);

function object(value, name) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${name} must be an object.`);
  return value;
}

function integer(value, name) {
  assert(Number.isSafeInteger(value) && value > 0, `${name} must be a positive safe integer.`);
  return value;
}

function matching(value, pattern, name) {
  assert(typeof value === "string" && pattern.test(value), `${name} is missing or invalid.`);
  return value;
}

function origin(value) {
  assert(typeof value === "string", "Target origin is missing.");
  const url = new URL(value);
  assert(url.protocol === "https:" && url.origin === value, "A bare HTTPS target origin is required.");
  return value;
}

function containerUrl(value) {
  assert(typeof value === "string", "Evidence container is missing.");
  const url = new URL(value);
  assert(url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash &&
    /^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(url.hostname) &&
    /^\/[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(url.pathname),
  "An exact Azure evidence container URL without credentials is required.");
  return value;
}

function receiptName(stage, sha, runId, attempt) {
  assert.equal(stage, "release", "Only disabled-release receipts are implemented.");
  matching(sha, SHA, "Release SHA");
  integer(runId, "Run ID");
  integer(attempt, "Run attempt");
  return `production-${stage}-${sha}-${runId}-${attempt}`;
}

function validateBinding(binding) {
  object(binding, "Release binding");
  matching(binding.releaseSha, SHA, "Release SHA");
  matching(binding.webImageDigest, DIGEST, "Web image digest");
  matching(binding.opsImageDigest, DIGEST, "Ops image digest");
  matching(binding.registryLoginServer, /^[a-z0-9]{5,50}\.azurecr\.io$/, "Registry login server");
  origin(binding.targetOrigin);
  containerUrl(binding.evidenceContainerUrl);
  return binding;
}

function productionVerificationOverrides(config) {
  object(config, "Production verification configuration");
  assert(["ready", "scheduled"].includes(config.phase), "Unknown production verification phase.");
  const fields = {
    phase: "PRODUCTION_VERIFICATION_PHASE",
    authorizationId: "PRODUCTION_AUTHORIZATION_ID",
    scheduleGeneration: "SCHEDULE_GENERATION_UNIX_SECONDS",
    ...(config.phase === "ready" ? {
      approvalId: "EXPECTED_APPROVAL_ID",
      approvalCreatedAfter: "EXPECTED_APPROVAL_CREATED_AFTER",
      shadowIdempotencyKey: "EXPECTED_SHADOW_IDEMPOTENCY_KEY",
      shadowStartedAfter: "EXPECTED_SHADOW_STARTED_AFTER",
    } : {
      scheduleEnabledAt: "SCHEDULE_ENABLED_AT_UNIX_SECONDS",
      scheduledExecutionStartedAt: "SCHEDULED_EXECUTION_STARTED_AT",
    }),
  };
  assert.deepEqual(Object.keys(config).sort(), Object.keys(fields).sort(),
    "Production configuration must contain exactly its phase's nonsecret fields.");
  matching(config.authorizationId, /^[0-9a-f]{64}$/, "Readiness authorization digest");
  integer(config.scheduleGeneration, "Schedule generation");
  assert(config.scheduleGeneration <= Math.floor(Date.now() / 1000), "Schedule generation is in the future.");
  const dateFields = config.phase === "ready" ?
    ["approvalCreatedAfter", "shadowStartedAfter"] : ["scheduledExecutionStartedAt"];
  for (const field of dateFields) {
    matching(config[field], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/, field);
    assert.equal(new Date(config[field]).toISOString().replace(".000Z", "Z"),
      config[field].replace(".000Z", "Z"), "Invalid production timestamp.");
  }
  if (config.phase === "ready") {
    matching(config.approvalId, /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/, "Approval ID");
    matching(config.shadowIdempotencyKey, /^manual-shadow:[A-Za-z0-9_.-]{1,64}$/, "Shadow key");
    matching(config.shadowStartedAfter, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, "Shadow start boundary");
  } else {
    integer(config.scheduleEnabledAt, "Schedule-enabled boundary");
    assert(config.scheduleEnabledAt >= config.scheduleGeneration &&
      config.scheduleEnabledAt <= Math.floor(Date.now() / 1000), "Invalid schedule-enabled boundary.");
  }
  return [
    { name: "OPERATION", value: "production-verification" },
    ...Object.entries(fields).map(([key, name]) => ({ name, value: String(config[key]) })),
  ];
}

function baseReceipt(env, stage) {
  assert.equal(stage, "release", "Only disabled-release receipts are implemented.");
  matching(env.GITHUB_REPOSITORY, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "Repository");
  assert.equal(env.GITHUB_REF, "refs/heads/main", "Production evidence requires protected main.");
  for (const key of ["GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_REPOSITORY_ID"]) {
    matching(env[key], /^[1-9][0-9]*$/, key);
  }
  return {
    schemaVersion: 1,
    stage,
    repository: env.GITHUB_REPOSITORY,
    repositoryId: integer(Number(env.GITHUB_REPOSITORY_ID), "Repository ID"),
    runId: integer(Number(env.GITHUB_RUN_ID), "Run ID"),
    runAttempt: integer(Number(env.GITHUB_RUN_ATTEMPT), "Run attempt"),
    workflowSha: matching(env.GITHUB_SHA, SHA, "Workflow SHA"),
    releaseSha: matching(env.RESOLVED_SHA, SHA, "Release SHA"),
    generatedAt: new Date().toISOString(),
  };
}

function createReleaseReceipt(env, needs) {
  object(needs, "Job results");
  const receipt = baseReceipt(env, "release");
  const gate = object(needs.gate, "Gate");
  assert.equal(gate.result, "success", "The release gate did not pass.");
  assert.equal(gate.outputs?.sha, receipt.releaseSha, "The gate authorized a different SHA.");
  assert.equal(gate.outputs?.deployment_stage, "full", "A foundation is not a release.");
  const admission = object(needs["force-disable-rollout"], "Admission");
  const results = {};
  for (const name of RELEASE_JOBS) {
    const result = object(needs[name], `${name} result`).result;
    assert(["success", "failure", "cancelled", "skipped"].includes(result),
      `Unknown result for ${name}.`);
    results[name] = result;
  }
  const fresh = admission.outputs?.existing_release === "false";
  const existing = admission.outputs?.existing_release === "true";
  const deferred = existing && admission.result === "success" &&
    admission.outputs?.admission_status === "deferred" &&
    POST_ADMISSION_JOBS.every((name) => results[name] === "skipped");
  const released = needs["release-cutover-fence"].outputs?.status;
  const verified = RELEASE_JOBS.every((name) => results[name] === "success") &&
    ((fresh && released === "fresh") ||
     (existing && admission.outputs?.admission_status === "admitted" && released === "released"));
  const status = verified ? "disabled" : deferred ? "deferred" : "failed";
  if (!verified) return { ...receipt, status, results, binding: null };

  const environment = object(needs["deploy-environment"].outputs, "Foundation outputs");
  const images = object(needs["build-images"].outputs, "Image outputs");
  const binding = validateBinding({
    releaseSha: receipt.releaseSha,
    webImageDigest: `sha256:${images.web_digest_hex}`,
    opsImageDigest: `sha256:${images.ops_digest_hex}`,
    registryLoginServer: environment.acr_login_server,
    targetOrigin: needs["verify-final-state"].outputs?.target_origin,
    evidenceContainerUrl: environment.evidence_container_url,
  });
  return {
    ...receipt, status, results, binding,
    backupExecutionId: matching(needs["migrate-backup"].outputs?.job_execution_id, EXECUTION, "Backup execution"),
    smokeExecutionId: matching(needs["target-smoke"].outputs?.job_execution_id, EXECUTION, "Smoke execution"),
    rolloutMode: "disabled",
    hourlyTriggerType: "Manual",
    dailyTriggerType: "Manual",
  };
}

function validateWorkflowRun(run, { repository, stage, releaseSha }) {
  object(run, "Workflow run");
  assert.equal(stage, "release", "Only disabled-release receipts are implemented.");
  integer(run.id, "Run ID");
  integer(run.run_attempt, "Run attempt");
  integer(run.repository?.id, "Repository ID");
  assert.equal(run.repository?.full_name?.toLowerCase(), repository.toLowerCase(), "Wrong run repository.");
  assert.equal(run.head_repository?.id, run.repository.id, "Fork evidence is not production evidence.");
  assert.equal(run.head_branch, "main", "Production evidence must originate on main.");
  matching(run.head_sha, SHA, "Workflow SHA");
  if (releaseSha !== undefined) matching(releaseSha, SHA, "Expected release SHA");
  assert.equal(run.path, `.github/workflows/${RELEASE_WORKFLOW}`, "Wrong production workflow.");
  assert.equal(run.event, "workflow_dispatch", "Wrong production event.");
  return run;
}

function validateReceipt(receipt, run, expected) {
  validateWorkflowRun(run, expected);
  object(receipt, "Production receipt");
  for (const [field, value] of Object.entries({
    schemaVersion: 1, stage: expected.stage, repository: expected.repository,
    repositoryId: run.repository.id, runId: run.id, runAttempt: run.run_attempt,
    workflowSha: run.head_sha,
  })) assert.equal(receipt[field], value, `Production receipt ${field} does not match its run.`);
  matching(receipt.releaseSha, SHA, "Receipt release SHA");
  if (expected.releaseSha !== undefined) {
    assert.equal(receipt.releaseSha, expected.releaseSha, "Production evidence is for another release.");
  }
  assert.equal(run.status, "completed", "Production evidence is not terminal.");
  const generatedAt = Date.parse(receipt.generatedAt);
  const startedAt = Date.parse(run.run_started_at);
  const updatedAt = Date.parse(run.updated_at);
  assert(Number.isFinite(generatedAt) && Number.isFinite(startedAt) && Number.isFinite(updatedAt) &&
    generatedAt >= startedAt && generatedAt <= updatedAt + 120_000,
  "Production evidence is outside its actual workflow attempt.");
  assert(["disabled", "deferred", "failed"].includes(receipt.status), "Unknown production outcome.");
  if (receipt.status === "failed") return receipt;
  assert.equal(run.conclusion, "success", "A failed workflow cannot authorize production progress.");
  if (receipt.status === "deferred") {
    assert.equal(receipt.binding, null, "Deferral cannot claim a deployed binding.");
    assert.equal(receipt.results?.gate, "success", "Deferral needs successful source admission.");
    assert.equal(receipt.results?.["force-disable-rollout"], "success", "Deferral needs successful admission.");
    assert(POST_ADMISSION_JOBS.every((name) => receipt.results?.[name] === "skipped"),
      "A deferred release must not have crossed its mutation boundary.");
    return receipt;
  }
  validateBinding(receipt.binding);
  assert.equal(receipt.binding.releaseSha, receipt.releaseSha, "Inconsistent release binding.");
  assert(RELEASE_JOBS.every((name) => receipt.results?.[name] === "success"),
    "The disabled release is missing a required successful stage.");
  assert.equal(receipt.rolloutMode, "disabled");
  assert.equal(receipt.hourlyTriggerType, "Manual");
  assert.equal(receipt.dailyTriggerType, "Manual");
  matching(receipt.backupExecutionId, EXECUTION, "Backup execution");
  matching(receipt.smokeExecutionId, EXECUTION, "Smoke execution");
  return receipt;
}

async function loadProductionReceipt({ github, owner, repo, run, stage, releaseSha }) {
  const expected = { repository: `${owner}/${repo}`, stage, releaseSha };
  validateWorkflowRun(run, expected);
  matching(releaseSha, SHA, "Expected release SHA");
  const receipt = await loadRunArchive({
    github, owner, repo, run,
    name: receiptName(stage, releaseSha, run.id, run.run_attempt),
  });
  return validateReceipt(receipt, run, expected);
}

module.exports = {
  RELEASE_WORKFLOW, RELEASE_JOBS,
  receiptName, validateBinding, baseReceipt, createReleaseReceipt,
  validateWorkflowRun, validateReceipt, loadProductionReceipt, productionVerificationOverrides,
};

if (require.main === module) {
  try {
    assert.equal(process.argv[2], "verification-overrides", "Unknown production evidence command.");
    assert.equal(process.argv.length, 4, "A single production configuration file is required.");
    const input = readFileSync(process.argv[3], "utf8");
    assert(input.length <= 8192, "Production configuration exceeds its bounded size.");
    let config;
    try {
      config = JSON.parse(input);
    } catch {
      throw new Error("Production configuration is not valid JSON.");
    }
    process.stdout.write(JSON.stringify(productionVerificationOverrides(config)));
  } catch (error) {
    process.stderr.write(`Production evidence rejected: ${error.message}\n`);
    process.exitCode = 1;
  }
}
