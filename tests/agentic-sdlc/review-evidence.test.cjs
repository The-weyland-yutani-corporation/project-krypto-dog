"use strict";

const { describe, expect, it } = require("@jest/globals");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { harness, verdict, page, blob, evidence, SHA, BASE, REPOSITORY } = require("./fixtures/review-evidence.cjs");

describe("trusted exact-head review packet", () => {
  it("collects source-addressed scope, complete blobs, job outcomes and retained references without executing PR code", async () => {
    const h = harness();
    h.factoryScope();
    const packet = await evidence.collectReviewPacket(h);
    expect(packet).toMatchObject({
      schemaVersion: 1, ready: true, number: 7, headSha: SHA, trustedWorkflowSha: BASE,
      correlationId: evidence.correlationId("qa-test-plan.lock.yml", 7, SHA),
      scope: { kind: "factory", approval: { id: 30, actor: "owner" } },
      diff: { contentComplete: true, headSha: SHA, mergeBaseSha: BASE },
      ci: { complete: true, state: "success" },
    });
    expect(packet.diff.contents[0].before.content).toContain("value = 1");
    expect(packet.diff.contents[0].after.content).toContain("value = 2");
    expect(packet.ci.checks.map((check) => check.source)).toEqual(
      [501, 502].map((id) => `https://api.github.com/repos/${REPOSITORY}/check-runs/${id}`),
    );
    expect(packet.ci.artifacts[0]).toMatchObject({ id: 700, attemptScope: "run_wide", headSha: SHA });
    expect(h.github.rest.checks.create).not.toHaveBeenCalled();
    expect(h.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it.each(["Bot", "Organization"])("does not trust a goal approval by %s or author-supplied proof", async (type) => {
    const h = harness();
    h.factoryScope();
    h.state.timeline[0].actor.type = type;
    await expect(evidence.collectReviewPacket(h)).rejects.toMatchObject({ code: "scope_unverified" });
  });

  it("requires the native parent, approved label and complete allowed scope", async () => {
    const h = harness();
    h.factoryScope();
    h.github.request.mockResolvedValue({ data: { number: 99 } });
    await expect(evidence.collectReviewPacket(h)).rejects.toMatchObject({ code: "scope_unverified" });
    h.github.request.mockResolvedValue({ data: { number: 10 } });
    h.state.issues.get(10).labels.pop();
    await expect(evidence.collectReviewPacket(h)).rejects.toMatchObject({ code: "scope_unverified" });
  });

  it("detects a moving head after fetching the immutable sources", async () => {
    const h = harness();
    h.github.rest.pulls.get.mockImplementationOnce(async () => ({ data: structuredClone(h.state.pull) }))
      .mockImplementation(async () => ({ data: { ...h.state.pull, head: { ...h.state.pull.head, sha: "f".repeat(40) } } }));
    await expect(evidence.collectReviewPacket(h)).rejects.toMatchObject({ code: "head_moved" });
  });

  it("preserves renamed-path risk floors and ambiguous risk labels", async () => {
    const h = harness("Agentic code review");
    const file = h.state.files[0];
    file.previous_filename = ".github/workflows/previous.yml";
    file.status = "renamed";
    h.state.contents.set(`${BASE}:${file.previous_filename}`, h.state.contents.get(`${BASE}:${file.filename}`));
    const packet = await evidence.collectReviewPacket(h);
    expect(packet.riskTier).toBe("risk:boundary");
    expect(packet.requiredChecks).toEqual(expect.arrayContaining(["Security review", "QA verification", "Human boundary approval"]));
    const other = harness("Agentic code review");
    other.state.pull.labels = [{ name: "risk:routine" }, { name: "risk:sensitive" }];
    expect((await evidence.collectReviewPacket(other)).riskTier).toBe("risk:boundary");
  });

  it("reads symlinks as literal Git blobs instead of following their targets", async () => {
    const h = harness();
    const link = { ...blob("../../untrusted-target"), mode: "120000" };
    h.state.files[0].sha = link.sha;
    h.state.contents.set(`${SHA}:${h.state.files[0].filename}`, link);
    h.state.blobs.set(link.sha, link);
    const packet = await evidence.collectReviewPacket(h);
    expect(packet.diff.contents[0].after).toMatchObject({ mode: "120000", content: "../../untrusted-target" });
    expect(h.github.rest.repos.getContent).not.toHaveBeenCalled();
  });

  it("retains readable blob files with the sealed packet and publishes from that exact bundle", async () => {
    const h = harness();
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "review-bundle-test-"));
    h.env.RUNNER_TEMP = temp;
    try {
      const packet = await evidence.prepareReviewEvidence(h);
      const after = packet.diff.contents[0].after;
      expect(after.content).toBeUndefined();
      expect(fs.readFileSync(path.join(temp, "review-evidence", after.contentFile), "utf8")).toContain("value = 2");
      expect(h.core.setOutput).toHaveBeenCalledWith("packet_path", path.join(temp, "review-evidence"));
      h.env.PACKET_DIGEST = packet.packetDigest;
      await evidence.recordReviewAttempt({ ...h, packet });
      expect(await evidence.publishReviewVerdict({ ...h, packet, items: [verdict(packet)] })).toMatchObject({ published: true });
    } finally {
      fs.rmSync(temp, { recursive: true });
    }
  });

  it.each(["403", "partial"])("records %s data as infrastructure, never a product rejection or a green wrapper", async (mode) => {
    const h = harness();
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "review-evidence-test-"));
    h.env.RUNNER_TEMP = temp;
    if (mode === "403") h.github.rest.checks.listForRef.mockRejectedValue(Object.assign(new Error("forbidden"), { status: 403 }));
    else h.state.pull.changed_files = 2;
    try {
      const packet = await evidence.prepareReviewEvidence(h);
      expect(packet).toMatchObject({ ready: false, outcome: "infrastructure",
        reason: mode === "403" ? "access_unavailable" : "partial_evidence" });
      expect(h.core.warning).toHaveBeenCalled();
      expect(h.github.rest.checks.create).not.toHaveBeenCalled();
      expect(JSON.parse(fs.readFileSync(path.join(temp, "review-evidence", "packet.json"), "utf8"))).toEqual(packet);
    } finally {
      fs.rmSync(temp, { recursive: true });
    }
  });

  it("paginates checks and artifact inventories instead of treating the first page as complete", async () => {
    const h = harness();
    const fillers = Array.from({ length: 101 }, (_, index) => ({
      id: index + 1, name: `unrelated ${index}`, head_sha: SHA, app: { slug: "github-actions" },
      status: "completed", conclusion: "success",
    }));
    h.state.checks.unshift(...fillers);
    h.state.artifacts.get(500).push(...Array.from({ length: 101 }, (_, index) => ({
      id: index + 701, name: `retained ${index}`, expired: false,
    })));
    const packet = await evidence.collectReviewPacket(h);
    expect(packet.ci.artifacts).toHaveLength(102);
    expect(h.github.rest.checks.listForRef).toHaveBeenCalledWith(expect.objectContaining({ page: 2 }));
    expect(h.github.rest.actions.listWorkflowRunArtifacts).toHaveBeenCalledWith(expect.objectContaining({ page: 2 }));
  });

  it("rejects duplicates, truncated pages, changed totals and unverified blob bytes", async () => {
    const h = harness();
    h.github.rest.checks.listForRef.mockResolvedValue({ data: { total_count: 3, check_runs: h.state.checks }, headers: {} });
    await expect(evidence.collectReviewPacket(h)).rejects.toMatchObject({ code: "partial_evidence" });
    const duplicate = [{ id: 1 }, { id: 1 }];
    await expect(evidence.readPages(async (params) => page(duplicate, params), {}))
      .rejects.toMatchObject({ code: "partial_evidence" });
    let call = 0;
    await expect(evidence.readPages(async () => ({ data: {
      total_count: ++call === 1 ? 101 : 102,
      workflow_runs: call === 1 ? Array.from({ length: 100 }, (_, id) => ({ id })) : [{ id: 100 }],
    } }), {}, "workflow_runs")).rejects.toMatchObject({ code: "partial_evidence" });
    const clean = harness();
    clean.github.rest.git.getBlob.mockResolvedValue({ data: { encoding: "base64", size: 1, content: "eA==" } });
    await expect(evidence.collectReviewPacket(clean)).rejects.toMatchObject({ code: "partial_evidence" });
  });

  it("waits for pending required CI but permits independent code review without claiming CI", async () => {
    const h = harness();
    h.state.checks[0].status = "in_progress";
    h.state.checks[0].conclusion = null;
    h.state.jobs.get(500)[0].status = "in_progress";
    h.state.jobs.get(500)[0].conclusion = null;
    const pending = await evidence.collectReviewPacket(h);
    expect(pending).toMatchObject({ ready: false, reason: "ci_pending", ci: { state: "pending" } });
    expect(h.github.rest.git.getBlob).not.toHaveBeenCalled();
    h.env.CHECK_NAME = "Agentic code review";
    h.env.REVIEW_WORKFLOW_ID = "code-review.lock.yml";
    h.env.CORRELATION_ID = evidence.correlationId("code-review.lock.yml", 7, SHA);
    const independent = await evidence.collectReviewPacket(h);
    expect(independent).toMatchObject({ ready: true, requiresCi: false, ci: { state: "pending" } });
  });

  it("does not use success on another head or a successful wrapper as required CI evidence", async () => {
    const h = harness();
    h.state.checks.forEach((check) => { check.head_sha = BASE; });
    const packet = await evidence.collectReviewPacket(h);
    expect(packet).toMatchObject({ ready: false, ci: { state: "pending", checks: [] } });
  });

  it.each([
    ["bad SHA", { EXPECTED_HEAD_SHA: "main" }],
    ["bad number", { EXPECTED_PR_NUMBER: "7;echo injected" }],
    ["correlation", { CORRELATION_ID: "author-supplied-green" }],
    ["trusted SHA", { TRUSTED_WORKFLOW_SHA: SHA }],
  ])("rejects a mismatched %s on dispatch", async (_label, override) => {
    const h = harness();
    Object.assign(h.env, override);
    await expect(evidence.collectReviewPacket(h)).rejects.toMatchObject({ code: "invalid_context" });
  });

  it("guards head-less manual dispatch, PR events and conflicting aw_context without branch fetch", async () => {
    const h = harness();
    h.env.EXPECTED_HEAD_SHA = "";
    const packet = await evidence.collectReviewPacket(h);
    expect(packet.headSha).toBe(SHA);
    h.context.payload.inputs = { aw_context: JSON.stringify({ item_type: "pull_request", item_number: 8 }) };
    await expect(evidence.collectReviewPacket(h)).rejects.toMatchObject({ code: "invalid_context" });
    delete h.context.payload.inputs;
    h.context.eventName = "pull_request";
    h.context.sha = "c".repeat(40);
    h.context.payload.pull_request = structuredClone(h.state.pull);
    expect((await evidence.collectReviewPacket(h)).headSha).toBe(SHA);
    h.context.eventName = "workflow_dispatch";
    h.context.ref = "refs/heads/untrusted-pr";
    await expect(evidence.collectReviewPacket(h)).rejects.toMatchObject({ code: "invalid_context" });
  });
});

