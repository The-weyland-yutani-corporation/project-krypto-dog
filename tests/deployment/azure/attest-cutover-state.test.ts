import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChildProcess, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  attestCutoverState, collectCutoverObservation, writeObservationFiles,
} from "../../../scripts/azure/attest-cutover-state";
import { deploymentFenceOwner } from "../../../.github/scripts/azure/lib/deployment-owner.cjs";
import {
  verifyWorkflowObservation, WORKFLOW_OBSERVATION_ISSUER, WORKFLOW_OBSERVATION_PATH,
  type WorkflowObservationReceipt,
} from "@/deployment/workflow-observation";
import { signedCutoverFixture } from "../workflow-observation-fixture";

jest.mock("node:child_process", () => {
  const actual = jest.requireActual<typeof import("node:child_process")>("node:child_process");
  const { promisify } = jest.requireActual<typeof import("node:util")>("node:util");
  const execute = jest.fn();
  Object.defineProperty(execute, promisify.custom, { value: jest.fn() });
  return { ...actual, execFile: execute };
});
jest.mock("@/deployment/workflow-observation", () => ({
  ...jest.requireActual("@/deployment/workflow-observation"), verifyWorkflowObservation: jest.fn(),
}));

const mockedExecute = jest.mocked(promisify(execFile));
const mockedVerify = jest.mocked(verifyWorkflowObservation);
const actualObservation = jest.requireActual<typeof import("@/deployment/workflow-observation")>(
  "@/deployment/workflow-observation",
);

const now = new Date("2026-10-21T12:00:00.000Z");
const candidate = "b".repeat(40);
const source = "a".repeat(40);
const sourceDigest = `sha256:${"c".repeat(64)}`;
const digest = `sha256:${"d".repeat(64)}`;
const opsDigest = `sha256:${"e".repeat(64)}`;
const image = `registry.example/krypto-web@${digest}`;
const origin = "https://ca-prod-web.example.com";
const repository = "owner/project";
const subscription = "00000000-0000-0000-0000-000000000001";
const prefix = `/subscriptions/${subscription}/resourceGroups/rg-krypto-prod/providers/Microsoft.App`;
const env = {
  GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/main", GITHUB_SHA: candidate,
  GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REPOSITORY: repository,
  GITHUB_REPOSITORY_ID: "456", GITHUB_REPOSITORY_OWNER_ID: "789",
  GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", GITHUB_WORKFLOW_SHA: candidate,
  GITHUB_WORKFLOW_REF: `${repository}/${WORKFLOW_OBSERVATION_PATH}@refs/heads/main`,
  AZURE_SUBSCRIPTION_ID: subscription,
};
const input = {
  resourceGroup: "rg-krypto-prod", webApp: "ca-prod-web", hourlyJob: "caj-prod-agent-run",
  dailyJob: "caj-prod-daily-summary", opsJob: "caj-prod-activation-check", expectedImage: image,
  owner: deploymentFenceOwner(env.GITHUB_REPOSITORY_ID, env.GITHUB_RUN_ID),
  sourceReleaseSha: source, sourceImageDigest: sourceDigest,
  candidateReleaseSha: candidate, runtimeReleaseSha: candidate, operationExecutionId: "run123-a1-release",
};
const executionUrl = (job: string) =>
  `https://management.azure.com${prefix}/jobs/${job}/executions?api-version=2023-05-01`;

