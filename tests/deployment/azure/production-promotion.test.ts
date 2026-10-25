import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { productionPromotionFixture } from "./production-promotion-fixture";

type Entry = { name: string; value?: string; secretRef?: string };
type Container = { name: string; image: string; env: Entry[]; command?: string[]; args?: string[] };
type Resource = {
  id: string; name: string;
  properties: {
    provisioningState: string; configuration: Record<string, unknown>;
    template: { containers: Container[] }; latestRevisionName?: string; latestReadyRevisionName?: string;
  };
};
const api = jest.requireActual<{
  runProductionPromotion(input: unknown): Promise<Record<string, unknown>>;
  resolvePromotionAuthority(input: unknown): Promise<{ mode: string; previous: unknown }>;
  captureProductionRecovery(input: unknown): Promise<Record<string, unknown>>;
  createRecoveryIntent(env: unknown, needs: unknown): Record<string, unknown>;
  validateRecoveryReceipt(receipt: unknown, env: unknown): Record<string, unknown>;
  runProductionRecovery(input: unknown): Promise<Record<string, unknown>>;
  releaseRecoveredProductionFence(input: unknown): Promise<Record<string, unknown>>;
}>("../../../.github/scripts/azure/production-promotion.cjs");
const { PRODUCTION_JOB_NAMES } = jest.requireActual<{ PRODUCTION_JOB_NAMES: Record<string, string> }>(
  "../../../.github/scripts/azure/production-evidence.cjs",
);
const workspace = path.resolve(__dirname, "../../..");
const privateToken = "private-test-oidc-token-not-for-publication";
const names = {
  WEB_APP_NAME: "ca-prod-web",
  PROD_HOURLY_JOB_NAME: "caj-prod-agent-run", PROD_DAILY_JOB_NAME: "caj-prod-daily-summary",
  PREFLIGHT_JOB_NAME: "caj-prod-preflight", VERIFIED_BACKUP_JOB_NAME: "caj-prod-verified-backup",
  MIGRATE_INIT_JOB_NAME: "caj-prod-migrate-init", TARGET_SMOKE_JOB_NAME: "caj-prod-target-smoke",
  ACTIVATION_CHECK_JOB_NAME: "caj-prod-activation-check",
};
const operations = {
  PREFLIGHT_JOB_NAME: "preflight", VERIFIED_BACKUP_JOB_NAME: "verified-backup",
  MIGRATE_INIT_JOB_NAME: "migrate-init", TARGET_SMOKE_JOB_NAME: "target-smoke",
  ACTIVATION_CHECK_JOB_NAME: "activation-check",
};
const owned: string[] = [];
const value = (args: string[], key: string) => {
  const index = args.indexOf(key);
  if (index < 0 || !args[index + 1]) throw new Error(`Missing command argument ${key}`);
  return args[index + 1];
};

