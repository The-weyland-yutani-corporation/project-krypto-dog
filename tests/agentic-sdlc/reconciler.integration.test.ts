export {};

interface PullRequest {
  number: number;
  title: string;
  draft: boolean;
  html_url: string;
  user: {
    login: string;
    type: string;
  };
  labels: Array<{ name: string }>;
  head: {
    sha: string;
    ref: string;
    repo: {
      full_name: string;
    } | null;
  };
}

interface ChangedFile {
  filename: string;
  status: string;
  previous_filename?: string;
}

interface Review {
  state: string;
  commit_id: string;
  author_association: string;
  user: {
    login: string;
    type: string;
  };
}

interface Commit {
  author: { login: string } | null;
  commit: { message: string };
}

interface WorkflowRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
}

interface CheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
}

interface CommitStatus {
  context: string;
  state: string;
  description: string;
}

interface ApiParams {
  pull_number?: number;
  workflow_id?: string;
  head_sha?: string;
  ref?: string;
  run_id?: number;
  issue_number?: number;
  labels?: string[];
  [key: string]: unknown;
}

interface HarnessOptions {
  pullRequests?: PullRequest[];
  filesByPull?: Record<number, ChangedFile[]>;
  reviewsByPull?: Record<number, Review[]>;
  commitsByPull?: Record<number, Commit[]>;
  checksBySha?: Record<string, CheckRun[]>;
  runs?: Record<string, WorkflowRun[]>;
  statusesBySha?: Record<string, CommitStatus[]>;
  fileErrors?: number[];
}

interface ReconcilerModule {
  reconcileAgenticPullRequests(input: {
    github: unknown;
    context: unknown;
    core: unknown;
  }): Promise<void>;
}

const { reconcileAgenticPullRequests } =
  jest.requireActual<ReconcilerModule>(
    "../../.github/scripts/agentic-pr-reconciler.cjs",
  );

const repository = "VeVarunSharma/project-krypto-dog";

function pullRequest(
  number: number,
  overrides: Partial<PullRequest> = {},
): PullRequest {
  return {
    number,
    title: "[docs-sync] Refresh contributor guide",
    draft: false,
    html_url: `https://github.com/${repository}/pull/${number}`,
    user: {
      login: "github-actions[bot]",
      type: "Bot",
    },
    labels: [
      { name: "agentic-factory" },
      { name: "docs-sync" },
      { name: "agentic-automerge" },
    ],
    head: {
      sha: `sha-${number}`,
      ref: `docs/agent-update-${number}`,
      repo: {
        full_name: repository,
      },
    },
    ...overrides,
  };
}

function runKey(workflowId: string, sha: string): string {
  return `${workflowId}:${sha}`;
}

function pullRequestInputs(number: number) {
  return {
    pr: String(number),
    aw_context: JSON.stringify({
      item_type: "pull_request",
      item_number: number,
    }),
  };
}

function targetInputs(number: number) {
  return {
    target: String(number),
    aw_context: JSON.stringify({
      item_type: "pull_request",
      item_number: number,
    }),
  };
}

function successRun(
  id: number,
  name: string,
  overrides: Partial<WorkflowRun> = {},
): WorkflowRun {
  return {
    id,
    name,
    status: "completed",
    conclusion: "success",
    ...overrides,
  };
}