function fixture() {
  const webTemplate = {
    containers: [{
      image,
      env: [{ name: "ROLLOUT_MODE", value: "disabled" }, { name: "APP_ORIGIN", value: origin }],
    }],
  };
  const web = {
    id: `${prefix}/containerApps/${input.webApp}`,
    properties: {
      provisioningState: "Succeeded", latestRevisionName: "ca-prod-web--candidate",
      latestReadyRevisionName: "ca-prod-web--candidate",
      configuration: { activeRevisionsMode: "Single", ingress: { fqdn: new URL(origin).hostname } },
      template: structuredClone(webTemplate),
    },
  };
  const activeRevision = {
    name: web.properties.latestRevisionName,
    properties: {
      active: true, provisioningState: "Provisioned", healthState: "Healthy",
      template: structuredClone(webTemplate),
    },
  };
  const retiredRevision = {
    name: "ca-prod-web--previous",
    properties: { active: false, replicas: 0, provisioningState: "Deprovisioned" },
  };
  const makeJob = (name: string) => ({
    id: `${prefix}/jobs/${name}`,
    properties: {
      provisioningState: "Succeeded",
      configuration: {
        triggerType: "Manual", replicaRetryLimit: 0,
        manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 },
      },
      template: { containers: [{
        image,
        env: [{ name: "ROLLOUT_MODE", value: "disabled" }, { name: "TARGET_BASE_URL", value: origin }],
      }] },
    },
  });
  const hourly = makeJob(input.hourlyJob);
  const daily = makeJob(input.dailyJob);
  const ops = makeJob(input.opsJob);
  ops.properties.template.containers[0] = {
    image: `registry.example/krypto-ops@${opsDigest}`,
    env: [
      { name: "RELEASE_SHA", value: candidate },
      { name: "IMAGE_DIGEST", value: digest },
      { name: "OPS_IMAGE_DIGEST", value: opsDigest },
      { name: "OPERATION", value: "activation-check" },
      { name: "ENVIRONMENT_NAME", value: "prod" },
      { name: "TARGET_ORIGIN", value: origin },
      { name: "DEPLOYMENT_REPOSITORY", value: repository },
      { name: "DEPLOYMENT_REPOSITORY_ID", value: env.GITHUB_REPOSITORY_ID },
      { name: "DEPLOYMENT_REPOSITORY_OWNER_ID", value: env.GITHUB_REPOSITORY_OWNER_ID },
    ],
  };
  const hourlyExecutions = [{
    id: `${hourly.id}/executions/hourly-previous`, name: "hourly-previous", properties: { status: "Succeeded" },
  }];
  const dailyExecutions = [{
    id: `${daily.id}/executions/daily-previous`, name: "daily-previous", properties: { status: "Stopped" },
  }];
  const executionPages = new Map<string, unknown>([
    [executionUrl(input.hourlyJob), { value: hourlyExecutions }],
    [executionUrl(input.dailyJob), { value: dailyExecutions }],
  ]);
  const read = jest.fn(async (args: string[]): Promise<unknown> => {
    if (args[0] === "rest") {
      const url = args[args.indexOf("--url") + 1];
      if (!executionPages.has(url)) throw new Error("Unexpected Azure execution page.");
      return executionPages.get(url);
    }
    if (args[1] === "show") return web;
    if (args[1] === "revision") return [activeRevision, retiredRevision];
    const jobName = args[args.indexOf("--name") + 1];
    return jobName === input.opsJob ? ops : jobName === input.hourlyJob ? hourly : daily;
  });
  const opsValue = (name: string, value: string) => {
    const setting = ops.properties.template.containers[0].env.find((entry) => entry.name === name);
    if (!setting) throw new Error(`Missing fixture setting: ${name}`);
    setting.value = value;
  };
  const runtimeContainers = [
    web.properties.template.containers[0], activeRevision.properties.template.containers[0],
    hourly.properties.template.containers[0], daily.properties.template.containers[0],
  ];
  return {
    web, activeRevision, retiredRevision, hourly, daily, ops, hourlyExecutions, dailyExecutions,
    read, opsValue, runtimeContainers, executionPages,
  };
}

