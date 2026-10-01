export {};

interface Label {
  name: string;
}

interface Comment {
  id: number;
  body: string;
  created_at?: string;
  user?: ActorFixture;
}

interface ActorFixture {
  login: string;
  type?: "Bot" | "User";
  id?: number;
  node_id?: string;
}

interface IssueFixture {
  number: number;
  state: "open" | "closed";
  labels: Label[];
  assignees: ActorFixture[];
  comments: Comment[];
  state_reason?: string;
  body?: string;
}

interface ChangedFileFixture {
  filename: string;
  status: string;
  previous_filename?: string;
}

interface PullRequestFixture {
  number: number;
  node_id: string;
  html_url: string;
  title: string;
  body: string;
  draft: boolean;
  state: "open" | "closed";
  merged_at: string | null;
  merge_commit_sha: string | null;
  auto_merge: unknown;
  user: ActorFixture;
  labels: Label[];
  head: { sha: string; ref: string; repo: { full_name: string } | null };
  base: { ref: string };
}

interface CommitFixture {
  author: ActorFixture | null;
  commit: { message: string };
}

interface CheckRunFixture {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
}

interface CommitStatusFixture {
  id: number;
  context: string;
  state: string;
}

interface DeploymentFixture {
  id: number;
}

interface DeploymentStatusFixture {
  id: number;
  state: string;
}

interface ApiParams {
  issue_number?: number;
  pull_number?: number;
  labels?: string | string[];
  ref?: string;
  sha?: string;
  deployment_id?: number;
  comment_id?: number;
  name?: string;
  body?: string;
  state?: string;
  state_reason?: string;
  [key: string]: unknown;
}

interface ReconcilerModule {
  reconcileFactoryLifecycle(input: {
    github: unknown;
    context: unknown;
    core: unknown;
    now?: string;
    assignmentActorNodeId?: string;
  }): Promise<void>;
  extractClaimMarkerPayload(body: unknown): string | null;
  resolveLatestIssueClaim(
    comments: unknown,
    issueNumber: number,
  ): { state: string; claim?: { nonce: string; owner: string; issueNumber: number; expiresAt: string }; reason?: string };
  classifyAssignmentEvidence(input: unknown): {
    state: string;
    reason?: string;
  };
  buildClaimNonceMarker(nonce: string): string;
  buildRefsMarker(issueNumber: number): string;
  correlatePullRequests(input: {
    pullRequests: unknown[];
    issueNumber: number;
    nonce: string;
    repository: string;
    defaultBranch: string;
    copilotIdentity: {
      nodeId: string;
      databaseId: number;
      suggestedLogin: string;
    };
  }): { candidates: unknown[]; valid: unknown[]; malformed: unknown[] };
  hasTrustedSelfHealCommit(
    commits: unknown[],
    copilotIdentity: {
      nodeId: string;
      databaseId: number;
    },
  ): boolean;
  hasPendingCheckRuns(checkRuns: unknown[]): boolean;
  resolveLifecycleTransitionPath(
    from: string,
    to: string,
  ): { allowed: boolean; path: string[] };
  computeLifecycleLabelChange(
    currentLabelNames: string[],
    target: string,
  ): { toRemove: string[]; toAdd: string[] };
  evaluateDevEvidence(input: unknown): "success" | "failure" | "pending";
  hasConflictingPullRequestRiskLabel(pullRequestRiskLabels: string[], issueRiskLabel: string): boolean;
  isRetryableAutoMergeStateError(error: unknown): boolean;
  ensureAutoMergeEnabled(input: {
    github: unknown;
    core: unknown;
    pullRequest: unknown;
  }): Promise<void>;
  pauseFactoryControl(input: {
    github: unknown;
    core: unknown;
    owner: string;
    repo: string;
    reason: string;
  }): Promise<void>;
  resolveFactoryMode(input: { github: unknown; core: unknown; owner: string; repo: string }): Promise<string>;
  findLatestLabelApplicationEvent(events: unknown, labelName: string): { actor?: { type?: string } } | undefined;
  getIssueFormSection(body: unknown, heading: string): string | undefined;
  validateAllowedPathsScope(input: {
    github: unknown;
    owner: string;
    repo: string;
    issue: unknown;
    pullRequest: unknown;
  }): Promise<{ ok: boolean; reason?: string }>;
  TARGET_LIFECYCLE_LABELS: string[];
}

const reconciler = jest.requireActual<ReconcilerModule>(
  "../../.github/scripts/agentic-lifecycle-reconciler.cjs",
);

const { reconcileFactoryLifecycle } = reconciler;

const owner = "VeVarunSharma";
const repo = "project-krypto-dog";
const repository = `${owner}/${repo}`;
const DEFAULT_BRANCH = "main";
const DEFAULT_NOW = "2026-08-20T20:52:00.000Z";
const CLAIM_CREATED_AT = "2026-08-20T18:57:11.000Z";
const CLAIM_EXPIRES_AT = "2026-08-20T20:56:29.000Z";
const ASSIGNED_AT = "2026-08-20T20:51:30.000Z";
const NONCE_FOR = (issueNumber: number) => `32405933684:1:${issueNumber}`;
const ASSIGNMENT_ACTOR: Required<ActorFixture> = {
  login: "VeVarunSharma",
  type: "User",
  id: 62218708,
  node_id: "U_assignment_actor",
};
const COPILOT_ACTOR: Required<ActorFixture> = {
  login: "Copilot",
  type: "Bot",
  id: 198982749,
  node_id: "BOT_copilot",
};
const ACTIONS_ACTOR: Required<ActorFixture> = {
  login: "github-actions[bot]",
  type: "Bot",
  id: 41898282,
  node_id: "BOT_actions",
};
const COPILOT_IDENTITY = {
  nodeId: COPILOT_ACTOR.node_id,
  databaseId: COPILOT_ACTOR.id,
  suggestedLogin: "copilot-swe-agent",
};
const VALID_ASSIGNEES = [ASSIGNMENT_ACTOR, COPILOT_ACTOR];

let nextCommentId = 1;
function claimComment(
  issueNumber: number,
  overrides: Partial<{
    nonce: string;
    owner: string;
    issueNumber: number;
    expiresAt: string;
    createdAt: string;
    user: ActorFixture;
  }> = {},
): Comment {
  const nonce = overrides.nonce ?? NONCE_FOR(issueNumber);
  const payload = {
    nonce,
    owner: overrides.owner ?? `queue-controller:32405933684:1`,
    issueNumber,
    expiresAt: overrides.expiresAt ?? CLAIM_EXPIRES_AT,
    ...(overrides.issueNumber === undefined
      ? {}
      : { issueNumber: overrides.issueNumber }),
  };
  return {
    id: nextCommentId++,
    body: `<!-- factory-claim:v1 ${JSON.stringify(payload)} -->`,
    created_at: overrides.createdAt ?? CLAIM_CREATED_AT,
    user: overrides.user ?? ACTIONS_ACTOR,
  };
}

function assignmentEvents(issueNumber: number): TimelineEventFixture[] {
  return [
    {
      id: issueNumber * 10 + 1,
      event: "assigned",
      actor: ASSIGNMENT_ACTOR,
      assignee: COPILOT_ACTOR,
      created_at: ASSIGNED_AT,
    },
    {
      id: issueNumber * 10 + 2,
      event: "assigned",
      actor: ASSIGNMENT_ACTOR,
      assignee: ASSIGNMENT_ACTOR,
      created_at: ASSIGNED_AT,
    },
  ];
}

function assignmentAttestation(issueNumber: number): Comment {
  const evidence = {
    nonce: NONCE_FOR(issueNumber),
    assignedAt: ASSIGNED_AT,
    eventIds: assignmentEvents(issueNumber).map((event) => event.id),
    copilotNodeId: COPILOT_ACTOR.node_id,
    assignmentActorNodeId: ASSIGNMENT_ACTOR.node_id,
  };
  return {
    id: nextCommentId++,
    body: `<!-- factory-assignment:v1 ${JSON.stringify(evidence)} -->`,
    created_at: ASSIGNED_AT,
    user: ACTIONS_ACTOR,
  };
}

// Default `### Allowed paths` scope and matching default PR changed-file
// list, so every pre-existing test (which doesn't care about scope
// validation) keeps working unmodified. Tests that specifically exercise
// scope validation override `issue.body` and/or `filesByPull`.
const DEFAULT_ALLOWED_PATHS_BODY = "### Allowed paths\n\nsrc/app/**\n";
const DEFAULT_CHANGED_FILES: ChangedFileFixture[] = [{ filename: "src/app/example.ts", status: "modified" }];

function issueFixture(
  number: number,
  labelName: string,
  overrides: Partial<IssueFixture> = {},
): IssueFixture {
  const afterClaim = [
    "factory:implementing",
    "factory:pr-open",
    "factory:repairing",
    "factory:merged",
    "factory:deployed-dev",
  ].includes(labelName);
  const normalizedOverrides = { ...overrides };
  if (
    normalizedOverrides.assignees?.length === 1 &&
    normalizedOverrides.assignees[0].login === "copilot-swe-agent[bot]"
  ) {
    normalizedOverrides.assignees = VALID_ASSIGNEES;
  }
  return {
    number,
    state: "open",
    labels: [{ name: labelName }, { name: "risk:routine" }],
    assignees: afterClaim ? VALID_ASSIGNEES : [],
    comments: afterClaim
      ? [claimComment(number), assignmentAttestation(number)]
      : [claimComment(number)],
    body: DEFAULT_ALLOWED_PATHS_BODY,
    ...normalizedOverrides,
  };
}

function pullRequestFixture(
  number: number,
  issueNumber: number,
  overrides: Partial<PullRequestFixture> = {},
): PullRequestFixture {
  const nonce = NONCE_FOR(issueNumber);
  return {
    number,
    node_id: `pr-node-${number}`,
    html_url: `https://github.com/${repository}/pull/${number}`,
    title: "[ai-dev] Implement the ticket",
    body: `Implements the ticket.\n\n${reconciler.buildClaimNonceMarker(nonce)}\n${reconciler.buildRefsMarker(issueNumber)}\n`,
    draft: false,
    state: "open",
    merged_at: null,
    merge_commit_sha: null,
    auto_merge: null,
    user: COPILOT_ACTOR,
    labels: [],
    head: { sha: `sha-${number}`, ref: `ai-dev/${number}`, repo: { full_name: repository } },
    base: { ref: DEFAULT_BRANCH },
    ...overrides,
  };
}

interface TimelineEventFixture {
  id?: number;
  event: string;
  label?: { name: string };
  actor?: Partial<ActorFixture>;
  assignee?: Partial<ActorFixture>;
  created_at?: string;
}

const HUMAN_ACTIVE_TIMELINE_EVENT: TimelineEventFixture = {
  id: 1,
  event: "labeled",
  label: { name: "factory-mode:active" },
  actor: ASSIGNMENT_ACTOR,
  created_at: "2024-01-01T00:00:00.000Z",
};

