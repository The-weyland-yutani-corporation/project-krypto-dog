export {};

type FindingLevel = "blocker" | "warning" | "pass";

interface Finding {
  level: FindingLevel;
  code: string;
  message: string;
  details?: unknown;
}

interface ReadinessReport {
  readOnly: boolean;
  controlMode: string;
  readiness: {
    baseline: { evaluated: boolean; ready: boolean };
    canary: { evaluated: boolean; ready: boolean | null };
    activation: {
      evaluated: boolean;
      ready: boolean | null;
      requiresHumanModeChange: boolean;
    };
    selected: { mode: string | null; ready: boolean };
  };
  findings: Finding[];
}

interface ReadinessModule {
  REQUIRED_FACTORY_SOURCE_PATHS: string[];
  REQUIRED_FACTORY_WORKFLOW_PATHS: string[];
  DEV_WORKFLOW_NAME: string;
  DEV_WORKFLOW_PATH: string;
  DEV_SUCCESS_DESCRIPTION: string;
  DEVELOPMENT_BRANCH_POLICIES: string[];
  CANARY_PATH: string;
  parseWorkflowInputs(input?: unknown): any;
  parseIssueCommentCommand(body?: unknown): any;
  computeGoalAuthorizationDigest(issue: unknown): {
    valid: boolean;
    digest: string | null;
  };
  evaluateFactoryReadiness(snapshot: unknown): ReadinessReport;
  formatReadinessSummary(report: ReadinessReport): string;
}

const readiness = jest.requireActual<ReadinessModule>(
  "../../.github/scripts/agentic-factory-readiness.cjs",
);
const lifecycle = jest.requireActual<{
  DEV_EVIDENCE_STATUS_CONTEXT: string;
  DEV_ENVIRONMENT: string;
}>("../../.github/scripts/agentic-lifecycle-reconciler.cjs");

const SHA = "a".repeat(40);
const STALE_SHA = "b".repeat(40);
const OBSERVED_AT = "2026-08-20T00:00:00.000Z";
const GOAL_NUMBER = 700;
const CANARY_NUMBER = 701;
const CONTROL_NUMBER = 233;
const RUN_URL = "https://github.com/acme/krypto/actions/runs/400";

function findingCodes(report: ReadinessReport, level?: FindingLevel) {
  return report.findings
    .filter((finding) => level === undefined || finding.level === level)
    .map((finding) => finding.code);
}

function protectedEnvironment(name: string) {
  return {
    readable: true,
    name,
    canAdminsBypass: false,
    protectionRules: [
      {
        type: "required_reviewers",
        prevent_self_review: true,
        reviewers: [{ type: "Team", reviewer: { id: 1 } }],
      },
    ],
    deploymentBranchPolicy: {
      protected_branches: true,
      custom_branch_policies: false,
    },
  };
}

function developmentEnvironment() {
  return {
    readable: true,
    name: lifecycle.DEV_ENVIRONMENT,
    canAdminsBypass: true,
    protectionRules: [{ type: "branch_policy" }],
    deploymentBranchPolicy: {
      protected_branches: false,
      custom_branch_policies: true,
    },
    branchPolicies: readiness.DEVELOPMENT_BRANCH_POLICIES.map((name) => ({
      name,
      type: "branch",
    })),
  };
}

function labelEvent(
  label: string,
  id = 1,
  createdAt = "2026-08-19T22:00:00.000Z",
) {
  return {
    id,
    event: "labeled",
    label: { name: label },
    created_at: createdAt,
    actor: { login: "github-actions[bot]", type: "Bot" },
  };
}

function goalBody(overrides: Record<string, string> = {}) {
  const fields: Array<[string, string]> = [
    ["Objective", "Prove one bounded factory canary."],
    [
      "Measurable success condition",
      "One canary reaches exact-SHA dev evidence.",
    ],
    ["Allowed scope", "The factory heartbeat document only."],
    ["Allowed paths", readiness.CANARY_PATH],
    [
      "Explicit non-goals",
      "No application, trading, deployment, or policy changes.",
    ],
    ["Maximum autonomous risk tier", "risk:routine"],
    ["Maximum active coding-agent sessions", "1"],
    ["Assignment budget", "1"],
    [
      "Required evidence",
      "CI, dev status, and development Deployment.",
    ],
    [
      "Pause and stop conditions",
      "Pause on any failed or ambiguous evidence.",
    ],
    [
      "Human-only boundaries",
      [
        "- [x] Production deployment remains human-approved.",
        "- [x] Live-trading enablement remains human-approved.",
        "- [x] Automation may pause itself but may not unpause itself.",
      ].join("\n"),
    ],
  ];
  return fields
    .map(
      ([heading, value]) =>
        `### ${heading}\n\n${
          Object.hasOwn(overrides, heading) ? overrides[heading] : value
        }`,
    )
    .join("\n\n");
}

