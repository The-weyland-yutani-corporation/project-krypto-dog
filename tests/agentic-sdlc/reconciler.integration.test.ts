export {};

interface PullRequest {
  number: number;
  title: string;
  draft: boolean;
  state: "open" | "closed";
  html_url: string;
  body: string;
  base?: { sha: string };
  created_at?: string;
  changed_files?: number;
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
  path?: string;
  run_attempt?: number;
  created_at?: string;
  updated_at?: string;
  repository?: { full_name: string };
  pull_requests?: Array<{ number: number; head: { sha: string }; base: { sha: string } }>;
}

interface CheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  head_sha?: string;
  app?: { slug: string };
  external_id?: string;
  check_suite?: { id: number };
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
  ciFailures?: number[];
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
const {
  CI_CHECKS,
  REVIEW_MARKER,
  REVIEW_WORKFLOWS,
  ciFingerprint,
} = jest.requireActual<{
  CI_CHECKS: string[];
  REVIEW_MARKER: string;
  REVIEW_WORKFLOWS: Record<string, string>;
  ciFingerprint(checks: CheckRun[], sha: string): string;
}>("../../.github/scripts/agentic-review-evidence.cjs");
const TRUSTED_WORKFLOW_SHA = "b".repeat(40);

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

function reconcilerContext() {
  return {
    repo: {
      owner: "VeVarunSharma",
      repo: "project-krypto-dog",
      default_branch: "main",
    },
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
    html_url: `https://github.com/${repository}/pull/${number}`,
    body: "",
    base: { sha: TRUSTED_WORKFLOW_SHA },
    created_at: "2026-08-20T00:00:00Z",
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
    ...(workflowId === "ci.yml" ? { pr: String(number) } : {}),
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
    event: name === "CI" ? "pull_request" : "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
    created_at: "2026-08-21T00:00:00Z",
    updated_at: "2026-08-21T00:01:00Z",
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
  const filesForPull = (number: number): ChangedFile[] => {
    if (fileErrors.has(number)) throw new Error(`file lookup failed for ${number}`);
    return options.filesByPull?.[number] ?? [
      { filename: "docs/guides/contributing.md", status: "modified" },
    ];
  };
  const runsForPull = (workflowId: string, pull: PullRequest, index: number): WorkflowRun[] => {
    const key = runKey(workflowId, pull.head.sha);
    const configured = options.runs?.[key];
    const runs = configured ?? (
      workflowId === "ci.yml" ? [successRun(20 + index, "CI")] :
      workflowId === "code-review.lock.yml" ? [successRun(30 + index, "Code Review")] : []
    );
    return runs.map((run) => ({
      ...run,
      run_attempt: run.run_attempt ?? 1,
      created_at: run.created_at ?? "2026-08-21T00:00:00Z",
      updated_at: run.updated_at ?? "2026-08-21T00:01:00Z",
      path: `.github/workflows/${workflowId}`,
      repository: { full_name: repository },
      head_sha: run.head_sha ?? (run.event === "workflow_dispatch" ? TRUSTED_WORKFLOW_SHA : pull.head.sha),
      head_branch: run.head_branch ?? (run.event === "workflow_dispatch" ? "main" : pull.head.ref),
      display_title: run.display_title ?? `agentic-pr:${pull.number}:${pull.head.sha}:${workflowId}`,
      pull_requests: [{ number: pull.number, head: { sha: pull.head.sha }, base: { sha: TRUSTED_WORKFLOW_SHA } }],
    }));
  };
  const ciChecksForPull = (pull: PullRequest): CheckRun[] => {
    const runs = runsForPull("ci.yml", pull, pullRequests.indexOf(pull));
    if (!runs.length || ["action_required", "cancelled", "timed_out"].includes(runs[0].conclusion || "")) return [];
    return CI_CHECKS.map((name, index) => ({
      id: 5000 + pull.number * 10 + index,
      name, head_sha: pull.head.sha, app: { slug: "github-actions" },
      status: "completed",
      conclusion: options.ciFailures?.includes(pull.number) ? "failure" : "success",
      check_suite: { id: 6000 + pull.number },
      details_url: `https://github.com/${repository}/actions/runs/${runs[0].id}/job/${5000 + pull.number * 10 + index}`,
    }));
  };
  const checksForPull = (pull: PullRequest): CheckRun[] => {
    const ci = ciChecksForPull(pull);
    const configured = options.checksBySha?.[pull.head.sha] ?? [{
      id: 40, name: "Agentic code review", status: "completed", conclusion: "success",
    }];
    const checks = configured.map((check) => ({
      ...check, head_sha: pull.head.sha, app: { slug: "github-actions" },
      ...(check.output ? { output: { ...check.output } } : {}),
    }));
    for (const check of checks) {
      const workflow = REVIEW_WORKFLOWS[check.name];
      if (!workflow || check.conclusion !== "success") continue;
      const run = runsForPull(workflow, pull, pullRequests.indexOf(pull))[0];
      if (!run) continue;
      const packetDigest = "e".repeat(64);
      check.external_id = `agentic-review:v1:${packetDigest}`;
      check.output = {
        title: check.name,
        summary: `<!-- ${REVIEW_MARKER} ${JSON.stringify({
          packetDigest, checkName: check.name, headSha: pull.head.sha,
          workflowSha: TRUSTED_WORKFLOW_SHA, pullNumber: pull.number,
          runId: run.id, runAttempt: run.run_attempt, verdict: "pass",
          ciFingerprint: ciFingerprint(ci, pull.head.sha),
        })} -->\nVerified fixture review`,
      };
    }
    return [...ci, ...checks];
  };
  const apiPage = <T,>(items: T[], params: ApiParams) => {
    const offset = (Number(params.page ?? 1) - 1) * Number(params.per_page ?? 100);
    return items.slice(offset, offset + Number(params.per_page ?? 100));
  };

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
        return filesForPull(params.pull_number ?? -1);
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
        const pull = pullRequests.find((item) => item.head.sha === params.ref);
        return pull ? checksForPull(pull) : [];
      }
      throw new Error("Unexpected paginated method");
    },
  );

  const listWorkflowRuns = jest.fn(async (params: ApiParams) => {
    const workflowId = params.workflow_id ?? "";
    const workflowRuns = pullRequests.flatMap((pull, index) => runsForPull(workflowId, pull, index));

    return {
      data: {
        workflow_runs: apiPage(workflowRuns, params),
        total_count: workflowRuns.length,
      },
    };
  });

  const listForRef = jest.fn(async (params: ApiParams) => {
    const pull = pullRequests.find((item) => item.head.sha === params.ref);
    const checks = pull ? checksForPull(pull) : [];
    return { data: { check_runs: apiPage(checks, params), total_count: checks.length } };
  });
  listFiles.mockImplementation(async (params: ApiParams) => ({
    data: apiPage(filesForPull(params.pull_number ?? -1), params),
  }));
  const getPull = jest.fn(async (params: ApiParams) => {
    const pull = pullRequests.find((item) => item.number === params.pull_number);
    if (!pull) throw new Error("Unknown pull request");
    return { data: { ...pull, changed_files: (options.filesByPull?.[pull.number] ?? [{}]).length } };
  });
  const getWorkflowRun = jest.fn(async (params: ApiParams) => {
    for (const [index, pull] of pullRequests.entries()) {
      const run = runsForPull("ci.yml", pull, index).find((item) => item.id === params.run_id);
      if (run) return { data: { ...run, check_suite_id: 6000 + pull.number } };
    }
    throw new Error("Unknown CI source run");
  });
  const listJobsForWorkflowRunAttempt = jest.fn(async (params: ApiParams) => {
    const pull = pullRequests.find((item, index) =>
      runsForPull("ci.yml", item, index).some((run) => run.id === params.run_id));
    if (!pull) throw new Error("Unknown CI job run");
    const jobs = ciChecksForPull(pull).map((check) => ({
      id: check.id, name: check.name, status: check.status, conclusion: check.conclusion, run_attempt: 1,
    }));
    return { data: { jobs: apiPage(jobs, params), total_count: jobs.length } };
  });
  const listWorkflowRunArtifacts = jest.fn(async () => ({ data: { artifacts: [], total_count: 0 } }));
  let createdCheckId = 100000;
  const createCheckRun = jest.fn(async (params: ApiParams) => ({
    data: { ...params, id: createdCheckId++, app: { slug: "github-actions" } },
  }));
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
        getWorkflowRun,
        listJobsForWorkflowRunAttempt,
        listJobsForWorkflowRun: listJobsForWorkflowRunAttempt,
        listWorkflowRunArtifacts,
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
        get: getPull,
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
    context: reconcilerContext(),
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