describe("trusted Azure cutover readback", () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(now); });
  afterEach(() => { jest.useRealTimers(); });

  it("uses actual immutable runtime images without inventing runtime RELEASE_SHA metadata", async () => {
    const state = fixture();
    expect(state.runtimeContainers.every((item) => !item.env.some((entry) => entry.name === "RELEASE_SHA"))).toBe(true);
    const result = await collectCutoverObservation(input, env, state.read);
    expect(result).toMatchObject({
      purpose: "cutover-release", releaseSha: candidate, imageDigest: digest, opsImageDigest: opsDigest,
      targetOrigin: origin, owner: input.owner, operationExecutionId: input.operationExecutionId,
      observedAt: now.toISOString(), completedAt: now.toISOString(),
      resources: { web: state.web.id, hourly: state.hourly.id, daily: state.daily.id, ops: state.ops.id },
    });
    const suffix = ["--resource-group", input.resourceGroup, "--subscription", subscription, "--output", "json"];
    expect(state.read.mock.calls).toEqual([
      [["containerapp", "show", "--name", input.webApp, ...suffix]],
      [["containerapp", "revision", "list", "--name", input.webApp, "--all", ...suffix]],
      [["containerapp", "job", "show", "--name", input.hourlyJob, ...suffix]],
      [["containerapp", "job", "show", "--name", input.dailyJob, ...suffix]],
      [["rest", "--method", "get", "--url", executionUrl(input.hourlyJob), "--subscription", subscription, "--output", "json"]],
      [["rest", "--method", "get", "--url", executionUrl(input.dailyJob), "--subscription", subscription, "--output", "json"]],
      [["containerapp", "job", "show", "--name", input.opsJob, ...suffix]],
    ]);
  });

  it("refuses to attest an active execution hidden behind a terminal first page", async () => {
    const state = fixture();
    const nextLink = `${executionUrl(input.hourlyJob)}&$skiptoken=second`;
    state.executionPages.set(executionUrl(input.hourlyJob), { value: state.hourlyExecutions, nextLink });
    state.executionPages.set(nextLink, {
      value: [{
        id: `${state.hourly.id}/executions/hourly-active`, name: "hourly-active",
        properties: { status: "Running" },
      }],
    });
    await expect(collectCutoverObservation(input, env, state.read)).rejects.toThrow(/still active/);
    expect(state.read).toHaveBeenCalledWith([
      "rest", "--method", "get", "--url", nextLink, "--subscription", subscription, "--output", "json",
    ]);
  });

  it.each([
    ["GITHUB_ACTIONS", "false"], ["GITHUB_REF", "refs/heads/topic"], ["GITHUB_SHA", source],
    ["GITHUB_WORKFLOW_SHA", source], ["GITHUB_EVENT_NAME", "pull_request"],
    ["GITHUB_WORKFLOW_REF", `${repository}/.github/workflows/other.yml@refs/heads/main`],
    ["GITHUB_RUN_ID", "124"], ["GITHUB_RUN_ATTEMPT", "0"], ["GITHUB_REPOSITORY_ID", "999"],
    ["AZURE_SUBSCRIPTION_ID", "not-a-guid"],
  ])("rejects untrusted %s before Azure access", async (key, value) => {
    const { read } = fixture();
    await expect(collectCutoverObservation(input, { ...env, [key]: value }, read)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid owner", { owner: "11111111-1111-4111-8111-111111111111" }],
    ["mutable image", { expectedImage: "registry.example/krypto-web:latest" }],
    ["unknown input", { signedObservation: "{}" }],
  ])("rejects %s before Azure access", async (_label, change) => {
    const { read } = fixture();
    await expect(collectCutoverObservation({ ...input, ...change }, env, read)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong resource", (state: ReturnType<typeof fixture>) => { state.hourly.id = state.daily.id; }],
    ["wrong subscription", (state: ReturnType<typeof fixture>) => { state.web.id = state.web.id.replace(subscription, "11111111-1111-1111-1111-111111111111"); }],
    ["unready web", (state: ReturnType<typeof fixture>) => { state.web.properties.latestReadyRevisionName = "older"; }],
    ["wrong runtime image", (state: ReturnType<typeof fixture>) => { state.runtimeContainers[2].image = "registry.example/krypto-web:latest"; }],
    ["enabled web", (state: ReturnType<typeof fixture>) => { state.runtimeContainers[0].env[0].value = "paper"; }],
    ["wrong origin", (state: ReturnType<typeof fixture>) => { state.runtimeContainers[1].env[1].value = "https://other.example.com"; }],
    ["wrong scheduler target", (state: ReturnType<typeof fixture>) => { state.runtimeContainers[3].env[1].value = "https://other.example.com"; }],
    ["active old revision", (state: ReturnType<typeof fixture>) => { state.retiredRevision.properties.active = true; }],
    ["old replicas", (state: ReturnType<typeof fixture>) => { state.retiredRevision.properties.replicas = 1; }],
    ["unhealthy revision", (state: ReturnType<typeof fixture>) => { state.activeRevision.properties.healthState = "Unhealthy"; }],
    ["enabled hourly", (state: ReturnType<typeof fixture>) => { state.hourly.properties.configuration.triggerType = "Schedule"; }],
    ["enabled daily", (state: ReturnType<typeof fixture>) => { state.daily.properties.configuration.triggerType = "Schedule"; }],
    ["running execution", (state: ReturnType<typeof fixture>) => { state.hourlyExecutions[0].properties.status = "Running"; }],
    ["unknown execution", (state: ReturnType<typeof fixture>) => { state.dailyExecutions[0].properties.status = "Unknown"; }],
    ["ops retries", (state: ReturnType<typeof fixture>) => { state.ops.properties.configuration.replicaRetryLimit = 1; }],
    ["parallel ops", (state: ReturnType<typeof fixture>) => { state.ops.properties.configuration.manualTriggerConfig.parallelism = 2; }],
    ["ops not provisioned", (state: ReturnType<typeof fixture>) => { state.ops.properties.provisioningState = "Updating"; }],
    ["wrong ops image", (state: ReturnType<typeof fixture>) => { state.ops.properties.template.containers[0].image = image; }],
    ["missing trust", (state: ReturnType<typeof fixture>) => {
      state.ops.properties.template.containers[0].env = state.ops.properties.template.containers[0].env
        .filter((entry) => entry.name !== "DEPLOYMENT_REPOSITORY_ID");
    }],
    ["duplicate trust", (state: ReturnType<typeof fixture>) => {
      state.ops.properties.template.containers[0].env.push({ name: "DEPLOYMENT_REPOSITORY_ID", value: env.GITHUB_REPOSITORY_ID });
    }],
  ])("does not attest %s", async (_label, change) => {
    const state = fixture();
    change(state);
    await expect(collectCutoverObservation(input, env, state.read)).rejects.toThrow();
  });

  it.each([
    ["RELEASE_SHA", "f".repeat(40)], ["IMAGE_DIGEST", sourceDigest], ["OPS_IMAGE_DIGEST", digest],
    ["ENVIRONMENT_NAME", "dev"], ["OPERATION", "target-smoke"], ["TARGET_ORIGIN", "https://other.example.com"],
    ["DEPLOYMENT_REPOSITORY", "another/project"], ["DEPLOYMENT_REPOSITORY_ID", "999"],
    ["DEPLOYMENT_REPOSITORY_OWNER_ID", "999"],
  ])("rejects mismatched ops %s", async (key, value) => {
    const state = fixture();
    state.opsValue(key, value);
    await expect(collectCutoverObservation(input, env, state.read)).rejects.toThrow();
  });

  it("rejects a candidate claimed against source ops metadata", async () => {
    const state = fixture();
    state.opsValue("RELEASE_SHA", source);
    await expect(collectCutoverObservation(input, env, state.read)).rejects.toThrow(/owned source or candidate/);
  });

  it("can attest source compensation through the candidate ops image", async () => {
    const state = fixture();
    const expectedImage = `registry.example/krypto-web@${sourceDigest}`;
    state.runtimeContainers.forEach((entry) => { entry.image = expectedImage; });
    const result = await collectCutoverObservation({
      ...input, runtimeReleaseSha: source, expectedImage,
    }, env, state.read);
    expect(result).toMatchObject({ releaseSha: source, imageDigest: sourceDigest, opsImageDigest: opsDigest });
  });

  it("rejects a source compensation with the wrong original image", async () => {
    const state = fixture();
    await expect(collectCutoverObservation({
      ...input, runtimeReleaseSha: source,
    }, env, state.read)).rejects.toThrow(/owned source or candidate/);
  });

  it("can deploy a newly built candidate image when source and candidate SHA are identical", async () => {
    const state = fixture();
    expect(await collectCutoverObservation({
      ...input, sourceReleaseSha: candidate,
    }, env, state.read)).toMatchObject({ releaseSha: candidate, imageDigest: digest, sourceImageDigest: sourceDigest });
  });

  it("rejects oversized readback intervals", async () => {
    const state = fixture();
    state.read.mockImplementationOnce(async () => {
      jest.setSystemTime(new Date(now.getTime() + 90_001));
      return state.web;
    });
    await expect(collectCutoverObservation(input, env, state.read)).rejects.toThrow(/exceeded 90 seconds/);
  });
});