function goalIssue(body = goalBody()) {
  return {
    number: GOAL_NUMBER,
    state: "open",
    labels: [
      { name: "agentic-factory" },
      { name: "factory:goal" },
      { name: "factory:goal-approved" },
    ],
    milestone: {
      id: 88,
      number: 8,
      node_id: "MI_kwDOExample",
      title: "Factory canary",
    },
    body,
  };
}

function goalSnapshot(issue = goalIssue()) {
  return {
    issue,
    approvedGoalIssues: [issue],
    timelineEvents: [labelEvent("factory:goal-approved", 20)],
    currentInFlightCount: 0,
    currentBudgetUsed: 0,
  };
}

function canaryCandidate(overrides: Record<string, unknown> = {}) {
  return {
    number: CANARY_NUMBER,
    labels: ["agentic-factory", "ready-for-ai-dev", "risk:routine"],
    milestone: "Factory canary",
    parentGoalNumber: GOAL_NUMBER,
    nativeParentGoalNumber: GOAL_NUMBER,
    parentGoalApproved: true,
    dependencyStates: [],
    state: "open",
    isLeaf: true,
    hasAcceptanceCriteria: true,
    hasValidationPlan: true,
    hasScopeDefinition: true,
    allowedPaths: [readiness.CANARY_PATH],
    hasRiskAssessment: true,
    hasRollbackPlan: true,
    assignees: [],
    hasOpenPullRequest: false,
    hasOpenSession: false,
    activeClaim: null,
    priority: "P0",
    createdAt: "2026-08-19T20:00:00.000Z",
    ...overrides,
  };
}

function actionsCreator() {
  return {
    creator: {
      id: 41898282,
      login: "github-actions[bot]",
      type: "Bot",
    },
    performed_via_github_app: { slug: "github-actions" },
  };
}

function goodEvidence() {
  return {
    sha: SHA,
    commitExists: true,
    ciRuns: [
      {
        id: 100,
        name: "CI",
        path: ".github/workflows/ci.yml",
        event: "push",
        head_sha: SHA,
        head_branch: "main",
        repository: { full_name: "acme/krypto" },
        head_repository: { full_name: "acme/krypto" },
        status: "completed",
        conclusion: "success",
      },
    ],
    devWorkflow: {
      id: 900,
      name: readiness.DEV_WORKFLOW_NAME,
      path: readiness.DEV_WORKFLOW_PATH,
      state: "active",
    },
    devRuns: [
      {
        id: 400,
        workflow_id: 900,
        name: readiness.DEV_WORKFLOW_NAME,
        path: readiness.DEV_WORKFLOW_PATH,
        event: "workflow_run",
        run_attempt: 1,
        head_sha: SHA,
        head_branch: "main",
        repository: { full_name: "acme/krypto" },
        head_repository: { full_name: "acme/krypto" },
        status: "completed",
        conclusion: "success",
        html_url: RUN_URL,
      },
    ],
    statuses: [
      {
        id: 200,
        context: lifecycle.DEV_EVIDENCE_STATUS_CONTEXT,
        state: "success",
        description: readiness.DEV_SUCCESS_DESCRIPTION,
        target_url: RUN_URL,
        ...actionsCreator(),
      },
    ],
    deployments: [
      {
        id: 300,
        sha: SHA,
        environment: lifecycle.DEV_ENVIRONMENT,
        description: readiness.DEV_SUCCESS_DESCRIPTION,
        transient_environment: true,
        production_environment: false,
        ...actionsCreator(),
      },
    ],
    deploymentStatusesByDeployment: {
      300: [
        {
          id: 301,
          state: "success",
          description: readiness.DEV_SUCCESS_DESCRIPTION,
          log_url: RUN_URL,
          ...actionsCreator(),
        },
      ],
    },
    developmentEnvironment: developmentEnvironment(),
  };
}

