export {};

interface CheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
}

interface PullRequest {
  number: number;
  state?: string;
  draft: boolean;
  merged_at?: string | null;
  node_id?: string;
  auto_merge?: unknown;
  labels: Array<{ name: string }>;
  head: {
    sha: string;
    repo: { full_name: string } | null;
  };
}

interface ArmingDecision {
  arm: boolean;
  reason: string;
}

interface SweeperModule {
  evaluateAutoMergeArming(input: {
    pullRequest: PullRequest;
    checkRuns?: CheckRun[];
    repository: string;
    factoryMode?: string;
  }): ArmingDecision;
  getCheckState(checkRuns: CheckRun[], name: string): string;
  isRetryableAutoMergeStateError(error: unknown): boolean;
  resolveHumanAttestedFactoryMode(input: {
    github: unknown;
    core: unknown;
    owner: string;
    repo: string;
  }): Promise<string>;
  sweepAutoMergeReadyPullRequests(input: {
    github: unknown;
    context: unknown;
    core: unknown;
  }): Promise<{
    factoryMode: string;
    armed: Array<{ number: number; reason: string }>;
    declined: Array<{ number: number; reason: string }>;
  }>;
  REQUIRED_CONTEXTS: readonly string[];
  ENABLE_AUTO_MERGE_MUTATION: string;
}

const {
  ENABLE_AUTO_MERGE_MUTATION,
  REQUIRED_CONTEXTS,
  evaluateAutoMergeArming,
  getCheckState,
  isRetryableAutoMergeStateError,
  resolveHumanAttestedFactoryMode,
  sweepAutoMergeReadyPullRequests,
} = jest.requireActual<SweeperModule>(
  "../../.github/scripts/agentic-automerge-sweeper.cjs",
);

const repository = "VeVarunSharma/project-krypto-dog";

function greenChecks(extra: CheckRun[] = []): CheckRun[] {
  return [
    ...REQUIRED_CONTEXTS.map((name, index) => ({
      id: index + 1,
      name,
      status: "completed",
      conclusion: "success",
    })),
    ...extra,
  ];
}

function pullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 42,
    state: "open",
    draft: false,
    merged_at: null,
    node_id: "PR_node_42",
    auto_merge: null,
    labels: [{ name: "agentic-factory" }, { name: "agentic-automerge" }],
    head: {
      sha: "head-sha",
      repo: { full_name: repository },
    },
    ...overrides,
  };
}

function decide(
  overrides: {
    pullRequest?: PullRequest;
    checkRuns?: CheckRun[];
    factoryMode?: string;
  } = {},
): ArmingDecision {
  return evaluateAutoMergeArming({
    pullRequest: overrides.pullRequest ?? pullRequest(),
    checkRuns: overrides.checkRuns ?? greenChecks(),
    repository,
    factoryMode: overrides.factoryMode ?? "active",
  });
}

