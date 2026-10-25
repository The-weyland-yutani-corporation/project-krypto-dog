import fs from "node:fs";
import path from "node:path";
import { creditFixture } from "./credit-admission-fixture";

const { AGENTIC_POLICY } = jest.requireActual<{
  AGENTIC_POLICY: {
    autonomy: {
      goalTitle: string; milestone: string; maxAssignmentsPerDay: number;
      tradingResearch: { market: string; startingCapitalUSD: number; targetDailyNetProfitUSD: number; paperOnly: boolean; allowLeverage: boolean };
    };
    copilotBotNodeId: string; copilotBotDatabaseId: number;
  };
}>("../../.github/scripts/agentic-policy.cjs");
const autonomy = jest.requireActual<{
  renderAutonomousGoal(): string;
  isAutonomousGoal(issue: object): boolean;
}>("../../.github/scripts/agentic-autonomy.cjs");
const intake = jest.requireActual<{
  dispatchDecision(runs: object[], correlation: string, maxAttempts?: number): string;
  runFactoryIntake(input: Record<string, unknown>): Promise<void>;
}>("../../.github/scripts/agentic-intake-controller.cjs");
const queue = jest.requireActual<{
  runFactoryQueueController(input: Record<string, unknown>): Promise<{ mode: string; dispatched: boolean }>;
  resolveActiveGoal(issues: object[], options: { autonomous: boolean }): {
    valid: boolean; reason: string; goal: { dailyBudgetLimit: number } | null;
  };
  countBudgetConsumption(github: object, owner: string, repo: string, goal: number, core: object, since?: string): Promise<number>;
}>("../../.github/scripts/agentic-queue-runtime.cjs");
const reconciler = jest.requireActual<{
  hasPendingSpecialistReview(input: { requiredChecks: string[]; checkStates: Record<string, string>; ciFailed: boolean; autonomous: boolean }): boolean;
  evaluateMergePolicy(input: Record<string, unknown>): {
    state: string; description: string; requiresHumanBoundaryApproval: boolean;
  };
}>("../../.github/scripts/agentic-pr-reconciler.cjs");
const lifecycle = jest.requireActual<{
  resolveFactoryMode(input: Record<string, unknown>): Promise<string>;
  ensureAutoMergeEnabled(input: Record<string, unknown>): Promise<void>;
}>("../../.github/scripts/agentic-lifecycle-reconciler.cjs");
const identity = jest.requireActual<{
  resolveRepositoryCopilotIdentity(input: Record<string, unknown>): Promise<{ nodeId: string; databaseId: number }>;
}>("../../.github/scripts/agentic-identity.cjs");
const promoter = jest.requireActual<{
  runBacklogPromoter(input: Record<string, unknown>): Promise<{ mode: string }>;
}>("../../.github/scripts/agentic-backlog-promoter-runtime.cjs");

describe("operator-owned emergency pause", () => {
  it.each(["Bot", "Organization"])("does not accept a %s-written activation in autonomous mode", async (type) => {
    const github = {
      rest: { issues: { listForRepo: "issues", listEventsForTimeline: "timeline" } },
      paginate: jest.fn(async (endpoint: string) => endpoint === "issues"
        ? [{ number: 1, labels: ["factory-mode:active"] }]
        : [{ id: 1, event: "labeled", label: { name: "factory-mode:active" }, actor: { type }, created_at: "2026-10-18T12:00:00Z" }]),
    };
    const summary = { addRaw: jest.fn().mockReturnThis(), write: jest.fn() };
    const core = { info: jest.fn(), warning: jest.fn(), summary };
    const input = { github, core, context: { repo: { owner: "o", repo: "r" } }, config: { autonomous: true } };
    expect(await queue.runFactoryQueueController(input)).toMatchObject({ mode: "paused", dispatched: false });
    expect(await promoter.runBacklogPromoter(input)).toMatchObject({ mode: "paused" });
    expect(await lifecycle.resolveFactoryMode({ github, core, owner: "o", repo: "r", autonomous: true })).toBe("paused");
  });
});

