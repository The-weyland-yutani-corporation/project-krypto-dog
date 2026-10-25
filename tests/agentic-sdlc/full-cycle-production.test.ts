import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { productionPromotionFixture } from "../deployment/azure/production-promotion-fixture";

const root = path.resolve(__dirname, "../..");
const workflow = z.object({
  jobs: z.object({
    "full-cycle": z.object({
      "timeout-minutes": z.number(),
      steps: z.array(z.object({
        name: z.string(), with: z.object({ script: z.string().optional() }).passthrough().optional(),
      })),
    }),
  }),
}).parse(parse(fs.readFileSync(path.join(root, ".github", "workflows", "agentic-factory-full-e2e.yml"), "utf8")));
const script = z.string().parse(workflow.jobs["full-cycle"].steps.find(
  (step) => step.name === "Wait for verified terminal paper-production state",
)?.with?.script);
const actualLifecycle = jest.requireActual<Record<string, unknown>>("../../.github/scripts/agentic-lifecycle-reconciler.cjs");
const policy = jest.requireActual<Record<string, unknown>>("../../.github/scripts/agentic-factory-policy.cjs");
const productionEvidence = jest.requireActual<Record<string, unknown>>("../../.github/scripts/azure/production-evidence.cjs");

function harness() {
  const f = productionPromotionFixture();
  const actor = { id: 198982749, node_id: "BOT_kgDOC9w8XQ", type: "Bot", login: "copilot-swe-agent[bot]" };
  const issue = { number: 42, state: "closed", state_reason: "completed", labels: [{ name: "factory:done" }], body: "Canary scope" };
  const claim = {
    id: 1, created_at: f.time(-240), user: { id: 41898282, login: "github-actions[bot]", type: "Bot" },
    body: `<!-- factory-claim:v1 ${JSON.stringify({
      nonce: "600:1:42", owner: "queue-controller:600:1", issueNumber: 42, expiresAt: f.time(-120),
    })} -->`,
  };
  const pull = {
    number: 43, title: "[ai-dev] Refresh the heartbeat", body: "<!-- factory-claim:600:1:42 -->\nRefs #42",
    state: "closed", draft: false, merged_at: f.time(-170), merge_commit_sha: f.sha, user: actor,
    head: { sha: "c".repeat(40), repo: { full_name: "owner/project" } }, base: { ref: "main" },
  };
  const files = [{ filename: "docs/e2e/factory-full-heartbeat.md", status: "modified" }];
  const listComments = jest.fn();
  const listPulls = jest.fn();
  const listFiles = jest.fn();
  const getContent = jest.fn(async () => ({ data: {
    type: "file", content: Buffer.from(
      `[run 500](https://github.com/owner/project/actions/runs/500)\n${f.time(-240)}`,
    ).toString("base64"),
  } }));
  const github = {
    ...f.github,
    rest: {
      ...f.github.rest,
      issues: { get: jest.fn(async () => ({ data: issue })), listComments },
      pulls: { list: listPulls, listFiles },
      repos: { ...f.github.rest.repos, get: jest.fn(async () => ({ data: { id: 456, default_branch: "main" } })), getContent },
    },
    paginate: jest.fn(async (method: unknown, args: Record<string, unknown>) => {
      if (method === listComments) return [claim];
      if (method === listPulls) return [pull];
      if (method === listFiles) return files;
      return f.github.paginate(method, args);
    }),
  };
  const verifyAssignment = jest.fn(async () => ({ valid: true }));
  const resolveMode = jest.fn(async () => "active");
  const lifecycle = { ...actualLifecycle, verifyPersistedAssignmentProvenance: verifyAssignment, resolveFactoryMode: resolveMode };
  const identity = {
    resolveRepositoryCopilotIdentity: jest.fn(async () => ({
      nodeId: actor.node_id, databaseId: actor.id, suggestedLogin: "copilot-swe-agent",
    })),
    normalizeConfiguredUserNodeId: jest.fn(() => "U_assignment"),
  };
  const requireModule = (name: string) => {
    if (name === "node:path") return path;
    if (name.endsWith("agentic-lifecycle-reconciler.cjs")) return lifecycle;
    if (name.endsWith("agentic-factory-policy.cjs")) return policy;
    if (name.endsWith("production-evidence.cjs")) return productionEvidence;
    if (name.endsWith("agentic-identity.cjs")) return identity;
    throw new Error(`Unexpected canary module ${name}`);
  };
  const core = { info: jest.fn() };
  const env = {
    CANARY_ISSUE: "42", REQUESTED_AT: f.time(-240), FACTORY_ASSIGNMENT_ACTOR_NODE_ID: "U_assignment",
    GITHUB_WORKSPACE: root, GITHUB_RUN_ID: "500", GITHUB_REPOSITORY: "owner/project", GITHUB_SERVER_URL: "https://github.com",
  };
  const execute = new Function("github", "context", "core", "require", "process", `return (async () => { ${script} })();`);
  return {
    f, issue, claim, pull, files, github, core, identity, resolveMode, verifyAssignment, getContent,
    run: () => execute(github, { repo: { owner: "owner", repo: "project" } }, core, requireModule, { env }) as Promise<void>,
  };
}

