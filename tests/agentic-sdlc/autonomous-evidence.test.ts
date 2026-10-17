const { readReceiptArchive } = jest.requireActual<{
  readReceiptArchive(data: Buffer): unknown;
}>("../../.github/scripts/agentic-receipt.cjs");
const { verifyTrustedReviewEvidence } = jest.requireActual<{
  verifyTrustedReviewEvidence(input: Record<string, unknown>): Promise<{ valid: boolean; reason?: string }>;
}>("../../.github/scripts/agentic-review-evidence.cjs");
const { mergeVerifiedHead } = jest.requireActual<{
  mergeVerifiedHead(input: Record<string, unknown>): Promise<void>;
}>("../../.github/scripts/agentic-merge.cjs");

function archive(value: unknown, filename = "receipt.json") {
  const content = Buffer.from(JSON.stringify(value));
  const name = Buffer.from(filename);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);
  const directory = Buffer.alloc(46);
  directory.writeUInt32LE(0x02014b50, 0);
  directory.writeUInt32LE(content.length, 20);
  directory.writeUInt32LE(content.length, 24);
  directory.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + content.length, 16);
  return Buffer.concat([local, name, content, directory, name, end]);
}

function evidenceFixture() {
  const sha = "a".repeat(40);
  const check = {
    id: 10, name: "Security review", head_sha: sha, status: "completed", conclusion: "success",
    app: { slug: "github-actions" }, details_url: "https://github.com/o/r/actions/runs/2",
  };
  const run = {
    id: 2, run_attempt: 1, event: "workflow_dispatch", head_branch: "main", status: "completed",
    conclusion: "success", repository: { full_name: "o/r" }, path: ".github/workflows/security-review.lock.yml",
    display_title: `agentic-pr:8:${sha}:security-review.lock.yml`,
  };
  const receipt = {
    schemaVersion: 1, runId: 2, runAttempt: 1, pullNumber: 8, headSha: sha,
    checks: [{ id: 10, name: "Security review", conclusion: "success" }],
  };
  const github = {
    rest: { actions: {
      getWorkflowRun: jest.fn(async () => ({ data: run })),
      listWorkflowRunArtifacts: "artifacts",
      downloadArtifact: jest.fn(async () => ({ data: archive(receipt) })),
    } },
    paginate: jest.fn(async () => [{ id: 20, name: `factory-receipt-${sha}-1`, expired: false }]),
  };
  return {
    github, owner: "o", repo: "r", defaultBranch: "main", serverUrl: "https://github.com",
    pullNumber: 8, headSha: sha, checkRuns: [check], requiredChecks: ["Security review"],
    receipt, run, check,
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
    fixture.run.display_title = `agentic-pr:8:${fixture.headSha}:ci.yml`;
    expect(await verifyTrustedReviewEvidence(fixture)).toEqual({ valid: true });
    fixture.receipt.checks[0].id = 999;
    expect(await verifyTrustedReviewEvidence(fixture)).toMatchObject({ valid: false });
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
    number: 8, state: "open", draft: false, labels: ["agentic-automerge"], mergeable_state: "clean",
    base: { ref: "main" }, head: { sha: "a".repeat(40), repo: { full_name: "o/r" } },
  };
  const current = { ...pullRequest, head: { ...pullRequest.head } };
  const github = {
    rest: {
      issues: { listForRepo: "controls" },
      pulls: {
        listReviews: "reviews",
        get: jest.fn(async () => ({ data: current })),
        merge: jest.fn(async () => ({ data: { merged: true, sha: "b".repeat(40) } })),
        updateBranch: jest.fn(async () => ({})),
      },
    },
    paginate: jest.fn(async (endpoint: string): Promise<object[]> => endpoint === "controls" ? [{ number: 1, labels: ["factory-mode:active"] }] : []),
  };
  return { github, owner: "o", repo: "r", pullRequest, current, core: { info: jest.fn() } };
}

describe("exact-head atomic merge", () => {
  it("merges the verified SHA without leaving future auto-merge armed", async () => {
    const fixture = mergeFixture();
    await mergeVerifiedHead(fixture);
    expect(fixture.github.rest.pulls.merge).toHaveBeenCalledWith({
      owner: "o", repo: "r", pull_number: 8, sha: "a".repeat(40), merge_method: "squash",
    });
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
});
