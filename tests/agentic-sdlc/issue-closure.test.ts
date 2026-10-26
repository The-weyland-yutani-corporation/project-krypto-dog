import { archive } from "./receipt-archive-fixture";

const reconciler = jest.requireActual<{
  assertNoClosingIssueReferences(input: Record<string, unknown>): Promise<void>;
  getAgentImplementationReference(pullRequest: object, identity: object): { required: boolean; valid: boolean };
  reconcileAgenticPullRequests(input: Record<string, unknown>): Promise<void>;
  verifyAutonomousMergeCandidate(input: Record<string, unknown>): Promise<{ valid: boolean; reason?: string }>;
}>("../../.github/scripts/agentic-pr-reconciler.cjs");
const { mergeVerifiedHead } = jest.requireActual<{
  mergeVerifiedHead(input: Record<string, unknown>): Promise<void>;
}>("../../.github/scripts/agentic-merge.cjs");
const { AGENTIC_POLICY } = jest.requireActual<{
  AGENTIC_POLICY: {
    copilotBotNodeId: string; copilotBotDatabaseId: number;
    autonomy: { goalTitle: string; milestone: string };
  };
}>("../../.github/scripts/agentic-policy.cjs");
const { renderAutonomousGoal } = jest.requireActual<{
  renderAutonomousGoal(): string;
}>("../../.github/scripts/agentic-autonomy.cjs");
const { createDispatchRecord } = jest.requireActual<{
  createDispatchRecord(input: Record<string, unknown>): { correlation: string };
}>("../../.github/scripts/agentic-dispatch.cjs");