describe("deterministic review verdict publication", () => {
  it("rejects empty, duplicate or contradictory safe-output envelopes", () => {
    expect(() => evidence.reviewVerdictItems({ items: [{ type: "noop" }], errors: [] }))
      .toThrow("Expected exactly one create_pr_check item; found 0");
    const item = { type: "create_pr_check", verdict: "pass" };
    expect(() => evidence.reviewVerdictItems({ items: [item, item] })).toThrow("found 2");
    expect(() => evidence.reviewVerdictItems({ items: [item, { type: "report_incomplete" }] }))
      .toThrow("pass conflicts with incomplete safe outputs");
    expect(() => evidence.reviewVerdictItems({ items: [item], errors: ["tool failure"] }))
      .toThrow("pass conflicts with incomplete safe outputs");
  });

  it("keeps independent code review separate from specialist label escalation", async () => {
    const h = harness("Agentic code review");
    const packet = await evidence.collectReviewPacket(h);
    h.state.pull.labels.push({ name: "security-review" });
    expect(await evidence.publishReviewVerdict({ ...h, packet, items: [verdict(packet)] })).toMatchObject({ published: true });
  });

  it("records the attempt before model execution and completes that exact check once", async () => {
    const h = harness();
    const packet = await evidence.collectReviewPacket(h);
    h.env.PACKET_DIGEST = packet.packetDigest;
    const attempt = await evidence.recordReviewAttempt({ ...h, packet });
    expect(attempt.ready).toBe(true);
    expect(h.state.checks.find((check) => check.id === attempt.checkId)).toMatchObject({
      head_sha: SHA, name: "QA verification", status: "in_progress",
    });
    await evidence.publishReviewVerdict({ ...h, packet, items: [verdict(packet)] });
    expect(h.github.rest.checks.create).toHaveBeenCalledTimes(1);
    expect(h.github.rest.checks.update).toHaveBeenCalledWith(expect.objectContaining({
      check_run_id: attempt.checkId, status: "completed", conclusion: "success",
    }));
  });

  it("keeps the real missing-target noop reproduction incomplete rather than synthesizing a verdict", async () => {
    const h = harness();
    const packet = await evidence.collectReviewPacket(h);
    h.env.PACKET_DIGEST = packet.packetDigest;
    await evidence.recordReviewAttempt({ ...h, packet });
    const agentOutput = { items: [{ type: "noop",
      message: "Code review could not run: only main branch context is available; no dispatched PR/head can be resolved." }] };
    await expect(evidence.publishReviewVerdict({
      ...h, packet, items: agentOutput.items.filter((item) => item.type === "create_pr_check"),
    })).rejects.toMatchObject({ code: "invalid_verdict" });
    expect(h.github.rest.checks.update).not.toHaveBeenCalled();
    expect(h.state.checks.at(-1).status).toBe("in_progress");
  });

  it("publishes explicit CI-wait infrastructure before the model and never changes a real rejection", async () => {
    const h = harness();
    h.state.checks[0].status = "in_progress";
    h.state.checks[0].conclusion = null;
    h.state.jobs.get(500)[0].status = "in_progress";
    h.state.jobs.get(500)[0].conclusion = null;
    const packet = await evidence.collectReviewPacket(h);
    h.env.PACKET_DIGEST = packet.packetDigest;
    expect(await evidence.recordReviewAttempt({ ...h, packet })).toMatchObject({ ready: false });
    expect(h.state.checks.at(-1)).toMatchObject({ name: "QA verification", conclusion: "action_required" });
    h.addReview("QA verification", "reject");
    const previousWrites = h.github.rest.checks.create.mock.calls.length;
    expect(await evidence.recordReviewAttempt({ ...h, packet })).toMatchObject({ reason: "substantive_rejection_preserved" });
    expect(h.github.rest.checks.create).toHaveBeenCalledTimes(previousWrites);
  });

  it("rejects an older publisher after a newer trusted bound attempt starts", async () => {
    const h = harness();
    const packet = await evidence.collectReviewPacket(h);
    h.state.runs.push({ ...h.state.runs.find((run) => run.id === 900),
      id: 1000, status: "in_progress", conclusion: null });
    await expect(evidence.publishReviewVerdict({ ...h, packet, items: [verdict(packet)] }))
      .rejects.toMatchObject({ code: "stale_evidence" });
    expect(h.github.rest.checks.create).not.toHaveBeenCalled();
  });

  it.each(["pass", "reject", "infrastructure"])("publishes %s only with the sealed packet and explicit schema", async (value) => {
    const h = harness();
    const packet = await evidence.collectReviewPacket(h);
    const result = await evidence.publishReviewVerdict({ ...h, packet, items: [verdict(packet, value)] });
    expect(result.published).toBe(true);
    const created = h.github.rest.checks.create.mock.calls[0][0];
    expect(created).toMatchObject({
      head_sha: SHA, name: "QA verification",
      conclusion: { pass: "success", reject: "failure", infrastructure: "action_required" }[value],
    });
    expect(evidence.receipt(created, evidence.REVIEW_MARKER)).toMatchObject({
      packetDigest: packet.packetDigest, headSha: SHA, workflowSha: BASE, runId: 900,
      packetArtifact: { id: 1900, preparationJobId: 1000 },
    });
  });

  it.each(["head", "ci attempt", "scope", "requirements"])("fails closed if %s changes after review", async (change) => {
    const h = harness();
    h.factoryScope();
    const packet = await evidence.collectReviewPacket(h);
    if (change === "head") h.state.pull.head.sha = "c".repeat(40);
    if (change === "ci attempt") {
      h.state.checks.push({ ...h.state.checks[0], id: 503, status: "queued", conclusion: null });
    }
    if (change === "scope") h.state.issues.get(20).body += "\nAdditional acceptance criteria.";
    if (change === "requirements") h.state.pull.labels.push({ name: "security-review" });
    await expect(evidence.publishReviewVerdict({ ...h, packet, items: [verdict(packet)] })).rejects.toBeInstanceOf(evidence.EvidenceError);
    expect(h.github.rest.checks.create).not.toHaveBeenCalled();
  });

  it("never turns failing required CI into a pass, even if the author and wrapper claim success", async () => {
    const h = harness();
    h.state.checks[0].conclusion = "failure";
    h.state.jobs.get(500)[0].conclusion = "failure";
    const packet = await evidence.collectReviewPacket(h);
    expect(packet.ready).toBe(true);
    await expect(evidence.publishReviewVerdict({ ...h, packet, items: [verdict(packet)] }))
      .rejects.toMatchObject({ code: "invalid_verdict" });
  });

  it.each(["digest", "schema", "head", "duplicate", "attempt", "artifact"])("refuses invalid %s evidence", async (invalid) => {
    const h = harness();
    const packet = await evidence.collectReviewPacket(h);
    const item = verdict(packet);
    if (invalid === "digest") item.packet_digest = "f".repeat(64);
    if (invalid === "schema") item.schema_version = "2";
    if (invalid === "head") item.head_sha = BASE;
    if (invalid === "attempt") h.env.GITHUB_RUN_ATTEMPT = "2";
    if (invalid === "artifact") h.state.artifacts.get(900)[0].created_at = "2026-09-15T00:10:00Z";
    await expect(evidence.publishReviewVerdict({
      ...h, packet, items: invalid === "duplicate" ? [item, item] : [item],
    })).rejects.toBeInstanceOf(evidence.EvidenceError);
    expect(h.github.rest.checks.create).not.toHaveBeenCalled();
  });

  it("is idempotent on replay and preserves real same-head rejection over a later preferred answer", async () => {
    const h = harness();
    const packet = await evidence.collectReviewPacket(h);
    await evidence.publishReviewVerdict({ ...h, packet, items: [verdict(packet)] });
    expect(await evidence.publishReviewVerdict({ ...h, packet, items: [verdict(packet)] }))
      .toMatchObject({ published: false, reason: "idempotent_replay" });
    expect(h.github.rest.checks.create).toHaveBeenCalledTimes(1);
    h.addReview("QA verification", "reject");
    expect(await evidence.publishReviewVerdict({ ...h, packet, items: [verdict(packet)] }))
      .toMatchObject({ published: false, reason: "substantive_rejection_preserved" });
    expect((await evidence.collectReviewPacket(h)).ready).toBe(false);
    expect(h.github.rest.checks.create).toHaveBeenCalledTimes(1);
  });
});