describe("auto-merge arming policy", () => {
  it("arms an enrolled same-repository PR whose evidence is complete", () => {
    expect(decide()).toEqual({
      arm: true,
      reason: "merge-evidence-complete",
    });
  });

  it.each([
    ["draft", { draft: true }, "draft"],
    ["merged", { merged_at: "2026-08-20T00:00:00Z" }, "already-merged"],
    ["closed", { state: "closed" }, "pull-request-not-open"],
    ["already armed", { auto_merge: { enabledBy: {} } }, "already-armed"],
    ["missing node id", { node_id: "" }, "missing-node-id"],
  ])("declines a %s pull request", (_name, overrides, reason) => {
    expect(decide({ pullRequest: pullRequest(overrides) })).toEqual({
      arm: false,
      reason,
    });
  });

  it("declines a pull request that is not enrolled for auto-merge", () => {
    expect(
      decide({
        pullRequest: pullRequest({ labels: [{ name: "agentic-factory" }] }),
      }),
    ).toEqual({ arm: false, reason: "not-enrolled" });
  });

  it("never arms a forked head, which requires a human approval", () => {
    expect(
      decide({
        pullRequest: pullRequest({
          head: { sha: "head-sha", repo: { full_name: "attacker/fork" } },
        }),
      }),
    ).toEqual({ arm: false, reason: "forked-head" });

    expect(
      decide({
        pullRequest: pullRequest({ head: { sha: "head-sha", repo: null } }),
      }),
    ).toEqual({ arm: false, reason: "forked-head" });
  });

  it.each(["blocked", "self-heal-exhausted"])(
    "declines a pull request labelled %s",
    (label) => {
      expect(
        decide({
          pullRequest: pullRequest({
            labels: [{ name: "agentic-automerge" }, { name: label }],
          }),
        }),
      ).toEqual({ arm: false, reason: `blocking-label:${label}` });
    },
  );

  it.each(["shadow", "paused"])(
    "does not arm while the factory is in %s mode",
    (mode) => {
      expect(decide({ factoryMode: mode })).toEqual({
        arm: false,
        reason: `factory-mode:${mode}`,
      });
    },
  );

  it("fails closed when the factory mode is unknown", () => {
    expect(decide({ factoryMode: "unresolvable" })).toEqual({
      arm: false,
      reason: "factory-mode:unresolvable",
    });
  });

  it.each([
    ["missing", [] as CheckRun[]],
    [
      "pending",
      [{ id: 9, name: "Agentic merge policy", status: "in_progress", conclusion: null }],
    ],
    [
      "failure",
      [{ id: 9, name: "Agentic merge policy", status: "completed", conclusion: "failure" }],
    ],
  ])("declines when the merge policy verdict is %s", (state, checks) => {
    const checkRuns = [
      ...greenChecks().filter((check) => check.name !== "Agentic merge policy"),
      ...checks,
    ];

    expect(decide({ checkRuns })).toEqual({
      arm: false,
      reason: `merge-policy:${state}`,
    });
  });

  it("requires a green boundary approval whenever that check exists", () => {
    expect(
      decide({
        checkRuns: greenChecks([
          {
            id: 99,
            name: "Human boundary approval",
            status: "in_progress",
            conclusion: null,
          },
        ]),
      }),
    ).toEqual({ arm: false, reason: "boundary-approval:pending" });

    expect(
      decide({
        checkRuns: greenChecks([
          {
            id: 99,
            name: "Human boundary approval",
            status: "completed",
            conclusion: "action_required",
          },
        ]),
      }),
    ).toEqual({ arm: false, reason: "boundary-approval:failure" });

    expect(
      decide({
        checkRuns: greenChecks([
          {
            id: 99,
            name: "Human boundary approval",
            status: "completed",
            conclusion: "success",
          },
        ]),
      }),
    ).toEqual({ arm: true, reason: "merge-evidence-complete" });
  });

  it.each(REQUIRED_CONTEXTS.filter((name) => name !== "Agentic merge policy"))(
    "declines while the required %s context is missing",
    (contextName) => {
      const checkRuns = greenChecks().filter(
        (check) => check.name !== contextName,
      );

      expect(decide({ checkRuns })).toEqual({
        arm: false,
        reason: `required-context:${contextName}:missing`,
      });
    },
  );

  it("reads only the newest run of a repeated check name", () => {
    const checkRuns: CheckRun[] = [
      { id: 1, name: "Agentic code review", status: "completed", conclusion: "failure" },
      { id: 2, name: "Agentic code review", status: "completed", conclusion: "success" },
    ];

    expect(getCheckState(checkRuns, "Agentic code review")).toBe("success");
    expect(getCheckState(checkRuns.slice(0, 1), "Agentic code review")).toBe(
      "failure",
    );
  });
});

describe("retryable auto-merge state errors", () => {
  it.each(["clean status", "unstable status", "pending status"])(
    "treats a %s rejection as retryable",
    (substring) => {
      expect(
        isRetryableAutoMergeStateError(
          new Error(`Pull request is not in the ${substring} required`),
        ),
      ).toBe(true);
    },
  );

  it("does not swallow an unrelated failure", () => {
    expect(isRetryableAutoMergeStateError(new Error("Resource not accessible"))).toBe(
      false,
    );
  });
});

interface FakeOptions {
  pullRequests?: PullRequest[];
  checkRuns?: Record<string, CheckRun[]>;
  controlIssues?: Array<{ number: number; labels: Array<{ name: string }> }>;
  timeline?: Array<{
    event: string;
    created_at: string;
    label?: { name: string };
    actor?: { type: string };
  }>;
  graphql?: jest.Mock;
}

function fakeGithub(options: FakeOptions = {}) {
  const {
    pullRequests = [pullRequest()],
    checkRuns = { "head-sha": greenChecks() },
    controlIssues = [{ number: 1, labels: [{ name: "factory-mode:active" }] }],
    timeline = [
      {
        event: "labeled",
        created_at: "2026-08-20T00:00:00Z",
        label: { name: "factory-mode:active" },
        actor: { type: "User" },
      },
    ],
    graphql = jest.fn().mockResolvedValue({}),
  } = options;

  const listForRef = jest.fn(
    async ({ ref }: { ref: string }) => checkRuns[ref] ?? [],
  );
  const merge = jest.fn();

  const github = {
    graphql,
    paginate: jest.fn(
      async (method: (params: unknown) => Promise<unknown>, params: unknown) =>
        method(params),
    ),
    rest: {
      pulls: { list: jest.fn(async () => pullRequests), merge },
      checks: { listForRef },
      issues: {
        listForRepo: jest.fn(async () => controlIssues),
        listEventsForTimeline: jest.fn(async () => timeline),
      },
    },
  };

  const core = {
    info: jest.fn(),
    warning: jest.fn(),
  };

  return { github, core, graphql, merge, listForRef };
}

