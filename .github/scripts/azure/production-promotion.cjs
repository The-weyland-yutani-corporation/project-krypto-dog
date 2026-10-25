"use strict";

const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs");
const path = require("node:path");
const {
  validateBinding, loadLatestDevelopmentReceipt,
  assertProductionFactoryMode, assertPromotionActor, loadDeployedProductionReceipt,
  loadVerifiedPromotionReceipt, promotionReference, productionAuthorization, productionReportExpectations,
} = require("./production-evidence.cjs");
const { validateProductionReport } = require("./lib/production-report.cjs");
const { validateWebRollout, validateRuntimeContainer } = require("./lib/disabled-rollout.cjs");
const { readJobExecutions } = require("./lib/job-executions.cjs");
const { deploymentFenceOwner } = require("./lib/deployment-owner.cjs");

const exec = promisify(execFile);
const OPS = Object.freeze({
  PREFLIGHT_JOB_NAME: "preflight",
  VERIFIED_BACKUP_JOB_NAME: "verified-backup",
  MIGRATE_INIT_JOB_NAME: "migrate-init",
  TARGET_SMOKE_JOB_NAME: "target-smoke",
  ACTIVATION_CHECK_JOB_NAME: "activation-check",
});

function required(value, pattern, name) {
  assert(typeof value === "string" && pattern.test(value), `${name} is missing or invalid.`);
  return value;
}

function nonsecretValue(container, name) {
  assert(Array.isArray(container?.env), "Runtime environment is missing.");
  const entries = container.env.filter((entry) => entry.name === name);
  assert(entries.length === 1 && typeof entries[0].value === "string" && entries[0].secretRef === undefined,
    `The ${name} binding is missing, duplicated or secret-valued.`);
  return entries[0].value;
}

function container(resource) {
  const template = resource?.properties?.template;
  assert(Array.isArray(template?.containers) && template.containers.length === 1,
    "Exactly one container is required.");
  assert(template.initContainers == null || template.initContainers.length === 0, "Unexpected init containers.");
  assert(template.volumes == null || template.volumes.length === 0, "Unexpected volumes.");
  return template.containers[0];
}