describe("full canary paper-production proof", () => {
  beforeEach(() => jest.useFakeTimers({ now: new Date("2026-10-22T01:05:00Z") }));
  afterEach(() => jest.useRealTimers());

  it("executes the actual canary body against native production and development archives", async () => {
    const h = harness();
    await h.run();
    expect(h.verifyAssignment).toHaveBeenCalledWith(expect.objectContaining({
      claim: expect.objectContaining({ nonce: "600:1:42" }), assignmentActorNodeId: "U_assignment",
    }));
    expect(h.identity.resolveRepositoryCopilotIdentity).toHaveBeenCalledWith(expect.objectContaining({ verifyPinnedIdentity: true }));
    expect(h.f.github.rest.actions.downloadArtifact).toHaveBeenCalledWith(expect.objectContaining({ artifact_id: 502 }));
    expect(h.core.info).toHaveBeenCalledWith(expect.stringContaining("scheduled paper-production evidence"));
    expect(workflow.jobs["full-cycle"]["timeout-minutes"]).toBe(360);
    expect(script).toContain("330 * 60 * 1000");
  });

  it.each(["pending", "failed", "missing-archive", "wrong-source", "wrong-assignment", "wrong-scope", "wrong-heartbeat"])(
    "rejects completion with %s evidence",
    async (problem) => {
      const h = harness();
      if (problem === "pending") h.f.run.status = "in_progress";
      if (problem === "failed") h.f.run.conclusion = "failure";
      if (problem === "missing-archive") h.f.artifacts.length = 0;
      if (problem === "wrong-source") h.pull.merge_commit_sha = "f".repeat(40);
      if (problem === "wrong-assignment") h.verifyAssignment.mockResolvedValue({ valid: false });
      if (problem === "wrong-scope") h.files.push({ filename: "src/trading/execute.ts", status: "modified" });
      if (problem === "wrong-heartbeat") h.getContent.mockResolvedValue({
        data: { type: "file", content: Buffer.from("[run 5000](https://elsewhere.example.com)").toString("base64") },
      });
      await expect(h.run()).rejects.toThrow();
      expect(h.core.info).not.toHaveBeenCalledWith(expect.stringContaining("completed through"));
    },
  );

  it("requires a claim-owned PR and honors a late factory pause", async () => {
    const h = harness();
    h.pull.body = "Refs #42";
    await expect(h.run()).rejects.toThrow("claim-owned");
    h.pull.body = "<!-- factory-claim:600:1:42 -->\nRefs #42";
    h.resolveMode.mockResolvedValueOnce("active").mockResolvedValue("paused");
    await expect(h.run()).rejects.toThrow("stopped during final");
  });

  it("does not treat a closed issue without factory:done as success", async () => {
    const h = harness();
    h.issue.labels = [{ name: "factory:deployed-dev" }];
    await expect(h.run()).rejects.toThrow("closed without factory completion evidence");
  });

  it.each(["claim", "scope", "merge", "reopened", "not-planned", "ambiguous-labels", "assignment"])(
    "rechecks %s after loading the native production proof",
    async (change) => {
      const h = harness();
      const read = h.f.github.rest.repos.listDeploymentStatuses.getMockImplementation();
      if (!read) throw new Error("Missing native fixture");
      h.f.github.rest.repos.listDeploymentStatuses.mockImplementation(async () => {
        if (change === "claim") h.claim.body = "No claim remains";
        if (change === "scope") h.issue.body = "Changed scope";
        if (change === "merge") h.pull.merge_commit_sha = "f".repeat(40);
        if (change === "reopened") h.issue.state = "open";
        if (change === "not-planned") h.issue.state_reason = "not_planned";
        if (change === "ambiguous-labels") h.issue.labels.push({ name: "factory:deployed-dev" });
        if (change === "assignment") h.verifyAssignment.mockResolvedValue({ valid: false });
        return read();
      });
      await expect(h.run()).rejects.toThrow();
      expect(h.core.info).not.toHaveBeenCalledWith(expect.stringContaining("completed through"));
    },
  );

  it("fails at its bounded polling deadline without inventing a successful terminal state", async () => {
    const h = harness();
    h.issue.state = "open";
    h.issue.labels = [{ name: "factory:deployed-dev" }];
    h.github.rest.issues.get.mockImplementation(async () => {
      jest.setSystemTime(new Date(h.f.time(396)));
      return { data: h.issue };
    });
    const outcome = expect(h.run()).rejects.toThrow("Timed out waiting");
    await jest.advanceTimersByTimeAsync(30_000);
    await outcome;
    expect(h.f.github.rest.actions.downloadArtifact).not.toHaveBeenCalled();
  });
});
