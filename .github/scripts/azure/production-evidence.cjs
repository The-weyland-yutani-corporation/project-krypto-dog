"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { loadRunArchive } = require("../agentic-receipt.cjs");
const { validateProductionReport } = require("./lib/production-report.cjs");

const RELEASE_WORKFLOW = "azure-deploy-prod.yml";
const DEVELOPMENT_WORKFLOW = "azure-deploy-dev.yml";
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const EXECUTION = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const DEVELOPMENT_JOBS = Object.freeze({
  gate: "Determine and validate the commit to deploy",
  "deploy-environment": "Deploy infra/environment.bicep (dev)",
  "build-images": "Build web/ops images and resolve digests (dev)",
  "deploy-release": "Deploy infra/release.bicep (dev, disabled/manual)",
  "ops-validate": "Run migrate-init / preflight / target-smoke while disabled (dev)",
  "stage-shadow": "Stage dev shadow with scheduler jobs still Manual",
  "validate-shadow": "Validate shadow and exactly one manual hourly execution",
  "promote-schedule": "Promote validated dev shadow jobs to Schedule",
  "observe-scheduled-execution": "Observe a successful dev hourly scheduled execution",
  "verify-final-state": "Verify live dev shadow/Schedule and exact SHA/digests",
});
const DEVELOPMENT_PUBLISHER = "Publish exact-SHA dev deployment evidence";
const DEVELOPMENT_RECEIPT_PUBLISHER = "Publish immutable dev release receipt";
const DEVELOPMENT_ROLLBACK = "Roll back dev to disabled/Manual after promotion failure";
const RELEASE_JOBS = Object.freeze([
  "gate", "force-disable-rollout", "deploy-environment", "build-images",
  "deploy-release", "migrate-backup", "release-cutover-fence",
  "target-smoke", "verify-final-state",
]);
const POST_ADMISSION_JOBS = RELEASE_JOBS.slice(2);
const PRODUCTION_STATUS_CONTEXT = "Production deployment evidence";
const PRODUCTION_ENVIRONMENT = "production";
const PRODUCTION_JOB_NAMES = Object.freeze({
  gate: "Determine and validate the commit to deploy",
  "force-disable-rollout": "Admit current release before any disabled/Manual cutover",
  "backup-current-release": "Preflight + verified-backup current release before environment.bicep",
  "deploy-environment": "Deploy infra/environment.bicep (prod, after current-release safety)",
  "build-images": "Build web/ops images and resolve digests (prod)",
  "deploy-release": "Deploy infra/release.bicep (prod, disabled/Manual)",
  "migrate-backup": "Migrate and restore-verify the candidate while its fence is held",
  "release-cutover-fence": "Persist the quiescent cutover release checkpoint",
  "target-smoke": "Verify and approve the released disabled candidate",
  "verify-final-state": "Verify live prod disabled/Manual, no schedule, and exact SHA/digests",
  "publish-release-receipt": "Publish an immutable full-release or deferral receipt",
  "prepare-paper": "Prepare a fresh zero-fill production shadow proof",
  "promote-paper": "Activate paper and verify the actual scheduled PAPER run",
  "publish-promotion-receipt": "Publish immutable paper-production evidence",
  "publish-production-delivery": "Publish exact-SHA paper-production delivery",
  "recover-paper": "Recover production to verified disabled/Manual",
  "release-recovered-fence": "Release the recovered source or candidate fence with fresh proof",
  "publish-production-failure": "Publish a durable production failure",
});
const PROMOTION_MODES = Object.freeze(["disabled", "operator", "continuous"]);

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
  assert(["release", "development", "promotion"].includes(stage), "Unknown deployment receipt stage.");
  matching(sha, SHA, "Release SHA");
  integer(runId, "Run ID");
  integer(attempt, "Run attempt");
  const prefix = stage === "development" ? "development-release" :
    stage === "promotion" ? "production-promotion" : "production-release";
  return `${prefix}-${sha}-${runId}-${attempt}`;
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

function resolveProductionInvocation(env, event) {
  object(env, "Production environment");
  object(event, "Production event");
  const repository = matching(env.GITHUB_REPOSITORY, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "Repository");
  assert.equal(env.GITHUB_REF, "refs/heads/main", "Production requires protected main.");
  assert.equal(env.GITHUB_WORKFLOW_REF,
    `${repository}/.github/workflows/${RELEASE_WORKFLOW}@refs/heads/main`, "Wrong production workflow source.");
  let sha;
  let deploymentStage;
  let promotionMode;
  const triggeringDevelopment = {};
  if (env.GITHUB_EVENT_NAME === "workflow_dispatch") {
    sha = matching(env.INPUT_COMMIT_SHA, SHA, "Manual release SHA");
    deploymentStage = env.INPUT_DEPLOYMENT_STAGE;
    assert(["foundation", "full"].includes(deploymentStage), "Production stage must be foundation or full.");
    promotionMode = env.INPUT_PROMOTION_MODE || "disabled";
    assert(PROMOTION_MODES.includes(promotionMode), "Unknown production promotion mode.");
    assert(deploymentStage === "full" || promotionMode === "disabled",
      "Foundation commissioning cannot activate paper.");
  } else {
    assert.equal(env.GITHUB_EVENT_NAME, "workflow_run", "Unsupported production trigger.");
    assert.equal(event.action, "completed", "Development completion is required.");
    const run = object(event.workflow_run, "Triggering development run");
    assert.equal(run.status, "completed", "Development is not terminal.");
    assert.equal(run.conclusion, "success", "Development did not succeed.");
    assert.equal(run.head_branch, "main", "Development must originate on main.");
    sha = matching(run.head_sha, SHA, "Development source SHA");
    triggeringDevelopment.development_run_id = integer(run.id, "Triggering development run ID");
    triggeringDevelopment.development_run_attempt = integer(run.run_attempt, "Triggering development attempt");
    deploymentStage = "full";
    promotionMode = "continuous";
  }
  assert.equal(sha, matching(env.GITHUB_SHA, SHA, "Workflow SHA"), "Production must deploy its exact workflow source.");
  assert.equal(sha, matching(env.GITHUB_WORKFLOW_SHA, SHA, "Workflow definition SHA"),
    "Production must execute its exact release source.");
  return { sha, deployment_stage: deploymentStage, promotion_mode: promotionMode, ...triggeringDevelopment };
}

