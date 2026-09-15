"use strict";

const { afterEach, describe, expect, it, jest: mocker } = require("@jest/globals");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const yaml = require("yaml");
const { reconcileAgenticPullRequests } = require("../../.github/scripts/agentic-pr-reconciler.cjs");
const { harness, evidence, SHA, BASE, REPOSITORY, NOW } = require("./fixtures/review-evidence.cjs");

afterEach(() => mocker.restoreAllMocks());

function dispatched(h) {
  return h.github.rest.actions.createWorkflowDispatch.mock.calls.map(([call]) => call.workflow_id);
}

function ciPending(h) {
  h.state.runs.find((run) => run.id === 500).status = "in_progress";
  h.state.runs.find((run) => run.id === 500).conclusion = null;
  h.state.checks[0].status = "in_progress";
  h.state.checks[0].conclusion = null;
  h.state.jobs.get(500)[0].status = "in_progress";
  h.state.jobs.get(500)[0].conclusion = null;
}

describe("exact-head API reconciliation and dispatch", () => {
  it("runs independent code review in parallel but waits for required CI before QA", async () => {
    mocker.spyOn(Date, "now").mockReturnValue(NOW);
    const h = harness();
    ciPending(h);
    await reconcileAgenticPullRequests(h);
    expect(dispatched(h)).toEqual(["code-review.lock.yml"]);
    h.addReview();
    Object.assign(h.state.runs.find((run) => run.id === 500), { status: "completed", conclusion: "success" });
    Object.assign(h.state.checks[0], { status: "completed", conclusion: "success" });
    Object.assign(h.state.jobs.get(500)[0], { status: "completed", conclusion: "success" });
    h.github.rest.actions.createWorkflowDispatch.mockClear();
    await reconcileAgenticPullRequests(h);
    expect(dispatched(h)).toEqual(["qa-test-plan.lock.yml"]);
    expect(h.github.rest.actions.createWorkflowDispatch).toHaveBeenCalledWith(expect.objectContaining({
      ref: "main", inputs: expect.objectContaining({
        head_sha: SHA, target: "7", correlation_id: evidence.correlationId("qa-test-plan.lock.yml", 7, SHA),
      }),
    }));
  });

  it("persists a bounded dispatch lease before a write and suppresses replay during API visibility lag", async () => {
    mocker.spyOn(Date, "now").mockReturnValue(NOW);
    const h = harness();
    await reconcileAgenticPullRequests(h);
    const first = dispatched(h);
    expect(first).toContain("code-review.lock.yml");
    expect(h.state.checks.some((check) => check.name === "Evidence dispatch: code-review.lock.yml")).toBe(true);
    const reservationIndex = h.github.rest.checks.create.mock.calls.findIndex(([check]) =>
      check.name === "Evidence dispatch: code-review.lock.yml");
    expect(h.github.rest.checks.create.mock.invocationCallOrder[reservationIndex])
      .toBeLessThan(h.github.rest.actions.createWorkflowDispatch.mock.invocationCallOrder[0]);
    h.github.rest.actions.createWorkflowDispatch.mockClear();
    await reconcileAgenticPullRequests(h);
    expect(dispatched(h)).toEqual([]);
  });

  it("retains the lease if dispatch returns an ambiguous transport failure", async () => {
    mocker.spyOn(Date, "now").mockReturnValue(NOW);
    const h = harness();
    h.addReview("QA verification");
    h.github.rest.actions.createWorkflowDispatch.mockRejectedValue(new Error("connection lost after acceptance"));
    await expect(reconcileAgenticPullRequests(h)).rejects.toBeInstanceOf(AggregateError);
    h.github.rest.actions.createWorkflowDispatch.mockReset().mockResolvedValue({});
    await reconcileAgenticPullRequests(h);
    expect(dispatched(h)).toEqual([]);
  });

  it.each(["cancelled", "failure", "timed_out", "action_required", "success"])(
    "recovers a %s wrapper with no verdict, never treating the wrapper as semantic proof",
    async (conclusion) => {
      mocker.spyOn(Date, "now").mockReturnValue(NOW);
      const h = harness();
      h.addReview("QA verification");
      h.state.runs.find((run) => run.path.endsWith("/code-review.lock.yml")).conclusion = conclusion;
      await reconcileAgenticPullRequests(h);
      expect(dispatched(h)).toEqual(["code-review.lock.yml"]);
      expect(h.state.checks.some((check) => check.name === "Agentic code review" && check.conclusion === "success")).toBe(false);
      expect(dispatched(h)).not.toContain("pr-self-heal.lock.yml");
    },
  );

  it("never counts provider/model failures against the product repair cap, including recovery exhaustion", async () => {
    mocker.spyOn(Date, "now").mockReturnValue(NOW);
    const h = harness();
    Object.assign(h.state.pull, {
      title: "[docs-sync] Update guide",
      user: { login: "github-actions[bot]", type: "Bot", id: 41898282 },
      labels: [{ name: "agentic-automerge" }, { name: "docs-sync" }],
    });
    h.state.files[0].filename = "docs/guides/contributing.md";
    h.state.controls.push({ number: 42, labels: [{ name: "factory-control" }, { name: "factory-mode:active" }] });
    h.state.timeline.push({ id: 1, event: "labeled", label: { name: "factory-mode:active" },
      actor: { type: "User", login: "owner" }, created_at: "2026-09-14T00:00:00Z" });
    const codeRun = h.state.runs.find((run) => run.path.endsWith("/code-review.lock.yml"));
    codeRun.conclusion = "failure";
    codeRun.run_attempt = evidence.MAX_INFRA_ATTEMPTS;
    await reconcileAgenticPullRequests(h);
    expect(dispatched(h)).toEqual([]);
    expect(h.core.warning).toHaveBeenCalledWith(expect.stringContaining("infrastructure recovery exhausted"));
    expect(h.github.rest.issues.addLabels).not.toHaveBeenCalled();
    expect(h.github.rest.issues.removeLabel).not.toHaveBeenCalled();
  });

  it("does not retry a genuine rejection, even if a later duplicate check or wrapper is green", async () => {
    const h = harness();
    h.addReview("Agentic code review", "reject");
    h.addReview("Agentic code review", "pass");
    h.addReview("QA verification");
    await reconcileAgenticPullRequests(h);
    expect(dispatched(h)).not.toContain("code-review.lock.yml");
    const policy = h.state.checks.filter((check) => check.name === "Agentic merge policy").at(-1);
    expect(policy).toMatchObject({ status: "in_progress", output: { summary: "Agentic code review requires changes" } });
  });

  it.each(["success", "cancelled", "failure"])(
    "invalidates an old same-head success when a newer trusted %s attempt published no item",
    async (conclusion) => {
      mocker.spyOn(Date, "now").mockReturnValue(NOW);
      const h = harness();
      h.addReview();
      const oldRun = h.state.runs.find((run) => run.id === 900);
      const oldSuccess = h.addReview("QA verification");
      h.state.runs.push({ ...oldRun, id: 1000, conclusion });
      await reconcileAgenticPullRequests(h);
      expect(oldSuccess.conclusion).toBe("success");
      const required = h.state.checks.filter((check) => check.name === "QA verification").at(-1);
      expect(required.conclusion).toBe("action_required");
      expect(evidence.receipt(required, evidence.REVIEW_MARKER)).toMatchObject({
        headSha: SHA, runId: 1000, verdict: "infrastructure", reason: "evidence_unavailable",
      });
      expect(h.state.checks.filter((check) => check.name === "Agentic merge policy").at(-1).status).toBe("in_progress");
      expect(dispatched(h)).not.toContain("pr-self-heal.lock.yml");
      h.github.rest.actions.createWorkflowDispatch.mockClear();
      await reconcileAgenticPullRequests(h);
      expect(dispatched(h)).toEqual([]);
    },
  );

  it.each(["wrong branch", "wrong correlation", "wrong repository"])(
    "does not let a newer %s run invalidate trusted same-head success",
    async (spoof) => {
      const h = harness();
      h.addReview();
      h.addReview("QA verification");
      const injected = { ...h.state.runs.find((run) => run.id === 900), id: 1000, conclusion: "failure" };
      if (spoof === "wrong branch") { injected.head_branch = "attacker"; injected.head_sha = SHA; }
      if (spoof === "wrong correlation") injected.display_title = "agentic-pr:8:forged:qa-test-plan.lock.yml";
      if (spoof === "wrong repository") injected.repository = { full_name: `attacker/${REPOSITORY.split("/")[1]}` };
      h.state.runs.push(injected);
      await reconcileAgenticPullRequests(h);
      expect(dispatched(h)).toEqual([]);
      expect(h.state.checks.filter((check) => check.name === "Agentic merge policy").at(-1).conclusion).toBe("success");
    },
  );

  it("seals an unfinished trusted attempt as infrastructure after its publisher fails", async () => {
    const h = harness();
    h.addReview();
    const packet = await evidence.collectReviewPacket(h);
    h.env.PACKET_DIGEST = packet.packetDigest;
    const attempt = await evidence.recordReviewAttempt({ ...h, packet });
    h.state.runs.find((run) => run.id === 900).conclusion = "failure";
    await reconcileAgenticPullRequests(h);
    expect(h.state.checks.find((check) => check.id === attempt.checkId)).toMatchObject({
      status: "completed", conclusion: "action_required",
    });
    expect(h.github.rest.checks.update).not.toHaveBeenCalledWith(expect.objectContaining({ conclusion: "success" }));
  });

  it("does not repair boundary PRs or weaken the current-head human veto", async () => {
    const h = harness();
    h.state.files[0].filename = ".github/scripts/example.cjs";
    h.addReview("Agentic code review", "reject");
    h.state.reviews.push({
      state: "CHANGES_REQUESTED", commit_id: SHA, author_association: "OWNER",
      user: { type: "User", login: "owner" },
    });
    await reconcileAgenticPullRequests(h);
    expect(dispatched(h)).not.toContain("pr-self-heal.lock.yml");
    expect(dispatched(h)).not.toContain("code-review.lock.yml");
    const policy = h.state.checks.filter((check) => check.name === "Agentic merge policy").at(-1);
    expect(policy).toMatchObject({ status: "in_progress", output: { summary: "A current human review requests changes" } });
  });

  it("invalidates an evidence-dependent pass when required checks are rerun on the same head", async () => {
    const h = harness();
    h.addReview();
    h.addReview("QA verification");
    ciPending(h);
    await reconcileAgenticPullRequests(h);
    expect(dispatched(h)).toEqual([]);
    const policy = h.state.checks.filter((check) => check.name === "Agentic merge policy").at(-1);
    expect(policy).toMatchObject({ status: "in_progress", output: { summary: "Waiting for QA verification" } });
  });

  it.each(["in_progress", "completed"])(
    "does not reuse old CI proof when a newer bound dispatch is %s but has no head evidence",
    async (status) => {
      const h = harness();
      h.addReview();
      h.addReview("QA verification");
      h.state.runs.push({
        ...h.state.runs.find((run) => run.id === 500), id: 1000, event: "workflow_dispatch",
        head_sha: BASE, head_branch: "main", display_title: evidence.correlationId("ci.yml", 7, SHA),
        status, conclusion: status === "completed" ? "failure" : null,
      });
      await reconcileAgenticPullRequests(h);
      const policy = h.state.checks.filter((check) => check.name === "Agentic merge policy").at(-1);
      expect(policy.status).toBe("in_progress");
      expect(dispatched(h)).not.toContain("qa-test-plan.lock.yml");
      expect(dispatched(h)).not.toContain("pr-self-heal.lock.yml");
    },
  );

  it("rejects a fabricated same-name success from another workflow", async () => {
    const h = harness();
    h.addReview();
    h.addReview("QA verification");
    h.state.runs.find((run) => run.path.endsWith("/code-review.lock.yml")).repository.full_name = "attacker/project";
    await reconcileAgenticPullRequests(h);
    const policy = h.state.checks.filter((check) => check.name === "Agentic merge policy").at(-1);
    expect(policy.status).toBe("in_progress");
    expect(dispatched(h)).toContain("code-review.lock.yml");
  });

  it.each(["head moved", "checks 403", "human reviews 403", "partial runs"])(
    "fails closed on %s without stale dispatch or retaining a successful policy",
    async (failure) => {
      const h = harness();
      h.addReview();
      h.addReview("QA verification");
      h.state.checks.push({ id: 8000, head_sha: SHA, app: { slug: "github-actions" },
        name: "Agentic merge policy", status: "completed", conclusion: "success" });
      if (failure === "head moved") {
        h.github.rest.pulls.get.mockImplementationOnce(async () => ({ data: structuredClone(h.state.pull) }))
          .mockImplementation(async () => ({ data: { ...h.state.pull, head: { ...h.state.pull.head, sha: BASE } } }));
      }
      if (failure === "checks 403") h.github.rest.checks.listForRef.mockRejectedValue(Object.assign(new Error("forbidden"), { status: 403 }));
      if (failure === "human reviews 403") h.github.rest.pulls.listReviews.mockRejectedValue(Object.assign(new Error("forbidden"), { status: 403 }));
      if (failure === "partial runs") h.github.rest.actions.listWorkflowRuns.mockResolvedValue({
        data: { total_count: 2, workflow_runs: [h.state.runs[0]] },
      });
      await expect(reconcileAgenticPullRequests(h)).rejects.toBeInstanceOf(AggregateError);
      expect(dispatched(h)).toEqual([]);
      expect(h.state.checks.filter((check) => check.name === "Agentic merge policy").at(-1).status).toBe("in_progress");
    },
  );

  it("paginates workflow runs before deciding a correlated review is missing", async () => {
    const h = harness();
    h.addReview();
    const qaRun = h.state.runs.find((run) => run.path.endsWith("/qa-test-plan.lock.yml"));
    qaRun.status = "in_progress";
    h.state.runs.unshift(...Array.from({ length: 101 }, (_, index) => ({
      ...qaRun, id: index + 1, head_sha: BASE, display_title: `unrelated ${index}`,
    })));
    await reconcileAgenticPullRequests(h);
    expect(h.github.rest.actions.listWorkflowRuns).toHaveBeenCalledWith(expect.objectContaining({
      workflow_id: "qa-test-plan.lock.yml", page: 2,
    }));
    expect(dispatched(h)).not.toContain("qa-test-plan.lock.yml");
  });
});