const sha = "a".repeat(40);
const target = { number: 8, node_id: "PR_fixture", head: { sha } };
function emptyConnection() {
  return { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
}
const association = () => ({
  totalCount: 1, nodes: [{ number: 10 }],
  pageInfo: { hasNextPage: false, endCursor: "MQ" },
});

function nativeEvidence(overrides: Record<string, unknown> = {}) {
  return {
    repository: {
      nameWithOwner: "o/r",
      pullRequest: {
        id: target.node_id, number: target.number, headRefOid: sha,
        repository: { nameWithOwner: "o/r" },
        closingIssuesReferences: emptyConnection(),
        ...overrides,
      },
    },
  };
}

function guardFixture() {
  const github = {
    graphql: jest.fn(async (_query: string, _variables: object): Promise<unknown> => nativeEvidence()),
    rest: { issues: {
      addLabels: jest.fn(async (_input: { labels: string[] }) => ({})),
      createComment: jest.fn(async (_input: object) => ({})),
    } },
  };
  return { github, owner: "o", repo: "r", pullRequest: target, core: { warning: jest.fn() } };
}

describe("native issue-closure evidence", () => {
  it("accepts only a complete empty connection for the requested repository, PR and head", async () => {
    const fixture = guardFixture();
    await expect(reconciler.assertNoClosingIssueReferences(fixture)).resolves.toBeUndefined();
    expect(fixture.github.graphql).toHaveBeenCalledWith(
      expect.stringContaining("closingIssuesReferences(first: 1, userLinkedOnly: false, excludeUserLinked: false)"),
      { owner: "o", repo: "r", number: 8 },
    );
    expect(fixture.github.rest.issues.addLabels).not.toHaveBeenCalled();
    expect(fixture.github.rest.issues.createComment).not.toHaveBeenCalled();
  });

  const malformedResponses: Array<[string, unknown]> = [
    ["missing response", undefined],
    ["null response", null],
    ["REST-style wrapper", { data: nativeEvidence() }],
    ["partial GraphQL errors", { ...nativeEvidence(), errors: [{ message: "partial query" }] }],
    ["missing repository", {}],
    ["null repository", { repository: null }],
    ["wrong outer repository", { repository: { ...nativeEvidence().repository, nameWithOwner: "other/r" } }],
    ["non-string repository", { repository: { ...nativeEvidence().repository, nameWithOwner: 123 } }],
    ["missing PR", { repository: { nameWithOwner: "o/r" } }],
    ["null PR", { repository: { nameWithOwner: "o/r", pullRequest: null } }],
    ["wrong PR repository", nativeEvidence({ repository: { nameWithOwner: "o/other" } })],
    ["wrong PR number", nativeEvidence({ number: 9 })],
    ["string PR number", nativeEvidence({ number: "8" })],
    ["wrong PR node", nativeEvidence({ id: "PR_other" })],
    ["missing PR node", nativeEvidence({ id: undefined })],
    ["wrong head", nativeEvidence({ headRefOid: "b".repeat(40) })],
    ["missing head", nativeEvidence({ headRefOid: undefined })],
    ["missing connection", nativeEvidence({ closingIssuesReferences: undefined })],
    ["null connection", nativeEvidence({ closingIssuesReferences: null })],
  ];
  const malformedConnections: Array<[string, unknown]> = [
    ["missing count", { ...emptyConnection(), totalCount: undefined }],
    ["string count", { ...emptyConnection(), totalCount: "0" }],
    ["negative count", { ...emptyConnection(), totalCount: -1 }],
    ["fractional count", { ...emptyConnection(), totalCount: 0.5 }],
    ["unsafe count", { ...emptyConnection(), totalCount: Number.MAX_SAFE_INTEGER + 1 }],
    ["missing nodes", { ...emptyConnection(), nodes: undefined }],
    ["null nodes", { ...emptyConnection(), nodes: null }],
    ["missing page metadata", { ...emptyConnection(), pageInfo: undefined }],
    ["missing page flag", { ...emptyConnection(), pageInfo: { endCursor: null } }],
    ["nonboolean page flag", { ...emptyConnection(), pageInfo: { hasNextPage: "false", endCursor: null } }],
    ["missing cursor", { ...emptyConnection(), pageInfo: { hasNextPage: false } }],
    ["nonempty cursor on empty page", { ...emptyConnection(), pageInfo: { hasNextPage: false, endCursor: "MQ" } }],
    ["partial empty page", { ...emptyConnection(), pageInfo: { hasNextPage: true, endCursor: "MQ" } }],
    ["omitted association node", { ...emptyConnection(), totalCount: 1 }],
    ["unadvertised association", { ...emptyConnection(), nodes: [{ number: 10 }] }],
    ["null issue node", { ...association(), nodes: [null] }],
    ["malformed issue node", { ...association(), nodes: [{}] }],
    ["string issue number", { ...association(), nodes: [{ number: "10" }] }],
    ["missing nonempty cursor", { ...association(), pageInfo: { hasNextPage: false, endCursor: null } }],
    ["truncated count", { ...association(), totalCount: 2 }],
  ];

  it.each([
    ...malformedResponses,
    ...malformedConnections.map(([name, closingIssuesReferences]): [string, unknown] =>
      [name, nativeEvidence({ closingIssuesReferences })]),
  ])("blocks and durably reports %s", async (_name, response) => {
    const fixture = guardFixture();
    fixture.github.graphql.mockResolvedValueOnce(response);
    await expect(reconciler.assertNoClosingIssueReferences(fixture)).rejects.toThrow("Native issue-closure safeguard blocked");
    expect(fixture.core.warning).toHaveBeenCalledWith(expect.stringContaining(sha));
    expect(fixture.github.rest.issues.addLabels).toHaveBeenCalledWith({
      owner: "o", repo: "r", issue_number: 8, labels: ["blocked"],
    });
    expect(fixture.github.rest.issues.createComment).toHaveBeenCalledWith(expect.objectContaining({
      issue_number: 8, body: expect.stringContaining("issue-closure-block"),
    }));
    expect(fixture.github.graphql).toHaveBeenCalledTimes(1);
  });

  it.each([1, 2, 101])("rejects %i native associations without paging to seek an empty page", async (count) => {
    const fixture = guardFixture();
    fixture.github.graphql.mockResolvedValueOnce(nativeEvidence({
      closingIssuesReferences: {
        ...association(), totalCount: count, pageInfo: { hasNextPage: count > 1, endCursor: "MQ" },
      },
    }));
    await expect(reconciler.assertNoClosingIssueReferences(fixture)).rejects.toThrow("native-closing-issues-present");
    expect(fixture.github.graphql).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 404, 502])("fails closed on inaccessible native evidence (HTTP %i)", async (status) => {
    const fixture = guardFixture();
    fixture.github.graphql.mockRejectedValueOnce(Object.assign(new Error("private response"), { status }));
    await expect(reconciler.assertNoClosingIssueReferences(fixture)).rejects.toThrow(`HTTP ${status}`);
    expect(fixture.github.rest.issues.createComment).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringContaining("native-closing-issues-read-failed"),
    }));
    expect(fixture.core.warning).not.toHaveBeenCalledWith(expect.stringContaining("private response"));
  });

  it("reports an unavailable GraphQL client instead of assuming no associations", async () => {
    const fixture = guardFixture();
    await expect(reconciler.assertNoClosingIssueReferences({
      ...fixture, github: { rest: fixture.github.rest },
    })).rejects.toThrow("native-closing-issues-read-failed");
    expect(fixture.github.rest.issues.createComment).toHaveBeenCalledTimes(1);
  });

  it.each(["addLabels", "createComment"] as const)("surfaces %s failure while attempting both reports once", async (operation) => {
    const fixture = guardFixture();
    fixture.github.graphql.mockResolvedValueOnce(nativeEvidence({ closingIssuesReferences: association() }));
    fixture.github.rest.issues[operation].mockRejectedValueOnce(new Error("report forbidden"));
    await expect(reconciler.assertNoClosingIssueReferences(fixture)).rejects.toThrow("Could not persist all blocking reports");
    expect(fixture.github.rest.issues.addLabels).toHaveBeenCalledTimes(1);
    expect(fixture.github.rest.issues.createComment).toHaveBeenCalledTimes(1);
  });
});