async function assertProductionFactoryMode({ github, core, owner, repo, eventName, promotionMode = "disabled" }) {
  assert(["workflow_dispatch", "workflow_run"].includes(eventName), "Unsupported production trigger.");
  assert(PROMOTION_MODES.includes(promotionMode), "Unknown production promotion mode.");
  if (eventName === "workflow_dispatch" && promotionMode !== "continuous") return;
  const { resolveHumanAttestedFactoryMode } = require("../agentic-automerge-sweeper.cjs");
  assert.equal(await resolveHumanAttestedFactoryMode({ github, core, owner, repo }), "active",
    "Automatic production admission requires a human-activated factory; paused, shadow or unreadable control blocks it.");
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
    } : {}),
  };
  assert.deepEqual(Object.keys(config).sort(), Object.keys(fields).sort(),
    "Production configuration must contain exactly its phase's nonsecret fields.");
  matching(config.authorizationId, /^[0-9a-f]{64}$/, "Readiness authorization digest");
  integer(config.scheduleGeneration, "Schedule generation");
  assert(config.scheduleGeneration <= Math.floor(Date.now() / 1000), "Schedule generation is in the future.");
  const dateFields = config.phase === "ready" ? ["approvalCreatedAfter", "shadowStartedAfter"] : [];
  for (const field of dateFields) {
    matching(config[field], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/, field);
    assert.equal(new Date(config[field]).toISOString().replace(".000Z", "Z"),
      config[field].replace(".000Z", "Z"), "Invalid production timestamp.");
  }
  if (config.phase === "ready") {
    matching(config.approvalId, /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/, "Approval ID");
    matching(config.shadowIdempotencyKey, /^manual-shadow:[A-Za-z0-9_.-]{1,64}$/, "Shadow key");
    matching(config.shadowStartedAfter, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, "Shadow start boundary");
  }
  return [
    { name: "OPERATION", value: "production-verification" },
    ...Object.entries(fields).map(([key, name]) => ({ name, value: String(config[key]) })),
  ];
}