describe("trusted CI dispatch bridge", () => {
  function ciHarness() {
    const h = harness();
    h.env.CORRELATION_ID = evidence.correlationId("ci.yml", 7, SHA);
    const run = h.state.runs.find((item) => item.id === 900);
    Object.assign(run, { path: ".github/workflows/ci.yml", display_title: h.env.CORRELATION_ID });
    h.state.jobs.set(900, evidence.CI_CHECKS.map((name, index) => ({
      id: 901 + index, name, status: "completed", conclusion: "success", run_attempt: 1,
    })));
    return h;
  }

  it("bridges only verified job outcomes to the requested SHA, not the workflow SHA", async () => {
    const h = ciHarness();
    const preparation = await evidence.prepareCiDispatch(h);
    const outcomes = Object.fromEntries(evidence.CI_CHECKS.map((name) => [name, "success"]));
    await evidence.publishCiChecks({ ...h, preparation, outcomes });
    expect(h.github.rest.checks.create).toHaveBeenCalledTimes(2);
    for (const [check] of h.github.rest.checks.create.mock.calls) {
      expect(check.head_sha).toBe(SHA);
      expect(evidence.receipt(check, evidence.CI_MARKER)).toMatchObject({
        headSha: SHA, workflowSha: BASE, runId: 900, runAttempt: 1, pullNumber: 7,
      });
    }
    const collected = await evidence.collectCiEvidence(h.github, h.context, SHA, h.state.checks);
    expect(collected).toMatchObject({ complete: true, state: "success" });
    await evidence.publishCiChecks({ ...h, preparation, outcomes });
    expect(h.github.rest.checks.create).toHaveBeenCalledTimes(2);
  });

  it.each(["failure", "skipped", "cancelled", "timed_out"])("does not convert a %s job to successful evidence", async (conclusion) => {
    const h = ciHarness();
    h.state.jobs.get(900)[0].conclusion = conclusion;
    const preparation = await evidence.prepareCiDispatch(h);
    await evidence.publishCiChecks({ ...h, preparation, outcomes: {
      [evidence.CI_CHECKS[0]]: conclusion, [evidence.CI_CHECKS[1]]: "success",
    } });
    expect(h.github.rest.checks.create.mock.calls[0][0].conclusion).toBe(conclusion);
  });

  it.each(["pending", "head moved", "wrong attempt", "403", "outcome mismatch"])("blocks CI publication for %s", async (reason) => {
    const h = ciHarness();
    const preparation = await evidence.prepareCiDispatch(h);
    if (reason === "pending") h.state.jobs.get(900)[0].status = "in_progress";
    if (reason === "head moved") h.state.pull.head.sha = BASE;
    if (reason === "wrong attempt") h.state.runs.find((run) => run.id === 900).run_attempt = 2;
    if (reason === "403") h.github.rest.actions.listJobsForWorkflowRunAttempt.mockRejectedValue(Object.assign(new Error("forbidden"), { status: 403 }));
    const outcomes = Object.fromEntries(evidence.CI_CHECKS.map((name) => [name, "success"]));
    if (reason === "outcome mismatch") outcomes[evidence.CI_CHECKS[0]] = "failure";
    await expect(evidence.publishCiChecks({ ...h, preparation, outcomes })).rejects.toBeInstanceOf(evidence.EvidenceError);
    expect(h.github.rest.checks.create).not.toHaveBeenCalled();
  });
});
