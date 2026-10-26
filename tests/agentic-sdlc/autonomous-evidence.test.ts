import { archive } from "./receipt-archive-fixture";

const { readReceiptArchive } = jest.requireActual<{
  readReceiptArchive(data: Buffer): unknown;
}>("../../.github/scripts/agentic-receipt.cjs");
const { selectTrustedCheckRuns, verifyTrustedReviewEvidence } = jest.requireActual<{
  selectTrustedCheckRuns(input: Record<string, unknown>): Promise<Array<{ id: number; name: string; conclusion: string }>>;
  verifyTrustedReviewEvidence(input: Record<string, unknown>): Promise<{ valid: boolean; reason?: string }>;
}>("../../.github/scripts/agentic-review-evidence.cjs");
const { mergeVerifiedHead } = jest.requireActual<{
  mergeVerifiedHead(input: Record<string, unknown>): Promise<void>;
}>("../../.github/scripts/agentic-merge.cjs");
const reconciler = jest.requireActual<{
  verifyAutonomousMergeCandidate(input: Record<string, unknown>): Promise<{ valid: boolean; reason?: string }>;
}>("../../.github/scripts/agentic-pr-reconciler.cjs");
const { createDispatchRecord } = jest.requireActual<{
  createDispatchRecord(input: { pullNumber: number; headSha: string; workflow: string; runId: number; runAttempt: number }): {
    correlation: string; nonce: string; workflow: string;
  };
}>("../../.github/scripts/agentic-dispatch.cjs");

function evidenceFixture() {
  const sha = "a".repeat(40);
  const check = {
    id: 10, name: "Security review", head_sha: sha, status: "completed", conclusion: "success",
    app: { slug: "github-actions" }, details_url: "https://github.com/o/r/actions/runs/2",
  };
  const dispatchRecord = createDispatchRecord({
    pullNumber: 8, headSha: sha, workflow: "security-review.lock.yml", runId: 1, runAttempt: 1,
  });
  const run = {
    id: 2, run_attempt: 1, event: "workflow_dispatch", head_branch: "main", status: "completed",
    conclusion: "success", repository: { full_name: "o/r" }, path: ".github/workflows/security-review.lock.yml",
    display_title: dispatchRecord.correlation,
    actor: { login: "github-actions[bot]", type: "Bot" },
    triggering_actor: { login: "github-actions[bot]", type: "Bot" },
  };
  const controller = {
    id: 1, run_attempt: 1, event: "schedule", head_branch: "main", status: "completed",
    conclusion: "success", repository: { full_name: "o/r" }, path: ".github/workflows/agentic-pr-reconciler.yml",
    actor: { type: "User", login: "schedule-owner", node_id: "U_schedule" },
    triggering_actor: { type: "User", login: "schedule-owner", node_id: "U_schedule" },
  };
  const dispatchReceipt = {
    schemaVersion: 1, runId: 1, runAttempt: 1, dispatches: [dispatchRecord],
  };
  const receipt = {
    schemaVersion: 1, runId: 2, runAttempt: 1, pullNumber: 8, headSha: sha,
    checks: [{ id: 10, name: "Security review", conclusion: "success" }],
  };
  const github = {
    rest: { actions: {
      getWorkflowRun: jest.fn(async (input: { run_id: number }) => ({ data: input.run_id === 1 ? controller : run })),
      listWorkflowRunArtifacts: "artifacts",
      downloadArtifact: jest.fn(async (input: { artifact_id: number }) => ({ data: archive(input.artifact_id === 21 ? dispatchReceipt : receipt) })),
    } },
    paginate: jest.fn(async (_endpoint: string, input: { run_id: number }) =>
      input.run_id === 1 ? [{ id: 21, name: "factory-dispatches-1", expired: false }] :
        [{ id: 20, name: `factory-receipt-${sha}-1`, expired: false }]),
  };
  return {
    github, owner: "o", repo: "r", defaultBranch: "main", serverUrl: "https://github.com",
    pullNumber: 8, headSha: sha, checkRuns: [check], requiredChecks: ["Security review"],
    receipt, run, check, controller, dispatchReceipt,
  };
}