describe("private observation publication", () => {
  let directory: string;
  const receipt: WorkflowObservationReceipt = {
    issuer: WORKFLOW_OBSERVATION_ISSUER, purpose: "cutover-release",
    observationDigest: "d".repeat(64), repositoryId: "456", repositoryOwnerId: "789",
    workflowRef: env.GITHUB_WORKFLOW_REF, workflowSha: candidate, runId: "123", runAttempt: 1,
    observedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 180_000).toISOString(),
  };
  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "krypto-observation-")); });
  afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

  it("writes the bearer proof separately from the nonsecret receipt", async () => {
    const proofPath = path.join(directory, "proof.json");
    const receiptPath = path.join(directory, "receipt.json");
    await writeObservationFiles(proofPath, receiptPath, "private-proof", receipt);
    expect(fs.readFileSync(proofPath, "utf8")).toBe("private-proof");
    expect(JSON.parse(fs.readFileSync(receiptPath, "utf8"))).toEqual(receipt);
    expect(fs.readFileSync(receiptPath, "utf8")).not.toContain("private-proof");
    if (process.platform !== "win32") expect(fs.statSync(proofPath).mode & 0o777).toBe(0o600);
  });

  it("preserves an existing proof and does not publish a receipt", async () => {
    const proofPath = path.join(directory, "proof.json");
    const receiptPath = path.join(directory, "receipt.json");
    fs.writeFileSync(proofPath, "existing");
    await expect(writeObservationFiles(proofPath, receiptPath, "replacement", receipt)).rejects.toThrow();
    expect(fs.readFileSync(proofPath, "utf8")).toBe("existing");
    expect(fs.existsSync(receiptPath)).toBe(false);
  });

  it("removes its new proof if the nonsecret receipt cannot be published", async () => {
    const proofPath = path.join(directory, "proof.json");
    const receiptPath = path.join(directory, "receipt.json");
    fs.writeFileSync(receiptPath, "existing");
    await expect(writeObservationFiles(proofPath, receiptPath, "private-proof", receipt)).rejects.toThrow();
    expect(fs.existsSync(proofPath)).toBe(false);
    expect(fs.readFileSync(receiptPath, "utf8")).toBe("existing");
  });
});

