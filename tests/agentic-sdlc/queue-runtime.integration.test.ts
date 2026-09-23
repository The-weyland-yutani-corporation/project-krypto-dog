export {};

interface ApiParams {
  owner?: string;
  repo?: string;
  state?: string;
  labels?: string | string[];
  per_page?: number;
  issue_number?: number;
  name?: string;
  body?: string;
  q?: string;
  workflow_id?: string;
  ref?: string;
  inputs?: Record<string, string>;
  [key: string]: unknown;
}

interface MockMilestone {
  title: string;
}

interface MockAssignee {
  login: string;
}

interface MockComment {
  body: string;
}

interface MockIssue {
  number: number;
  body: string;
  labels: string[];
  milestone: MockMilestone | null;
  assignees: MockAssignee[];
  state: "open" | "closed";
  created_at: string;
  comments: MockComment[];
}

interface MockPullRequestBody {
  body: string;
}

interface MockSubIssue {
  state: string;
}

interface MockTimelineActor {
  type: string;
  login?: string;
}

interface MockTimelineEvent {
  event: string;
  created_at?: string;
  label?: { name: string };
  actor?: MockTimelineActor;
}

interface Rejection {
  number: number | undefined;
  reasons: string[];
}

interface GoalConfig {
  number: number;
  milestone: string;
  maxGoalRiskTier: string;
  concurrencyLimit: number;
  dailyBudgetLimit: number;
  goalAllowedPaths: string[];
  fieldWarnings: string[];
}

interface SelectedCandidate {
  number: number;
  [key: string]: unknown;
}

interface ClaimPayload {
  nonce: string;
  owner: string;
  issueNumber: number;
  expiresAt: string;
}

interface RunResult {
  mode: string;
  controlReason: string;
  activeGoal: GoalConfig | null;
  activeGoalReason: string | null;
  selected: SelectedCandidate | null;
  rejections: Rejection[];
  claimed: boolean;
  dispatched: boolean;
  blocked: boolean;
  blockedReason: string | null;
  autoPaused: boolean;
  autoPauseReason: string | null;
  timeValid: boolean;
  claim?: ClaimPayload;
}

interface RunConfig {
  now?: string;
  leaseMinutes?: number;
  runId?: string;
  attempt?: number;
  claimOwner?: string;
  defaultBranch?: string;
}

interface CandidateSections {
  labels: string[];
  milestone: string | null;
  parentGoalNumber: number | undefined;
  parentGoalApproved: boolean;
  dependencyNumbers: number[] | null;
  hasAcceptanceCriteria: boolean;
  hasValidationPlan: boolean;
  hasScopeDefinition: boolean;
  allowedPaths: string[];
  allowedPathsReason: string | undefined;
  hasRiskAssessment: boolean;
  hasRollbackPlan: boolean;
  priority: string | undefined;
  state: "open" | "closed";
  createdAt: unknown;
}

interface RuntimeModule {
  runFactoryQueueController(input: {
    github: unknown;
    context: { repo: { owner: string; repo: string } };
    core: unknown;
    config?: RunConfig;
  }): Promise<RunResult>;
  extractIssueFormSections(body: unknown): Record<string, string>;
  getIssueFormSection(sections: Record<string, string>, heading: string): string | undefined;
  parseIssueReference(text: unknown): number | undefined;
  parseDependencyReferences(text: unknown): number[] | null;
  normalizeLabels(labels: unknown): string[];
  determineFactoryMode(controlIssues: unknown[]): {
    mode: string;
    reason: string;
    controlIssue: unknown;
  };
  resolveActiveGoal(goalIssues: unknown[]): { valid: boolean; reason: string; goal: GoalConfig | null };
  parseCandidateSections(issue: unknown, activeGoalNumber: number | undefined): CandidateSections;
  isValidTimestamp(value: unknown): boolean;
  areAllCheckboxesChecked(sectionText: unknown): boolean;
  findLatestLabelApplicationEvent(
    events: unknown,
    labelName: string,
  ): MockTimelineEvent | undefined;
  isHumanActorType(actorType: unknown): boolean;
  CONTROL_LABEL: string;
  GOAL_LABEL: string;
  GOAL_APPROVED_LABEL: string;
  FACTORY_LABEL: string;
  READY_LABEL: string;
  CLAIMED_LABEL: string;
  BLOCKED_LABEL: string;
  MODE_LABELS: string[];
  PAUSED_MODE_LABEL: string;
  IMPLEMENT_WORKFLOW_ID: string;
  MAX_ALLOWED_CONCURRENCY_LIMIT: number;
  PRIORITY_LABELS: string[];
}

const runtime = jest.requireActual<RuntimeModule>("../../.github/scripts/agentic-queue-runtime.cjs");

const owner = "VeVarunSharma";
const repo = "project-krypto-dog";
const NOW = "2024-06-01T00:00:00.000Z";

function renderForm(sections: Array<[string, string]>): string {
  return sections.map(([heading, content]) => `### ${heading}\n\n${content}`).join("\n\n");
}

function goalBody(overrides: Partial<Record<string, string>> = {}): string {
  const fields: Record<string, string> = {
    Objective: "Ship the safety-bounded factory.",
    "Measurable success condition": "All gates green.",
    "Allowed scope": "src/**, tests/**",
    "Allowed paths": "src/**\ntests/**",
    "Explicit non-goals": "Production and live trading.",
    "Maximum autonomous risk tier": "risk:sensitive",
    "Maximum active coding-agent sessions": "1",
    "Assignment budget": "10",
    "Required evidence": "CI green.",
    "Pause and stop conditions": "Any required check unresolved.",
    "Human-only boundaries": [
      "- [x] Production deployment remains human-approved.",
      "- [x] Live-trading enablement remains human-approved.",
      "- [x] Automation may pause itself but may not unpause itself.",
    ].join("\n"),
    ...overrides,
  };
  return renderForm(Object.entries(fields));
}

function candidateBody(overrides: Partial<Record<string, string>> = {}): string {
  const fields: Record<string, string> = {
    "Work type": "implementation",
    "Approved parent goal": "#1",
    "Problem or goal": "Fix the bug.",
    "Scope and non-goals": "Only src/foo.ts.",
    "Allowed paths": "src/foo.ts",
    "Risk tier": "risk:routine",
    Dependencies: "None",
    "Acceptance criteria": "- [ ] The bug is fixed.",
    "Validation plan": "npm test -- --ci",
    "Rollback or safe reversal": "git revert the merge commit.",
    ...overrides,
  };
  return renderForm(Object.entries(fields));
}

/**
 * Builds a candidate body with one heading rendered *twice* (with possibly
 * different values), simulating a malformed/duplicated issue-form render.
 * Unlike `candidateBody`, which de-duplicates through object-key semantics,
 * this appends a second literal `### heading` occurrence to the array
 * `renderForm` joins, so both occurrences actually appear in the body.
 */
function candidateBodyWithDuplicateHeading(
  heading: string,
  firstValue: string,
  secondValue: string,
): string {
  const fields: Record<string, string> = {
    "Work type": "implementation",
    "Approved parent goal": "#1",
    "Problem or goal": "Fix the bug.",
    "Scope and non-goals": "Only src/foo.ts.",
    "Allowed paths": "src/foo.ts",
    "Risk tier": "risk:routine",
    Dependencies: "None",
    "Acceptance criteria": "- [ ] The bug is fixed.",
    "Validation plan": "npm test -- --ci",
    "Rollback or safe reversal": "git revert the merge commit.",
  };
  fields[heading] = firstValue;
  const entries: Array<[string, string]> = Object.entries(fields);
  entries.push([heading, secondValue]);
  return renderForm(entries);
}

/**
 * Same idea as `candidateBodyWithDuplicateHeading`, but for the goal
 * template's fields.
 */
function goalBodyWithDuplicateHeading(
  heading: string,
  firstValue: string,
  secondValue: string,
): string {
  const fields: Record<string, string> = {
    Objective: "Ship the safety-bounded factory.",
    "Measurable success condition": "All gates green.",
    "Allowed scope": "src/**, tests/**",
    "Allowed paths": "src/**\ntests/**",
    "Explicit non-goals": "Production and live trading.",
    "Maximum autonomous risk tier": "risk:sensitive",
    "Maximum active coding-agent sessions": "1",
    "Assignment budget": "10",
    "Required evidence": "CI green.",
    "Pause and stop conditions": "Any required check unresolved.",
    "Human-only boundaries": [
      "- [x] Production deployment remains human-approved.",
      "- [x] Live-trading enablement remains human-approved.",
      "- [x] Automation may pause itself but may not unpause itself.",
    ].join("\n"),
  };
  fields[heading] = firstValue;
  const entries: Array<[string, string]> = Object.entries(fields);
  entries.push([heading, secondValue]);
  return renderForm(entries);
}

function controlIssue(number: number, labels: string[], overrides: Partial<MockIssue> = {}): MockIssue {
  return {
    number,
    body: "Factory control switch.",
    labels: [runtime.CONTROL_LABEL, ...labels],
    milestone: null,
    assignees: [],
    state: "open",
    created_at: "2024-01-01T00:00:00Z",
    comments: [],
    ...overrides,
  };
}

function goalIssue(number: number, overrides: Partial<MockIssue> = {}): MockIssue {
  return {
    number,
    body: goalBody(),
    labels: [runtime.GOAL_LABEL, runtime.GOAL_APPROVED_LABEL, "agentic-factory"],
    milestone: { title: "v2.4" },
    assignees: [],
    state: "open",
    created_at: "2024-01-02T00:00:00Z",
    comments: [],
    ...overrides,
  };
}

function candidateIssue(number: number, overrides: Partial<MockIssue> = {}): MockIssue {
  return {
    number,
    body: candidateBody(),
    labels: [runtime.READY_LABEL, runtime.FACTORY_LABEL, "risk:routine"],
    milestone: { title: "v2.4" },
    assignees: [],
    state: "open",
    created_at: "2024-02-01T00:00:00Z",
    comments: [],
    ...overrides,
  };
}