describe("immutable trusted-run verdicts", () => {
  it("accepts only the exact successful check in the trusted run receipt", async () => {
    expect(await verifyTrustedReviewEvidence(evidenceFixture())).toEqual({ valid: true });
  });

  it("rejects a forged success linking to a genuine run", async () => {
    const fixture = evidenceFixture();
    fixture.check.id = 11;
    expect(await verifyTrustedReviewEvidence(fixture)).toMatchObject({ valid: false });
  });

  it("ignores a later forged check instead of discarding a valid trusted verdict", async () => {
    const fixture = evidenceFixture();
    fixture.checkRuns.push({ ...fixture.check, id: 999 });
    expect(await verifyTrustedReviewEvidence(fixture)).toEqual({ valid: true });
    expect(await selectTrustedCheckRuns(fixture)).toMatchObject([fixture.check]);
  });

  it("never skips a newer authenticated failure to revive an older success", async () => {
    const fixture = evidenceFixture();
    fixture.checkRuns.push({ ...fixture.check, id: 11, conclusion: "failure" });
    fixture.receipt.checks[0] = { id: 11, name: "Security review", conclusion: "failure" };
    expect(await verifyTrustedReviewEvidence(fixture)).toMatchObject({ valid: false });
    expect(await selectTrustedCheckRuns(fixture)).toEqual([
      expect.objectContaining({ id: 11, conclusion: "failure" }),
    ]);
  });

  it("retains a newer failed workflow's receipt instead of an older successful run", async () => {
    const fixture = evidenceFixture();
    const newerRecord = createDispatchRecord({
      pullNumber: 8, headSha: fixture.headSha, workflow: "security-review.lock.yml", runId: 1, runAttempt: 1,
    });
    fixture.dispatchReceipt.dispatches.push(newerRecord);
    const newerRun = { ...fixture.run, id: 3, conclusion: "failure", display_title: newerRecord.correlation };
    const newerCheck = { ...fixture.check, id: 11, conclusion: "failure", details_url: "https://github.com/o/r/actions/runs/3" };
    const newerReceipt = { ...fixture.receipt, runId: 3, checks: [{ id: 11, name: "Security review", conclusion: "failure" }] };
    fixture.checkRuns.push(newerCheck);
    fixture.github.rest.actions.getWorkflowRun.mockImplementation(async ({ run_id }) => ({
      data: run_id === 1 ? fixture.controller : run_id === 3 ? newerRun : fixture.run,
    }));
    fixture.github.paginate.mockImplementation(async (_endpoint, { run_id }) => [{
      id: run_id === 1 ? 21 : run_id === 3 ? 30 : 20,
      name: run_id === 1 ? "factory-dispatches-1" : `factory-receipt-${fixture.headSha}-1`,
      expired: false,
    }]);
    fixture.github.rest.actions.downloadArtifact.mockImplementation(async ({ artifact_id }) => ({
      data: archive(artifact_id === 21 ? fixture.dispatchReceipt : artifact_id === 30 ? newerReceipt : fixture.receipt),
    }));
    expect(await verifyTrustedReviewEvidence(fixture)).toMatchObject({ valid: false });
    expect(await selectTrustedCheckRuns(fixture)).toEqual([
      expect.objectContaining({ id: 11, conclusion: "failure", factoryRunConclusion: "failure" }),
    ]);
    newerCheck.conclusion = "success";
    newerReceipt.checks[0].conclusion = "success";
    expect(await verifyTrustedReviewEvidence(fixture)).toMatchObject({ valid: false });
  });

  it("rejects rewriting a failing check into success, even when the publisher run succeeded", async () => {
    const fixture = evidenceFixture();
    fixture.receipt.checks[0].conclusion = "failure";
    expect(await verifyTrustedReviewEvidence(fixture)).toMatchObject({ valid: false });
  });

  it.each(["headSha", "runId", "runAttempt"])("rejects replay with a mismatched receipt %s", async (field) => {
    const fixture = evidenceFixture();
    Object.assign(fixture.receipt, { [field]: "wrong" });
    await expect(verifyTrustedReviewEvidence(fixture)).rejects.toThrow("does not match");
  });

  it("rejects a receipt for another PR", async () => {
    const fixture = evidenceFixture();
    fixture.receipt.pullNumber = 9;
    expect(await verifyTrustedReviewEvidence(fixture)).toMatchObject({ valid: false });
  });

  it("rejects PR-authored workflow origins", async () => {
    const fixture = evidenceFixture();
    fixture.run.head_branch = "untrusted-branch";
    expect(await verifyTrustedReviewEvidence(fixture)).toMatchObject({ valid: false });
    expect(fixture.github.rest.actions.downloadArtifact).not.toHaveBeenCalled();
  });

  it("requires producer-bound receipts for baseline CI as well as agent reviews", async () => {
    const fixture = evidenceFixture();
    fixture.requiredChecks = ["Quality and evidence gates"];
    fixture.check.name = "Quality and evidence gates";
    fixture.receipt.checks[0].name = fixture.check.name;
    fixture.run.path = ".github/workflows/ci.yml";
    const record = createDispatchRecord({ pullNumber: 8, headSha: fixture.headSha, workflow: "ci.yml", runId: 1, runAttempt: 1 });
    fixture.run.display_title = record.correlation;
    fixture.dispatchReceipt.dispatches = [record];
    expect(await verifyTrustedReviewEvidence(fixture)).toEqual({ valid: true });
    fixture.receipt.checks[0].id = 999;
    expect(await verifyTrustedReviewEvidence(fixture)).toMatchObject({ valid: false });
  });

  it("rejects manual runs even if they copy a valid correlation and nonce", async () => {
    const fixture = evidenceFixture();
    fixture.run.actor = { login: "collaborator", type: "User" };
    expect(await verifyTrustedReviewEvidence(fixture)).toMatchObject({ valid: false });
    expect(fixture.github.rest.actions.downloadArtifact).not.toHaveBeenCalled();
  });

  it("rejects a human rerun of a trusted bot dispatch", async () => {
    const fixture = evidenceFixture();
    fixture.run.triggering_actor = { login: "collaborator", type: "User" };
    expect(await verifyTrustedReviewEvidence(fixture)).toMatchObject({ valid: false });
  });

  it("rejects a bot dispatch with a nonce absent from the controller's immutable receipt", async () => {
    const fixture = evidenceFixture();
    fixture.dispatchReceipt.dispatches = [];
    expect(await verifyTrustedReviewEvidence(fixture)).toMatchObject({ valid: false });
  });

  it("rejects a purported dispatcher that ran from PR-controlled YAML", async () => {
    const fixture = evidenceFixture();
    fixture.controller.event = "pull_request_review";
    expect(await verifyTrustedReviewEvidence(fixture)).toMatchObject({ valid: false });
  });

  it("rejects a manually dispatched controller even when its downstream actor is the bot", async () => {
    const fixture = evidenceFixture();
    fixture.controller.event = "workflow_dispatch";
    expect(await verifyTrustedReviewEvidence(fixture)).toMatchObject({ valid: false });
  });

  it("rejects mismatched controller attempts and changed triggering identities", async () => {
    const fixture = evidenceFixture();
    fixture.controller.run_attempt = 2;
    expect(await verifyTrustedReviewEvidence(fixture)).toMatchObject({ valid: false });
    fixture.controller.run_attempt = 1;
    fixture.controller.triggering_actor.node_id = "U_rerunner";
    expect(await verifyTrustedReviewEvidence(fixture)).toMatchObject({ valid: false });
  });

  it("accepts a same-identity controller rerun only with its own matching immutable attempt receipt", async () => {
    const fixture = evidenceFixture();
    const record = createDispatchRecord({
      pullNumber: 8, headSha: fixture.headSha, workflow: "security-review.lock.yml", runId: 1, runAttempt: 2,
    });
    fixture.run.display_title = record.correlation;
    fixture.controller.run_attempt = 2;
    fixture.dispatchReceipt.runAttempt = 2;
    fixture.dispatchReceipt.dispatches = [record];
    fixture.github.paginate.mockImplementation(async (_endpoint, { run_id }) => run_id === 1
      ? [{ id: 21, name: "factory-dispatches-2", expired: false }]
      : [{ id: 20, name: `factory-receipt-${fixture.headSha}-1`, expired: false }]);
    expect(await verifyTrustedReviewEvidence(fixture)).toEqual({ valid: true });
    fixture.dispatchReceipt.runAttempt = 1;
    expect(await verifyTrustedReviewEvidence(fixture)).toMatchObject({ valid: false });
  });

  it("does not treat ordinary successful PR CI checks as trusted QA prerequisites", async () => {
    const fixture = evidenceFixture();
    fixture.check.name = "Quality and evidence gates";
    fixture.run.event = "pull_request";
    expect(await selectTrustedCheckRuns(fixture)).toEqual([]);
  });

  it("fails when the receipt is missing or expired", async () => {
    const fixture = evidenceFixture();
    fixture.github.paginate.mockResolvedValueOnce([]);
    await expect(verifyTrustedReviewEvidence(fixture)).rejects.toThrow("unique trusted-run");
  });
});