function resourceContext(env) {
  const subscription = required(env.AZURE_SUBSCRIPTION_ID,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Azure subscription");
  const group = required(env.PROD_RESOURCE_GROUP_NAME, /^[A-Za-z0-9_.()-]{1,90}$/, "Production resource group");
  const names = {};
  for (const key of ["WEB_APP_NAME", "PROD_HOURLY_JOB_NAME", "PROD_DAILY_JOB_NAME", ...Object.keys(OPS)]) {
    names[key] = required(env[key], /^[a-z][a-z0-9-]{0,31}$/, key);
  }
  assert.equal(new Set(Object.values(names)).size, Object.keys(names).length, "Production resources must be distinct.");
  const prefix = `/subscriptions/${subscription}/resourceGroups/${group}/providers/Microsoft.App`;
  return {
    subscription, group, names,
    id: (key) => `${prefix}/${key === "WEB_APP_NAME" ? "containerApps" : "jobs"}/${names[key]}`,
  };
}

async function defaultExecute(command, args, options) {
  return (await exec(command, args, options)).stdout;
}

function commandRunner(execute = defaultExecute) {
  return async (command, args, label, timeout = 45_000) => {
    try {
      return await execute(command, args, { encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 });
    } catch (error) {
      const code = Number.isSafeInteger(error?.code) ? error.code : "unavailable";
      // Child output can contain a private OIDC proof or execution template.
      throw new Error(`${label} failed (exit ${code}); no production success is inferred.`);
    }
  };
}

async function readSnapshot(context, read) {
  const entries = await Promise.all(Object.entries(context.names).map(async ([key, name]) => {
    const value = await read([
      "containerapp", ...(key === "WEB_APP_NAME" ? [] : ["job"]), "show", "--name", name,
      "--resource-group", context.group, "--subscription", context.subscription, "--output", "json",
    ]);
    assert.equal(value?.id?.toLowerCase(), context.id(key).toLowerCase(), "Azure returned another production resource.");
    return [key, value];
  }));
  const snapshot = Object.fromEntries(entries);
  snapshot.revisions = await read([
    "containerapp", "revision", "list", "--name", context.names.WEB_APP_NAME, "--all",
    "--resource-group", context.group, "--subscription", context.subscription, "--output", "json",
  ]);
  return snapshot;
}

function verifyBinding(snapshot, binding, env) {
  validateBinding(binding);
  const webImage = `${binding.registryLoginServer}/krypto-web@${binding.webImageDigest}`;
  const opsImage = `${binding.registryLoginServer}/krypto-ops@${binding.opsImageDigest}`;
  const web = snapshot.WEB_APP_NAME;
  assert.equal(container(web).image, webImage, "The production runtime image changed.");
  assert.equal(nonsecretValue(container(web), "APP_ORIGIN"), binding.targetOrigin, "The production origin changed.");
  assert.equal(`https://${web.properties.configuration.ingress.fqdn}`, binding.targetOrigin,
    "The production origin does not identify the live application.");
  for (const key of ["PROD_HOURLY_JOB_NAME", "PROD_DAILY_JOB_NAME"]) {
    assert.equal(container(snapshot[key]).image, webImage, "A scheduler image changed.");
    assert.equal(nonsecretValue(container(snapshot[key]), "TARGET_BASE_URL"), binding.targetOrigin,
      "A scheduler target changed.");
  }
  for (const [key, operation] of Object.entries(OPS)) {
    const job = snapshot[key];
    const spec = container(job);
    assert.equal(spec.image, opsImage, "An operations image changed.");
    assert.equal(job.properties.configuration.triggerType, "Manual", "An operations job is not Manual.");
    assert(job.properties.configuration.scheduleTriggerConfig == null &&
      job.properties.configuration.eventTriggerConfig == null, "An operations trigger changed.");
    for (const [name, value] of Object.entries({
      OPERATION: operation, ENVIRONMENT_NAME: "prod", RELEASE_SHA: binding.releaseSha,
    })) assert.equal(nonsecretValue(spec, name), value, "An operations binding changed.");
  }
  const smoke = container(snapshot.TARGET_SMOKE_JOB_NAME);
  for (const [name, value] of Object.entries({
    IMAGE_DIGEST: binding.webImageDigest, OPS_IMAGE_DIGEST: binding.opsImageDigest,
    TARGET_BASE_URL: binding.targetOrigin, DEPLOYMENT_REPOSITORY: env.GITHUB_REPOSITORY,
    DEPLOYMENT_REPOSITORY_ID: env.GITHUB_REPOSITORY_ID,
    DEPLOYMENT_REPOSITORY_OWNER_ID: env.GITHUB_REPOSITORY_OWNER_ID,
  })) assert.equal(nonsecretValue(smoke, name), value, "An operations observation binding changed.");
}

function verifyRuntime(snapshot, binding, context, mode, trigger, generation) {
  const image = `${binding.registryLoginServer}/krypto-web@${binding.webImageDigest}`;
  validateWebRollout({ web: snapshot.WEB_APP_NAME, revisions: snapshot.revisions }, image, mode);
  for (const [key, route, cron, retries] of [
    ["PROD_HOURLY_JOB_NAME", "/api/agent/run", "0 * * * *", 1],
    ["PROD_DAILY_JOB_NAME", "/api/agent/daily-summary", "5 0 * * *", 0],
  ]) {
    const job = snapshot[key].properties;
    const spec = container(snapshot[key]);
    assert.equal(job.provisioningState, "Succeeded", "Scheduler provisioning is incomplete.");
    validateRuntimeContainer(job.template, image, mode);
    assert.deepEqual(spec.command, ["node"], "A scheduler command changed.");
    assert.deepEqual(spec.args, ["--experimental-strip-types", "scripts/scheduled-trigger.mjs"],
      "A scheduler command changed.");
    assert.equal(spec.name, context.names[key], "A scheduler container name changed.");
    assert(spec.probes == null || spec.probes.length === 0, "Unexpected scheduler probes.");
    assert(spec.volumeMounts == null || spec.volumeMounts.length === 0, "Unexpected scheduler volumes.");
    const expected = {
      TARGET_BASE_URL: binding.targetOrigin, SCHEDULED_ROUTE: route, ROLLOUT_MODE: mode,
      ...(key === "PROD_HOURLY_JOB_NAME" ? {
        SCHEDULED_IDEMPOTENCY_NAMESPACE: `${binding.webImageDigest}-${generation}`,
      } : {}),
    };
    assert.equal(spec.env.length, Object.keys(expected).length + 1, "Unexpected scheduler environment entries.");
    for (const [name, value] of Object.entries(expected)) {
      assert.equal(nonsecretValue(spec, name), value, "A scheduler binding changed.");
    }
    const secret = spec.env.filter((entry) => entry.name === "CRON_SECRET");
    assert(secret.length === 1 && secret[0].secretRef === "cron-secret" && secret[0].value === undefined,
      "The scheduler must retain its cron-secret reference.");
    const configuration = job.configuration;
    assert.equal(configuration.triggerType, trigger, "A scheduler trigger changed.");
    assert.equal(configuration.replicaRetryLimit, retries, "A scheduler retry limit changed.");
    assert.equal(configuration.replicaTimeout, 300, "A scheduler timeout changed.");
    assert(configuration.eventTriggerConfig == null, "Unexpected scheduler event trigger.");
    const current = trigger === "Manual" ? configuration.manualTriggerConfig : configuration.scheduleTriggerConfig;
    assert.equal(current?.parallelism, 1);
    assert.equal(current?.replicaCompletionCount, 1);
    if (trigger === "Manual") assert(configuration.scheduleTriggerConfig == null, "A scheduler is still scheduled.");
    else {
      assert.equal(current.cronExpression, cron, "A scheduler cron changed.");
      assert(configuration.manualTriggerConfig == null, "Unexpected Manual trigger configuration.");
    }
  }
}

async function resolvePromotionAuthority({ github, core, owner, repo, env, execute }) {
  const mode = env.PROMOTION_MODE;
  await assertProductionFactoryMode({ github, core, owner, repo, eventName: env.GITHUB_EVENT_NAME, promotionMode: mode });
  const run = await assertPromotionActor({ github, owner, repo, env, mode });
  const authority = { mode, actorId: run.actor.id, triggeringActorId: run.triggering_actor.id, previous: null };
  if (mode !== "continuous") return authority;
  assert(["true", "false"].includes(env.EXISTING_RELEASE), "Existing-release detection is missing.");
  if (env.EXISTING_RELEASE === "false") return { ...authority, mode: "disabled" };
  const command = commandRunner(execute);
  const read = async (args) => JSON.parse(await command("az", args, "Production continuity readback"));
  const context = resourceContext(env);
  const snapshot = await readSnapshot(context, read);
  const currentMode = nonsecretValue(container(snapshot.WEB_APP_NAME), "ROLLOUT_MODE");
  assert(["disabled", "shadow", "paper"].includes(currentMode), "The deployed production mode is unknown.");
  if (currentMode !== "paper") return { ...authority, mode: "disabled" };
  const webImage = container(snapshot.WEB_APP_NAME).image;
  const opsImage = container(snapshot.TARGET_SMOKE_JOB_NAME).image;
  assert(typeof webImage === "string" && typeof opsImage === "string", "Deployed images are missing.");
  const binding = validateBinding({
    releaseSha: nonsecretValue(container(snapshot.TARGET_SMOKE_JOB_NAME), "RELEASE_SHA"),
    webImageDigest: webImage.split("@")[1], opsImageDigest: opsImage.split("@")[1],
    registryLoginServer: webImage.split("/")[0],
    targetOrigin: nonsecretValue(container(snapshot.WEB_APP_NAME), "APP_ORIGIN"),
    evidenceContainerUrl: env.EVIDENCE_CONTAINER_URL,
  });
  const namespace = nonsecretValue(container(snapshot.PROD_HOURLY_JOB_NAME), "SCHEDULED_IDEMPOTENCY_NAMESPACE");
  assert(namespace.startsWith(`${binding.webImageDigest}-`), "The deployed generation is not digest-bound.");
  const generation = Number(required(namespace.slice(binding.webImageDigest.length + 1), /^[1-9][0-9]{0,9}$/, "Deployed generation"));
  verifyBinding(snapshot, binding, env);
  verifyRuntime(snapshot, binding, context, "paper", "Schedule", generation);
  const receipt = await loadDeployedProductionReceipt({
    github, owner, repo, repositoryId: Number(env.GITHUB_REPOSITORY_ID), binding, scheduleGeneration: generation,
  });
  const fresh = await readSnapshot(context, read);
  verifyBinding(fresh, binding, env);
  verifyRuntime(fresh, binding, context, "paper", "Schedule", generation);
  return { ...authority, previous: promotionReference(receipt) };
}

function readJson(file, limit = 1_048_576) {
  const metadata = fs.lstatSync(file);
  assert(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= limit, "Evidence file is missing or unbounded.");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function runProductionPromotion({ phase, github, core, owner, repo, env, execute, recoveryPlan }) {
  assert(["prepare", "activate", "recover"].includes(phase), "Unknown production orchestration phase.");
  assert(!recoveryPlan || phase === "recover", "Recovery bindings cannot authorize activation.");
  const release = recoveryPlan ? null : JSON.parse(env.PRODUCTION_RELEASE);
  if (release) {
    assert.equal(release.status, "disabled", "Promotion requires the trusted successful disabled-release predecessor.");
    assert.equal(release.releaseSha, env.RESOLVED_SHA, "The disabled release belongs to another source.");
    assert.equal(release.runId, Number(env.GITHUB_RUN_ID), "The disabled release belongs to another workflow.");
    assert.equal(release.runAttempt, Number(env.GITHUB_RUN_ATTEMPT), "The disabled release belongs to another attempt.");
  }
  const binding = validateBinding(recoveryPlan ? recoveryPlan.binding : release.binding);
  const authority = phase === "recover" ? null : JSON.parse(env.PROMOTION_AUTHORITY);
  if (authority) assert(["operator", "continuous"].includes(authority.mode), "No paper-promotion authority was admitted.");
  const values = recoveryPlan ? recoveryPlan.values : JSON.parse(env.ROLLOUT_VALUES);
  const context = resourceContext(env);
  const command = commandRunner(execute);
  const read = async (args) => JSON.parse(await command("az", args, "Production Azure readback"));
  const scripts = (...parts) => path.join(env.GITHUB_WORKSPACE, ".github", "scripts", "azure", ...parts);
  const infra = (file) => path.join(env.GITHUB_WORKSPACE, "infra", file);
  const root = fs.mkdtempSync(path.join(env.RUNNER_TEMP, "production-promotion-"));
  const local = (name) => path.join(root, name);
  const write = (name, value) => {
    const file = local(name);
    fs.writeFileSync(file, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    return file;
  };
  const logical = (suffix) => required(`run${env.GITHUB_RUN_ID}-a${env.GITHUB_RUN_ATTEMPT}-prod-${suffix}`,
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/, "Production invocation ID");
  const snapshot = () => readSnapshot(context, read);
  const check = async (mode, trigger, generation) => {
    const state = await snapshot();
    verifyBinding(state, binding, env);
    verifyRuntime(state, binding, context, mode, trigger, generation);
    return state;
  };
  const verifyQuiescence = async () => {
    await command("bash", [
      scripts("verify-disabled-rollout.sh"), "--resource-group", context.group,
      "--web-app", context.names.WEB_APP_NAME, "--hourly-job", context.names.PROD_HOURLY_JOB_NAME,
      "--daily-job", context.names.PROD_DAILY_JOB_NAME,
      "--image", `${binding.registryLoginServer}/krypto-web@${binding.webImageDigest}`,
    ], "Production disabled/Manual quiescence", 600_000);
    await check("disabled", "Manual", 0);
  };
  let recoveryChecks = 0;
  const guardRecovery = async () => {
    if (!recoveryPlan) return;
    assert(Date.now() < Date.parse(recoveryPlan.deadlineAt), "The bounded recovery deadline expired.");
    if (recoveryPlan.fence === "required") {
      const id = logical(`recovery-check-${++recoveryChecks}`);
      await command("bash", [
        scripts("run-deployment-admission.sh"),
        ...fenceArguments(recoveryPlan.cutover, binding, context, "verify", id, local(id)),
      ], "Owned recovery fence verification", 650_000);
    }
    assert(Date.now() < Date.parse(recoveryPlan.deadlineAt), "The bounded recovery deadline expired.");
    verifyBinding(await snapshot(), binding, env);
  };
  const guard = async () => {
    await loadLatestDevelopmentReceipt({
      github, owner, repo, repositoryId: Number(env.GITHUB_REPOSITORY_ID),
      releaseSha: binding.releaseSha, expectedRunId: release.development.runId,
      expectedRunAttempt: release.development.runAttempt,
    });
    await assertProductionFactoryMode({
      github, core, owner, repo, eventName: env.GITHUB_EVENT_NAME, promotionMode: authority.mode,
    });
    const run = await assertPromotionActor({ github, owner, repo, env, mode: authority.mode });
    assert.equal(authority.actorId, run.actor.id);
    assert.equal(authority.triggeringActorId, run.triggering_actor.id);
    if (authority.mode === "continuous") {
      await loadVerifiedPromotionReceipt({
        github, owner, repo, repositoryId: Number(env.GITHUB_REPOSITORY_ID), reference: authority.previous,
      });
    } else assert.equal(authority.previous, null, "Operator authority cannot impersonate continuity.");
    return run;
  };
  const planDeployment = async (template, parameters, label) => {
    const args = [
      "--resource-group", context.group, "--subscription", context.subscription,
      "--template-file", template, "--parameters", parameters,
    ];
    const whatif = JSON.parse(await command("az", [
      "deployment", "group", "what-if", ...args, "--result-format", "FullResourcePayloads",
      "--no-pretty-print", "--output", "json",
    ], `${label} what-if`, 600_000));
    const file = write(`${label}-whatif.json`, whatif);
    await command("node", [scripts("reject-unsafe-whatif-deletes.mjs"), "--file", file], `${label} delete guard`);
    return async () => JSON.parse(await command("az", [
      "deployment", "group", "create", ...args, "--name", `${label}-${env.GITHUB_RUN_ID}-a${env.GITHUB_RUN_ATTEMPT}`,
      "--query", "properties.outputs", "--output", "json",
    ], `${label} deployment`, 1_200_000));
  };
  const planRollout = async (mode, trigger, generation, label) => {
    const params = local(`${label}.bicepparam`);
    const substitutions = {
      containerAppsEnvironmentId: values.container_apps_environment_id,
      acrLoginServer: binding.registryLoginServer,
      runtimeIdentityId: values.runtime_identity_id,
      runtimeIdentityClientId: values.runtime_identity_client_id,
      schedulerIdentityId: values.scheduler_identity_id,
      communicationEmailSender: values.communication_email_sender,
    };
    const args = [scripts("render-bicepparam.mjs"), "--template", infra(path.join("params", "rollout.prod.bicepparam")),
      "--out", params];
    for (const [key, value] of Object.entries(substitutions)) {
      assert(typeof value === "string" && value.length > 0, `Missing rollout binding ${key}.`);
      args.push("--set", `REPLACE_WITH_ENVIRONMENT_OUTPUT_${key}=${value}`);
    }
    args.push("--set", `REPLACE_WITH_CURRENTLY_RELEASED_DIGEST=${binding.webImageDigest.slice(7)}`,
      "--set-string-param", `rolloutMode=${mode}`, "--set-string-param", `hourlyTriggerType=${trigger}`,
      "--set-string-param", `dailyTriggerType=${trigger}`, "--set-string-param", `scheduleGenerationUnixSeconds=${generation}`);
    await command("node", args, `${label} parameter rendering`);
    const apply = await planDeployment(infra("rollout.bicep"), params, label);
    return async () => {
      const outputs = await apply();
      assert.equal(outputs.rolloutMode?.value, mode);
      assert.equal(outputs.hourlyTriggerType?.value, trigger);
      assert.equal(outputs.dailyTriggerType?.value, trigger);
    };
  };
  const monitoring = async (enabled, generation, label) => {
    const params = local(`${label}.json`);
    await command("az", [
      "bicep", "build-params", "--file", infra(path.join("params", "schedule-monitoring.prod.bicepparam")), "--outfile", params,
    ], "Production monitoring parameter compilation");
    const document = readJson(params);
    assert(document.parameters?.enabled && document.parameters?.scheduleEnabledAtUnixSeconds, "Monitoring parameters are incomplete.");
    document.parameters.enabled.value = enabled;
    document.parameters.scheduleEnabledAtUnixSeconds.value = String(generation);
    const rendered = write(`${label}-rendered.json`, document);
    const apply = await planDeployment(infra("schedule-monitoring.bicep"), `@${rendered}`, label);
    if (phase === "recover") {
      await verifyQuiescence();
      await guardRecovery();
    }
    else await guard();
    const outputs = await apply();
    assert.equal(outputs.missingHourlySuccessAlertEnabled?.value, enabled);
    assert.equal(outputs.scheduleEnabledAtUnixSeconds?.value, String(generation));
    const id = outputs.missingHourlySuccessAlertId?.value;
    const expected = `/subscriptions/${context.subscription}/resourceGroups/${context.group}` +
      `/providers/Microsoft.Insights/scheduledQueryRules/alert-${context.names.PROD_HOURLY_JOB_NAME}-missing-success`;
    assert.equal(id?.toLowerCase(), expected.toLowerCase(), "Unexpected production monitoring resource.");
    const rule = await read(["rest", "--method", "get", "--url",
      `https://management.azure.com${id}?api-version=2023-12-01`, "--subscription", context.subscription, "--output", "json"]);
    assert.equal(rule.properties?.enabled, enabled, "Monitoring did not retain its requested state.");
    assert.equal(rule.properties?.actions?.customProperties?.scheduleEnabledAtUnixSeconds, String(generation),
      "Monitoring is not bound to this activation window.");
    if (enabled) {
      assert.equal(rule.properties.skipQueryValidation, false, "The missing-success query was not validated.");
      assert(Array.isArray(rule.properties.actions.actionGroups) && rule.properties.actions.actionGroups.length > 0,
        "Missing-success monitoring has no notification destination.");
    }
  };
  const runOps = async (jobKey, operation, id, options = {}) => {
    const executionFile = local(`${id}-execution.txt`);
    await command("bash", [
      scripts("run-ops-job.sh"), "--job-name", context.names[jobKey], "--resource-group", context.group,
      "--job-execution-id", id, "--execution-name-output", executionFile,
      "--timeout-seconds", "1800", ...(options.args ?? []),
    ], `${operation} execution`, 1_850_000);
    const executionName = required(fs.readFileSync(executionFile, "utf8").trim(),
      /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/, "Native production execution");
    if (options.manual) return { executionName };
    const destination = local(id);
    await command("bash", [
      scripts("download-evidence.sh"), "--container-url", binding.evidenceContainerUrl,
      "--environment-name", "prod", "--release-sha", binding.releaseSha, "--operation", operation,
      "--job-execution-id", id, "--destination", destination,
    ], `${operation} evidence download`, 120_000);
    const file = path.join(destination, "prod", binding.releaseSha, operation, id, "report.json");
    return { report: readJson(file), file, executionName };
  };
  const ready = async (evidence, suffix) => {
    const config = write(`${suffix}-config.json`, {
      phase: "ready", authorizationId: evidence.authorizationId, scheduleGeneration: evidence.scheduleGeneration,
      approvalId: evidence.approvalId, approvalCreatedAfter: evidence.approvalCreatedAfter,
      shadowIdempotencyKey: evidence.manualShadow.idempotencyKey, shadowStartedAfter: evidence.manualShadow.startedAfter,
    });
    const id = logical(suffix);
    const result = await runOps("TARGET_SMOKE_JOB_NAME", "production-verification", id,
      { args: ["--production-verification-config", config] });
    validateProductionReport(result.report, {
      ...productionReportExpectations(binding, { ...evidence, ready: result.report }, "ready"),
      "job-execution-id": id, "azure-execution-name": result.executionName,
    });
    return result.report;
  };
  const manualMatches = async (runStartedAt, marker) => {
    const executions = await readJobExecutions(context.id("PROD_HOURLY_JOB_NAME"), read);
    const candidates = executions.filter((entry) =>
      !Number.isFinite(Date.parse(entry.properties.startTime)) ||
      Date.parse(entry.properties.startTime) >= Date.parse(runStartedAt) - 120_000);
    assert(candidates.length <= 50, "The current-attempt manual execution inventory is unbounded.");
    const details = await Promise.all(candidates.map((entry) => read([
      "rest", "--method", "get", "--url", `https://management.azure.com${entry.id}?api-version=2023-05-01`,
      "--subscription", context.subscription, "--output", "json",
    ])));
    return details.filter((entry, index) => {
      assert.equal(entry?.id?.toLowerCase(), candidates[index].id.toLowerCase(), "Manual execution identity changed.");
      const spec = container(entry);
      const markers = spec.env?.filter((value) => value.name === "JOB_EXECUTION_ID") ?? [];
      assert(markers.length <= 1, "Manual execution has ambiguous invocation markers.");
      return markers[0]?.value === marker;
    });
  };

  try {
    if (phase === "recover") {
      verifyBinding(await snapshot(), binding, env);
      const apply = await planRollout("disabled", "Manual", 0, "prod-recover");
      await guardRecovery();
      verifyBinding(await snapshot(), binding, env);
      await apply();
      await verifyQuiescence();
      await monitoring(false, 0, "prod-monitor-recover");
      await verifyQuiescence();
      return { recovered: true };
    }

    const run = await guard();
    if (phase === "prepare") {
      await check("disabled", "Manual", 0);
      const generation = Math.floor(Date.now() / 1000);
      const evidence = {
        scheduleGeneration: generation,
        authorizationId: productionAuthorization({ env, binding, authority, scheduleGeneration: generation }),
        approvalCreatedAfter: new Date().toISOString(),
      };
      const smoke = await runOps("TARGET_SMOKE_JOB_NAME", "target-smoke", logical("smoke"));
      await command("node", [
        scripts("validate-report.mjs"), "--report", smoke.file, "--operation", "target-smoke",
        "--release-sha", binding.releaseSha, "--image-digest", binding.webImageDigest,
      ], "Fresh production smoke validation");
      evidence.approvalId = required(smoke.report.evidenceIds?.approval, /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/, "Smoke approval");
      const apply = await planRollout("shadow", "Manual", generation, "prod-shadow");
      await guard();
      await check("disabled", "Manual", 0);
      await apply();
      await check("shadow", "Manual", generation);
      const id = logical("shadow");
      assert.equal((await manualMatches(run.run_started_at, id)).length, 0, "The manual shadow marker already exists.");
      const boundary = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      const manual = await runOps("PROD_HOURLY_JOB_NAME", "manual-shadow", id, {
        manual: true, args: ["--scheduled-idempotency-key", `manual-shadow:${id}`],
      });
      const matches = await manualMatches(run.run_started_at, id);
      assert.equal(matches.length, 1, "Exactly one native manual shadow execution is required.");
      assert.equal(matches[0].name, manual.executionName, "Manual shadow readback belongs to another execution.");
      assert.equal(matches[0].properties.status, "Succeeded", "The manual shadow execution did not succeed.");
      evidence.manualShadow = { executionName: manual.executionName, idempotencyKey: `manual-shadow:${id}`, startedAfter: boundary };
      await ready(evidence, "prepare");
      return evidence;
    }

    const evidence = JSON.parse(env.PRODUCTION_PREPARATION);
    assert.equal(evidence.authorizationId, productionAuthorization({
      env, binding, authority, scheduleGeneration: evidence.scheduleGeneration,
    }), "Preparation is not bound to this paper authorization.");
    await check("shadow", "Manual", evidence.scheduleGeneration);
    await monitoring(true, Math.floor(Date.now() / 1000), "prod-monitor-paper");
    const apply = await planRollout("paper", "Schedule", evidence.scheduleGeneration, "prod-paper");
    evidence.ready = await ready(evidence, "ready");
    await guard();
    await check("shadow", "Manual", evidence.scheduleGeneration);
    validateProductionReport(evidence.ready, productionReportExpectations(binding, evidence, "ready"));
    await apply();
    await check("paper", "Schedule", evidence.scheduleGeneration);
    const proofFile = local("scheduled-private.json");
    const observationReceiptFile = local("scheduled-observation.json");
    const id = logical("scheduled");
    await command("node", [
      "--import", "tsx", path.join(env.GITHUB_WORKSPACE, "scripts", "azure", "attest-scheduled-execution.ts"),
      "--resource-group", context.group, "--web-app", context.names.WEB_APP_NAME,
      "--hourly-job", context.names.PROD_HOURLY_JOB_NAME, "--daily-job", context.names.PROD_DAILY_JOB_NAME,
      "--ops-job", context.names.TARGET_SMOKE_JOB_NAME,
      "--expected-image", `${binding.registryLoginServer}/krypto-web@${binding.webImageDigest}`,
      "--expected-ops-image", `${binding.registryLoginServer}/krypto-ops@${binding.opsImageDigest}`,
      "--release-sha", binding.releaseSha, "--authorization-id", evidence.authorizationId,
      "--schedule-generation", String(evidence.scheduleGeneration), "--job-execution-id", id,
      "--proof-output", proofFile, "--receipt-output", observationReceiptFile,
    ], "Actual scheduled-execution observation", 4_850_000);
    const privateProof = readJson(proofFile, 65_536);
    assert(typeof privateProof.token === "string" && privateProof.observation?.purpose === "scheduled-execution",
      "The scheduled observer did not produce a private authenticated proof.");
    core.setSecret(privateProof.token);
    const observation = privateProof.observation;
    const receipt = readJson(observationReceiptFile, 8192);
    const config = write("scheduled-config.json", {
      phase: "scheduled", authorizationId: evidence.authorizationId, scheduleGeneration: evidence.scheduleGeneration,
    });
    const scheduled = await runOps("TARGET_SMOKE_JOB_NAME", "production-verification", id, {
      args: ["--production-verification-config", config, "--workflow-observation-proof", proofFile],
    });
    const execution = observation.execution;
    const expectedKey = `cron:${binding.webImageDigest}-${evidence.scheduleGeneration}:${execution.startedAt.slice(0, 13)}`;
    evidence.scheduled = scheduled.report;
    validateProductionReport(evidence.scheduled, {
      ...productionReportExpectations(binding, evidence, "scheduled"),
      "job-execution-id": id, "azure-execution-name": scheduled.executionName,
      "workflow-observation-digest": receipt.observationDigest,
      "expected-scheduled-idempotency-key": expectedKey,
      "scheduled-execution-resource-id": execution.id, "scheduled-execution-name": execution.name,
      "scheduled-execution-template-digest": execution.templateDigest,
      "scheduled-execution-started-at": execution.startedAt,
      "scheduled-execution-completed-at": execution.completedAt, "schedule-enabled-at": observation.scheduleEnabledAt,
    });
    await check("paper", "Schedule", evidence.scheduleGeneration);
    return evidence;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function recoveryIdentity(env) {
  const positive = (value, name) => {
    const result = Number(required(value, /^[1-9][0-9]*$/, name));
    assert(Number.isSafeInteger(result), `${name} is not a safe integer.`);
    return result;
  };
  const repository = required(env.GITHUB_REPOSITORY, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "Repository");
  const releaseSha = required(env.RESOLVED_SHA, /^[0-9a-f]{40}$/, "Recovery candidate");
  assert(env.GITHUB_REF === "refs/heads/main" && env.GITHUB_SHA === releaseSha &&
    env.GITHUB_WORKFLOW_SHA === releaseSha &&
    env.GITHUB_WORKFLOW_REF === `${repository}/.github/workflows/azure-deploy-prod.yml@refs/heads/main`,
  "Recovery must use its exact admitted main workflow source.");
  return {
    schemaVersion: 1, repository,
    repositoryId: positive(env.GITHUB_REPOSITORY_ID, "Repository ID"),
    repositoryOwnerId: positive(env.GITHUB_REPOSITORY_OWNER_ID, "Repository owner ID"),
    runId: positive(env.GITHUB_RUN_ID, "Recovery run"), runAttempt: positive(env.GITHUB_RUN_ATTEMPT, "Recovery attempt"),
    workflowSha: releaseSha, releaseSha,
  };
}

function rolloutValues(input) {
  const result = {};
  for (const key of [
    "container_apps_environment_id", "runtime_identity_id", "runtime_identity_client_id",
    "scheduler_identity_id", "communication_email_sender",
  ]) {
    assert(typeof input?.[key] === "string" && input[key].length > 0, `Missing recovery rollout value ${key}.`);
    result[key] = input[key];
  }
  return result;
}

function recoveryScope(context) {
  return { subscription: context.subscription, group: context.group, names: context.names };
}

async function captureProductionRecovery({ env, execute }) {
  const identity = recoveryIdentity(env);
  const context = resourceContext(env);
  const command = commandRunner(execute);
  const snapshot = await readSnapshot(context, async (args) =>
    JSON.parse(await command("az", args, "Pre-mutation production binding")));
  const webImage = container(snapshot.WEB_APP_NAME).image;
  const opsImage = container(snapshot.TARGET_SMOKE_JOB_NAME).image;
  assert(typeof webImage === "string" && typeof opsImage === "string", "Current immutable images are missing.");
  const binding = validateBinding({
    releaseSha: env.CURRENT_SHA, webImageDigest: `sha256:${env.CURRENT_WEB_DIGEST_HEX}`,
    opsImageDigest: opsImage.split("@")[1], registryLoginServer: webImage.split("/")[0],
    targetOrigin: env.TARGET_ORIGIN, evidenceContainerUrl: env.EVIDENCE_CONTAINER_URL,
  });
  verifyBinding(snapshot, binding, env);
  const mode = nonsecretValue(container(snapshot.WEB_APP_NAME), "ROLLOUT_MODE");
  assert(["disabled", "shadow", "paper"].includes(mode), "The source rollout mode is unknown.");
  const namespace = nonsecretValue(container(snapshot.PROD_HOURLY_JOB_NAME), "SCHEDULED_IDEMPOTENCY_NAMESPACE");
  assert(namespace.startsWith(`${binding.webImageDigest}-`), "The source generation is not image-bound.");
  const generation = Number(required(namespace.slice(binding.webImageDigest.length + 1), /^[0-9]{1,10}$/, "Source generation"));
  verifyRuntime(snapshot, binding, context, mode, mode === "paper" ? "Schedule" : "Manual", generation);
  return {
    ...identity, resources: recoveryScope(context), binding, values: rolloutValues(JSON.parse(env.ROLLOUT_VALUES)),
    owner: deploymentFenceOwner(env.GITHUB_REPOSITORY_ID, env.GITHUB_RUN_ID),
  };
}

function createRecoveryIntent(env, needs) {
  const identity = recoveryIdentity(env);
  assert(needs?.gate?.result === "success" && needs.gate.outputs?.sha === identity.releaseSha,
    "Recovery requires the admitted workflow gate.");
  const now = Date.now();
  return {
    ...identity, startedAt: new Date(now).toISOString(), deadlineAt: new Date(now + 3_600_000).toISOString(),
    completedAt: null, status: "retained", scope: null, binding: null, cutover: null, fence: "unknown",
    reason: "recovery-not-yet-proven",
  };
}

function validateRecoveryReceipt(receipt, env) {
  const identity = recoveryIdentity(env);
  const keys = [...Object.keys(identity), "startedAt", "deadlineAt", "completedAt",
    "status", "scope", "binding", "cutover", "fence", "reason"];
  assert(receipt && typeof receipt === "object" && !Array.isArray(receipt) &&
    Object.keys(receipt).length === keys.length && keys.every((key) => Object.hasOwn(receipt, key)),
  "Recovery evidence has an unknown or missing field.");
  for (const [key, value] of Object.entries(identity)) assert.equal(receipt[key], value, "Recovery identity changed.");
  assert(["retained", "disabled", "untouched"].includes(receipt.status), "Unknown recovery state.");
  assert([null, "source", "candidate"].includes(receipt.scope), "Unknown recovery scope.");
  assert(["unknown", "required", "retained", "released", "none"].includes(receipt.fence), "Unknown recovery fence state.");
  for (const key of ["startedAt", "deadlineAt"]) {
    assert(typeof receipt[key] === "string" && Number.isFinite(Date.parse(receipt[key])) &&
      new Date(receipt[key]).toISOString() === receipt[key], "Invalid recovery clock.");
  }
  assert(Date.parse(receipt.startedAt) <= Date.now() &&
    Date.parse(receipt.deadlineAt) - Date.parse(receipt.startedAt) === 3_600_000, "Recovery must retain its one-hour bound.");
  assert(receipt.completedAt === null || (typeof receipt.completedAt === "string" &&
    Number.isFinite(Date.parse(receipt.completedAt)) &&
    Date.parse(receipt.completedAt) >= Date.parse(receipt.startedAt) &&
    Date.parse(receipt.completedAt) <= Date.now()), "Invalid recovery completion time.");
  assert(typeof receipt.reason === "string" && /^[a-z-]{1,80}$/.test(receipt.reason), "Invalid recovery reason.");
  if (receipt.binding !== null) validateBinding(receipt.binding);
  if (receipt.cutover !== null) {
    const cutover = receipt.cutover;
    const fields = ["owner", "sourceReleaseSha", "candidateReleaseSha", "sourceImageDigest", "targetOrigin", "evidenceContainerUrl"];
    assert(Object.keys(cutover).length === fields.length && fields.every((key) => typeof cutover[key] === "string"),
      "The recovery fence binding is not closed.");
    assert.equal(cutover.owner, deploymentFenceOwner(env.GITHUB_REPOSITORY_ID, env.GITHUB_RUN_ID), "Recovery cannot adopt another owner.");
    required(cutover.sourceReleaseSha, /^[0-9a-f]{40}$/, "Recovery source");
    required(cutover.sourceImageDigest, /^sha256:[0-9a-f]{64}$/, "Recovery source image");
    assert.equal(cutover.candidateReleaseSha, identity.releaseSha, "Recovery cannot adopt another candidate.");
    assert.equal(cutover.targetOrigin, receipt.binding?.targetOrigin, "Recovery fence origin changed.");
    assert.equal(cutover.evidenceContainerUrl, receipt.binding?.evidenceContainerUrl, "Recovery evidence location changed.");
  }
  if (receipt.status === "disabled") {
    assert(receipt.binding && receipt.scope && receipt.completedAt &&
      Date.parse(receipt.completedAt) <= Date.parse(receipt.deadlineAt), "Disabled recovery lacks bounded proof.");
    assert(["required", "retained", "released", "none"].includes(receipt.fence), "Disabled recovery has no fence disposition.");
    assert(receipt.fence === "none" ? receipt.cutover === null : receipt.cutover,
      "Owned recovery has no fence binding.");
    assert.equal(receipt.binding.releaseSha,
      receipt.scope === "source" ? receipt.cutover?.sourceReleaseSha : identity.releaseSha,
      "Recovery cannot borrow another source or candidate.");
    if (receipt.scope === "source") {
      assert.equal(receipt.binding.webImageDigest, receipt.cutover.sourceImageDigest, "Recovery source image changed.");
    }
  }
  if (receipt.status === "untouched") {
    assert(receipt.scope === null && receipt.binding === null && receipt.cutover === null &&
      receipt.fence === "unknown" && receipt.completedAt &&
      receipt.reason === "verified-mutation-free-deferral", "Untouched recovery cannot claim a changed runtime or fence.");
  }
  return receipt;
}

function fenceArguments(cutover, binding, context, action, id, destination) {
  return [
    "--action", action, "--owner", cutover.owner,
    "--source-release-sha", cutover.sourceReleaseSha, "--candidate-release-sha", cutover.candidateReleaseSha,
    "--source-image-digest", cutover.sourceImageDigest, "--job-release-sha", binding.releaseSha,
    "--target-origin", binding.targetOrigin, "--job-name", context.names.ACTIVATION_CHECK_JOB_NAME,
    "--resource-group", context.group, "--container-url", binding.evidenceContainerUrl,
    "--job-execution-id", id, "--destination", destination, "--timeout-seconds", "600",
  ];
}

async function runProductionRecovery(options) {
  const { env, execute } = options;
  const intent = validateRecoveryReceipt(JSON.parse(env.PRODUCTION_RECOVERY_INTENT), env);
  assert.equal(intent.status, "retained", "Recovery cannot replay a completed result.");
  let result = { ...intent };
  try {
    assert(Date.now() < Date.parse(intent.deadlineAt), "Recovery intent expired.");
    const needs = JSON.parse(env.PRODUCTION_JOB_RESULTS);
    assert(needs.gate?.result === "success" && needs.gate.outputs?.sha === intent.releaseSha, "The recovery gate changed.");
    const admission = needs["force-disable-rollout"];
    if (admission?.result === "success" && admission.outputs?.admission_status === "deferred") {
      assert.equal(admission.outputs.existing_release, "true", "A deferral requires the unchanged existing release.");
      for (const id of ["backup-current-release", "deploy-environment", "build-images", "deploy-release",
        "migrate-backup", "release-cutover-fence", "target-smoke", "verify-final-state", "prepare-paper", "promote-paper"]) {
        assert.equal(needs[id]?.result, "skipped", "A deferred attempt also ran a mutation-capable job.");
      }
      return validateRecoveryReceipt({
        ...intent, status: "untouched", completedAt: new Date().toISOString(),
        reason: "verified-mutation-free-deferral",
      }, env);
    }
    const context = resourceContext(env);
    const command = commandRunner(execute);
    const snapshot = await readSnapshot(context, async (args) =>
      JSON.parse(await command("az", args, "Recovery runtime inspection")));
    const existing = admission?.outputs?.existing_release;
    assert(["true", "false"].includes(existing), "Recovery has no reliable release inventory.");
    let source = null;
    if (existing === "true") {
      source = JSON.parse(admission.outputs.recovery_context);
      const identity = recoveryIdentity(env);
      for (const [key, value] of Object.entries(identity)) {
        if (key === "runAttempt") assert(Number.isSafeInteger(source[key]) && source[key] > 0 && source[key] <= value,
          "The captured recovery attempt is invalid.");
        else assert.equal(source[key], value, "The captured source belongs to another workflow.");
      }
      assert.deepEqual(source.resources, recoveryScope(context), "The captured recovery resources changed.");
      assert.equal(source.owner, deploymentFenceOwner(env.GITHUB_REPOSITORY_ID, env.GITHUB_RUN_ID));
      validateBinding(source.binding);
      assert.equal(source.binding.releaseSha, admission.outputs.current_sha);
      assert.equal(source.binding.webImageDigest, `sha256:${admission.outputs.current_digest}`);
    }
    const cutover = source ? {
      owner: source.owner, sourceReleaseSha: source.binding.releaseSha,
      candidateReleaseSha: intent.releaseSha, sourceImageDigest: source.binding.webImageDigest,
      targetOrigin: source.binding.targetOrigin, evidenceContainerUrl: source.binding.evidenceContainerUrl,
    } : null;
    const candidates = [];
    if (needs["deploy-environment"]?.result === "success" && needs["build-images"]?.result === "success" &&
        ["success", "failure", "cancelled"].includes(needs["deploy-release"]?.result)) {
      const values = needs["deploy-environment"].outputs;
      const images = needs["build-images"].outputs;
      candidates.push({
        scope: "candidate", values: rolloutValues(values),
        binding: validateBinding({
          releaseSha: intent.releaseSha, webImageDigest: `sha256:${images.web_digest_hex}`,
          opsImageDigest: `sha256:${images.ops_digest_hex}`, registryLoginServer: values.acr_login_server,
          targetOrigin: source?.binding.targetOrigin ?? `https://${snapshot.WEB_APP_NAME.properties.configuration.ingress.fqdn}`,
          evidenceContainerUrl: values.evidence_container_url,
        }),
      });
    }
    if (source) candidates.push({ scope: "source", values: rolloutValues(source.values), binding: source.binding });
    const selected = candidates.find(({ binding }) =>
      container(snapshot.WEB_APP_NAME).image === `${binding.registryLoginServer}/krypto-web@${binding.webImageDigest}` &&
      container(snapshot.TARGET_SMOKE_JOB_NAME).image === `${binding.registryLoginServer}/krypto-ops@${binding.opsImageDigest}` &&
      nonsecretValue(container(snapshot.TARGET_SMOKE_JOB_NAME), "RELEASE_SHA") === binding.releaseSha);
    assert(selected, "The runtime is not a complete owned source or candidate binding.");
    verifyBinding(snapshot, selected.binding, env);
    if (selected.scope === "source") {
      assert.equal(needs["migrate-backup"]?.result, "skipped", "Source recovery cannot guess a database rollback.");
    }
    const checkpoint = needs["release-cutover-fence"];
    const guardFence = !source ? "none" :
      checkpoint?.result === "success" && checkpoint.outputs?.status === "released" ? "released" : "required";
    assert(guardFence !== "released" || selected.scope === "candidate",
      "A completed candidate cutover cannot authorize mutation of a restored source.");
    const baseline = needs["migrate-backup"];
    const verifiedBaseline = baseline?.result === "success" &&
      /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(baseline.outputs?.job_execution_id ?? "");
    const fence = guardFence === "required" && selected.scope === "candidate" && !verifiedBaseline ? "retained" : guardFence;
    result = { ...intent, scope: selected.scope, binding: selected.binding, cutover, fence };
    validateRecoveryReceipt(result, env);
    await runProductionPromotion({
      ...options, phase: "recover",
      recoveryPlan: { ...selected, cutover, fence: guardFence, deadlineAt: intent.deadlineAt },
    });
    return validateRecoveryReceipt({
      ...result, status: "disabled", completedAt: new Date().toISOString(),
      reason: fence === "retained" ? "candidate-baseline-unverified" : "disabled-manual-verified",
    }, env);
  } catch {
    const error = new Error("Production recovery remains retained; ownership, runtime or completion could not be proved.");
    error.recovery = { ...result, status: "retained", completedAt: new Date().toISOString(), reason: "recovery-unverified" };
    throw error;
  }
}

async function releaseRecoveredProductionFence({ env, core, execute }) {
  const receipt = validateRecoveryReceipt(JSON.parse(env.PRODUCTION_RECOVERY_RECEIPT), env);
  assert(receipt.status === "disabled" && receipt.fence === "required" && receipt.cutover,
    "Fence completion requires verified disabled recovery and its original owner.");
  const context = resourceContext(env);
  const command = commandRunner(execute);
  const root = fs.mkdtempSync(path.join(env.RUNNER_TEMP, "production-recovery-proof-"));
  const scripts = (...parts) => path.join(env.GITHUB_WORKSPACE, ".github", "scripts", "azure", ...parts);
  const binding = receipt.binding;
  const image = `${binding.registryLoginServer}/krypto-web@${binding.webImageDigest}`;
  const verify = async () => {
    assert(Date.now() < Date.parse(receipt.deadlineAt), "The bounded fence recovery deadline expired.");
    await command("bash", [
      scripts("verify-disabled-rollout.sh"), "--resource-group", context.group,
      "--web-app", context.names.WEB_APP_NAME, "--hourly-job", context.names.PROD_HOURLY_JOB_NAME,
      "--daily-job", context.names.PROD_DAILY_JOB_NAME, "--image", image,
    ], "Recovered runtime quiescence", 600_000);
    const snapshot = await readSnapshot(context, async (args) =>
      JSON.parse(await command("az", args, "Recovered binding verification")));
    verifyBinding(snapshot, binding, env);
    verifyRuntime(snapshot, binding, context, "disabled", "Manual", 0);
  };
  try {
    await verify();
    const id = required(`run${env.GITHUB_RUN_ID}-a${env.GITHUB_RUN_ATTEMPT}-recover-release`,
      /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/, "Recovery invocation");
    const proof = path.join(root, "proof.json");
    const observation = path.join(root, "observation.json");
    await command("node", [
      "--import", "tsx", path.join(env.GITHUB_WORKSPACE, "scripts", "azure", "attest-cutover-state.ts"),
      "--resource-group", context.group, "--web-app", context.names.WEB_APP_NAME,
      "--hourly-job", context.names.PROD_HOURLY_JOB_NAME, "--daily-job", context.names.PROD_DAILY_JOB_NAME,
      "--ops-job", context.names.ACTIVATION_CHECK_JOB_NAME, "--expected-image", image,
      "--owner", receipt.cutover.owner, "--source-release-sha", receipt.cutover.sourceReleaseSha,
      "--source-image-digest", receipt.cutover.sourceImageDigest, "--candidate-release-sha", receipt.releaseSha,
      "--runtime-release-sha", binding.releaseSha, "--job-execution-id", id,
      "--proof-output", proof, "--receipt-output", observation,
    ], "Recovered cutover attestation", 150_000);
    const privateProof = readJson(proof, 65_536);
    assert(typeof privateProof.token === "string" && privateProof.observation?.purpose === "cutover-release",
      "Recovery did not obtain private cutover proof.");
    core.setSecret(privateProof.token);
    const digest = required(readJson(observation, 8192).observationDigest, /^[0-9a-f]{64}$/, "Recovery observation digest");
    assert(Date.now() < Date.parse(receipt.deadlineAt), "The bounded fence recovery deadline expired.");
    await command("bash", [
      scripts("run-deployment-admission.sh"),
      ...fenceArguments(receipt.cutover, binding, context, "release", id, path.join(root, "evidence")),
      "--workflow-observation-proof", proof, "--workflow-observation-digest", digest,
    ], "Exact owned recovery fence release", 650_000);
    await verify();
    return validateRecoveryReceipt({
      ...receipt, fence: "released", completedAt: new Date().toISOString(), reason: "disabled-and-owned-fence-released",
    }, env);
  } catch {
    const error = new Error("Recovered fence completion is unverified; retain the recovery state.");
    error.recovery = { ...receipt, status: "retained", completedAt: new Date().toISOString(), reason: "fence-release-unverified" };
    throw error;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function describeProductionRecovery(env) {
  if (env.RECOVERY_RESULT !== "success") return "recovery-retained";
  const receipt = validateRecoveryReceipt(JSON.parse(env.PRODUCTION_RECOVERY_RECEIPT), env);
  if (receipt.status === "untouched") return "untouched-deferral";
  if (receipt.status !== "disabled") return "recovery-retained";
  if (receipt.fence === "none" || receipt.fence === "released") return "disabled-verified";
  if (receipt.fence === "retained") return "fence-retained";
  if (env.RECOVERY_FENCE_RESULT !== "success") return "fence-retained";
  const completed = validateRecoveryReceipt(JSON.parse(env.RECOVERED_FENCE_RECEIPT), env);
  assert(completed.status === "disabled" && completed.fence === "released", "Fence recovery is not complete.");
  for (const key of ["scope", "binding", "cutover", "startedAt", "deadlineAt"]) {
    assert.deepEqual(completed[key], receipt[key], "Fence completion belongs to another recovery.");
  }
  return "disabled-verified";
}

module.exports = {
  resolvePromotionAuthority, runProductionPromotion, nonsecretValue, verifyBinding, verifyRuntime,
  captureProductionRecovery, createRecoveryIntent, validateRecoveryReceipt,
  runProductionRecovery, releaseRecoveredProductionFence, describeProductionRecovery,
};
