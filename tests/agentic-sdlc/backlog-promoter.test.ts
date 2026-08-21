export {};

interface PromoterConfig {
  factoryMode: string;
  goalApproved: boolean;
  goalNumber: number;
  goalMilestone: string;
  goalAllowedPaths: string[];
  maxGoalRiskTier: string;
  maxPromotions: number;
}

interface PromoterModule {
  evaluatePromotion(
    candidate: unknown,
    config: unknown,
  ): { number?: number; promotable: boolean; reasons: string[]; bucket: string; plan: any };
  planPromotions(
    candidates: unknown[],
    config: unknown,
  ): { advisory: boolean; promotions: any[]; rejections: any[]; counts: Record<string, number> };
  classifyBucket(reasons: string[]): string;
  resolveGoalRiskCeiling(config: unknown): string;
}

const promoter: PromoterModule = require("../../.github/scripts/agentic-backlog-promoter.cjs");

const GOAL_NUMBER = 248;

function baseConfig(overrides: Partial<PromoterConfig> = {}): PromoterConfig {
  return {
    factoryMode: "active",
    goalApproved: true,
    goalNumber: GOAL_NUMBER,
    goalMilestone: "v2.1 Safety and Correctness",
    goalAllowedPaths: ["src/lib/**", "tests/**"],
    maxGoalRiskTier: "risk:sensitive",
    maxPromotions: 5,
    ...overrides,
  };
}