interface HarnessOptions {
  issues?: IssueFixture[];
  pullRequests?: PullRequestFixture[];
  commitsByPull?: Record<number, CommitFixture[]>;
  checksBySha?: Record<string, CheckRunFixture[]>;
  statusesBySha?: Record<string, CommitStatusFixture[]>;
  deploymentsBySha?: Record<string, DeploymentFixture[]>;
  deploymentStatusesByDeployment?: Record<number, DeploymentStatusFixture[]>;
  // Changed files per pull number, for the `### Allowed paths` scope
  // invariant. Defaults to `DEFAULT_CHANGED_FILES` (which matches the
  // default issue's `DEFAULT_ALLOWED_PATHS_BODY`) for any pull not listed.
  filesByPull?: Record<number, ChangedFileFixture[]>;
  controlIssue?: { number: number; labels: Label[]; comments: Comment[] } | null;
  // Timeline events for the control issue's `factory-mode:active` human
  // authorization check. Defaults to a single human-applied event so every
  // other test (which only cares about the resolved mode) keeps working
  // without having to know about this check.
  controlIssueTimelineEvents?: TimelineEventFixture[];
  controlIssueTimelineFails?: boolean;
  assignmentTimelineByIssue?: Record<number, TimelineEventFixture[]>;
  assignmentTimelineSequenceByIssue?: Record<
    number,
    TimelineEventFixture[][]
  >;
  assignmentTimelineFailsFor?: number[];
  issueRereadAssigneesByIssue?: Record<number, ActorFixture[]>;
  copilotSuggestedActors?: unknown[];
  failIssueNumbers?: number[];
  defaultBranch?: string;
  now?: string;
}

