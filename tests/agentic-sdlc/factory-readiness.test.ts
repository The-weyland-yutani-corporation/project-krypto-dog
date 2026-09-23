import { baseIssues, goalBody, issue, NOW, workBody } from "./fixtures/factory-intake";

const readiness = require("../../.github/scripts/agentic-factory-readiness.cjs");
const { createReadOnlyReader } = require("../../.github/scripts/agentic-readiness-reader.cjs");
const { resolveIsLeaf, resolveHasOpenPullRequest, nativeParentMatchesRepository, formatMachineReceipt } = require("../../.github/scripts/agentic-queue-runtime.cjs");

function snapshot() {
  const issues = baseIssues();
  issues[2].labels = ["agentic-factory", "ready-for-ai-dev", "risk:routine", "priority:P1"];
  const details = Object.fromEntries(issues.map((item) => [item.number, {
    parent: { number: 248 }, subIssues: [], comments: [], blockedBy: [],
    timeline: item.labels.map((name) => ({ event: "labeled", label: { name }, actor: { type: "User" }, created_at: NOW })),
  }]));
  return {
    schemaVersion: 1, observedAt: NOW, repository: { owner: "example", repo: "krypto" },
    issues, details, pulls: [], reads: [] as { resource: string; complete: boolean; reason?: string; status?: number }[],
    capabilities: { modelVariables: [] as { name: string; value: string }[],
      modelAvailability: [] as { model: string; layer: string; availability: string; observedAt: string; evidenceRefs: string[] }[],
      workflows: [], branchProtection: null },
  };
}

