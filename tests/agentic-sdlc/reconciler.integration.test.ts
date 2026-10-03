export {};

interface PullRequest {
  number: number;
  title: string;
  draft: boolean;
  state: "open" | "closed";
  node_id: string;
  auto_merge: unknown;
  html_url: string;
  body: string;
  user: {
    login: string;
    type: string;
    id?: number;
    node_id?: string;
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
  author:
    | { login: string; type?: string; id?: number; node_id?: string }
    | null;
  commit: { message: string };
}

interface WorkflowRun {
  id: number;
  name: string;
  event?: string;
  status: string;
  conclusion: string | null;
  head_sha?: string;
  head_branch?: string;
  display_title?: string;
}

interface CheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  details_url?: string;
  output?: {
    title: string;
    summary: string;
  };
}

interface ApiParams {
  pull_number?: number;
  workflow_id?: string;
  head_sha?: string;
  check_run_id?: number;
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
  fileErrors?: number[];
  addLabelErrors?: number[];
  updateCheckErrors?: number[];
  controlIssues?: Array<{ labels: Array<{ name: string }> }>;
  controlTimeline?: Array<{
    event: string;
    created_at: string;
    label?: { name: string };
    actor?: { login: string; type: string };
  }>;
  provenanceIssues?: Record<
    number,
    { body?: string; labels: Array<{ name: string }> }
  >;
  commentsByIssue?: Record<
    number,
    Array<{
      id?: number;
      created_at?: string;
      body: string;
      user: {
        login: string;
        type: string;
        id?: number;
        node_id?: string;
      };
    }>
  >;
  goalMaxRiskTier?: string;
  goalAllowedPaths?: string;
  context?: {
    eventName?: string;
    payload?: Record<string, unknown>;
  };
}

interface ReconcilerModule {
  reconcileAgenticPullRequests(input: {
    github: unknown;
    context: unknown;
    core: unknown;
    assignmentActorNodeId?: string;
  }): Promise<void>;
}

const { reconcileAgenticPullRequests } =
  jest.requireActual<ReconcilerModule>(
    "../../.github/scripts/agentic-pr-reconciler.cjs",
  );

const repository = "VeVarunSharma/project-krypto-dog";
const COPILOT_ACTOR = {
  login: "Copilot",
  type: "Bot",
  id: 198982749,
  node_id: "BOT_copilot",
};
const ACTIONS_ACTOR = {
  login: "github-actions[bot]",
  type: "Bot",
  id: 41898282,
  node_id: "BOT_actions",
};
const ASSIGNMENT_ACTOR = {
  login: "VeVarunSharma",
  type: "User",
  id: 62218708,
  node_id: "U_assignment_actor",
};
const VALID_ASSIGNEES = [ASSIGNMENT_ACTOR, COPILOT_ACTOR];
const ASSIGNED_AT = "2026-08-20T20:51:30.000Z";
const CLAIM_CREATED_AT = "2026-08-20T18:57:11.000Z";
const CLAIM_EXPIRES_AT = "2026-08-20T20:56:29.000Z";

function claimNonce(issueNumber: number): string {
  return `32405933684:1:${issueNumber}`;
}

function trustedClaimComment(
  issueNumber: number,
  nonce = claimNonce(issueNumber),
) {
  const [runId, runAttempt] = nonce.split(":");
  return {
    id: issueNumber * 10,
    created_at: CLAIM_CREATED_AT,
    user: ACTIONS_ACTOR,
    body: `<!-- factory-claim:v1 ${JSON.stringify({
      nonce,
      owner: `queue-controller:${runId}:${runAttempt}`,
      issueNumber,
      expiresAt: CLAIM_EXPIRES_AT,
    })} -->`,
  };
}

function assignmentEvents(issueNumber: number) {
  return [
    {
      id: issueNumber * 100 + 1,
      event: "assigned",
      created_at: ASSIGNED_AT,
      actor: ASSIGNMENT_ACTOR,
      assignee: COPILOT_ACTOR,
    },
    {
      id: issueNumber * 100 + 2,
      event: "assigned",
      created_at: ASSIGNED_AT,
      actor: ASSIGNMENT_ACTOR,
      assignee: ASSIGNMENT_ACTOR,
    },
  ];
}

function assignmentAttestation(issueNumber: number, nonce: string) {
  return {
    id: issueNumber * 100 + 3,
    created_at: ASSIGNED_AT,
    user: ACTIONS_ACTOR,
    body: `<!-- factory-assignment:v1 ${JSON.stringify({
      nonce,
      assignedAt: ASSIGNED_AT,
      eventIds: assignmentEvents(issueNumber).map((event) => event.id),
      copilotNodeId: COPILOT_ACTOR.node_id,
      assignmentActorNodeId: ASSIGNMENT_ACTOR.node_id,
    })} -->`,
  };
}