function createHarness(options: HarnessOptions = {}) {
  const issues = new Map<number, IssueFixture>();
  for (const issue of options.issues ?? []) {
    issues.set(issue.number, issue);
  }
  const pulls = new Map<number, PullRequestFixture>();
  for (const pull of options.pullRequests ?? []) {
    pulls.set(pull.number, pull);
  }
  const commitsByPull = Object.fromEntries(
    Object.entries(options.commitsByPull ?? {}).map(([number, commits]) => [
      number,
      commits.map((commit) => {
        if (commit.author?.login === "copilot-swe-agent[bot]") {
          return { ...commit, author: COPILOT_ACTOR };
        }
        if (commit.author?.login === "github-actions[bot]") {
          return { ...commit, author: ACTIONS_ACTOR };
        }
        return commit;
      }),
    ]),
  );
  const filesByPull = options.filesByPull ?? {};
  const checksBySha = options.checksBySha ?? {};
  const statusesBySha = options.statusesBySha ?? {};
  const deploymentsBySha = options.deploymentsBySha ?? {};
  const deploymentStatusesByDeployment: Record<number, DeploymentStatusFixture[]> =
    options.deploymentStatusesByDeployment ?? {};
  let controlIssue =
    options.controlIssue === undefined
      ? {
          number: 9000,
          labels: [{ name: "factory-control" }, { name: "factory-mode:active" }],
          comments: [] as Comment[],
        }
      : options.controlIssue;
  const controlIssueTimelineEvents = options.controlIssueTimelineEvents ?? [HUMAN_ACTIVE_TIMELINE_EVENT];
  const controlIssueTimelineFails = options.controlIssueTimelineFails ?? false;
  const assignmentTimelineFailsFor = new Set(
    options.assignmentTimelineFailsFor ?? [],
  );
  const assignmentTimelineReadCount = new Map<number, number>();
  const failIssueNumbers = new Set(options.failIssueNumbers ?? []);
  const defaultBranch = options.defaultBranch ?? DEFAULT_BRANCH;

  function findEntity(issueNumber: number): { comments?: Comment[]; labels: Label[] } | undefined {
    if (issues.has(issueNumber)) return issues.get(issueNumber);
    if (pulls.has(issueNumber)) return pulls.get(issueNumber);
    if (controlIssue && controlIssue.number === issueNumber) return controlIssue;
    return undefined;
  }

  const repoGet = jest.fn(async () => ({ data: { default_branch: defaultBranch } }));

  const listForRepo = jest.fn();
  const listComments = jest.fn();
  const listPulls = jest.fn();
  const listCommits = jest.fn();
  const listFiles = jest.fn();
  const listForRef = jest.fn();
  const listCommitStatusesForRef = jest.fn();
  const listDeployments = jest.fn();
  const listDeploymentStatuses = jest.fn();
  const listEventsForTimeline = jest.fn();
  const getIssue = jest.fn(async (params: ApiParams) => {
    const issue = issues.get(params.issue_number ?? -1);
    if (!issue) {
      throw new Error("Issue not found");
    }
    return {
      data: {
        ...issue,
        assignees:
          options.issueRereadAssigneesByIssue?.[
            params.issue_number ?? -1
          ] ?? issue.assignees,
      },
    };
  });

  const paginate = jest.fn(async (method: unknown, params: ApiParams): Promise<unknown[]> => {
    if (method === listForRepo) {
      if (params.labels === "factory-control") {
        return controlIssue ? [controlIssue] : [];
      }
      const label = params.labels as string;
      return [...issues.values()].filter(
        (issue) => issue.state === "open" && issue.labels.some((l) => l.name === label),
      );
    }
    if (method === listEventsForTimeline) {
      if (controlIssue && params.issue_number === controlIssue.number) {
        if (controlIssueTimelineFails) {
          throw new Error("simulated timeline read failure");
        }
        return controlIssueTimelineEvents;
      }
      const issueNumber = params.issue_number ?? -1;
      if (assignmentTimelineFailsFor.has(issueNumber)) {
        throw new Error("simulated assignment timeline read failure");
      }
      const sequence =
        options.assignmentTimelineSequenceByIssue?.[issueNumber];
      if (sequence) {
        const readCount = assignmentTimelineReadCount.get(issueNumber) ?? 0;
        assignmentTimelineReadCount.set(issueNumber, readCount + 1);
        return sequence[Math.min(readCount, sequence.length - 1)];
      }
      return (
        options.assignmentTimelineByIssue?.[issueNumber] ??
        assignmentEvents(issueNumber)
      );
    }
    if (method === listComments) {
      const issueNumber = params.issue_number ?? -1;
      if (failIssueNumbers.has(issueNumber)) {
        throw new Error(`simulated comment-listing failure for issue #${issueNumber}`);
      }
      const entity = findEntity(issueNumber);
      return entity ? entity.comments ?? [] : [];
    }
    if (method === listPulls) {
      return [...pulls.values()];
    }
    if (method === listCommits) {
      return commitsByPull[params.pull_number ?? -1] ?? [];
    }
    if (method === listFiles) {
      return filesByPull[params.pull_number ?? -1] ?? DEFAULT_CHANGED_FILES;
    }
    if (method === listForRef) {
      return checksBySha[params.ref ?? ""] ?? [];
    }
    if (method === listCommitStatusesForRef) {
      return statusesBySha[params.ref ?? ""] ?? [];
    }
    if (method === listDeployments) {
      return deploymentsBySha[params.sha ?? ""] ?? [];
    }
    if (method === listDeploymentStatuses) {
      return deploymentStatusesByDeployment[params.deployment_id ?? -1] ?? [];
    }
    throw new Error("Unexpected paginated method in test harness");
  });

  const addLabels = jest.fn(async (params: ApiParams) => {
    const entity = findEntity(params.issue_number ?? -1);
    if (!entity) return {};
    const present = new Set(entity.labels.map((l) => l.name));
    for (const name of (params.labels as string[]) ?? []) {
      if (!present.has(name)) {
        entity.labels.push({ name });
        present.add(name);
      }
    }
    return {};
  });

  const removeLabel = jest.fn(async (params: ApiParams) => {
    const entity = findEntity(params.issue_number ?? -1);
    const name = params.name as string;
    const index = entity ? entity.labels.findIndex((l) => l.name === name) : -1;
    if (!entity || index === -1) {
      const error = new Error("Label does not exist") as Error & { status?: number };
      error.status = 404;
      throw error;
    }
    entity.labels.splice(index, 1);
    return {};
  });

  const createComment = jest.fn(async (params: ApiParams) => {
    const entity = findEntity(params.issue_number ?? -1);
    const comment = {
      id: nextCommentId++,
      body: params.body ?? "",
      created_at: DEFAULT_NOW,
      user: ACTIONS_ACTOR,
    };
    if (entity && entity.comments) entity.comments.push(comment);
    return { data: comment };
  });

  const updateComment = jest.fn(async (params: ApiParams) => {
    const allComments = [
      ...[...issues.values()].flatMap((issue) => issue.comments),
      ...(controlIssue ? controlIssue.comments : []),
    ];
    const target = allComments.find((comment) => comment.id === params.comment_id);
    if (target) target.body = params.body ?? target.body;
    return {};
  });

  const updateIssue = jest.fn(async (params: ApiParams) => {
    const issue = issues.get(params.issue_number ?? -1);
    if (issue) {
      issue.state = (params.state as "open" | "closed") ?? issue.state;
      issue.state_reason = params.state_reason;
    }
    return {};
  });

  const graphql = jest.fn(async (query: string, variables: { pullRequestId?: string }) => {
    if (query.includes("ResolveCopilotSuggestedActor")) {
      return {
        repository: {
          suggestedActors: {
            nodes: options.copilotSuggestedActors ?? [
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
    }
    const pull = [...pulls.values()].find((p) => p.node_id === variables.pullRequestId);
    if (pull) {
      pull.auto_merge = { enabledBy: { login: "github-actions[bot]" } };
    }
    return {};
  });

  const core = {
    info: jest.fn(),
    warning: jest.fn(),
  };

  const github = {
    paginate,
    graphql,
    rest: {
      repos: {
        get: repoGet,
        listCommitStatusesForRef,
        listDeployments,
        listDeploymentStatuses,
      },
      issues: {
        listForRepo,
        listComments,
        listEventsForTimeline,
        get: getIssue,
        addLabels,
        removeLabel,
        createComment,
        updateComment,
        update: updateIssue,
      },
      pulls: {
        list: listPulls,
        listCommits,
        listFiles,
      },
      checks: {
        listForRef,
      },
    },
  };

  return {
    core,
    github,
    issues,
    pulls,
    getControlIssue: () => controlIssue,
    mocks: {
      addLabels,
      removeLabel,
      createComment,
      updateComment,
      updateIssue,
      graphql,
      repoGet,
      paginate,
      listEventsForTimeline,
      listFiles,
    },
  };
}

async function reconcile(options: HarnessOptions = {}) {
  const harness = createHarness(options);
  await reconcileFactoryLifecycle({
    github: harness.github,
    context: { repo: { owner, repo } },
    core: harness.core,
    now: options.now ?? DEFAULT_NOW,
    assignmentActorNodeId: ASSIGNMENT_ACTOR.node_id,
  });
  return harness;
}

function labelsOf(entity: { labels: Label[] } | undefined): string[] {
  return entity ? entity.labels.map((l) => l.name) : [];
}

function autoMergeCalls(graphql: jest.Mock): unknown[][] {
  return graphql.mock.calls.filter(
    ([, variables]) => variables && variables.pullRequestId,
  );
}

describe("agentic lifecycle reconciler factory-mode gate", () => {
  it("performs no mutations and logs an advisory when the control issue is missing", async () => {
    const issue = issueFixture(70, "factory:claimed", {
      assignees: [{ login: "copilot-swe-agent[bot]" }],
    });
    const harness = await reconcile({ issues: [issue], controlIssue: null });

    expect(labelsOf(harness.issues.get(70))).toEqual(["factory:claimed", "risk:routine"]);
    expect(harness.mocks.addLabels).not.toHaveBeenCalled();
    expect(harness.mocks.removeLabel).not.toHaveBeenCalled();
    expect(harness.mocks.createComment).not.toHaveBeenCalled();
    expect(autoMergeCalls(harness.mocks.graphql)).toHaveLength(0);
    expect(harness.mocks.updateIssue).not.toHaveBeenCalled();
    expect(harness.core.info).toHaveBeenCalledWith(
      expect.stringContaining("Factory mode is 'paused'"),
    );
  });

  it("performs no mutations in shadow mode", async () => {
    const issue = issueFixture(71, "factory:claimed", {
      assignees: [{ login: "copilot-swe-agent[bot]" }],
    });
    const harness = await reconcile({
      issues: [issue],
      controlIssue: {
        number: 9002,
        labels: [{ name: "factory-control" }, { name: "factory-mode:shadow" }],
        comments: [],
      },
    });

    expect(labelsOf(harness.issues.get(71))).toEqual(["factory:claimed", "risk:routine"]);
    expect(harness.mocks.addLabels).not.toHaveBeenCalled();
    expect(harness.mocks.createComment).not.toHaveBeenCalled();
    expect(harness.core.info).toHaveBeenCalledWith(
      expect.stringContaining("Factory mode is 'shadow'"),
    );
  });

  it("performs no mutations in paused mode", async () => {
    const issue = issueFixture(72, "factory:pr-open");
    const pull = pullRequestFixture(160, 72);
    const harness = await reconcile({
      issues: [issue],
      pullRequests: [pull],
      controlIssue: {
        number: 9003,
        labels: [{ name: "factory-control" }, { name: "factory-mode:paused" }],
        comments: [],
      },
    });

    expect(labelsOf(harness.issues.get(72))).toEqual(["factory:pr-open", "risk:routine"]);
    expect(harness.mocks.addLabels).not.toHaveBeenCalled();
    expect(autoMergeCalls(harness.mocks.graphql)).toHaveLength(0);
    expect(harness.core.info).toHaveBeenCalledWith(
      expect.stringContaining("Factory mode is 'paused'"),
    );
  });

  it("performs no mutations when the control issue carries conflicting mode labels", async () => {
    const issue = issueFixture(73, "factory:claimed", {
      assignees: [{ login: "copilot-swe-agent[bot]" }],
    });
    const harness = await reconcile({
      issues: [issue],
      controlIssue: {
        number: 9004,
        labels: [
          { name: "factory-control" },
          { name: "factory-mode:active" },
          { name: "factory-mode:shadow" },
        ],
        comments: [],
      },
    });

    expect(labelsOf(harness.issues.get(73))).toEqual(["factory:claimed", "risk:routine"]);
    expect(harness.mocks.addLabels).not.toHaveBeenCalled();
    expect(harness.core.info).toHaveBeenCalledWith(
      expect.stringContaining("Factory mode is 'paused'"),
    );
  });

  it("still reconciles normally when the control issue is exactly active", async () => {
    const issue = issueFixture(74, "factory:claimed", {
      assignees: [{ login: "copilot-swe-agent[bot]" }],
    });
    const harness = await reconcile({ issues: [issue] });

    expect(labelsOf(harness.issues.get(74))).toContain("factory:implementing");
  });

  it("performs no mutations when factory-mode:active was most-recently applied by a bot, not a human", async () => {
    const issue = issueFixture(79, "factory:claimed", {
      assignees: [{ login: "copilot-swe-agent[bot]" }],
    });
    const harness = await reconcile({
      issues: [issue],
      controlIssueTimelineEvents: [
        {
          event: "labeled",
          label: { name: "factory-mode:active" },
          actor: { type: "Bot", login: "github-actions[bot]" },
          created_at: "2024-01-01T00:00:00.000Z",
        },
      ],
    });

    expect(labelsOf(harness.issues.get(79))).toEqual(["factory:claimed", "risk:routine"]);
    expect(harness.mocks.addLabels).not.toHaveBeenCalled();
    expect(harness.mocks.createComment).not.toHaveBeenCalled();
    expect(harness.core.warning).toHaveBeenCalledWith(
      expect.stringContaining("was not most-recently applied by a human user"),
    );
  });

  it("performs no mutations when no labeled timeline event exists for factory-mode:active at all", async () => {
    const issue = issueFixture(80, "factory:claimed", {
      assignees: [{ login: "copilot-swe-agent[bot]" }],
    });
    const harness = await reconcile({
      issues: [issue],
      controlIssueTimelineEvents: [
        { event: "labeled", label: { name: "risk:routine" }, actor: { type: "User" } },
      ],
    });

    expect(labelsOf(harness.issues.get(80))).toEqual(["factory:claimed", "risk:routine"]);
    expect(harness.mocks.addLabels).not.toHaveBeenCalled();
  });

  it("performs no mutations when the control issue's timeline cannot be read", async () => {
    const issue = issueFixture(81, "factory:claimed", {
      assignees: [{ login: "copilot-swe-agent[bot]" }],
    });
    const harness = await reconcile({ issues: [issue], controlIssueTimelineFails: true });

    expect(labelsOf(harness.issues.get(81))).toEqual(["factory:claimed", "risk:routine"]);
    expect(harness.mocks.addLabels).not.toHaveBeenCalled();
    expect(harness.mocks.createComment).not.toHaveBeenCalled();
    expect(harness.core.warning).toHaveBeenCalledWith(
      expect.stringContaining("Could not resolve factory mode"),
    );
  });

  it("uses only the most recent factory-mode:active labeling event when it was re-applied over time", async () => {
    const issue = issueFixture(82, "factory:claimed", {
      assignees: [{ login: "copilot-swe-agent[bot]" }],
    });

    // Human-applied first, then most recently re-applied by a bot: must
    // resolve to paused because the *latest* event governs, not the first.
    const harnessBotWinsLatest = await reconcile({
      issues: [issue],
      controlIssueTimelineEvents: [
        {
          event: "labeled",
          label: { name: "factory-mode:active" },
          actor: { type: "User" },
          created_at: "2024-01-01T00:00:00.000Z",
        },
        {
          event: "labeled",
          label: { name: "factory-mode:active" },
          actor: { type: "Bot" },
          created_at: "2024-06-01T00:00:00.000Z",
        },
      ],
    });
    expect(labelsOf(harnessBotWinsLatest.issues.get(82))).toEqual(["factory:claimed", "risk:routine"]);

    // Bot-applied first, then most recently re-applied by a human: must
    // resolve to active.
    const issue2 = issueFixture(83, "factory:claimed", {
      assignees: [{ login: "copilot-swe-agent[bot]" }],
    });
    const harnessHumanWinsLatest = await reconcile({
      issues: [issue2],
      controlIssueTimelineEvents: [
        {
          event: "labeled",
          label: { name: "factory-mode:active" },
          actor: { type: "Bot" },
          created_at: "2024-01-01T00:00:00.000Z",
        },
        {
          event: "labeled",
          label: { name: "factory-mode:active" },
          actor: { type: "User" },
          created_at: "2024-06-01T00:00:00.000Z",
        },
      ],
    });
    expect(labelsOf(harnessHumanWinsLatest.issues.get(83))).toContain("factory:implementing");
  });

  it("directly: resolveFactoryMode fails closed to paused on every non-human-active scenario", async () => {
    const botApplied = createHarness({
      controlIssueTimelineEvents: [
        {
          event: "labeled",
          label: { name: "factory-mode:active" },
          actor: { type: "Bot" },
          created_at: "2024-01-01T00:00:00.000Z",
        },
      ],
    });
    await expect(
      reconciler.resolveFactoryMode({ github: botApplied.github, core: botApplied.core, owner, repo }),
    ).resolves.toBe("paused");

    const noEvent = createHarness({ controlIssueTimelineEvents: [] });
    await expect(
      reconciler.resolveFactoryMode({ github: noEvent.github, core: noEvent.core, owner, repo }),
    ).resolves.toBe("paused");

    const timelineFailure = createHarness({ controlIssueTimelineFails: true });
    await expect(
      reconciler.resolveFactoryMode({
        github: timelineFailure.github,
        core: timelineFailure.core,
        owner,
        repo,
      }),
    ).resolves.toBe("paused");

    const humanApplied = createHarness({});
    await expect(
      reconciler.resolveFactoryMode({ github: humanApplied.github, core: humanApplied.core, owner, repo }),
    ).resolves.toBe("active");
  });
});

describe("agentic lifecycle reconciler integration", () => {
  it("fails closed to blocked when an issue past the queue has no claim comment at all", async () => {
    const issue = issueFixture(1, "factory:claimed", { comments: [] });
    const harness = await reconcile({ issues: [issue] });

    expect(labelsOf(harness.issues.get(1))).toContain("blocked");
    expect(labelsOf(harness.issues.get(1))).not.toContain("factory:claimed");
    expect(harness.mocks.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 1,
        body: expect.stringContaining("missing-trusted-claim"),
      }),
    );
  });

  it("fails closed to blocked when the claim marker payload is malformed JSON", async () => {
    const issue = issueFixture(2, "factory:claimed", {
      comments: [
        {
          id: nextCommentId++,
          body: "<!-- factory-claim:v1 {not-json} -->",
          created_at: CLAIM_CREATED_AT,
          user: ACTIONS_ACTOR,
        },
      ],
    });
    const harness = await reconcile({ issues: [issue] });

    expect(labelsOf(harness.issues.get(2))).toEqual(
      expect.arrayContaining(["blocked", "risk:routine"]),
    );
    expect(harness.mocks.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("malformed-claim"),
      }),
    );
  });

  it("transitions the observed User plus Copilot Bot assignment pair to implementing", async () => {
    const issue = issueFixture(3, "factory:claimed", {
      assignees: VALID_ASSIGNEES,
    });
    const harness = await reconcile({ issues: [issue] });

    expect(labelsOf(harness.issues.get(3))).toContain("factory:implementing");
    expect(labelsOf(harness.issues.get(3))).not.toContain("factory:claimed");
    expect(harness.mocks.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 3,
        body: expect.stringContaining("factory:claimed -> factory:implementing"),
      }),
    );
    expect(harness.mocks.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 3,
        body: expect.stringContaining("factory-assignment:v1"),
      }),
    );
  });

  it("accepts a changed REST display login only when stable Copilot IDs match", async () => {
    const issue = issueFixture(4, "factory:claimed", {
      assignees: [
        ASSIGNMENT_ACTOR,
        { ...COPILOT_ACTOR, login: "Renamed Copilot" },
      ],
    });
    const timeline = assignmentEvents(4).map((event) =>
      event.assignee?.node_id === COPILOT_ACTOR.node_id
        ? {
            ...event,
            assignee: { ...COPILOT_ACTOR, login: "Renamed Copilot" },
          }
        : event,
    );
    const harness = await reconcile({
      issues: [issue],
      assignmentTimelineByIssue: { 4: timeline },
    });

    expect(labelsOf(harness.issues.get(4))).toContain("factory:implementing");
  });

  it("accepts the authorized assignment pair with bounded timestamp skew", async () => {
    const issue = issueFixture(47, "factory:claimed", {
      assignees: VALID_ASSIGNEES,
    });
    const skewed = assignmentEvents(47).map((event, index) => ({
      ...event,
      created_at:
        index === 0
          ? ASSIGNED_AT
          : "2026-08-20T20:51:32.000Z",
    }));
    const harness = await reconcile({
      issues: [issue],
      assignmentTimelineByIssue: { 47: skewed },
    });
    expect(labelsOf(harness.issues.get(47))).toContain(
      "factory:implementing",
    );
  });

  it("reuses an exact same-nonce assignment attestation after an interrupted transition", async () => {
    const issue = issueFixture(48, "factory:claimed", {
      assignees: VALID_ASSIGNEES,
      comments: [claimComment(48), assignmentAttestation(48)],
    });
    const harness = await reconcile({ issues: [issue] });
    expect(labelsOf(harness.issues.get(48))).toContain(
      "factory:implementing",
    );
    const assignmentComments = harness.mocks.createComment.mock.calls.filter(
      ([params]) =>
        typeof params.body === "string" &&
        params.body.includes("factory-assignment:v1"),
    );
    expect(assignmentComments).toHaveLength(0);
  });

  it("invalidates downstream authority after a later assignment mutation", async () => {
    const issue = issueFixture(49, "factory:implementing");
    const laterMutation = {
      id: 499,
      event: "unassigned",
      actor: ASSIGNMENT_ACTOR,
      assignee: ASSIGNMENT_ACTOR,
      created_at: "2026-08-20T21:10:00.000Z",
    };
    const harness = await reconcile({
      issues: [issue],
      pullRequests: [],
      assignmentTimelineByIssue: {
        49: [...assignmentEvents(49), laterMutation],
      },
      now: "2026-08-20T21:15:00.000Z",
    });
    expect(labelsOf(harness.issues.get(49))).toContain("blocked");
    expect(labelsOf(harness.getControlIssue() ?? undefined)).toContain(
      "factory-mode:paused",
    );
  });

  it("fails closed when the current Copilot login matches but its stable ID does not", async () => {
    const issue = issueFixture(40, "factory:claimed", {
      assignees: [
        ASSIGNMENT_ACTOR,
        { ...COPILOT_ACTOR, id: 999, node_id: "BOT_wrong" },
      ],
    });
    const harness = await reconcile({ issues: [issue] });
    expect(labelsOf(harness.issues.get(40))).toContain("blocked");
    expect(labelsOf(harness.getControlIssue() ?? undefined)).toContain(
      "factory-mode:paused",
    );
  });

  it("fails closed when an extra assignee appears beside the authorized pair", async () => {
    const issue = issueFixture(41, "factory:claimed", {
      assignees: [
        ...VALID_ASSIGNEES,
        {
          login: "other-user",
          type: "User",
          id: 77,
          node_id: "U_other",
        },
      ],
    });
    const harness = await reconcile({ issues: [issue] });
    expect(labelsOf(harness.issues.get(41))).toContain("blocked");
    expect(labelsOf(harness.getControlIssue() ?? undefined)).toContain(
      "factory-mode:paused",
    );
  });

  it("rejects assignment events at the exact claim expiry boundary", async () => {
    const issue = issueFixture(42, "factory:claimed", {
      assignees: VALID_ASSIGNEES,
    });
    const atExpiry = assignmentEvents(42).map((event) => ({
      ...event,
      created_at: CLAIM_EXPIRES_AT,
    }));
    const harness = await reconcile({
      issues: [issue],
      assignmentTimelineByIssue: { 42: atExpiry },
      now: "2026-08-20T21:00:00.000Z",
    });
    expect(labelsOf(harness.issues.get(42))).toContain("blocked");
  });

  it("ignores an untrusted future claim marker instead of letting it replace the trusted claim", async () => {
    const issue = issueFixture(43, "factory:claimed", {
      assignees: VALID_ASSIGNEES,
    });
    issue.comments.push({
      id: nextCommentId++,
      body: `<!-- factory-claim:v1 ${JSON.stringify({
        nonce: "99999999999:1:43",
        owner: "queue-controller:99999999999:1",
        issueNumber: 43,
        expiresAt: "2099-01-01T01:00:00.000Z",
      })} -->`,
      created_at: "2099-01-01T00:00:00.000Z",
      user: {
        login: "malicious-user",
        type: "User",
        id: 123,
        node_id: "U_malicious",
      },
    });
    const harness = await reconcile({ issues: [issue] });
    expect(labelsOf(harness.issues.get(43))).toContain(
      "factory:implementing",
    );
  });

  it("pauses and aborts the pass when the canonical Copilot actor cannot be resolved", async () => {
    const issue = issueFixture(44, "factory:claimed", {
      assignees: VALID_ASSIGNEES,
    });
    const harness = createHarness({
      issues: [issue],
      copilotSuggestedActors: [],
    });
    await expect(
      reconcileFactoryLifecycle({
        github: harness.github,
        context: { repo: { owner, repo } },
        core: harness.core,
        now: DEFAULT_NOW,
        assignmentActorNodeId: ASSIGNMENT_ACTOR.node_id,
      }),
    ).rejects.toThrow("Canonical Copilot identity");
    expect(labelsOf(harness.issues.get(44))).toContain("factory:claimed");
    expect(labelsOf(harness.getControlIssue() ?? undefined)).toContain(
      "factory-mode:paused",
    );
  });

  it("pauses and aborts the pass when the assignment timeline cannot be read", async () => {
    const issue = issueFixture(45, "factory:claimed", {
      assignees: VALID_ASSIGNEES,
    });
    const harness = createHarness({
      issues: [issue],
      assignmentTimelineFailsFor: [45],
    });
    await expect(
      reconcileFactoryLifecycle({
        github: harness.github,
        context: { repo: { owner, repo } },
        core: harness.core,
        now: DEFAULT_NOW,
        assignmentActorNodeId: ASSIGNMENT_ACTOR.node_id,
      }),
    ).rejects.toThrow("assignment timeline");
    expect(labelsOf(harness.issues.get(45))).toContain("factory:claimed");
    expect(labelsOf(harness.getControlIssue() ?? undefined)).toContain(
      "factory-mode:paused",
    );
  });

  it("blocks and pauses when assignees change during the final pre-transition re-read", async () => {
    const issue = issueFixture(46, "factory:claimed", {
      assignees: VALID_ASSIGNEES,
    });
    const harness = await reconcile({
      issues: [issue],
      issueRereadAssigneesByIssue: {
        46: [COPILOT_ACTOR],
      },
    });
    expect(labelsOf(harness.issues.get(46))).toContain("blocked");
    expect(harness.mocks.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining(
          "assignment-changed-before-transition",
        ),
      }),
    );
    expect(labelsOf(harness.getControlIssue() ?? undefined)).toContain(
      "factory-mode:paused",
    );
  });

  it("blocks an unassign-reassign ABA mutation detected by the final timeline watermark", async () => {
    const issue = issueFixture(50, "factory:claimed", {
      assignees: VALID_ASSIGNEES,
    });
    const base = assignmentEvents(50);
    const churned = [
      ...base,
      {
        id: 503,
        event: "unassigned",
        actor: ASSIGNMENT_ACTOR,
        assignee: ASSIGNMENT_ACTOR,
        created_at: "2026-08-20T20:51:33.000Z",
      },
      {
        id: 504,
        event: "assigned",
        actor: ASSIGNMENT_ACTOR,
        assignee: ASSIGNMENT_ACTOR,
        created_at: "2026-08-20T20:51:34.000Z",
      },
    ];
    const harness = await reconcile({
      issues: [issue],
      assignmentTimelineSequenceByIssue: {
        50: [base, base, churned],
      },
    });
    expect(labelsOf(harness.issues.get(50))).toContain("blocked");
    expect(labelsOf(harness.getControlIssue() ?? undefined)).toContain(
      "factory-mode:paused",
    );
  });

  it("leaves an unassigned claim unchanged", async () => {
    const issue = issueFixture(5, "factory:claimed", { assignees: [] });
    const harness = await reconcile({ issues: [issue] });

    expect(labelsOf(harness.issues.get(5))).toEqual(["factory:claimed", "risk:routine"]);
    expect(harness.mocks.addLabels).not.toHaveBeenCalled();
    expect(harness.mocks.createComment).not.toHaveBeenCalled();
  });

  it("leaves an unassigned claim unchanged when expiresAt is still in the future relative to an injected now", async () => {
    const issue = issueFixture(86, "factory:claimed", {
      assignees: [],
      comments: [
        claimComment(86, {
          createdAt: "2024-05-31T23:00:00.000Z",
          expiresAt: "2024-06-01T00:10:00.000Z",
        }),
      ],
    });
    const harness = await reconcile({
      issues: [issue],
      now: "2024-06-01T00:00:00.000Z",
      assignmentTimelineByIssue: { 86: [] },
    });

    expect(labelsOf(harness.issues.get(86))).toEqual(["factory:claimed", "risk:routine"]);
    expect(harness.mocks.addLabels).not.toHaveBeenCalled();
    expect(harness.mocks.createComment).not.toHaveBeenCalled();
    expect(labelsOf(harness.getControlIssue() ?? undefined)).toContain("factory-mode:active");
  });

  it("transitions a stale, unassigned claim to blocked with stale-claim-without-assignment and best-effort pauses the factory", async () => {
    const issue = issueFixture(87, "factory:claimed", {
      assignees: [],
      comments: [
        claimComment(87, {
          createdAt: "2024-05-31T22:00:00.000Z",
          expiresAt: "2024-06-01T00:00:00.000Z",
        }),
      ],
    });
    const harness = await reconcile({
      issues: [issue],
      now: "2024-06-01T00:10:00.000Z",
      assignmentTimelineByIssue: { 87: [] },
    });

    expect(labelsOf(harness.issues.get(87))).toContain("blocked");
    expect(labelsOf(harness.issues.get(87))).not.toContain("factory:claimed");
    expect(harness.mocks.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 87,
        body: expect.stringContaining("assignment-evidence-expired"),
      }),
    );
    // A stale, unassigned lease is a queue/lease integrity failure, not an
    // ordinary item failure: the factory must be paused too, never
    // silently renewed/requeued.
    expect(labelsOf(harness.getControlIssue() ?? undefined)).toContain("factory-mode:paused");
    expect(labelsOf(harness.getControlIssue() ?? undefined)).not.toContain("factory-mode:active");
  });

  it("treats an expiresAt exactly equal to now as expired (at/past now)", async () => {
    const issue = issueFixture(88, "factory:claimed", {
      assignees: [],
      comments: [
        claimComment(88, {
          createdAt: "2024-05-31T22:00:00.000Z",
          expiresAt: "2024-06-01T00:00:00.000Z",
        }),
      ],
    });
    const harness = await reconcile({
      issues: [issue],
      now: "2024-06-01T00:00:00.000Z",
      assignmentTimelineByIssue: { 88: [] },
    });

    expect(labelsOf(harness.issues.get(88))).toContain("blocked");
    expect(labelsOf(harness.getControlIssue() ?? undefined)).toContain("factory-mode:paused");
  });

  it("does not treat an assigned claim as stale even past its original expiresAt: assigned/implementing work continues", async () => {
    const issue = issueFixture(89, "factory:claimed", {
      assignees: [{ login: "copilot-swe-agent[bot]" }],
      comments: [
        claimComment(89, {
          createdAt: "2024-05-31T22:00:00.000Z",
          expiresAt: "2024-06-01T00:00:00.000Z",
        }),
      ],
    });
    const historicalPair = assignmentEvents(89).map((event) => ({
      ...event,
      created_at: "2024-05-31T23:59:00.000Z",
    }));
    const harness = await reconcile({
      issues: [issue],
      now: "2024-06-01T00:10:00.000Z",
      assignmentTimelineByIssue: { 89: historicalPair },
    });

    expect(labelsOf(harness.issues.get(89))).toContain("factory:implementing");
    expect(labelsOf(harness.issues.get(89))).not.toContain("blocked");
    // No spurious pause: the claim expiring after assignment is expected
    // and does not signal queue/lease corruption.
    expect(labelsOf(harness.getControlIssue() ?? undefined)).toContain("factory-mode:active");
  });

  it("blocks a claim assigned to an unknown, undocumented assignee", async () => {
    const issue = issueFixture(6, "factory:claimed", {
      assignees: [{ login: "some-random-human" }],
    });
    const harness = await reconcile({ issues: [issue] });

    expect(labelsOf(harness.issues.get(6))).toContain("blocked");
    expect(harness.mocks.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("unexpected-current-assignee"),
      }),
    );
  });

  it("stays in factory:implementing when zero correlated pull requests exist yet", async () => {
    const issue = issueFixture(7, "factory:implementing");
    const harness = await reconcile({ issues: [issue], pullRequests: [] });

    expect(labelsOf(harness.issues.get(7))).toEqual(["factory:implementing", "risk:routine"]);
    expect(harness.mocks.addLabels).not.toHaveBeenCalled();
  });

  it("correlates exactly one valid pull request, enrolls it, and opens factory:pr-open", async () => {
    const issue = issueFixture(8, "factory:implementing");
    const pull = pullRequestFixture(101, 8);
    const harness = await reconcile({
      issues: [issue],
      pullRequests: [pull],
      now: DEFAULT_NOW,
    });

    expect(labelsOf(harness.issues.get(8))).toContain("factory:pr-open");
    expect(labelsOf(harness.pulls.get(101))).toEqual(
      expect.arrayContaining(["agentic-factory", "agentic-automerge", "needs-ai-review", "risk:routine"]),
    );
    expect(autoMergeCalls(harness.mocks.graphql)).toHaveLength(0);
  });

  describe("Allowed paths scope invariant", () => {
    it("enrolls when every changed file exactly matches an allowed-paths entry", async () => {
      const issue = issueFixture(90, "factory:implementing", {
        body: "### Allowed paths\n\nsrc/app/example.ts\ndocs/readme.md\n",
      });
      const pull = pullRequestFixture(190, 90);
      const harness = await reconcile({
        issues: [issue],
        pullRequests: [pull],
        filesByPull: {
          190: [
            { filename: "src/app/example.ts", status: "modified" },
            { filename: "docs/readme.md", status: "added" },
          ],
        },
      });

      expect(labelsOf(harness.issues.get(90))).toContain("factory:pr-open");
      expect(labelsOf(harness.getControlIssue() ?? undefined)).toContain("factory-mode:active");
    });

    it("enrolls when every changed file matches a terminal path/** glob", async () => {
      const issue = issueFixture(91, "factory:implementing", {
        body: "### Allowed paths\n\nsrc/app/**\n",
      });
      const pull = pullRequestFixture(191, 91);
      const harness = await reconcile({
        issues: [issue],
        pullRequests: [pull],
        filesByPull: {
          191: [
            { filename: "src/app/nested/deep/file.ts", status: "added" },
            { filename: "src/app/example.ts", status: "modified" },
          ],
        },
      });

      expect(labelsOf(harness.issues.get(91))).toContain("factory:pr-open");
    });

    it("blocks and best-effort pauses the factory when a changed file escapes the declared allowed-paths scope", async () => {
      const issue = issueFixture(92, "factory:implementing", {
        body: "### Allowed paths\n\nsrc/app/**\n",
      });
      const pull = pullRequestFixture(192, 92);
      const harness = await reconcile({
        issues: [issue],
        pullRequests: [pull],
        filesByPull: {
          192: [
            { filename: "src/app/example.ts", status: "modified" },
            { filename: "src/lib/unexpected.ts", status: "added" },
          ],
        },
      });

      expect(labelsOf(harness.issues.get(92))).toContain("blocked");
      expect(labelsOf(harness.issues.get(92))).not.toContain("factory:pr-open");
      expect(harness.mocks.createComment).toHaveBeenCalledWith(
        expect.objectContaining({ body: expect.stringContaining("changed-files-outside-allowed-paths") }),
      );
      // Scope escape is a provenance/scope invariant violation, not an
      // ordinary item failure: the factory must be paused too.
      expect(labelsOf(harness.getControlIssue() ?? undefined)).toContain("factory-mode:paused");
      // Never trust title/author/enrollment: no labels were ever applied.
      expect(labelsOf(harness.pulls.get(192))).toEqual([]);
      expect(autoMergeCalls(harness.mocks.graphql)).toHaveLength(0);
    });

    it("blocks and best-effort pauses the factory when a file is renamed FROM outside the declared scope", async () => {
      const issue = issueFixture(93, "factory:implementing", {
        body: "### Allowed paths\n\nsrc/app/**\n",
      });
      const pull = pullRequestFixture(193, 93);
      const harness = await reconcile({
        issues: [issue],
        pullRequests: [pull],
        filesByPull: {
          193: [
            {
              filename: "src/app/renamed.ts",
              status: "renamed",
              previous_filename: "src/legacy/renamed.ts",
            },
          ],
        },
      });

      expect(labelsOf(harness.issues.get(93))).toContain("blocked");
      expect(harness.mocks.createComment).toHaveBeenCalledWith(
        expect.objectContaining({ body: expect.stringContaining("changed-files-outside-allowed-paths") }),
      );
      expect(labelsOf(harness.getControlIssue() ?? undefined)).toContain("factory-mode:paused");
    });

    it("blocks and best-effort pauses the factory when the Allowed paths section is missing entirely", async () => {
      const issue = issueFixture(94, "factory:implementing", { body: "no allowed-paths section here" });
      const pull = pullRequestFixture(194, 94);
      const harness = await reconcile({
        issues: [issue],
        pullRequests: [pull],
        now: DEFAULT_NOW,
      });

      expect(labelsOf(harness.issues.get(94))).toContain("blocked");
      expect(harness.mocks.createComment).toHaveBeenCalledWith(
        expect.objectContaining({ body: expect.stringContaining("invalid-allowed-paths:allowed-paths-not-string") }),
      );
      expect(labelsOf(harness.getControlIssue() ?? undefined)).toContain("factory-mode:paused");
    });

    it("fails closed and best-effort pauses the factory when Allowed paths appears more than once (ambiguous), matching the PR provenance parser's exactly-one convention", async () => {
      const issue = issueFixture(97, "factory:implementing", {
        // Two "### Allowed paths" sections in the same issue-form body: which
        // one is authoritative is genuinely ambiguous, so this must fail
        // closed exactly like a missing section -- never guess by picking
        // the first/last/most-permissive one. This mirrors
        // The shared implementation-reference parser
        // provenance parser, which likewise treats anything other than
        // exactly one match as invalid (0 or >1 are both rejected).
        body: "### Allowed paths\n\nsrc/app/**\n\n### Allowed paths\n\ndocs/**\n",
      });
      const pull = pullRequestFixture(197, 97);
      const harness = await reconcile({ issues: [issue], pullRequests: [pull] });

      expect(labelsOf(harness.issues.get(97))).toContain("blocked");
      expect(labelsOf(harness.issues.get(97))).not.toContain("factory:pr-open");
      expect(harness.mocks.createComment).toHaveBeenCalledWith(
        expect.objectContaining({ body: expect.stringContaining("invalid-allowed-paths:allowed-paths-not-string") }),
      );
      expect(labelsOf(harness.getControlIssue() ?? undefined)).toContain("factory-mode:paused");
      expect(labelsOf(harness.pulls.get(197))).toEqual([]);
      expect(autoMergeCalls(harness.mocks.graphql)).toHaveLength(0);
    });

    it("blocks and best-effort pauses the factory when the Allowed paths section contains a malformed pattern", async () => {
      const issue = issueFixture(95, "factory:implementing", {
        body: "### Allowed paths\n\n/etc/passwd\n",
      });
      const pull = pullRequestFixture(195, 95);
      const harness = await reconcile({ issues: [issue], pullRequests: [pull] });

      expect(labelsOf(harness.issues.get(95))).toContain("blocked");
      expect(harness.mocks.createComment).toHaveBeenCalledWith(
        expect.objectContaining({ body: expect.stringContaining("invalid-allowed-paths:invalid-allowed-path") }),
      );
      expect(labelsOf(harness.getControlIssue() ?? undefined)).toContain("factory-mode:paused");
    });

    it("re-validates scope on every pass while the PR is open, even after initial enrollment", async () => {
      const issue = issueFixture(96, "factory:pr-open", {
        body: "### Allowed paths\n\nsrc/app/**\n",
      });
      const pull = pullRequestFixture(196, 96, {
        labels: [
          { name: "agentic-factory" },
          { name: "agentic-automerge" },
          { name: "needs-ai-review" },
          { name: "risk:routine" },
        ],
      });
      const harness = await reconcile({
        issues: [issue],
        pullRequests: [pull],
        filesByPull: {
          196: [{ filename: "src/app/example.ts", status: "modified" }, { filename: "outside/new.ts", status: "added" }],
        },
      });

      expect(labelsOf(harness.issues.get(96))).toContain("blocked");
      expect(autoMergeCalls(harness.mocks.graphql)).toHaveLength(0);
      expect(labelsOf(harness.getControlIssue() ?? undefined)).toContain("factory-mode:paused");
    });
  });

  it("directly: ensureAutoMergeEnabled swallows a retryable clean/unstable/pending-status error", async () => {
    const core = { info: jest.fn(), warning: jest.fn() };
    const graphql = jest
      .fn()
      .mockRejectedValueOnce(new Error("Base branch was modified; head is in unstable status."));
    await expect(
      reconciler.ensureAutoMergeEnabled({
        github: { graphql },
        core,
        pullRequest: {
          number: 1,
          draft: false,
          merged_at: null,
          state: "open",
          node_id: "pr-node-1",
          auto_merge: null,
          labels: [{ name: "agentic-automerge" }],
        },
      }),
    ).resolves.toBeUndefined();
    expect(core.info).toHaveBeenCalledWith(expect.stringContaining("has not settled yet"));
  });

  it("directly: ensureAutoMergeEnabled rethrows an unexpected, non-retryable error", async () => {
    const core = { info: jest.fn(), warning: jest.fn() };
    const graphql = jest.fn().mockRejectedValueOnce(new Error("Resource not accessible by integration"));
    await expect(
      reconciler.ensureAutoMergeEnabled({
        github: { graphql },
        core,
        pullRequest: {
          number: 1,
          draft: false,
          merged_at: null,
          state: "open",
          node_id: "pr-node-1",
          auto_merge: null,
          labels: [{ name: "agentic-automerge" }],
        },
      }),
    ).rejects.toThrow("Resource not accessible by integration");
  });

  it("blocks enrollment when the correlated PR already carries a different risk label than the issue", async () => {
    const issue = issueFixture(76, "factory:implementing", {
      labels: [{ name: "factory:implementing" }, { name: "risk:routine" }],
    });
    const pull = pullRequestFixture(176, 76, { labels: [{ name: "risk:boundary" }] });
    const harness = await reconcile({ issues: [issue], pullRequests: [pull] });

    expect(labelsOf(harness.issues.get(76))).toContain("blocked");
    expect(harness.mocks.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining("conflicting-pull-request-risk-label") }),
    );
    // No mutation to the PR itself: the reconciler must not add a second,
    // conflicting risk label rather than resolving the conflict.
    expect(labelsOf(harness.pulls.get(176))).toEqual(["risk:boundary"]);
  });

  it("blocks enrollment when the correlated PR already carries more than one risk label", async () => {
    const issue = issueFixture(77, "factory:implementing", {
      labels: [{ name: "factory:implementing" }, { name: "risk:routine" }],
    });
    const pull = pullRequestFixture(177, 77, {
      labels: [{ name: "risk:routine" }, { name: "risk:sensitive" }],
    });
    const harness = await reconcile({ issues: [issue], pullRequests: [pull] });

    expect(labelsOf(harness.issues.get(77))).toContain("blocked");
    expect(harness.mocks.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining("conflicting-pull-request-risk-label") }),
    );
  });

  it("enrolls normally when the correlated PR's pre-existing risk label already matches the issue's", async () => {
    const issue = issueFixture(78, "factory:implementing", {
      labels: [{ name: "factory:implementing" }, { name: "risk:routine" }],
    });
    const pull = pullRequestFixture(178, 78, { labels: [{ name: "risk:routine" }] });
    const harness = await reconcile({ issues: [issue], pullRequests: [pull] });

    expect(labelsOf(harness.issues.get(78))).toContain("factory:pr-open");
    expect(labelsOf(harness.pulls.get(178))).toEqual(
      expect.arrayContaining(["risk:routine", "agentic-factory", "agentic-automerge", "needs-ai-review"]),
    );
  });

  it("blocks the issue and every candidate PR when more than one candidate correlates, and best-effort pauses the factory", async () => {
    const issue = issueFixture(10, "factory:implementing");
    const pullA = pullRequestFixture(103, 10);
    const pullB = pullRequestFixture(104, 10);
    const harness = await reconcile({ issues: [issue], pullRequests: [pullA, pullB] });

    expect(labelsOf(harness.issues.get(10))).toContain("blocked");
    expect(labelsOf(harness.pulls.get(103))).toContain("blocked");
    expect(labelsOf(harness.pulls.get(104))).toContain("blocked");
    expect(harness.mocks.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining("duplicate-pull-request-candidates") }),
    );
    // Duplicate-PR provenance is queue corruption (contract §10/§15), not an
    // ordinary item failure: the factory must be paused too.
    expect(labelsOf(harness.getControlIssue() ?? undefined)).toContain("factory-mode:paused");
    expect(labelsOf(harness.getControlIssue() ?? undefined)).not.toContain("factory-mode:active");
  });

  it("blocks the issue when the sole candidate PR is malformed (wrong title prefix), and best-effort pauses the factory", async () => {
    const issue = issueFixture(11, "factory:implementing");
    const pull = pullRequestFixture(105, 11, { title: "Implement the ticket" });
    const harness = await reconcile({ issues: [issue], pullRequests: [pull] });

    expect(labelsOf(harness.issues.get(11))).toContain("blocked");
    expect(labelsOf(harness.pulls.get(105))).toContain("blocked");
    expect(harness.mocks.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining("malformed-pull-request-candidate") }),
    );
    expect(labelsOf(harness.getControlIssue() ?? undefined)).toContain("factory-mode:paused");
  });

  it("blocks the issue when the sole candidate PR is malformed (wrong author), and best-effort pauses the factory", async () => {
    const issue = issueFixture(56, "factory:pr-open");
    const pull = pullRequestFixture(156, 56, { user: { login: "some-human" } });
    const harness = await reconcile({ issues: [issue], pullRequests: [pull] });

    expect(labelsOf(harness.issues.get(56))).toContain("blocked");
    expect(labelsOf(harness.getControlIssue() ?? undefined)).toContain("factory-mode:paused");
  });

  it("transitions factory:pr-open to blocked with evidence when the PR closes unmerged, and does NOT pause the factory", async () => {
    const issue = issueFixture(12, "factory:pr-open");
    const pull = pullRequestFixture(106, 12, { state: "closed", merged_at: null });
    const harness = await reconcile({ issues: [issue], pullRequests: [pull] });

    expect(labelsOf(harness.issues.get(12))).toContain("blocked");
    expect(harness.mocks.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining("pull-request-closed-unmerged") }),
    );
    // An ordinary closed-unmerged PR is a normal item outcome, not
    // queue/provenance corruption: the factory must stay active.
    expect(labelsOf(harness.getControlIssue() ?? undefined)).toContain("factory-mode:active");
    expect(labelsOf(harness.getControlIssue() ?? undefined)).not.toContain("factory-mode:paused");
  });

  it("uses factory:repairing while a trusted [self-heal] commit has pending checks, and returns to factory:pr-open once resolved", async () => {
    const issue = issueFixture(13, "factory:pr-open");
    const pull = pullRequestFixture(107, 13);
    const harness = await reconcile({
      issues: [issue],
      pullRequests: [pull],
      commitsByPull: {
        107: [{ author: { login: "copilot-swe-agent[bot]" }, commit: { message: "[self-heal] retry lint" } }],
      },
      checksBySha: {
        "sha-107": [{ id: 1, name: "CI", status: "in_progress", conclusion: null }],
      },
    });

    expect(labelsOf(harness.issues.get(13))).toContain("factory:repairing");
  });

  it("moves factory:implementing straight to factory:merged as an illegal transition, and blocks instead", async () => {
    const issue = issueFixture(14, "factory:implementing");
    const pull = pullRequestFixture(108, 14, {
      state: "closed",
      merged_at: "2026-08-20T20:00:00.000Z",
      merge_commit_sha: "merged-sha-108",
    });
    const harness = await reconcile({ issues: [issue], pullRequests: [pull] });

    expect(labelsOf(harness.issues.get(14))).toContain("blocked");
    expect(labelsOf(harness.issues.get(14))).not.toContain("factory:merged");
    expect(harness.mocks.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("illegal-transition:factory:implementing->factory:merged"),
      }),
    );
  });

  it("transitions factory:pr-open to factory:merged when the correlated PR merges, and stays merged while dev evidence is pending", async () => {
    const issue = issueFixture(15, "factory:pr-open");
    const pull = pullRequestFixture(109, 15, {
      state: "closed",
      merged_at: "2026-08-20T20:00:00.000Z",
      merge_commit_sha: "merged-sha-109",
    });
    const harness = await reconcile({
      issues: [issue],
      pullRequests: [pull],
      now: DEFAULT_NOW,
    });
    expect(labelsOf(harness.issues.get(15))).toContain("factory:merged");
    expect(harness.issues.get(15)?.state).toBe("open");
    expect(harness.mocks.updateIssue).not.toHaveBeenCalled();
  });

  it("blocks and pauses when merged dev evidence remains missing past the deadline", async () => {
    const issue = issueFixture(115, "factory:merged");
    const pull = pullRequestFixture(115, 115, {
      state: "closed",
      merged_at: "2026-08-20T14:00:00.000Z",
      merge_commit_sha: "merged-sha-115",
    });
    const harness = await reconcile({
      issues: [issue],
      pullRequests: [pull],
      now: DEFAULT_NOW,
    });

    expect(labelsOf(harness.issues.get(115))).toContain("blocked");
    expect(labelsOf(harness.getControlIssue() ?? undefined)).toContain(
      "factory-mode:paused",
    );
    expect(harness.mocks.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 115,
        body: expect.stringContaining("dev-evidence-timeout"),
      }),
    );
  });

  it("persists only factory:deployed-dev when dev evidence succeeds, and closes as factory:done only on the next run", async () => {
    const issue = issueFixture(16, "factory:merged");
    const pull = pullRequestFixture(110, 16, {
      state: "closed",
      merged_at: "2024-02-01T00:00:00.000Z",
      merge_commit_sha: "merged-sha-110",
    });
    const harness = createHarness({
      issues: [issue],
      pullRequests: [pull],
      statusesBySha: {
        "merged-sha-110": [{ id: 1, context: "Dev deployment evidence", state: "success" }],
      },
      deploymentsBySha: {
        "merged-sha-110": [{ id: 501 }],
      },
      deploymentStatusesByDeployment: {
        501: [{ id: 1, state: "success" }],
      },
    });

    await reconcileFactoryLifecycle({
      github: harness.github,
      context: { repo: { owner, repo } },
      core: harness.core,
      now: DEFAULT_NOW,
      assignmentActorNodeId: ASSIGNMENT_ACTOR.node_id,
    });

    // First run: verified evidence authorizes exactly one hop,
    // `factory:merged -> factory:deployed-dev`. The issue must NOT be
    // closed and must NOT already carry `factory:done` in this same pass.
    expect(labelsOf(harness.issues.get(16))).toContain("factory:deployed-dev");
    expect(labelsOf(harness.issues.get(16))).not.toContain("factory:done");
    expect(harness.issues.get(16)?.state).toBe("open");
    expect(harness.mocks.updateIssue).not.toHaveBeenCalled();
    expect(harness.mocks.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining("dev-evidence-verified") }),
    );

    await reconcileFactoryLifecycle({
      github: harness.github,
      context: { repo: { owner, repo } },
      core: harness.core,
      now: DEFAULT_NOW,
      assignmentActorNodeId: ASSIGNMENT_ACTOR.node_id,
    });

    // Second, separate run: `factory:deployed-dev -> factory:done` and the
    // issue is finally closed as completed.
    expect(labelsOf(harness.issues.get(16))).toContain("factory:done");
    expect(harness.issues.get(16)?.state).toBe("closed");
    expect(harness.issues.get(16)?.state_reason).toBe("completed");
  });

  it("pauses the factory-control issue and blocks when dev deployment evidence fails", async () => {
    const issue = issueFixture(17, "factory:merged");
    const pull = pullRequestFixture(111, 17, {
      state: "closed",
      merged_at: "2024-02-01T00:00:00.000Z",
      merge_commit_sha: "merged-sha-111",
    });
    const harness = await reconcile({
      issues: [issue],
      pullRequests: [pull],
      statusesBySha: {
        "merged-sha-111": [{ id: 1, context: "Dev deployment evidence", state: "failure" }],
      },
    });

    expect(labelsOf(harness.issues.get(17))).toContain("blocked");
    const controlIssue = harness.getControlIssue();
    expect(labelsOf(controlIssue ?? undefined)).toContain("factory-mode:paused");
    expect(labelsOf(controlIssue ?? undefined)).not.toContain("factory-mode:active");
    expect(harness.mocks.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: controlIssue?.number,
        body: expect.stringContaining("paused by lifecycle reconciler"),
      }),
    );
  });

  it("never unpauses and never duplicates the pause when the control issue is already paused", async () => {
    // The top-level mode gate (requirement 1) means a full reconcile pass
    // starting from an already-paused control issue performs no mutations
    // at all -- so `pauseFactoryControl`'s own idempotency is exercised
    // directly here, as it would be if reached mid-run before the control
    // issue's mode had changed out from under it.
    const alreadyPaused = {
      number: 9001,
      labels: [{ name: "factory-control" }, { name: "factory-mode:paused" }],
      comments: [] as Comment[],
    };
    const harness = createHarness({ issues: [], controlIssue: alreadyPaused });

    await reconciler.pauseFactoryControl({
      github: harness.github,
      core: harness.core,
      owner,
      repo,
      reason: "dev evidence failed",
    });
    await reconciler.pauseFactoryControl({
      github: harness.github,
      core: harness.core,
      owner,
      repo,
      reason: "dev evidence failed again",
    });

    expect(labelsOf(harness.getControlIssue() ?? undefined)).toEqual([
      "factory-control",
      "factory-mode:paused",
    ]);
    expect(harness.mocks.createComment).not.toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 9001 }),
    );
    expect(harness.mocks.addLabels).not.toHaveBeenCalled();
    expect(harness.mocks.removeLabel).not.toHaveBeenCalled();
  });

  it("closes a factory:deployed-dev issue idempotently left over from a partial prior run", async () => {
    const issue = issueFixture(19, "factory:deployed-dev");
    const harness = await reconcile({ issues: [issue] });

    expect(labelsOf(harness.issues.get(19))).toContain("factory:done");
    expect(harness.issues.get(19)?.state).toBe("closed");
  });

  it("fails closed to blocked when an issue carries more than one lifecycle label, and best-effort pauses the factory", async () => {
    const issue = issueFixture(20, "factory:pr-open", {
      labels: [{ name: "factory:pr-open" }, { name: "factory:merged" }, { name: "risk:routine" }],
    });
    const harness = await reconcile({ issues: [issue] });

    expect(labelsOf(harness.issues.get(20))).toEqual(
      expect.arrayContaining(["blocked", "risk:routine"]),
    );
    expect(labelsOf(harness.issues.get(20))).not.toContain("factory:pr-open");
    expect(labelsOf(harness.issues.get(20))).not.toContain("factory:merged");
    // An ambiguous lifecycle state is queue/provenance corruption (contract
    // §5/§15), not an ordinary item failure: the factory must be paused too.
    expect(labelsOf(harness.getControlIssue() ?? undefined)).toContain("factory-mode:paused");
  });

  it("does not pause the factory for an issue that is simply missing a claim comment (an ordinary item failure)", async () => {
    const issue = issueFixture(84, "factory:claimed", { comments: [] });
    const harness = await reconcile({ issues: [issue] });

    expect(labelsOf(harness.issues.get(84))).toContain("blocked");
    expect(labelsOf(harness.getControlIssue() ?? undefined)).toContain("factory-mode:active");
  });

  it("pauses the factory for an issue with invalid assignment provenance", async () => {
    const issue = issueFixture(85, "factory:claimed", {
      assignees: [{ login: "some-random-human" }],
    });
    const harness = await reconcile({ issues: [issue] });

    expect(labelsOf(harness.issues.get(85))).toContain("blocked");
    expect(labelsOf(harness.getControlIssue() ?? undefined)).toContain("factory-mode:paused");
  });

  it("makes no further mutation on an idempotent rerun once a transition has already settled", async () => {
    const issue = issueFixture(21, "factory:claimed", {
      assignees: [{ login: "copilot-swe-agent[bot]" }],
    });
    const harness = createHarness({ issues: [issue] });

    await reconcileFactoryLifecycle({
      github: harness.github,
      context: { repo: { owner, repo } },
      core: harness.core,
      now: DEFAULT_NOW,
      assignmentActorNodeId: ASSIGNMENT_ACTOR.node_id,
    });
    expect(labelsOf(harness.issues.get(21))).toContain("factory:implementing");
    expect(harness.mocks.addLabels).toHaveBeenCalledTimes(1);
    expect(harness.mocks.createComment).toHaveBeenCalledTimes(2);

    // Second pass: the issue is already `factory:implementing` with zero
    // correlated PRs yet, which is a defined "stays" no-op -- it must not
    // re-attempt the already-applied transition or write a second comment.
    await reconcileFactoryLifecycle({
      github: harness.github,
      context: { repo: { owner, repo } },
      core: harness.core,
      now: DEFAULT_NOW,
      assignmentActorNodeId: ASSIGNMENT_ACTOR.node_id,
    });
    expect(harness.mocks.addLabels).toHaveBeenCalledTimes(1);
    expect(harness.mocks.removeLabel).toHaveBeenCalledTimes(1);
    expect(harness.mocks.createComment).toHaveBeenCalledTimes(2);
    expect(harness.mocks.updateComment).not.toHaveBeenCalled();
  });

  it("re-running a settled factory:pr-open state performs zero additional mutations", async () => {
    const issue = issueFixture(22, "factory:implementing");
    const pull = pullRequestFixture(113, 22);
    const harness = createHarness({ issues: [issue], pullRequests: [pull] });

    await reconcileFactoryLifecycle({
      github: harness.github,
      context: { repo: { owner, repo } },
      core: harness.core,
      now: DEFAULT_NOW,
      assignmentActorNodeId: ASSIGNMENT_ACTOR.node_id,
    });
    expect(labelsOf(harness.issues.get(22))).toContain("factory:pr-open");
    expect(harness.mocks.graphql).toHaveBeenCalledTimes(1);
    const firstCommentCalls = harness.mocks.createComment.mock.calls.length;
    const firstAddLabelCalls = harness.mocks.addLabels.mock.calls.length;

    await reconcileFactoryLifecycle({
      github: harness.github,
      context: { repo: { owner, repo } },
      core: harness.core,
      now: DEFAULT_NOW,
      assignmentActorNodeId: ASSIGNMENT_ACTOR.node_id,
    });

    expect(harness.mocks.graphql).toHaveBeenCalledTimes(2);
    expect(harness.mocks.createComment.mock.calls.length).toBe(firstCommentCalls);
    expect(harness.mocks.addLabels.mock.calls.length).toBe(firstAddLabelCalls);
    expect(harness.mocks.updateComment).not.toHaveBeenCalled();
  });

  it("isolates a per-issue API failure: one issue's failure does not stop reconciliation of another", async () => {
    const brokenIssue = issueFixture(23, "factory:claimed", {
      assignees: [{ login: "copilot-swe-agent[bot]" }],
    });
    const healthyIssue = issueFixture(24, "factory:claimed", {
      assignees: [{ login: "copilot-swe-agent[bot]" }],
    });
    const harness = await reconcile({
      issues: [brokenIssue, healthyIssue],
      failIssueNumbers: [23],
    });

    expect(harness.core.warning).toHaveBeenCalledWith(
      expect.stringContaining("Lifecycle reconciliation failed for issue #23"),
    );
    // The broken issue is fail-closed to blocked on a best-effort basis...
    expect(labelsOf(harness.issues.get(23))).toContain("blocked");
    // ...while the healthy issue still progresses normally.
    expect(labelsOf(harness.issues.get(24))).toContain("factory:implementing");
  });

  it("warns and returns without touching any issue when the default branch cannot be resolved", async () => {
    const issue = issueFixture(25, "factory:claimed", {
      assignees: [{ login: "copilot-swe-agent[bot]" }],
    });
    const harness = createHarness({ issues: [issue] });
    harness.mocks.repoGet.mockRejectedValueOnce(new Error("repos.get failed"));

    await reconcileFactoryLifecycle({
      github: harness.github,
      context: { repo: { owner, repo } },
      core: harness.core,
      now: DEFAULT_NOW,
      assignmentActorNodeId: ASSIGNMENT_ACTOR.node_id,
    });

    expect(harness.core.warning).toHaveBeenCalledWith(
      expect.stringContaining("Could not resolve the default branch"),
    );
    expect(labelsOf(harness.issues.get(25))).toEqual(["factory:claimed", "risk:routine"]);
    expect(harness.mocks.addLabels).not.toHaveBeenCalled();
  });
});