interface HarnessOptions {
  issues: MockIssue[];
  subIssuesByNumber?: Record<number, MockSubIssue[]>;
  failSubIssuesFor?: number[];
  parentGoalByNumber?: Record<number, number>;
  failParentFor?: number[];
  defaultNativeParentGoalNumber?: number;
  failDependencyFetchFor?: number[];
  pullRequests?: MockPullRequestBody[];
  failPullRequestList?: boolean;
  failAddLabelsFor?: number[];
  failRemoveLabelFor?: number[];
  failRemoveLabelForNames?: Record<number, string[]>;
  failCreateCommentFor?: number[];
  failDispatchFor?: number[];
  failReposGet?: boolean;
  failListCommentsFor?: number[];
  staleGetFor?: number[];
  injectExtraLifecycleLabelFor?: Record<number, string>;
  dropLatestCommentOnVerifyFor?: number[];
  tamperClaimNonceOnVerifyFor?: number[];
  timelineByNumber?: Record<number, MockTimelineEvent[]>;
  failTimelineFor?: number[];
  defaultBranch?: string;
}

function createHarness(options: HarnessOptions) {
  const issuesByNumber = new Map<number, MockIssue>();
  const snapshots = new Map<number, MockIssue>();
  for (const issue of options.issues) {
    issuesByNumber.set(issue.number, { ...issue, labels: [...issue.labels], comments: [...issue.comments] });
    snapshots.set(issue.number, { ...issue, labels: [...issue.labels], comments: [...issue.comments] });
  }

  const commentListCallCounts = new Map<number, number>();

  const requireIssue = (number: number): MockIssue => {
    const issue = issuesByNumber.get(number);
    if (!issue) {
      throw new Error(`No such mock issue #${number}`);
    }
    return issue;
  };

  const listForRepo = jest.fn(async (params: ApiParams): Promise<MockIssue[]> => {
    const wantedLabels = typeof params.labels === "string" ? params.labels.split(",") : [];
    const state = params.state ?? "open";
    return Array.from(issuesByNumber.values()).filter((issue) => {
      const stateMatches = state === "all" || issue.state === state;
      const labelsMatch = wantedLabels.every((label) => issue.labels.includes(label));
      return stateMatches && labelsMatch;
    });
  });

  const listComments = jest.fn(async (params: ApiParams): Promise<MockComment[]> => {
    const number = params.issue_number as number;
    if ((options.failListCommentsFor ?? []).includes(number)) {
      throw new Error(`listComments failed for #${number}`);
    }
    const callIndex = commentListCallCounts.get(number) ?? 0;
    commentListCallCounts.set(number, callIndex + 1);
    const issue = requireIssue(number);
    if (callIndex > 0 && (options.dropLatestCommentOnVerifyFor ?? []).includes(number)) {
      return issue.comments.slice(0, -1);
    }
    return issue.comments;
  });

  const paginate = jest.fn(
    async (
      method: (params: ApiParams) => Promise<unknown[]>,
      params: ApiParams,
    ): Promise<unknown[]> => method(params),
  );

  const getIssue = jest.fn(async (params: ApiParams): Promise<{ data: MockIssue }> => {
    const number = params.issue_number as number;
    if ((options.failDependencyFetchFor ?? []).includes(number)) {
      throw new Error(`dependency lookup failed for #${number}`);
    }
    if ((options.staleGetFor ?? []).includes(number)) {
      const snapshot = snapshots.get(number);
      if (!snapshot) {
        throw new Error(`no snapshot for #${number}`);
      }
      return { data: snapshot };
    }
    const issue = requireIssue(number);
    const injectedLabel = options.injectExtraLifecycleLabelFor?.[number];
    if (injectedLabel) {
      // Simulates a race where another workflow concurrently applied a
      // different lifecycle label in between our mutation and our
      // verification re-read, without mutating the real stored issue.
      return { data: { ...issue, labels: [...issue.labels, injectedLabel] } };
    }
    return { data: issue };
  });

  const addLabels = jest.fn(async (params: ApiParams): Promise<Record<string, never>> => {
    const number = params.issue_number as number;
    if ((options.failAddLabelsFor ?? []).includes(number)) {
      throw new Error(`addLabels failed for #${number}`);
    }
    const issue = requireIssue(number);
    const labels = Array.isArray(params.labels) ? params.labels : [];
    for (const label of labels) {
      if (!issue.labels.includes(label)) {
        issue.labels.push(label);
      }
    }
    return {};
  });

  const removeLabel = jest.fn(async (params: ApiParams): Promise<Record<string, never>> => {
    const number = params.issue_number as number;
    const name = (params.name as string) ?? "";
    if ((options.failRemoveLabelFor ?? []).includes(number)) {
      throw new Error(`removeLabel failed for #${number}`);
    }
    if ((options.failRemoveLabelForNames?.[number] ?? []).includes(name)) {
      throw new Error(`removeLabel failed for #${number} label "${name}"`);
    }
    const issue = requireIssue(number);
    if (!issue.labels.includes(name)) {
      const notFound = new Error(`Label "${name}" not found on #${number}`) as Error & { status?: number };
      notFound.status = 404;
      throw notFound;
    }
    issue.labels = issue.labels.filter((label) => label !== name);
    return {};
  });

  const createComment = jest.fn(async (params: ApiParams): Promise<Record<string, never>> => {
    const number = params.issue_number as number;
    if ((options.failCreateCommentFor ?? []).includes(number)) {
      throw new Error(`createComment failed for #${number}`);
    }
    const issue = requireIssue(number);
    let body = params.body ?? "";
    if ((options.tamperClaimNonceOnVerifyFor ?? []).includes(number)) {
      // Simulates a forged/mismatched persisted nonce (e.g. a concurrent
      // write clobbering ours) -- the label mutation succeeded, but the
      // claim marker that ends up persisted does not match what we posted.
      body = body.replace(/"nonce":"[^"]*"/, '"nonce":"forged:9:999"');
    }
    issue.comments.push({ body });
    return {};
  });

  const listPullRequests = jest.fn(async () => {
    if (options.failPullRequestList) throw new Error("pull request list failed");
    return (options.pullRequests || []).map((item, index) => ({
      number: 10000 + index,
      head: { repo: { id: 10, full_name: `${owner}/${repo}` } },
      base: { repo: { id: 10, full_name: `${owner}/${repo}` } },
      ...item,
    }));
  });

  const request = jest.fn(
    async (route: string, params: ApiParams): Promise<{ data: MockSubIssue[] | { number: number; repository_url: string } }> => {
      const number = params.issue_number as number;
      if (route.includes("/parent")) {
        if ((options.failParentFor ?? []).includes(number)) {
          throw new Error(`parent lookup failed for #${number}`);
        }
        const parentNumber =
          options.parentGoalByNumber?.[number] ?? options.defaultNativeParentGoalNumber ?? 1;
        return { data: { number: parentNumber, repository_url: `https://api.github.com/repos/${params.owner}/${params.repo}` } };
      }
      if ((options.failSubIssuesFor ?? []).includes(number)) {
        throw new Error(`sub_issues lookup failed for #${number}`);
      }
      return { data: options.subIssuesByNumber?.[number] ?? [] };
    },
  );

  const listEventsForTimeline = jest.fn(async (params: ApiParams): Promise<MockTimelineEvent[]> => {
    const number = params.issue_number as number;
    if ((options.failTimelineFor ?? []).includes(number)) {
      throw new Error(`timeline lookup failed for #${number}`);
    }
    if (options.timelineByNumber && number in options.timelineByNumber) {
      return options.timelineByNumber[number];
    }
    // Default: synthesize a human "labeled" event for every mode/approval
    // label currently on the issue, so existing fixtures (which already
    // carry the relevant label) resolve as human-applied without every
    // test needing to wire up a timeline explicitly.
    const issue = requireIssue(number);
    const relevantLabels = [
      "factory-mode:active",
      "factory-mode:shadow",
      "factory-mode:paused",
      runtime.GOAL_APPROVED_LABEL,
    ];
    return issue.labels
      .filter((label) => relevantLabels.includes(label))
      .map((label) => ({
        event: "labeled",
        label: { name: label },
        actor: { type: "User", login: "human-operator" },
      }));
  });

  const createWorkflowDispatch = jest.fn(async (params: ApiParams): Promise<Record<string, never>> => {
    const number = Number(params.inputs?.issue);
    if ((options.failDispatchFor ?? []).includes(number)) {
      throw new Error(`dispatch failed for #${number}`);
    }
    return {};
  });

  const reposGet = jest.fn(async (): Promise<{ data: { default_branch: string } }> => {
    if (options.failReposGet) {
      throw new Error("repos.get failed");
    }
    return { data: { default_branch: options.defaultBranch ?? "main" } };
  });

  const core = {
    info: jest.fn(),
    warning: jest.fn(),
  };

  const github = {
    paginate,
    request,
    rest: {
      issues: {
        listForRepo,
        listComments,
        listEventsForTimeline,
        get: getIssue,
        addLabels,
        removeLabel,
        createComment,
      },
      pulls: {
        list: listPullRequests,
      },
      actions: {
        createWorkflowDispatch,
      },
      repos: {
        get: reposGet,
      },
    },
  };

  return {
    github,
    core,
    issuesByNumber,
    mocks: {
      listForRepo,
      listComments,
      listEventsForTimeline,
      paginate,
      getIssue,
      addLabels,
      removeLabel,
      createComment,
      listPullRequests,
      request,
      createWorkflowDispatch,
      reposGet,
    },
  };
}

async function run(
  options: HarnessOptions,
  config: RunConfig = {},
): Promise<{ result: RunResult } & ReturnType<typeof createHarness>> {
  const harness = createHarness(options);
  const result = await runtime.runFactoryQueueController({
    github: harness.github,
    context: { repo: { owner, repo } },
    core: harness.core,
    config: { now: NOW, leaseMinutes: 120, runId: "run-1", attempt: 0, claimOwner: "queue-controller-test", defaultBranch: "main", ...config },
  });
  return { result, ...harness };
}