describe("authenticated observation producer", () => {
  let directory: string;
  const requestEnv = {
    ...env,
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://pipelines.actions.githubusercontent.com/example/idtoken?api-version=2",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "test-request-token",
  };
  const argumentsFor = () => [
    "--resource-group", input.resourceGroup, "--web-app", input.webApp,
    "--hourly-job", input.hourlyJob, "--daily-job", input.dailyJob, "--ops-job", input.opsJob,
    "--expected-image", input.expectedImage, "--owner", input.owner,
    "--source-release-sha", source, "--candidate-release-sha", candidate,
    "--runtime-release-sha", candidate, "--source-image-digest", sourceDigest,
    "--job-execution-id", input.operationExecutionId,
    "--proof-output", path.join(directory, "proof.json"),
    "--receipt-output", path.join(directory, "receipt.json"),
  ];

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "krypto-producer-"));
    jest.useFakeTimers();
    jest.setSystemTime(now);
    mockedExecute.mockReset();
    mockedVerify.mockReset();
    jest.spyOn(process.stdout, "write").mockReturnValue(true);
    jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected unmocked token request"));
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  async function prepare(claims: Record<string, string> = {}) {
    const state = fixture();
    const observation = await collectCutoverObservation(input, env, state.read);
    const signed = await signedCutoverFixture(observation, now, {
      sub: "repo:owner@789/project@456:environment:production-deploy",
      repository: repository, repository_id: env.GITHUB_REPOSITORY_ID,
      repository_owner_id: env.GITHUB_REPOSITORY_OWNER_ID, workflow_ref: env.GITHUB_WORKFLOW_REF,
      ...claims,
    });
    mockedExecute.mockImplementation((command, args) => {
      expect(command).toBe("az");
      if (!Array.isArray(args) || !args.every((value) => typeof value === "string")) {
        throw new Error("Expected fixed Azure argv");
      }
      return Object.assign(state.read(args).then((value) => ({
        stdout: JSON.stringify(value), stderr: "",
      })), { child: new ChildProcess() });
    });
    jest.mocked(globalThis.fetch).mockResolvedValue(new Response(JSON.stringify({ value: signed.token })));
    mockedVerify.mockImplementation((proof, expected) =>
      actualObservation.verifyWorkflowObservation(proof, expected, { now, keys: signed.keys }));
    return { signed, observation };
  }

  it("requests the canonical digest audience, verifies the real signature, then writes private proof and public receipt", async () => {
    const { signed, observation } = await prepare();
    await attestCutoverState(argumentsFor(), requestEnv);
    expect(mockedExecute).toHaveBeenCalledTimes(7);
    const request = new URL(String(jest.mocked(globalThis.fetch).mock.calls[0][0]));
    expect(request.origin).toBe("https://pipelines.actions.githubusercontent.com");
    expect(request.searchParams.get("audience")).toBe(actualObservation.workflowObservationAudience(observation));
    expect(jest.mocked(globalThis.fetch).mock.calls[0][1]).toMatchObject({
      redirect: "error", headers: { Authorization: "Bearer test-request-token" },
    });
    const proof = fs.readFileSync(path.join(directory, "proof.json"), "utf8");
    const receipt = fs.readFileSync(path.join(directory, "receipt.json"), "utf8");
    expect(JSON.parse(proof)).toEqual({ observation, token: signed.token });
    expect(JSON.parse(receipt)).toMatchObject({
      purpose: "cutover-release", repositoryId: "456", repositoryOwnerId: "789",
      workflowSha: candidate, runId: "123", runAttempt: 1,
    });
    expect(receipt).not.toContain(signed.token);
    expect(mockedVerify).toHaveBeenCalledTimes(1);
    const output = jest.mocked(process.stdout.write).mock.calls.map(([value]) => String(value));
    expect(output[0]).toBe(`::add-mask::${signed.token}\n`);
    expect(output.slice(1).join("")).not.toContain(signed.token);
  });

  it.each([
    "http://pipelines.actions.githubusercontent.com/token",
    "https://actions.githubusercontent.com.evil.example/token",
    "https://user:password@pipelines.actions.githubusercontent.com/token",
    "https://pipelines.actions.githubusercontent.com:8443/token",
  ])("rejects an unsafe token endpoint %s without sending credentials", async (url) => {
    await prepare();
    await expect(attestCutoverState(argumentsFor(), {
      ...requestEnv, ACTIONS_ID_TOKEN_REQUEST_URL: url,
    })).rejects.toThrow(/Unexpected GitHub OIDC/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it("does not publish or log a rejected provider response", async () => {
    await prepare();
    jest.mocked(globalThis.fetch).mockResolvedValue(new Response("private-provider-response", { status: 403 }));
    await expect(attestCutoverState(argumentsFor(), requestEnv)).rejects.toThrow(/request failed \(403\)/);
    expect(mockedVerify).not.toHaveBeenCalled();
    expect(process.stdout.write).not.toHaveBeenCalled();
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it("rejects a multiline token before emitting a GitHub workflow command", async () => {
    await prepare();
    jest.mocked(globalThis.fetch).mockResolvedValue(new Response(JSON.stringify({
      value: "not-a-token\n::warning::untrusted",
    })));
    await expect(attestCutoverState(argumentsFor(), requestEnv)).rejects.toThrow(/invalid workflow-observation token/);
    expect(process.stdout.write).not.toHaveBeenCalled();
    expect(mockedVerify).not.toHaveBeenCalled();
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it("does not publish a signed token for a different audience", async () => {
    await prepare({ aud: "urn:wrong-observation" });
    await expect(attestCutoverState(argumentsFor(), requestEnv)).rejects.toThrow();
    expect(mockedVerify).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it("does not request an OIDC token when Azure collection fails", async () => {
    await prepare();
    mockedExecute.mockRejectedValue(new Error("private-provider-detail"));
    await expect(attestCutoverState(argumentsFor(), requestEnv)).rejects.toThrow(/Azure read-only cutover collection failed/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(process.stdout.write).not.toHaveBeenCalled();
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it("does not accept caller-supplied observation JSON", async () => {
    await expect(attestCutoverState([
      ...argumentsFor(), "--observation", "{}",
    ], requestEnv)).rejects.toThrow();
    expect(mockedExecute).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(fs.readdirSync(directory)).toEqual([]);
  });
});
