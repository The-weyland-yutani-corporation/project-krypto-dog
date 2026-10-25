import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { parseArgs, promisify } from "node:util";
import { z } from "zod";
import { readJobExecutions } from "../../.github/scripts/azure/lib/job-executions.cjs";
import { validateWebRollout } from "../../.github/scripts/azure/lib/disabled-rollout.cjs";
import {
  canonicalObservationJson, cutoverObservationSchema, scheduledExecutionObservationSchema,
  workflowObservationTrustSchema, WORKFLOW_OBSERVATION_PATH, SCHEDULE_OBSERVATION_MAX_AGE_MS,
  type ScheduledExecutionObservation,
} from "../../src/deployment/workflow-observation";
import { attestCollectedObservation, writeObservationFiles } from "./attest-cutover-state";

const execute = promisify(execFile);
const name = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
const inputSchema = z.object({
  resourceGroup: z.string().regex(/^[A-Za-z0-9_.()-]{1,90}$/),
  webApp: name, hourlyJob: name, dailyJob: name, opsJob: name,
  expectedImage: z.string().regex(/^[a-z0-9.-]+\/krypto-web@sha256:[0-9a-f]{64}$/),
  expectedOpsImage: z.string().regex(/^[a-z0-9.-]+\/krypto-ops@sha256:[0-9a-f]{64}$/),
  releaseSha: cutoverObservationSchema.shape.releaseSha,
  authorizationId: z.string().regex(/^[0-9a-f]{64}$/),
  scheduleGeneration: z.number().int().positive().max(9_999_999_999),
  operationExecutionId: cutoverObservationSchema.shape.operationExecutionId,
}).strict();
type CollectorInput = z.infer<typeof inputSchema>;
type ReadAzure = (args: string[]) => Promise<unknown>;
type Execution = Awaited<ReturnType<typeof readJobExecutions>>[number];

const containerSchema = z.object({
  name: z.string().optional(), image: z.string(),
  command: z.array(z.string()).optional(), args: z.array(z.string()).optional(),
  env: z.array(z.object({
    name: z.string(), value: z.string().optional(), secretRef: z.string().optional(),
  }).strict()),
  resources: z.object({
    cpu: z.number().positive().optional(), memory: z.string().optional(),
    ephemeralStorage: z.string().optional(),
  }).strict().optional(),
});
const templateSchema = z.object({
  containers: z.array(containerSchema).length(1),
  initContainers: z.array(z.unknown()).max(0).nullish(),
  volumes: z.array(z.unknown()).max(0).nullish(),
});
const resourceSchema = z.object({
  id: z.string(),
  properties: z.object({ template: z.unknown() }),
});

function nonsecretValue(container: z.infer<typeof containerSchema>, key: string): string {
  const entries = container.env.filter((entry) => entry.name === key);
  assert(entries.length === 1 && typeof entries[0].value === "string" &&
    entries[0].secretRef === undefined, "A required runtime binding is missing, duplicated or secret-valued.");
  return entries[0].value;
}

function azureTimestamp(value: unknown): string {
  const parsed = z.iso.datetime({ offset: true }).parse(value);
  return new Date(parsed).toISOString();
}

function schedulerTemplate(
  value: unknown, jobName: string, image: string, origin: string, namespace?: string,
) {
  const template = templateSchema.extend({
    containers: z.array(containerSchema.extend({
      probes: z.array(z.unknown()).max(0).nullish(),
      volumeMounts: z.array(z.unknown()).max(0).nullish(),
    }).strict()).length(1),
  }).strict().parse(value);
  const container = containerSchema.parse(template.containers[0]);
  assert.equal(container.name, jobName, "The scheduler container name changed.");
  assert.equal(container.image, image, "The scheduler image changed.");
  assert.deepEqual(container.command, ["node"], "The scheduler command changed.");
  assert.deepEqual(container.args, ["--experimental-strip-types", "scripts/scheduled-trigger.mjs"],
    "The scheduler arguments changed.");
  const expected = {
    TARGET_BASE_URL: origin,
    SCHEDULED_ROUTE: namespace ? "/api/agent/run" : "/api/agent/daily-summary",
    ROLLOUT_MODE: "paper",
    ...(namespace ? { SCHEDULED_IDEMPOTENCY_NAMESPACE: namespace } : {}),
  };
  assert.equal(container.env.length, Object.keys(expected).length + 1,
    "The scheduler template has missing or unexpected environment bindings.");
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(nonsecretValue(container, key), value, "A scheduler binding changed.");
  }
  const cron = container.env.filter((entry) => entry.name === "CRON_SECRET");
  assert(cron.length === 1 && cron[0].secretRef === "cron-secret" && cron[0].value === undefined,
    "The scheduler must retain its existing cron secret reference.");
  return {
    ...container, env: [...container.env].sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
  };
}