describe("canonical Copilot identity", () => {
  it("verifies stable Bot IDs independently of suggested-actor visibility and display login", async () => {
    const request = jest.fn(async () => ({ data: {
      type: "Bot", login: "Copilot",
      node_id: AGENTIC_POLICY.copilotBotNodeId, id: AGENTIC_POLICY.copilotBotDatabaseId,
    } }));
    const graphql = jest.fn();
    expect(await identity.resolveRepositoryCopilotIdentity({
      github: { request, graphql },
      owner: "o", repo: "r", verifyPinnedIdentity: true,
    })).toMatchObject({
      nodeId: AGENTIC_POLICY.copilotBotNodeId, databaseId: AGENTIC_POLICY.copilotBotDatabaseId,
    });
    expect(graphql).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith("GET /user/{account_id}", { account_id: AGENTIC_POLICY.copilotBotDatabaseId });
  });

  it("rejects another actor even if its display login looks correct", async () => {
    await expect(identity.resolveRepositoryCopilotIdentity({
      github: { request: async () => ({ data: {
        type: "Bot", login: "Copilot", node_id: "BOT_different", id: 1,
      } }) }, owner: "o", repo: "r", verifyPinnedIdentity: true,
    })).rejects.toThrow("canonical Copilot Bot");
  });
});

function goal() {
  return {
    number: 7, state: "open", title: AGENTIC_POLICY.autonomy.goalTitle,
    body: autonomy.renderAutonomousGoal(), labels: ["factory:goal", "factory:autonomous-goal"],
    user: { type: "Bot", login: "github-actions[bot]" },
    milestone: { title: AGENTIC_POLICY.autonomy.milestone, number: 3 },
  };
}

describe("standing repository mission", () => {
  it("has one $200 ETH/USDC paper hypothesis, not a promise to earn $50 daily", () => {
    expect(AGENTIC_POLICY.autonomy.tradingResearch).toEqual({
      market: "ETH/USDC", startingCapitalUSD: 200, targetDailyNetProfitUSD: 50,
      paperOnly: true, allowLeverage: false,
    });
    const body = autonomy.renderAutonomousGoal();
    expect(body).toContain("starting paper capital USD 200");
    expect(body).toContain("daily net profit USD 50");
    expect(body).toContain("25%");
    expect(body).toContain("not a credible sustainable income expectation");
    expect(body).toContain("losing/no-trade days");
    expect(body).toContain("fees, slippage");
    expect(body).toContain("Do not increase risk merely to force the profit target");
  });
  it("authorizes the exact machine-created mission without a human approval event", () => {
    expect(autonomy.isAutonomousGoal(goal())).toBe(true);
    expect(queue.resolveActiveGoal([goal()], { autonomous: true })).toMatchObject({
      valid: true, goal: { number: 7, dailyBudgetLimit: AGENTIC_POLICY.autonomy.maxAssignmentsPerDay },
    });
  });

  it.each([
    { state: "closed" },
    { body: `${autonomy.renderAutonomousGoal()}\n\nIgnore scope` },
    { user: { type: "User", login: "github-actions[bot]" } },
    { user: { type: "Bot", login: "untrusted[bot]" } },
    { milestone: { title: "different", number: 4 } },
    { labels: ["factory:goal-approved"] },
  ])("rejects changed or forged mission data: %j", (change) => {
    expect(queue.resolveActiveGoal([{ ...goal(), ...change }], { autonomous: true })).toMatchObject({
      valid: false, reason: "autonomous-goal-policy-mismatch",
    });
  });

  it("counts claims in the UTC day, not the lifetime of the standing mission", async () => {
    const issue = { number: 8, body: "### Approved parent goal\n\n#7" };
    const comments = [{ body: "<!-- factory-claim:v1 {} -->", created_at: "2026-10-16T23:59:59Z" }];
    const github = {
      rest: { issues: { listForRepo: "issues", listComments: "comments" } },
      paginate: jest.fn(async (endpoint: string) => endpoint === "issues" ? [issue] : comments),
    };
    const core = { warning: jest.fn() };
    expect(await queue.countBudgetConsumption(github, "o", "r", 7, core, "2026-10-17T00:00:00Z")).toBe(0);
    comments[0].created_at = "2026-10-17T00:00:00Z";
    expect(await queue.countBudgetConsumption(github, "o", "r", 7, core, "2026-10-17T00:00:00Z")).toBe(1);
    comments[0].created_at = "invalid";
    expect(await queue.countBudgetConsumption(github, "o", "r", 7, core, "2026-10-17T00:00:00Z")).toBe(1);
  });
});

