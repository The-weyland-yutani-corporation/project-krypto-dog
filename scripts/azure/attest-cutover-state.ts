import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { open, unlink } from "node:fs/promises";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { z } from "zod";
import { validateDisabledRollout } from "../../.github/scripts/azure/lib/disabled-rollout.cjs";
import { deploymentFenceOwner } from "../../.github/scripts/azure/lib/deployment-owner.cjs";
import { readJobExecutions } from "../../.github/scripts/azure/lib/job-executions.cjs";
import {
  cutoverObservationSchema,
  verifyWorkflowObservation,
  workflowObservationAudience,
  workflowObservationTrustSchema,
  WORKFLOW_OBSERVATION_MAX_BYTES,
  WORKFLOW_OBSERVATION_PATH,
  type CutoverObservation,
  type WorkflowObservationReceipt,
} from "../../src/deployment/workflow-observation";

const execute = promisify(execFile);
const name = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
const inputSchema = z.object({
  resourceGroup: z.string().regex(/^[A-Za-z0-9_.()-]{1,90}$/),
  webApp: name, hourlyJob: name, dailyJob: name, opsJob: name,
  expectedImage: z.string().regex(/^[a-z0-9.-]+\/krypto-web@sha256:[0-9a-f]{64}$/),
  owner: cutoverObservationSchema.shape.owner,
  sourceReleaseSha: cutoverObservationSchema.shape.sourceReleaseSha,
  sourceImageDigest: cutoverObservationSchema.shape.sourceImageDigest,
  candidateReleaseSha: cutoverObservationSchema.shape.candidateReleaseSha,
  runtimeReleaseSha: cutoverObservationSchema.shape.releaseSha,
  operationExecutionId: cutoverObservationSchema.shape.operationExecutionId,
}).strict();
type CollectorInput = z.infer<typeof inputSchema>;
type ReadAzure = (args: string[]) => Promise<unknown>;
const container = z.object({
  image: z.string(),
  env: z.array(z.object({
    name: z.string(), value: z.string().optional(), secretRef: z.string().optional(),
  })),
});
const resource = z.object({
  id: z.string(),
  properties: z.object({ template: z.object({ containers: z.array(container).length(1) }) }),
});

function valueOf(entry: z.infer<typeof container>, key: string): string {
  const matches = entry.env.filter((item) => item.name === key);
  assert(matches.length === 1 && typeof matches[0].value === "string" && matches[0].secretRef === undefined,
    `${key} must have exactly one nonsecret value in Azure readback.`);
  return matches[0].value;
}

async function readAzure(args: string[]): Promise<unknown> {
  let stdout: string;
  try {
    ({ stdout } = await execute("az", args, { encoding: "utf8", timeout: 45_000, maxBuffer: 16 * 1024 * 1024 }));
  } catch {
    throw new Error("Azure read-only cutover collection failed; no observation can be issued.");
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error("Azure cutover readback was not JSON.");
  }
}