function baseSnapshot(mode: "baseline" | "canary" = "baseline"): any {
  const issue = goalIssue();
  const goalDigest = readiness.computeGoalAuthorizationDigest(issue).digest;
  const command =
    mode === "baseline"
      ? "/factory-readiness mode=baseline gh-aw-token-attested=true actions-pr-attested=true"
      : `/factory-readiness mode=canary goal=${GOAL_NUMBER} canary=${CANARY_NUMBER} goal-digest=${goalDigest} gh-aw-token-attested=true actions-pr-attested=true`;
  const request = readiness.parseWorkflowInputs(
    readiness.parseIssueCommentCommand(command).inputs,
  );
  const candidate = canaryCandidate();
  return {
    request,
    observedAt: OBSERVED_AT,
    repository: {
      defaultBranch: "main",
      fullName: "acme/krypto",
      defaultBranchSha: SHA,
      finalDefaultBranchSha: SHA,
      defaultBranchProtected: true,
      trustedScriptSha: SHA,
      treePaths: [...readiness.REQUIRED_FACTORY_SOURCE_PATHS],
      treeTruncated: false,
      workflows: readiness.REQUIRED_FACTORY_WORKFLOW_PATHS.map((workflowPath) => ({
        path: workflowPath,
        state: "active",
      })),
    },
    controlIssues: [
      {
        number: CONTROL_NUMBER,
        state: "open",
        labels: [
          { name: "factory-control" },
          { name: "factory-mode:shadow" },
        ],
        timelineEvents: [],
      },
    ],
    invocation: {
      eventName: "issue_comment",
      action: "created",
      runAttempt: 1,
      runId: 5678,
      workflowSha: SHA,
      workflowRef: "refs/heads/main",
      issueNumber: CONTROL_NUMBER,
      isPullRequest: false,
      commentId: 1234,
      commentExists: true,
      commentBodyUnchanged: true,
      commentUnedited: true,
      command: readiness.parseIssueCommentCommand(command),
      approvalEnvironmentName: "factory-control",
      protectedGatePassed: true,
      environment: protectedEnvironment("factory-control"),
    },
    goal: mode === "canary" ? goalSnapshot(issue) : null,
    canary:
      mode === "canary"
        ? {
            candidate,
            queueCandidates: [candidate],
            currentInFlightCount: 0,
            currentBudgetUsed: 0,
          }
        : null,
    evidence: goodEvidence(),
  };
}

