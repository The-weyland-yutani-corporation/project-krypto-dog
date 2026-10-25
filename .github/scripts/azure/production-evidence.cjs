"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { loadRunArchive } = require("../agentic-receipt.cjs");

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
  assert(["release", "development"].includes(stage), "Only disabled-release or development receipts are implemented.");
  matching(sha, SHA, "Release SHA");
  integer(runId, "Run ID");
  integer(attempt, "Run attempt");
  const prefix = stage === "development" ? "development-release" : "production-release";
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
  const triggeringDevelopment = {};
  if (env.GITHUB_EVENT_NAME === "workflow_dispatch") {
    sha = matching(env.INPUT_COMMIT_SHA, SHA, "Manual release SHA");
    deploymentStage = env.INPUT_DEPLOYMENT_STAGE;
    assert(["foundation", "full"].includes(deploymentStage), "Production stage must be foundation or full.");
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
  }
  assert.equal(sha, matching(env.GITHUB_SHA, SHA, "Workflow SHA"), "Production must deploy its exact workflow source.");
  assert.equal(sha, matching(env.GITHUB_WORKFLOW_SHA, SHA, "Workflow definition SHA"),
    "Production must execute its exact release source.");
  return { sha, deployment_stage: deploymentStage, ...triggeringDevelopment };
}

async function assertProductionFactoryMode({ github, core, owner, repo, eventName }) {
  assert(["workflow_dispatch", "workflow_run"].includes(eventName), "Unsupported production trigger.");
  if (eventName === "workflow_dispatch") return;
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
  assert(["release", "development"].includes(stage), "Only disabled-release or development receipts are implemented.");
  matching(env.GITHUB_REPOSITORY, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "Repository");
  assert.equal(env.GITHUB_REF, "refs/heads/main", "Deployment evidence requires protected main.");
  for (const key of ["GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_REPOSITORY_ID"]) {
    matching(env[key], /^[1-9][0-9]*$/, key);
  }
  return {
    schemaVersion: stage === "development" ? 1 : 2,
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
  assert(["release", "development"].includes(stage), "Only disabled-release or development receipts are implemented.");
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
  if (stage === "development") {
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
  const latestRunId = async () => {
    const { data } = await github.rest.actions.listWorkflowRuns({
      owner, repo, workflow_id: workflow.id, head_sha: releaseSha, per_page: 100,
    });
    assert(Array.isArray(data.workflow_runs) && Number.isSafeInteger(data.total_count) &&
      data.total_count > 0 && data.total_count <= 100 && data.workflow_runs.length === data.total_count,
    "A complete bounded inventory of development runs is required.");
    const ids = data.workflow_runs.map((entry) => {
      assert.equal(entry.head_sha, releaseSha, "Unrelated source in development inventory.");
      return integer(entry.id, "Development run ID");
    });
    assert.equal(new Set(ids).size, ids.length, "Development inventory is ambiguous.");
    return Math.max(...ids);
  };
  const runId = await latestRunId();
  if (expectedRunId !== undefined) assert.equal(runId, expectedRunId, "The admitted development run was superseded.");
  const { data: run } = await github.rest.actions.getWorkflowRun({ owner, repo, run_id: runId });
  const expected = { repository: `${owner}/${repo}`, repositoryId, stage: "development", releaseSha };
  validateWorkflowRun(run, expected);
  assert.equal(run.id, runId, "Wrong development run.");
  assert.equal(run.workflow_id, workflow.id, "Wrong immutable development workflow.");
  if (expectedRunAttempt !== undefined) {
    assert.equal(run.run_attempt, expectedRunAttempt, "The admitted development attempt was superseded.");
  }
  assert.equal(run.status, "completed", "The latest development run is not terminal.");
  assert.equal(run.conclusion, "success", "The latest development run did not succeed.");
  const receipt = validateReceipt(await loadRunArchive({
    github, owner, repo, run, name: receiptName("development", releaseSha, run.id, run.run_attempt),
  }), run, expected);
  assert.equal(receipt.status, "shadow", "A green development wrapper is not a verified deployment.");
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRunAttempt, {
    owner, repo, run_id: run.id, attempt_number: run.run_attempt, per_page: 100,
  });
  assert(Array.isArray(jobs) && jobs.length <= 100, "Development job inventory is missing or unbounded.");
  for (const name of [
    ...Object.values(DEVELOPMENT_JOBS), DEVELOPMENT_RECEIPT_PUBLISHER, DEVELOPMENT_PUBLISHER, DEVELOPMENT_ROLLBACK,
  ]) {
    const matchingJobs = jobs.filter((job) => job.name === name);
    assert(matchingJobs.length === 1 && matchingJobs[0].status === "completed" &&
      matchingJobs[0].conclusion === (name === DEVELOPMENT_ROLLBACK ? "skipped" : "success"),
    `The actual development attempt is missing its required result: ${name}.`);
  }
  const { data: fresh } = await github.rest.actions.getWorkflowRun({ owner, repo, run_id: run.id });
  validateWorkflowRun(fresh, expected);
  for (const field of ["id", "run_attempt", "workflow_id", "status", "conclusion", "updated_at"]) {
    assert.equal(fresh[field], run[field], "Development changed during evidence verification.");
  }
  assert.equal(fresh.actor.id, run.actor.id, "Development actor changed during verification.");
  assert.equal(fresh.triggering_actor.id, run.triggering_actor.id, "Development rerun actor changed during verification.");
  assert.equal(await latestRunId(), run.id, "A newer development run superseded the evidence.");
  await assertCurrentMain(context);
  return receipt;
}

module.exports = {
  RELEASE_WORKFLOW, RELEASE_JOBS, DEVELOPMENT_WORKFLOW, DEVELOPMENT_JOBS,
  DEVELOPMENT_PUBLISHER, DEVELOPMENT_RECEIPT_PUBLISHER, DEVELOPMENT_ROLLBACK,
  receiptName, validateBinding, baseReceipt, createReleaseReceipt, createDevelopmentReceipt,
  validateWorkflowRun, validateReceipt, loadProductionReceipt, productionVerificationOverrides,
  assertCurrentMain, loadLatestDevelopmentReceipt, resolveProductionInvocation, assertProductionFactoryMode,
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