export async function collectCutoverObservation(
  input: CollectorInput,
  env: NodeJS.ProcessEnv,
  read: ReadAzure = readAzure,
): Promise<CutoverObservation> {
  const args = inputSchema.parse(input);
  const trust = workflowObservationTrustSchema.parse({
    repository: env.GITHUB_REPOSITORY,
    repositoryId: env.GITHUB_REPOSITORY_ID,
    repositoryOwnerId: env.GITHUB_REPOSITORY_OWNER_ID,
  });
  const runId = z.string().regex(/^[1-9][0-9]{0,19}$/).parse(env.GITHUB_RUN_ID);
  const attempt = z.string().regex(/^[1-9][0-9]*$/).transform(Number).pipe(z.number().int().positive().safe())
    .parse(env.GITHUB_RUN_ATTEMPT);
  const subscription = z.guid().parse(env.AZURE_SUBSCRIPTION_ID);
  assert(env.GITHUB_ACTIONS === "true" && env.GITHUB_REF === "refs/heads/main" &&
    ["workflow_dispatch", "workflow_run"].includes(env.GITHUB_EVENT_NAME ?? "") &&
    env.GITHUB_WORKFLOW_REF === `${trust.repository}/${WORKFLOW_OBSERVATION_PATH}@refs/heads/main` &&
    env.GITHUB_WORKFLOW_SHA === args.candidateReleaseSha && env.GITHUB_SHA === args.candidateReleaseSha,
  "Cutover observations require this exact main-branch production workflow and source SHA.");
  assert(args.owner === deploymentFenceOwner(trust.repositoryId, runId),
    "The cutover owner does not belong to this trusted workflow run.");
  const observedAt = new Date().toISOString();
  const prefix = `/subscriptions/${subscription}/resourceGroups/${args.resourceGroup}/providers/Microsoft.App`;
  const expectedIds = [
    `${prefix}/containerApps/${args.webApp}`, `${prefix}/jobs/${args.hourlyJob}`,
    `${prefix}/jobs/${args.dailyJob}`, `${prefix}/jobs/${args.opsJob}`,
  ];
  const suffix = ["--resource-group", args.resourceGroup, "--subscription", subscription, "--output", "json"];
  const [web, revisions, hourly, daily, hourlyExecutions, dailyExecutions, ops] = await Promise.all([
    read(["containerapp", "show", "--name", args.webApp, ...suffix]),
    read(["containerapp", "revision", "list", "--name", args.webApp, "--all", ...suffix]),
    read(["containerapp", "job", "show", "--name", args.hourlyJob, ...suffix]),
    read(["containerapp", "job", "show", "--name", args.dailyJob, ...suffix]),
    readJobExecutions(expectedIds[1], read, Date.parse(observedAt)),
    readJobExecutions(expectedIds[2], read, Date.parse(observedAt)),
    read(["containerapp", "job", "show", "--name", args.opsJob, ...suffix]),
  ]);
  validateDisabledRollout({ web, revisions, hourly, daily, hourlyExecutions, dailyExecutions }, args.expectedImage);
  const resources = [web, hourly, daily, ops].map((item) => resource.parse(item));
  resources.forEach((item, index) => assert.equal(item.id.toLowerCase(), expectedIds[index].toLowerCase(),
    "Azure returned an unexpected cutover resource identity."));
  const [webResource, hourlyResource, dailyResource, opsResource] = resources;
  const metadata = z.object({ properties: z.object({
    latestReadyRevisionName: z.string(),
    configuration: z.object({ ingress: z.object({ fqdn: z.string() }) }),
  }) }).parse(web).properties;
  const targetOrigin = `https://${metadata.configuration.ingress.fqdn}`;
  const webContainer = webResource.properties.template.containers[0];
  const opsContainer = opsResource.properties.template.containers[0];
  const releaseSha = args.runtimeReleaseSha;
  const activeRevision = z.array(z.object({ name: z.string() }).passthrough())
    .parse(revisions).find((item) => item.name === metadata.latestReadyRevisionName);
  assert(activeRevision, "The active revision is absent from readback.");
  const revisionContainer = z.object({
    properties: z.object({ template: z.object({ containers: z.array(container).length(1) }) }),
  }).parse(activeRevision).properties.template.containers[0];
  for (const runtime of [webContainer, revisionContainer]) {
    assert.equal(valueOf(runtime, "APP_ORIGIN"), targetOrigin, "The web origin does not match Azure ingress.");
  }
  for (const runtime of [
    hourlyResource.properties.template.containers[0], dailyResource.properties.template.containers[0],
  ]) {
    assert.equal(valueOf(runtime, "TARGET_BASE_URL"), targetOrigin, "A scheduler targets a different web origin.");
  }
  const imageDigest = args.expectedImage.split("@")[1];
  const opsRelease = valueOf(opsContainer, "RELEASE_SHA");
  // Runtime containers carry their immutable image, not RELEASE_SHA. Bind that
  // image through the candidate ops metadata or the original owned source.
  const candidateImage = releaseSha === args.candidateReleaseSha &&
    opsRelease === args.candidateReleaseSha && valueOf(opsContainer, "IMAGE_DIGEST") === imageDigest;
  const sourceImage = releaseSha === args.sourceReleaseSha && imageDigest === args.sourceImageDigest &&
    [args.sourceReleaseSha, args.candidateReleaseSha].includes(opsRelease);
  assert(candidateImage || sourceImage, "The runtime image does not match the owned source or candidate release.");
  assert.equal(valueOf(opsContainer, "OPERATION"), "activation-check");
  assert.equal(valueOf(opsContainer, "ENVIRONMENT_NAME"), "prod");
  assert.equal(valueOf(opsContainer, "TARGET_ORIGIN"), targetOrigin);
  assert.equal(valueOf(opsContainer, "DEPLOYMENT_REPOSITORY"), trust.repository);
  assert.equal(valueOf(opsContainer, "DEPLOYMENT_REPOSITORY_ID"), trust.repositoryId);
  assert.equal(valueOf(opsContainer, "DEPLOYMENT_REPOSITORY_OWNER_ID"), trust.repositoryOwnerId);
  const opsDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/).parse(valueOf(opsContainer, "OPS_IMAGE_DIGEST"));
  assert.equal(opsContainer.image, `${args.expectedImage.split("/")[0]}/krypto-ops@${opsDigest}`,
    "The actual ops container does not match its declared digest and registry.");
  z.object({ properties: z.object({ configuration: z.object({
    triggerType: z.literal("Manual"), replicaRetryLimit: z.literal(0),
    manualTriggerConfig: z.object({ parallelism: z.literal(1), replicaCompletionCount: z.literal(1) }),
  }), provisioningState: z.literal("Succeeded") }) }).parse(ops);
  const completedAt = new Date().toISOString();
  assert(Date.parse(completedAt) - Date.parse(observedAt) <= 90_000, "Cutover readback exceeded 90 seconds.");
  return cutoverObservationSchema.parse({
    schemaVersion: 1, purpose: "cutover-release",
    workflow: { ...trust, sha: args.candidateReleaseSha, runId, runAttempt: attempt },
    observedAt, completedAt, operationExecutionId: args.operationExecutionId,
    releaseSha, imageDigest, opsImageDigest: opsDigest, targetOrigin,
    resources: { web: webResource.id, hourly: hourlyResource.id, daily: dailyResource.id, ops: opsResource.id },
    owner: args.owner, sourceReleaseSha: args.sourceReleaseSha,
    candidateReleaseSha: args.candidateReleaseSha, sourceImageDigest: args.sourceImageDigest,
    revision: metadata.latestReadyRevisionName, rolloutMode: "disabled",
    hourlyTriggerType: "Manual", dailyTriggerType: "Manual",
    inactiveRevisionsQuiescent: true, schedulerExecutionsQuiescent: true,
  });
}

