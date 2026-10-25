import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChildProcess, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import {
  attestScheduledExecution, collectScheduledExecutionObservation,
} from "../../../scripts/azure/attest-scheduled-execution";
import { canonicalObservationJson, verifyWorkflowObservation, WORKFLOW_OBSERVATION_PATH } from "@/deployment/workflow-observation";
import { signedScheduledFixture } from "../workflow-observation-fixture";

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

const execute = jest.mocked(promisify(execFile));
const actualObservation = jest.requireActual<typeof import("@/deployment/workflow-observation")>(
  "@/deployment/workflow-observation",
);
const NOW = new Date("2026-10-21T11:59:50Z");
const firstWindow = Date.parse("2026-10-21T12:00:00Z");
const subscription = "00000000-0000-0000-0000-000000000001";
const prefix = `/subscriptions/${subscription}/resourceGroups/rg-prod/providers/Microsoft.App`;
const origin = "https://ca-prod-web.example.com";
const releaseSha = "a".repeat(40);
const imageDigest = `sha256:${"b".repeat(64)}`;
const opsDigest = `sha256:${"c".repeat(64)}`;
const input = {
  resourceGroup: "rg-prod", webApp: "ca-prod-web", hourlyJob: "caj-prod-agent-run",
  dailyJob: "caj-prod-daily-summary", opsJob: "caj-prod-target-smoke",
  expectedImage: `registry.example/krypto-web@${imageDigest}`,
  expectedOpsImage: `registry.example/krypto-ops@${opsDigest}`,
  releaseSha, authorizationId: "d".repeat(64), scheduleGeneration: NOW.getTime() / 1000 - 5,
  operationExecutionId: "run123-a1-scheduled",
};
const env = {
  GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/main", GITHUB_SHA: releaseSha,
  GITHUB_WORKFLOW_SHA: releaseSha, GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REPOSITORY: "owner/project", GITHUB_REPOSITORY_ID: "456", GITHUB_REPOSITORY_OWNER_ID: "789",
  GITHUB_WORKFLOW_REF: `owner/project/${WORKFLOW_OBSERVATION_PATH}@refs/heads/main`,
  GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", AZURE_SUBSCRIPTION_ID: subscription,
};
const inventoryUrl = `https://management.azure.com${prefix}/jobs/${input.hourlyJob}/executions?api-version=2023-05-01`;