describe("bounded artifact decoding", () => {
  it("reads a single JSON receipt without filesystem extraction", () => {
    expect(readReceiptArchive(archive({ schemaVersion: 1 }))).toEqual({ schemaVersion: 1 });
  });
  it.each(["../receipt.json", "/receipt.json", "another.json"])("rejects archive filename %s", (name) => {
    expect(() => readReceiptArchive(archive({}, name))).toThrow("Unsupported");
  });
  it("rejects oversized or truncated archives", () => {
    expect(() => readReceiptArchive(Buffer.alloc(262145))).toThrow("size");
    expect(() => readReceiptArchive(archive({}).subarray(0, 35))).toThrow();
  });
  it("rejects multiple entries", () => {
    const data = archive({});
    data.writeUInt16LE(2, data.length - 12);
    expect(() => readReceiptArchive(data)).toThrow("exactly one");
  });
});

function mergeFixture() {
  const pullRequest = {
    number: 8, node_id: "PR_test", state: "open", draft: false, labels: ["agentic-automerge"], mergeable_state: "clean",
    base: { ref: "main" }, head: { sha: "a".repeat(40), repo: { full_name: "o/r" } },
  };
  const current = { ...pullRequest, head: { ...pullRequest.head } };
  const github = {
    graphql: jest.fn(async () => ({
      repository: {
        nameWithOwner: "o/r",
        pullRequest: {
          id: current.node_id, number: current.number, headRefOid: current.head.sha,
          repository: { nameWithOwner: "o/r" },
          closingIssuesReferences: {
            totalCount: 0, nodes: [], pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    })),
    rest: {
      issues: {
        listForRepo: "controls", listEventsForTimeline: "timeline",
        addLabels: jest.fn(), createComment: jest.fn(),
      },
      pulls: {
        listReviews: "reviews",
        get: jest.fn(async () => ({ data: current })),
        merge: jest.fn(async () => ({ data: { merged: true, sha: "b".repeat(40) } })),
        updateBranch: jest.fn(async () => ({})),
      },
    },
    paginate: jest.fn(async (endpoint: string): Promise<object[]> => {
      if (endpoint === "controls") return [{ number: 1, labels: ["factory-mode:active"] }];
      if (endpoint === "timeline") return [{
        event: "labeled", label: { name: "factory-mode:active" },
        actor: { type: "User" }, created_at: "2026-10-18T12:00:00Z",
      }];
      return [];
    }),
  };
  return { github, owner: "o", repo: "r", pullRequest, current, core: { info: jest.fn(), warning: jest.fn() } };
}

describe("exact-head atomic merge", () => {
  afterEach(() => jest.restoreAllMocks());

  beforeEach(() => {
    jest.spyOn(reconciler, "verifyAutonomousMergeCandidate").mockResolvedValue({ valid: true });
  });
  it("merges the verified SHA without leaving future auto-merge armed", async () => {
    const fixture = mergeFixture();
    await mergeVerifiedHead(fixture);
    expect(fixture.github.rest.pulls.merge).toHaveBeenCalledWith({
      owner: "o", repo: "r", pull_number: 8, sha: "a".repeat(40), merge_method: "squash",
      commit_title: "[factory] Merge PR #8",
      commit_message: `Verified head: ${"a".repeat(40)}\n\nIssue completion requires exact-source lifecycle evidence.`,
    });
  });
  it("does not substitute a different PR returned by the initial target read", async () => {
    const fixture = mergeFixture();
    fixture.current.number = 9;
    await mergeVerifiedHead(fixture);
    expect(fixture.github.rest.pulls.merge).not.toHaveBeenCalled();
    expect(fixture.github.graphql).not.toHaveBeenCalled();
  });
  it("rejects a different PR returned by the target reread after authorization", async () => {
    const fixture = mergeFixture();
    fixture.github.rest.pulls.get
      .mockResolvedValueOnce({ data: fixture.current })
      .mockResolvedValueOnce({ data: { ...fixture.current, number: 9 } });
    await mergeVerifiedHead(fixture);
    expect(reconciler.verifyAutonomousMergeCandidate).toHaveBeenCalledTimes(1);
    expect(fixture.github.rest.pulls.get).toHaveBeenCalledTimes(2);
    expect(fixture.github.rest.pulls.merge).not.toHaveBeenCalled();
    expect(fixture.github.graphql).not.toHaveBeenCalled();
  });
  it("does not merge a changed head", async () => {
    const fixture = mergeFixture();
    fixture.current.head.sha = "c".repeat(40);
    await mergeVerifiedHead(fixture);
    expect(fixture.github.rest.pulls.merge).not.toHaveBeenCalled();
  });
  it("honors an emergency pause immediately before the merge", async () => {
    const fixture = mergeFixture();
    fixture.github.paginate.mockResolvedValueOnce([{ number: 1, labels: ["factory-mode:paused"] }]);
    await mergeVerifiedHead(fixture);
    expect(fixture.github.rest.pulls.merge).not.toHaveBeenCalled();
  });
  it("does not merge when enrollment is removed", async () => {
    const fixture = mergeFixture();
    fixture.current.labels = [];
    await mergeVerifiedHead(fixture);
    expect(fixture.github.rest.pulls.merge).not.toHaveBeenCalled();
  });
  it("refreshes a behind branch without merging its newly changed head", async () => {
    const fixture = mergeFixture();
    fixture.current.mergeable_state = "behind";
    await mergeVerifiedHead(fixture);
    expect(fixture.github.rest.pulls.updateBranch).toHaveBeenCalledWith(expect.objectContaining({
      expected_head_sha: fixture.pullRequest.head.sha,
    }));
    expect(fixture.github.rest.pulls.merge).not.toHaveBeenCalled();
  });
  it("does not bypass GitHub's blocked mergeability state", async () => {
    const fixture = mergeFixture();
    fixture.current.mergeable_state = "blocked";
    await mergeVerifiedHead(fixture);
    expect(fixture.github.rest.pulls.merge).not.toHaveBeenCalled();
  });

  it("revalidates full provenance, scope and evidence in the isolated publisher", async () => {
    const fixture = mergeFixture();
    jest.spyOn(reconciler, "verifyAutonomousMergeCandidate").mockResolvedValue({
      valid: false, reason: "Factory claim provenance is invalid",
    });
    Object.assign(fixture.core, { warning: jest.fn() });
    await mergeVerifiedHead(fixture);
    expect(reconciler.verifyAutonomousMergeCandidate).toHaveBeenCalledWith(expect.objectContaining({
      pullRequest: fixture.current,
    }));
    expect(fixture.github.rest.pulls.merge).not.toHaveBeenCalled();
    expect(fixture.github.rest.pulls.updateBranch).not.toHaveBeenCalled();
  });

  it("honors a pause applied during the final evidence reads", async () => {
    const fixture = mergeFixture();
    fixture.github.paginate
      .mockResolvedValueOnce([{ number: 1, labels: ["factory-mode:active"] }])
      .mockResolvedValueOnce([{ event: "labeled", label: { name: "factory-mode:active" }, actor: { type: "User" } }])
      .mockResolvedValueOnce([{ number: 1, labels: ["factory-mode:paused"] }]);
    await mergeVerifiedHead(fixture);
    expect(fixture.github.rest.pulls.merge).not.toHaveBeenCalled();
  });

  it("rejects bot relabeling of the emergency control at final publication", async () => {
    const fixture = mergeFixture();
    fixture.github.paginate
      .mockResolvedValueOnce([{ number: 1, labels: ["factory-mode:active"] }])
      .mockResolvedValueOnce([{ event: "labeled", label: { name: "factory-mode:active" }, actor: { type: "Bot" } }]);
    await mergeVerifiedHead(fixture);
    expect(fixture.github.rest.pulls.merge).not.toHaveBeenCalled();
    expect(reconciler.verifyAutonomousMergeCandidate).not.toHaveBeenCalled();
  });
});