describe("independent deterministic readiness diagnostics", () => {
  it("shows paused, multiple goals and malformed candidates together without selection", () => {
    const input = snapshot();
    input.issues[0].labels = ["factory-control", "factory-mode:paused"];
    input.issues.push(issue(274, {
      labels: ["factory:goal", "factory:goal-approved"], milestone: null,
      body: `${goalBody({ "Assignment budget": "not a number" })}\n\n### Allowed paths\n\ntests/**`,
    }));
    input.issues[2].body = workBody({ Dependencies: "_No response_", "Risk tier": "_No response_" });
    const report = readiness.buildFactoryReadinessReport(input);
    expect(report).toMatchObject({ readOnly: true, selectionAttempted: false, claimsAttempted: false });
    expect(report.mode.mode).toBe("paused");
    expect(report.goals.resolution).toBe("multiple-active-goals");
    expect(report.goals.items.find((goal: { number: number }) => goal.number === 274).reasons).toEqual(expect.arrayContaining([
      "goal-missing-milestone", "goal-invalid-assignment-budget", "duplicate-field:Allowed paths",
    ]));
    expect(report.candidates[0].reasons).toContain("dependencies-unknown");
    expect(report.candidates[0].authorizationReasons).toEqual(expect.arrayContaining(["factory-mode:paused", "multiple-active-goals"]));
    expect(report.candidates[0].authorized).toBe(false);
  });

  it("distinguishes a ready hypothetical candidate from paused authorization", () => {
    const input = snapshot();
    input.issues[0].labels = ["factory-control", "factory-mode:paused"];
    const report = readiness.buildFactoryReadinessReport(input);
    expect(report.candidates[0]).toMatchObject({ hypotheticalReady: true, authorized: false });
    expect(report.disposition[0].apply).toBe(false);
  });

  it("keeps claim/PR ownership and hard blocks in the recovery manifest", () => {
    const input = snapshot();
    input.issues[2].labels.push("blocked");
    input.issues[2].assignees = [{ login: "copilot" }];
    input.details[300].parent = { number: 16 };
    const report = readiness.buildFactoryReadinessReport(input);
    expect(report.candidates[0].reasons).toEqual(expect.arrayContaining(["native-parent-mismatch", "blocked-by-label"]));
    expect(report.disposition[0]).toMatchObject({ disposition: "preserve-in-flight", humanOnly: true, apply: false });
    expect(report.capacity).toMatchObject({
      inFlightCount: 0, accountingBasis: "canonical-lifecycle-labels",
      ownershipSignals: [300], unaccountedOwnership: [300], requiresHumanReconciliation: true,
    });
    expect(report.authorizationReasons).toContain("wip-label-accounting-inconsistent");
  });

  it("reports incomplete API/budget reads as unknown, never a healthy zero", () => {
    const input = snapshot();
    input.reads.push({ resource: "GET /repos/example/krypto/issues/300/comments", complete: false, reason: "api-read-failed", status: 403 });
    const report = readiness.buildFactoryReadinessReport(input);
    expect(report.completeness.complete).toBe(false);
    expect(report.capacity.inFlightCount).toBeNull();
    expect(report.goals.items[0].budgetUsed).toBeNull();
    expect(report.candidates[0].authorizationReasons).toContain("api-incomplete");
  });

  it("diagnoses all independent malformed goal dimensions, not the first failure", () => {
    const diagnostic = readiness.diagnoseGoalIssue(issue(248, { milestone: null, body: goalBody({
      Objective: "_No response_", "Allowed paths": "../escape",
      "Maximum autonomous risk tier": "safe", "Maximum active coding-agent sessions": "12",
      "Assignment budget": "twelve", "Human-only boundaries": "- [x] only one unchecked boundary omitted",
    }) }));
    expect(diagnostic.reasons).toEqual(expect.arrayContaining([
      "goal-missing-milestone", "goal-invalid-max-wip", "goal-invalid-assignment-budget",
      "goal-invalid-max-risk", "goal-invalid-allowed-paths", "goal-boundaries-not-fully-checked", "missing-field:Objective",
    ]));
  });

  it("separates override configuration, runtime support and retained provider observations", () => {
    const input = snapshot();
    input.capabilities.modelVariables = [{ name: "GH_AW_DEFAULT_MODEL_COPILOT", value: "claude-sonnet-5" }];
    input.capabilities.modelAvailability = [{
      model: "claude-sonnet-5", layer: "runtime", availability: "unsupported",
      observedAt: "2026-09-15T05:57:14Z", evidenceRefs: ["https://github.com/example/krypto/actions/runs/1"],
    }];
    const models = readiness.buildFactoryReadinessReport(input).capabilities.models;
    expect(models.agent).toMatchObject({ effective: "claude-sonnet-5", source: "default-override", runtimeSupported: "unknown", providerAvailable: "unknown" });
    expect(models.agent.retainedObservations[0]).toMatchObject({ layer: "runtime", availability: "unsupported" });
    expect(models.detection.effective).toBe("claude-sonnet-5");
    input.capabilities.modelVariables = [];
    expect(readiness.buildFactoryReadinessReport(input).capabilities.models.agent).toMatchObject({ effective: "claude-sonnet-4.6", source: "compiled-fallback" });
  });

  it("makes unavailable model-variable access explicit rather than assuming the fallback is effective", () => {
    const input = snapshot();
    input.reads.push({ resource: "GET /repos/example/krypto/actions/variables", complete: false, status: 403 });
    expect(readiness.buildFactoryReadinessReport(input).capabilities.models.agent.effective).toBeNull();
  });

  it("reports reserved handoffs as human recovery instead of quietly reauthoring another issue", () => {
    const receipt = { body: formatMachineReceipt("reservation", { stage: "pm", fingerprint: "reserved" }),
      created_at: NOW, updated_at: NOW,
      user: { login: "github-actions[bot]", type: "Bot" } };
    expect(readiness.inspectIntakeReceipts([receipt])).toMatchObject({
      reasons: ["intake-reservation-unresolved-human-recovery"],
      entries: [{ stage: "pm", status: "reserved-unresolved", implementingIssue: null }],
    });
  });
});