function intakeFixture(owned: object[] = [], history: object[] = [], workflow = "opportunity-discovery.lock.yml") {
  const dispatch = jest.fn(async () => undefined);
  const credits = creditFixture(workflow, "o/r", "2026-10-17T12:00:00Z");
  const github = {
    rest: { issues: { listForRepo: "issues" }, actions: { ...credits.api, createWorkflowDispatch: dispatch } },
    paginate: jest.fn(async (endpoint: unknown) => {
      if (endpoint === "issues") return [{ number: 99, labels: ["ready-for-ai-dev"] }];
      if (endpoint === credits.api.listWorkflowRuns) return history;
      return owned;
    }),
  };
  return {
    github, core: { info: jest.fn(), warning: jest.fn() },
    context: { repo: { owner: "o", repo: "r" }, payload: { repository: { default_branch: "main" } } },
    now: "2026-10-17T12:00:00Z",
    queueResult: { mode: "active", activeGoal: { number: 7, concurrencyLimit: 1 }, budgetRemaining: 2 },
    dispatch, credits,
  };
}

describe("durable intake handoffs", () => {
  it("dispatches discovery despite unrelated legacy backlog", async () => {
    const fixture = intakeFixture();
    await intake.runFactoryIntake(fixture);
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
    expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      workflow_id: "opportunity-discovery.lock.yml", ref: "main",
      inputs: expect.objectContaining({ correlation_id: "factory-intake:2026-10-17:discovery" }),
    }));
  });

  it("explicitly dispatches bot-labeled planning with native issue context", async () => {
    const fixture = intakeFixture([{ number: 8, state: "open", labels: ["ready-for-planning"] }]);
    await intake.runFactoryIntake(fixture);
    expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      workflow_id: "em-planning.lock.yml",
      inputs: expect.objectContaining({ scope: "8", aw_context: '{"item_type":"issue","item_number":8}' }),
    }));
  });

  it.each(["paused", "shadow"])("does not read or mutate intake in %s mode", async (mode) => {
    const fixture = intakeFixture();
    fixture.queueResult.mode = mode;
    await intake.runFactoryIntake(fixture);
    expect(fixture.github.paginate).not.toHaveBeenCalled();
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("does not intake new work after the daily budget is exhausted", async () => {
    const fixture = intakeFixture();
    fixture.queueResult.budgetRemaining = 0;
    await intake.runFactoryIntake(fixture);
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("does not retry a dispatch that throws or times out within the pass", async () => {
    const fixture = intakeFixture();
    fixture.dispatch.mockRejectedValueOnce(new Error("timeout: acceptance unknown"));
    await expect(intake.runFactoryIntake(fixture)).rejects.toThrow("acceptance unknown");
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
  });

  it("sees outstanding stages from before midnight independently of today's attempt window", async () => {
    const fixture = intakeFixture([{ number: 8, state: "open", labels: ["ready-for-planning"] }]);
    fixture.github.paginate.mockImplementation(async (endpoint: unknown, ...args: unknown[]) => {
      if (endpoint === "issues") return [];
      if (endpoint !== fixture.credits.api.listWorkflowRuns) return [{ number: 8, state: "open", labels: ["ready-for-planning"] }];
      const params = args[0] as { status?: string };
      if (params.status) expect(params).not.toHaveProperty("created");
      return params.status === "queued" ? [{ status: "queued", created_at: "2026-10-16T23:59:59Z" }] : [];
    });
    await intake.runFactoryIntake(fixture);
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(fixture.github.paginate).toHaveBeenCalledWith(
      fixture.credits.api.listWorkflowRuns,
      expect.objectContaining({ workflow_id: "em-planning.lock.yml", status: "queued" }),
    );
  });

  it("does not substitute discovery when an owned planning stage exceeds its credit limit", async () => {
    const fixture = intakeFixture([{ number: 8, state: "open", labels: ["ready-for-planning"] }], [], "em-planning.lock.yml");
    fixture.credits.addRun(3001);
    await intake.runFactoryIntake(fixture);
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(fixture.credits.api.downloadArtifact).toHaveBeenCalledTimes(1);
    expect(fixture.core.info).toHaveBeenCalledWith(expect.stringContaining("rolling-credit-limit"));
  });

  it("leaves exhausted discovery undispatched for a later scheduled pass", async () => {
    const fixture = intakeFixture();
    fixture.credits.addRun(2001);
    await intake.runFactoryIntake(fixture);
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(fixture.core.info).toHaveBeenCalledWith(expect.stringContaining("2001/2000"));
  });

  it("does not advance intake after implementation credit deferral", async () => {
    const fixture = intakeFixture();
    Object.assign(fixture.queueResult, { creditAdmission: { allowed: false } });
    await intake.runFactoryIntake(fixture);
    expect(fixture.github.paginate).not.toHaveBeenCalled();
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("fails explicitly on missing credit evidence before requesting any workflow", async () => {
    const fixture = intakeFixture();
    fixture.credits.addRun(1);
    fixture.credits.api.listWorkflowRunArtifacts.mockResolvedValue({ data: { total_count: 0, artifacts: [] } });
    await expect(intake.runFactoryIntake(fixture)).rejects.toThrow("unique latest-run");
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("suppresses active, completed, and exhausted duplicate stages", () => {
    expect(intake.dispatchDecision([{ status: "in_progress" }], "x")).toBe("running");
    expect(intake.dispatchDecision([{ status: "completed", conclusion: "success", display_title: "x" }], "x")).toBe("completed");
    expect(intake.dispatchDecision([
      { status: "completed", conclusion: "failure", display_title: "x" },
      { status: "completed", conclusion: "failure", display_title: "x" },
    ], "x")).toBe("attempts-exhausted");
  });

  it("does not let a known outstanding intake run block a different issue", () => {
    expect(intake.dispatchDecision([{
      status: "in_progress", display_title: "factory-intake:2026-10-17:8:em-planning.lock.yml",
    }], "factory-intake:2026-10-17:9:em-planning.lock.yml")).toBe("dispatch");
  });

  it("matches the same outstanding issue across UTC day boundaries", () => {
    expect(intake.dispatchDecision([{
      status: "queued", display_title: "factory-intake:2026-10-16:8:em-planning.lock.yml",
    }], "factory-intake:2026-10-17:8:em-planning.lock.yml")).toBe("running");
  });
});

const sha = "a".repeat(40);
function mergeInput() {
  return {
    autonomous: true,
    repository: "o/r",
    factoryMode: "active",
    copilotIdentity: { nodeId: AGENTIC_POLICY.copilotBotNodeId, databaseId: AGENTIC_POLICY.copilotBotDatabaseId },
    agentImplementationProvenance: true,
    issueAllowedPaths: [".github/workflows/**"],
    goalMaxRiskTier: "risk:boundary",
    pullRequest: {
      number: 8, title: "[ai-dev] Improve factory", state: "open", draft: false,
      body: "<!-- factory-claim:run:1:8 -->\nRefs #8",
      user: { type: "Bot", login: "Copilot", node_id: AGENTIC_POLICY.copilotBotNodeId, id: AGENTIC_POLICY.copilotBotDatabaseId },
      labels: [{ name: "agentic-automerge" }],
      head: { sha, repo: { full_name: "o/r" } },
    },
    files: [{ filename: ".github/workflows/ci.yml", status: "modified" }],
    reviews: [] as object[],
    checkRuns: ["Agentic code review", "QA verification", "Security review"].map((name, index) => ({
      id: index + 1, name, head_sha: sha, app: { slug: "github-actions" }, status: "completed", conclusion: "success",
    })),
  };
}

describe("machine-verified boundary merge", () => {
  it("lets a failed CI be repaired before dependent QA without skipping other specialist reviews", () => {
    const state = {
      requiredChecks: ["QA verification", "Security review"],
      checkStates: { "QA verification": "missing", "Security review": "success" },
      ciFailed: true, autonomous: true,
    };
    expect(reconciler.hasPendingSpecialistReview(state)).toBe(false);
    state.checkStates["Security review"] = "pending";
    expect(reconciler.hasPendingSpecialistReview(state)).toBe(true);
    state.checkStates["Security review"] = "success";
    state.ciFailed = false;
    expect(reconciler.hasPendingSpecialistReview(state)).toBe(true);
  });
  it("requires all current-head machine reviews but no per-change human approval", () => {
    expect(reconciler.evaluateMergePolicy(mergeInput())).toMatchObject({
      state: "success", requiresHumanBoundaryApproval: false,
    });
  });

  it("does not let a label authorize a human-authored PR", () => {
    const input = mergeInput();
    input.pullRequest.title = "Unowned factory change";
    input.pullRequest.user.type = "User";
    input.pullRequest.user.login = "collaborator";
    input.pullRequest.body = "";
    expect(reconciler.evaluateMergePolicy(input)).toMatchObject({
      state: "pending", description: "Autonomous merge requires a trusted factory-owned pull request",
    });
  });

  it("rejects Copilot implementations without valid claim provenance", () => {
    const input = mergeInput();
    input.agentImplementationProvenance = false;
    expect(reconciler.evaluateMergePolicy(input).state).toBe("pending");
  });

  it("limits the trusted docs-sync exception to documentation paths", () => {
    const input = mergeInput();
    input.pullRequest.title = "[docs-sync] Document workflow";
    input.pullRequest.body = "";
    input.pullRequest.user.login = "github-actions[bot]";
    input.pullRequest.user.id = 41898282;
    input.pullRequest.user.node_id = "MDM6Qm90NDE4OTgyODI=";
    expect(reconciler.evaluateMergePolicy(input)).toMatchObject({
      state: "pending", description: "PR changes escape issue allowed paths",
    });
    input.files = [{ filename: "docs/workflow-guide.md", status: "modified" }];
    expect(reconciler.evaluateMergePolicy(input).state).toBe("success");
  });

  it.each(["QA verification", "Security review", "Agentic code review"])("holds a boundary change missing %s", (missing) => {
    const input = mergeInput();
    input.checkRuns = input.checkRuns.filter((check) => check.name !== missing);
    expect(reconciler.evaluateMergePolicy(input).state).toBe("pending");
  });

  it("rejects a stale-head or foreign-app review", () => {
    const input = mergeInput();
    input.checkRuns[0].head_sha = "b".repeat(40);
    expect(reconciler.evaluateMergePolicy(input).state).toBe("pending");
    input.checkRuns[0].head_sha = sha;
    input.checkRuns[0].app.slug = "untrusted";
    expect(reconciler.evaluateMergePolicy(input).state).toBe("pending");
  });

  it("retains an explicit current-head review veto", () => {
    const input = mergeInput();
    input.reviews = [{ id: 1, state: "CHANGES_REQUESTED", commit_id: sha, author_association: "OWNER", user: { login: "owner", type: "User" } }];
    expect(reconciler.evaluateMergePolicy(input).state).toBe("pending");
  });

  it("binds native auto-merge to the verified head", async () => {
    const graphql = jest.fn(async () => ({}));
    await lifecycle.ensureAutoMergeEnabled({
      github: { graphql }, core: { info: jest.fn() }, expectedHeadOid: sha,
      pullRequest: { ...mergeInput().pullRequest, node_id: "PR_test" },
    });
    expect(graphql).toHaveBeenCalledWith(expect.stringContaining("expectedHeadOid"), { pullRequestId: "PR_test", expectedHeadOid: sha });
  });

  it("opts the live controllers into the autonomous contract explicitly", () => {
    for (const workflow of ["factory-queue-controller.yml", "factory-backlog-promoter.yml", "agentic-pr-reconciler.yml", "agentic-lifecycle-reconciler.yml", "agentic-automerge-sweeper.yml"]) {
      expect(fs.readFileSync(path.join(__dirname, "../../.github/workflows", workflow), "utf8")).toContain("AGENTIC_POLICY.autonomy.enabled");
    }
  });

  it("permits trusted controller dispatch for every intake and implementation stage", () => {
    for (const workflow of ["opportunity-discovery", "pm-triage", "em-planning", "rubber-duck-architecture", "implement-ticket", "pr-self-heal"]) {
      expect(fs.readFileSync(path.join(__dirname, "../../.github/workflows", `${workflow}.md`), "utf8"))
        .toContain('bots: ["github-actions[bot]"]');
    }
  });

  it("includes canonical policy in every dependent sparse checkout", () => {
    for (const workflow of ["factory-queue-controller.yml", "factory-backlog-promoter.yml", "agentic-factory-full-e2e.yml"]) {
      const source = fs.readFileSync(path.join(__dirname, "../../.github/workflows", workflow), "utf8");
      expect(source).toContain("sparse-checkout: |");
      expect(source).toContain("            .github/agentic-policy.json");
    }
  });

  it("loads trusted workflow limits in both credit-admitting controller checkouts", () => {
    for (const workflow of ["factory-queue-controller.yml", "agentic-pr-reconciler.yml"]) {
      const source = fs.readFileSync(path.join(__dirname, "../../.github/workflows", workflow), "utf8");
      expect(source).toContain("            .github/workflows");
      expect(source).toContain("ref: ${{ github.event.repository.default_branch }}");
    }
  });
});