function controllerFixture() {
  const guard = guardFixture();
  const now = Date.now();
  const claimedAt = new Date(now - 300_000).toISOString();
  const assignedAt = new Date(now - 200_000).toISOString();
  const nonce = "1:1:9";
  const actionsActor = { login: "github-actions[bot]", type: "Bot", id: 41898282, node_id: "MDM6Qm90NDE4OTgyODI=" };
  const assignmentActor = { login: "owner", type: "User", id: 2, node_id: "U_owner" };
  const copilotActor = {
    login: "Copilot", type: "Bot", id: AGENTIC_POLICY.copilotBotDatabaseId,
    node_id: AGENTIC_POLICY.copilotBotNodeId,
  };
  const pullRequest = {
    ...target, state: "open", draft: false, mergeable_state: "clean", auto_merge: null,
    title: "[ai-dev] Improve contributor guide", body: `<!-- factory-claim:${nonce} -->\nRefs #9`,
    labels: [{ name: "agentic-automerge" }, { name: "risk:routine" }],
    base: { ref: "main", repo: { full_name: "o/r" } },
    head: { sha, repo: { full_name: "o/r" } }, user: copilotActor,
  };
  const issue = {
    number: 9, state: "open", assignees: [assignmentActor, copilotActor],
    labels: [{ name: "factory:pr-open" }, { name: "risk:routine" }],
    body: "### Approved parent goal\n\n#7\n\n### Allowed paths\n\ndocs/**",
  };
  const goal = {
    number: 7, state: "open", title: AGENTIC_POLICY.autonomy.goalTitle,
    body: renderAutonomousGoal(), user: actionsActor,
    labels: [{ name: "factory:goal" }, { name: "factory:goal-approved" }, { name: "factory:autonomous-goal" }],
    milestone: { title: AGENTIC_POLICY.autonomy.milestone },
  };
  const assignmentTimeline = [copilotActor, assignmentActor].map((assignee, index) => ({
    id: index + 1, event: "assigned", created_at: assignedAt, actor: assignmentActor, assignee,
  }));
  const comments = [
    {
      id: 91, created_at: claimedAt, user: actionsActor,
      body: `<!-- factory-claim:v1 ${JSON.stringify({
        nonce, owner: "queue-controller:1:1", issueNumber: 9, expiresAt: new Date(now + 3_600_000).toISOString(),
      })} -->`,
    },
    {
      id: 92, created_at: assignedAt, user: actionsActor,
      body: `<!-- factory-assignment:v1 ${JSON.stringify({
        nonce, assignedAt, eventIds: [1, 2], copilotNodeId: copilotActor.node_id,
        assignmentActorNodeId: assignmentActor.node_id,
      })} -->`,
    },
  ];
  const workflows = ["ci.yml", "code-review.lock.yml"];
  const records = workflows.map((workflow) => createDispatchRecord({
    pullNumber: 8, headSha: sha, workflow, runId: 1, runAttempt: 1,
  }));
  const runs = [
    {
      id: 1, run_attempt: 1, event: "schedule", head_branch: "main", status: "completed", conclusion: "success",
      repository: { full_name: "o/r" }, path: ".github/workflows/agentic-pr-reconciler.yml",
      actor: assignmentActor, triggering_actor: assignmentActor, display_title: "Controller",
    },
    ...workflows.map((workflow, index) => ({
      id: index + 2, run_attempt: 1, event: "workflow_dispatch", head_branch: "main", status: "completed",
      conclusion: "success", repository: { full_name: "o/r" }, path: `.github/workflows/${workflow}`,
      actor: actionsActor, triggering_actor: actionsActor, display_title: records[index].correlation,
    })),
  ];
  const checks = ["Quality and evidence gates", "PostgreSQL migrations and execution", "Agentic code review"].map((name, index) => ({
    id: 20 + index, name, head_sha: sha, status: "completed", conclusion: "success",
    app: { slug: "github-actions" }, details_url: `https://github.com/o/r/actions/runs/${index < 2 ? 2 : 3}`,
  }));
  const receipts = [
    { schemaVersion: 1, runId: 1, runAttempt: 1, dispatches: records },
    ...[2, 3].map((runId) => ({
      schemaVersion: 1, runId, runAttempt: 1, pullNumber: 8, headSha: sha,
      checks: checks.filter((check) => check.details_url.endsWith(`/${runId}`))
        .map(({ id, name, conclusion }) => ({ id, name, conclusion })),
    })),
  ];
  const reviews: object[] = [];
  const files = [{ filename: "docs/guides/contributing.md", status: "modified" }];
  const core = { ...guard.core, info: jest.fn() };
  const github = {
    ...guard.github,
    request: jest.fn(async (route: string) => {
      if (route === "GET /user/{account_id}") return { data: copilotActor };
      if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}/parent") return { data: { number: 7 } };
      throw new Error(`Unexpected request: ${route}`);
    }),
    paginate: jest.fn(async (endpoint: string, params: { issue_number?: number; run_id?: number }): Promise<object[]> => {
      switch (endpoint) {
        case "pulls": return [pullRequest];
        case "files": return files;
        case "reviews": return reviews;
        case "commits": return [{ commit: { message: "Fixes #10" } }];
        case "checks": return checks;
        case "controls": return [{ number: 1, labels: [{ name: "factory-mode:active" }] }];
        case "comments": return params.issue_number === 9 ? comments : [];
        case "timeline":
          if (params.issue_number === 9) return assignmentTimeline;
          if (params.issue_number === 1 || params.issue_number === 7) return [{
            event: "labeled", label: { name: "factory-mode:active" }, actor: assignmentActor, created_at: claimedAt,
          }];
          throw new Error(`Unexpected timeline: ${params.issue_number}`);
        case "artifacts": return [{
          id: 100 + (params.run_id ?? 0), expired: false,
          name: params.run_id === 1 ? "factory-dispatches-1" : `factory-receipt-${sha}-1`,
        }];
        default: throw new Error(`Unexpected pagination: ${endpoint}`);
      }
    }),
    rest: {
      issues: {
        ...guard.github.rest.issues,
        listForRepo: "controls", listEventsForTimeline: "timeline", listComments: "comments",
        get: jest.fn(async (params: { issue_number: number }) => {
          if (params.issue_number === 7) return { data: goal };
          if (params.issue_number === 9) return { data: issue };
          throw new Error(`Unexpected issue: ${params.issue_number}`);
        }),
      },
      pulls: {
        list: "pulls", listFiles: "files", listReviews: "reviews", listCommits: "commits",
        get: jest.fn(async () => ({ data: pullRequest })),
        merge: jest.fn(async (_params: object) => ({ data: { merged: true, sha: "b".repeat(40) } })),
        updateBranch: jest.fn(async () => ({})),
      },
      checks: { listForRef: "checks" },
      actions: {
        getWorkflowRun: jest.fn(async (params: { run_id: number }) => ({ data: runs.find((run) => run.id === params.run_id) })),
        listWorkflowRuns: jest.fn(async (params: { workflow_id: string }) => ({
          data: { workflow_runs: runs.filter((run) => run.path === `.github/workflows/${params.workflow_id}`) },
        })),
        listWorkflowRunArtifacts: "artifacts",
        downloadArtifact: jest.fn(async (params: { artifact_id: number }) => ({ data: archive(receipts[params.artifact_id - 101]) })),
        createWorkflowDispatch: jest.fn(async () => ({})),
      },
    },
  };
  github.rest.issues.addLabels.mockImplementation(async ({ labels }) => {
    pullRequest.labels.push(...labels.map((name) => ({ name })));
    return {};
  });
  const onVerifiedMerge = jest.fn(async (_item: { number: number; headSha: string }) => undefined);
  return {
    github, core, owner: "o", repo: "r", serverUrl: "https://github.com", pullRequest, issue, checks, files, reviews,
    assignmentActorNodeId: assignmentActor.node_id, onVerifiedMerge,
    reconciliation: {
      github, core, autonomous: true, onVerifiedMerge,
      assignmentActorNodeId: assignmentActor.node_id,
      context: { repo: { owner: "o", repo: "r", default_branch: "main" }, serverUrl: "https://github.com" },
    },
  };
}