describe("bounded read-only GitHub adapter", () => {
  it("reads subsequent pages and reports truncation explicitly at the configured bound", async () => {
    const github = { request: jest.fn(async (_route: string, params: { page: number }) => ({
      data: params.page === 1 ? Array.from({ length: 100 }, (_, number) => ({ number })) : [{ number: 101 }],
      headers: params.page === 1 ? { link: '<https://api.github.com/repos/example/krypto/issues?page=2>; rel="next"' } : {},
    })) };
    const reader = createReadOnlyReader({ github, owner: "example", repo: "krypto" });
    expect(await reader.list("GET /repos/{owner}/{repo}/issues")).toHaveLength(101);
    expect(reader.reads[0]).toMatchObject({ complete: true, pages: 2 });
    const capped = createReadOnlyReader({ github, owner: "example", repo: "krypto", maxPages: 1 });
    expect(await capped.list("GET /repos/{owner}/{repo}/issues")).toHaveLength(100);
    expect(capped.reads[0]).toMatchObject({ complete: false, reason: "api-list-incomplete" });
  });

  it("does not treat malformed lists or permission failures as empty success", async () => {
    const malformed = createReadOnlyReader({
      github: { request: async () => ({ data: { unknown: [] } }) }, owner: "example", repo: "krypto",
    });
    await malformed.list("GET /repos/{owner}/{repo}/issues");
    expect(malformed.reads[0].complete).toBe(false);
    const denied = createReadOnlyReader({
      github: { request: async () => { throw Object.assign(new Error("Forbidden"), { status: 403 }); } }, owner: "example", repo: "krypto",
    });
    expect(await denied.get("GET /repos/{owner}/{repo}/issues/1")).toBeUndefined();
    expect(denied.reads[0]).toMatchObject({ complete: false, status: 403 });
  });

  it.each([
    undefined,
    { items: [] },
    [{ number: 900 }],
    [{ number: 900, body: 42 }],
  ])("fails closed on incomplete or malformed PR list evidence: %j", async (data) => {
    const core = { warning: jest.fn() };
    const github = {
      rest: { pulls: { list: async () => data } },
      paginate: async (method: () => Promise<unknown>) => method(),
    };
    expect(await resolveHasOpenPullRequest({ github, core, owner: "example", repo: "krypto", issueNumber: 300 })).toBe(true);
    expect(core.warning).toHaveBeenCalled();
  });

  it("refuses mutating routes before any GitHub request", async () => {
    const github = { request: jest.fn() };
    const reader = createReadOnlyReader({ github, owner: "example", repo: "krypto" });
    await reader.get("PATCH /repos/{owner}/{repo}/issues/1");
    expect(github.request).not.toHaveBeenCalled();
    expect(reader.reads[0].complete).toBe(false);
  });

  it("rejects a foreign native parent with the same issue number or missing repository identity", () => {
    expect(nativeParentMatchesRepository({ number: 248, repository_url: "https://api.github.com/repos/foreign/other" }, "example", "krypto")).toBe(false);
    expect(nativeParentMatchesRepository({ number: 248 }, "example", "krypto")).toBe(false);
    expect(nativeParentMatchesRepository({ number: 248, repository_url: "https://api.github.com/repos/example/krypto" }, "example", "krypto")).toBe(true);
  });
  it("fails closed on unadvertised remaining pages and unknown sub-issue shapes", async () => {
    const github = { request: jest.fn(async (_route: string, params: { page: number }) => ({
      data: params.page === 1 ? Array.from({ length: 100 }, () => ({ state: "closed" })) : [{ state: "open" }],
    })) };
    expect(await resolveIsLeaf({ github, owner: "example", repo: "krypto", issueNumber: 300, core: { warning: jest.fn() } })).toBe(false);
    expect(github.request).toHaveBeenCalledTimes(2);
    const bad = { request: async () => ({ data: { sub_issues: [] } }) };
    expect(await resolveIsLeaf({ github: bad, owner: "example", repo: "krypto", issueNumber: 300, core: { warning: jest.fn() } })).toBe(false);
  });
});