export async function writeObservationFiles(
  proofPath: string,
  receiptPath: string,
  proof: string,
  receipt: WorkflowObservationReceipt,
): Promise<void> {
  const created: string[] = [];
  try {
    for (const [path, content] of [[proofPath, proof], [receiptPath, JSON.stringify(receipt)]]) {
      const file = await open(path, "wx", 0o600);
      created.push(path);
      try {
        await file.writeFile(content, "utf8");
      } finally {
        await file.close();
      }
    }
  } catch (error) {
    await Promise.all(created.map((path) => unlink(path)));
    throw error;
  }
}

let attestationStage = "arguments";

export async function attestCutoverState(argv: string[], env: NodeJS.ProcessEnv): Promise<void> {
  attestationStage = "arguments";
  const { values } = parseArgs({
    args: argv,
    options: Object.fromEntries([
      "resource-group", "web-app", "hourly-job", "daily-job", "ops-job", "expected-image",
      "owner", "source-release-sha", "source-image-digest", "candidate-release-sha",
      "runtime-release-sha", "job-execution-id", "proof-output", "receipt-output",
    ].map((key) => [key, { type: "string" as const }])),
    strict: true, allowPositionals: false,
  });
  const required = (key: string) => z.string().min(1).parse(values[key]);
  const proofPath = required("proof-output");
  const receiptPath = required("receipt-output");
  assert(proofPath !== receiptPath, "Private proof and nonsecret receipt need distinct paths.");
  attestationStage = "Azure read-only collection";
  const observation = await collectCutoverObservation({
    resourceGroup: required("resource-group"), webApp: required("web-app"),
    hourlyJob: required("hourly-job"), dailyJob: required("daily-job"), opsJob: required("ops-job"),
    expectedImage: required("expected-image"), owner: required("owner"),
    sourceReleaseSha: required("source-release-sha"), sourceImageDigest: required("source-image-digest"),
    candidateReleaseSha: required("candidate-release-sha"), runtimeReleaseSha: required("runtime-release-sha"),
    operationExecutionId: required("job-execution-id"),
  }, env);
  attestationStage = "GitHub OIDC request";
  const request = new URL(z.string().min(1).parse(env.ACTIONS_ID_TOKEN_REQUEST_URL));
  assert(request.protocol === "https:" && request.hostname.endsWith(".actions.githubusercontent.com") &&
    !request.username && !request.password && !request.port, "Unexpected GitHub OIDC request endpoint.");
  request.searchParams.set("audience", workflowObservationAudience(observation));
  const requestToken = z.string().min(1).parse(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN);
  let response: Response;
  try {
    response = await fetch(request, {
      headers: { Authorization: `Bearer ${requestToken}` },
      redirect: "error", signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("GitHub workflow-observation token request failed.");
  }
  assert(response.ok, `GitHub workflow-observation token request failed (${response.status}).`);
  const tokenResult = z.object({
    value: z.string().max(12_000).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
  }).safeParse(await response.json());
  assert(tokenResult.success, "GitHub returned an invalid workflow-observation token.");
  const token = tokenResult.data.value;
  process.stdout.write(`::add-mask::${token}\n`);
  const proof = JSON.stringify({ observation, token });
  assert(Buffer.byteLength(proof, "utf8") <= WORKFLOW_OBSERVATION_MAX_BYTES, "Observation proof exceeds its bound.");
  attestationStage = "workflow proof verification";
  const verified = await verifyWorkflowObservation(proof, {
    ...observation.workflow, workflowSha: observation.workflow.sha,
    purpose: "cutover-release", operationExecutionId: observation.operationExecutionId,
  });
  attestationStage = "private proof publication";
  await writeObservationFiles(proofPath, receiptPath, proof, verified.receipt);
  process.stdout.write(`Attested disabled cutover ${verified.receipt.observationDigest}.\n`);
}

if (process.argv[1] && /attest-cutover-state\.(ts|js)$/.test(process.argv[1])) {
  attestCutoverState(process.argv.slice(2), process.env).catch((error: unknown) => {
    const kind = error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)
      ? error.name : "Error";
    process.stderr.write(`Cutover attestation failed during ${attestationStage} (${kind}); no fence release is authorized.\n`);
    process.exitCode = 1;
  });
}