describe("native closure guard across actual controller authorization and publication", () => {
  it("reconciles and publishes an owned no-association PR using each phase's credential", async () => {
    const fixture = controllerFixture();
    fixture.pullRequest.title = "[ai-dev] Fixes #10";
    await reconciler.reconcileAgenticPullRequests(fixture.reconciliation);
    expect(fixture.onVerifiedMerge).toHaveBeenCalledWith({ number: 8, headSha: sha });
    const publisherGraphql = jest.fn(async (): Promise<unknown> => nativeEvidence());
    await mergeVerifiedHead({
      ...fixture, github: { ...fixture.github, graphql: publisherGraphql },
      pullRequest: { number: 8, head: { sha } },
    });
    expect(fixture.github.graphql).toHaveBeenCalledTimes(1);
    expect(publisherGraphql).toHaveBeenCalledTimes(2);
    expect(fixture.github.rest.pulls.merge).toHaveBeenCalledWith({
      owner: "o", repo: "r", pull_number: 8, sha, merge_method: "squash",
      commit_title: "[factory] Merge PR #8",
      commit_message: `Verified head: ${sha}\n\nIssue completion requires exact-source lifecycle evidence.`,
    });
    expect(fixture.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it.each([
    ["body-independent manual association", ""],
    ["additional closing directive", "\nAlso fixes #10."],
    ["negated closing directive", "\nDo not close #10."],
    ["repeated ordinary reference", "\nRefs #9"],
  ])("blocks a valid claim/reference with a %s", async (_name, suffix) => {
    const fixture = controllerFixture();
    fixture.pullRequest.body += suffix;
    expect(reconciler.getAgentImplementationReference(fixture.pullRequest, {
      nodeId: AGENTIC_POLICY.copilotBotNodeId, databaseId: AGENTIC_POLICY.copilotBotDatabaseId,
    })).toMatchObject({ required: true, valid: true });
    fixture.github.graphql.mockResolvedValue(nativeEvidence({ closingIssuesReferences: association() }));
    await expect(reconciler.reconcileAgenticPullRequests(fixture.reconciliation)).rejects.toThrow("Failed to reconcile");
    expect(fixture.onVerifiedMerge).not.toHaveBeenCalled();
    expect(fixture.github.rest.pulls.merge).not.toHaveBeenCalled();
    expect(fixture.github.rest.issues.createComment).toHaveBeenCalledWith(expect.objectContaining({
      issue_number: 8, body: expect.stringContaining("native-closing-issues-present"),
    }));
    await reconciler.reconcileAgenticPullRequests(fixture.reconciliation);
    expect(fixture.github.rest.issues.createComment).toHaveBeenCalledTimes(1);
  });

  it("keeps multiple distinct ordinary reference targets unauthorized", async () => {
    const fixture = controllerFixture();
    fixture.pullRequest.body += "\nRefs #10";
    await reconciler.reconcileAgenticPullRequests(fixture.reconciliation);
    expect(fixture.onVerifiedMerge).not.toHaveBeenCalled();
    expect(fixture.github.graphql).not.toHaveBeenCalled();
  });

  it.each([
    ["missing response", undefined],
    ["partial empty connection", nativeEvidence({
      closingIssuesReferences: { ...emptyConnection(), pageInfo: { hasNextPage: true, endCursor: "MQ" } },
    })],
    ["partial GraphQL response", { ...nativeEvidence(), errors: [{ message: "unavailable field" }] }],
  ])("never emits a ready publication for a %s during reconciliation", async (_name, response) => {
    const fixture = controllerFixture();
    fixture.github.graphql.mockResolvedValueOnce(response);
    await expect(reconciler.reconcileAgenticPullRequests(fixture.reconciliation)).rejects.toThrow("Failed to reconcile");
    expect(fixture.onVerifiedMerge).not.toHaveBeenCalled();
    expect(fixture.github.rest.issues.createComment).toHaveBeenCalledTimes(1);
    expect(fixture.github.rest.pulls.merge).not.toHaveBeenCalled();
  });

  it.each([
    ["association", nativeEvidence({ closingIssuesReferences: association() })],
    ["partial response", { ...nativeEvidence(), errors: [{ message: "partial" }] }],
    ["wrong repository", nativeEvidence({ repository: { nameWithOwner: "o/other" } })],
    ["wrong PR", nativeEvidence({ number: 9 })],
    ["wrong PR identity", nativeEvidence({ id: "PR_other" })],
    ["changed head", nativeEvidence({ headRefOid: "b".repeat(40) })],
  ])("rejects a %s introduced after preflight in the publisher's own read", async (_name, response) => {
    const fixture = controllerFixture();
    await reconciler.reconcileAgenticPullRequests(fixture.reconciliation);
    const publisherGraphql = jest.fn(async (): Promise<unknown> => response);
    await expect(mergeVerifiedHead({
      ...fixture, github: { ...fixture.github, graphql: publisherGraphql },
      pullRequest: { number: 8, head: { sha } },
    })).rejects.toThrow("Native issue-closure safeguard blocked");
    expect(publisherGraphql).toHaveBeenCalledTimes(1);
    expect(fixture.github.graphql).toHaveBeenCalledTimes(1);
    expect(fixture.github.rest.pulls.merge).not.toHaveBeenCalled();
  });

  it("does not inherit an earlier empty read after the final veto/mergeability checks", async () => {
    const fixture = controllerFixture();
    fixture.github.graphql
      .mockResolvedValueOnce(nativeEvidence())
      .mockResolvedValueOnce(nativeEvidence({ closingIssuesReferences: association() }));
    await expect(mergeVerifiedHead(fixture)).rejects.toThrow("native-closing-issues-present");
    expect(fixture.github.graphql).toHaveBeenCalledTimes(2);
    expect(fixture.github.rest.pulls.merge).not.toHaveBeenCalled();
  });

  it("blocks a failed last native read even after a successful publisher authorization", async () => {
    const fixture = controllerFixture();
    fixture.github.graphql.mockResolvedValueOnce(nativeEvidence()).mockRejectedValueOnce(new Error("unavailable"));
    await expect(mergeVerifiedHead(fixture)).rejects.toThrow("native-closing-issues-read-failed");
    expect(fixture.github.rest.pulls.merge).not.toHaveBeenCalled();
    expect(fixture.github.rest.issues.createComment).toHaveBeenCalledTimes(1);
  });

  it("requires the complete existing authorization even when native closing evidence is empty", async () => {
    const fixture = controllerFixture();
    fixture.files[0].filename = ".github/workflows/ci.yml";
    expect(await reconciler.verifyAutonomousMergeCandidate(fixture)).toEqual({
      valid: false, reason: "PR changes escape issue allowed paths",
    });
    expect(fixture.github.graphql).not.toHaveBeenCalled();
    expect(fixture.github.rest.pulls.merge).not.toHaveBeenCalled();
  });

  it("does not let empty native evidence replace a current-head review veto", async () => {
    const fixture = controllerFixture();
    fixture.reviews.push({
      state: "CHANGES_REQUESTED", commit_id: sha, author_association: "OWNER",
      user: { login: "reviewer", type: "User" },
    });
    await mergeVerifiedHead(fixture);
    expect(fixture.github.graphql).not.toHaveBeenCalled();
    expect(fixture.github.rest.pulls.merge).not.toHaveBeenCalled();
  });
});