describe("label storms and compiled evidence boundaries", () => {
  it.each(["qa-test-plan", "security-review", "trading-safety-review"])(
    "%s queues unrelated label events without cancelling the required review and does no evidence/API work for them",
    async (workflow) => {
      const compiled = yaml.parse(fs.readFileSync(path.join(__dirname, "../../.github/workflows", `${workflow}.lock.yml`), "utf8"));
      expect(compiled.concurrency).toMatchObject({ "cancel-in-progress": false, queue: "max" });
      expect(compiled.jobs.activation.needs).toContain("review_evidence");
      expect(compiled.jobs.review_evidence.permissions.checks).toBe("read");
      expect(compiled.jobs.review_evidence.if).toContain("github.event.pull_request.base.ref == github.event.repository.default_branch");
      expect(compiled.jobs.agent.permissions.checks).toBe("read");
      expect(compiled.jobs.create_pr_check.permissions.checks).toBe("write");
      const name = Object.keys(evidence.REVIEW_WORKFLOWS).find((key) => evidence.REVIEW_WORKFLOWS[key] === `${workflow}.lock.yml`);
      const label = { "qa-test-plan": "needs-qa", "security-review": "security-review", "trading-safety-review": "trading-safety" }[workflow];
      const h = harness(name);
      h.context.eventName = "pull_request";
      h.context.payload.pull_request = h.state.pull;
      h.context.payload.action = "labeled";
      const temp = fs.mkdtempSync(path.join(os.tmpdir(), "review-label-test-"));
      h.env.RUNNER_TEMP = temp;
      const queue = [label, "risk:boundary", "ready-for-human-review", "docs-sync", "unrelated"];
      const results = [];
      try {
        for (const item of queue) {
          h.context.payload.label = { name: item };
          results.push(await evidence.prepareReviewEvidence(h));
        }
        expect(results.map((packet) => packet.ready)).toEqual([true, false, false, false, false]);
        expect(h.github.rest.pulls.get).toHaveBeenCalledTimes(2);
        expect(h.github.rest.checks.create).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(temp, { recursive: true });
      }
    },
  );

  it("keeps all CI execution jobs read-only and dispatch-bound, with separate privileged publication", () => {
    const workflow = yaml.parse(fs.readFileSync(path.join(__dirname, "../../.github/workflows/ci.yml"), "utf8"));
    for (const name of ["quality", "postgres", "harness-integrity", "docker-validate"]) {
      const job = workflow.jobs[name];
      expect(job.needs).toBe("dispatch-context");
      expect(job.steps.find((step) => step.name === "Checkout").with.ref).toBe("${{ inputs.head_sha || github.sha }}");
      expect(job.steps.some((step) => step.name === "Verify dispatched head")).toBe(true);
      expect(job.permissions?.checks).not.toBe("write");
    }
    const publisher = workflow.jobs["publish-dispatch-checks"];
    expect(publisher.needs).toEqual(expect.arrayContaining(["dispatch-context", "quality", "postgres"]));
    expect(publisher.permissions.checks).toBe("write");
    expect(publisher.steps[0].with.ref).toBe("${{ github.sha }}");
    expect(workflow.on.pull_request_target).toBeUndefined();
  });

  it("declares pending exact-head CI checks in the real preparation step before tests run", async () => {
    const h = harness();
    h.env.CORRELATION_ID = evidence.correlationId("ci.yml", 7, SHA);
    const workflow = yaml.parse(fs.readFileSync(path.join(__dirname, "../../.github/workflows/ci.yml"), "utf8"));
    const script = workflow.jobs["dispatch-context"].steps.find((step) => step.id === "verify").with.script;
    const env = { ...h.env, GITHUB_WORKSPACE: path.join(__dirname, "../..") };
    const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    try {
      Object.assign(process.env, env);
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      await new AsyncFunction("github", "context", "core", "require", script)(h.github, h.context, h.core, require);
      expect(evidence.ciState(h.state.checks, SHA)).toBe("pending");
      expect(h.state.checks.filter((check) => check.head_sha === SHA && check.status === "in_progress")).toHaveLength(2);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