describe("agentic factory readiness pure preflight", () => {
  it("strictly parses one-line commands and canonical typed inputs", () => {
    const parsed = readiness.parseIssueCommentCommand(
      `/factory-readiness mode=canary goal=42 canary=43 goal-digest=${"c".repeat(
        64,
      )} sha=${SHA.toUpperCase()} gh-aw-token-attested=true actions-pr-attested=false`,
    );
    expect(parsed).toMatchObject({ recognized: true, valid: true, errors: [] });
    expect(readiness.parseWorkflowInputs(parsed.inputs)).toMatchObject({
      mode: "canary",
      goalIssue: { provided: true, valid: true, value: 42 },
      canaryIssue: { provided: true, valid: true, value: 43 },
      evidenceSha: { provided: true, valid: true, value: SHA },
      goalDigest: {
        provided: true,
        valid: true,
        value: "c".repeat(64),
      },
      attestations: {
        ghAwAgentToken: true,
        actionsCanCreatePullRequests: false,
      },
    });

    for (const malformed of [
      "/factory-readiness mode=baseline mode=canary",
      "/factory-readiness mode=baseline surprise=true",
      "/factory-readiness\nmode=baseline",
      "/factory-readiness goal=1",
      "/factory-readiness mode",
    ]) {
      expect(readiness.parseIssueCommentCommand(malformed).valid).toBe(false);
    }
  });

  it("fails closed deterministically for malformed top-level input", () => {
    const first = readiness.evaluateFactoryReadiness(null);
    expect(readiness.evaluateFactoryReadiness(null)).toEqual(first);
    expect(first.readiness.selected.ready).toBe(false);
    expect(findingCodes(first, "blocker")).toEqual(
      expect.arrayContaining([
        "REQUEST_MODE_INVALID",
        "REQUEST_EVIDENCE_SHA_INVALID",
        "REQUEST_GOAL_DIGEST_INVALID",
        "OBSERVATION_TIME_INVALID",
        "DEFAULT_BRANCH_IDENTITY_INVALID",
        "CONTROL_ISSUE_MISSING",
        "INVOCATION_EVENT_INVALID",
        "ATTEST_GH_AW_AGENT_TOKEN_MISSING",
        "EVIDENCE_SHA_INVALID",
      ]),
    );
  });

  it("passes baseline without emitting ignored goal/canary findings", () => {
    const report = readiness.evaluateFactoryReadiness(baseSnapshot());
    expect(report.readOnly).toBe(true);
    expect(report.readiness.selected).toEqual({
      mode: "baseline",
      ready: true,
    });
    expect(report.readiness.canary.ready).toBeNull();
    expect(findingCodes(report, "blocker")).toEqual([]);
    expect(
      report.findings.some(
        (finding) =>
          finding.code.startsWith("GOAL_") ||
          finding.code.startsWith("CANARY_"),
      ),
    ).toBe(false);
  });

  it("rejects contradictory goal, canary, or digest inputs in baseline", () => {
    const snapshot = baseSnapshot();
    snapshot.request = readiness.parseWorkflowInputs({
      mode: "baseline",
      goalIssue: "700",
      canaryIssue: "701",
      goalDigest: "d".repeat(64),
      ghAwAgentTokenAttested: "true",
      actionsCanCreatePullRequestsAttested: "true",
    });
    const report = readiness.evaluateFactoryReadiness(snapshot);
    expect(findingCodes(report, "blocker")).toContain(
      "BASELINE_CONTRADICTORY_CANARY_INPUTS",
    );
    expect(report.readiness.selected.ready).toBe(false);
  });

  it("passes a fully bounded canary and reports protected digest approval", () => {
    const report = readiness.evaluateFactoryReadiness(baseSnapshot("canary"));
    expect(report.readiness.canary.ready).toBe(true);
    expect(report.readiness.activation).toEqual({
      evaluated: true,
      ready: true,
      requiresHumanModeChange: true,
    });
    expect(findingCodes(report, "blocker")).toEqual([]);
    expect(findingCodes(report, "pass")).toEqual(
      expect.arrayContaining([
        "INVOCATION_PROTECTED_APPROVAL_VALID",
        "GOAL_APPROVAL_DIGEST_MATCH",
        "GOAL_BOUNDARIES_CONFIRMED",
        "GOAL_CANARY_PATH_BOUND_VALID",
        "CANARY_QUEUE_ELIGIBLE",
        "EVIDENCE_DEV_PRODUCER_VALID",
        "EVIDENCE_DEV_STATUS_SUCCESS",
        "EVIDENCE_DEVELOPMENT_DEPLOYMENT_SUCCESS",
      ]),
    );
  });

  it("rejects reruns, stale heads, edited commands, wrong issues, and unprotected approval", () => {
    const snapshot = baseSnapshot();
    snapshot.invocation.runAttempt = 2;
    snapshot.invocation.workflowSha = STALE_SHA;
    snapshot.invocation.commentBodyUnchanged = false;
    snapshot.invocation.commentUnedited = false;
    snapshot.invocation.issueNumber = 999;
    snapshot.invocation.environment.protectionRules = [];
    snapshot.invocation.environment.deploymentBranchPolicy = {
      protected_branches: false,
      custom_branch_policies: true,
    };
    const report = readiness.evaluateFactoryReadiness(snapshot);
    expect(findingCodes(report, "blocker")).toEqual(
      expect.arrayContaining([
        "INVOCATION_RERUN_REJECTED",
        "INVOCATION_DEFAULT_HEAD_MISMATCH",
        "INVOCATION_COMMENT_STALE_OR_EDITED",
        "INVOCATION_CONTROL_ISSUE_MISMATCH",
        "FACTORY_CONTROL_ENVIRONMENT_REVIEWERS_INVALID",
        "FACTORY_CONTROL_ENVIRONMENT_BRANCH_POLICY_INVALID",
        "ATTEST_GH_AW_AGENT_TOKEN_PROTECTED_APPROVAL_MISSING",
      ]),
    );
  });

  it("blocks default-head movement and an unprotected default branch", () => {
    const snapshot = baseSnapshot();
    snapshot.repository.finalDefaultBranchSha = STALE_SHA;
    snapshot.repository.defaultBranchProtected = false;
    const report = readiness.evaluateFactoryReadiness(snapshot);
    expect(findingCodes(report, "blocker")).toEqual(
      expect.arrayContaining([
        "DEFAULT_BRANCH_MOVED_DURING_PREFLIGHT",
        "DEFAULT_BRANCH_NOT_PROTECTED",
        "EVIDENCE_SHA_STALE",
      ]),
    );
  });

  it("fails closed on missing, inactive, ambiguous, and truncated factory inventory", () => {
    const snapshot = baseSnapshot();
    snapshot.repository.treePaths = snapshot.repository.treePaths.slice(1);
    snapshot.repository.treeTruncated = true;
    snapshot.repository.workflows = [
      {
        ...snapshot.repository.workflows[1],
        state: "disabled_manually",
      },
      snapshot.repository.workflows[2],
      { ...snapshot.repository.workflows[2] },
    ];
    const report = readiness.evaluateFactoryReadiness(snapshot);
    expect(findingCodes(report, "blocker")).toEqual(
      expect.arrayContaining([
        "DEFAULT_BRANCH_TREE_TRUNCATED",
        "DEFAULT_BRANCH_FACTORY_FILES_MISSING",
        "DEFAULT_BRANCH_WORKFLOWS_MISSING",
        "DEFAULT_BRANCH_WORKFLOWS_INACTIVE",
        "DEFAULT_BRANCH_WORKFLOWS_AMBIGUOUS",
      ]),
    );
  });

  it("orders active-mode events by timestamp then ID and fails on ambiguity", () => {
    const accepted = baseSnapshot();
    accepted.controlIssues[0].labels = [
      { name: "factory-control" },
      { name: "factory-mode:active" },
    ];
    accepted.controlIssues[0].timelineEvents = [
      labelEvent("factory-mode:active", 1),
      labelEvent("factory-mode:active", 2),
    ];
    expect(
      findingCodes(readiness.evaluateFactoryReadiness(accepted), "blocker"),
    ).toContain("INVOCATION_ACTIVE_EVENT_APPROVAL_MISMATCH");
    accepted.invocation.command = readiness.parseIssueCommentCommand(
      "/factory-readiness mode=baseline active-event=2 gh-aw-token-attested=true actions-pr-attested=true",
    );
    expect(
      findingCodes(readiness.evaluateFactoryReadiness(accepted), "pass"),
    ).toContain("CONTROL_ACTIVE_EVENT_ORDERED");
    expect(
      findingCodes(readiness.evaluateFactoryReadiness(accepted), "pass"),
    ).toContain("INVOCATION_ACTIVE_EVENT_APPROVAL_MATCH");

    accepted.controlIssues[0].timelineEvents.push(
      labelEvent("factory-mode:active", 2),
    );
    expect(
      findingCodes(readiness.evaluateFactoryReadiness(accepted), "blocker"),
    ).toContain("CONTROL_ACTIVE_EVENT_AMBIGUOUS");
  });

  it("binds approval to the canonical current goal and milestone digest", () => {
    const snapshot = baseSnapshot("canary");
    snapshot.goal.issue.body = goalBody({
      Objective: "Edited after protected approval.",
    });
    snapshot.goal.approvedGoalIssues = [snapshot.goal.issue];
    const report = readiness.evaluateFactoryReadiness(snapshot);
    expect(findingCodes(report, "blocker")).toContain(
      "GOAL_APPROVAL_DIGEST_MISMATCH",
    );

    snapshot.goal.issue.milestone.title = "Edited milestone";
    const second = readiness.evaluateFactoryReadiness(snapshot);
    expect(findingCodes(second, "blocker")).toContain(
      "GOAL_APPROVAL_DIGEST_MISMATCH",
    );
  });

  it("rejects incomplete milestone identity, ambiguous approval events, and multiple approved goals", () => {
    const snapshot = baseSnapshot("canary");
    snapshot.goal.issue.milestone.node_id = "";
    snapshot.goal.timelineEvents.push({
      ...snapshot.goal.timelineEvents[0],
    });
    snapshot.goal.approvedGoalIssues.push({
      ...goalIssue(),
      number: GOAL_NUMBER + 1,
    });
    const report = readiness.evaluateFactoryReadiness(snapshot);
    expect(findingCodes(report, "blocker")).toEqual(
      expect.arrayContaining([
        "GOAL_MILESTONE_IDENTITY_INVALID",
        "GOAL_APPROVAL_EVENT_AMBIGUOUS",
        "GOAL_APPROVED_SET_AMBIGUOUS",
      ]),
    );
  });

  it.each([
    ["missing", ""],
    [
      "renamed",
      [
        "- [x] Production deployment remains manually approved.",
        "- [x] Live-trading enablement remains human-approved.",
        "- [x] Automation may pause itself but may not unpause itself.",
      ].join("\n"),
    ],
    [
      "extra",
      [
        "- [x] Production deployment remains human-approved.",
        "- [x] Live-trading enablement remains human-approved.",
        "- [x] Automation may pause itself but may not unpause itself.",
        "- [x] An extra boundary.",
      ].join("\n"),
    ],
    [
      "duplicate",
      [
        "- [x] Production deployment remains human-approved.",
        "- [x] Production deployment remains human-approved.",
        "- [x] Automation may pause itself but may not unpause itself.",
      ].join("\n"),
    ],
    [
      "unchecked",
      [
        "- [ ] Production deployment remains human-approved.",
        "- [x] Live-trading enablement remains human-approved.",
        "- [x] Automation may pause itself but may not unpause itself.",
      ].join("\n"),
    ],
  ])("rejects %s canonical boundary state", (_name, boundaries) => {
    const snapshot = baseSnapshot("canary");
    snapshot.goal.issue.body = goalBody({
      "Human-only boundaries": boundaries,
    });
    snapshot.goal.approvedGoalIssues = [snapshot.goal.issue];
    const digest = readiness.computeGoalAuthorizationDigest(snapshot.goal.issue);
    if (digest.valid) {
      snapshot.request.goalDigest.value = digest.digest;
    }
    const report = readiness.evaluateFactoryReadiness(snapshot);
    expect(findingCodes(report, "blocker")).toContain(
      "GOAL_BOUNDARIES_INVALID",
    );
  });

  it("enforces exact canary path, routine risk, WIP one, and unused budget one", () => {
    const snapshot = baseSnapshot("canary");
    snapshot.goal.issue.body = goalBody({
      "Allowed paths": "docs/e2e/**",
      "Maximum autonomous risk tier": "risk:review-required",
      "Maximum active coding-agent sessions": "2",
      "Assignment budget": "2",
    });
    snapshot.goal.approvedGoalIssues = [snapshot.goal.issue];
    snapshot.request.goalDigest.value =
      readiness.computeGoalAuthorizationDigest(snapshot.goal.issue).digest;
    snapshot.canary.candidate.allowedPaths = ["docs/e2e/**"];
    snapshot.canary.candidate.labels = [
      "agentic-factory",
      "ready-for-ai-dev",
      "risk:review-required",
    ];
    snapshot.canary.queueCandidates = [snapshot.canary.candidate];
    const report = readiness.evaluateFactoryReadiness(snapshot);
    expect(findingCodes(report, "blocker")).toEqual(
      expect.arrayContaining([
        "GOAL_CANARY_PATH_BOUND_INVALID",
        "GOAL_CANARY_RISK_BOUND_INVALID",
        "GOAL_CANARY_WIP_BOUND_INVALID",
        "GOAL_CANARY_ASSIGNMENT_BOUND_INVALID",
        "CANARY_SCOPE_INVALID",
        "CANARY_RISK_INVALID",
      ]),
    );
  });

  it("requires the one WIP and assignment units to remain unused", () => {
    const snapshot = baseSnapshot("canary");
    snapshot.goal.currentInFlightCount = 1;
    snapshot.goal.currentBudgetUsed = 1;
    snapshot.canary.currentInFlightCount = 1;
    snapshot.canary.currentBudgetUsed = 1;
    const report = readiness.evaluateFactoryReadiness(snapshot);
    expect(findingCodes(report, "blocker")).toEqual(
      expect.arrayContaining([
        "GOAL_CANARY_WIP_NOT_EMPTY",
        "GOAL_CANARY_ASSIGNMENT_NOT_EMPTY",
      ]),
    );
  });

  it("fails closed on canary ancestry, leaf, readiness, dependencies, assignee, session, and PR state", () => {
    const snapshot = baseSnapshot("canary");
    Object.assign(snapshot.canary.candidate, {
      nativeParentGoalNumber: 999,
      isLeaf: false,
      hasAcceptanceCriteria: false,
      dependencyStates: ["open"],
      assignees: ["agent"],
      hasOpenSession: true,
      hasOpenPullRequest: true,
    });
    snapshot.canary.queueCandidates = [snapshot.canary.candidate];
    const report = readiness.evaluateFactoryReadiness(snapshot);
    expect(findingCodes(report, "blocker")).toEqual(
      expect.arrayContaining([
        "CANARY_NATIVE_PARENT_INVALID",
        "CANARY_NOT_OPEN_LEAF",
        "CANARY_READINESS_INCOMPLETE",
        "CANARY_DEPENDENCIES_OPEN",
        "CANARY_ASSIGNEE_PRESENT_OR_UNKNOWN",
        "CANARY_SESSION_PRESENT_OR_UNKNOWN",
        "CANARY_PULL_REQUEST_PRESENT_OR_UNKNOWN",
      ]),
    );
  });

  it("blocks malformed claims and competing eligible candidates", () => {
    const snapshot = baseSnapshot("canary");
    snapshot.canary.candidate.activeClaim = {
      issueNumber: CANARY_NUMBER,
      nonce: "bad",
      claimedAt: "not-a-time",
      expiresAt: "not-a-time",
    };
    const competitor = canaryCandidate({
      number: CANARY_NUMBER + 1,
      createdAt: "2026-08-19T19:00:00.000Z",
    });
    snapshot.canary.queueCandidates = [
      snapshot.canary.candidate,
      competitor,
    ];
    const report = readiness.evaluateFactoryReadiness(snapshot);
    expect(findingCodes(report, "blocker")).toEqual(
      expect.arrayContaining([
        "CANARY_CLAIM_MALFORMED",
        "CANARY_COMPETING_ELIGIBLE_ISSUES",
      ]),
    );
  });

  it("distinguishes an expired claim that requires explicit recovery", () => {
    const snapshot = baseSnapshot("canary");
    snapshot.canary.candidate.activeClaim = {
      owner: "agent-a",
      expiresAt: "2026-08-19T00:00:00.000Z",
    };
    snapshot.canary.queueCandidates = [snapshot.canary.candidate];
    expect(
      findingCodes(readiness.evaluateFactoryReadiness(snapshot), "blocker"),
    ).toContain("CANARY_CLAIM_STALE");
  });

  it("verifies exact trusted producer, status creator/App/URL, and Deployment correlation", () => {
    const snapshot = baseSnapshot();
    snapshot.evidence.devRuns[0].path = ".github/workflows/other.yml";
    snapshot.evidence.devRuns[0].run_attempt = 2;
    snapshot.evidence.statuses[0].target_url =
      "https://example.invalid/actions/runs/400";
    snapshot.evidence.statuses[0].creator = {
      login: "maintainer",
      type: "User",
    };
    snapshot.evidence.deploymentStatusesByDeployment[300][0].log_url =
      "https://example.invalid/actions/runs/400";
    const report = readiness.evaluateFactoryReadiness(snapshot);
    expect(findingCodes(report, "blocker")).toEqual(
      expect.arrayContaining([
        "EVIDENCE_DEV_PRODUCER_INVALID",
        "EVIDENCE_DEV_STATUS_INVALID",
        "EVIDENCE_DEVELOPMENT_DEPLOYMENT_INVALID",
      ]),
    );
  });

  it("accepts a trusted manual exact-SHA dev retry without changing the autonomous development boundary", () => {
    const snapshot = baseSnapshot();
    snapshot.evidence.devRuns[0].event = "workflow_dispatch";
    snapshot.evidence.devRuns[0].actor = {
      id: 1,
      login: "maintainer",
      type: "User",
    };
    expect(
      readiness.evaluateFactoryReadiness(snapshot).readiness.selected.ready,
    ).toBe(true);

    snapshot.evidence.devRuns[0].actor = {
      id: 2,
      login: "github-actions[bot]",
      type: "Bot",
    };
    expect(
      findingCodes(readiness.evaluateFactoryReadiness(snapshot), "blocker"),
    ).toContain("EVIDENCE_DEV_PRODUCER_INVALID");
  });

  it("accepts a successful rerun of the trusted automatic dev workflow", () => {
    const snapshot = baseSnapshot();
    snapshot.evidence.devRuns[0].run_attempt = 2;
    expect(
      readiness.evaluateFactoryReadiness(snapshot).readiness.selected.ready,
    ).toBe(true);
  });

  it("requires the exact autonomous development environment boundary", () => {
    const snapshot = baseSnapshot();
    snapshot.evidence.developmentEnvironment.protectionRules = [
      {
        type: "required_reviewers",
        prevent_self_review: true,
        reviewers: [{ type: "User", reviewer: { id: 1 } }],
      },
    ];
    snapshot.evidence.developmentEnvironment.branchPolicies = [
      { name: "main", type: "branch" },
      { name: "v1.0", type: "tag" },
    ];
    const blockers = findingCodes(
      readiness.evaluateFactoryReadiness(snapshot),
      "blocker",
    );
    expect(blockers).toEqual(
      expect.arrayContaining([
        "DEVELOPMENT_ENVIRONMENT_REVIEWERS_UNEXPECTED",
        "DEVELOPMENT_ENVIRONMENT_BRANCH_POLICY_INVALID",
        "EVIDENCE_DEV_PRODUCER_INVALID",
      ]),
    );
  });

  it("requires the factory-control environment to disable administrator bypass", () => {
    const snapshot = baseSnapshot();
    snapshot.invocation.environment.canAdminsBypass = true;
    expect(
      findingCodes(readiness.evaluateFactoryReadiness(snapshot), "blocker"),
    ).toContain("FACTORY_CONTROL_ENVIRONMENT_ADMIN_BYPASS_ENABLED");
  });

  it("fails on ambiguous latest status and correlated Deployments", () => {
    const snapshot = baseSnapshot();
    snapshot.evidence.statuses.push({
      ...snapshot.evidence.statuses[0],
      id: snapshot.evidence.statuses[0].id,
    });
    snapshot.evidence.deployments.push({
      ...snapshot.evidence.deployments[0],
      id: snapshot.evidence.deployments[0].id,
    });
    const report = readiness.evaluateFactoryReadiness(snapshot);
    expect(findingCodes(report, "blocker")).toEqual(
      expect.arrayContaining([
        "EVIDENCE_DEV_STATUS_AMBIGUOUS",
        "EVIDENCE_DEVELOPMENT_DEPLOYMENT_AMBIGUOUS",
      ]),
    );
  });

  it("never infers missing attestations outside the protected approval", () => {
    const snapshot = baseSnapshot();
    snapshot.request.attestations.ghAwAgentToken = false;
    snapshot.request.attestations.actionsCanCreatePullRequests = null;
    const report = readiness.evaluateFactoryReadiness(snapshot);
    expect(findingCodes(report, "blocker")).toEqual(
      expect.arrayContaining([
        "ATTEST_GH_AW_AGENT_TOKEN_MISSING",
        "ATTEST_ACTIONS_PR_CREATION_MALFORMED",
      ]),
    );
  });

  it("escapes and bounds all dynamic Markdown summary values", () => {
    const report = readiness.evaluateFactoryReadiness(baseSnapshot());
    report.findings.push({
      level: "blocker",
      code: "DYNAMIC|`<code>",
      message: "line one\nline two | <script>`",
      details: { payload: "x".repeat(5000), markdown: "|<`" },
    });
    const summary = readiness.formatReadinessSummary(report);
    expect(summary).not.toContain("<script>");
    expect(summary).not.toContain("DYNAMIC|`<code>");
    expect(summary).toContain("DYNAMIC&#124;&#96;&lt;code&gt;");
    expect(summary).toContain("line one line two &#124; &lt;script&gt;&#96;");
    expect(summary.length).toBeLessThan(20000);
  });
});