function harness(initialMode = "disabled") {
  const f = productionPromotionFixture();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "krypto-production-orchestration-"));
  owned.push(directory);
  const prefix = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-prod";
  const id = (name: string, web = false) => `${prefix}/providers/Microsoft.App/${web ? "containerApps" : "jobs"}/${name}`;
  const env: Record<string, string> = {
    ...f.env, ...names, AZURE_SUBSCRIPTION_ID: "00000000-0000-0000-0000-000000000001",
    PROD_RESOURCE_GROUP_NAME: "rg-prod", GITHUB_WORKSPACE: workspace, RUNNER_TEMP: directory,
    PROMOTION_MODE: "operator", EXISTING_RELEASE: "true", EVIDENCE_CONTAINER_URL: f.binding.evidenceContainerUrl,
    PRODUCTION_RELEASE: JSON.stringify(f.receipt.release), PROMOTION_AUTHORITY: JSON.stringify(f.authority),
    PRODUCTION_PREPARATION: JSON.stringify({
      authorizationId: f.evidence.authorizationId, scheduleGeneration: f.evidence.scheduleGeneration,
      approvalId: f.evidence.approvalId, approvalCreatedAfter: f.evidence.approvalCreatedAfter,
      manualShadow: f.evidence.manualShadow,
    }),
    ROLLOUT_VALUES: JSON.stringify({
      container_apps_environment_id: `${prefix}/providers/Microsoft.App/managedEnvironments/cae-prod`,
      runtime_identity_id: `${prefix}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/runtime`,
      runtime_identity_client_id: "00000000-0000-0000-0000-000000000002",
      scheduler_identity_id: `${prefix}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/scheduler`,
      communication_email_sender: "DoNotReply@example.com",
    }),
  };
  const state = {
    mode: initialMode, generation: initialMode === "disabled" ? 0 : f.evidence.scheduleGeneration,
    manualCount: 0, failAt: "", monitoringAt: "0", monitoringEnabled: false, stopped: false,
    binding: { ...f.binding }, fence: "owned", partialDisable: false,
    corruptResource: undefined as ((resources: Record<string, Resource>) => void) | undefined,
  };
  const events: string[] = [];
  const entries = (fields: Record<string, string>): Entry[] => Object.entries(fields).map(([name, value]) => ({ name, value }));
  function snapshot() {
    const binding = state.binding;
    const webImage = `${binding.registryLoginServer}/krypto-web@${binding.webImageDigest}`;
    const opsImage = `${binding.registryLoginServer}/krypto-ops@${binding.opsImageDigest}`;
    const web: Resource = {
      id: id(names.WEB_APP_NAME, true), name: names.WEB_APP_NAME,
      properties: {
        provisioningState: "Succeeded", latestRevisionName: "current", latestReadyRevisionName: "current",
        configuration: { activeRevisionsMode: "Single", ingress: { fqdn: "production.example.com" } },
        template: { containers: [{
          name: names.WEB_APP_NAME, image: webImage,
          env: entries({ APP_ORIGIN: binding.targetOrigin, ROLLOUT_MODE: state.mode }),
        }] },
      },
    };
    const resources: Record<string, Resource> = { WEB_APP_NAME: web };
    for (const [key, route, cron, retries] of [
      ["PROD_HOURLY_JOB_NAME", "/api/agent/run", "0 * * * *", 1],
      ["PROD_DAILY_JOB_NAME", "/api/agent/daily-summary", "5 0 * * *", 0],
    ] as const) {
      resources[key] = {
        id: id(names[key]), name: names[key],
        properties: {
          provisioningState: "Succeeded",
          configuration: {
            triggerType: state.mode === "paper" ? "Schedule" : "Manual", replicaRetryLimit: retries, replicaTimeout: 300,
            ...(state.mode === "paper" ? {
              scheduleTriggerConfig: { parallelism: 1, replicaCompletionCount: 1, cronExpression: cron },
            } : { manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 } }),
          },
          template: { containers: [{
            name: names[key], image: webImage, command: ["node"],
            args: ["--experimental-strip-types", "scripts/scheduled-trigger.mjs"],
            env: [
              ...entries({ TARGET_BASE_URL: binding.targetOrigin, SCHEDULED_ROUTE: route, ROLLOUT_MODE: state.mode }),
              ...(key === "PROD_HOURLY_JOB_NAME" ? entries({
                SCHEDULED_IDEMPOTENCY_NAMESPACE: `${binding.webImageDigest}-${state.generation}`,
              }) : []),
              { name: "CRON_SECRET", secretRef: "cron-secret" },
            ],
          }] },
        },
      };
    }
    for (const [key, operation] of Object.entries(operations)) {
      resources[key] = {
        id: id(env[key]), name: env[key],
        properties: {
          provisioningState: "Succeeded", configuration: { triggerType: "Manual" },
          template: { containers: [{
            name: env[key], image: opsImage,
            env: entries({
              OPERATION: operation, ENVIRONMENT_NAME: "prod", RELEASE_SHA: binding.releaseSha,
              IMAGE_DIGEST: binding.webImageDigest, OPS_IMAGE_DIGEST: binding.opsImageDigest,
              TARGET_BASE_URL: binding.targetOrigin, DEPLOYMENT_REPOSITORY: f.env.GITHUB_REPOSITORY,
              DEPLOYMENT_REPOSITORY_ID: "456", DEPLOYMENT_REPOSITORY_OWNER_ID: "12",
            }),
          }] },
        },
      };
    }
    if (state.partialDisable) resources.PROD_DAILY_JOB_NAME.properties.configuration.triggerType = "Schedule";
    state.corruptResource?.(resources);
    return {
      resources,
      revisions: [{ name: "current", properties: {
        active: true, provisioningState: "Provisioned", healthState: "Healthy", template: web.properties.template,
      } }],
    };
  }
  const executions = () => Array.from({ length: state.manualCount }, (_, index) => ({
    id: `${id(names.PROD_HOURLY_JOB_NAME)}/executions/manual-shadow${index ? `-${index}` : ""}`,
    name: `manual-shadow${index ? `-${index}` : ""}`,
    properties: {
      status: "Succeeded", startTime: f.time(11), endTime: f.time(12),
      template: { containers: [{
        name: names.PROD_HOURLY_JOB_NAME,
        env: [{ name: "JOB_EXECUTION_ID", value: "run1001-a2-prod-shadow" }],
      }] },
    },
  }));
  const listForRepo = jest.fn();
  const listEventsForTimeline = jest.fn();
  const github = {
    ...f.github,
    rest: {
      ...f.github.rest,
      issues: { listForRepo, listEventsForTimeline },
      git: { getRef: jest.fn(async () => ({ data: { object: { sha: f.sha } } })) },
    },
    paginate: jest.fn(async (method: unknown, args: Record<string, unknown>) => {
      if (method === listForRepo) return [{
        number: 233, labels: [{ name: "factory-control" }, { name: `factory-mode:${state.stopped ? "paused" : "active"}` }],
      }];
      if (method === listEventsForTimeline) return [{
        event: "labeled", label: { name: "factory-mode:active" }, actor: { type: "User" }, created_at: f.time(-240),
      }];
      return f.github.paginate(method, args);
    }),
  };
  const activeRun = { ...f.run, status: "in_progress", conclusion: null };
  github.rest.actions.getWorkflowRun.mockImplementation(async (args) => ({
    data: args.run_id === 900 ? f.developmentRun : activeRun,
  }));
  const execute = jest.fn(async (command: string, args: string[]) => {
    const script = path.basename(args[0]);
    const event = command === "az" ? args.slice(0, 4).join(" ") : script;
    events.push(event);
    if (state.failAt && [event, ...args].some((part) => part.includes(state.failAt))) {
      throw Object.assign(new Error(privateToken), { code: 1, stderr: privateToken });
    }
    if (command === "node" && ["render-bicepparam.mjs", "reject-unsafe-whatif-deletes.mjs"].includes(script)) {
      const result = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 15_000 });
      if (result.status !== 0) throw new Error(result.stderr || `Local helper failed: ${script}`);
      return result.stdout;
    }
    if (command === "node" && script === "validate-report.mjs") return "";
    if (command === "node" && args.includes("tsx")) {
      if (args.some((arg) => arg.endsWith("attest-cutover-state.ts"))) {
        fs.writeFileSync(value(args, "--proof-output"), JSON.stringify({
          token: privateToken, observation: { purpose: "cutover-release" },
        }));
        fs.writeFileSync(value(args, "--receipt-output"), JSON.stringify({ observationDigest: "d".repeat(64) }));
        return "";
      }
      const execution = f.evidence.scheduled.scheduledExecution;
      if (!execution) throw new Error("Missing scheduled fixture");
      fs.writeFileSync(value(args, "--proof-output"), JSON.stringify({
        token: privateToken, observation: {
          purpose: "scheduled-execution", execution, scheduleEnabledAt: execution.scheduleEnabledAt,
        },
      }));
      fs.writeFileSync(value(args, "--receipt-output"), JSON.stringify(f.evidence.scheduled.workflowObservation));
      jest.setSystemTime(new Date(f.time(61)));
      return "";
    }
    if (command === "bash" && script === "run-ops-job.sh") {
      const logical = value(args, "--job-execution-id");
      const suffix = logical.split("-").at(-1);
      const execution = suffix === "shadow" ? "manual-shadow" : `ops-${suffix}`;
      fs.writeFileSync(value(args, "--execution-name-output"), execution);
      if (suffix === "shadow") {
        state.manualCount += 1;
        jest.setSystemTime(new Date(f.time(12)));
      }
      return "";
    }
    if (command === "bash" && script === "download-evidence.sh") {
      const logical = value(args, "--job-execution-id");
      const operation = value(args, "--operation");
      const suffix = logical.split("-").at(-1);
      const report = suffix === "smoke" ? { evidenceIds: { approval: f.evidence.approvalId } } :
        suffix === "scheduled" ? f.evidence.scheduled :
          { ...f.evidence.ready, jobExecutionId: logical, azureExecutionName: `ops-${suffix}` };
      const directory = path.join(value(args, "--destination"), "prod", f.sha, operation, logical);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, "report.json"), JSON.stringify(report));
      if (suffix === "ready" || suffix === "prepare") jest.setSystemTime(new Date(f.time(20)));
      return "";
    }
    if (command === "bash" && script === "verify-disabled-rollout.sh") return "";
    if (command === "bash" && script === "run-deployment-admission.sh") {
      const action = value(args, "--action");
      if (action === "verify" && state.fence === "owned") return "";
      if (action === "release" && ["owned", "released", "expired"].includes(state.fence)) {
        state.fence = "released";
        return "";
      }
      throw Object.assign(new Error(privateToken), { code: 1 });
    }
    if (command !== "az") throw new Error(`Unexpected test command ${command} ${script}`);
    if (args[0] === "containerapp") {
      const current = snapshot();
      if (args.includes("revision")) return JSON.stringify(current.revisions);
      const resource = Object.values(current.resources).find((entry) => entry.name === value(args, "--name"));
      if (!resource) throw new Error("Unexpected resource read");
      return JSON.stringify(resource);
    }
    if (args[0] === "bicep") {
      fs.writeFileSync(value(args, "--outfile"), JSON.stringify({
        parameters: { enabled: { value: false }, scheduleEnabledAtUnixSeconds: { value: "0" } },
      }));
      return "";
    }
    if (args[0] === "deployment") {
      if (args.includes("what-if")) return JSON.stringify({ changes: [] });
      const deployment = value(args, "--name");
      events.push(deployment);
      if (deployment.startsWith("prod-monitor")) {
        const document = JSON.parse(fs.readFileSync(value(args, "--parameters").slice(1), "utf8"));
        state.monitoringEnabled = document.parameters.enabled.value;
        state.monitoringAt = document.parameters.scheduleEnabledAtUnixSeconds.value;
        return JSON.stringify({
          missingHourlySuccessAlertEnabled: { value: state.monitoringEnabled },
          scheduleEnabledAtUnixSeconds: { value: state.monitoringAt },
          missingHourlySuccessAlertId: { value: `${prefix}/providers/Microsoft.Insights/scheduledQueryRules/alert-${names.PROD_HOURLY_JOB_NAME}-missing-success` },
        });
      }
      const text = fs.readFileSync(value(args, "--parameters"), "utf8");
      const mode = /param rolloutMode = '(\w+)'/.exec(text)?.[1];
      const generation = /param scheduleGenerationUnixSeconds = '(\d+)'/.exec(text)?.[1];
      if (!mode || !generation) throw new Error("Rendered rollout did not contain overrides");
      state.mode = mode;
      state.generation = Number(generation);
      state.partialDisable = false;
      if (mode === "shadow") jest.setSystemTime(new Date(f.time(11)));
      if (mode === "paper") jest.setSystemTime(new Date(f.time(21)));
      return JSON.stringify({
        rolloutMode: { value: mode }, hourlyTriggerType: { value: mode === "paper" ? "Schedule" : "Manual" },
        dailyTriggerType: { value: mode === "paper" ? "Schedule" : "Manual" },
      });
    }
    const url = value(args, "--url");
    if (url.includes("/scheduledQueryRules/")) return JSON.stringify({ properties: {
      enabled: state.monitoringEnabled, skipQueryValidation: false,
      actions: { actionGroups: ["existing-alerts"], customProperties: { scheduleEnabledAtUnixSeconds: state.monitoringAt } },
    } });
    if (url.includes("/executions?")) return JSON.stringify({ value: executions() });
    const execution = executions().find((entry) => url.includes(`${entry.id}?`));
    if (!execution) throw new Error("Unexpected execution detail read");
    return JSON.stringify(execution);
  });
  const core = { info: jest.fn(), warning: jest.fn(), setSecret: jest.fn() };
  const needs: Record<string, { result: string; outputs: Record<string, string> }> = Object.fromEntries(
    Object.keys(PRODUCTION_JOB_NAMES).filter((id) =>
      !["recover-paper", "release-recovered-fence", "publish-production-failure"].includes(id))
      .map((id) => [id, { result: "skipped", outputs: {} }]),
  );
  needs.gate = { result: "success", outputs: { sha: f.sha } };
  needs["force-disable-rollout"] = { result: "failure", outputs: { existing_release: "true" } };
  const capture = async () => {
    env.CURRENT_SHA = state.binding.releaseSha;
    env.CURRENT_WEB_DIGEST_HEX = state.binding.webImageDigest.slice(7);
    env.TARGET_ORIGIN = state.binding.targetOrigin;
    const captured = await api.captureProductionRecovery({ env, execute });
    Object.assign(needs["force-disable-rollout"].outputs, {
      current_sha: env.CURRENT_SHA, current_digest: env.CURRENT_WEB_DIGEST_HEX, recovery_context: JSON.stringify(captured),
    });
    return captured;
  };
  return {
    f, env, state, events, execute, github, core, directory, activeRun, needs, capture,
    run: (phase: string) => api.runProductionPromotion({ phase, github, core, owner: "owner", repo: "project", env, execute }),
    resolve: () => api.resolvePromotionAuthority({ github, core, owner: "owner", repo: "project", env, execute }),
    recover: () => {
      env.PRODUCTION_JOB_RESULTS = JSON.stringify(needs);
      env.PRODUCTION_RECOVERY_INTENT ??= JSON.stringify(api.createRecoveryIntent(env, needs));
      return api.runProductionRecovery({ github, core, owner: "owner", repo: "project", env, execute });
    },
    release: (receipt: Record<string, unknown>) => api.releaseRecoveredProductionFence({
      core, env: { ...env, PRODUCTION_RECOVERY_RECEIPT: JSON.stringify(receipt) }, execute,
    }),
  };
}