describe("agentic lifecycle reconciler pure helpers", () => {
  it("extractClaimMarkerPayload returns null when no marker is present", () => {
    expect(reconciler.extractClaimMarkerPayload("just some text")).toBeNull();
    expect(reconciler.extractClaimMarkerPayload(undefined)).toBeNull();
  });

  it("resolveLatestIssueClaim takes the most recently posted claim marker", () => {
    const first = claimComment(30, {
      nonce: "100:1:30",
      owner: "queue-controller:100:1",
      createdAt: "2024-01-01T00:00:00.000Z",
      expiresAt: "2024-01-01T01:00:00.000Z",
    });
    const second = claimComment(30, {
      nonce: "101:1:30",
      owner: "queue-controller:101:1",
      createdAt: "2024-01-01T02:00:00.000Z",
      expiresAt: "2024-01-01T03:00:00.000Z",
    });
    const result = reconciler.resolveLatestIssueClaim([first, second], 30);
    expect(result.state).toBe("valid");
    expect(result.claim?.nonce).toBe("101:1:30");
  });

  it("resolveLatestIssueClaim fails closed on an issue-number mismatch", () => {
    const comment = claimComment(31, { issueNumber: 999 });
    const result = reconciler.resolveLatestIssueClaim([comment], 31);
    expect(result.state).toBe("malformed");
    expect(result.reason).toContain("issue-number-mismatch");
  });

  it("correlatePullRequests partitions valid vs. malformed candidates", () => {
    const nonce = NONCE_FOR(99);
    const valid = pullRequestFixture(200, 99);
    const malformedTitle = pullRequestFixture(201, 99, { title: "Implement it" });
    const unrelated = pullRequestFixture(202, 100);

    const result = reconciler.correlatePullRequests({
      pullRequests: [valid, malformedTitle, unrelated],
      issueNumber: 99,
      nonce,
      repository,
      defaultBranch: DEFAULT_BRANCH,
      copilotIdentity: COPILOT_IDENTITY,
    });

    expect(result.candidates).toHaveLength(2);
    expect(result.valid).toEqual([valid]);
    expect(result.malformed).toEqual([malformedTitle]);
  });

  it("resolveLifecycleTransitionPath composes the repairing->merged hop", () => {
    expect(reconciler.resolveLifecycleTransitionPath("factory:repairing", "factory:merged")).toEqual({
      allowed: true,
      path: ["factory:repairing", "factory:pr-open", "factory:merged"],
    });
  });

  it("resolveLifecycleTransitionPath rejects an illegal transition outright", () => {
    expect(reconciler.resolveLifecycleTransitionPath("factory:implementing", "factory:merged")).toEqual({
      allowed: false,
      path: [],
    });
    expect(reconciler.resolveLifecycleTransitionPath("factory:claimed", "factory:done")).toEqual({
      allowed: false,
      path: [],
    });
  });

  it("resolveLifecycleTransitionPath no longer composites factory:merged -> factory:done in one hop", () => {
    expect(reconciler.resolveLifecycleTransitionPath("factory:merged", "factory:done")).toEqual({
      allowed: false,
      path: [],
    });
    expect(reconciler.resolveLifecycleTransitionPath("factory:merged", "factory:deployed-dev")).toEqual({
      allowed: true,
      path: ["factory:merged", "factory:deployed-dev"],
    });
    expect(reconciler.resolveLifecycleTransitionPath("factory:deployed-dev", "factory:done")).toEqual({
      allowed: true,
      path: ["factory:deployed-dev", "factory:done"],
    });
  });

  it("hasConflictingPullRequestRiskLabel flags multiple or mismatched pre-existing PR risk labels", () => {
    expect(reconciler.hasConflictingPullRequestRiskLabel([], "risk:routine")).toBe(false);
    expect(reconciler.hasConflictingPullRequestRiskLabel(["risk:routine"], "risk:routine")).toBe(false);
    expect(reconciler.hasConflictingPullRequestRiskLabel(["risk:boundary"], "risk:routine")).toBe(true);
    expect(
      reconciler.hasConflictingPullRequestRiskLabel(["risk:routine", "risk:sensitive"], "risk:routine"),
    ).toBe(true);
  });

  it("isRetryableAutoMergeStateError only matches the documented clean/unstable/pending phrases", () => {
    expect(reconciler.isRetryableAutoMergeStateError(new Error("head is in clean status"))).toBe(true);
    expect(reconciler.isRetryableAutoMergeStateError(new Error("head is in unstable status"))).toBe(true);
    expect(reconciler.isRetryableAutoMergeStateError(new Error("head is in pending status"))).toBe(true);
    expect(reconciler.isRetryableAutoMergeStateError(new Error("Resource not accessible"))).toBe(false);
  });

  it("findLatestLabelApplicationEvent picks the event with the newest created_at, not array order", () => {
    const older = {
      event: "labeled",
      label: { name: "factory-mode:active" },
      actor: { type: "Bot" },
      created_at: "2024-01-01T00:00:00.000Z",
    };
    const newer = {
      event: "labeled",
      label: { name: "factory-mode:active" },
      actor: { type: "User" },
      created_at: "2024-06-01T00:00:00.000Z",
    };
    const unrelated = { event: "labeled", label: { name: "risk:routine" }, actor: { type: "User" } };

    // Newer listed first: still picks the newer one by created_at.
    expect(reconciler.findLatestLabelApplicationEvent([newer, older, unrelated], "factory-mode:active")).toBe(
      newer,
    );
    // Newer listed last: still picks the newer one, not the last-seen.
    expect(reconciler.findLatestLabelApplicationEvent([older, unrelated, newer], "factory-mode:active")).toBe(
      newer,
    );
    expect(reconciler.findLatestLabelApplicationEvent([], "factory-mode:active")).toBeUndefined();
    expect(reconciler.findLatestLabelApplicationEvent([unrelated], "factory-mode:active")).toBeUndefined();
  });

  it("getIssueFormSection extracts exactly one matching heading and fails closed otherwise", () => {
    const body = "### Allowed paths\n\nsrc/app/**\ndocs/readme.md\n\n### Risk assessment\n\nrisk:routine\n";
    expect(reconciler.getIssueFormSection(body, "Allowed paths")).toBe("src/app/**\ndocs/readme.md");
    expect(reconciler.getIssueFormSection(body, "Risk assessment")).toBe("risk:routine");
    expect(reconciler.getIssueFormSection(body, "Nonexistent")).toBeUndefined();
    expect(reconciler.getIssueFormSection("### Allowed paths\n\n_No response_\n", "Allowed paths")).toBeUndefined();
    expect(reconciler.getIssueFormSection(undefined, "Allowed paths")).toBeUndefined();
    // Duplicate headings are ambiguous: fail closed rather than guessing.
    const duplicated = "### Allowed paths\n\nsrc/**\n\n### Allowed paths\n\ndocs/**\n";
    expect(reconciler.getIssueFormSection(duplicated, "Allowed paths")).toBeUndefined();
  });

  it("validateAllowedPathsScope requires every current and previous filename within the normalized patterns", async () => {
    const githubFor = (files: unknown[]) => ({
      paginate: async () => files,
      rest: { pulls: { listFiles: "listFiles" } },
    });
    const issue = { number: 1, body: "### Allowed paths\n\nsrc/app/**\ndocs/readme.md\n" };
    const pullRequest = { number: 10 };

    await expect(
      reconciler.validateAllowedPathsScope({
        github: githubFor([
          { filename: "src/app/foo.ts", status: "modified" },
          { filename: "docs/readme.md", status: "modified" },
        ]),
        owner,
        repo,
        issue,
        pullRequest,
      }),
    ).resolves.toEqual({ ok: true });

    await expect(
      reconciler.validateAllowedPathsScope({
        github: githubFor([{ filename: "src/other/foo.ts", status: "modified" }]),
        owner,
        repo,
        issue,
        pullRequest,
      }),
    ).resolves.toEqual({ ok: false, reason: "changed-files-outside-allowed-paths" });

    await expect(
      reconciler.validateAllowedPathsScope({
        github: githubFor([
          { filename: "src/app/renamed.ts", status: "renamed", previous_filename: "outside/old.ts" },
        ]),
        owner,
        repo,
        issue,
        pullRequest,
      }),
    ).resolves.toEqual({ ok: false, reason: "changed-files-outside-allowed-paths" });

    await expect(
      reconciler.validateAllowedPathsScope({
        github: githubFor([{ filename: "src/app/foo.ts", status: "modified" }]),
        owner,
        repo,
        issue: { number: 2, body: "no section" },
        pullRequest,
      }),
    ).resolves.toEqual({ ok: false, reason: "invalid-allowed-paths:allowed-paths-not-string" });
  });

  it("computeLifecycleLabelChange removes every other lifecycle label and adds only the target", () => {
    expect(
      reconciler.computeLifecycleLabelChange(
        ["factory:pr-open", "risk:routine", "needs-ai-review"],
        "factory:merged",
      ),
    ).toEqual({ toRemove: ["factory:pr-open"], toAdd: ["factory:merged"] });

    expect(
      reconciler.computeLifecycleLabelChange(["factory:merged", "risk:routine"], "factory:merged"),
    ).toEqual({ toRemove: [], toAdd: [] });
  });

  it("evaluateDevEvidence requires both the status and the deployment to succeed for the exact SHA", () => {
    const success = reconciler.evaluateDevEvidence({
      statuses: [{ id: 1, context: "Dev deployment evidence", state: "success" }],
      deployments: [{ id: 1 }],
      deploymentStatusesByDeployment: { 1: [{ id: 1, state: "success" }] },
    });
    expect(success).toBe("success");

    const failure = reconciler.evaluateDevEvidence({
      statuses: [{ id: 1, context: "Dev deployment evidence", state: "failure" }],
      deployments: [],
      deploymentStatusesByDeployment: {},
    });
    expect(failure).toBe("failure");

    const pending = reconciler.evaluateDevEvidence({
      statuses: [],
      deployments: [],
      deploymentStatusesByDeployment: {},
    });
    expect(pending).toBe("pending");
  });

  it("hasTrustedSelfHealCommit and hasPendingCheckRuns are conservative and trusted-author scoped", () => {
    expect(
      reconciler.hasTrustedSelfHealCommit(
        [
          {
            author: { login: "some-human", type: "User" },
            commit: { message: "[self-heal] retry" },
          },
        ],
        COPILOT_IDENTITY,
      ),
    ).toBe(false);
    expect(
      reconciler.hasTrustedSelfHealCommit(
        [
          {
            author: COPILOT_ACTOR,
            commit: { message: "[self-heal] retry" },
          },
        ],
        COPILOT_IDENTITY,
      ),
    ).toBe(true);
    expect(reconciler.hasPendingCheckRuns([{ status: "completed" }])).toBe(false);
    expect(reconciler.hasPendingCheckRuns([{ status: "in_progress" }])).toBe(true);
  });
});
