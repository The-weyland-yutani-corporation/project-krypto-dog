export {};

interface QueueClaim {
  owner?: unknown;
  expiresAt?: unknown;
}

interface QueueCandidate {
  number: number;
  labels: string[];
  milestone?: string | null;
  parentGoalNumber: number;
  parentGoalApproved: boolean;
  dependencyStates?: string[];
  state: "open" | "closed";
  isLeaf: boolean;
  hasAcceptanceCriteria: boolean;
  hasValidationPlan: boolean;
  hasScopeDefinition: boolean;
  hasRiskAssessment: boolean;
  hasRollbackPlan: boolean;
  allowedPaths: string[];
  assignees?: string[];
  hasOpenPullRequest?: boolean;
  hasOpenSession?: boolean;
  activeClaim?: QueueClaim | null;
  priority?: string;
  createdAt: string;
  updatedAt?: string;
}

interface QueueControllerConfig {
  factoryMode: string;
  goalApproved: boolean;
  allowedMilestones: string[];
  concurrencyLimit: number;
  currentInFlightCount: number;
  dailyBudgetLimit: number;
  currentBudgetUsed: number;
  maxGoalRiskTier: string;
  goalAllowedPaths: string[];
  now?: string;
}

interface ClaimState {
  present: boolean;
  blocking: boolean;
  malformed: boolean;
  expired?: boolean;
  reason: string;
}

interface SelectionResult {
  selected: QueueCandidate | null;
  advisory: boolean;
  rejections: Array<{ number: number | undefined; reasons: string[] }>;
}

interface QueueControllerModule {
  priorityRank(priority: string | undefined): number;
  evaluateClaimState(claim: QueueClaim | null | undefined, nowIso: string | undefined): ClaimState;
  isLeaseStale(claim: QueueClaim | null | undefined, nowIso: string | undefined): boolean;
  buildClaimNonce(input: { runId: string; attempt: number; issueNumber: number }): string;
  buildClaimPayload(input: {
    runId: string;
    attempt: number;
    issueNumber: number;
    owner: string;
    expiresAt: string;
  }): { nonce: string; owner: string; issueNumber: number; expiresAt: string };
  serializeClaimPayload(payload: unknown): string;
  parseClaimPayload(serialized: unknown): { valid: boolean; claim?: object; reason?: string };
  buildCorrelationId(input: { runId: string; attempt: number; issueNumber: number }): string;
  isIdempotentRetry(previous: unknown, current: unknown): boolean;
  resolveMaxGoalRiskTier(config: Partial<QueueControllerConfig>): string;
  evaluateEligibility(
    candidate: QueueCandidate,
    config: QueueControllerConfig,
  ): string[];
  compareCandidates(a: QueueCandidate, b: QueueCandidate, config: QueueControllerConfig): number;
  selectNextIssue(
    candidates: QueueCandidate[],
    config: QueueControllerConfig,
  ): SelectionResult;
}

const controller = jest.requireActual<QueueControllerModule>(
  "../../.github/scripts/agentic-queue-controller.cjs",
);

const baseConfig: QueueControllerConfig = {
  factoryMode: "active",
  goalApproved: true,
  allowedMilestones: ["v2.2", "v2.3"],
  concurrencyLimit: 2,
  currentInFlightCount: 0,
  dailyBudgetLimit: 10,
  currentBudgetUsed: 0,
  maxGoalRiskTier: "risk:sensitive",
  goalAllowedPaths: ["src/**", "tests/**"],
  now: "2024-06-01T00:00:00Z",
};

function config(overrides: Partial<QueueControllerConfig> = {}): QueueControllerConfig {
  return { ...baseConfig, ...overrides };
}