const context = { repo: { owner: "VeVarunSharma", repo: "project-krypto-dog" } };

describe("auto-merge sweep", () => {
  it("arms a ready pull request without ever merging it", async () => {
    const { github, core, graphql, merge } = fakeGithub();

    const result = await sweepAutoMergeReadyPullRequests({
      github,
      context,
      core,
    });

    expect(result.armed).toEqual([
      { number: 42, reason: "merge-evidence-complete" },
    ]);
    expect(graphql).toHaveBeenCalledTimes(1);
    expect(graphql).toHaveBeenCalledWith(ENABLE_AUTO_MERGE_MUTATION, {
      pullRequestId: "PR_node_42",
    });
    expect(merge).not.toHaveBeenCalled();
  });

  it("never arms anything while the factory is paused", async () => {
    const { github, core, graphql } = fakeGithub({
      controlIssues: [{ number: 1, labels: [{ name: "factory-mode:paused" }] }],
    });

    const result = await sweepAutoMergeReadyPullRequests({
      github,
      context,
      core,
    });

    expect(result.factoryMode).toBe("paused");
    expect(result.armed).toEqual([]);
    expect(graphql).not.toHaveBeenCalled();
  });

  it("downgrades a bot-applied activation to paused", async () => {
    const { github, core } = fakeGithub({
      timeline: [
        {
          event: "labeled",
          created_at: "2026-08-20T00:00:00Z",
          label: { name: "factory-mode:active" },
          actor: { type: "Bot" },
        },
      ],
    });

    await expect(
      resolveHumanAttestedFactoryMode({
        github,
        core,
        owner: "VeVarunSharma",
        repo: "project-krypto-dog",
      }),
    ).resolves.toBe("paused");
  });

  it("fails closed when the factory control issue is ambiguous", async () => {
    const { github, core } = fakeGithub({
      controlIssues: [
        { number: 1, labels: [{ name: "factory-mode:active" }] },
        { number: 2, labels: [{ name: "factory-mode:active" }] },
      ],
    });

    await expect(
      resolveHumanAttestedFactoryMode({
        github,
        core,
        owner: "VeVarunSharma",
        repo: "project-krypto-dog",
      }),
    ).resolves.toBe("paused");
    expect(core.warning).toHaveBeenCalled();
  });

  it("skips the check-run request for structurally ineligible pull requests", async () => {
    const { github, core, listForRef } = fakeGithub({
      pullRequests: [pullRequest({ number: 7, draft: true })],
    });

    const result = await sweepAutoMergeReadyPullRequests({
      github,
      context,
      core,
    });

    expect(result.declined).toEqual([{ number: 7, reason: "draft" }]);
    expect(listForRef).not.toHaveBeenCalled();
  });

  it("treats an unsettled head as retryable rather than a failure", async () => {
    const { github, core, graphql } = fakeGithub({
      graphql: jest
        .fn()
        .mockRejectedValue(
          new Error("Pull request is not in the clean status required"),
        ),
    });

    const result = await sweepAutoMergeReadyPullRequests({
      github,
      context,
      core,
    });

    expect(graphql).toHaveBeenCalledTimes(1);
    expect(result.armed).toEqual([]);
    expect(result.declined).toEqual([
      { number: 42, reason: "head-state-unsettled" },
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it("isolates a failing pull request so the sweep continues", async () => {
    const { github, core, graphql } = fakeGithub({
      pullRequests: [
        pullRequest({ number: 1, node_id: "PR_node_1" }),
        pullRequest({ number: 2, node_id: "PR_node_2" }),
      ],
      graphql: jest
        .fn()
        .mockRejectedValueOnce(new Error("Resource not accessible"))
        .mockResolvedValueOnce({}),
    });

    const result = await sweepAutoMergeReadyPullRequests({
      github,
      context,
      core,
    });

    expect(graphql).toHaveBeenCalledTimes(2);
    expect(result.armed).toEqual([
      { number: 2, reason: "merge-evidence-complete" },
    ]);
    expect(result.declined).toEqual([{ number: 1, reason: "sweep-error" }]);
    expect(core.warning).toHaveBeenCalled();
  });
});