describe("factory queue-controller runtime: control mode resolution", () => {
  it("treats a missing factory-control issue as paused", async () => {
    const { result, mocks } = await run({ issues: [] });

    expect(result.mode).toBe("paused");
    expect(result.controlReason).toBe("missing-control-issue");
    expect(mocks.addLabels).not.toHaveBeenCalled();
    expect(mocks.createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it("treats multiple open factory-control issues as paused", async () => {
    const { result } = await run({
      issues: [
        controlIssue(10, ["factory-mode:active"]),
        controlIssue(11, ["factory-mode:active"]),
      ],
    });

    expect(result.mode).toBe("paused");
    expect(result.controlReason).toBe("multiple-control-issues");
  });

  it("treats conflicting mode labels on the control issue as paused", async () => {
    const { result } = await run({
      issues: [controlIssue(10, ["factory-mode:active", "factory-mode:paused"])],
    });

    expect(result.mode).toBe("paused");
    expect(result.controlReason).toBe("conflicting-mode-labels");
  });

  it("treats a control issue with no mode label as paused", async () => {
    const { result } = await run({ issues: [controlIssue(10, [])] });

    expect(result.mode).toBe("paused");
    expect(result.controlReason).toBe("missing-mode-label");
  });
});

describe("factory queue-controller runtime: paused and shadow no-op", () => {
  it("performs no goal/candidate lookups or mutations while paused", async () => {
    const { result, mocks } = await run({
      issues: [controlIssue(10, ["factory-mode:paused"]), goalIssue(1), candidateIssue(100)],
    });

    expect(result.mode).toBe("paused");
    // Only the control-issue lookup should have run.
    expect(mocks.listForRepo).toHaveBeenCalledTimes(1);
    expect(mocks.addLabels).not.toHaveBeenCalled();
    expect(mocks.removeLabel).not.toHaveBeenCalled();
    expect(mocks.createComment).not.toHaveBeenCalled();
    expect(mocks.createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it("evaluates selection in shadow mode but makes no mutations", async () => {
    const { result, mocks } = await run({
      issues: [controlIssue(10, ["factory-mode:shadow"]), goalIssue(1), candidateIssue(100)],
    });

    expect(result.mode).toBe("shadow");
    expect(result.selected?.number).toBe(100);
    expect(result.dispatched).toBe(false);
    expect(result.claimed).toBe(false);
    expect(mocks.addLabels).not.toHaveBeenCalled();
    expect(mocks.removeLabel).not.toHaveBeenCalled();
    expect(mocks.createComment).not.toHaveBeenCalled();
    expect(mocks.createWorkflowDispatch).not.toHaveBeenCalled();
  });
});

describe("factory queue-controller runtime: active goal resolution", () => {
  it("fails closed when there is no active goal", async () => {
    const { result } = await run({ issues: [controlIssue(10, ["factory-mode:active"])] });

    expect(result.activeGoalReason).toBe("missing-active-goal");
    expect(result.selected).toBeNull();
  });

  it("fails closed when more than one active goal is open", async () => {
    const { result } = await run({
      issues: [controlIssue(10, ["factory-mode:active"]), goalIssue(1), goalIssue(2)],
    });

    expect(result.activeGoalReason).toBe("multiple-active-goals");
  });

  it("fails closed when the goal has no milestone", async () => {
    const { result } = await run({
      issues: [controlIssue(10, ["factory-mode:active"]), goalIssue(1, { milestone: null })],
    });

    expect(result.activeGoalReason).toBe("goal-missing-milestone");
  });

  it("defaults malformed max-WIP/budget fields to zero and blocks all dispatch", async () => {
    const { result } = await run({
      issues: [
        controlIssue(10, ["factory-mode:active"]),
        goalIssue(1, {
          body: goalBody({
            "Maximum active coding-agent sessions": "not-a-number",
            "Assignment budget": "also-not-a-number",
          }),
        }),
        candidateIssue(100),
      ],
    });

    expect(result.activeGoal?.concurrencyLimit).toBe(0);
    expect(result.activeGoal?.dailyBudgetLimit).toBe(0);
    expect(result.selected).toBeNull();
    const rejection = result.rejections.find((entry) => entry.number === 100);
    expect(rejection?.reasons).toEqual(
      expect.arrayContaining(["concurrency-limit-reached", "budget-limit-reached"]),
    );
  });

  it.each<[string, number]>([
    ["0", 0],
    ["1", 1],
    ["2", 2],
  ])("accepts the contract-permitted max-WIP value %s", async (maxWip, expected) => {
    const { result } = await run({
      issues: [
        controlIssue(10, ["factory-mode:active"]),
        goalIssue(1, { body: goalBody({ "Maximum active coding-agent sessions": maxWip }) }),
      ],
    });

    expect(result.activeGoal?.concurrencyLimit).toBe(expected);
    expect(result.activeGoal?.fieldWarnings ?? []).not.toEqual(
      expect.arrayContaining(["goal-max-wip-exceeds-contract-ceiling-defaulted-to-zero"]),
    );
  });

  it("fails closed to zero with a warning when max-WIP exceeds the contract ceiling of 2", async () => {
    const { result, core } = await run({
      issues: [
        controlIssue(10, ["factory-mode:active"]),
        goalIssue(1, { body: goalBody({ "Maximum active coding-agent sessions": "3" }) }),
        candidateIssue(100),
      ],
    });

    expect(result.activeGoal?.concurrencyLimit).toBe(0);
    const rejection = result.rejections.find((entry) => entry.number === 100);
    expect(rejection?.reasons).toContain("concurrency-limit-reached");
    expect(
      (core.warning as jest.Mock).mock.calls.some(([message]: [string]) =>
        message.includes("goal-max-wip-exceeds-contract-ceiling-defaulted-to-zero"),
      ),
    ).toBe(true);
  });

  it("distinguishes an out-of-range max-WIP from a malformed one in its warning", async () => {
    const { core } = await run({
      issues: [
        controlIssue(10, ["factory-mode:active"]),
        goalIssue(1, { body: goalBody({ "Maximum active coding-agent sessions": "100" }) }),
      ],
    });

    expect(
      (core.warning as jest.Mock).mock.calls.some(([message]: [string]) =>
        message.includes("goal-max-wip-exceeds-contract-ceiling-defaulted-to-zero"),
      ),
    ).toBe(true);
    expect(
      (core.warning as jest.Mock).mock.calls.some(([message]: [string]) =>
        message.includes("goal-malformed-max-wip-defaulted-to-zero"),
      ),
    ).toBe(false);
  });
});

describe("factory queue-controller runtime: goal completeness must be human-derived", () => {
  const NARRATIVE_HEADINGS = [
    "Objective",
    "Measurable success condition",
    "Allowed scope",
    "Explicit non-goals",
    "Required evidence",
    "Pause and stop conditions",
  ];

  it.each(NARRATIVE_HEADINGS)("fails closed when the goal is missing the '%s' section", async (heading) => {
    const { result } = await run({
      issues: [
        controlIssue(10, ["factory-mode:active"]),
        goalIssue(1, { body: goalBody({ [heading]: "_No response_" }) }),
      ],
    });

    expect(result.activeGoalReason).toBe("goal-incomplete-narrative");
    expect(result.activeGoal).toBeNull();
  });

  it("fails closed when a Human-only boundaries checkbox is unchecked", async () => {
    const { result } = await run({
      issues: [
        controlIssue(10, ["factory-mode:active"]),
        goalIssue(1, {
          body: goalBody({
            "Human-only boundaries": [
              "- [x] Production deployment remains human-approved.",
              "- [ ] Live-trading enablement remains human-approved.",
              "- [x] Automation may pause itself but may not unpause itself.",
            ].join("\n"),
          }),
        }),
      ],
    });

    expect(result.activeGoalReason).toBe("goal-boundaries-not-fully-checked");
  });

  it("fails closed when the Human-only boundaries section is missing entirely", async () => {
    const { result } = await run({
      issues: [
        controlIssue(10, ["factory-mode:active"]),
        goalIssue(1, { body: goalBody({ "Human-only boundaries": "_No response_" }) }),
      ],
    });

    expect(result.activeGoalReason).toBe("goal-boundaries-not-fully-checked");
  });

  it("fails closed when the goal's own 'Allowed paths' section is missing", async () => {
    const { result } = await run({
      issues: [
        controlIssue(10, ["factory-mode:active"]),
        goalIssue(1, { body: goalBody({ "Allowed paths": "_No response_" }) }),
      ],
    });

    expect(result.activeGoalReason).toBe("goal-invalid-allowed-paths");
    expect(result.activeGoal).toBeNull();
  });

  it("fails closed when the goal's own 'Allowed paths' section has an invalid wildcard/traversal form", async () => {
    const { result } = await run({
      issues: [
        controlIssue(10, ["factory-mode:active"]),
        goalIssue(1, { body: goalBody({ "Allowed paths": "../secrets/**" }) }),
      ],
    });

    expect(result.activeGoalReason).toBe("goal-invalid-allowed-paths");
  });

  it("rejects a candidate whose Allowed paths escape the goal's own scope ceiling", async () => {
    const { result } = await run({
      issues: [
        controlIssue(10, ["factory-mode:active"]),
        goalIssue(1, { body: goalBody({ "Allowed paths": "docs/**" }) }),
        candidateIssue(100), // default Allowed paths: src/foo.ts, outside docs/**
      ],
    });

    const rejection = result.rejections.find((entry) => entry.number === 100);
    expect(rejection?.reasons).toContain("scope-exceeds-goal");
    expect(result.selected).toBeNull();
  });

  it("fails closed when the goal's own 'Allowed paths' has a non-terminal wildcard form", async () => {
    const { result } = await run({
      issues: [
        controlIssue(10, ["factory-mode:active"]),
        goalIssue(1, { body: goalBody({ "Allowed paths": "src/*.ts" }) }),
      ],
    });

    expect(result.activeGoalReason).toBe("goal-invalid-allowed-paths");
    expect(result.activeGoal).toBeNull();
  });

  it("rejects a candidate that widens its glob beyond a narrower goal ceiling (child-widening)", async () => {
    // The goal only authorizes src/components/**; a candidate claiming the
    // broader src/** is not "contained" even though it superficially looks
    // like a subset of the repo -- containment is glob-width-aware, not
    // just a disjoint-path check.
    const { result } = await run({
      issues: [
        controlIssue(10, ["factory-mode:active"]),
        goalIssue(1, { body: goalBody({ "Allowed paths": "src/components/**" }) }),
        candidateIssue(100, { body: candidateBody({ "Allowed paths": "src/**" }) }),
      ],
    });

    const rejection = result.rejections.find((entry) => entry.number === 100);
    expect(rejection?.reasons).toContain("scope-exceeds-goal");
    expect(result.selected).toBeNull();
  });

  it("accepts a candidate whose exact file nests within a narrower goal glob", async () => {
    const { result } = await run({
      issues: [
        controlIssue(10, ["factory-mode:active"]),
        goalIssue(1, { body: goalBody({ "Allowed paths": "src/components/**" }) }),
        candidateIssue(100, {
          body: candidateBody({ "Allowed paths": "src/components/example.tsx" }),
        }),
      ],
    });

    expect(result.selected?.number).toBe(100);
    expect(result.selected?.allowedPaths).toEqual(["src/components/example.tsx"]);
  });

  it("accepts a complete goal with all three boundaries checked", async () => {
    const { result } = await run({
      issues: [controlIssue(10, ["factory-mode:active"]), goalIssue(1), candidateIssue(100)],
    });

    expect(result.activeGoal).not.toBeNull();
    expect(result.selected?.number).toBe(100);
  });

  it("fails closed when the current 'factory:goal-approved' label was applied by a bot, not a human", async () => {
    const { result, core } = await run({
      issues: [controlIssue(10, ["factory-mode:active"]), goalIssue(1), candidateIssue(100)],
      timelineByNumber: {
        1: [
          {
            event: "labeled",
            created_at: "2026-08-19T01:00:00Z",
            label: { name: runtime.GOAL_APPROVED_LABEL },
            actor: { type: "Bot", login: "some-workflow[bot]" },
          },
        ],
      },
    });

    expect(result.activeGoal).toBeNull();
    expect(result.activeGoalReason).toBe("goal-approval-not-human-applied");
    expect(result.selected).toBeNull();
    expect(
      (core.warning as jest.Mock).mock.calls.some(([message]: [string]) =>
        message.includes("Automation cannot approve its own scope"),
      ),
    ).toBe(true);
  });

  it("fails closed when no 'labeled' timeline event exists for 'factory:goal-approved'", async () => {
    const { result } = await run({
      issues: [controlIssue(10, ["factory-mode:active"]), goalIssue(1), candidateIssue(100)],
      timelineByNumber: { 1: [] },
    });

    expect(result.activeGoalReason).toBe("goal-approval-not-human-applied");
  });

  it("fails closed when the goal's timeline cannot be read", async () => {
    const { result } = await run({
      issues: [controlIssue(10, ["factory-mode:active"]), goalIssue(1), candidateIssue(100)],
      failTimelineFor: [1],
    });

    expect(result.activeGoalReason).toBe("goal-approval-not-human-applied");
  });

  it("honors the latest re-application of 'factory:goal-approved' after an earlier bot event", async () => {
    const { result } = await run({
      issues: [controlIssue(10, ["factory-mode:active"]), goalIssue(1), candidateIssue(100)],
      timelineByNumber: {
        1: [
          {
            event: "labeled",
            created_at: "2026-08-19T01:00:00Z",
            label: { name: runtime.GOAL_APPROVED_LABEL },
            actor: { type: "Bot", login: "some-workflow[bot]" },
          },
          { event: "unlabeled", label: { name: runtime.GOAL_APPROVED_LABEL }, actor: { type: "Bot" } },
          {
            event: "labeled",
            created_at: "2026-08-19T03:00:00Z",
            label: { name: runtime.GOAL_APPROVED_LABEL },
            actor: { type: "User", login: "human-operator" },
          },
        ],
      },
    });

    expect(result.activeGoal).not.toBeNull();
    expect(result.selected?.number).toBe(100);
  });
});

describe("factory queue-controller runtime: 'factory-mode:active' must be human-applied", () => {
  it("fails closed to paused when 'factory-mode:active' was applied by a bot", async () => {
    const { result, core } = await run({
      issues: [controlIssue(10, ["factory-mode:active"]), goalIssue(1), candidateIssue(100)],
      timelineByNumber: {
        10: [
          {
            event: "labeled",
            label: { name: "factory-mode:active" },
            actor: { type: "Bot", login: "some-workflow[bot]" },
          },
        ],
      },
    });

    expect(result.mode).toBe("paused");
    expect(result.controlReason).toBe("active-mode-not-human-applied");
    expect(result.selected).toBeNull();
    expect(
      (core.warning as jest.Mock).mock.calls.some(([message]: [string]) =>
        message.includes("Automation cannot activate itself"),
      ),
    ).toBe(true);
  });

  it("fails closed to paused when no 'labeled' timeline event exists for 'factory-mode:active'", async () => {
    const { result } = await run({
      issues: [controlIssue(10, ["factory-mode:active"]), goalIssue(1), candidateIssue(100)],
      timelineByNumber: { 10: [] },
    });

    expect(result.mode).toBe("paused");
    expect(result.controlReason).toBe("active-mode-not-human-applied");
  });

  it("fails closed to paused when the control issue's timeline cannot be read", async () => {
    const { result } = await run({
      issues: [controlIssue(10, ["factory-mode:active"]), goalIssue(1), candidateIssue(100)],
      failTimelineFor: [10],
    });

    expect(result.mode).toBe("paused");
    expect(result.controlReason).toBe("active-mode-not-human-applied");
  });

  it("does not require a human timeline event for shadow mode (automation may self-apply it)", async () => {
    const { result } = await run({
      issues: [controlIssue(10, ["factory-mode:shadow"]), goalIssue(1), candidateIssue(100)],
      timelineByNumber: {
        10: [
          {
            event: "labeled",
            label: { name: "factory-mode:shadow" },
            actor: { type: "Bot", login: "some-workflow[bot]" },
          },
        ],
      },
    });

    expect(result.mode).toBe("shadow");
    expect(result.controlReason).toBe("ok");
  });

  it("does not require a human timeline event for paused mode (automation may self-apply it)", async () => {
    const { result } = await run({
      issues: [controlIssue(10, ["factory-mode:paused"])],
      timelineByNumber: { 10: [] },
    });

    expect(result.mode).toBe("paused");
    expect(result.controlReason).toBe("ok");
  });
});

describe("factory queue-controller runtime: native sub-issue goal ancestry", () => {
  it("fails closed when a candidate's native sub-issue parent does not match the active goal", async () => {
    const { result } = await run({
      issues: [controlIssue(10, ["factory-mode:active"]), goalIssue(1), candidateIssue(100)],
      parentGoalByNumber: { 100: 999 },
    });

    const rejection = result.rejections.find((entry) => entry.number === 100);
    expect(rejection?.reasons).toContain("goal-not-approved");
    expect(result.selected).toBeNull();
  });

  it("fails closed when a candidate has no resolvable native sub-issue parent (404)", async () => {
    const { result, core } = await run({
      issues: [controlIssue(10, ["factory-mode:active"]), goalIssue(1), candidateIssue(100)],
      failParentFor: [100],
    });

    const rejection = result.rejections.find((entry) => entry.number === 100);
    expect(rejection?.reasons).toContain("goal-not-approved");
    expect(result.selected).toBeNull();
    expect(
      (core.warning as jest.Mock).mock.calls.some(([message]: [string]) =>
        message.includes("native sub-issue parent"),
      ),
    ).toBe(true);
  });

  it("selects a candidate whose native sub-issue parent matches the active goal", async () => {
    const { result } = await run({
      issues: [controlIssue(10, ["factory-mode:active"]), goalIssue(1), candidateIssue(100)],
      parentGoalByNumber: { 100: 1 },
    });

    expect(result.selected?.number).toBe(100);
  });

  it("fails closed even when the issue body text claims the correct parent goal but native ancestry disagrees", async () => {
    const { result } = await run({
      issues: [
        controlIssue(10, ["factory-mode:active"]),
        goalIssue(1),
        candidateIssue(100, { body: candidateBody({ "Approved parent goal": "#1" }) }),
      ],
      parentGoalByNumber: { 100: 42 },
    });

    expect(result.selected).toBeNull();
    const rejection = result.rejections.find((entry) => entry.number === 100);
    expect(rejection?.reasons).toContain("goal-not-approved");
  });
});

describe("factory queue-controller runtime: human-authorization pure helpers", () => {
  it("findLatestLabelApplicationEvent returns the most recent matching 'labeled' event", () => {
    const events = [
      { event: "labeled", created_at: "2026-08-19T03:00:00Z", label: { name: "factory:goal-approved" }, actor: { type: "User" } },
      { event: "unlabeled", label: { name: "factory:goal-approved" }, actor: { type: "Bot" } },
      { event: "labeled", label: { name: "some-other-label" }, actor: { type: "User" } },
      { event: "labeled", created_at: "2026-08-19T01:00:00Z", label: { name: "factory:goal-approved" }, actor: { type: "Bot" } },
    ];

    const latest = runtime.findLatestLabelApplicationEvent(events, "factory:goal-approved");
    expect(latest?.actor?.type).toBe("User");
  });

  it("findLatestLabelApplicationEvent returns undefined when there is no match", () => {
    expect(runtime.findLatestLabelApplicationEvent([], "factory:goal-approved")).toBeUndefined();
    expect(runtime.findLatestLabelApplicationEvent(undefined, "factory:goal-approved")).toBeUndefined();
  });

  it("isHumanActorType only accepts 'User'", () => {
    expect(runtime.isHumanActorType("User")).toBe(true);
    expect(runtime.isHumanActorType("Bot")).toBe(false);
    expect(runtime.isHumanActorType("App")).toBe(false);
    expect(runtime.isHumanActorType(undefined)).toBe(false);
    expect(runtime.isHumanActorType(null)).toBe(false);
  });

  it("areAllCheckboxesChecked requires at least one checkbox and all of them checked", () => {
    expect(runtime.areAllCheckboxesChecked("- [x] a\n- [X] b\n- [x] c")).toBe(true);
    expect(runtime.areAllCheckboxesChecked("- [x] a\n- [ ] b")).toBe(false);
    expect(runtime.areAllCheckboxesChecked("")).toBe(false);
    expect(runtime.areAllCheckboxesChecked(undefined)).toBe(false);
  });
});

describe("factory queue-controller runtime: assignment-budget accounting", () => {
  function blockedIssueWithParentGoal(number: number, overrides: Partial<MockIssue> = {}): MockIssue {
    return {
      number,
      body: candidateBody(),
      labels: ["blocked"],
      milestone: null,
      assignees: [],
      state: "closed",
      created_at: "2024-01-05T00:00:00Z",
      comments: [],
      ...overrides,
    };
  }

  it("does not count a pre-queue blocked issue that was never claimed", async () => {
    const { result } = await run({
      issues: [
        controlIssue(10, ["factory-mode:active"]),
        goalIssue(1, { body: goalBody({ "Assignment budget": "1" }) }),
        blockedIssueWithParentGoal(500),
        candidateIssue(100),
      ],
    });

    expect(result.selected?.number).toBe(100);
    const rejection = result.rejections.find((entry) => entry.number === 100);
    expect(rejection).toBeUndefined();
  });

  it("counts a blocked issue that carries a valid factory-claim marker", async () => {
    const claim = {
      nonce: "run-0:0:500",
      owner: "other-run",
      issueNumber: 500,
      expiresAt: "2024-01-06T00:00:00.000Z",
    };
    const { result } = await run({
      issues: [
        controlIssue(10, ["factory-mode:active"]),
        goalIssue(1, { body: goalBody({ "Assignment budget": "1" }) }),
        blockedIssueWithParentGoal(500, {
          comments: [{ body: `<!-- factory-claim:v1 ${JSON.stringify(claim)} -->` }],
        }),
        candidateIssue(100),
      ],
    });

    expect(result.selected).toBeNull();
    const rejection = result.rejections.find((entry) => entry.number === 100);
    expect(rejection?.reasons).toContain("budget-limit-reached");
  });

  it("counts a blocked issue that carries a malformed factory-claim marker (fail closed)", async () => {
    const { result } = await run({
      issues: [
        controlIssue(10, ["factory-mode:active"]),
        goalIssue(1, { body: goalBody({ "Assignment budget": "1" }) }),
        blockedIssueWithParentGoal(500, {
          comments: [{ body: "<!-- factory-claim:v1 not-json -->" }],
        }),
        candidateIssue(100),
      ],
    });

    expect(result.selected).toBeNull();
    const rejection = result.rejections.find((entry) => entry.number === 100);
    expect(rejection?.reasons).toContain("budget-limit-reached");
  });

  it("conservatively counts a post-queue issue when its comments cannot be read", async () => {
    const { result } = await run({
      issues: [
        controlIssue(10, ["factory-mode:active"]),
        goalIssue(1, { body: goalBody({ "Assignment budget": "1" }) }),
        blockedIssueWithParentGoal(500),
        candidateIssue(100),
      ],
      failListCommentsFor: [500],
    });

    expect(result.selected).toBeNull();
    const rejection = result.rejections.find((entry) => entry.number === 100);
    expect(rejection?.reasons).toContain("budget-limit-reached");
  });
});

describe("factory queue-controller runtime: pure candidate-section parsing", () => {
  it("parses a well-formed candidate body", () => {
    const sections = runtime.parseCandidateSections(
      {
        number: 100,
        body: candidateBody(),
        labels: ["risk:routine"],
        milestone: null,
        state: "open",
        created_at: NOW,
      },
      1,
    );

    expect(sections.parentGoalNumber).toBe(1);
    expect(sections.parentGoalApproved).toBe(true);
    expect(sections.dependencyNumbers).toEqual([]);
    expect(sections.hasAcceptanceCriteria).toBe(true);
    expect(sections.hasValidationPlan).toBe(true);
    expect(sections.hasScopeDefinition).toBe(true);
    expect(sections.allowedPaths).toEqual(["src/foo.ts"]);
    expect(sections.hasRiskAssessment).toBe(true);
    expect(sections.hasRollbackPlan).toBe(true);
  });

  it("fails closed on a mismatched parent goal", () => {
    const sections = runtime.parseCandidateSections(
      { number: 100, body: candidateBody({ "Approved parent goal": "#2" }), labels: [], milestone: null, state: "open", created_at: NOW },
      1,
    );

    expect(sections.parentGoalNumber).toBe(2);
    expect(sections.parentGoalApproved).toBe(false);
  });

  it("fails closed on an unknown risk-tier value", () => {
    const sections = runtime.parseCandidateSections(
      { number: 100, body: candidateBody({ "Risk tier": "not-a-real-tier" }), labels: [], milestone: null, state: "open", created_at: NOW },
      1,
    );

    expect(sections.hasRiskAssessment).toBe(false);
  });

  it("fails closed when the declared Risk tier does not equal the issue's exactly-one risk label", () => {
    const sections = runtime.parseCandidateSections(
      {
        number: 100,
        body: candidateBody({ "Risk tier": "risk:routine" }),
        labels: ["risk:sensitive"],
        milestone: null,
        state: "open",
        created_at: NOW,
      },
      1,
    );

    expect(sections.hasRiskAssessment).toBe(false);
  });

  it("fails closed when the issue carries zero or multiple risk labels even if the form value is known", () => {
    const noLabel = runtime.parseCandidateSections(
      { number: 100, body: candidateBody(), labels: [], milestone: null, state: "open", created_at: NOW },
      1,
    );
    const twoLabels = runtime.parseCandidateSections(
      {
        number: 100,
        body: candidateBody(),
        labels: ["risk:routine", "risk:sensitive"],
        milestone: null,
        state: "open",
        created_at: NOW,
      },
      1,
    );

    expect(noLabel.hasRiskAssessment).toBe(false);
    expect(twoLabels.hasRiskAssessment).toBe(false);
  });

  it("parses explicit dependency issue numbers", () => {
    const sections = runtime.parseCandidateSections(
      { number: 100, body: candidateBody({ Dependencies: "Blocked by #40 and #41." }), labels: [], milestone: null, state: "open", created_at: NOW },
      1,
    );

    expect(sections.dependencyNumbers).toEqual([40, 41]);
  });

  it("fails closed to null when dependencies are neither None nor numbered", () => {
    const sections = runtime.parseCandidateSections(
      { number: 100, body: candidateBody({ Dependencies: "Some other team owns this." }), labels: [], milestone: null, state: "open", created_at: NOW },
      1,
    );

    expect(sections.dependencyNumbers).toBeNull();
  });

  it("treats a missing required section as incomplete", () => {
    const sections = runtime.parseCandidateSections(
      { number: 100, body: candidateBody({ "Acceptance criteria": "_No response_" }), labels: [], milestone: null, state: "open", created_at: NOW },
      1,
    );

    expect(sections.hasAcceptanceCriteria).toBe(false);
  });

  it("derives priority from exactly one priority:Pn label", () => {
    const p0 = runtime.parseCandidateSections(
      { number: 100, body: candidateBody(), labels: ["priority:P0"], milestone: null, state: "open", created_at: NOW },
      1,
    );
    const p1 = runtime.parseCandidateSections(
      { number: 100, body: candidateBody(), labels: ["priority:P1"], milestone: null, state: "open", created_at: NOW },
      1,
    );
    const p2 = runtime.parseCandidateSections(
      { number: 100, body: candidateBody(), labels: ["priority:P2"], milestone: null, state: "open", created_at: NOW },
      1,
    );

    expect(p0.priority).toBe("P0");
    expect(p1.priority).toBe("P1");
    expect(p2.priority).toBe("P2");
  });

  it("falls back to the default (undefined) priority when zero or multiple priority labels are present", () => {
    const none = runtime.parseCandidateSections(
      { number: 100, body: candidateBody(), labels: [], milestone: null, state: "open", created_at: NOW },
      1,
    );
    const both = runtime.parseCandidateSections(
      {
        number: 100,
        body: candidateBody(),
        labels: ["priority:P0", "priority:P1"],
        milestone: null,
        state: "open",
        created_at: NOW,
      },
      1,
    );
    const unknown = runtime.parseCandidateSections(
      { number: 100, body: candidateBody(), labels: ["priority:P9"], milestone: null, state: "open", created_at: NOW },
      1,
    );

    expect(none.priority).toBeUndefined();
    expect(both.priority).toBeUndefined();
    expect(unknown.priority).toBeUndefined();
  });
});

describe("factory queue-controller runtime: scope definition requires valid Allowed paths", () => {
  it("accepts an exact repo-relative file path", () => {
    const sections = runtime.parseCandidateSections(
      {
        number: 100,
        body: candidateBody({ "Allowed paths": "src/components/example.tsx" }),
        labels: [],
        milestone: null,
        state: "open",
        created_at: NOW,
      },
      1,
    );

    expect(sections.hasScopeDefinition).toBe(true);
    expect(sections.allowedPaths).toEqual(["src/components/example.tsx"]);
    expect(sections.allowedPathsReason).toBeUndefined();
  });

  it("accepts a terminal 'path/**' directory glob", () => {
    const sections = runtime.parseCandidateSections(
      {
        number: 100,
        body: candidateBody({ "Allowed paths": "tests/components/**" }),
        labels: [],
        milestone: null,
        state: "open",
        created_at: NOW,
      },
      1,
    );

    expect(sections.hasScopeDefinition).toBe(true);
    expect(sections.allowedPaths).toEqual(["tests/components/**"]);
  });

  it("accepts multiple lines mixing exact files and terminal globs", () => {
    const sections = runtime.parseCandidateSections(
      {
        number: 100,
        body: candidateBody({
          "Allowed paths": ["src/components/example.tsx", "tests/components/**"].join("\n"),
        }),
        labels: [],
        milestone: null,
        state: "open",
        created_at: NOW,
      },
      1,
    );

    expect(sections.hasScopeDefinition).toBe(true);
    expect(sections.allowedPaths).toEqual(["src/components/example.tsx", "tests/components/**"]);
  });

  it("fails closed when Allowed paths is missing entirely", () => {
    const sections = runtime.parseCandidateSections(
      {
        number: 100,
        body: candidateBody({ "Allowed paths": "_No response_" }),
        labels: [],
        milestone: null,
        state: "open",
        created_at: NOW,
      },
      1,
    );

    expect(sections.hasScopeDefinition).toBe(false);
    expect(sections.allowedPaths).toEqual([]);
    expect(sections.allowedPathsReason).toBe("allowed-paths-not-string");
  });

  it("fails closed on a non-terminal wildcard form", () => {
    const sections = runtime.parseCandidateSections(
      {
        number: 100,
        body: candidateBody({ "Allowed paths": "src/*.ts" }),
        labels: [],
        milestone: null,
        state: "open",
        created_at: NOW,
      },
      1,
    );

    expect(sections.hasScopeDefinition).toBe(false);
    expect(sections.allowedPaths).toEqual([]);
    expect(sections.allowedPathsReason).toBe("invalid-allowed-path:src/*.ts");
  });

  it("fails closed on a directory traversal form", () => {
    const sections = runtime.parseCandidateSections(
      {
        number: 100,
        body: candidateBody({ "Allowed paths": "../secrets/config.json" }),
        labels: [],
        milestone: null,
        state: "open",
        created_at: NOW,
      },
      1,
    );

    expect(sections.hasScopeDefinition).toBe(false);
    expect(sections.allowedPaths).toEqual([]);
    expect(sections.allowedPathsReason).toBe("invalid-allowed-path:../secrets/config.json");
  });

  it("fails closed when 'Scope and non-goals' is empty even if Allowed paths is valid", () => {
    const sections = runtime.parseCandidateSections(
      {
        number: 100,
        body: candidateBody({ "Scope and non-goals": "_No response_" }),
        labels: [],
        milestone: null,
        state: "open",
        created_at: NOW,
      },
      1,
    );

    expect(sections.hasScopeDefinition).toBe(false);
    // Allowed paths itself still parses fine -- only the combined
    // "readiness" flag fails closed.
    expect(sections.allowedPaths).toEqual(["src/foo.ts"]);
  });

  it("rejects a full-pipeline candidate with an invalid Allowed paths section", async () => {
    const { result } = await run({
      issues: [
        controlIssue(10, ["factory-mode:active"]),
        goalIssue(1),
        candidateIssue(100, { body: candidateBody({ "Allowed paths": "src/**/*.ts" }) }),
      ],
    });

    const rejection = result.rejections.find((entry) => entry.number === 100);
    expect(rejection?.reasons).toContain("readiness-incomplete:hasScopeDefinition");
    expect(result.selected).toBeNull();
  });

  it("includes the normalized allowedPaths on the selected candidate for audit", async () => {
    const { result } = await run({
      issues: [
        controlIssue(10, ["factory-mode:shadow"]),
        goalIssue(1),
        candidateIssue(100, {
          body: candidateBody({ "Allowed paths": ["src/foo.ts", "tests/foo/**"].join("\n") }),
        }),
      ],
    });

    expect(result.selected?.number).toBe(100);
    expect(result.selected?.allowedPaths).toEqual(["src/foo.ts", "tests/foo/**"]);
  });
});

describe("factory queue-controller runtime: duplicate issue-form headings fail closed", () => {
  it("extractIssueFormSections omits any heading that renders more than once", () => {
    const body = renderForm([
      ["Risk tier", "risk:routine"],
      ["Approved parent goal", "#1"],
      ["Risk tier", "risk:boundary"],
    ]);

    const sections = runtime.extractIssueFormSections(body);
    expect(runtime.getIssueFormSection(sections, "Risk tier")).toBeUndefined();
    expect(runtime.getIssueFormSection(sections, "Approved parent goal")).toBe("#1");
  });

  it("does not silently accept the last value when duplicated values happen to agree", () => {
    const body = renderForm([
      ["Approved parent goal", "#1"],
      ["Approved parent goal", "#1"],
    ]);

    const sections = runtime.extractIssueFormSections(body);
    // Even matching duplicate values are unusable -- a duplicate heading is
    // itself the failure signal, not just a value mismatch.
    expect(runtime.getIssueFormSection(sections, "Approved parent goal")).toBeUndefined();
  });

  it.each([
    ["Allowed paths", "src/foo.ts", "src/bar.ts"],
    ["Risk tier", "risk:routine", "risk:boundary"],
    ["Approved parent goal", "#1", "#2"],
    ["Dependencies", "None", "#40"],
  ] as Array<[string, string, string]>)(
    "fails closed on a duplicate '%s' heading in a candidate body",
    (heading, firstValue, secondValue) => {
      const sections = runtime.parseCandidateSections(
        {
          number: 100,
          body: candidateBodyWithDuplicateHeading(heading, firstValue, secondValue),
          labels: ["risk:routine"],
          milestone: null,
          state: "open",
          created_at: NOW,
        },
        1,
      );

      if (heading === "Allowed paths") {
        expect(sections.hasScopeDefinition).toBe(false);
        expect(sections.allowedPaths).toEqual([]);
      }
      if (heading === "Risk tier") {
        expect(sections.hasRiskAssessment).toBe(false);
      }
      if (heading === "Approved parent goal") {
        expect(sections.parentGoalNumber).toBeUndefined();
        expect(sections.parentGoalApproved).toBe(false);
      }
      if (heading === "Dependencies") {
        expect(sections.dependencyNumbers).toBeNull();
      }
    },
  );

  it("rejects a full-pipeline candidate whose 'Approved parent goal' heading is duplicated (even with matching values)", async () => {
    const { result } = await run({
      issues: [
        controlIssue(10, ["factory-mode:active"]),
        goalIssue(1),
        candidateIssue(100, {
          body: candidateBodyWithDuplicateHeading("Approved parent goal", "#1", "#1"),
        }),
      ],
    });

    const rejection = result.rejections.find((entry) => entry.number === 100);
    expect(rejection?.reasons).toEqual(
      expect.arrayContaining(["goal-not-approved", "missing-parent-goal"]),
    );
    expect(result.selected).toBeNull();
  });

  it("rejects a full-pipeline candidate whose 'Dependencies' heading is duplicated", async () => {
    const { result } = await run({
      issues: [
        controlIssue(10, ["factory-mode:active"]),
        goalIssue(1),
        candidateIssue(100, {
          body: candidateBodyWithDuplicateHeading("Dependencies", "None", "None"),
        }),
      ],
    });

    const rejection = result.rejections.find((entry) => entry.number === 100);
    expect(rejection?.reasons).toContain("dependencies-unknown");
    expect(result.selected).toBeNull();
  });

  it("fails the whole goal closed when a required narrative heading is duplicated", async () => {
    const { result } = await run({
      issues: [
        controlIssue(10, ["factory-mode:active"]),
        goalIssue(1, {
          body: goalBodyWithDuplicateHeading("Objective", "Ship it.", "Ship it again."),
        }),
      ],
    });

    expect(result.activeGoalReason).toBe("goal-incomplete-narrative");
    expect(result.activeGoal).toBeNull();
  });

  it("fails the goal's own Allowed paths closed when its heading is duplicated", async () => {
    const { result } = await run({
      issues: [
        controlIssue(10, ["factory-mode:active"]),
        goalIssue(1, {
          body: goalBodyWithDuplicateHeading("Allowed paths", "src/**", "tests/**"),
        }),
      ],
    });

    expect(result.activeGoalReason).toBe("goal-invalid-allowed-paths");
    expect(result.activeGoal).toBeNull();
  });

  it("defaults max-WIP to zero (per-field, with a warning) when its heading is duplicated on the goal", async () => {
    const { result, core } = await run({
      issues: [
        controlIssue(10, ["factory-mode:active"]),
        goalIssue(1, {
          body: goalBodyWithDuplicateHeading("Maximum active coding-agent sessions", "1", "2"),
        }),
        candidateIssue(100),
      ],
    });

    expect(result.activeGoal?.concurrencyLimit).toBe(0);
    const rejection = result.rejections.find((entry) => entry.number === 100);
    expect(rejection?.reasons).toContain("concurrency-limit-reached");
    expect(
      (core.warning as jest.Mock).mock.calls.some(([message]: [string]) =>
        message.includes("goal-malformed-max-wip-defaulted-to-zero"),
      ),
    ).toBe(true);
  });
});

describe("factory queue-controller runtime: dependency/sub-issue/PR API failures fail closed", () => {
  it("rejects a candidate when a dependency lookup fails", async () => {
    const { result } = await run({
      issues: [
        controlIssue(10, ["factory-mode:active"]),
        goalIssue(1),
        candidateIssue(100, { body: candidateBody({ Dependencies: "#900" }) }),
      ],
      failDependencyFetchFor: [900],
    });

    const rejection = result.rejections.find((entry) => entry.number === 100);
    expect(rejection?.reasons).toContain("dependencies-unknown");
    expect(result.selected).toBeNull();
  });

  it("rejects a candidate as non-leaf when the sub-issues lookup fails", async () => {
    const { result } = await run({
      issues: [controlIssue(10, ["factory-mode:active"]), goalIssue(1), candidateIssue(100)],
      failSubIssuesFor: [100],
    });

    const rejection = result.rejections.find((entry) => entry.number === 100);
    expect(rejection?.reasons).toContain("not-open-leaf");
    expect(result.selected).toBeNull();
  });

  it("rejects a leaf candidate that has an open sub-issue", async () => {
    const { result } = await run({
      issues: [controlIssue(10, ["factory-mode:active"]), goalIssue(1), candidateIssue(100)],
      subIssuesByNumber: { 100: [{ state: "open" }] },
    });

    const rejection = result.rejections.find((entry) => entry.number === 100);
    expect(rejection?.reasons).toContain("not-open-leaf");
  });

  it("treats a candidate as already having an open PR when listing PRs fails", async () => {
    const { result } = await run({
      issues: [controlIssue(10, ["factory-mode:active"]), goalIssue(1), candidateIssue(100)],
      failPullRequestList: true,
    });

    const rejection = result.rejections.find((entry) => entry.number === 100);
    expect(rejection?.reasons).toContain("already-has-open-pull-request");
  });

  it("treats a candidate as already having an open PR with an exact Refs match", async () => {
    const { result } = await run({
      issues: [controlIssue(10, ["factory-mode:active"]), goalIssue(1), candidateIssue(100)],
      pullRequests: [{ body: "Implements the fix.\n\nRefs #100" }],
    });

    const rejection = result.rejections.find((entry) => entry.number === 100);
    expect(rejection?.reasons).toContain("already-has-open-pull-request");
  });

  it("does not flag an unrelated issue-number prefix as a linked PR", async () => {
    const { result } = await run({
      issues: [controlIssue(10, ["factory-mode:active"]), goalIssue(1), candidateIssue(100)],
      pullRequests: [{ body: "Mentions issue #1002 but not this one." }],
    });

    expect(result.selected?.number).toBe(100);
  });
});

describe("factory queue-controller runtime: malformed claim markers fail closed", () => {
  it("treats an unparseable claim marker as an active, blocking claim", async () => {
    const { result } = await run({
      issues: [
        controlIssue(10, ["factory-mode:active"]),
        goalIssue(1),
        candidateIssue(100, { comments: [{ body: "<!-- factory-claim:v1 not-json -->" }] }),
      ],
    });

    const rejection = result.rejections.find((entry) => entry.number === 100);
    expect(rejection?.reasons).toContain("active-claim");
    expect(result.selected).toBeNull();
  });

  it("does not select a candidate with an existing valid, unexpired claim (no duplicate assignment)", async () => {
    const claim = { nonce: "run-0:0:100", owner: "other-run", issueNumber: 100, expiresAt: "2024-06-01T02:00:00.000Z" };
    const { result, mocks } = await run({
      issues: [
        controlIssue(10, ["factory-mode:active"]),
        goalIssue(1),
        candidateIssue(100, {
          comments: [{ body: `<!-- factory-claim:v1 ${JSON.stringify(claim)} -->` }],
        }),
      ],
    });

    expect(result.selected).toBeNull();
    expect(result.claimed).toBe(false);
    expect(mocks.addLabels).not.toHaveBeenCalled();
    expect(mocks.createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it("reports that an expired claim requires explicit recovery rather than silently reclaiming it", async () => {
    const claim = { nonce: "run-0:0:100", owner: "other-run", issueNumber: 100, expiresAt: "2024-05-31T00:00:00.000Z" };
    const { result, core } = await run({
      issues: [
        controlIssue(10, ["factory-mode:active"]),
        goalIssue(1),
        candidateIssue(100, {
          comments: [{ body: `<!-- factory-claim:v1 ${JSON.stringify(claim)} -->` }],
        }),
      ],
    });

    const rejection = result.rejections.find((entry) => entry.number === 100);
    expect(rejection?.reasons).toContain("stale-claim-requires-recovery");
    expect(result.selected).toBeNull();
    expect(
      (core.warning as jest.Mock).mock.calls.some(([message]: [string]) =>
        message.includes("requires explicit human/lifecycle-reconciler recovery"),
      ),
    ).toBe(true);
  });
});

describe("factory queue-controller runtime: deterministic selection", () => {
  it("selects the oldest eligible candidate when several are eligible", async () => {
    const { result } = await run({
      issues: [
        controlIssue(10, ["factory-mode:shadow"]),
        goalIssue(1),
        candidateIssue(200, { created_at: "2024-02-05T00:00:00Z" }),
        candidateIssue(101, { created_at: "2024-02-01T00:00:00Z" }),
      ],
    });

    expect(result.selected?.number).toBe(101);
    const other = result.rejections.find((entry) => entry.number === 200);
    expect(other?.reasons).toEqual(["lower-priority-than-selected"]);
  });

  it("selects a priority:P0 candidate ahead of an older, unlabeled candidate", async () => {
    const { result } = await run({
      issues: [
        controlIssue(10, ["factory-mode:shadow"]),
        goalIssue(1),
        candidateIssue(101, { created_at: "2024-02-01T00:00:00Z" }),
        candidateIssue(200, {
          created_at: "2024-02-10T00:00:00Z",
          labels: [runtime.READY_LABEL, runtime.FACTORY_LABEL, "risk:routine", "priority:P0"],
        }),
      ],
    });

    expect(result.selected?.number).toBe(200);
  });

  it("does not elevate a candidate carrying conflicting priority labels", async () => {
    const { result } = await run({
      issues: [
        controlIssue(10, ["factory-mode:shadow"]),
        goalIssue(1),
        candidateIssue(101, { created_at: "2024-02-01T00:00:00Z" }),
        candidateIssue(200, {
          created_at: "2024-02-10T00:00:00Z",
          labels: [
            runtime.READY_LABEL,
            runtime.FACTORY_LABEL,
            "risk:routine",
            "priority:P0",
            "priority:P1",
          ],
        }),
      ],
    });

    // #200 has conflicting priority labels, so it falls back to the default
    // rank and loses the createdAt tie-break to the older #101.
    expect(result.selected?.number).toBe(101);
  });
});

describe("factory queue-controller runtime: active-mode claim and dispatch", () => {
  it("claims exactly and dispatches implement-ticket.lock.yml on the default branch", async () => {
    const { result, mocks } = await run({
      issues: [controlIssue(10, ["factory-mode:active"]), goalIssue(1), candidateIssue(100)],
    });

    expect(result.claimed).toBe(true);
    expect(result.dispatched).toBe(true);
    expect(result.blocked).toBe(false);

    expect(mocks.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ owner, repo, issue_number: 100, labels: ["factory:claimed"] }),
    );
    expect(mocks.removeLabel).toHaveBeenCalledWith(
      expect.objectContaining({ owner, repo, issue_number: 100, name: runtime.READY_LABEL }),
    );

    const [[commentParams]] = mocks.createComment.mock.calls as [[ApiParams]];
    expect(commentParams.body).toContain("<!-- factory-claim:v1 ");
    expect(commentParams.body).toContain('"nonce":"run-1:0:100"');
    expect(commentParams.body).toContain('"owner":"queue-controller-test"');

    expect(mocks.createWorkflowDispatch).toHaveBeenCalledWith({
      owner,
      repo,
      workflow_id: runtime.IMPLEMENT_WORKFLOW_ID,
      ref: "main",
      inputs: {
        issue: "100",
        claim_nonce: "run-1:0:100",
        aw_context: JSON.stringify({ item_type: "issue", item_number: 100 }),
      },
    });

    expect(result.claim?.nonce).toBe("run-1:0:100");
  });

  it("selects at most one candidate even when several are eligible", async () => {
    const { mocks } = await run({
      issues: [
        controlIssue(10, ["factory-mode:active"]),
        goalIssue(1),
        candidateIssue(100, { created_at: "2024-02-01T00:00:00Z" }),
        candidateIssue(200, { created_at: "2024-02-02T00:00:00Z" }),
      ],
    });

    expect(mocks.addLabels).toHaveBeenCalledTimes(1);
    expect(mocks.createWorkflowDispatch).toHaveBeenCalledTimes(1);
    const [[dispatchParams]] = mocks.createWorkflowDispatch.mock.calls as [[ApiParams]];
    expect(dispatchParams.inputs?.issue).toBe("100");
  });
});

describe("factory queue-controller runtime: claim verification failure", () => {
  it("blocks the issue when a post-mutation re-read shows an unexpected label state", async () => {
    const { result, mocks, issuesByNumber } = await run({
      issues: [controlIssue(10, ["factory-mode:active"]), goalIssue(1), candidateIssue(100)],
      staleGetFor: [100],
    });

    expect(result.claimed).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.blockedReason).toBe("claim-verification-label-mismatch");
    expect(result.dispatched).toBe(false);
    expect(mocks.createWorkflowDispatch).not.toHaveBeenCalled();
    expect(mocks.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 100, labels: ["blocked"] }),
    );
    expect(
      mocks.createComment.mock.calls
        .filter(([params]: [ApiParams]) => params.issue_number === 100)
        .at(-1)?.[0],
    ).toEqual(
      expect.objectContaining({ issue_number: 100, body: expect.stringContaining("claim-verification-label-mismatch") }),
    );
    // No claimed+blocked combination: the lifecycle cleanup must have
    // removed "factory:claimed" before/alongside adding "blocked".
    const issue = issuesByNumber.get(100);
    expect(issue?.labels).toContain("blocked");
    expect(issue?.labels).not.toContain(runtime.CLAIMED_LABEL);
  });

  it("blocks the issue when the claim marker cannot be re-read (marker mismatch)", async () => {
    const { result, mocks, issuesByNumber } = await run({
      issues: [controlIssue(10, ["factory-mode:active"]), goalIssue(1), candidateIssue(100)],
      dropLatestCommentOnVerifyFor: [100],
    });

    expect(result.claimed).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.blockedReason).toBe("claim-verification-marker-mismatch");
    expect(mocks.createWorkflowDispatch).not.toHaveBeenCalled();
    const issue = issuesByNumber.get(100);
    expect(issue?.labels).toContain("blocked");
    expect(issue?.labels).not.toContain(runtime.CLAIMED_LABEL);
  });

  it("blocks the issue when the persisted claim marker has a forged/mismatched nonce", async () => {
    const { result, mocks, issuesByNumber } = await run({
      issues: [controlIssue(10, ["factory-mode:active"]), goalIssue(1), candidateIssue(100)],
      tamperClaimNonceOnVerifyFor: [100],
    });

    expect(result.claimed).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.blockedReason).toBe("claim-verification-marker-mismatch");
    expect(mocks.createWorkflowDispatch).not.toHaveBeenCalled();
    const issue = issuesByNumber.get(100);
    expect(issue?.labels).toContain("blocked");
    expect(issue?.labels).not.toContain(runtime.CLAIMED_LABEL);
  });

  it("blocks the issue when more than one lifecycle label is present after mutation", async () => {
    // Simulates external corruption/racing: another workflow concurrently
    // applied a different lifecycle label between our claim mutation and
    // our verification re-read, so the issue ends up with two lifecycle
    // labels (claimed + merged) instead of exactly one.
    const { result, mocks, issuesByNumber } = await run({
      issues: [controlIssue(10, ["factory-mode:active"]), goalIssue(1), candidateIssue(100)],
      injectExtraLifecycleLabelFor: { 100: "factory:merged" },
    });

    expect(result.claimed).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.blockedReason).toBe("claim-verification-label-mismatch");
    expect(mocks.createWorkflowDispatch).not.toHaveBeenCalled();
    const issue = issuesByNumber.get(100);
    expect(issue?.labels).toContain("blocked");
    expect(issue?.labels).not.toContain(runtime.CLAIMED_LABEL);
  });

  it("never restores ready-for-ai-dev automatically after a blocked claim", async () => {
    const { result, issuesByNumber } = await run({
      issues: [controlIssue(10, ["factory-mode:active"]), goalIssue(1), candidateIssue(100)],
      staleGetFor: [100],
    });

    expect(result.blocked).toBe(true);
    const issue = issuesByNumber.get(100);
    expect(issue?.labels).toContain("blocked");
    expect(issue?.labels).not.toContain(runtime.READY_LABEL);
    expect(issue?.labels).not.toContain(runtime.CLAIMED_LABEL);
  });
});

describe("factory queue-controller runtime: markBlocked lifecycle-label cleanup", () => {
  it("ignores label-not-found responses while removing other lifecycle labels", async () => {
    const { result, mocks, core, issuesByNumber } = await run({
      issues: [controlIssue(10, ["factory-mode:active"]), goalIssue(1), candidateIssue(100)],
      staleGetFor: [100],
    });

    expect(result.blocked).toBe(true);
    // Every lifecycle label except "blocked" was attempted; almost all are
    // 404s (not present) and must be silently ignored (no warning at all
    // in this scenario), yet "blocked" still gets applied successfully.
    expect(mocks.removeLabel.mock.calls.length).toBeGreaterThan(1);
    const issue = issuesByNumber.get(100);
    expect(issue?.labels).toContain("blocked");
    expect(
      (core.warning as jest.Mock).mock.calls.some(([message]: [string]) =>
        message.includes("Failed to remove lifecycle label"),
      ),
    ).toBe(false);
  });

  it("warns (but still blocks) when a lifecycle-label removal fails for a reason other than not-found", async () => {
    const { result, core, issuesByNumber } = await run({
      issues: [controlIssue(10, ["factory-mode:active"]), goalIssue(1), candidateIssue(100)],
      staleGetFor: [100],
      failRemoveLabelForNames: { 100: [runtime.CLAIMED_LABEL] },
    });

    expect(result.blocked).toBe(true);
    expect(
      (core.warning as jest.Mock).mock.calls.some(([message]: [string]) =>
        message.includes(`Failed to remove lifecycle label "${runtime.CLAIMED_LABEL}"`),
      ),
    ).toBe(true);
    // "blocked" is still applied best-effort even though the claimed-label
    // removal itself failed.
    const issue = issuesByNumber.get(100);
    expect(issue?.labels).toContain("blocked");
  });
});

describe("factory queue-controller runtime: dispatch failure blocks and does not select another item", () => {
  it("blocks the claimed issue when dispatch fails and does not attempt a second candidate", async () => {
    const { result, mocks, issuesByNumber } = await run({
      issues: [
        controlIssue(10, ["factory-mode:active"]),
        goalIssue(1),
        candidateIssue(100, { created_at: "2024-02-01T00:00:00Z" }),
        candidateIssue(200, { created_at: "2024-02-02T00:00:00Z" }),
      ],
      failDispatchFor: [100],
    });

    expect(result.claimed).toBe(true);
    expect(result.dispatched).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.blockedReason).toBe("dispatch-failed");
    expect(mocks.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 100, labels: ["blocked"] }),
    );
    // Only the originally selected issue is ever touched -- no fallback to #200.
    expect(mocks.addLabels).not.toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 200 }),
    );
    expect(mocks.createWorkflowDispatch).toHaveBeenCalledTimes(1);
    // The exactly-one-lifecycle-label invariant holds: "blocked" replaced
    // "factory:claimed" rather than coexisting with it.
    const issue = issuesByNumber.get(100);
    expect(issue?.labels).toContain("blocked");
    expect(issue?.labels).not.toContain(runtime.CLAIMED_LABEL);
    // The circuit breaker also trips: the control issue is paused so a
    // repeat trigger does not keep attempting dispatch.
    expect(result.autoPaused).toBe(true);
    expect(result.autoPauseReason).toBe("dispatch-failed");
    const controlIssue10 = issuesByNumber.get(10);
    expect(controlIssue10?.labels).toContain(runtime.PAUSED_MODE_LABEL);
    expect(controlIssue10?.labels).not.toContain("factory-mode:active");
  });
});