function fixture() {
  const webTemplate = { containers: [{
    image: input.expectedImage,
    env: [{ name: "ROLLOUT_MODE", value: "paper" }, { name: "APP_ORIGIN", value: origin }],
  }] };
  const web = {
    id: `${prefix}/containerApps/${input.webApp}`,
    properties: {
      provisioningState: "Succeeded", latestRevisionName: "ca-prod-web--paper",
      latestReadyRevisionName: "ca-prod-web--paper",
      configuration: { activeRevisionsMode: "Single", ingress: { fqdn: new URL(origin).hostname } },
      template: structuredClone(webTemplate),
    },
  };
  const active = { name: web.properties.latestReadyRevisionName, properties: {
    active: true, provisioningState: "Provisioned", healthState: "Healthy",
    template: structuredClone(webTemplate),
  } };
  const retired = { name: "ca-prod-web--previous", properties: {
    active: false, replicas: 0, provisioningState: "Deprovisioned",
  } };
  const job = (name: string, hourly: boolean) => ({
    id: `${prefix}/jobs/${name}`,
    properties: {
      provisioningState: "Succeeded",
      configuration: {
        triggerType: "Schedule", replicaRetryLimit: hourly ? 1 : 0, replicaTimeout: 300,
        scheduleTriggerConfig: {
          cronExpression: hourly ? "0 * * * *" : "5 0 * * *", parallelism: 1, replicaCompletionCount: 1,
        },
      },
      template: { containers: [{
        name, image: input.expectedImage, command: ["node"],
        args: ["--experimental-strip-types", "scripts/scheduled-trigger.mjs"],
        resources: { cpu: 0.25, memory: "0.5Gi" },
        env: [
          { name: "TARGET_BASE_URL", value: origin },
          { name: "SCHEDULED_ROUTE", value: hourly ? "/api/agent/run" : "/api/agent/daily-summary" },
          { name: "ROLLOUT_MODE", value: "paper" },
          ...(hourly ? [{ name: "SCHEDULED_IDEMPOTENCY_NAMESPACE", value: `${imageDigest}-${input.scheduleGeneration}` }] : []),
          { name: "CRON_SECRET", secretRef: "cron-secret" },
        ],
      }] },
    },
  });
  const hourly = job(input.hourlyJob, true);
  const daily = job(input.dailyJob, false);
  const ops = {
    id: `${prefix}/jobs/${input.opsJob}`, properties: {
      provisioningState: "Succeeded",
      configuration: {
        triggerType: "Manual", replicaRetryLimit: 0,
        manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 },
      },
      template: { containers: [{
        image: input.expectedOpsImage, env: Object.entries({
          OPERATION: "target-smoke", ENVIRONMENT_NAME: "prod", RELEASE_SHA: releaseSha,
          IMAGE_DIGEST: imageDigest, OPS_IMAGE_DIGEST: opsDigest, TARGET_BASE_URL: origin,
          DEPLOYMENT_REPOSITORY: env.GITHUB_REPOSITORY, DEPLOYMENT_REPOSITORY_ID: env.GITHUB_REPOSITORY_ID,
          DEPLOYMENT_REPOSITORY_OWNER_ID: env.GITHUB_REPOSITORY_OWNER_ID,
        }).map(([name, value]) => ({ name, value })),
      }] },
    },
  };
  const execution = {
    id: `${hourly.id}/executions/hourly-observed`, name: "hourly-observed",
    properties: {
      status: "Succeeded", startTime: "2026-10-21T12:00:01+00:00", endTime: "2026-10-21T12:00:30+00:00",
    },
  };
  const detail = { ...execution, properties: {
    ...execution.properties, template: structuredClone(hourly.properties.template),
  } };
  const inventory = () => {
    if (Date.now() < Date.parse(execution.properties.startTime)) return [];
    const record = structuredClone(execution);
    if (Date.now() < Date.parse(record.properties.endTime) && record.properties.status === "Succeeded") {
      record.properties.status = "Running";
      Reflect.deleteProperty(record.properties, "endTime");
    }
    return [record];
  };
  const pages = new Map<string, () => unknown>();
  const read = jest.fn(async (args: string[]): Promise<unknown> => {
    if (args[0] === "rest") {
      const url = args[args.indexOf("--url") + 1];
      const page = pages.get(url);
      if (page) return page();
      if (url === inventoryUrl) return { value: inventory() };
      if (url === `https://management.azure.com${execution.id}?api-version=2023-05-01`) return detail;
      throw new Error("Unexpected Azure request.");
    }
    if (args[1] === "show") return web;
    if (args[1] === "revision") return [active, retired];
    const name = args[args.indexOf("--name") + 1];
    if (name === input.hourlyJob) return hourly;
    if (name === input.dailyJob) return daily;
    if (name === input.opsJob) return ops;
    throw new Error("Unexpected resource name.");
  });
  const sleep = jest.fn(async (milliseconds: number) => { jest.setSystemTime(Date.now() + milliseconds); });
  return { web, active, retired, hourly, daily, ops, execution, detail, inventory, pages, read, sleep };
}