function baseCandidate(overrides: Record<string, unknown> = {}) {
  return {
    number: 300,
    labels: ["agentic-factory"],
    milestone: null,
    parentGoalNumber: GOAL_NUMBER,
    declaredRiskTier: "risk:routine",
    allowedPaths: ["src/lib/**"],
    hasAcceptanceCriteria: true,
    hasValidationPlan: true,
    hasScopeDefinition: true,
    hasRollbackPlan: true,
    dependencyStates: [],
    state: "open",
    isLeaf: true,
    assignees: [],
    hasOpenPullRequest: false,
    hasOpenSession: false,
    createdAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("backlog promoter decision core", () => {
  it("promotes a complete, in-scope candidate and binds the goal milestone", () => {
    const result = promoter.evaluatePromotion(baseCandidate(), baseConfig());

    expect(result.promotable).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.plan.addLabels).toEqual(["ready-for-ai-dev", "risk:routine"]);
    expect(result.plan.milestone).toBe("v2.1 Safety and Correctness");
  });

  it("does not re-add a risk label the issue already carries", () => {
    const result = promoter.evaluatePromotion(
      baseCandidate({ labels: ["agentic-factory", "risk:routine"] }),
      baseConfig(),
    );

    expect(result.promotable).toBe(true);
    expect(result.plan.addLabels).toEqual(["ready-for-ai-dev"]);
  });

  it("never promotes when the factory is not active or shadow", () => {
    const result = promoter.evaluatePromotion(baseCandidate(), baseConfig({ factoryMode: "paused" }));

    expect(result.promotable).toBe(false);
    expect(result.reasons).toEqual(["factory-not-active"]);
  });

  it("never promotes boundary-tier work", () => {
    const result = promoter.evaluatePromotion(
      baseCandidate({ declaredRiskTier: "risk:boundary" }),
      baseConfig({ maxGoalRiskTier: "risk:boundary" }),
    );

    expect(result.promotable).toBe(false);
    expect(result.reasons).toContain("risk-boundary-requires-human");
    expect(result.bucket).toBe("boundary-requires-human");
  });

  it("refuses to promote work whose risk exceeds the goal ceiling", () => {
    const result = promoter.evaluatePromotion(
      baseCandidate({ declaredRiskTier: "risk:sensitive" }),
      baseConfig({ maxGoalRiskTier: "risk:routine" }),
    );

    expect(result.promotable).toBe(false);
    expect(result.reasons).toContain("risk-exceeds-goal-max");
    expect(result.bucket).toBe("scope-blocked");
  });

  it("refuses to promote work whose paths escape the goal scope", () => {
    const result = promoter.evaluatePromotion(
      baseCandidate({ allowedPaths: ["src/trading/**"] }),
      baseConfig(),
    );

    expect(result.promotable).toBe(false);
    expect(result.reasons).toContain("scope-exceeds-goal");
    expect(result.bucket).toBe("scope-blocked");
  });

  it("refuses to re-point an issue declaring a different parent goal", () => {
    const result = promoter.evaluatePromotion(
      baseCandidate({ parentGoalNumber: 999 }),
      baseConfig(),
    );

    expect(result.promotable).toBe(false);
    expect(result.reasons).toContain("parent-goal-mismatch");
    expect(result.bucket).toBe("scope-blocked");
  });

  it("fails closed when the parent goal could not be corroborated", () => {
    const result = promoter.evaluatePromotion(
      baseCandidate({ parentGoalNumber: undefined }),
      baseConfig(),
    );

    expect(result.promotable).toBe(false);
    expect(result.reasons).toContain("missing-parent-goal");
  });

  it("requires an approved goal", () => {
    const result = promoter.evaluatePromotion(baseCandidate(), baseConfig({ goalApproved: false }));

    expect(result.promotable).toBe(false);
    expect(result.reasons).toContain("goal-not-approved");
  });

  it.each([
    ["hasAcceptanceCriteria"],
    ["hasValidationPlan"],
    ["hasScopeDefinition"],
    ["hasRollbackPlan"],
  ])("refuses to promote when %s is missing", (field) => {
    const result = promoter.evaluatePromotion(baseCandidate({ [field]: false }), baseConfig());

    expect(result.promotable).toBe(false);
    expect(result.bucket).toBe("authoring-incomplete");
  });

  it("refuses a declared risk tier that conflicts with an existing label", () => {
    const result = promoter.evaluatePromotion(
      baseCandidate({ labels: ["agentic-factory", "risk:sensitive"], declaredRiskTier: "risk:routine" }),
      baseConfig(),
    );

    expect(result.promotable).toBe(false);
    expect(result.reasons).toContain("risk-label-conflicts-with-declaration");
  });

  it("refuses an unknown or missing declared risk tier", () => {
    expect(
      promoter.evaluatePromotion(baseCandidate({ declaredRiskTier: undefined }), baseConfig()).reasons,
    ).toContain("missing-declared-risk-tier");
    expect(
      promoter.evaluatePromotion(baseCandidate({ declaredRiskTier: "risk:trivial" }), baseConfig()).reasons,
    ).toContain("unknown-declared-risk-tier");
  });

  it("performs a legal lifecycle transition and removes the superseded label", () => {
    const result = promoter.evaluatePromotion(
      baseCandidate({ labels: ["agentic-factory", "ready-for-planning"] }),
      baseConfig(),
    );

    expect(result.promotable).toBe(true);
    expect(result.plan.removeLabels).toEqual(["ready-for-planning"]);
    expect(result.plan.addLabels).toContain("ready-for-ai-dev");
  });

  it("refuses a pre-planning state that cannot legally reach ready", () => {
    const result = promoter.evaluatePromotion(
      baseCandidate({ labels: ["agentic-factory", "needs-triage"] }),
      baseConfig(),
    );

    expect(result.promotable).toBe(false);
    expect(result.reasons).toContain("already-in-lifecycle");
  });

  it("never auto-unblocks a blocked issue", () => {
    const result = promoter.evaluatePromotion(
      baseCandidate({ labels: ["agentic-factory", "blocked"] }),
      baseConfig(),
    );

    expect(result.promotable).toBe(false);
    expect(result.reasons).toContain("blocked-by-label");
  });

  it("never re-promotes in-flight work even when the transition table allows it", () => {
    for (const state of ["factory:claimed", "factory:implementing", "factory:pr-open"]) {
      const result = promoter.evaluatePromotion(
        baseCandidate({ labels: ["agentic-factory", state] }),
        baseConfig(),
      );
      expect(result.promotable).toBe(false);
      expect(result.reasons).toContain("already-in-lifecycle");
      expect(result.bucket).toBe("in-flight");
    }
  });

  it("leaves issues already ready untouched", () => {
    const ready = promoter.evaluatePromotion(
      baseCandidate({ labels: ["agentic-factory", "ready-for-ai-dev"] }),
      baseConfig(),
    );
    expect(ready.reasons).toContain("already-ready");
  });

  it("skips non-leaf issues and issues with open work", () => {
    expect(promoter.evaluatePromotion(baseCandidate({ isLeaf: false }), baseConfig()).reasons).toContain(
      "not-leaf",
    );
    expect(
      promoter.evaluatePromotion(baseCandidate({ assignees: ["octocat"] }), baseConfig()).reasons,
    ).toContain("already-assigned");
    expect(
      promoter.evaluatePromotion(baseCandidate({ hasOpenPullRequest: true }), baseConfig()).reasons,
    ).toContain("already-has-open-pull-request");
  });

  it("refuses to move an issue off a milestone a human already set", () => {
    const result = promoter.evaluatePromotion(
      baseCandidate({ milestone: "v3.0 Something Else" }),
      baseConfig(),
    );

    expect(result.promotable).toBe(false);
    expect(result.reasons).toContain("milestone-conflict");
  });

  it("blocks on unresolved or open dependencies", () => {
    expect(
      promoter.evaluatePromotion(baseCandidate({ dependencyStates: null }), baseConfig()).reasons,
    ).toContain("dependencies-unknown");
    expect(
      promoter.evaluatePromotion(baseCandidate({ dependencyStates: ["open"] }), baseConfig()).reasons,
    ).toContain("dependencies-not-closed");
  });

  it("falls back to the most restrictive risk ceiling for an unknown goal tier", () => {
    expect(promoter.resolveGoalRiskCeiling({ maxGoalRiskTier: "nonsense" })).toBe("risk:routine");
    expect(promoter.resolveGoalRiskCeiling({})).toBe("risk:routine");
  });
});

describe("backlog promoter planning", () => {
  it("bounds promotions per pass and defers the remainder", () => {
    const candidates = [1, 2, 3, 4].map((offset) => baseCandidate({ number: 300 + offset }));
    const plan = promoter.planPromotions(candidates, baseConfig({ maxPromotions: 2 }));

    expect(plan.promotions.map((promotion) => promotion.number)).toEqual([301, 302]);
    expect(plan.rejections.filter((rejection) => rejection.bucket === "deferred")).toHaveLength(2);
  });

  it("marks shadow-mode planning advisory", () => {
    const plan = promoter.planPromotions([baseCandidate()], baseConfig({ factoryMode: "shadow" }));

    expect(plan.advisory).toBe(true);
    expect(plan.promotions).toHaveLength(1);
  });

  it("promotes nothing when the limit is zero", () => {
    const plan = promoter.planPromotions([baseCandidate()], baseConfig({ maxPromotions: 0 }));

    expect(plan.promotions).toHaveLength(0);
  });

  it("groups rejections into actionable buckets", () => {
    const plan = promoter.planPromotions(
      [
        baseCandidate({ number: 301 }),
        baseCandidate({ number: 302, allowedPaths: ["src/trading/**"] }),
        baseCandidate({ number: 303, hasValidationPlan: false }),
      ],
      baseConfig(),
    );

    expect(plan.counts.promotable).toBe(1);
    expect(plan.counts["scope-blocked"]).toBe(1);
    expect(plan.counts["authoring-incomplete"]).toBe(1);
  });
});

interface PromoterRuntimeModule {
  buildCandidate(args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

const promoterRuntime: PromoterRuntimeModule = require("../../.github/scripts/agentic-backlog-promoter-runtime.cjs");

function runtimeCore() {
  return { warning: () => {}, info: () => {}, notice: () => {}, setFailed: () => {} };
}

function githubStub({ openPullRequests = [] as unknown[] } = {}) {
  return {
    request: async (route: string) => {
      if (route.includes("sub_issues")) {
        return { data: [] };
      }
      return { data: { sub_issue_parent: { number: GOAL_NUMBER } } };
    },
    rest: {
      issues: { get: async () => ({ data: { state: "closed" } }) },
      search: { issuesAndPullRequests: async () => ({ data: { items: openPullRequests } }) },
    },
  };
}

const RUNTIME_ISSUE = {
  number: 300,
  title: "Harden the thing",
  state: "open",
  labels: [{ name: "agentic-factory" }, { name: "ready-for-planning" }],
  milestone: null,
  assignees: [],
  created_at: "2026-08-01T00:00:00.000Z",
  body: [
    "### Approved parent goal",
    "",
    `#${GOAL_NUMBER}`,
    "",
    "### Risk tier",
    "",
    "risk:routine",
  ].join("\n"),
};

describe("backlog promoter runtime candidate", () => {
  // Regression: the open-PR guard in evaluatePromotion is only reachable when
  // buildCandidate actually resolves hasOpenPullRequest. It was previously
  // never set, making that guard dead code.
  it("resolves hasOpenPullRequest to false when no linked pull request is open", async () => {
    const candidate = await promoterRuntime.buildCandidate({
      github: githubStub(),
      owner: "acme",
      repo: "widgets",
      issue: RUNTIME_ISSUE,
      activeGoalNumber: GOAL_NUMBER,
      core: runtimeCore(),
    });

    expect(candidate.hasOpenPullRequest).toBe(false);
  });

  it("resolves hasOpenPullRequest to true when a pull request already refs the issue", async () => {
    const candidate = await promoterRuntime.buildCandidate({
      github: githubStub({ openPullRequests: [{ body: "Refs #300" }] }),
      owner: "acme",
      repo: "widgets",
      issue: RUNTIME_ISSUE,
      activeGoalNumber: GOAL_NUMBER,
      core: runtimeCore(),
    });

    expect(candidate.hasOpenPullRequest).toBe(true);
  });

  it("blocks promotion of a candidate that already has an open pull request", async () => {
    const candidate = await promoterRuntime.buildCandidate({
      github: githubStub({ openPullRequests: [{ body: "Refs #300" }] }),
      owner: "acme",
      repo: "widgets",
      issue: RUNTIME_ISSUE,
      activeGoalNumber: GOAL_NUMBER,
      core: runtimeCore(),
    });

    const result = promoter.evaluatePromotion(
      { ...candidate, allowedPaths: ["src/lib/**"], hasAcceptanceCriteria: true, hasValidationPlan: true, hasScopeDefinition: true, hasRollbackPlan: true },
      baseConfig(),
    );

    expect(result.promotable).toBe(false);
  });
});