describe("factory queue-controller runtime: circuit breaker auto-pauses the factory", () => {
  it("pauses the control issue and posts an audit comment when claim verification fails", async () => {
    const { result, mocks, issuesByNumber } = await run({
      issues: [controlIssue(10, ["factory-mode:active"]), goalIssue(1), candidateIssue(100)],
      staleGetFor: [100],
    });

    expect(result.autoPaused).toBe(true);
    expect(result.autoPauseReason).toBe("claim-verification-label-mismatch");
    const controlIssue10 = issuesByNumber.get(10);
    expect(controlIssue10?.labels).toEqual(
      expect.arrayContaining([runtime.CONTROL_LABEL, runtime.PAUSED_MODE_LABEL]),
    );
    expect(controlIssue10?.labels).not.toContain("factory-mode:active");
    // Exactly one mode label survives.
    const modeLabels = (controlIssue10?.labels ?? []).filter((label) => runtime.MODE_LABELS.includes(label));
    expect(modeLabels).toEqual([runtime.PAUSED_MODE_LABEL]);

    const auditComment = mocks.createComment.mock.calls.find(
      ([params]: [ApiParams]) => params.issue_number === 10,
    )?.[0] as ApiParams | undefined;
    expect(auditComment?.body).toContain(runtime.PAUSED_MODE_LABEL);
    expect(auditComment?.body).toContain("claim-verification-label-mismatch");
    expect(auditComment?.body).toContain("can never unpause it");
  });

  it("pauses the control issue when the default-branch lookup fails", async () => {
    const { result, issuesByNumber } = await run(
      {
        issues: [controlIssue(10, ["factory-mode:active"]), goalIssue(1), candidateIssue(100)],
        failReposGet: true,
      },
      { defaultBranch: undefined },
    );

    expect(result.claimed).toBe(true);
    expect(result.dispatched).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.blockedReason).toBe("default-branch-lookup-failed");
    expect(result.autoPaused).toBe(true);
    expect(result.autoPauseReason).toBe("default-branch-lookup-failed");
    const controlIssue10 = issuesByNumber.get(10);
    expect(controlIssue10?.labels).toContain(runtime.PAUSED_MODE_LABEL);
    expect(controlIssue10?.labels).not.toContain("factory-mode:active");
  });

  it("pauses the control issue before selecting or dispatching any candidate when a stale claim is observed", async () => {
    const staleClaim = {
      nonce: "run-0:0:900",
      owner: "other-run",
      issueNumber: 900,
      expiresAt: "2024-05-31T00:00:00.000Z",
    };
    const { result, mocks, issuesByNumber } = await run({
      issues: [
        controlIssue(10, ["factory-mode:active"]),
        goalIssue(1),
        candidateIssue(900, {
          comments: [{ body: `<!-- factory-claim:v1 ${JSON.stringify(staleClaim)} -->` }],
        }),
        candidateIssue(100), // otherwise perfectly eligible
      ],
    });

    expect(result.autoPaused).toBe(true);
    expect(result.autoPauseReason).toBe("stale-claim-requires-recovery");
    // No claim/dispatch attempt was made on the otherwise-eligible #100 --
    // the breaker trips *before* any selection is acted on.
    expect(result.claimed).toBe(false);
    expect(result.dispatched).toBe(false);
    expect(mocks.addLabels).not.toHaveBeenCalledWith(expect.objectContaining({ issue_number: 100 }));
    expect(mocks.removeLabel).not.toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 100, name: runtime.READY_LABEL }),
    );
    expect(mocks.createWorkflowDispatch).not.toHaveBeenCalled();
    const controlIssue10 = issuesByNumber.get(10);
    expect(controlIssue10?.labels).toContain(runtime.PAUSED_MODE_LABEL);
    expect(controlIssue10?.labels).not.toContain("factory-mode:active");
  });

  it("does not trip the breaker in shadow mode even when a stale claim is present (shadow stays mutation-free)", async () => {
    const staleClaim = {
      nonce: "run-0:0:900",
      owner: "other-run",
      issueNumber: 900,
      expiresAt: "2024-05-31T00:00:00.000Z",
    };
    const { result, mocks } = await run({
      issues: [
        controlIssue(10, ["factory-mode:shadow"]),
        goalIssue(1),
        candidateIssue(900, {
          comments: [{ body: `<!-- factory-claim:v1 ${JSON.stringify(staleClaim)} -->` }],
        }),
      ],
    });

    expect(result.mode).toBe("shadow");
    expect(result.autoPaused).toBe(false);
    expect(result.autoPauseReason).toBeNull();
    expect(mocks.addLabels).not.toHaveBeenCalled();
    expect(mocks.removeLabel).not.toHaveBeenCalled();
    expect(mocks.createComment).not.toHaveBeenCalled();
    expect(mocks.createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it("ignores label-not-found responses while replacing the mode label and keeps exactly one mode label", async () => {
    const { issuesByNumber, core } = await run({
      issues: [controlIssue(10, ["factory-mode:active"]), goalIssue(1), candidateIssue(100)],
      staleGetFor: [100],
    });

    const controlIssue10 = issuesByNumber.get(10);
    const modeLabels = (controlIssue10?.labels ?? []).filter((label) => runtime.MODE_LABELS.includes(label));
    expect(modeLabels).toEqual([runtime.PAUSED_MODE_LABEL]);
    // "factory-mode:shadow" was never present on the control issue, so its
    // removal attempt 404s and must be silently ignored (no warning).
    expect(
      (core.warning as jest.Mock).mock.calls.some(([message]: [string]) =>
        message.includes('Failed to remove mode label "factory-mode:shadow"'),
      ),
    ).toBe(false);
  });

  it("warns but still pauses when removing the current mode label fails for a reason other than not-found", async () => {
    const { result, issuesByNumber, core } = await run({
      issues: [controlIssue(10, ["factory-mode:active"]), goalIssue(1), candidateIssue(100)],
      staleGetFor: [100],
      failRemoveLabelForNames: { 10: ["factory-mode:active"] },
    });

    expect(result.autoPaused).toBe(true);
    expect(
      (core.warning as jest.Mock).mock.calls.some(([message]: [string]) =>
        message.includes('Failed to remove mode label "factory-mode:active"'),
      ),
    ).toBe(true);
    // "factory-mode:paused" is still applied best-effort even though the
    // old mode label's removal itself failed.
    const controlIssue10 = issuesByNumber.get(10);
    expect(controlIssue10?.labels).toContain(runtime.PAUSED_MODE_LABEL);
  });

  it("never applies 'factory-mode:active' -- automation may only ever pause, not unpause", async () => {
    const { mocks } = await run({
      issues: [controlIssue(10, ["factory-mode:active"]), goalIssue(1), candidateIssue(100)],
      staleGetFor: [100],
    });

    expect(mocks.addLabels).not.toHaveBeenCalledWith(
      expect.objectContaining({ labels: expect.arrayContaining(["factory-mode:active"]) }),
    );
  });
});

describe("factory queue-controller runtime: 'now' validation fails closed", () => {
  it("refuses to select, claim, or dispatch when 'now' is not a valid timestamp", async () => {
    const { result, mocks } = await run(
      {
        issues: [
          controlIssue(10, ["factory-mode:active"]),
          goalIssue(1),
          candidateIssue(100, { created_at: "2024-02-01T00:00:00Z" }),
        ],
      },
      { now: "not-a-real-timestamp" },
    );

    expect(result.timeValid).toBe(false);
    expect(result.selected).toBeNull();
    expect(result.claimed).toBe(false);
    expect(result.dispatched).toBe(false);
    expect(result.blocked).toBe(false);
    expect(mocks.addLabels).not.toHaveBeenCalled();
    expect(mocks.removeLabel).not.toHaveBeenCalled();
    expect(mocks.createComment).not.toHaveBeenCalled();
    expect(mocks.createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it("does not throw and reports timeValid: true for a well-formed 'now'", async () => {
    const { result } = await run({
      issues: [controlIssue(10, ["factory-mode:paused"])],
    });

    expect(result.timeValid).toBe(true);
  });

  it("validates 'now' via the exported isValidTimestamp helper", () => {
    expect(runtime.isValidTimestamp("2024-06-01T00:00:00.000Z")).toBe(true);
    expect(runtime.isValidTimestamp("not-a-real-timestamp")).toBe(false);
    expect(runtime.isValidTimestamp("")).toBe(false);
    expect(runtime.isValidTimestamp(undefined)).toBe(false);
  });
});