describe("native production promotion orchestration", () => {
  beforeEach(() => jest.useFakeTimers({ now: new Date("2026-10-22T00:10:00Z") }));
  afterEach(() => {
    jest.useRealTimers();
    for (const directory of owned.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });

  it("runs one marked Manual shadow after fresh smoke and a real guarded shadow parameter rendering", async () => {
    const h = harness();
    const result = await h.run("prepare");
    expect(result).toEqual(JSON.parse(h.env.PRODUCTION_PREPARATION));
    expect(h.state.mode).toBe("shadow");
    expect(h.state.manualCount).toBe(1);
    const starts = h.execute.mock.calls.filter(([command, args]) => command === "bash" && args[0].endsWith("run-ops-job.sh"));
    expect(starts).toHaveLength(3);
    expect(starts[1][1]).toContain("manual-shadow:run1001-a2-prod-shadow");
    expect(fs.readdirSync(h.directory)).toEqual([]);
  });

  it("arms fresh monitoring before Schedule, validates ready, and passes only a private proof file to scheduled verification", async () => {
    const h = harness("shadow");
    jest.setSystemTime(new Date(h.f.time(17)));
    const result = await h.run("activate");
    expect(h.state.mode).toBe("paper");
    expect(h.state.monitoringAt).toBe(String(Date.parse(h.f.time(17)) / 1000));
    expect(h.events.indexOf("prod-monitor-paper-1001-a2")).toBeLessThan(h.events.indexOf("prod-paper-1001-a2"));
    expect(h.events.indexOf("download-evidence.sh")).toBeLessThan(h.events.indexOf("prod-paper-1001-a2"));
    expect(result.ready).toEqual(h.f.evidence.ready);
    expect(result.scheduled).toEqual(h.f.evidence.scheduled);
    expect(JSON.stringify(result)).not.toContain(privateToken);
    expect(h.core.setSecret).toHaveBeenCalledWith(privateToken);
    const observation = h.execute.mock.calls.find(([, args]) => args.includes("tsx"));
    expect(observation?.[1]).toContain("--receipt-output");
    expect(observation?.[1]).toContain("--proof-output");
    expect(h.execute.mock.calls.some(([, args]) => args.includes(privateToken))).toBe(false);
    expect(fs.readdirSync(h.directory)).toEqual([]);
  });

  it("can recover while paused without new authority and disables monitoring only after verified quiescence", async () => {
    const h = harness("paper");
    h.state.stopped = true;
    await expect(h.run("recover")).resolves.toEqual({ recovered: true });
    expect(h.state.mode).toBe("disabled");
    expect(h.state.generation).toBe(0);
    expect(h.state.monitoringEnabled).toBe(false);
    expect(h.events.indexOf("verify-disabled-rollout.sh")).toBeLessThan(h.events.indexOf("prod-monitor-recover-1001-a2"));
    expect(h.github.rest.actions.getWorkflowRun).not.toHaveBeenCalled();
    expect(fs.readdirSync(h.directory)).toEqual([]);
  });

  it.each(["render-bicepparam.mjs", "what-if", "run-ops-job.sh", "download-evidence.sh"])(
    "stops preparation on %s failure, excludes private child output and cleans up",
    async (stage) => {
      const h = harness();
      h.state.failAt = stage;
      const failure = await h.run("prepare").then(() => null, (error: Error) => error);
      expect(failure?.message).toContain("no production success is inferred");
      expect(failure?.message).not.toContain(privateToken);
      expect(h.events).not.toContain("prod-paper-1001-a2");
      expect(fs.readdirSync(h.directory)).toEqual([]);
    },
  );

  it("does not duplicate an existing marked manual execution", async () => {
    const h = harness();
    h.state.manualCount = 1;
    await expect(h.run("prepare")).rejects.toThrow("manual shadow marker already exists");
    expect(h.execute.mock.calls.filter(([, args]) => args.includes("--scheduled-idempotency-key"))).toHaveLength(0);
    expect(fs.readdirSync(h.directory)).toEqual([]);
  });

  it("does not disable failure monitoring when disabled quiescence cannot be established", async () => {
    const h = harness("paper");
    h.state.failAt = "verify-disabled-rollout.sh";
    await expect(h.run("recover")).rejects.toThrow("quiescence failed");
    expect(h.events).not.toContain("prod-monitor-recover-1001-a2");
  });

  it.each(["build-params", "prod-monitor-paper", "prod-paper", "tsx", "download-evidence.sh"])(
    "fails activation explicitly at %s, cleans private files and permits owned disabled recovery",
    async (stage) => {
      const h = harness("shadow");
      h.state.failAt = stage;
      const failure = await h.run("activate").then(() => null, (error: Error) => error);
      expect(failure?.message).toContain("no production success is inferred");
      expect(failure?.message).not.toContain(privateToken);
      expect(fs.readdirSync(h.directory)).toEqual([]);
      h.state.failAt = "";
      await expect(h.run("recover")).resolves.toEqual({ recovered: true });
      expect(h.state.mode).toBe("disabled");
      expect(h.state.monitoringEnabled).toBe(false);
    },
  );

  it("refuses protected-resource deletion before any shadow or paper apply", async () => {
    const h = harness();
    const execute = h.execute.getMockImplementation();
    if (!execute) throw new Error("Missing command fixture");
    h.execute.mockImplementation(async (command, args) => command === "az" && args.includes("what-if")
      ? JSON.stringify({ changes: [{
        changeType: "Delete",
        resourceId: "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-prod/providers/Microsoft.DBforPostgreSQL/flexibleServers/db-prod",
      }] })
      : execute(command, args));
    await expect(h.run("prepare")).rejects.toThrow("delete guard");
    expect(h.state.mode).toBe("disabled");
    expect(h.state.manualCount).toBe(0);
  });

  it("rejects multiple native executions bearing the Manual shadow marker", async () => {
    const h = harness();
    const execute = h.execute.getMockImplementation();
    if (!execute) throw new Error("Missing command fixture");
    h.execute.mockImplementation(async (command, args) => {
      const output = await execute(command, args);
      if (command === "bash" && args.includes("manual-shadow:run1001-a2-prod-shadow")) h.state.manualCount = 2;
      return output;
    });
    await expect(h.run("prepare")).rejects.toThrow("Exactly one native manual shadow");
    expect(h.execute.mock.calls.filter(([, args]) => args.includes("--scheduled-idempotency-key"))).toHaveLength(1);
    expect(fs.readdirSync(h.directory)).toEqual([]);
  });

  it("rechecks real-clock readiness after slow final authority reads", async () => {
    const h = harness("shadow");
    const read = h.github.rest.actions.getWorkflowRun.getMockImplementation();
    if (!read) throw new Error("Missing native run fixture");
    h.github.rest.actions.getWorkflowRun.mockImplementation(async (args) => {
      const response = await read(args);
      if (args.run_id === 1001 && h.events.includes("download-evidence.sh")) jest.setSystemTime(new Date(h.f.time(40)));
      return response;
    });
    await expect(h.run("activate")).rejects.toThrow();
    expect(h.events).not.toContain("prod-paper-1001-a2");
    expect(h.state.mode).toBe("shadow");
    expect(fs.readdirSync(h.directory)).toEqual([]);
  });

  it.each(["prepare", "activate", "recover"])("rechecks runtime ownership after the %s rollout preview", async (phase) => {
    const h = harness(phase === "prepare" ? "disabled" : phase === "activate" ? "shadow" : "paper");
    const execute = h.execute.getMockImplementation();
    if (!execute) throw new Error("Missing command fixture");
    h.execute.mockImplementation(async (command, args) => {
      const output = await execute(command, args);
      if (command === "az" && args.includes("what-if") && args.some((arg) => arg.endsWith("rollout.bicep"))) {
        h.state.corruptResource = (resources) => { resources.WEB_APP_NAME.properties.template.containers[0].image = "foreign"; };
      }
      return output;
    });
    await expect(h.run(phase)).rejects.toThrow("runtime image changed");
    expect(h.events.some((event) => /^prod-(shadow|paper|recover)-/.test(event))).toBe(false);
  });

  it("repeats quiescence after the monitoring-disable preview instead of trusting an old read", async () => {
    const h = harness("paper");
    const execute = h.execute.getMockImplementation();
    if (!execute) throw new Error("Missing command fixture");
    h.execute.mockImplementation(async (command, args) => {
      const output = await execute(command, args);
      if (command === "az" && args.includes("what-if") && args.some((arg) => arg.endsWith("schedule-monitoring.bicep"))) {
        h.state.failAt = "verify-disabled-rollout.sh";
      }
      return output;
    });
    await expect(h.run("recover")).rejects.toThrow("quiescence failed");
    expect(h.events).not.toContain("prod-monitor-recover-1001-a2");
  });

  it.each([
    ["image", "runtime image changed"], ["origin", "origin does not identify"],
    ["scheduler-command", "scheduler command changed"], ["extra-env", "Unexpected scheduler environment"],
    ["old-revision", "desired disabled revision is not ready"],
  ])("rejects changed %s before mutation", async (part, message) => {
    const h = harness();
    h.state.corruptResource = (resources) => {
      const web = resources.WEB_APP_NAME;
      const hourly = resources.PROD_HOURLY_JOB_NAME.properties.template.containers[0];
      if (part === "image") web.properties.template.containers[0].image = "unexpected";
      if (part === "origin") web.properties.configuration.ingress = { fqdn: "elsewhere.example.com" };
      if (part === "scheduler-command") hourly.command = ["sh"];
      if (part === "extra-env") hourly.env.push({ name: "UNEXPECTED", value: "1" });
      if (part === "old-revision") web.properties.latestReadyRevisionName = "old";
    };
    await expect(h.run("prepare")).rejects.toThrow(message);
    expect(h.events.some((entry) => entry.startsWith("deployment"))).toBe(false);
    expect(fs.readdirSync(h.directory)).toEqual([]);
  });

  it("does not use a later main SHA or a changed producer actor", async () => {
    const h = harness();
    h.github.rest.git.getRef.mockResolvedValue({ data: { object: { sha: "f".repeat(40) } } });
    await expect(h.run("prepare")).rejects.toThrow("superseded on main");
    expect(h.execute).not.toHaveBeenCalled();
    h.github.rest.git.getRef.mockResolvedValue({ data: { object: { sha: h.f.sha } } });
    h.activeRun.actor = { id: 99, login: "different", type: "User" };
    await expect(h.run("prepare")).rejects.toThrow("actor");
    expect(h.execute).not.toHaveBeenCalled();
  });

  it.each(["fresh", "disabled", "shadow"])("continuous admission for %s production never creates first activation", async (kind) => {
    const h = harness(kind === "fresh" ? "disabled" : kind);
    h.env.PROMOTION_MODE = "continuous";
    h.env.EXISTING_RELEASE = kind === "fresh" ? "false" : "true";
    await expect(h.resolve()).resolves.toMatchObject({ mode: "disabled", previous: null });
    expect(h.events.some((entry) => entry.startsWith("deployment"))).toBe(false);
    if (kind === "fresh") expect(h.execute).not.toHaveBeenCalled();
  });

  it("rejects continuous admission when the factory is paused", async () => {
    const h = harness("paper");
    h.env.PROMOTION_MODE = "continuous";
    h.state.stopped = true;
    await expect(h.resolve()).rejects.toThrow("human-activated factory");
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("continues only the exact actually deployed paper receipt and generation", async () => {
    const h = harness("paper");
    jest.setSystemTime(new Date(h.f.time(100)));
    h.env.PROMOTION_MODE = "continuous";
    h.env.GITHUB_RUN_ID = "2001";
    const current = { ...h.activeRun, id: 2001, run_started_at: h.f.time(80) };
    h.github.rest.actions.getWorkflowRun.mockImplementation(async (args) => ({
      data: args.run_id === 2001 ? current : args.run_id === 900 ? h.f.developmentRun : h.f.run,
    }));
    await expect(h.resolve()).resolves.toMatchObject({ mode: "continuous", previous: h.f.reference });
    h.state.generation += 1;
    await expect(h.resolve()).rejects.toThrow("generation changed");
    expect(h.events.some((entry) => entry.startsWith("deployment"))).toBe(false);
  });

  it.each(["acquire-response", "partial-disable", "partial-monitoring", "backup-current-release", "deploy-environment", "build-images"])(
    "recovers the exact owned source after %s failure with no preparation or successful receipt",
    async (failure) => {
      const h = harness("paper");
      h.state.binding = { ...h.f.binding, releaseSha: "1".repeat(40), webImageDigest: `sha256:${"2".repeat(64)}`,
        opsImageDigest: `sha256:${"3".repeat(64)}` };
      const source = await h.capture();
      h.state.stopped = true;
      delete h.env.PRODUCTION_RELEASE;
      delete h.env.PROMOTION_AUTHORITY;
      if (failure !== "acquire-response") {
        h.state.mode = "disabled";
        h.state.generation = 0;
      }
      h.state.partialDisable = failure === "partial-disable";
      if (["backup-current-release", "deploy-environment", "build-images"].includes(failure)) {
        h.needs["force-disable-rollout"].result = "success";
        h.needs[failure].result = "failure";
      }
      const receipt = await h.recover();
      expect(receipt).toMatchObject({ status: "disabled", scope: "source", fence: "required", binding: source.binding });
      expect(h.needs["prepare-paper"].result).toBe("skipped");
      expect(h.needs["publish-release-receipt"].result).toBe("skipped");
      expect(h.state.mode).toBe("disabled");
      expect(h.state.partialDisable).toBe(false);
      expect(h.state.monitoringEnabled).toBe(false);
      const fences = h.execute.mock.calls.filter(([, args]) => args[0].endsWith("run-deployment-admission.sh"));
      expect(fences).toHaveLength(2);
      for (const [, args] of fences) {
        expect(value(args, "--action")).toBe("verify");
        expect(value(args, "--owner")).toBe(source.owner);
        expect(value(args, "--source-release-sha")).toBe(h.state.binding.releaseSha);
        expect(value(args, "--job-release-sha")).toBe(h.state.binding.releaseSha);
        expect(value(args, "--candidate-release-sha")).toBe(h.f.sha);
      }
      expect(h.events.indexOf("run-deployment-admission.sh")).toBeLessThan(h.events.indexOf("prod-recover-1001-a2"));
      expect(h.github.rest.actions.getWorkflowRun).not.toHaveBeenCalled();
      expect(JSON.stringify(receipt)).not.toContain(privateToken);
      expect(fs.readdirSync(h.directory)).toEqual([]);
    },
  );

  it.each(["none", "owned", "released", "baseline-failed", "baseline-missing-output"])(
    "recovers candidate failures with %s fence disposition without inventing a release receipt", async (fence) => {
    const h = harness("paper");
    if (fence !== "none") {
      h.state.binding = { ...h.f.binding, releaseSha: "1".repeat(40) };
      await h.capture();
      h.state.binding = { ...h.f.binding };
    } else h.needs["force-disable-rollout"].outputs.existing_release = "false";
    h.needs["deploy-environment"] = { result: "success", outputs: {
      ...JSON.parse(h.env.ROLLOUT_VALUES), acr_login_server: h.f.binding.registryLoginServer,
      evidence_container_url: h.f.binding.evidenceContainerUrl,
    } };
    h.needs["build-images"] = { result: "success", outputs: {
      web_digest_hex: h.f.binding.webImageDigest.slice(7), ops_digest_hex: h.f.binding.opsImageDigest.slice(7),
    } };
    h.needs["deploy-release"].result = "failure";
    h.needs["migrate-backup"] = { result: "success", outputs: { job_execution_id: "run1001-a2-backup" } };
    if (fence === "baseline-failed") h.needs["migrate-backup"].result = "failure";
    if (fence === "baseline-missing-output") h.needs["migrate-backup"].outputs = {};
    if (fence === "released") {
      h.needs["release-cutover-fence"] = { result: "success", outputs: { status: "released" } };
      h.state.fence = "released";
    }
    const receipt = await h.recover();
    const baselineMissing = fence.startsWith("baseline-");
    expect(receipt).toMatchObject({ status: "disabled", scope: "candidate", binding: h.f.binding,
      fence: baselineMissing ? "retained" : fence === "owned" ? "required" : fence });
    const checks = h.execute.mock.calls.filter(([, args]) => args.includes("--action"));
    expect(checks).toHaveLength(fence === "owned" || baselineMissing ? 2 : 0);
    if (baselineMissing) {
      expect(receipt.reason).toBe("candidate-baseline-unverified");
      h.execute.mockClear();
      await expect(h.release(receipt)).rejects.toThrow("requires verified disabled recovery");
      expect(h.execute).not.toHaveBeenCalled();
    }
  });

  it.each(["missing-context", "foreign-owner", "foreign-run", "mixed-images", "partial-foundation", "expired-fence", "active-stop", "changed-source"])(
    "retains %s rather than acquiring, extending, stealing or guessing a recoverable binding",
    async (failure) => {
      const h = harness("paper");
      const source = await h.capture();
      if (failure === "missing-context") delete h.needs["force-disable-rollout"].outputs.recovery_context;
      if (failure === "foreign-owner") h.state.fence = "foreign";
      if (failure === "expired-fence") h.state.fence = "expired";
      if (failure === "active-stop") h.state.fence = "stop-blocked";
      if (failure === "foreign-run") h.needs["force-disable-rollout"].outputs.recovery_context = JSON.stringify({ ...source, runId: 999 });
      if (failure === "mixed-images") h.state.corruptResource = (resources) => {
        resources.PREFLIGHT_JOB_NAME.properties.template.containers[0].image = "foreign";
      };
      if (failure === "partial-foundation") h.needs["force-disable-rollout"].outputs.existing_release = "false";
      if (failure === "changed-source") h.state.binding.webImageDigest = `sha256:${"f".repeat(64)}`;
      const failureResult = await h.recover().then(() => null, (error: Error & { recovery: Record<string, unknown> }) => error);
      expect(failureResult?.recovery).toMatchObject({ status: "retained", reason: "recovery-unverified" });
      expect(failureResult?.message).not.toContain(privateToken);
      expect(h.events).not.toContain("prod-recover-1001-a2");
      expect(h.state.mode).toBe("paper");
      expect(h.execute.mock.calls.some(([, args]) => args.includes("acquire") || args.includes("release"))).toBe(false);
    },
  );

  it.each(["rollout", "monitoring"])("rechecks ownership after the recovery %s preview", async (stage) => {
    const h = harness("paper");
    await h.capture();
    const execute = h.execute.getMockImplementation();
    if (!execute) throw new Error("Missing command fixture");
    h.execute.mockImplementation(async (command, args) => {
      const result = await execute(command, args);
      if (command === "az" && args.includes("what-if") &&
        args.some((arg) => arg.endsWith(stage === "rollout" ? "rollout.bicep" : "schedule-monitoring.bicep"))) {
        h.state.fence = "foreign";
      }
      return result;
    });
    await expect(h.recover()).rejects.toThrow("retained");
    expect(h.events).not.toContain(stage === "rollout" ? "prod-recover-1001-a2" : "prod-monitor-recover-1001-a2");
  });

  it("preserves a verified mutation-free deferral despite a publication failure, without any Azure execution", async () => {
    const h = harness("paper");
    h.needs["force-disable-rollout"] = { result: "success", outputs: {
      existing_release: "true", admission_status: "deferred",
    } };
    h.needs["publish-release-receipt"].result = "failure";
    await expect(h.recover()).resolves.toMatchObject({ status: "untouched", fence: "unknown" });
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.state.mode).toBe("paper");
    h.needs["deploy-environment"].result = "failure";
    await expect(h.recover()).rejects.toThrow("retained");
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("uses a single bounded clock and refuses expired recovery before Azure access", async () => {
    const h = harness();
    const now = Date.now();
    const clock = jest.spyOn(Date, "now").mockReturnValueOnce(now).mockReturnValueOnce(now + 1);
    const intent = api.createRecoveryIntent(h.env, h.needs);
    clock.mockRestore();
    expect(api.validateRecoveryReceipt(intent, h.env)).toBe(intent);
    h.env.PRODUCTION_RECOVERY_INTENT = JSON.stringify(intent);
    jest.setSystemTime(new Date(now + 3_600_000));
    await expect(h.recover()).rejects.toThrow("retained");
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("does not extend the deadline while previewing a recovery mutation", async () => {
    const h = harness("paper");
    await h.capture();
    const execute = h.execute.getMockImplementation();
    if (!execute) throw new Error("Missing command fixture");
    h.execute.mockImplementation(async (command, args) => {
      const result = await execute(command, args);
      if (command === "az" && args.includes("what-if")) jest.setSystemTime(new Date(Date.now() + 3_600_000));
      return result;
    });
    await expect(h.recover()).rejects.toThrow("retained");
    expect(h.events).not.toContain("prod-recover-1001-a2");
  });

  it.each(["owned", "expired", "released"])("uses fresh source-bound private proof and the existing signed release protocol for an %s fence", async (fence) => {
    const h = harness("paper");
    h.state.binding = { ...h.f.binding, releaseSha: "1".repeat(40), webImageDigest: `sha256:${"2".repeat(64)}` };
    const source = await h.capture();
    const recovered = await h.recover();
    h.state.fence = fence;
    const completed = await h.release(recovered);
    expect(completed).toMatchObject({ status: "disabled", scope: "source", fence: "released" });
    const attestation = h.execute.mock.calls.find(([, args]) => args.some((arg) => arg.endsWith("attest-cutover-state.ts")));
    expect(attestation).toBeDefined();
    if (!attestation) throw new Error("Missing private attestation");
    expect(value(attestation[1], "--runtime-release-sha")).toBe(h.state.binding.releaseSha);
    expect(value(attestation[1], "--source-release-sha")).toBe(h.state.binding.releaseSha);
    expect(value(attestation[1], "--candidate-release-sha")).toBe(h.f.sha);
    expect(value(attestation[1], "--owner")).toBe(source.owner);
    const releases = h.execute.mock.calls.filter(([, args]) => args.includes("--action") && args.includes("release"));
    expect(releases).toHaveLength(1);
    expect(releases[0][1]).toContain("--workflow-observation-proof");
    expect(value(releases[0][1], "--workflow-observation-digest")).toBe("d".repeat(64));
    expect(h.core.setSecret).toHaveBeenCalledWith(privateToken);
    expect(JSON.stringify(completed)).not.toContain(privateToken);
    expect(fs.readdirSync(h.directory)).toEqual([]);
  });

  it.each(["verify-disabled-rollout.sh", "attest-cutover-state.ts", "run-deployment-admission.sh"])(
    "retains failed fence completion at %s without retries, raw errors or private files",
    async (failure) => {
      const h = harness("paper");
      await h.capture();
      const receipt = await h.recover();
      h.execute.mockClear();
      h.state.failAt = failure;
      const error = await h.release(receipt).then(() => null, (error: Error & { recovery: Record<string, unknown> }) => error);
      expect(error?.recovery).toMatchObject({ status: "retained", reason: "fence-release-unverified" });
      expect(error?.message).not.toContain(privateToken);
      const attempts = h.execute.mock.calls.filter(([, args]) => args.some((arg) => arg.endsWith(failure)));
      expect(attempts).toHaveLength(1);
      expect(fs.readdirSync(h.directory)).toEqual([]);
    },
  );

  it("does not borrow a completed candidate cutover to change a restored source", async () => {
    const h = harness("paper");
    h.state.binding.releaseSha = "1".repeat(40);
    await h.capture();
    h.needs["release-cutover-fence"] = { result: "success", outputs: { status: "released" } };
    await expect(h.recover()).rejects.toThrow("retained");
    expect(h.events).not.toContain("prod-recover-1001-a2");
  });

  it("does not release a restored source after an attempted candidate migration", async () => {
    const h = harness("paper");
    await h.capture();
    h.needs["migrate-backup"].result = "failure";
    await expect(h.recover()).rejects.toThrow("retained");
    expect(h.events).not.toContain("prod-recover-1001-a2");
  });

  it("rejects extra private receipt fields and excludes unrelated live values from captured context", async () => {
    const h = harness();
    h.env.ROLLOUT_VALUES = JSON.stringify({ ...JSON.parse(h.env.ROLLOUT_VALUES), privateProof: privateToken });
    expect(JSON.stringify(await h.capture())).not.toContain(privateToken);
    const intent = api.createRecoveryIntent(h.env, h.needs);
    expect(() => api.validateRecoveryReceipt({ ...intent, privateProof: privateToken }, h.env)).toThrow("unknown or missing field");
    expect(() => api.validateRecoveryReceipt({ ...intent, runAttempt: 1 }, h.env)).toThrow("identity changed");
  });
});