function createHarness(options: HarnessOptions = {}) {
  const pullRequests = options.pullRequests ?? [pullRequest(1)];
  const fileErrors = new Set(options.fileErrors ?? []);

  const listPulls = jest.fn();
  const listFiles = jest.fn();
  const listReviews = jest.fn();
  const listCommits = jest.fn();
  const listCommitStatusesForRef = jest.fn();

  const paginate = jest.fn(
    async (method: unknown, params: ApiParams): Promise<unknown[]> => {
      if (method === listPulls) {
        return pullRequests;
      }
      if (method === listFiles) {
        const number = params.pull_number ?? -1;
        if (fileErrors.has(number)) {
          throw new Error(`file lookup failed for ${number}`);
        }
        return (
          options.filesByPull?.[number] ?? [
            {
              filename: "docs/guides/contributing.md",
              status: "modified",
            },
          ]
        );
      }
      if (method === listReviews) {
        return options.reviewsByPull?.[params.pull_number ?? -1] ?? [];
      }
      if (method === listCommits) {
        return options.commitsByPull?.[params.pull_number ?? -1] ?? [];
      }
      if (method === listCommitStatusesForRef) {
        return options.statusesBySha?.[params.ref ?? ""] ?? [];
      }
      if (method === listForRef) {
        return options.checksBySha?.[params.ref ?? ""] ?? [
          {
            id: 40,
            name: "Agentic code review",
            status: "completed",
            conclusion: "success",
          },
        ];
      }
      throw new Error("Unexpected paginated method");
    },
  );

  const listWorkflowRuns = jest.fn(async (params: ApiParams) => {
    const workflowId = params.workflow_id ?? "";
    const sha = params.head_sha ?? "";
    const configured = options.runs?.[runKey(workflowId, sha)];
    let workflowRuns: WorkflowRun[];

    if (configured) {
      workflowRuns = configured;
    } else if (workflowId === "ci.yml") {
      workflowRuns = [successRun(20, "CI")];
    } else if (workflowId === "code-review.lock.yml") {
      workflowRuns = [successRun(30, "Code Review")];
    } else {
      workflowRuns = [];
    }

    return {
      data: {
        workflow_runs: [...workflowRuns],
      },
    };
  });

  const listForRef = jest.fn();
  const createCommitStatus = jest.fn(async (_params: ApiParams) => ({}));
  const createWorkflowDispatch = jest.fn(
    async (_params: ApiParams) => ({}),
  );
  const approveWorkflowRun = jest.fn(async (_params: ApiParams) => ({}));
  const addLabels = jest.fn(async (_params: ApiParams) => ({}));
  const core = {
    info: jest.fn(),
    warning: jest.fn(),
  };

  const github = {
    paginate,
    rest: {
      actions: {
        approveWorkflowRun,
        createWorkflowDispatch,
        listWorkflowRuns,
      },
      checks: {
        listForRef,
      },
      issues: {
        addLabels,
      },
      pulls: {
        list: listPulls,
        listCommits,
        listFiles,
        listReviews,
      },
      repos: {
        createCommitStatus,
        listCommitStatusesForRef,
      },
    },
  };

  return {
    core,
    github,
    mocks: {
      addLabels,
      approveWorkflowRun,
      createCommitStatus,
      createWorkflowDispatch,
      listForRef,
      listWorkflowRuns,
      paginate,
    },
  };
}

async function reconcile(
  options: HarnessOptions = {},
): Promise<ReturnType<typeof createHarness>> {
  const harness = createHarness(options);
  await reconcileAgenticPullRequests({
    github: harness.github,
    context: {
      repo: {
        owner: "VeVarunSharma",
        repo: "project-krypto-dog",
      },
    },
    core: harness.core,
  });
  return harness;
}

function dispatchedWorkflow(
  mock: jest.Mock,
  workflowId: string,
): boolean {
  return mock.mock.calls.some(
    ([params]: [ApiParams]) => params.workflow_id === workflowId,
  );
}