function baseReceipt(env, stage) {
  assert(["release", "development", "promotion"].includes(stage), "Unknown deployment receipt stage.");
  matching(env.GITHUB_REPOSITORY, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "Repository");
  assert.equal(env.GITHUB_REF, "refs/heads/main", "Deployment evidence requires protected main.");
  for (const key of ["GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_REPOSITORY_ID"]) {
    matching(env[key], /^[1-9][0-9]*$/, key);
  }
  return {
    schemaVersion: stage === "release" ? 2 : 1,
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

function timestamp(value, name) {
  matching(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|\+00:00)$/, name);
  const fraction = /\.(\d+)/.exec(value)?.[1] ?? "";
  const canonical = `${value.slice(0, 19)}.${fraction.slice(0, 3).padEnd(3, "0")}Z`;
  assert.equal(new Date(value).toISOString(), canonical, `${name} is not a valid UTC timestamp.`);
  return canonical;
}

function validateDevelopmentExecution(receipt) {
  const execution = object(receipt.scheduledExecution, "Development execution");
  const manual = object(receipt.manualShadow, "Development manual shadow");
  matching(execution.name, EXECUTION, "Development execution name");
  matching(manual.executionName, EXECUTION, "Manual shadow execution name");
  assert.notEqual(execution.name, manual.executionName, "Manual shadow is not scheduled-window evidence.");
  assert.equal(manual.idempotencyKey,
    `manual-shadow:run${receipt.runId}-a${receipt.runAttempt}-manual-hourly`, "Wrong manual shadow invocation.");
  assert.equal(execution.originAssurance, "schedule-observed-not-origin-proven", "Trigger origin is not proven.");
  assert.equal(execution.status, "Succeeded", "The development execution did not succeed.");
  for (const [value, name] of [
    [execution.startedAt, "Execution start"], [execution.completedAt, "Execution completion"],
    [execution.scheduleEnabledAt, "Schedule enablement"], [manual.startedAfter, "Manual shadow boundary"],
  ]) assert.equal(value, timestamp(value, name), `${name} must be canonical UTC.`);
  const enabledAt = Date.parse(execution.scheduleEnabledAt);
  const firstWindow = (Math.floor(enabledAt / 3_600_000) + 1) * 3_600_000;
  const startedAt = Date.parse(execution.startedAt);
  const completedAt = Date.parse(execution.completedAt);
  assert(Date.parse(manual.startedAfter) <= enabledAt &&
    enabledAt < startedAt && startedAt >= firstWindow && startedAt <= firstWindow + 900_000 &&
    completedAt >= startedAt && completedAt <= Date.parse(receipt.generatedAt),
  "Development execution does not belong to the verified first schedule window.");
  assert.equal(receipt.rolloutMode, "shadow");
  assert.equal(receipt.hourlyTriggerType, "Schedule");
  assert.equal(receipt.dailyTriggerType, "Schedule");
}

function createDevelopmentReceipt(env, needs, run) {
  object(needs, "Development job results");
  const receipt = baseReceipt(env, "development");
  validateWorkflowRun(run, {
    repository: receipt.repository, repositoryId: receipt.repositoryId,
    stage: "development", releaseSha: receipt.releaseSha,
  });
  assert.equal(run.id, receipt.runId, "Wrong producer run.");
  assert.equal(run.run_attempt, receipt.runAttempt, "Wrong producer attempt.");
  assert.equal(env.GITHUB_WORKFLOW_SHA, receipt.releaseSha, "Development must execute its exact release source.");
  assert.equal(receipt.workflowSha, receipt.releaseSha, "Development must deploy its exact workflow source.");
  assert.equal(env.GITHUB_WORKFLOW_REF,
    `${receipt.repository}/.github/workflows/${DEVELOPMENT_WORKFLOW}@refs/heads/main`, "Wrong producer workflow.");
  assert.equal(env.GITHUB_EVENT_NAME, run.event, "Wrong producer event.");
  assert.equal(env.GITHUB_ACTOR_ID, String(run.actor.id), "Wrong producer actor.");
  assert.equal(env.GITHUB_TRIGGERING_ACTOR, run.triggering_actor.login, "Wrong rerun actor.");
  const gate = object(needs.gate, "Development gate");
  assert.equal(gate.result, "success", "The development gate did not pass.");
  assert.equal(gate.outputs?.sha, receipt.releaseSha, "Development authorized another release.");
  assert.equal(gate.outputs?.deployment_stage, "full", "A foundation is not development release evidence.");
  const results = {};
  for (const name of Object.keys(DEVELOPMENT_JOBS)) {
    const result = object(needs[name], `${name} result`).result;
    assert(["success", "failure", "cancelled", "skipped"].includes(result), `Unknown result for ${name}.`);
    results[name] = result;
  }
  const verified = Object.keys(DEVELOPMENT_JOBS).every((name) => results[name] === "success");
  const result = {
    ...receipt, workflowId: run.workflow_id,
    actorId: run.actor.id, triggeringActorId: run.triggering_actor.id,
    status: verified ? "shadow" : "failed", results,
    binding: null, manualShadow: null, scheduledExecution: null,
  };
  if (!verified) return result;
  const environment = object(needs["deploy-environment"].outputs, "Development foundation outputs");
  const images = object(needs["build-images"].outputs, "Development image outputs");
  const final = object(needs["verify-final-state"].outputs, "Development final readback");
  const shadow = object(needs["validate-shadow"].outputs, "Development shadow evidence");
  const enablement = matching(needs["promote-schedule"].outputs?.schedule_deployed_at,
    /^[1-9][0-9]*$/, "Development schedule enablement");
  const enabledAt = integer(Number(enablement), "Development schedule enablement") * 1000;
  assert(Number.isSafeInteger(enabledAt), "Development schedule enablement exceeds the timestamp range.");
  result.binding = validateBinding({
    releaseSha: receipt.releaseSha,
    webImageDigest: `sha256:${images.web_digest_hex}`,
    opsImageDigest: `sha256:${images.ops_digest_hex}`,
    registryLoginServer: environment.acr_login_server,
    targetOrigin: final.target_origin,
    evidenceContainerUrl: environment.evidence_container_url,
  });
  result.manualShadow = {
    executionName: shadow.manual_hourly_execution_name,
    idempotencyKey: shadow.manual_shadow_idempotency_key,
    startedAfter: timestamp(shadow.manual_shadow_started_after, "Manual shadow boundary"),
  };
  assert.equal(final.scheduled_execution_name, needs["observe-scheduled-execution"].outputs?.scheduled_execution_name,
    "The final readback observed another execution.");
  result.scheduledExecution = {
    name: final.scheduled_execution_name,
    status: "Succeeded",
    startedAt: timestamp(final.scheduled_execution_start_time, "Execution start"),
    completedAt: timestamp(final.scheduled_execution_completed_time, "Execution completion"),
    scheduleEnabledAt: new Date(enabledAt).toISOString(),
    originAssurance: "schedule-observed-not-origin-proven",
  };
  result.rolloutMode = "shadow";
  result.hourlyTriggerType = "Schedule";
  result.dailyTriggerType = "Schedule";
  validateDevelopmentExecution(result);
  return result;
}

function createReleaseReceipt(env, needs) {
  object(needs, "Job results");
  const receipt = baseReceipt(env, "release");
  const gate = object(needs.gate, "Gate");
  assert.equal(gate.result, "success", "The release gate did not pass.");
  assert.equal(gate.outputs?.sha, receipt.releaseSha, "The gate authorized a different SHA.");
  assert.equal(gate.outputs?.deployment_stage, "full", "A foundation is not a release.");
  assert.equal(receipt.workflowSha, receipt.releaseSha, "Production must deploy its exact workflow source.");
  receipt.development = {};
  for (const [field, output] of Object.entries({
    runId: "development_run_id", runAttempt: "development_run_attempt", workflowId: "development_workflow_id",
  })) {
    receipt.development[field] = integer(Number(matching(gate.outputs?.[output], /^[1-9][0-9]*$/, output)), output);
  }
  assert.notEqual(receipt.development.runId, receipt.runId, "Production cannot be its own development admission.");
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

function validateWorkflowRun(run, { repository, repositoryId, stage, releaseSha }) {
  object(run, "Workflow run");
  assert(["release", "development", "promotion"].includes(stage), "Unknown deployment receipt stage.");
  integer(run.id, "Run ID");
  integer(run.run_attempt, "Run attempt");
  integer(run.repository?.id, "Repository ID");
  assert.equal(run.repository?.full_name?.toLowerCase(), repository.toLowerCase(), "Wrong run repository.");
  assert.equal(run.head_repository?.id, run.repository.id, "Fork evidence is not production evidence.");
  assert.equal(run.head_branch, "main", "Production evidence must originate on main.");
  matching(run.head_sha, SHA, "Workflow SHA");
  if (releaseSha !== undefined) matching(releaseSha, SHA, "Expected release SHA");
  const workflow = stage === "development" ? DEVELOPMENT_WORKFLOW : RELEASE_WORKFLOW;
  assert.equal(run.path, `.github/workflows/${workflow}`, "Wrong deployment workflow.");
  if (stage !== "release") {
    assert.equal(run.repository.id, integer(repositoryId, "Expected repository ID"), "Wrong immutable repository.");
    assert.equal(run.head_sha, matching(releaseSha, SHA, "Expected release SHA"), "Wrong development source.");
    assert(["workflow_run", "workflow_dispatch"].includes(run.event), "Wrong development event.");
    integer(run.workflow_id, "Development workflow ID");
    integer(run.actor?.id, "Development actor ID");
    integer(run.triggering_actor?.id, "Development rerun actor ID");
    matching(run.triggering_actor?.login, /^[A-Za-z0-9_.-]+(?:\[bot\])?$/, "Development rerun actor");
  } else {
    assert(["workflow_dispatch", "workflow_run"].includes(run.event), "Wrong production event.");
  }
  return run;
}

function validateReceipt(receipt, run, expected) {
  if (expected.stage === "promotion") return validatePromotionReceipt(receipt, run, expected);
  validateWorkflowRun(run, expected);
  object(receipt, "Production receipt");
  for (const [field, value] of Object.entries({
    schemaVersion: expected.stage === "development" ? 1 : 2,
    stage: expected.stage, repository: expected.repository,
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
  if (expected.stage === "development") {
    for (const [field, value] of Object.entries({
      workflowId: run.workflow_id, actorId: run.actor.id, triggeringActorId: run.triggering_actor.id,
      releaseSha: run.head_sha,
    })) assert.equal(receipt[field], value, `Development receipt ${field} does not match its run.`);
    assert(["shadow", "failed"].includes(receipt.status), "Unknown development outcome.");
    if (receipt.status === "failed") return receipt;
    assert.equal(run.conclusion, "success", "A failed workflow cannot authorize production progress.");
    assert(Object.keys(DEVELOPMENT_JOBS).every((name) => receipt.results?.[name] === "success"),
      "Development is missing a successful required stage.");
    validateBinding(receipt.binding);
    assert.equal(receipt.binding.releaseSha, receipt.releaseSha, "Inconsistent development source binding.");
    validateDevelopmentExecution(receipt);
    assert(Date.parse(receipt.manualShadow.startedAfter) >= startedAt,
      "Development shadow belongs to an earlier workflow attempt.");
    return receipt;
  }
  assert.equal(receipt.releaseSha, run.head_sha, "Production evidence must use its exact workflow source.");
  object(receipt.development, "Development admission");
  for (const field of ["runId", "runAttempt", "workflowId"]) integer(receipt.development[field], `Development ${field}`);
  assert.notEqual(receipt.development.runId, receipt.runId, "Production cannot be its own development admission.");
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

async function assertCurrentMain({ github, owner, repo, releaseSha }) {
  matching(releaseSha, SHA, "Expected main SHA");
  const response = await github.rest.git.getRef({ owner, repo, ref: "heads/main" });
  assert.equal(response.data.object?.sha, releaseSha, "The release was superseded on main.");
}

async function latestNativeRunId({ github, owner, repo, workflowId, releaseSha }) {
  const { data } = await github.rest.actions.listWorkflowRuns({
    owner, repo, workflow_id: workflowId, head_sha: releaseSha, per_page: 100,
  });
  assert(Array.isArray(data.workflow_runs) && Number.isSafeInteger(data.total_count) &&
    data.total_count >= 0 && data.total_count <= 100 && data.workflow_runs.length === data.total_count,
  "A complete bounded inventory of deployment runs is required.");
  const ids = data.workflow_runs.map((entry) => {
    assert.equal(entry.head_sha, releaseSha, "Unrelated source in deployment inventory.");
    return integer(entry.id, "Deployment run ID");
  });
  assert.equal(new Set(ids).size, ids.length, "Deployment inventory is ambiguous.");
  return ids.length ? Math.max(...ids) : null;
}

async function verifyNativeJobs({ github, owner, repo, run, conclusions, exact = false }) {
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRunAttempt, {
    owner, repo, run_id: run.id, attempt_number: run.run_attempt, per_page: 100,
  });
  assert(Array.isArray(jobs) && jobs.length <= 100, "Deployment job inventory is missing or unbounded.");
  if (exact) assert.equal(jobs.length, Object.keys(conclusions).length, "Unexpected native production jobs.");
  const matched = {};
  for (const [name, conclusion] of Object.entries(conclusions)) {
    const entries = jobs.filter((job) => job.name === name);
    assert(entries.length === 1 && entries[0].status === "completed" && entries[0].conclusion === conclusion,
      `The actual ${run.path === `.github/workflows/${DEVELOPMENT_WORKFLOW}` ? "development" : "production"} attempt is missing its required result: ${name}.`);
    matched[name] = entries[0];
  }
  return matched;
}

async function assertUnchangedNativeRun({ github, owner, repo, run, expected }) {
  const { data: fresh } = await github.rest.actions.getWorkflowRun({ owner, repo, run_id: run.id });
  validateWorkflowRun(fresh, expected);
  for (const field of ["id", "run_attempt", "workflow_id", "status", "conclusion", "updated_at"]) {
    assert.equal(fresh[field], run[field], "Deployment changed during evidence verification.");
  }
  assert.equal(fresh.actor?.id, run.actor?.id, "Deployment actor changed during verification.");
  assert.equal(fresh.triggering_actor?.id, run.triggering_actor?.id, "Deployment rerun actor changed during verification.");
}

async function verifyDevelopmentRunReceipt({ github, owner, repo, repositoryId, releaseSha, run }) {
  const expected = { repository: `${owner}/${repo}`, repositoryId, stage: "development", releaseSha };
  validateWorkflowRun(run, expected);
  assert.equal(run.status, "completed", "The latest development run is not terminal.");
  assert.equal(run.conclusion, "success", "The latest development run did not succeed.");
  const receipt = validateReceipt(await loadRunArchive({
    github, owner, repo, run, name: receiptName("development", releaseSha, run.id, run.run_attempt),
  }), run, expected);
  assert.equal(receipt.status, "shadow", "A green development wrapper is not a verified deployment.");
  await verifyNativeJobs({
    github, owner, repo, run, conclusions: Object.fromEntries([
      ...Object.values(DEVELOPMENT_JOBS), DEVELOPMENT_RECEIPT_PUBLISHER, DEVELOPMENT_PUBLISHER, DEVELOPMENT_ROLLBACK,
    ].map((name) => [name, name === DEVELOPMENT_ROLLBACK ? "skipped" : "success"])),
  });
  await assertUnchangedNativeRun({ github, owner, repo, run, expected });
  return receipt;
}

async function loadExactDevelopmentReceipt({ github, owner, repo, repositoryId, releaseSha, reference }) {
  object(reference, "Development admission reference");
  for (const field of ["runId", "runAttempt", "workflowId"]) integer(reference[field], `Development ${field}`);
  const { data: workflow } = await github.rest.actions.getWorkflow({
    owner, repo, workflow_id: DEVELOPMENT_WORKFLOW,
  });
  assert.equal(workflow.path, `.github/workflows/${DEVELOPMENT_WORKFLOW}`);
  assert.equal(integer(workflow.id, "Development workflow ID"), reference.workflowId);
  const { data: run } = await github.rest.actions.getWorkflowRun({ owner, repo, run_id: reference.runId });
  assert.equal(run.id, reference.runId);
  assert.equal(run.workflow_id, reference.workflowId);
  assert.equal(run.run_attempt, reference.runAttempt, "The admitted development attempt was superseded.");
  return verifyDevelopmentRunReceipt({ github, owner, repo, repositoryId, releaseSha, run });
}

async function loadLatestDevelopmentReceipt({
  github, owner, repo, repositoryId, releaseSha, expectedRunId, expectedRunAttempt,
}) {
  integer(repositoryId, "Expected repository ID");
  if (expectedRunId !== undefined) integer(expectedRunId, "Expected development run ID");
  if (expectedRunAttempt !== undefined) integer(expectedRunAttempt, "Expected development run attempt");
  assert.equal(expectedRunId === undefined, expectedRunAttempt === undefined,
    "Development revalidation requires both the original run and attempt.");
  const context = { github, owner, repo, releaseSha };
  await assertCurrentMain(context);
  const { data: workflow } = await github.rest.actions.getWorkflow({
    owner, repo, workflow_id: DEVELOPMENT_WORKFLOW,
  });
  integer(workflow.id, "Trusted development workflow ID");
  assert.equal(workflow.path, `.github/workflows/${DEVELOPMENT_WORKFLOW}`, "Wrong development workflow definition.");
  const latestRunId = () => latestNativeRunId({ ...context, workflowId: workflow.id });
  const runId = await latestRunId();
  integer(runId, "Latest development run ID");
  if (expectedRunId !== undefined) assert.equal(runId, expectedRunId, "The admitted development run was superseded.");
  const { data: run } = await github.rest.actions.getWorkflowRun({ owner, repo, run_id: runId });
  const expected = { repository: `${owner}/${repo}`, repositoryId, stage: "development", releaseSha };
  validateWorkflowRun(run, expected);
  assert.equal(run.id, runId, "Wrong development run.");
  assert.equal(run.workflow_id, workflow.id, "Wrong immutable development workflow.");
  if (expectedRunAttempt !== undefined) {
    assert.equal(run.run_attempt, expectedRunAttempt, "The admitted development attempt was superseded.");
  }
  const receipt = await verifyDevelopmentRunReceipt({ ...context, repositoryId, run });
  assert.equal(await latestRunId(), run.id, "A newer development run superseded the evidence.");
  await assertCurrentMain(context);
  return receipt;
}

function promotionReference(receipt) {
  assert.equal(receipt.stage, "promotion", "A paper-production receipt is required.");
  assert.equal(receipt.status, "paper", "Only verified paper delivery can authorize continuation.");
  return {
    schemaVersion: 1, kind: "production-promotion",
    repositoryId: receipt.repositoryId, releaseSha: receipt.releaseSha,
    runId: receipt.runId, runAttempt: receipt.runAttempt, workflowId: receipt.workflowId,
    scheduleGeneration: receipt.evidence.scheduleGeneration,
    authorizationId: receipt.evidence.authorizationId,
  };
}

function validatePromotionReference(reference) {
  object(reference, "Production reference");
  assert.deepEqual(Object.keys(reference).sort(), [
    "schemaVersion", "kind", "repositoryId", "releaseSha", "runId", "runAttempt",
    "workflowId", "scheduleGeneration", "authorizationId",
  ].sort(), "Production reference must use its closed nonsecret shape.");
  assert.equal(reference.schemaVersion, 1);
  assert.equal(reference.kind, "production-promotion");
  for (const field of ["repositoryId", "runId", "runAttempt", "workflowId", "scheduleGeneration"]) {
    integer(reference[field], `Production reference ${field}`);
  }
  matching(reference.releaseSha, SHA, "Previous production source");
  matching(reference.authorizationId, /^[0-9a-f]{64}$/, "Previous production authorization");
  return reference;
}

async function assertPromotionActor({ github, owner, repo, env, mode }) {
  assert(PROMOTION_MODES.includes(mode), "Unknown production promotion mode.");
  const { data: run } = await github.rest.actions.getWorkflowRun({
    owner, repo, run_id: integer(Number(env.GITHUB_RUN_ID), "Producer run ID"),
  });
  validateWorkflowRun(run, {
    repository: `${owner}/${repo}`, repositoryId: Number(env.GITHUB_REPOSITORY_ID),
    releaseSha: env.RESOLVED_SHA, stage: "promotion",
  });
  assert.equal(run.run_attempt, Number(env.GITHUB_RUN_ATTEMPT), "Wrong producer attempt.");
  assert.equal(run.status, "in_progress", "Promotion must belong to the current running workflow.");
  assert(Number.isFinite(Date.parse(run.run_started_at)), "The native production start time is missing.");
  assert.equal(env.GITHUB_WORKFLOW_SHA, run.head_sha, "Wrong producer workflow source.");
  assert.equal(env.GITHUB_WORKFLOW_REF,
    `${owner}/${repo}/.github/workflows/${RELEASE_WORKFLOW}@refs/heads/main`, "Wrong producer workflow ref.");
  assert.equal(env.GITHUB_ACTOR_ID, String(run.actor.id), "Wrong producer actor.");
  assert.equal(env.GITHUB_TRIGGERING_ACTOR, run.triggering_actor.login, "Wrong producer rerun actor.");
  assert.equal(env.GITHUB_EVENT_NAME, run.event, "Wrong producer event.");
  if (mode === "operator") {
    assert.equal(run.event, "workflow_dispatch", "First activation requires explicit operator dispatch.");
    for (const actor of [run.actor, run.triggering_actor]) {
      assert.equal(actor.type, "User", "A bot cannot authorize first paper activation or recovery.");
      const { data } = await github.rest.repos.getCollaboratorPermissionLevel({
        owner, repo, username: actor.login,
      });
      assert(["admin", "maintain", "write"].includes(data.permission),
        "Paper activation requires an authenticated repository operator with write permission.");
    }
  }
  return run;
}

function productionAuthorization({ env, binding, authority, scheduleGeneration }) {
  validateBinding(binding);
  matching(env.GITHUB_REPOSITORY, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "Production repository");
  for (const key of ["GITHUB_REPOSITORY_ID", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"]) {
    integer(Number(matching(env[key], /^[1-9][0-9]*$/, key)), key);
  }
  object(authority, "Production authority");
  assert.deepEqual(Object.keys(authority).sort(), ["mode", "actorId", "triggeringActorId", "previous"].sort(),
    "Production authority must use its closed nonsecret shape.");
  integer(authority.actorId, "Production actor");
  integer(authority.triggeringActorId, "Production rerun actor");
  integer(scheduleGeneration, "Schedule generation");
  assert(scheduleGeneration <= Math.floor(Date.now() / 1000), "Schedule generation is in the future.");
  assert(["operator", "continuous"].includes(authority.mode), "Paper authority is missing.");
  if (authority.mode === "continuous") {
    validatePromotionReference(authority.previous);
    assert.equal(authority.previous.repositoryId, Number(env.GITHUB_REPOSITORY_ID), "Continuation belongs to another repository.");
    assert(authority.previous.runId < Number(env.GITHUB_RUN_ID), "Continuation requires an earlier production run.");
  }
  else assert.equal(authority.previous, null, "Operator activation must not impersonate receipt continuation.");
  return createHash("sha256").update(JSON.stringify([
    "production-paper-v1", env.GITHUB_REPOSITORY, Number(env.GITHUB_REPOSITORY_ID),
    Number(env.GITHUB_RUN_ID), Number(env.GITHUB_RUN_ATTEMPT),
    binding.releaseSha, binding.webImageDigest, binding.opsImageDigest,
    binding.registryLoginServer, binding.targetOrigin, binding.evidenceContainerUrl,
    authority.mode, authority.actorId, authority.triggeringActorId,
    authority.previous === null ? null : [
      authority.previous.repositoryId, authority.previous.releaseSha, authority.previous.runId,
      authority.previous.runAttempt, authority.previous.workflowId, authority.previous.scheduleGeneration,
      authority.previous.authorizationId,
    ],
    scheduleGeneration,
  ])).digest("hex");
}

function productionReportExpectations(binding, evidence, phase) {
  const report = object(evidence[phase], `${phase} production report`);
  const expected = {
    "production-phase": phase, "authorization-id": evidence.authorizationId,
    "target-origin": binding.targetOrigin, "image-digest": binding.webImageDigest,
    "release-sha": binding.releaseSha, "schedule-generation": String(evidence.scheduleGeneration),
    "job-execution-id": report.jobExecutionId, "azure-execution-name": report.azureExecutionName,
  };
  if (phase === "ready") return {
    ...expected, "approval-id": evidence.approvalId,
    "expected-shadow-idempotency-key": evidence.manualShadow.idempotencyKey,
    "expected-shadow-started-after": evidence.manualShadow.startedAfter,
  };
  const execution = object(report.scheduledExecution, "Scheduled execution");
  return {
    ...expected, "workflow-observation-digest": report.workflowObservation?.observationDigest,
    "expected-scheduled-idempotency-key": report.scheduledRun?.idempotencyKey,
    "scheduled-execution-resource-id": execution.id, "scheduled-execution-name": execution.name,
    "scheduled-execution-template-digest": execution.templateDigest,
    "scheduled-execution-started-at": execution.startedAt,
    "scheduled-execution-completed-at": execution.completedAt,
    "schedule-enabled-at": execution.scheduleEnabledAt,
  };
}

function validateHistoricalPromotionEvidence(receipt, run) {
  const evidence = object(receipt.evidence, "Paper-production evidence");
  assert.deepEqual(Object.keys(evidence).sort(), [
    "authorizationId", "scheduleGeneration", "approvalId", "approvalCreatedAfter", "manualShadow", "ready", "scheduled",
  ].sort(), "Paper-production evidence must contain only its closed nonsecret fields.");
  const binding = validateBinding(receipt.release.binding);
  const authority = object(receipt.authority, "Paper-production authority");
  assert(["operator", "continuous"].includes(authority.mode), "Unknown paper authority.");
  assert.equal(authority.actorId, run.actor.id, "Paper authority belongs to another actor.");
  assert.equal(authority.triggeringActorId, run.triggering_actor.id, "Paper authority belongs to another rerun actor.");
  if (authority.mode === "operator") {
    assert.equal(run.event, "workflow_dispatch", "A scheduled workflow cannot authorize first activation.");
    assert.equal(run.actor.type, "User", "First activation was not operator initiated.");
    assert.equal(run.triggering_actor.type, "User", "First activation was not operator rerun.");
  }
  assert.equal(evidence.authorizationId, productionAuthorization({
    env: {
      GITHUB_REPOSITORY: receipt.repository, GITHUB_REPOSITORY_ID: String(receipt.repositoryId),
      GITHUB_RUN_ID: String(receipt.runId), GITHUB_RUN_ATTEMPT: String(receipt.runAttempt),
    },
    binding, authority, scheduleGeneration: evidence.scheduleGeneration,
  }), "Production authority does not bind this exact attempt, release and generation.");
  const start = Date.parse(run.run_started_at);
  const end = Date.parse(receipt.generatedAt);
  const manual = object(evidence.manualShadow, "Production manual shadow");
  matching(manual.executionName, EXECUTION, "Production manual execution");
  assert.equal(manual.idempotencyKey, `manual-shadow:run${run.id}-a${run.run_attempt}-prod-shadow`);
  for (const boundary of [manual.startedAfter, evidence.approvalCreatedAfter]) {
    assert(Number.isFinite(Date.parse(boundary)) && Date.parse(boundary) >= start &&
      Date.parse(boundary) <= end, "Production preparation belongs to another workflow attempt.");
  }
  assert(evidence.scheduleGeneration * 1000 >= start - 1000 &&
    evidence.scheduleGeneration * 1000 <= Date.parse(manual.startedAfter),
  "Production generation is not bound to this preparation.");
  for (const phase of ["ready", "scheduled"]) {
    const report = object(evidence[phase], `${phase} production evidence`);
    const generated = Date.parse(report.generatedAt);
    assert(Number.isFinite(generated) && generated >= start && generated <= end,
      "Production report is outside its native attempt.");
    // Historical audit only. Native job windows are checked by the loader;
    // actuation always uses validateProductionReport with the real current clock.
    validateProductionReport(report, productionReportExpectations(binding, evidence, phase), generated);
    assert.equal(report.jobExecutionId,
      `run${run.id}-a${run.run_attempt}-prod-${phase}`, "Production report belongs to another invocation.");
  }
  assert(Date.parse(evidence.ready.generatedAt) <= Date.parse(evidence.scheduled.scheduledExecution.scheduleEnabledAt),
    "Ready evidence was generated after schedule enablement.");
  assert.notEqual(manual.executionName, evidence.scheduled.scheduledExecution.name,
    "Manual shadow cannot stand in for an actual scheduled execution.");
  assert.equal(evidence.ready.posthog.host, evidence.scheduled.posthog.host, "Production telemetry host changed.");
  assert.equal(evidence.ready.posthog.keyBinding, evidence.scheduled.posthog.keyBinding,
    "Production telemetry identity changed.");
  const observation = evidence.scheduled.workflowObservation;
  for (const [field, expected] of Object.entries({
    repositoryId: String(receipt.repositoryId), repositoryOwnerId: String(receipt.repositoryOwnerId),
    workflowRef: `${receipt.repository}/.github/workflows/${RELEASE_WORKFLOW}@refs/heads/main`,
    workflowSha: receipt.releaseSha, runId: String(run.id), runAttempt: run.run_attempt,
  })) assert.equal(observation[field], expected, `Scheduled observation ${field} changed.`);
}

function createPromotionReceipt(env, needs, run) {
  const base = baseReceipt(env, "promotion");
  validateWorkflowRun(run, {
    repository: base.repository, repositoryId: base.repositoryId,
    stage: "promotion", releaseSha: base.releaseSha,
  });
  assert.equal(run.id, base.runId);
  assert.equal(run.run_attempt, base.runAttempt);
  assert.equal(base.workflowSha, base.releaseSha);
  assert.equal(env.GITHUB_WORKFLOW_SHA, base.releaseSha);
  assert.equal(env.GITHUB_WORKFLOW_REF,
    `${base.repository}/.github/workflows/${RELEASE_WORKFLOW}@refs/heads/main`, "Wrong producer workflow.");
  assert.equal(env.GITHUB_EVENT_NAME, run.event, "Wrong producer event.");
  assert.equal(env.GITHUB_ACTOR_ID, String(run.actor.id), "Wrong producer actor.");
  assert.equal(env.GITHUB_TRIGGERING_ACTOR, run.triggering_actor.login, "Wrong rerun actor.");
  assert.equal(Number(env.GITHUB_REPOSITORY_OWNER_ID), run.repository.owner?.id, "Wrong producer repository owner.");
  const release = object(JSON.parse(needs["publish-release-receipt"].outputs.receipt), "Disabled release receipt");
  const authority = object(JSON.parse(needs["force-disable-rollout"].outputs.promotion_authority), "Promotion authority");
  const results = {};
  for (const id of [...RELEASE_JOBS, "publish-release-receipt", "prepare-paper", "promote-paper"]) {
    const result = needs[id]?.result;
    assert(["success", "failure", "cancelled", "skipped"].includes(result), `Missing promotion predecessor ${id}.`);
    results[id] = result;
  }
  const status = results["publish-release-receipt"] !== "success" ? "failed" : release.status === "disabled" ?
    (authority.mode === "disabled" && results["prepare-paper"] === "skipped" && results["promote-paper"] === "skipped" ?
      "disabled" : results["prepare-paper"] === "success" && results["promote-paper"] === "success" ? "paper" : "failed") :
    release.status === "deferred" ? "deferred" : "failed";
  const receipt = {
    ...base, schemaVersion: 2, workflowId: run.workflow_id,
    repositoryOwnerId: integer(Number(env.GITHUB_REPOSITORY_OWNER_ID), "Repository owner ID"),
    actorId: run.actor.id, triggeringActorId: run.triggering_actor.id,
    status, results, release, authority,
    existingRelease: needs["force-disable-rollout"].outputs.existing_release === "true",
    evidence: status === "paper" ? JSON.parse(needs["promote-paper"].outputs.evidence) : null,
  };
  assert.equal(release.runId, receipt.runId);
  assert.equal(release.runAttempt, receipt.runAttempt);
  assert.equal(release.releaseSha, receipt.releaseSha);
  if (status === "paper") validateHistoricalPromotionEvidence(receipt, run);
  assert(Buffer.byteLength(JSON.stringify(receipt), "utf8") <= 60_000, "Production receipt exceeds its bounded size.");
  return receipt;
}

function validatePromotionReceipt(receipt, run, expected) {
  validateWorkflowRun(run, { ...expected, stage: "promotion" });
  object(receipt, "Promotion receipt");
  assert([1, 2].includes(receipt.schemaVersion), "Unknown promotion receipt schema.");
  for (const [field, value] of Object.entries({
    stage: "promotion", repository: expected.repository,
    repositoryId: run.repository.id, repositoryOwnerId: run.repository.owner?.id,
    runId: run.id, runAttempt: run.run_attempt, workflowId: run.workflow_id,
    actorId: run.actor.id, triggeringActorId: run.triggering_actor.id,
    workflowSha: run.head_sha, releaseSha: run.head_sha,
  })) assert.equal(receipt[field], value, `Promotion receipt ${field} does not match its native run.`);
  integer(receipt.repositoryOwnerId, "Repository owner ID");
  assert.equal(run.status, "completed", "Promotion evidence is not terminal.");
  const start = Date.parse(run.run_started_at);
  const end = Date.parse(run.updated_at);
  const generated = Date.parse(receipt.generatedAt);
  assert(Number.isFinite(start) && Number.isFinite(end) && Number.isFinite(generated) &&
    start <= generated && generated <= end + 120_000, "Promotion receipt is outside its native attempt.");
  assert(["paper", "disabled", "deferred", "failed"].includes(receipt.status), "Unknown paper-production outcome.");
  if (receipt.status === "failed") {
    assert.equal(receipt.evidence, null, "A failed promotion cannot contain a successful paper proof.");
    return receipt;
  }
  assert.equal(run.conclusion, "success", "A failed native workflow cannot authorize paper delivery.");
  validateReceipt(receipt.release, run, { ...expected, stage: "release" });
  assert.equal(receipt.release.status, receipt.status === "deferred" ? "deferred" : "disabled");
  if (receipt.status !== "paper") {
    assert.equal(receipt.evidence, null, "Disabled or deferred releases cannot contain a paper proof.");
    assert.equal(receipt.results?.["prepare-paper"], "skipped");
    assert.equal(receipt.results?.["promote-paper"], "skipped");
    return receipt;
  }
  assert([...RELEASE_JOBS, "publish-release-receipt", "prepare-paper", "promote-paper"]
    .every((id) => receipt.results?.[id] === "success"), "Paper production is missing a required successful predecessor.");
  assert.equal(typeof receipt.existingRelease, "boolean");
  validateHistoricalPromotionEvidence(receipt, run);
  return receipt;
}

function promotionJobEntries(receipt) {
  assert([1, 2].includes(receipt.schemaVersion), "Unknown promotion job inventory.");
  // Schema 1 predates the separate recovery fence-release job.
  return Object.entries(PRODUCTION_JOB_NAMES)
    .filter(([id]) => receipt.schemaVersion !== 1 || id !== "release-recovered-fence");
}

async function loadVerifiedPromotionReceipt({ github, owner, repo, repositoryId, reference }) {
  validatePromotionReference(reference);
  assert.equal(reference.repositoryId, integer(repositoryId, "Expected repository ID"));
  const expected = { repository: `${owner}/${repo}`, repositoryId, stage: "promotion", releaseSha: reference.releaseSha };
  const { data: workflow } = await github.rest.actions.getWorkflow({
    owner, repo, workflow_id: RELEASE_WORKFLOW,
  });
  assert.equal(workflow.path, `.github/workflows/${RELEASE_WORKFLOW}`);
  assert.equal(integer(workflow.id, "Production workflow ID"), reference.workflowId);
  const { data: run } = await github.rest.actions.getWorkflowRun({ owner, repo, run_id: reference.runId });
  validateWorkflowRun(run, expected);
  assert.equal(run.id, reference.runId);
  assert.equal(run.workflow_id, reference.workflowId);
  assert.equal(run.run_attempt, reference.runAttempt, "The referenced production attempt was superseded.");
  assert.equal(run.status, "completed", "Promotion evidence is not terminal.");
  assert.equal(run.conclusion, "success", "A failed native workflow cannot authorize paper delivery.");
  const receipt = validatePromotionReceipt(await loadRunArchive({
    github, owner, repo, run, name: receiptName("promotion", reference.releaseSha, run.id, run.run_attempt),
  }), run, expected);
  assert.deepEqual(promotionReference(receipt), reference, "Production reference does not match its native evidence.");
  const conclusions = Object.fromEntries(promotionJobEntries(receipt).map(([id, name]) => [
    name, ["recover-paper", "release-recovered-fence", "publish-production-failure"].includes(id) ||
      (id === "backup-current-release" && !receipt.existingRelease) ? "skipped" : "success",
  ]));
  const jobs = await verifyNativeJobs({ github, owner, repo, run, conclusions, exact: true });
  for (const [id, values] of [
    ["publish-release-receipt", [receipt.release.generatedAt]],
    ["publish-promotion-receipt", [receipt.generatedAt]],
    ["prepare-paper", [receipt.evidence.approvalCreatedAfter, receipt.evidence.manualShadow.startedAfter]],
    ["promote-paper", [receipt.evidence.ready.generatedAt, receipt.evidence.scheduled.generatedAt]],
  ]) {
    const job = jobs[PRODUCTION_JOB_NAMES[id]];
    const start = Date.parse(job.started_at);
    const end = Date.parse(job.completed_at);
    assert(Number.isFinite(start) && Number.isFinite(end) && start <= end, "Native production job times are invalid.");
    assert(values.every((value) => Number.isFinite(Date.parse(value)) &&
      Date.parse(value) >= start - 1000 && Date.parse(value) <= end + 120_000),
    "Historical production evidence is outside the actual producer job.");
  }
  assert(Date.parse(receipt.release.generatedAt) <= Date.parse(receipt.evidence.approvalCreatedAfter),
    "Promotion preparation predates its disabled-release proof.");
  const development = await loadExactDevelopmentReceipt({
    github, owner, repo, repositoryId, releaseSha: receipt.releaseSha, reference: receipt.release.development,
  });
  assert(Date.parse(development.generatedAt) <= Date.parse(run.run_started_at) + 120_000,
    "Production admission predates its development evidence.");
  await assertUnchangedNativeRun({ github, owner, repo, run, expected });
  return receipt;
}

async function latestProductionDeployment({ github, owner, repo, releaseSha }) {
  const { data: deployments } = await github.rest.repos.listDeployments({
    owner, repo, sha: releaseSha, environment: PRODUCTION_ENVIRONMENT, per_page: 100,
  });
  assert(Array.isArray(deployments) && deployments.length > 0 && deployments.length < 100,
    "An unambiguous bounded production deployment inventory is required.");
  for (const deployment of deployments) {
    integer(deployment.id, "Production deployment ID");
    assert.equal(deployment.sha, releaseSha, "Unrelated production deployment source.");
    assert.equal(deployment.environment, PRODUCTION_ENVIRONMENT, "Wrong deployment environment.");
  }
  assert.equal(new Set(deployments.map((entry) => entry.id)).size, deployments.length, "Duplicate deployment IDs.");
  const deployment = deployments.reduce((latest, entry) => entry.id > latest.id ? entry : latest);
  const { data: statuses } = await github.rest.repos.listDeploymentStatuses({
    owner, repo, deployment_id: deployment.id, per_page: 100,
  });
  assert(Array.isArray(statuses) && statuses.length > 0 && statuses.length < 100, "Production status inventory is missing or unbounded.");
  for (const status of statuses) integer(status.id, "Production deployment status ID");
  assert.equal(new Set(statuses.map((entry) => entry.id)).size, statuses.length, "Duplicate deployment status IDs.");
  const status = statuses.reduce((latest, entry) => entry.id > latest.id ? entry : latest);
  assert.equal(status.state, "success", "The latest production deployment is not successful.");
  const payload = typeof deployment.payload === "string" ? JSON.parse(deployment.payload) : deployment.payload;
  return { deploymentId: deployment.id, statusId: status.id, reference: validatePromotionReference(payload) };
}

async function loadDeployedProductionReceipt({ github, owner, repo, repositoryId, binding, scheduleGeneration }) {
  validateBinding(binding);
  const context = { github, owner, repo, releaseSha: binding.releaseSha };
  const pointer = await latestProductionDeployment(context);
  const receipt = await loadVerifiedPromotionReceipt({ github, owner, repo, repositoryId, reference: pointer.reference });
  assert.deepEqual(receipt.release.binding, binding, "The receipt does not match the actual deployed release.");
  assert.equal(receipt.evidence.scheduleGeneration, scheduleGeneration, "The deployed schedule generation changed.");
  assert.deepEqual(await latestProductionDeployment(context), pointer, "Production delivery changed during admission.");
  return receipt;
}

async function inspectProductionDelivery({ github, owner, repo, repositoryId, releaseSha }) {
  const context = { github, owner, repo, releaseSha };
  const { data: workflow } = await github.rest.actions.getWorkflow({ owner, repo, workflow_id: RELEASE_WORKFLOW });
  assert.equal(workflow.path, `.github/workflows/${RELEASE_WORKFLOW}`);
  const runId = await latestNativeRunId({ ...context, workflowId: integer(workflow.id, "Production workflow ID") });
  if (runId === null) return { state: "pending", reason: "production-not-started" };
  const { data: run } = await github.rest.actions.getWorkflowRun({ owner, repo, run_id: runId });
  const expected = { repository: `${owner}/${repo}`, repositoryId, stage: "promotion", releaseSha };
  validateWorkflowRun(run, expected);
  assert.equal(run.id, runId);
  assert.equal(run.workflow_id, workflow.id);
  if (run.status !== "completed") {
    assert(["queued", "in_progress", "waiting", "pending", "requested"].includes(run.status), "Unknown production workflow state.");
    return { state: "pending", reason: "production-in-progress", runId };
  }
  if (run.conclusion !== "success") return { state: "failure", reason: "production-workflow-failed", runId };
  const receipt = validatePromotionReceipt(await loadRunArchive({
    github, owner, repo, run, name: receiptName("promotion", releaseSha, run.id, run.run_attempt),
  }), run, expected);
  if (receipt.status === "deferred" && receipt.authority?.mode === "continuous") {
    assert.deepEqual(Object.keys(receipt.authority).sort(), ["actorId", "mode", "previous", "triggeringActorId"]);
    assert.equal(receipt.authority.actorId, run.actor.id);
    assert.equal(receipt.authority.triggeringActorId, run.triggering_actor.id);
    const previous = validatePromotionReference(receipt.authority.previous);
    assert.equal(previous.repositoryId, repositoryId);
    assert(previous.runId < run.id, "A deferred release needs earlier paper-production authority.");
    const successful = ["gate", "force-disable-rollout", "publish-release-receipt", "publish-promotion-receipt"];
    await verifyNativeJobs({
      github, owner, repo, run, exact: true,
      conclusions: Object.fromEntries(promotionJobEntries(receipt).map(([id, name]) => [
        name, successful.includes(id) ? "success" : "skipped",
      ])),
    });
    await loadExactDevelopmentReceipt({
      github, owner, repo, repositoryId, releaseSha, reference: receipt.release.development,
    });
    await loadVerifiedPromotionReceipt({ github, owner, repo, repositoryId, reference: previous });
    await assertUnchangedNativeRun({ github, owner, repo, run, expected });
    assert.equal(await latestNativeRunId({ ...context, workflowId: workflow.id }), runId,
      "A newer production run superseded the deferral.");
    return {
      state: "pending", reason: "production-deferred", retryable: true,
      runId, runAttempt: run.run_attempt, completedAt: run.updated_at,
    };
  }
  if (receipt.status !== "paper") return {
    state: receipt.status === "failed" ? "failure" : "pending",
    reason: `production-${receipt.status}`, runId, runAttempt: run.run_attempt,
  };
  const verified = await loadVerifiedPromotionReceipt({
    github, owner, repo, repositoryId, reference: promotionReference(receipt),
  });
  assert.equal(await latestNativeRunId({ ...context, workflowId: workflow.id }), runId,
    "A newer production run superseded the evidence.");
  const deployment = await latestProductionDeployment(context);
  assert.deepEqual(deployment.reference, promotionReference(verified), "Delivery does not identify the verified production attempt.");
  return { state: "success", reason: "verified-paper-production", receipt: verified };
}

async function inspectDevelopmentDelivery({ github, owner, repo, repositoryId, releaseSha }) {
  const context = { github, owner, repo, repositoryId, releaseSha };
  const { data: workflow } = await github.rest.actions.getWorkflow({ owner, repo, workflow_id: DEVELOPMENT_WORKFLOW });
  assert.equal(workflow.path, `.github/workflows/${DEVELOPMENT_WORKFLOW}`);
  const workflowId = integer(workflow.id, "Development workflow ID");
  const runId = await latestNativeRunId({ ...context, workflowId });
  if (runId === null) return { state: "pending", reason: "development-not-started" };
  const { data: run } = await github.rest.actions.getWorkflowRun({ owner, repo, run_id: runId });
  validateWorkflowRun(run, { repository: `${owner}/${repo}`, repositoryId, stage: "development", releaseSha });
  assert.equal(run.id, runId);
  assert.equal(run.workflow_id, workflowId);
  if (run.status !== "completed") {
    assert(["queued", "in_progress", "waiting", "pending", "requested"].includes(run.status), "Unknown development state.");
    return { state: "pending", reason: "development-in-progress" };
  }
  if (run.conclusion !== "success") return { state: "failure", reason: "development-workflow-failed" };
  const receipt = await verifyDevelopmentRunReceipt({ ...context, run });
  assert.equal(await latestNativeRunId({ ...context, workflowId }), runId, "New development evidence superseded this run.");
  return { state: "success", receipt };
}

module.exports = {
  RELEASE_WORKFLOW, RELEASE_JOBS, DEVELOPMENT_WORKFLOW, DEVELOPMENT_JOBS,
  DEVELOPMENT_PUBLISHER, DEVELOPMENT_RECEIPT_PUBLISHER, DEVELOPMENT_ROLLBACK,
  receiptName, validateBinding, baseReceipt, createReleaseReceipt, createDevelopmentReceipt,
  validateWorkflowRun, validateReceipt, loadProductionReceipt, productionVerificationOverrides,
  assertCurrentMain, loadLatestDevelopmentReceipt, resolveProductionInvocation, assertProductionFactoryMode,
  PRODUCTION_STATUS_CONTEXT, PRODUCTION_ENVIRONMENT, PRODUCTION_JOB_NAMES, PROMOTION_MODES,
  promotionReference, validatePromotionReference, assertPromotionActor, productionAuthorization,
  productionReportExpectations, createPromotionReceipt, validatePromotionReceipt,
  loadVerifiedPromotionReceipt, loadDeployedProductionReceipt, inspectProductionDelivery,
  loadExactDevelopmentReceipt, inspectDevelopmentDelivery,
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