async function readAzure(args: string[]): Promise<unknown> {
  let stdout: string;
  try {
    ({ stdout } = await execute("az", args, {
      encoding: "utf8", timeout: 45_000, maxBuffer: 16 * 1024 * 1024,
    }));
  } catch {
    throw new Error("Azure scheduled-execution readback failed; no observation can be issued.");
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error("Azure scheduled-execution readback was not JSON.");
  }
}

function windowExecution(executions: Execution[], firstWindow: number): Execution | undefined {
  const matching = executions.filter((execution) =>
    Math.floor(Date.parse(azureTimestamp(execution.properties.startTime)) / 3_600_000) * 3_600_000 === firstWindow);
  assert(matching.length <= 1, "Multiple executions make the first scheduled window ambiguous.");
  const selected = matching[0];
  if (selected) {
    assert(["Running", "Processing", "Succeeded"].includes(selected.properties.status),
      "The observed scheduled-window execution failed or has an unknown state.");
  }
  return selected;
}

export async function collectScheduledExecutionObservation(
  input: CollectorInput,
  env: NodeJS.ProcessEnv,
  dependencies: { read?: ReadAzure; sleep?: (milliseconds: number) => Promise<void> } = {},
): Promise<ScheduledExecutionObservation> {
  const args = inputSchema.parse(input);
  const read = dependencies.read ?? readAzure;
  const sleep = dependencies.sleep ?? ((milliseconds) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const trust = workflowObservationTrustSchema.parse({
    repository: env.GITHUB_REPOSITORY, repositoryId: env.GITHUB_REPOSITORY_ID,
    repositoryOwnerId: env.GITHUB_REPOSITORY_OWNER_ID,
  });
  const runId = z.string().regex(/^[1-9][0-9]{0,19}$/).parse(env.GITHUB_RUN_ID);
  const runAttempt = z.string().regex(/^[1-9][0-9]*$/).transform(Number)
    .pipe(z.number().int().positive().safe()).parse(env.GITHUB_RUN_ATTEMPT);
  const subscription = z.guid().parse(env.AZURE_SUBSCRIPTION_ID);
  assert(env.GITHUB_ACTIONS === "true" && env.GITHUB_REF === "refs/heads/main" &&
    ["workflow_dispatch", "workflow_run"].includes(env.GITHUB_EVENT_NAME ?? "") &&
    env.GITHUB_WORKFLOW_REF === `${trust.repository}/${WORKFLOW_OBSERVATION_PATH}@refs/heads/main` &&
    env.GITHUB_SHA === args.releaseSha && env.GITHUB_WORKFLOW_SHA === args.releaseSha,
  "Scheduled observations require the exact main-branch production workflow source.");
  assert(args.scheduleGeneration <= Math.floor(Date.now() / 1000),
    "Schedule generation cannot be in the future.");
  assert.equal(args.expectedImage.split("/")[0], args.expectedOpsImage.split("/")[0],
    "Runtime and ops images must use the same registry.");
  const prefix = `/subscriptions/${subscription}/resourceGroups/${args.resourceGroup}/providers/Microsoft.App`;
  const expectedIds = [
    `${prefix}/containerApps/${args.webApp}`, `${prefix}/jobs/${args.hourlyJob}`,
    `${prefix}/jobs/${args.dailyJob}`, `${prefix}/jobs/${args.opsJob}`,
  ];
  const suffix = ["--resource-group", args.resourceGroup, "--subscription", subscription, "--output", "json"];
  const imageDigest = args.expectedImage.split("@")[1];
  const opsImageDigest = args.expectedOpsImage.split("@")[1];
  const namespace = `${imageDigest}-${args.scheduleGeneration}`;

  async function snapshot() {
    const started = Date.now();
    const [web, revisions, hourly, daily, ops] = await Promise.all([
      read(["containerapp", "show", "--name", args.webApp, ...suffix]),
      read(["containerapp", "revision", "list", "--name", args.webApp, "--all", ...suffix]),
      read(["containerapp", "job", "show", "--name", args.hourlyJob, ...suffix]),
      read(["containerapp", "job", "show", "--name", args.dailyJob, ...suffix]),
      read(["containerapp", "job", "show", "--name", args.opsJob, ...suffix]),
    ]);
    validateWebRollout({ web, revisions }, args.expectedImage, "paper");
    const resources = [web, hourly, daily, ops].map((value) => resourceSchema.parse(value));
    resources.forEach((resource, index) => assert.equal(resource.id.toLowerCase(), expectedIds[index].toLowerCase(),
      "Azure returned an unexpected scheduled observation resource."));
    const metadata = z.object({ properties: z.object({
      latestReadyRevisionName: z.string(),
      configuration: z.object({ ingress: z.object({ fqdn: z.string() }) }),
    }) }).parse(web).properties;
    const origin = `https://${metadata.configuration.ingress.fqdn}`;
    const revision = z.array(z.object({ name: z.string() }).passthrough()).parse(revisions)
      .find((value) => value.name === metadata.latestReadyRevisionName);
    assert(revision, "The ready revision is missing from the inventory.");
    const revisionTemplate = z.object({ properties: z.object({ template: templateSchema }) })
      .parse(revision).properties.template;
    for (const container of [
      templateSchema.parse(resources[0].properties.template).containers[0], revisionTemplate.containers[0],
    ]) {
      assert.equal(nonsecretValue(container, "APP_ORIGIN"), origin, "The web origin changed.");
    }
    for (const [job, cron, retries] of [[hourly, "0 * * * *", 1], [daily, "5 0 * * *", 0]] as const) {
      const configuration = z.object({ properties: z.object({
        provisioningState: z.literal("Succeeded"),
        configuration: z.object({
          triggerType: z.literal("Schedule"), replicaRetryLimit: z.number(),
          replicaTimeout: z.literal(300), manualTriggerConfig: z.null().optional(),
          eventTriggerConfig: z.null().optional(),
          scheduleTriggerConfig: z.object({
            cronExpression: z.string(), parallelism: z.literal(1), replicaCompletionCount: z.literal(1),
          }),
        }),
      }) }).parse(job).properties.configuration;
      assert.equal(configuration.scheduleTriggerConfig.cronExpression, cron, "A scheduler cron changed.");
      assert.equal(configuration.replicaRetryLimit, retries, "A scheduler retry limit changed.");
    }
    const hourlyTemplate = schedulerTemplate(resources[1].properties.template, args.hourlyJob,
      args.expectedImage, origin, namespace);
    const dailyTemplate = schedulerTemplate(resources[2].properties.template, args.dailyJob, args.expectedImage, origin);
    z.object({ properties: z.object({
      provisioningState: z.literal("Succeeded"),
      configuration: z.object({
        triggerType: z.literal("Manual"), replicaRetryLimit: z.literal(0),
        scheduleTriggerConfig: z.null().optional(), eventTriggerConfig: z.null().optional(),
        manualTriggerConfig: z.object({ parallelism: z.literal(1), replicaCompletionCount: z.literal(1) }),
      }),
    }) }).parse(ops);
    const opsContainer = templateSchema.parse(resources[3].properties.template).containers[0];
    assert.equal(opsContainer.image, args.expectedOpsImage, "The operations image changed.");
    for (const [key, value] of Object.entries({
      OPERATION: "target-smoke", ENVIRONMENT_NAME: "prod", RELEASE_SHA: args.releaseSha,
      IMAGE_DIGEST: imageDigest, OPS_IMAGE_DIGEST: opsImageDigest, TARGET_BASE_URL: origin,
      DEPLOYMENT_REPOSITORY: trust.repository, DEPLOYMENT_REPOSITORY_ID: trust.repositoryId,
      DEPLOYMENT_REPOSITORY_OWNER_ID: trust.repositoryOwnerId,
    })) assert.equal(nonsecretValue(opsContainer, key), value, "An operations observation binding changed.");
    assert(Date.now() >= started && Date.now() - started <= 90_000, "Runtime snapshot exceeded 90 seconds.");
    return {
      revision: metadata.latestReadyRevisionName, targetOrigin: origin, hourlyTemplate, dailyTemplate,
      resources: { web: resources[0].id, hourly: resources[1].id, daily: resources[2].id, ops: resources[3].id },
    };
  }

  const initial = await snapshot();
  const enabled = Date.now();
  const firstWindow = (Math.floor(enabled / 3_600_000) + 1) * 3_600_000;
  const deadline = Math.min(firstWindow + 900_000, enabled + SCHEDULE_OBSERVATION_MAX_AGE_MS);
  while (true) {
    const now = Date.now();
    assert(now >= enabled && now < deadline, "Timed out or clock moved backwards while observing the scheduled window.");
    if (now < firstWindow) {
      await sleep(Math.min(15_000, firstWindow - now));
      continue;
    }
    const candidate = windowExecution(await readJobExecutions(initial.resources.hourly, read), firstWindow);
    if (candidate?.properties.status === "Succeeded") {
      const observedAt = new Date().toISOString();
      const [current, inventory, raw] = await Promise.all([
        snapshot(),
        readJobExecutions(initial.resources.hourly, read, Date.parse(observedAt)),
        read(["rest", "--method", "get", "--url",
          `https://management.azure.com${candidate.id}?api-version=2023-05-01`,
          "--subscription", subscription, "--output", "json"]),
      ]);
      assert.deepEqual(current, initial, "The observed runtime or schedule changed after verified enablement.");
      const confirmed = windowExecution(inventory, firstWindow);
      assert(confirmed?.id === candidate.id && confirmed.properties.status === "Succeeded",
        "The selected execution changed during final readback.");
      const execution = z.object({
        id: z.string().optional(), name: z.string(),
        properties: z.object({
          status: z.literal("Succeeded"), startTime: z.string(), endTime: z.string(), template: z.unknown(),
        }),
      }).parse(raw);
      assert(execution.name === candidate.name &&
        (execution.id === undefined || execution.id.toLowerCase() === candidate.id.toLowerCase()),
      "Execution detail does not match the exact requested inventory resource.");
      const startedAt = azureTimestamp(execution.properties.startTime);
      const completedAt = azureTimestamp(execution.properties.endTime);
      assert.equal(startedAt, azureTimestamp(confirmed.properties.startTime), "Execution start readback disagrees.");
      if (confirmed.properties.endTime !== undefined) {
        assert.equal(completedAt, azureTimestamp(confirmed.properties.endTime), "Execution end readback disagrees.");
      }
      const template = schedulerTemplate(execution.properties.template, args.hourlyJob,
        args.expectedImage, initial.targetOrigin, namespace);
      assert.deepEqual(template, current.hourlyTemplate, "The actual execution used a different template.");
      const finished = new Date().toISOString();
      assert(Date.parse(finished) >= Date.parse(observedAt) &&
        Date.parse(finished) - Date.parse(observedAt) <= 90_000 &&
        Date.parse(finished) < deadline, "Scheduled readback exceeded its bounded observation interval.");
      return scheduledExecutionObservationSchema.parse({
        schemaVersion: 1, purpose: "scheduled-execution",
        workflow: { ...trust, sha: args.releaseSha, runId, runAttempt },
        observedAt, completedAt: finished, operationExecutionId: args.operationExecutionId,
        releaseSha: args.releaseSha, imageDigest, opsImageDigest, targetOrigin: initial.targetOrigin,
        resources: initial.resources, revision: initial.revision,
        authorizationId: args.authorizationId, scheduleGeneration: args.scheduleGeneration,
        scheduleEnabledAt: new Date(enabled).toISOString(),
        rolloutMode: "paper", hourlyTriggerType: "Schedule", dailyTriggerType: "Schedule",
        hourlyCron: "0 * * * *", dailyCron: "5 0 * * *", inactiveRevisionsQuiescent: true,
        originAssurance: "schedule-observed-not-origin-proven",
        execution: {
          id: candidate.id, name: candidate.name, status: "Succeeded", startedAt, completedAt, imageDigest,
          templateDigest: createHash("sha256").update(canonicalObservationJson(template)).digest("hex"),
        },
      });
    }
    await sleep(Math.min(15_000, Math.max(0, deadline - Date.now())));
  }
}

export async function attestScheduledExecution(argv: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: Object.fromEntries([
      "resource-group", "web-app", "hourly-job", "daily-job", "ops-job", "expected-image",
      "expected-ops-image", "release-sha", "authorization-id", "schedule-generation",
      "job-execution-id", "proof-output", "receipt-output",
    ].map((key) => [key, { type: "string" as const }])),
    strict: true, allowPositionals: false,
  });
  const required = (key: string) => z.string().min(1).parse(values[key]);
  const proofPath = required("proof-output");
  const receiptPath = required("receipt-output");
  assert(proofPath !== receiptPath, "Private proof and nonsecret receipt need distinct paths.");
  const observation = await collectScheduledExecutionObservation({
    resourceGroup: required("resource-group"), webApp: required("web-app"),
    hourlyJob: required("hourly-job"), dailyJob: required("daily-job"), opsJob: required("ops-job"),
    expectedImage: required("expected-image"), expectedOpsImage: required("expected-ops-image"),
    releaseSha: required("release-sha"), authorizationId: required("authorization-id"),
    scheduleGeneration: Number(z.string().regex(/^[1-9][0-9]{0,9}$/).parse(required("schedule-generation"))),
    operationExecutionId: required("job-execution-id"),
  }, env);
  const { proof, receipt } = await attestCollectedObservation(observation, env);
  await writeObservationFiles(proofPath, receiptPath, proof, receipt);
  process.stdout.write(`Attested Azure scheduled-window observation ${receipt.observationDigest}; trigger origin is not exposed by Azure.\n`);
}

if (process.argv[1] && /attest-scheduled-execution\.(ts|js)$/.test(process.argv[1])) {
  attestScheduledExecution(process.argv.slice(2), process.env).catch((error: unknown) => {
    const kind = error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name) ? error.name : "Error";
    process.stderr.write(`Scheduled-execution attestation failed (${kind}); paper-production completion is not verified.\n`);
    process.exitCode = 1;
  });
}
