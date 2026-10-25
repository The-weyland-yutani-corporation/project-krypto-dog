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
}>("../../../.github/scripts/azure/production-promotion.cjs");
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
  const webImage = `${f.binding.registryLoginServer}/krypto-web@${f.binding.webImageDigest}`;
  const opsImage = `${f.binding.registryLoginServer}/krypto-ops@${f.binding.opsImageDigest}`;
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
    corruptResource: undefined as ((resources: Record<string, Resource>) => void) | undefined,
  };
  const events: string[] = [];
  const entries = (fields: Record<string, string>): Entry[] => Object.entries(fields).map(([name, value]) => ({ name, value }));
  function snapshot() {
    const web: Resource = {
      id: id(names.WEB_APP_NAME, true), name: names.WEB_APP_NAME,
      properties: {
        provisioningState: "Succeeded", latestRevisionName: "current", latestReadyRevisionName: "current",
        configuration: { activeRevisionsMode: "Single", ingress: { fqdn: "production.example.com" } },
        template: { containers: [{
          name: names.WEB_APP_NAME, image: webImage,
          env: entries({ APP_ORIGIN: f.binding.targetOrigin, ROLLOUT_MODE: state.mode }),
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
              ...entries({ TARGET_BASE_URL: f.binding.targetOrigin, SCHEDULED_ROUTE: route, ROLLOUT_MODE: state.mode }),
              ...(key === "PROD_HOURLY_JOB_NAME" ? entries({
                SCHEDULED_IDEMPOTENCY_NAMESPACE: `${f.binding.webImageDigest}-${state.generation}`,
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
              OPERATION: operation, ENVIRONMENT_NAME: "prod", RELEASE_SHA: f.sha,
              IMAGE_DIGEST: f.binding.webImageDigest, OPS_IMAGE_DIGEST: f.binding.opsImageDigest,
              TARGET_BASE_URL: f.binding.targetOrigin, DEPLOYMENT_REPOSITORY: f.env.GITHUB_REPOSITORY,
              DEPLOYMENT_REPOSITORY_ID: "456", DEPLOYMENT_REPOSITORY_OWNER_ID: "12",
            }),
          }] },
        },
      };
    }
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
  return {
    f, env, state, events, execute, github, core, directory, activeRun,
    run: (phase: string) => api.runProductionPromotion({ phase, github, core, owner: "owner", repo: "project", env, execute }),
    resolve: () => api.resolvePromotionAuthority({ github, core, owner: "owner", repo: "project", env, execute }),
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
});