function candidate(overrides: Partial<QueueCandidate> = {}): QueueCandidate {
  return {
    number: 100,
    labels: ["ready-for-ai-dev", "risk:routine"],
    milestone: "v2.2",
    parentGoalNumber: 1,
    parentGoalApproved: true,
    dependencyStates: [],
    state: "open",
    isLeaf: true,
    hasAcceptanceCriteria: true,
    hasValidationPlan: true,
    hasScopeDefinition: true,
    hasRiskAssessment: true,
    hasRollbackPlan: true,
    allowedPaths: ["src/example.ts"],
    assignees: [],
    hasOpenPullRequest: false,
    hasOpenSession: false,
    activeClaim: null,
    priority: "P1",
    createdAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("queue eligibility", () => {
  it("accepts a fully-ready candidate", () => {
    expect(controller.evaluateEligibility(candidate(), config())).toEqual([]);
  });

  it("rejects when the factory is not active or shadow", () => {
    expect(controller.evaluateEligibility(candidate(), config({ factoryMode: "paused" }))).toEqual([
      "factory-not-active",
    ]);
    expect(controller.evaluateEligibility(candidate(), config({ factoryMode: "off" }))).toEqual([
      "factory-not-active",
    ]);
    expect(
      controller.evaluateEligibility(candidate(), undefined as unknown as QueueControllerConfig),
    ).toEqual(["factory-not-active"]);
  });

  it("accepts shadow mode as advisory-eligible using the same algorithm", () => {
    expect(controller.evaluateEligibility(candidate(), config({ factoryMode: "shadow" }))).toEqual(
      [],
    );
  });

  it("rejects an invalid candidate shape", () => {
    expect(controller.evaluateEligibility(null as unknown as QueueCandidate, config())).toEqual([
      "invalid-candidate",
    ]);
    expect(controller.evaluateEligibility(undefined as unknown as QueueCandidate, config())).toEqual(
      ["invalid-candidate"],
    );
  });

  it("rejects when the parent goal is not approved", () => {
    expect(
      controller.evaluateEligibility(candidate({ parentGoalApproved: false }), config()),
    ).toContain("goal-not-approved");
    expect(
      controller.evaluateEligibility(candidate(), config({ goalApproved: false })),
    ).toContain("goal-not-approved");
  });

  it("rejects when the parent goal identifier is missing", () => {
    expect(
      controller.evaluateEligibility(candidate({ parentGoalNumber: 0 }), config()),
    ).toContain("missing-parent-goal");
  });

  it("rejects issue scope that exceeds the approved goal", () => {
    expect(
      controller.evaluateEligibility(
        candidate({ allowedPaths: ["docs/**"] }),
        config(),
      ),
    ).toContain("scope-exceeds-goal");
  });

  it("rejects when the milestone is missing or not allowed", () => {
    expect(controller.evaluateEligibility(candidate({ milestone: "v9.9" }), config())).toContain(
      "milestone-not-allowed",
    );
    expect(
      controller.evaluateEligibility(candidate({ milestone: null }), config()),
    ).toContain("milestone-not-allowed");
  });

  it("rejects closed or non-leaf issues", () => {
    expect(controller.evaluateEligibility(candidate({ state: "closed" }), config())).toContain(
      "not-open-leaf",
    );
    expect(controller.evaluateEligibility(candidate({ isLeaf: false }), config())).toContain(
      "not-open-leaf",
    );
  });

  it("rejects when the ready-for-ai-dev label is missing", () => {
    expect(
      controller.evaluateEligibility(candidate({ labels: ["risk:routine"] }), config()),
    ).toContain("missing-ready-label");
  });

  it("requires ready-for-ai-dev to be the only lifecycle label", () => {
    expect(
      controller.evaluateEligibility(
        candidate({
          labels: [
            "ready-for-planning",
            "ready-for-ai-dev",
            "risk:routine",
          ],
        }),
        config(),
      ),
    ).toContain("invalid-lifecycle-label-count");
  });

  it("rejects when there is not exactly one valid risk label", () => {
    expect(
      controller.evaluateEligibility(candidate({ labels: ["ready-for-ai-dev"] }), config()),
    ).toContain("invalid-risk-label-count");
    expect(
      controller.evaluateEligibility(
        candidate({ labels: ["ready-for-ai-dev", "risk:routine", "risk:sensitive"] }),
        config(),
      ),
    ).toContain("invalid-risk-label-count");
  });

  it("rejects when dependencies are not all closed", () => {
    expect(
      controller.evaluateEligibility(candidate({ dependencyStates: ["closed", "open"] }), config()),
    ).toContain("dependencies-not-closed");
    expect(
      controller.evaluateEligibility(candidate({ dependencyStates: ["closed", "closed"] }), config()),
    ).toEqual([]);
  });

  it("rejects with a specific reason for every incomplete readiness field", () => {
    expect(
      controller.evaluateEligibility(candidate({ hasAcceptanceCriteria: false }), config()),
    ).toContain("readiness-incomplete:hasAcceptanceCriteria");
    expect(
      controller.evaluateEligibility(candidate({ hasValidationPlan: false }), config()),
    ).toContain("readiness-incomplete:hasValidationPlan");
    expect(
      controller.evaluateEligibility(candidate({ hasScopeDefinition: false }), config()),
    ).toContain("readiness-incomplete:hasScopeDefinition");
    expect(
      controller.evaluateEligibility(candidate({ hasRiskAssessment: false }), config()),
    ).toContain("readiness-incomplete:hasRiskAssessment");
    expect(
      controller.evaluateEligibility(candidate({ hasRollbackPlan: false }), config()),
    ).toContain("readiness-incomplete:hasRollbackPlan");
  });

  it("rejects blocked or human-review-gated issues", () => {
    expect(
      controller.evaluateEligibility(
        candidate({ labels: ["ready-for-ai-dev", "risk:routine", "blocked"] }),
        config(),
      ),
    ).toContain("blocked-by-label");
    expect(
      controller.evaluateEligibility(
        candidate({ labels: ["ready-for-ai-dev", "risk:routine", "ready-for-human-review"] }),
        config(),
      ),
    ).toContain("blocked-by-label");
  });

  it("rejects issues that already have an assignee, session, or open PR", () => {
    expect(
      controller.evaluateEligibility(candidate({ assignees: ["someone"] }), config()),
    ).toContain("already-assigned");
    expect(
      controller.evaluateEligibility(candidate({ hasOpenSession: true }), config()),
    ).toContain("already-has-open-session");
    expect(
      controller.evaluateEligibility(candidate({ hasOpenPullRequest: true }), config()),
    ).toContain("already-has-open-pull-request");
  });

  it("rejects issues with an active claim", () => {
    expect(
      controller.evaluateEligibility(
        candidate({ activeClaim: { owner: "agent-a", expiresAt: "2024-06-01T01:00:00Z" } }),
        config(),
      ),
    ).toContain("active-claim");
  });

  it("requires explicit recovery before reusing an expired claim", () => {
    expect(
      controller.evaluateEligibility(
        candidate({ activeClaim: { owner: "agent-a", expiresAt: "2024-05-31T00:00:00Z" } }),
        config(),
      ),
    ).toContain("stale-claim-requires-recovery");
  });

  it("fails closed on a malformed claim instead of auto-reclaiming it", () => {
    expect(
      controller.evaluateEligibility(
        candidate({ activeClaim: { owner: "agent-a", expiresAt: "not-a-date" } }),
        config(),
      ),
    ).toContain("active-claim");
    expect(
      controller.evaluateEligibility(
        candidate({ activeClaim: { expiresAt: "2024-06-01T01:00:00Z" } }),
        config(),
      ),
    ).toContain("active-claim");
  });

  it("pauses selection when concurrency capacity is exhausted", () => {
    expect(
      controller.evaluateEligibility(
        candidate(),
        config({ concurrencyLimit: 1, currentInFlightCount: 1 }),
      ),
    ).toContain("concurrency-limit-reached");
  });

  it("pauses selection when the daily budget is exhausted", () => {
    expect(
      controller.evaluateEligibility(
        candidate(),
        config({ dailyBudgetLimit: 5, currentBudgetUsed: 5 }),
      ),
    ).toContain("budget-limit-reached");
  });

  it("rejects a candidate whose risk tier exceeds the goal's max risk tier", () => {
    expect(
      controller.evaluateEligibility(
        candidate({ labels: ["ready-for-ai-dev", "risk:boundary"] }),
        config({ maxGoalRiskTier: "risk:sensitive" }),
      ),
    ).toContain("risk-exceeds-goal-max");
    expect(
      controller.evaluateEligibility(
        candidate({ labels: ["ready-for-ai-dev", "risk:sensitive"] }),
        config({ maxGoalRiskTier: "risk:sensitive" }),
      ),
    ).toEqual([]);
  });

  it("fails closed to routine max risk when the goal's max risk tier is missing or invalid", () => {
    expect(
      controller.evaluateEligibility(
        candidate({ labels: ["ready-for-ai-dev", "risk:sensitive"] }),
        config({ maxGoalRiskTier: "not-a-tier" }),
      ),
    ).toContain("risk-exceeds-goal-max");
    expect(controller.resolveMaxGoalRiskTier(config({ maxGoalRiskTier: "not-a-tier" }))).toBe(
      "risk:routine",
    );
  });
});

describe("deterministic ordering and selection", () => {
  it("orders by priority first: P0 before P1 before P2/default", () => {
    const p2 = candidate({ number: 1, priority: "P2" });
    const p1 = candidate({ number: 2, priority: "P1" });
    const p0 = candidate({ number: 3, priority: "P0" });
    const result = controller.selectNextIssue([p2, p1, p0], config());
    expect(result.selected?.number).toBe(3);
  });

  it("groups unknown priorities with P2 at the lowest rank", () => {
    expect(controller.priorityRank("P2")).toBe(controller.priorityRank("unspecified"));
    expect(controller.priorityRank("P0")).toBeLessThan(controller.priorityRank("P1"));
    expect(controller.priorityRank("P1")).toBeLessThan(controller.priorityRank("P2"));
  });

  it("orders by configured milestone order after priority", () => {
    const laterMilestone = candidate({ number: 1, milestone: "v2.3", priority: "P1" });
    const earlierMilestone = candidate({ number: 2, milestone: "v2.2", priority: "P1" });
    const result = controller.selectNextIssue([laterMilestone, earlierMilestone], config());
    expect(result.selected?.number).toBe(2);
  });

  it("orders by oldest createdAt after priority and milestone", () => {
    const newer = candidate({ number: 1, createdAt: "2024-02-01T00:00:00Z" });
    const older = candidate({ number: 2, createdAt: "2024-01-01T00:00:00Z" });
    const result = controller.selectNextIssue([newer, older], config());
    expect(result.selected?.number).toBe(2);
  });

  it("orders by lowest issue number as the final tiebreaker", () => {
    const higher = candidate({ number: 20, createdAt: "2024-01-01T00:00:00Z" });
    const lower = candidate({ number: 5, createdAt: "2024-01-01T00:00:00Z" });
    const result = controller.selectNextIssue([higher, lower], config());
    expect(result.selected?.number).toBe(5);
  });

  it("selects the same candidate no matter the input order (idempotent selection)", () => {
    const a = candidate({ number: 1, priority: "P1", createdAt: "2024-01-02T00:00:00Z" });
    const b = candidate({ number: 2, priority: "P0", createdAt: "2024-01-01T00:00:00Z" });
    const c = candidate({ number: 3, priority: "P1", createdAt: "2024-01-01T00:00:00Z" });
    const first = controller.selectNextIssue([a, b, c], config());
    const second = controller.selectNextIssue([c, a, b], config());
    const third = controller.selectNextIssue([b, c, a], config());
    expect(first.selected?.number).toBe(2);
    expect(second.selected?.number).toBe(2);
    expect(third.selected?.number).toBe(2);
  });

  it("returns null selection and no rejections for an empty candidate list", () => {
    expect(controller.selectNextIssue([], config())).toEqual({
      selected: null,
      advisory: false,
      rejections: [],
    });
  });

  it("reports structured rejection reasons for every rejected candidate", () => {
    const eligible = candidate({ number: 1 });
    const rejected = candidate({ number: 2, state: "closed", assignees: ["someone"] });
    const result = controller.selectNextIssue([eligible, rejected], config());
    expect(result.selected?.number).toBe(1);
    expect(result.rejections).toEqual([
      {
        number: 2,
        reasons: expect.arrayContaining(["not-open-leaf", "already-assigned"]),
      },
    ]);
  });

  it("reports eligible candidates not selected by ordering", () => {
    const selected = candidate({ number: 1, priority: "P0" });
    const deferred = candidate({ number: 2, priority: "P1" });
    const result = controller.selectNextIssue([deferred, selected], config());
    expect(result.rejections).toContainEqual({
      number: 2,
      reasons: ["lower-priority-than-selected"],
    });
  });

  it("marks shadow-mode selection as advisory using the same algorithm", () => {
    const eligible = candidate({ number: 1 });
    const result = controller.selectNextIssue([eligible], config({ factoryMode: "shadow" }));
    expect(result.selected?.number).toBe(1);
    expect(result.advisory).toBe(true);
  });
});

describe("claim nonce, payload, and lease helpers", () => {
  it("builds a deterministic nonce from run id, attempt, and issue number", () => {
    const nonce = controller.buildClaimNonce({ runId: "run-123", attempt: 0, issueNumber: 42 });
    expect(nonce).toBe("run-123:0:42");
    expect(controller.buildClaimNonce({ runId: "run-123", attempt: 0, issueNumber: 42 })).toBe(
      nonce,
    );
  });

  it("changes the nonce when any input changes", () => {
    const base = controller.buildClaimNonce({ runId: "run-123", attempt: 0, issueNumber: 42 });
    expect(controller.buildClaimNonce({ runId: "run-124", attempt: 0, issueNumber: 42 })).not.toBe(
      base,
    );
    expect(controller.buildClaimNonce({ runId: "run-123", attempt: 1, issueNumber: 42 })).not.toBe(
      base,
    );
    expect(controller.buildClaimNonce({ runId: "run-123", attempt: 0, issueNumber: 43 })).not.toBe(
      base,
    );
  });

  it("round-trips a claim payload through serialize/parse", () => {
    const payload = controller.buildClaimPayload({
      runId: "run-123",
      attempt: 0,
      issueNumber: 42,
      owner: "implement-ticket",
      expiresAt: "2024-06-01T01:00:00Z",
    });
    const serialized = controller.serializeClaimPayload(payload);
    const parsed = controller.parseClaimPayload(serialized);
    expect(parsed.valid).toBe(true);
    expect(parsed.claim).toEqual(payload);
  });

  it("fails closed when parsing an invalid or malformed claim payload", () => {
    expect(controller.parseClaimPayload("not json").valid).toBe(false);
    expect(controller.parseClaimPayload(JSON.stringify({ owner: "x" })).valid).toBe(false);
    expect(controller.parseClaimPayload(null).valid).toBe(false);
    expect(
      controller.parseClaimPayload(
        JSON.stringify({ nonce: "a:0:1", owner: "x", issueNumber: 1, expiresAt: "not-a-date" }),
      ).valid,
    ).toBe(false);
  });

  it("detects lease staleness explicitly from timestamps", () => {
    expect(
      controller.isLeaseStale(
        { owner: "agent", expiresAt: "2024-01-01T00:00:00Z" },
        "2024-06-01T00:00:00Z",
      ),
    ).toBe(true);
    expect(
      controller.isLeaseStale(
        { owner: "agent", expiresAt: "2099-01-01T00:00:00Z" },
        "2024-06-01T00:00:00Z",
      ),
    ).toBe(false);
  });

  it("does not treat a malformed lease as stale/reclaimable", () => {
    expect(controller.isLeaseStale({ owner: "agent", expiresAt: "garbage" }, "2024-06-01T00:00:00Z")).toBe(
      false,
    );
    expect(
      controller.evaluateClaimState({ owner: "agent", expiresAt: "garbage" }, "2024-06-01T00:00:00Z")
        .malformed,
    ).toBe(true);
  });

  it("fails closed when now is missing/invalid, rather than treating the claim as expired", () => {
    const state = controller.evaluateClaimState(
      { owner: "agent", expiresAt: "2024-06-01T00:00:00Z" },
      undefined,
    );
    expect(state.blocking).toBe(true);
    expect(state.reason).toBe("unknown-now-fail-closed");
  });
});

describe("idempotency and correlation", () => {
  it("derives the same correlation id as the claim nonce", () => {
    const input = { runId: "run-123", attempt: 2, issueNumber: 7 };
    expect(controller.buildCorrelationId(input)).toBe(controller.buildClaimNonce(input));
  });

  it("recognizes an idempotent retry by matching correlation ids", () => {
    expect(controller.isIdempotentRetry("run-123:0:7", "run-123:0:7")).toBe(true);
    expect(controller.isIdempotentRetry("run-123:0:7", "run-123:1:7")).toBe(false);
    expect(controller.isIdempotentRetry(undefined, "run-123:0:7")).toBe(false);
  });
});