describe("agentic PR reconciler integration", () => {
  it("creates the deterministic merge-policy commit status", async () => {
    const { mocks } = await reconcile();

    expect(mocks.createCommitStatus).toHaveBeenCalledWith({
      owner: "VeVarunSharma",
      repo: "project-krypto-dog",
      sha: "sha-1",
      state: "success",
      context: "Agentic merge policy",
      description: "Current-head agent reviews approve this PR",
      target_url: `https://github.com/${repository}/pull/1`,
    });
  });

  it("does not recreate an identical current merge-policy status", async () => {
    const { mocks } = await reconcile({
      statusesBySha: {
        "sha-1": [
          {
            context: "Agentic merge policy",
            state: "success",
            description: "Current-head agent reviews approve this PR",
          },
        ],
      },
    });

    expect(mocks.createCommitStatus).not.toHaveBeenCalled();
  });

  it("dispatches missing CI and agentic review on the PR head", async () => {
    const { mocks } = await reconcile({
      runs: {
        [runKey("ci.yml", "sha-1")]: [],
        [runKey("code-review.lock.yml", "sha-1")]: [],
      },
    });

    expect(mocks.createWorkflowDispatch).toHaveBeenCalledWith({
      owner: "VeVarunSharma",
      repo: "project-krypto-dog",
      workflow_id: "ci.yml",
      ref: "docs/agent-update-1",
      inputs: {},
    });
    expect(mocks.createWorkflowDispatch).toHaveBeenCalledWith({
      owner: "VeVarunSharma",
      repo: "project-krypto-dog",
      workflow_id: "code-review.lock.yml",
      ref: "docs/agent-update-1",
      inputs: pullRequestInputs(1),
    });
    expect(
      dispatchedWorkflow(
        mocks.createWorkflowDispatch,
        "pr-self-heal.lock.yml",
      ),
    ).toBe(false);
  });

  it("dispatches required security and trading specialist reviews", async () => {
    const { mocks } = await reconcile({
      filesByPull: {
        1: [
          {
            filename: ".github/workflows/ci.yml",
            status: "modified",
          },
          {
            filename: "src/db/schema.ts",
            status: "modified",
          },
        ],
      },
    });

    expect(mocks.createCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "pending",
        description: "Waiting for Security review",
      }),
    );
    expect(mocks.createWorkflowDispatch).toHaveBeenCalledWith({
      owner: "VeVarunSharma",
      repo: "project-krypto-dog",
      workflow_id: "security-review.lock.yml",
      ref: "docs/agent-update-1",
      inputs: targetInputs(1),
    });
    expect(mocks.createWorkflowDispatch).toHaveBeenCalledWith({
      owner: "VeVarunSharma",
      repo: "project-krypto-dog",
      workflow_id: "trading-safety-review.lock.yml",
      ref: "docs/agent-update-1",
      inputs: targetInputs(1),
    });
  });

  it("approves a high-risk PR after every required agent check passes", async () => {
    const { mocks } = await reconcile({
      filesByPull: {
        1: [
          {
            filename: ".github/workflows/ci.yml",
            status: "modified",
          },
          {
            filename: "src/db/schema.ts",
            status: "modified",
          },
        ],
      },
      checksBySha: {
        "sha-1": [
          {
            id: 40,
            name: "Agentic code review",
            status: "completed",
            conclusion: "success",
          },
          {
            id: 41,
            name: "Security review",
            status: "completed",
            conclusion: "success",
          },
          {
            id: 42,
            name: "Trading safety review",
            status: "completed",
            conclusion: "success",
          },
        ],
      },
      runs: {
        [runKey("security-review.lock.yml", "sha-1")]: [
          successRun(50, "Security Review"),
        ],
        [runKey("trading-safety-review.lock.yml", "sha-1")]: [
          successRun(51, "Trading Safety Review"),
        ],
      },
    });

    expect(mocks.createCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "success",
        description: "Current-head agent reviews approve this PR",
      }),
    );
    expect(
      dispatchedWorkflow(
        mocks.createWorkflowDispatch,
        "security-review.lock.yml",
      ),
    ).toBe(false);
    expect(
      dispatchedWorkflow(
        mocks.createWorkflowDispatch,
        "trading-safety-review.lock.yml",
      ),
    ).toBe(false);
  });

  it("approves held CI only for a trusted enrolled agent PR", async () => {
    const trusted = pullRequest(1);
    const untrusted = pullRequest(2, {
      user: {
        login: "trusted-human",
        type: "User",
      },
    });
    const { mocks } = await reconcile({
      pullRequests: [trusted, untrusted],
      runs: {
        [runKey("ci.yml", "sha-1")]: [
          successRun(101, "CI", { conclusion: "action_required" }),
        ],
        [runKey("ci.yml", "sha-2")]: [
          successRun(102, "CI", { conclusion: "action_required" }),
        ],
      },
    });

    expect(mocks.approveWorkflowRun).toHaveBeenCalledTimes(1);
    expect(mocks.approveWorkflowRun).toHaveBeenCalledWith({
      owner: "VeVarunSharma",
      repo: "project-krypto-dog",
      run_id: 101,
    });
    expect(
      dispatchedWorkflow(
        mocks.createWorkflowDispatch,
        "pr-self-heal.lock.yml",
      ),
    ).toBe(false);
  });

  it("manually redispatches held agentic review for same-repository PRs", async () => {
    const trusted = pullRequest(1);
    const untrusted = pullRequest(2, {
      labels: [{ name: "agentic-factory" }],
    });
    const { mocks } = await reconcile({
      pullRequests: [trusted, untrusted],
      runs: {
        [runKey("code-review.lock.yml", "sha-1")]: [
          successRun(201, "Code Review", {
            conclusion: "action_required",
          }),
        ],
        [runKey("code-review.lock.yml", "sha-2")]: [
          successRun(202, "Code Review", {
            conclusion: "action_required",
          }),
        ],
      },
    });

    const reviewDispatches = mocks.createWorkflowDispatch.mock.calls.filter(
      ([params]: [ApiParams]) =>
        params.workflow_id === "code-review.lock.yml",
    );
    expect(reviewDispatches).toEqual([
      [
        {
          owner: "VeVarunSharma",
          repo: "project-krypto-dog",
          workflow_id: "code-review.lock.yml",
          ref: "docs/agent-update-1",
          inputs: pullRequestInputs(1),
        },
      ],
      [
        {
          owner: "VeVarunSharma",
          repo: "project-krypto-dog",
          workflow_id: "code-review.lock.yml",
          ref: "docs/agent-update-2",
          inputs: pullRequestInputs(2),
        },
      ],
    ]);
    expect(mocks.approveWorkflowRun).not.toHaveBeenCalled();
    expect(
      dispatchedWorkflow(
        mocks.createWorkflowDispatch,
        "pr-self-heal.lock.yml",
      ),
    ).toBe(false);
  });

  it.each(["CI", "review"] as const)(
    "dispatches self-heal for a completed failed %s check",
    async (failureSource) => {
      const ciRun =
        failureSource === "CI"
          ? successRun(301, "CI", { conclusion: "failure" })
          : successRun(301, "CI");
      const reviewCheck: CheckRun = {
        id: 401,
        name: "Agentic code review",
        status: "completed",
        conclusion:
          failureSource === "review" ? "failure" : "success",
      };

      const { mocks } = await reconcile({
        runs: {
          [runKey("ci.yml", "sha-1")]: [ciRun],
          [runKey("code-review.lock.yml", "sha-1")]: [
            successRun(302, "Code Review"),
          ],
          [runKey("pr-self-heal.lock.yml", "sha-1")]: [],
        },
        checksBySha: {
          "sha-1": [reviewCheck],
        },
      });

      expect(mocks.createWorkflowDispatch).toHaveBeenCalledWith({
        owner: "VeVarunSharma",
        repo: "project-krypto-dog",
        workflow_id: "pr-self-heal.lock.yml",
        ref: "docs/agent-update-1",
        inputs: pullRequestInputs(1),
      });
    },
  );

  it("paginates check runs before selecting the latest review result", async () => {
    const fillerChecks = Array.from({ length: 101 }, (_, index) => ({
      id: index + 1,
      name: `Unrelated check ${index + 1}`,
      status: "completed",
      conclusion: "success",
    }));
    const { mocks } = await reconcile({
      runs: {
        [runKey("pr-self-heal.lock.yml", "sha-1")]: [],
      },
      checksBySha: {
        "sha-1": [
          ...fillerChecks,
          {
            id: 1000,
            name: "Agentic code review",
            status: "completed",
            conclusion: "failure",
          },
        ],
      },
    });

    expect(mocks.paginate).toHaveBeenCalledWith(
      mocks.listForRef,
      expect.objectContaining({
        owner: "VeVarunSharma",
        repo: "project-krypto-dog",
        ref: "sha-1",
        per_page: 100,
      }),
    );
    expect(mocks.createWorkflowDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow_id: "pr-self-heal.lock.yml",
      }),
    );
  });

  it("never routes action_required CI or review runs to self-heal", async () => {
    const { mocks } = await reconcile({
      runs: {
        [runKey("ci.yml", "sha-1")]: [
          successRun(501, "CI", { conclusion: "action_required" }),
        ],
        [runKey("code-review.lock.yml", "sha-1")]: [
          successRun(502, "Code Review", {
            conclusion: "action_required",
          }),
        ],
      },
      checksBySha: {
        "sha-1": [
          {
            id: 503,
            name: "Agentic code review",
            status: "completed",
            conclusion: "failure",
          },
        ],
      },
    });

    expect(mocks.approveWorkflowRun).toHaveBeenCalledTimes(1);
    expect(
      dispatchedWorkflow(
        mocks.createWorkflowDispatch,
        "code-review.lock.yml",
      ),
    ).toBe(true);
    expect(
      dispatchedWorkflow(
        mocks.createWorkflowDispatch,
        "pr-self-heal.lock.yml",
      ),
    ).toBe(false);
    expect(
      mocks.listWorkflowRuns.mock.calls.some(
        ([params]: [ApiParams]) =>
          params.workflow_id === "pr-self-heal.lock.yml",
      ),
    ).toBe(false);
  });

  it("labels a failed PR exhausted after two trusted repair commits", async () => {
    const repairCommit = (message: string): Commit => ({
      author: { login: "github-actions[bot]" },
      commit: { message },
    });
    const { mocks } = await reconcile({
      runs: {
        [runKey("ci.yml", "sha-1")]: [
          successRun(601, "CI", { conclusion: "failure" }),
        ],
      },
      commitsByPull: {
        1: [
          repairCommit("docs: first repair [self-heal]"),
          repairCommit("docs: second repair [self-heal]"),
        ],
      },
    });

    expect(mocks.addLabels).toHaveBeenCalledWith({
      owner: "VeVarunSharma",
      repo: "project-krypto-dog",
      issue_number: 1,
      labels: ["self-heal-exhausted", "blocked"],
    });
    expect(
      dispatchedWorkflow(
        mocks.createWorkflowDispatch,
        "pr-self-heal.lock.yml",
      ),
    ).toBe(false);
  });

  it("labels a still-failing PR after a completed no-change heal run", async () => {
    const { mocks } = await reconcile({
      runs: {
        [runKey("ci.yml", "sha-1")]: [
          successRun(701, "CI", { conclusion: "failure" }),
        ],
        [runKey("pr-self-heal.lock.yml", "sha-1")]: [
          successRun(702, "PR Self Heal"),
        ],
      },
    });

    expect(mocks.addLabels).toHaveBeenCalledWith({
      owner: "VeVarunSharma",
      repo: "project-krypto-dog",
      issue_number: 1,
      labels: ["self-heal-exhausted", "blocked"],
    });
  });

  it("does not self-heal non-low-risk or specialist-blocked PRs", async () => {
    const nonLowRisk = pullRequest(1);
    const specialistBlocked = pullRequest(2, {
      labels: [
        { name: "agentic-factory" },
        { name: "agentic-automerge" },
        { name: "security-review" },
      ],
    });
    const { mocks } = await reconcile({
      pullRequests: [nonLowRisk, specialistBlocked],
      filesByPull: {
        1: [{ filename: "src/agent/run.ts", status: "modified" }],
      },
      runs: {
        [runKey("ci.yml", "sha-1")]: [
          successRun(801, "CI", { conclusion: "failure" }),
        ],
        [runKey("ci.yml", "sha-2")]: [
          successRun(802, "CI", { conclusion: "failure" }),
        ],
      },
    });

    expect(
      dispatchedWorkflow(
        mocks.createWorkflowDispatch,
        "pr-self-heal.lock.yml",
      ),
    ).toBe(false);
  });

  it("isolates a per-PR API failure and reconciles the next PR", async () => {
    const { core, mocks } = await reconcile({
      pullRequests: [pullRequest(1), pullRequest(2)],
      fileErrors: [1],
    });

    expect(core.warning).toHaveBeenCalledWith(
      "Failed to reconcile PR #1: file lookup failed for 1",
    );
    expect(mocks.createCommitStatus).toHaveBeenCalledTimes(1);
    expect(mocks.createCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        sha: "sha-2",
        context: "Agentic merge policy",
      }),
    );
  });
});