describe("authenticated scheduled-window Azure observation", () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    execute.mockReset();
    jest.mocked(verifyWorkflowObservation).mockReset();
  });
  afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

  it("observes enablement and the completed first full window using only exact read-only requests", async () => {
    const state = fixture();
    const result = await collectScheduledExecutionObservation(input, env, state);
    expect(result).toMatchObject({
      purpose: "scheduled-execution", releaseSha, imageDigest, opsImageDigest: opsDigest,
      scheduleEnabledAt: NOW.toISOString(), authorizationId: input.authorizationId,
      originAssurance: "schedule-observed-not-origin-proven",
      execution: {
        id: state.execution.id, name: state.execution.name, status: "Succeeded",
        startedAt: "2026-10-21T12:00:01.000Z", completedAt: "2026-10-21T12:00:30.000Z",
      },
    });
    const template = {
      ...state.hourly.properties.template.containers[0],
      env: [...state.hourly.properties.template.containers[0].env]
        .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
    };
    expect(result.execution.templateDigest).toBe(createHash("sha256")
      .update(canonicalObservationJson(template)).digest("hex"));
    for (const [args] of state.read.mock.calls) {
      expect(args).toContain("--subscription");
      expect(args[args.indexOf("--subscription") + 1]).toBe(subscription);
      expect(args).not.toEqual(expect.arrayContaining(["start"]));
      if (args[0] === "rest") expect(args.slice(0, 4)).toEqual(["rest", "--method", "get", "--url"]);
      else expect(args).toContain(args[1] === "revision" ? "list" : "show");
    }
    expect(state.sleep.mock.calls[0]).toEqual([10_000]);
    expect(state.read).toHaveBeenCalledWith([
      "rest", "--method", "get", "--url",
      `https://management.azure.com${state.execution.id}?api-version=2023-05-01`,
      "--subscription", subscription, "--output", "json",
    ]);
  });

  it("uses completed initial readback, not pre-read generation, when ARM crosses an hour boundary", async () => {
    const state = fixture();
    const read = state.read.getMockImplementation()!;
    let initial = true;
    state.read.mockImplementation(async (args) => {
      if (initial) { initial = false; jest.setSystemTime(firstWindow + 5000); }
      return read(args);
    });
    state.execution.properties.startTime = "2026-10-21T13:00:01Z";
    state.execution.properties.endTime = "2026-10-21T13:00:30Z";
    Object.assign(state.detail.properties, state.execution.properties);
    const result = await collectScheduledExecutionObservation(input, env, state);
    expect(result.scheduleEnabledAt).toBe("2026-10-21T12:00:05.000Z");
    expect(result.execution.startedAt).toBe("2026-10-21T13:00:01.000Z");
  });

  it("reads every inventory page and tolerates the documented absent detail id", async () => {
    const state = fixture();
    const second = `${inventoryUrl}&$skiptoken=next`;
    state.pages.set(inventoryUrl, () => ({ value: [], nextLink: second }));
    state.pages.set(second, () => ({ value: state.inventory() }));
    Reflect.deleteProperty(state.detail, "id");
    const result = await collectScheduledExecutionObservation(input, env, state);
    expect(result.execution.id).toBe(state.execution.id);
    expect(state.read.mock.calls.filter(([args]) => args.includes(second)).length).toBeGreaterThan(1);
  });

  it("normalizes environment order and empty provider mount/probe metadata without dropping behavior", async () => {
    const state = fixture();
    state.detail.properties.template.containers[0].env.reverse();
    Object.assign(state.detail.properties.template.containers[0], { probes: [], volumeMounts: null });
    expect((await collectScheduledExecutionObservation(input, env, state)).execution.status).toBe("Succeeded");
  });

  it.each([
    ["GITHUB_REF", "refs/heads/topic"], ["GITHUB_ACTIONS", "false"], ["GITHUB_SHA", "f".repeat(40)],
    ["GITHUB_WORKFLOW_SHA", "f".repeat(40)], ["GITHUB_EVENT_NAME", "pull_request"],
    ["GITHUB_WORKFLOW_REF", "owner/project/.github/workflows/other.yml@refs/heads/main"],
    ["GITHUB_RUN_ID", "0"], ["GITHUB_RUN_ATTEMPT", "0"], ["AZURE_SUBSCRIPTION_ID", "invalid"],
    ["GITHUB_REPOSITORY_ID", ""], ["GITHUB_REPOSITORY_OWNER_ID", ""],
  ])("rejects untrusted %s before Azure access", async (key, value) => {
    const state = fixture();
    await expect(collectScheduledExecutionObservation(input, { ...env, [key]: value }, state)).rejects.toThrow();
    expect(state.read).not.toHaveBeenCalled();
  });

  it.each([
    { scheduleEnabledAt: NOW.toISOString() }, { scheduledExecutionId: "chosen-by-caller" },
    { scheduleGeneration: NOW.getTime() / 1000 + 1 },
    { expectedImage: "registry.example/krypto-web:latest" },
    { expectedOpsImage: `other.example/krypto-ops@${opsDigest}` },
    { authorizationId: "not-a-digest" },
  ])("rejects invalid or caller-authored observation input %j", async (change) => {
    const state = fixture();
    await expect(collectScheduledExecutionObservation({ ...input, ...change }, env, state)).rejects.toThrow();
    expect(state.read).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong resource", (s: ReturnType<typeof fixture>) => { s.hourly.id = s.daily.id; }],
    ["unready revision", (s: ReturnType<typeof fixture>) => { s.active.properties.healthState = "Unhealthy"; }],
    ["active old revision", (s: ReturnType<typeof fixture>) => { s.retired.properties.active = true; }],
    ["old replicas", (s: ReturnType<typeof fixture>) => { s.retired.properties.replicas = 1; }],
    ["disabled web", (s: ReturnType<typeof fixture>) => { s.web.properties.template.containers[0].env[0].value = "disabled"; }],
    ["wrong origin", (s: ReturnType<typeof fixture>) => { s.active.properties.template.containers[0].env[1].value = "https://other.example.com"; }],
    ["manual hourly job", (s: ReturnType<typeof fixture>) => { s.hourly.properties.configuration.triggerType = "Manual"; }],
    ["wrong daily cron", (s: ReturnType<typeof fixture>) => { s.daily.properties.configuration.scheduleTriggerConfig.cronExpression = "* * * * *"; }],
    ["parallel scheduler", (s: ReturnType<typeof fixture>) => { s.hourly.properties.configuration.scheduleTriggerConfig.parallelism = 2; }],
    ["changed retry limit", (s: ReturnType<typeof fixture>) => { s.daily.properties.configuration.replicaRetryLimit = 1; }],
    ["changed timeout", (s: ReturnType<typeof fixture>) => { s.hourly.properties.configuration.replicaTimeout = 600; }],
    ["wrong command", (s: ReturnType<typeof fixture>) => { s.hourly.properties.template.containers[0].command = ["sh"]; }],
    ["extra environment", (s: ReturnType<typeof fixture>) => { s.hourly.properties.template.containers[0].env.push({ name: "UNEXPECTED", value: "override" }); }],
    ["inline secret", (s: ReturnType<typeof fixture>) => { Object.assign(s.hourly.properties.template.containers[0].env.at(-1)!, { value: "not-allowed" }); }],
    ["extra template field", (s: ReturnType<typeof fixture>) => { Object.assign(s.hourly.properties.template, { unexpected: true }); }],
    ["extra container field", (s: ReturnType<typeof fixture>) => { Object.assign(s.hourly.properties.template.containers[0], { unexpected: true }); }],
    ["ops retry", (s: ReturnType<typeof fixture>) => { s.ops.properties.configuration.replicaRetryLimit = 1; }],
    ["contradictory ops schedule", (s: ReturnType<typeof fixture>) => {
      Object.assign(s.ops.properties.configuration, { scheduleTriggerConfig: { cronExpression: "* * * * *" } });
    }],
    ["ops image", (s: ReturnType<typeof fixture>) => { s.ops.properties.template.containers[0].image = input.expectedImage; }],
    ["missing trust", (s: ReturnType<typeof fixture>) => { s.ops.properties.template.containers[0].env.pop(); }],
  ])("does not attest %s", async (_name, change) => {
    const state = fixture();
    change(state);
    await expect(collectScheduledExecutionObservation(input, env, state)).rejects.toThrow();
  });

  it.each([
    ["foreign id", (s: ReturnType<typeof fixture>) => { s.detail.id = `${s.daily.id}/executions/hourly-observed`; }],
    ["foreign name", (s: ReturnType<typeof fixture>) => { s.detail.name = "another-execution"; }],
    ["failed detail", (s: ReturnType<typeof fixture>) => { s.detail.properties.status = "Failed"; }],
    ["start mismatch", (s: ReturnType<typeof fixture>) => { s.detail.properties.startTime = "2026-10-21T12:00:02Z"; }],
    ["end mismatch", (s: ReturnType<typeof fixture>) => { s.detail.properties.endTime = "2026-10-21T12:00:29Z"; }],
    ["wrong execution image", (s: ReturnType<typeof fixture>) => { s.detail.properties.template.containers[0].image = input.expectedOpsImage; }],
    ["wrong execution arguments", (s: ReturnType<typeof fixture>) => { s.detail.properties.template.containers[0].args = ["other.mjs"]; }],
    ["wrong execution resources", (s: ReturnType<typeof fixture>) => { s.detail.properties.template.containers[0].resources.cpu = 0.5; }],
    ["execution mounts", (s: ReturnType<typeof fixture>) => { Object.assign(s.detail.properties.template.containers[0], { volumeMounts: [{ mountPath: "/tmp" }] }); }],
    ["unknown execution field", (s: ReturnType<typeof fixture>) => { Object.assign(s.detail.properties.template.containers[0], { unexpected: true }); }],
    ["failed window", (s: ReturnType<typeof fixture>) => { s.execution.properties.status = "Failed"; }],
    ["unknown window", (s: ReturnType<typeof fixture>) => { s.execution.properties.status = "Unknown"; }],
  ])("rejects %s instead of trusting a successful inventory label", async (_name, change) => {
    const state = fixture();
    change(state);
    await expect(collectScheduledExecutionObservation(input, env, state)).rejects.toThrow();
  });

  it("rejects ambiguous executions, including one on a later page", async () => {
    const state = fixture();
    const second = `${inventoryUrl}&$skiptoken=next`;
    state.pages.set(inventoryUrl, () => ({ value: state.inventory(), nextLink: second }));
    state.pages.set(second, () => ({ value: state.inventory().map((item) => ({
      ...item, id: `${state.hourly.id}/executions/another`, name: "another",
    })) }));
    await expect(collectScheduledExecutionObservation(input, env, state)).rejects.toThrow("ambiguous");
  });

  it.each(["revision", "generation"])("rejects %s changes while waiting", async (kind) => {
    const state = fixture();
    state.sleep.mockImplementation(async (milliseconds) => {
      jest.setSystemTime(Date.now() + milliseconds);
      if (kind === "revision") {
        state.web.properties.latestReadyRevisionName = "ca-prod-web--changed";
        state.web.properties.latestRevisionName = state.web.properties.latestReadyRevisionName;
        state.active.name = state.web.properties.latestReadyRevisionName;
      } else {
        const binding = state.hourly.properties.template.containers[0].env
          .find((entry) => entry.name === "SCHEDULED_IDEMPOTENCY_NAMESPACE");
        Object.assign(binding!, { value: `${imageDigest}-${input.scheduleGeneration + 1}` });
      }
    });
    await expect(collectScheduledExecutionObservation(input, env, state)).rejects.toThrow();
  });

  it("times out without claiming a missing execution completed", async () => {
    const state = fixture();
    state.pages.set(inventoryUrl, () => ({ value: [] }));
    await expect(collectScheduledExecutionObservation(input, env, state)).rejects.toThrow("Timed out");
    expect(Date.now()).toBe(firstWindow + 900_000);
  });

  it("rejects a clock rollback during the wait", async () => {
    const state = fixture();
    state.sleep.mockImplementation(async () => { jest.setSystemTime(NOW.getTime() - 1); });
    await expect(collectScheduledExecutionObservation(input, env, state)).rejects.toThrow("backwards");
  });

  it.each<[boolean, number]>([
    [false, 90_000], [false, 90_001], [true, 90_000], [true, 90_001],
  ])("bounds final=%s readback at %i milliseconds", async (final, elapsed) => {
    const state = fixture();
    if (!final) {
      state.execution.properties.startTime = "2026-10-21T13:00:01Z";
      state.execution.properties.endTime = "2026-10-21T13:00:30Z";
      Object.assign(state.detail.properties, state.execution.properties);
    }
    const read = state.read.getMockImplementation()!;
    let delayed = false;
    state.read.mockImplementation(async (args) => {
      const result = await read(args);
      if (!delayed && ((!final && args[1] === "show") ||
          (final && args[0] === "rest" && args.includes(`https://management.azure.com${state.execution.id}?api-version=2023-05-01`)))) {
        delayed = true;
        jest.setSystemTime(Date.now() + elapsed);
      }
      return result;
    });
    if (elapsed === 90_000) {
      expect((await collectScheduledExecutionObservation(input, env, state)).execution.status).toBe("Succeeded");
    } else {
      await expect(collectScheduledExecutionObservation(input, env, state)).rejects.toThrow(/90 seconds|bounded observation/);
    }
  });

  it("does not return partial evidence after a provider failure", async () => {
    const state = fixture();
    state.pages.set(inventoryUrl, () => { throw new Error("Provider read failed"); });
    await expect(collectScheduledExecutionObservation(input, env, state)).rejects.toThrow("Provider read failed");
  });

  it("sanitizes the real Azure subprocess failure", async () => {
    execute.mockRejectedValue(new Error("PRIVATE_PROVIDER_CREDENTIAL"));
    await expect(collectScheduledExecutionObservation(input, env)).rejects.toThrow(
      "Azure scheduled-execution readback failed; no observation can be issued.",
    );
  });

  it("rejects missing start metadata instead of guessing an execution window", async () => {
    const state = fixture();
    state.pages.set(inventoryUrl, () => ({ value: [{
      ...state.execution, properties: { status: "Running" },
    }] }));
    await expect(collectScheduledExecutionObservation(input, env, state)).rejects.toThrow();
  });

  it("runs the real CLI producer through actual collection, OIDC verification and private publication", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "krypto-scheduled-producer-"));
    try {
      const state = fixture();
      const observation = await collectScheduledExecutionObservation(input, env, state);
      const signed = await signedScheduledFixture(observation, new Date(), {
        sub: "repo:owner@789/project@456:environment:production-promotion",
        repository: env.GITHUB_REPOSITORY, repository_id: env.GITHUB_REPOSITORY_ID,
        repository_owner_id: env.GITHUB_REPOSITORY_OWNER_ID, workflow_ref: env.GITHUB_WORKFLOW_REF,
      });
      jest.setSystemTime(NOW);
      execute.mockImplementation((command, args) => {
        expect(command).toBe("az");
        if (!Array.isArray(args) || !args.every((value) => typeof value === "string")) {
          throw new Error("Expected fixed Azure argv.");
        }
        return Object.assign(state.read(args).then((value) => ({
          stdout: JSON.stringify(value), stderr: "",
        })), { child: new ChildProcess() });
      });
      jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ value: signed.token })));
      jest.mocked(verifyWorkflowObservation).mockImplementation((proof, expected) =>
        actualObservation.verifyWorkflowObservation(proof, expected, { now: new Date(), keys: signed.keys }));
      const output = jest.spyOn(process.stdout, "write").mockReturnValue(true);
      const proofPath = path.join(directory, "proof.json");
      const receiptPath = path.join(directory, "receipt.json");
      const invocation = attestScheduledExecution([
        "--resource-group", input.resourceGroup, "--web-app", input.webApp,
        "--hourly-job", input.hourlyJob, "--daily-job", input.dailyJob, "--ops-job", input.opsJob,
        "--expected-image", input.expectedImage, "--expected-ops-image", input.expectedOpsImage,
        "--release-sha", input.releaseSha, "--authorization-id", input.authorizationId,
        "--schedule-generation", String(input.scheduleGeneration),
        "--job-execution-id", input.operationExecutionId,
        "--proof-output", proofPath, "--receipt-output", receiptPath,
      ], {
        ...env, ACTIONS_ID_TOKEN_REQUEST_URL: "https://pipelines.actions.githubusercontent.com/example/idtoken",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "test-only-request-token",
      });
      await jest.runAllTimersAsync();
      await invocation;
      expect(JSON.parse(fs.readFileSync(proofPath, "utf8"))).toEqual({ observation, token: signed.token });
      const receipt = fs.readFileSync(receiptPath, "utf8");
      expect(JSON.parse(receipt)).toMatchObject({
        purpose: "scheduled-execution", workflowSha: releaseSha, runId: env.GITHUB_RUN_ID, runAttempt: 1,
        observationDigest: actualObservation.workflowObservationAudience(observation).split(":").at(-1),
      });
      expect(receipt).not.toContain(signed.token);
      expect(output.mock.calls[0][0]).toBe(`::add-mask::${signed.token}\n`);
      expect(output.mock.calls.slice(1).map(([value]) => String(value)).join("")).not.toContain(signed.token);
      if (process.platform !== "win32") expect(fs.statSync(proofPath).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["--schedule-enabled-at", "--scheduled-execution-id", "--observation"])(
    "does not expose caller-supplied evidence on the CLI (%s)", async (argument) => {
      await expect(attestScheduledExecution([argument, "forged"], env)).rejects.toThrow();
      expect(execute).not.toHaveBeenCalled();
    },
  );
});