function expectCheckRun(
  mock: jest.Mock,
  name: string,
  status: string,
  summary: string,
) {
  expect(mock).toHaveBeenCalledWith(
    expect.objectContaining({
      name,
      status,
      output: expect.objectContaining({ summary }),
    }),
  );
}

describe("agentic PR reconciler integration", () => {
  it("keeps enrolled PRs fail-closed when the factory control issue is missing", async () => {
    const { mocks } = await reconcile({ controlIssues: [] });

    expectCheckRun(
      mocks.createCheckRun,
      "Agentic merge policy",
      "in_progress",
      "Factory is paused",
    );
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

    expectCheckRun(
      mocks.createCheckRun,
      "Agentic merge policy",
      "in_progress",
      "Factory shadow mode does not authorize merge",
    );
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
    expectCheckRun(
      mocks.createCheckRun,
      "Agentic merge policy",
      "in_progress",
      "Factory is paused",
    );
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

      expectCheckRun(
        mocks.createCheckRun,
        "Agentic merge policy",
        "completed",
        "Current-head agent reviews approve this PR",
      );
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

    expectCheckRun(
      mocks.createCheckRun,
      "Agentic merge policy",
      "in_progress",
      "Boundary change requires current human approval",
    );
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

    expectCheckRun(
      mocks.createCheckRun,
      "Agentic merge policy",
      "in_progress",
      "PR risk exceeds approved goal",
    );
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

      expectCheckRun(
        mocks.createCheckRun,
        "Agentic merge policy",
        "in_progress",
        "Factory claim provenance is invalid",
      );
      expect(mocks.createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it("creates the deterministic merge-policy check run", async () => {
    const { mocks } = await reconcile();

    expect(mocks.createCheckRun).toHaveBeenCalledWith({
      owner: "VeVarunSharma",
      repo: "project-krypto-dog",
      name: "Agentic merge policy",
      head_sha: "sha-1",
      status: "completed",
      conclusion: "success",
      details_url: `https://github.com/${repository}/pull/1`,
      output: {
        title: "Agentic merge policy",
        summary: "Current-head agent reviews approve this PR",
      },
    });
  });

  it("does not recreate an identical current merge-policy check run", async () => {
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
            status: "completed",
            conclusion: "success",
            details_url: `https://github.com/${repository}/pull/1`,
            output: {
              title: "Agentic merge policy",
              summary: "Current-head agent reviews approve this PR",
            },
          },
        ],
      },
    });

    expect(mocks.createCheckRun).not.toHaveBeenCalled();
    expect(mocks.updateCheckRun).not.toHaveBeenCalled();
  });

  it("updates the active policy check and cancels superseded active checks", async () => {
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
          summary: "Superseded by a newer reconciliation for this head",
        },
      }),
    );
    expect(mocks.updateCheckRun).toHaveBeenCalledWith({
      owner: "VeVarunSharma",
      repo: "project-krypto-dog",
      check_run_id: 42,
      name: "Agentic merge policy",
      status: "completed",
      conclusion: "success",
      details_url: `https://github.com/${repository}/pull/1`,
      output: {
        title: "Agentic merge policy",
        summary: "Current-head agent reviews approve this PR",
      },
    });
    expect(mocks.listForRef).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: "sha-1",
        filter: "all",
      }),
    );
  });

  it("creates a new pending check when a completed result is invalidated", async () => {
    const { mocks } = await reconcile({
      filesByPull: {
        1: [{ filename: "src/agent/run.ts", status: "modified" }],
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
            name: "Agentic merge policy",
            status: "completed",
            conclusion: "success",
            output: {
              title: "Agentic merge policy",
              summary: "Current-head agent reviews approve this PR",
            },
          },
        ],
      },
    });

    expect(mocks.updateCheckRun).not.toHaveBeenCalled();
    expect(mocks.createCheckRun).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Agentic merge policy",
        head_sha: "sha-1",
        status: "in_progress",
        output: {
          title: "Agentic merge policy",
          summary: "Waiting for QA verification",
        },
      }),
    );
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

    expect(mocks.createCheckRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "in_progress",
        output: {
          title: "Agentic merge policy",
          summary: "Waiting for QA verification",
        },
      }),
    );
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
            head_sha: TRUSTED_WORKFLOW_SHA,
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
    expect(harness.mocks.createCheckRun).toHaveBeenCalledWith(
      expect.objectContaining({
        head_sha: "sha-2",
        name: "Agentic merge policy",
      }),
    );
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

    expect(mocks.createCheckRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "completed",
        conclusion: "success",
        output: {
          title: "Agentic merge policy",
          summary: "Current-head agent reviews approve this PR",
        },
      }),
    );
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

  it("keeps boundary work pending until a current-head human approves", async () => {
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
    expectCheckRun(
      withoutApproval.mocks.createCheckRun,
      "Agentic merge policy",
      "in_progress",
      "Boundary change requires current human approval",
    );
    expectCheckRun(
      withoutApproval.mocks.createCheckRun,
      "Human boundary approval",
      "in_progress",
      "Boundary change requires current-head human approval",
    );
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
    expect(withApproval.mocks.updateCheckRun).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Agentic merge policy",
        status: "completed",
        conclusion: "success",
        output: {
          title: "Agentic merge policy",
          summary: "Current-head human and agent reviews approve boundary PR",
        },
      }),
    );
    expectCheckRun(
      withApproval.mocks.createCheckRun,
      "Human boundary approval",
      "completed",
      "Current-head human approval satisfies boundary policy",
    );
  });

  it("keeps merge policy pending when a final boundary-label write fails", async () => {
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

    expect(harness.mocks.updateCheckRun).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Agentic merge policy",
        status: "in_progress",
        output: {
          title: "Agentic merge policy",
          summary: "Reconciler operation failed; retrying",
        },
      }),
    );
    expect(harness.mocks.updateCheckRun).not.toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Agentic merge policy",
        status: "completed",
        conclusion: "success",
      }),
    );
  });

  it("publishes the desired policy before stale-check cleanup", async () => {
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
    const desiredCallIndex = harness.mocks.updateCheckRun.mock.calls.findIndex(
      ([params]: [ApiParams]) =>
        params.check_run_id === 42 && params.conclusion === "success",
    );
    const cleanupCallIndex = harness.mocks.updateCheckRun.mock.calls.findIndex(
      ([params]: [ApiParams]) => params.check_run_id === 41,
    );
    expect(desiredCallIndex).toBeGreaterThanOrEqual(0);
    expect(
      harness.mocks.updateCheckRun.mock.invocationCallOrder[desiredCallIndex],
    ).toBeLessThan(
      harness.mocks.updateCheckRun.mock.invocationCallOrder[cleanupCallIndex],
    );
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
      checksBySha: { "sha-1": [], "sha-2": [] },
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
        ciFailures: failureSource === "CI" ? [1] : [],
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

    expect(mocks.listForRef).toHaveBeenCalledWith(
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

  it("never routes held CI to self-heal or retries a substantive review rejection", async () => {
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
    ).toBe(false);
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
      ciFailures: [1],
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
      ciFailures: [1],
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
    expect(harness.mocks.createCheckRun).toHaveBeenCalledTimes(2);
    expect(harness.mocks.createCheckRun).toHaveBeenCalledWith(expect.objectContaining({
      head_sha: "sha-1",
      name: "Agentic merge policy",
      status: "in_progress",
      output: expect.objectContaining({ summary: "Reconciliation evidence unavailable; no authorization" }),
    }));
    expect(harness.mocks.createCheckRun).toHaveBeenCalledWith(
      expect.objectContaining({
        head_sha: "sha-2",
        name: "Agentic merge policy",
      }),
    );
  });
});