function reconcilerContext(
  overrides: {
    eventName?: string;
    payload?: Record<string, unknown>;
  } = {},
) {
  return {
    repo: {
      owner: "VeVarunSharma",
      repo: "project-krypto-dog",
      default_branch: "main",
    },
    ...overrides,
  };
}

function pullRequest(
  number: number,
  overrides: Partial<PullRequest> = {},
): PullRequest {
  return {
    number,
    title: "[docs-sync] Refresh contributor guide",
    draft: false,
    state: "open",
    node_id: `PR_node_${number}`,
    auto_merge: null,
    html_url: `https://github.com/${repository}/pull/${number}`,
    body: "",
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

function dispatchMetadata(workflowId: string, number: number) {
  const sha = `sha-${number}`;
  return {
    head_sha: sha,
    correlation_id: `agentic-pr:${number}:${sha}:${workflowId}`,
  };
}

function pullRequestInputs(workflowId: string, number: number) {
  return {
    pr: String(number),
    aw_context: JSON.stringify({
      item_type: "pull_request",
      item_number: number,
    }),
    ...dispatchMetadata(workflowId, number),
  };
}

function targetInputs(workflowId: string, number: number) {
  return {
    target: String(number),
    aw_context: JSON.stringify({
      item_type: "pull_request",
      item_number: number,
    }),
    ...dispatchMetadata(workflowId, number),
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
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    ...overrides,
  };
}

function createHarness(options: HarnessOptions = {}) {
  const pullRequests = options.pullRequests ?? [pullRequest(1)];
  const fileErrors = new Set(options.fileErrors ?? []);
  const addLabelErrors = new Set(options.addLabelErrors ?? []);
  const updateCheckErrors = new Set(options.updateCheckErrors ?? []);

  const listPulls = jest.fn();
  const listFiles = jest.fn();
  const listReviews = jest.fn();
  const listCommits = jest.fn();
  const listForRepo = jest.fn();
  const listEventsForTimeline = jest.fn();
  const listComments = jest.fn();
  const getIssue = jest.fn();

  const paginate = jest.fn(
    async (method: unknown, params: ApiParams): Promise<unknown[]> => {
      if (method === listPulls) {
        return pullRequests;
      }
      if (method === listForRepo) {
        return (
          options.controlIssues ?? [
            {
              number: 233,
              labels: [
                { name: "factory-control" },
                { name: "factory-mode:active" },
              ],
            },
          ]
        );
      }
      if (method === listComments) {
        const issueNumber = params.issue_number ?? -1;
        const comments = options.commentsByIssue?.[issueNumber] ?? [];
        const claim = comments.find((comment) =>
          comment.body.includes("<!-- factory-claim:v1 "),
        );
        const match = claim
          ? /<!-- factory-claim:v1 (.+?) -->/s.exec(claim.body)
          : null;
        if (
          match &&
          !comments.some((comment) =>
            comment.body.includes("<!-- factory-assignment:v1 "),
          )
        ) {
          const payload = JSON.parse(match[1]) as { nonce: string };
          return [
            ...comments,
            assignmentAttestation(issueNumber, payload.nonce),
          ];
        }
        return comments;
      }
      if (method === listEventsForTimeline) {
        if (params.issue_number === 10) {
          return [
            {
              event: "labeled",
              created_at: "2026-08-19T00:00:00Z",
              label: { name: "factory:goal-approved" },
              actor: { login: "owner", type: "User" },
            },
          ];
        }
        if (params.issue_number !== 233) {
          return assignmentEvents(params.issue_number ?? -1);
        }
        return (
          options.controlTimeline ?? [
            {
              event: "labeled",
              created_at: "2026-08-19T00:00:00Z",
              label: { name: "factory-mode:active" },
              actor: { login: "owner", type: "User" },
            },
          ]
        );
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
        return (
          options.commitsByPull?.[params.pull_number ?? -1] ?? []
        ).map((commit) => {
          if (commit.author?.login === "github-actions[bot]") {
            return { ...commit, author: ACTIONS_ACTOR };
          }
          if (commit.author?.login === "copilot-swe-agent[bot]") {
            return { ...commit, author: COPILOT_ACTOR };
          }
          return commit;
        });
      }
      if (method === listForRef) {
        const checks = options.checksBySha?.[params.ref ?? ""] ?? [
          {
            id: 40,
            name: "Agentic code review",
            status: "completed",
            conclusion: "success",
          },
        ];
        return checks.map((check) => ({
          ...check,
          ...(check.output ? { output: { ...check.output } } : {}),
        }));
      }
      throw new Error("Unexpected paginated method");
    },
  );

  const listWorkflowRuns = jest.fn(async (params: ApiParams) => {
    const workflowId = params.workflow_id ?? "";
    const workflowRuns = pullRequests.flatMap((pull, index) => {
      const key = runKey(workflowId, pull.head.sha);
      if (Object.hasOwn(options.runs ?? {}, key)) {
        return (options.runs?.[key] ?? []).map((run) => ({
          ...run,
          head_sha: run.head_sha ?? pull.head.sha,
        }));
      }
      if (workflowId === "ci.yml") {
        return [
          successRun(20 + index, "CI", {
            head_sha: pull.head.sha,
          }),
        ];
      }
      if (workflowId === "code-review.lock.yml") {
        return [
          successRun(30 + index, "Code Review", {
            head_sha: pull.head.sha,
          }),
        ];
      }
      return [];
    });

    return {
      data: {
        workflow_runs: [...workflowRuns],
      },
    };
  });

  const listForRef = jest.fn();
  const createCheckRun = jest.fn(async (_params: ApiParams) => ({}));
  const updateCheckRun = jest.fn(async (params: ApiParams) => {
    if (updateCheckErrors.has(params.check_run_id ?? -1)) {
      throw new Error("check update forbidden");
    }
    return {};
  });
  const createWorkflowDispatch = jest.fn(
    async (_params: ApiParams) => ({}),
  );
  const approveWorkflowRun = jest.fn(async (_params: ApiParams) => ({}));
  const addLabels = jest.fn(async (params: ApiParams) => {
    if (addLabelErrors.has(params.issue_number ?? -1)) {
      throw new Error("label update forbidden");
    }
    return {};
  });
  const removeLabel = jest.fn(async (_params: ApiParams) => ({}));
  const createComment = jest.fn(async (_params: ApiParams) => ({}));
  const graphql = jest.fn(async (query: string) => {
    if (query.includes("EnableAgenticAutoMerge")) {
      return {
        enablePullRequestAutoMerge: {
          pullRequest: { number: 1 },
        },
      };
    }
    if (!query.includes("ResolveCopilotSuggestedActor")) {
      throw new Error("Unexpected GraphQL query");
    }
    return {
      repository: {
        suggestedActors: {
          nodes: [
            {
              __typename: "Bot",
              login: "copilot-swe-agent",
              id: COPILOT_ACTOR.node_id,
              databaseId: COPILOT_ACTOR.id,
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    };
  });
  getIssue.mockImplementation(async (params: ApiParams) => ({
    data:
      params.issue_number === 10
        ? {
            state: "open",
            labels: [
              { name: "factory:goal" },
              { name: "factory:goal-approved" },
            ],
            body: [
              "### Allowed paths",
              "",
              options.goalAllowedPaths ?? "docs/**",
              "",
              "### Maximum autonomous risk tier",
              "",
              options.goalMaxRiskTier ?? "risk:boundary",
            ].join("\n"),
          }
        : {
            number: params.issue_number,
            ...(options.provenanceIssues?.[
              params.issue_number ?? -1
            ] ?? { labels: [] }),
            assignees: VALID_ASSIGNEES,
          },
  }));
  const core = {
    info: jest.fn(),
    warning: jest.fn(),
  };

  const github = {
    paginate,
    graphql,
    request: jest.fn(
      async (
        _route: string,
        params: ApiParams,
      ): Promise<{ data: { number: number } }> => ({
        data: {
          number:
            params.issue_number === 99
              ? 10
              : -1,
        },
      }),
    ),
    rest: {
      actions: {
        approveWorkflowRun,
        createWorkflowDispatch,
        listWorkflowRuns,
      },
      checks: {
        create: createCheckRun,
        listForRef,
        update: updateCheckRun,
      },
      issues: {
        addLabels,
        get: getIssue,
        listComments,
        listForRepo,
        listEventsForTimeline,
        removeLabel,
        createComment,
      },
      pulls: {
        list: listPulls,
        listCommits,
        listFiles,
        listReviews,
      },
      repos: {},
    },
  };

  return {
    core,
    github,
    mocks: {
      addLabels,
      removeLabel,
      createComment,
      approveWorkflowRun,
      createCheckRun,
      updateCheckRun,
      createWorkflowDispatch,
      listForRef,
      listForRepo,
      listEventsForTimeline,
      listComments,
      getIssue,
      listWorkflowRuns,
      paginate,
      graphql,
    },
  };
}

async function reconcile(
  options: HarnessOptions = {},
): Promise<ReturnType<typeof createHarness>> {
  const harness = createHarness(options);
  await reconcileAgenticPullRequests({
    github: harness.github,
    context: reconcilerContext(options.context),
    core: harness.core,
    assignmentActorNodeId: ASSIGNMENT_ACTOR.node_id,
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

function autoMergeCalls(mock: jest.Mock): unknown[][] {
  return mock.mock.calls.filter(([query]) =>
    String(query).includes("EnableAgenticAutoMerge"),
  );
}

describe("agentic PR reconciler integration", () => {
  it("keeps enrolled PRs fail-closed when the factory control issue is missing", async () => {
    const { mocks } = await reconcile({ controlIssues: [] });

    expect(mocks.createCheckRun).not.toHaveBeenCalled();
    expect(autoMergeCalls(mocks.graphql)).toHaveLength(0);
    expect(mocks.createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it("keeps enrolled PRs advisory-only in shadow mode", async () => {
    const { mocks } = await reconcile({
      controlIssues: [
        {
          labels: [
            { name: "factory-control" },
            { name: "factory-mode:shadow" },
          ],
        },
      ],
    });

    expect(mocks.createCheckRun).not.toHaveBeenCalled();
    expect(autoMergeCalls(mocks.graphql)).toHaveLength(0);
    expect(mocks.createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it("rejects active mode when its latest label event is not human", async () => {
    const { mocks } = await reconcile({
      controlTimeline: [
        {
          event: "labeled",
          created_at: "2026-08-19T00:00:00Z",
          label: { name: "factory-mode:active" },
          actor: { login: "github-actions[bot]", type: "Bot" },
        },
      ],
    });
    expect(mocks.createCheckRun).not.toHaveBeenCalled();
    expect(autoMergeCalls(mocks.graphql)).toHaveLength(0);
    expect(mocks.createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it("approves a correlated Copilot implementation PR with matching claim provenance", async () => {
      const nonce = claimNonce(99);
      const implementation = pullRequest(1, {
        title: "[ai-dev] Implement issue 99",
        body: `<!-- factory-claim:${nonce} -->\nRefs #99`,
        user: COPILOT_ACTOR,
        labels: [
          { name: "agentic-factory" },
          { name: "agentic-automerge" },
          { name: "risk:routine" },
        ],
      });
      const { mocks } = await reconcile({
        pullRequests: [implementation],
        provenanceIssues: {
          99: {
            body: "### Approved parent goal\n\n#10\n\n### Allowed paths\n\ndocs/**",
            labels: [
              { name: "agentic-factory" },
              { name: "factory:pr-open" },
              { name: "risk:routine" },
            ],
          },
        },
        commentsByIssue: {
          99: [trustedClaimComment(99, nonce)],
        },
      });

      expect(mocks.createCheckRun).not.toHaveBeenCalled();
      expect(autoMergeCalls(mocks.graphql)).toHaveLength(1);
  });

  it("pauses before merge or self-heal when more than one PR shares the claim", async () => {
    const nonce = claimNonce(99);
    const body = `<!-- factory-claim:${nonce} -->\nRefs #99`;
    const first = pullRequest(1, {
      title: "[ai-dev] Implement issue 99",
      body,
      user: COPILOT_ACTOR,
      labels: [
        { name: "agentic-factory" },
        { name: "agentic-automerge" },
        { name: "risk:routine" },
      ],
    });
    const second = pullRequest(2, {
      title: "[ai-dev] Duplicate issue 99",
      body: `<!-- factory-claim:${nonce} -->`,
      state: "closed",
      user: COPILOT_ACTOR,
      labels: [
        { name: "agentic-factory" },
        { name: "agentic-automerge" },
        { name: "risk:routine" },
      ],
    });
    const { mocks } = await reconcile({
      pullRequests: [first, second],
      provenanceIssues: {
        99: {
          body:
            "### Approved parent goal\n\n#10\n\n### Allowed paths\n\ndocs/**",
          labels: [
            { name: "factory:pr-open" },
            { name: "risk:routine" },
          ],
        },
      },
      commentsByIssue: {
        99: [trustedClaimComment(99, nonce)],
      },
    });

    expect(mocks.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 233,
        labels: ["factory-mode:paused"],
      }),
    );
    expect(mocks.createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it("inherits boundary risk from the claimed issue before PR risk labeling", async () => {
    const nonce = claimNonce(99);
    const implementation = pullRequest(1, {
      title: "[ai-dev] Implement issue 99",
      body: `<!-- factory-claim:${nonce} -->\nRefs #99`,
      user: COPILOT_ACTOR,
      labels: [
        { name: "agentic-factory" },
        { name: "agentic-automerge" },
      ],
    });

    const { mocks } = await reconcile({
      pullRequests: [implementation],
      provenanceIssues: {
        99: {
          body: "### Approved parent goal\n\n#10\n\n### Allowed paths\n\ndocs/**",
          labels: [
            { name: "factory:pr-open" },
            { name: "risk:boundary" },
          ],
        },
      },
      commentsByIssue: {
        99: [trustedClaimComment(99, nonce)],
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
            name: "QA verification",
            status: "completed",
            conclusion: "success",
          },
        ],
      },
      runs: {
        [runKey("qa-test-plan.lock.yml", "sha-1")]: [
          successRun(49, "QA Test Plan"),
        ],
      },
    });

    expect(mocks.createCheckRun).not.toHaveBeenCalled();
    expect(autoMergeCalls(mocks.graphql)).toHaveLength(0);
  });

  it("pauses when the PR path risk exceeds its approved goal ceiling", async () => {
    const nonce = claimNonce(99);
    const implementation = pullRequest(1, {
      title: "[ai-dev] Change workflow policy",
      body: `<!-- factory-claim:${nonce} -->\nRefs #99`,
      user: COPILOT_ACTOR,
      labels: [
        { name: "agentic-factory" },
        { name: "agentic-automerge" },
        { name: "risk:sensitive" },
      ],
    });
    const { mocks } = await reconcile({
      pullRequests: [implementation],
      goalMaxRiskTier: "risk:sensitive",
      goalAllowedPaths: ".github/**",
      provenanceIssues: {
        99: {
          body: "### Approved parent goal\n\n#10\n\n### Allowed paths\n\n.github/**",
          labels: [
            { name: "factory:pr-open" },
            { name: "risk:sensitive" },
          ],
        },
      },
      commentsByIssue: {
        99: [trustedClaimComment(99, nonce)],
      },
      filesByPull: {
        1: [{ filename: ".github/workflows/ci.yml", status: "modified" }],
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
            name: "QA verification",
            status: "completed",
            conclusion: "success",
          },
          {
            id: 42,
            name: "Security review",
            status: "completed",
            conclusion: "success",
          },
        ],
      },
      runs: {
        [runKey("qa-test-plan.lock.yml", "sha-1")]: [
          successRun(49, "QA Test Plan"),
        ],
        [runKey("security-review.lock.yml", "sha-1")]: [
          successRun(50, "Security Review"),
        ],
      },
    });

    expect(mocks.createCheckRun).not.toHaveBeenCalled();
    expect(autoMergeCalls(mocks.graphql)).toHaveLength(0);
    expect(mocks.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 233,
        labels: ["factory-mode:paused"],
      }),
    );
    expect(mocks.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 233,
        body: expect.stringContaining("exceeds its approved goal ceiling"),
      }),
    );
  });

  it("fails closed when a Copilot implementation PR claim does not match the issue", async () => {
      const implementation = pullRequest(1, {
        title: "[ai-dev] Implement issue 99",
        body: `<!-- factory-claim:${claimNonce(99)} -->\nRefs #99`,
        user: COPILOT_ACTOR,
        labels: [
          { name: "agentic-factory" },
          { name: "agentic-automerge" },
          { name: "risk:routine" },
        ],
      });
      const { mocks } = await reconcile({
        pullRequests: [implementation],
        provenanceIssues: {
          99: {
            body: "### Approved parent goal\n\n#10\n\n### Allowed paths\n\ndocs/**",
            labels: [{ name: "factory:pr-open" }],
          },
        },
        commentsByIssue: {
          99: [trustedClaimComment(99, "32405933685:1:99")],
        },
      });

      expect(mocks.createCheckRun).not.toHaveBeenCalled();
      expect(autoMergeCalls(mocks.graphql)).toHaveLength(0);
      expect(mocks.createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it("never creates synthetic policy checks", async () => {
    const { mocks } = await reconcile();

    expect(mocks.createCheckRun).not.toHaveBeenCalled();
  });

  it("cancels active deprecated policy checks", async () => {
    const { mocks } = await reconcile({
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
            name: "Agentic merge policy",
            status: "in_progress",
            conclusion: null,
            output: {
              title: "Agentic merge policy",
              summary: "Waiting for Agentic code review",
            },
          },
          {
            id: 42,
            name: "Agentic merge policy",
            status: "in_progress",
            conclusion: null,
            output: {
              title: "Agentic merge policy",
              summary: "Waiting for QA verification",
            },
          },
        ],
      },
    });

    expect(mocks.createCheckRun).not.toHaveBeenCalled();
    expect(mocks.updateCheckRun).toHaveBeenCalledWith(
      expect.objectContaining({
        check_run_id: 41,
        name: "Agentic merge policy",
        status: "completed",
        conclusion: "cancelled",
        output: {
          title: "Agentic merge policy",
          summary:
            "Synthetic policy checks are retired; policy is enforced before auto-merge",
        },
      }),
    );
    expect(mocks.updateCheckRun).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Agentic merge policy",
        check_run_id: 42,
        status: "completed",
        conclusion: "cancelled",
        output: {
          title: "Agentic merge policy",
          summary:
            "Synthetic policy checks are retired; policy is enforced before auto-merge",
        },
      }),
    );
  });

  it("backfills deprecated checks on historical PR heads when explicitly requested", async () => {
    const closedPull = pullRequest(2, { state: "closed" });
    const { mocks } = await reconcile({
      pullRequests: [closedPull],
      context: {
        eventName: "workflow_dispatch",
        payload: {
          inputs: {
            backfill_deprecated_checks: "true",
          },
        },
      },
      checksBySha: {
        "sha-2": [
          {
            id: 51,
            name: "Human boundary approval",
            status: "in_progress",
            conclusion: null,
          },
        ],
      },
    });

    expect(mocks.updateCheckRun).toHaveBeenCalledWith(
      expect.objectContaining({
        check_run_id: 51,
        name: "Human boundary approval",
        status: "completed",
        conclusion: "cancelled",
        output: {
          title: "Human boundary approval",
          summary: "Pull request is closed or merged",
        },
      }),
    );
    expect(mocks.createCheckRun).not.toHaveBeenCalled();
  });

  it("dispatches missing CI and agentic review from the trusted default branch", async () => {
    const { mocks } = await reconcile({
      checksBySha: { "sha-1": [] },
      runs: {
        [runKey("ci.yml", "sha-1")]: [],
        [runKey("code-review.lock.yml", "sha-1")]: [],
      },
    });

    expect(mocks.createWorkflowDispatch).toHaveBeenCalledWith({
      owner: "VeVarunSharma",
      repo: "project-krypto-dog",
      workflow_id: "ci.yml",
      ref: "main",
      inputs: dispatchMetadata("ci.yml", 1),
    });
    expect(mocks.createWorkflowDispatch).toHaveBeenCalledWith({
      owner: "VeVarunSharma",
      repo: "project-krypto-dog",
      workflow_id: "code-review.lock.yml",
      ref: "main",
      inputs: pullRequestInputs("code-review.lock.yml", 1),
    });
    expect(
      dispatchedWorkflow(
        mocks.createWorkflowDispatch,
        "pr-self-heal.lock.yml",
      ),
    ).toBe(false);
  });

  it("does not let a denied native review run suppress stable workflow dispatch", async () => {
    const { mocks } = await reconcile({
      checksBySha: { "sha-1": [] },
      runs: {
        [runKey("code-review.lock.yml", "sha-1")]: [
          successRun(31, "Code Review", {
            event: "pull_request",
            conclusion: "skipped",
          }),
        ],
      },
    });
    expect(mocks.createWorkflowDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow_id: "code-review.lock.yml",
        ref: "main",
      }),
    );
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

    expect(mocks.createCheckRun).not.toHaveBeenCalled();
    expect(autoMergeCalls(mocks.graphql)).toHaveLength(0);
    expect(mocks.createWorkflowDispatch).toHaveBeenCalledWith({
      owner: "VeVarunSharma",
      repo: "project-krypto-dog",
      workflow_id: "qa-test-plan.lock.yml",
      ref: "main",
      inputs: targetInputs("qa-test-plan.lock.yml", 1),
    });
    expect(mocks.createWorkflowDispatch).toHaveBeenCalledWith({
      owner: "VeVarunSharma",
      repo: "project-krypto-dog",
      workflow_id: "security-review.lock.yml",
      ref: "main",
      inputs: targetInputs("security-review.lock.yml", 1),
    });
    expect(mocks.createWorkflowDispatch).toHaveBeenCalledWith({
      owner: "VeVarunSharma",
      repo: "project-krypto-dog",
      workflow_id: "trading-safety-review.lock.yml",
      ref: "main",
      inputs: targetInputs("trading-safety-review.lock.yml", 1),
    });
  });

  it("does not duplicate a correlated trusted workflow run", async () => {
    const workflowId = "qa-test-plan.lock.yml";
    const { mocks } = await reconcile({
      filesByPull: {
        1: [{ filename: "src/agent/run.ts", status: "modified" }],
      },
      runs: {
        [runKey(workflowId, "sha-1")]: [
          successRun(51, "QA Test Plan", {
            status: "in_progress",
            conclusion: null,
            head_sha: "main-sha",
            head_branch: "main",
            event: "workflow_dispatch",
            display_title: `agentic-pr:1:sha-1:${workflowId}`,
          }),
        ],
      },
    });

    expect(
      dispatchedWorkflow(mocks.createWorkflowDispatch, workflowId),
    ).toBe(false);
  });

  it("dispatches QA despite a boundary-label failure and fails loud afterward", async () => {
    const harness = createHarness({
      pullRequests: [pullRequest(1), pullRequest(2)],
      filesByPull: {
        1: [
          {
            filename: ".github/workflows/ci.yml",
            status: "modified",
          },
        ],
      },
      addLabelErrors: [1],
    });

    await expect(
      reconcileAgenticPullRequests({
        github: harness.github,
        context: reconcilerContext(),
        core: harness.core,
      }),
    ).rejects.toThrow("Failed to reconcile 1 pull request operation(s)");

    expect(harness.core.warning).toHaveBeenCalledWith(
      "Failed to reconcile PR #1: label update forbidden",
    );
    expect(
      dispatchedWorkflow(
        harness.mocks.createWorkflowDispatch,
        "qa-test-plan.lock.yml",
      ),
    ).toBe(true);
    const qaDispatchIndex =
      harness.mocks.createWorkflowDispatch.mock.calls.findIndex(
        ([params]: [ApiParams]) =>
          params.workflow_id === "qa-test-plan.lock.yml",
      );
    expect(
      harness.mocks.createWorkflowDispatch.mock.invocationCallOrder[
        qaDispatchIndex
      ],
    ).toBeLessThan(harness.mocks.addLabels.mock.invocationCallOrder[0]);
    expect(harness.mocks.createCheckRun).not.toHaveBeenCalled();
  });

  it("approves sensitive reversible work after every required agent check passes", async () => {
    const { mocks } = await reconcile({
      filesByPull: {
        1: [
          {
            filename: "src/app/api/auth/login/route.ts",
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
            name: "QA verification",
            status: "completed",
            conclusion: "success",
          },
          {
            id: 42,
            name: "Security review",
            status: "completed",
            conclusion: "success",
          },
          {
            id: 43,
            name: "Trading safety review",
            status: "completed",
            conclusion: "success",
          },
        ],
      },
      runs: {
        [runKey("qa-test-plan.lock.yml", "sha-1")]: [
          successRun(49, "QA Test Plan"),
        ],
        [runKey("security-review.lock.yml", "sha-1")]: [
          successRun(50, "Security Review"),
        ],
        [runKey("trading-safety-review.lock.yml", "sha-1")]: [
          successRun(51, "Trading Safety Review"),
        ],
      },
    });

    expect(mocks.createCheckRun).not.toHaveBeenCalled();
    expect(autoMergeCalls(mocks.graphql)).toHaveLength(1);
    expect(
      dispatchedWorkflow(
        mocks.createWorkflowDispatch,
        "qa-test-plan.lock.yml",
      ),
    ).toBe(false);
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

  it("keeps boundary work pending for explicit admin merge after approval", async () => {
    const checks = [
      {
        id: 40,
        name: "Agentic code review",
        status: "completed",
        conclusion: "success",
      },
      {
        id: 41,
        name: "QA verification",
        status: "completed",
        conclusion: "success",
      },
      {
        id: 42,
        name: "Security review",
        status: "completed",
        conclusion: "success",
      },
    ];
    const runs = {
      [runKey("qa-test-plan.lock.yml", "sha-1")]: [
        successRun(49, "QA Test Plan"),
      ],
      [runKey("security-review.lock.yml", "sha-1")]: [
        successRun(50, "Security Review"),
      ],
    };
    const withoutApproval = await reconcile({
      filesByPull: {
        1: [{ filename: ".github/workflows/ci.yml", status: "modified" }],
      },
      checksBySha: { "sha-1": checks },
      runs,
    });
    expect(withoutApproval.mocks.createCheckRun).not.toHaveBeenCalled();
    expect(autoMergeCalls(withoutApproval.mocks.graphql)).toHaveLength(0);
    expect(withoutApproval.mocks.addLabels).toHaveBeenCalledWith({
      owner: "VeVarunSharma",
      repo: "project-krypto-dog",
      issue_number: 1,
      labels: ["ready-for-human-review"],
    });

    const withApproval = await reconcile({
      filesByPull: {
        1: [{ filename: ".github/workflows/ci.yml", status: "modified" }],
      },
      reviewsByPull: {
        1: [
          {
            state: "APPROVED",
            commit_id: "sha-1",
            author_association: "OWNER",
            user: { login: "reviewer", type: "User" },
          },
        ],
      },
      checksBySha: { "sha-1": checks },
      runs,
    });
    expect(withApproval.mocks.createCheckRun).not.toHaveBeenCalled();
    expect(autoMergeCalls(withApproval.mocks.graphql)).toHaveLength(0);
  });

  it("does not arm auto-merge when a final boundary-label write fails", async () => {
    const harness = createHarness({
      filesByPull: {
        1: [{ filename: ".github/workflows/ci.yml", status: "modified" }],
      },
      reviewsByPull: {
        1: [
          {
            state: "APPROVED",
            commit_id: "sha-1",
            author_association: "OWNER",
            user: { login: "reviewer", type: "User" },
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
            name: "QA verification",
            status: "completed",
            conclusion: "success",
          },
          {
            id: 42,
            name: "Security review",
            status: "completed",
            conclusion: "success",
          },
        ],
      },
      runs: {
        [runKey("qa-test-plan.lock.yml", "sha-1")]: [
          successRun(49, "QA Test Plan"),
        ],
        [runKey("security-review.lock.yml", "sha-1")]: [
          successRun(50, "Security Review"),
        ],
      },
      addLabelErrors: [1],
    });

    await expect(
      reconcileAgenticPullRequests({
        github: harness.github,
        context: reconcilerContext(),
        core: harness.core,
      }),
    ).rejects.toThrow("Failed to reconcile 1 pull request operation(s)");

    expect(autoMergeCalls(harness.mocks.graphql)).toHaveLength(0);
  });

  it("fails loud when deprecated-check cleanup fails", async () => {
    const harness = createHarness({
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
            name: "Agentic merge policy",
            status: "in_progress",
            conclusion: null,
          },
          {
            id: 42,
            name: "Agentic merge policy",
            status: "in_progress",
            conclusion: null,
          },
        ],
      },
      updateCheckErrors: [41],
    });

    await expect(
      reconcileAgenticPullRequests({
        github: harness.github,
        context: reconcilerContext(),
        core: harness.core,
      }),
    ).rejects.toThrow("Failed to reconcile 1 pull request operation(s)");

    expect(harness.core.warning).toHaveBeenCalledWith(
      "Failed to reconcile PR #1: check update forbidden",
    );
    expect(autoMergeCalls(harness.mocks.graphql)).toHaveLength(0);
  });

  it("dispatches the trusted default workflow when the PR modifies its copy", async () => {
    const { mocks } = await reconcile({
      filesByPull: {
        1: [
          {
            filename: ".github/workflows/code-review.lock.yml",
            status: "modified",
          },
        ],
      },
      checksBySha: { "sha-1": [] },
      runs: {
        [runKey("code-review.lock.yml", "sha-1")]: [],
      },
    });

    expect(mocks.createWorkflowDispatch).toHaveBeenCalledWith({
      owner: "VeVarunSharma",
      repo: "project-krypto-dog",
      workflow_id: "code-review.lock.yml",
      ref: "main",
      inputs: pullRequestInputs("code-review.lock.yml", 1),
    });
  });

  it("replaces held CI with trusted default-branch dispatches", async () => {
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

    const ciDispatches = mocks.createWorkflowDispatch.mock.calls.filter(
      ([params]: [ApiParams]) => params.workflow_id === "ci.yml",
    );
    expect(ciDispatches).toEqual([
      [
        {
          owner: "VeVarunSharma",
          repo: "project-krypto-dog",
          workflow_id: "ci.yml",
          ref: "main",
          inputs: dispatchMetadata("ci.yml", 1),
        },
      ],
      [
        {
          owner: "VeVarunSharma",
          repo: "project-krypto-dog",
          workflow_id: "ci.yml",
          ref: "main",
          inputs: dispatchMetadata("ci.yml", 2),
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
          ref: "main",
          inputs: pullRequestInputs("code-review.lock.yml", 1),
        },
      ],
      [
        {
          owner: "VeVarunSharma",
          repo: "project-krypto-dog",
          workflow_id: "code-review.lock.yml",
          ref: "main",
          inputs: pullRequestInputs("code-review.lock.yml", 2),
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
        ref: "main",
        inputs: pullRequestInputs("pr-self-heal.lock.yml", 1),
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

    expect(mocks.approveWorkflowRun).not.toHaveBeenCalled();
    expect(
      dispatchedWorkflow(mocks.createWorkflowDispatch, "ci.yml"),
    ).toBe(true);
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
    const harness = createHarness({
      pullRequests: [pullRequest(1), pullRequest(2)],
      fileErrors: [1],
    });

    await expect(
      reconcileAgenticPullRequests({
        github: harness.github,
        context: reconcilerContext(),
        core: harness.core,
      }),
    ).rejects.toThrow("Failed to reconcile 1 pull request operation(s)");

    expect(harness.core.warning).toHaveBeenCalledWith(
      "Failed to reconcile PR #1: file lookup failed for 1",
    );
    expect(harness.mocks.createCheckRun).not.toHaveBeenCalled();
    expect(autoMergeCalls(harness.mocks.graphql)).toHaveLength(1);
  });
});
