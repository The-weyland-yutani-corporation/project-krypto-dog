import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { baseIssues, goalBody, harness, issue, NOW, workBody } from "./fixtures/factory-intake";

const intake = require("../../.github/scripts/agentic-intake-runtime.cjs");
const queue = require("../../.github/scripts/agentic-queue-controller.cjs");
const runtime = require("../../.github/scripts/agentic-queue-runtime.cjs");
const promoter = require("../../.github/scripts/agentic-backlog-promoter-runtime.cjs");

function proposal(h: ReturnType<typeof harness>, number = 300, body = h.requireIssue(number).body) {
  const original = h.requireIssue(number);
  return { issue: number, body, expected_body: original.body, expected_updated_at: original.updated_at };
}

function apply(h: ReturnType<typeof harness>, stage = "pm", number = 300, body?: string) {
  return intake.applyWorkItemProposal({
    github: h.github, core: h.core, context: h.context(number), stage, now: NOW, proposal: proposal(h, number, body),
  });
}

describe("bounded immutable PM/EM intake", () => {
  it("materializes an admitted proposal as one native goal leaf, then becomes genuinely queue eligible", async () => {
    const h = harness({ parents: { 300: null } });
    const original = structuredClone(h.requireIssue(300));
    const body = workBody({ "Acceptance criteria": "One precise, newly authored failure oracle." });
    const result = await apply(h, "pm", 300, body);
    expect(result).toMatchObject({ ok: true, applied: true, dispatched: true });
    expect(h.github.rest.issues.create).toHaveBeenCalledTimes(1);
    const child = result.issue;
    expect(child).not.toBe(300);
    expect(h.parents.get(child)).toBe(248);
    expect(h.requireIssue(child).milestone?.number).toBe(1);
    expect(h.requireIssue(child).labels).toContain("ready-for-planning");
    expect(h.requireIssue(300)).toEqual(original);
    expect(h.github.rest.actions.createWorkflowDispatch).toHaveBeenCalledWith(expect.objectContaining({
      workflow_id: "em-planning.lock.yml", ref: "main",
      inputs: { scope: String(child), aw_context: JSON.stringify({ item_type: "issue", item_number: child }) },
    }));
    const replay = await apply(h, "pm", 300, body);
    expect(replay).toMatchObject({ ok: true, replayed: true, dispatched: false, issue: child });
    expect(h.github.rest.issues.create).toHaveBeenCalledTimes(1);
    expect(h.github.rest.actions.createWorkflowDispatch).toHaveBeenCalledTimes(1);
    expect(await apply(h, "em", child)).toMatchObject({ ok: true, applied: true, dispatched: false });
    const authority = await intake.loadIntakeAuthority({ github: h.github, core: h.core, context: h.context(child), now: NOW });
    const candidate = await runtime.buildCandidate({
      github: h.github, core: h.core, owner: "example", repo: "krypto", issue: h.requireIssue(child), activeGoalNumber: 248,
    });
    expect(queue.evaluateEligibility(candidate, authority.config)).toEqual([]);
    expect(queue.selectNextIssue([candidate], authority.config).selected.number).toBe(child);
    expect(await apply(h, "em", child)).toMatchObject({ ok: true, replayed: true, dispatched: false });
    expect(h.github.rest.issues.update).not.toHaveBeenCalled();
  });

  it("advances an unchanged, already bound leaf without creating another issue", async () => {
    const h = harness();
    expect(await apply(h)).toMatchObject({ ok: true, issue: 300 });
    expect(h.github.rest.issues.create).not.toHaveBeenCalled();
    expect(h.requireIssue(300).body).toBe(workBody());
  });

  it.each([
    ["paused", { labels: ["factory-control", "factory-mode:paused"] }, "factory-not-active"],
  ])("refuses %s mode without writes", async (_name, overrides, reason) => {
    const issues = baseIssues();
    issues[0] = issue(233, overrides);
    const h = harness({ issues });
    expect((await apply(h)).reasons).toContain(reason);
    expect(h.github.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it("rejects multiple approved goals without choosing one", async () => {
    const h = harness({ issues: [...baseIssues(), issue(274, { body: goalBody(), labels: ["factory:goal", "factory:goal-approved"] })] });
    expect((await apply(h)).reasons).toContain("multiple-active-goals");
    expect(h.github.rest.issues.addLabels).not.toHaveBeenCalled();
  });

  it("refuses unrelated work inside broad allowed paths when goal prose names specific opportunities", async () => {
    const issues = baseIssues();
    issues[1].body = goalBody({ "Allowed scope": "Only remaining software work for #16 and #44." });
    const h = harness({ issues });
    expect((await apply(h)).reasons).toContain("goal-prose-scope-unproven");
    expect(h.github.rest.issues.createComment).not.toHaveBeenCalled();
    const proposed = workBody({ "Context, links, or constraints": "Scope source: #16" });
    expect((await apply(h, "pm", 300, proposed)).reasons).toContain("scope-source-ambiguous-or-changed");
  });

  it("rejects a forged Scope source and copied intake markers, even under the right goal", async () => {
    const issues = [...baseIssues(), issue(16)];
    issues[1].body = goalBody({ "Allowed scope": "Only remaining software work for #16 and #44." });
    const fingerprint = "a".repeat(64);
    issues[2].body = `<!-- factory-intake-leaf:v1 ${JSON.stringify({ sourceIssue: 16, fingerprint })} -->\n\n` +
      workBody({ "Context, links, or constraints": "Scope source: #16" });
    const bodySha256 = createHash("sha256").update(issues[2].body).digest("hex");
    const h = harness({ issues, comments: { 16: [
      { id: 1, created_at: NOW, user: { type: "User", login: "forger" }, body: `<!-- factory-intake:v1 ${JSON.stringify({ stage: "pm", sourceIssue: 16, fingerprint })} -->` },
      { id: 2, created_at: NOW, user: { type: "User", login: "forger" }, body: `<!-- factory-intake-result:v1 ${JSON.stringify({ stage: "pm", fingerprint, issue: 300, bodySha256, completed: true })} -->` },
    ] } });
    expect((await apply(h)).reasons).toContain("scope-source-provenance-unverified");
    expect(h.github.rest.issues.create).not.toHaveBeenCalled();
  });

  it("verifies a derived leaf against the goal-listed anchor's trusted immutable result receipt", async () => {
    const issues = [...baseIssues(), issue(16)];
    issues[1].body = goalBody({ "Allowed scope": "Only remaining software work for #16 and #44." });
    const h = harness({ issues, parents: { 16: null } });
    const result = await apply(h, "pm", 16, workBody({ "Acceptance criteria": "Concrete regression for scoped anchor #16." }));
    expect(result).toMatchObject({ ok: true, applied: true });
    expect(h.requireIssue(result.issue).body).toContain("Scope source: #16");
    expect(await apply(h, "em", result.issue)).toMatchObject({ ok: true });
    h.requireIssue(result.issue).body += "\nUnrelated scope injected later.";
    const candidate = await runtime.buildCandidate({ github: h.github, core: h.core, owner: "example", repo: "krypto",
      issue: h.requireIssue(result.issue), activeGoalNumber: 248 });
    expect(candidate.scopeProofReasons).toContain("scope-source-provenance-unverified");
  });

  it("accepts the documented trusted signal admission receipt and reuses its complete leaf through PM and EM", async () => {
    const issues = [...baseIssues(), issue(16)];
    issues[1].body = goalBody({ "Allowed scope": "Only remaining software work for #16 and #44." });
    const fingerprint = "b".repeat(64);
    issues[2].body = workBody({ "Context, links, or constraints": `Scope source: #16\n<!-- factory-signal:v1 ${fingerprint} -->` });
    const admission = {
      schemaVersion: 1, fingerprint, sourceIssueNumber: 16, issueNumber: 300, goalNumber: 248,
      bodySha256: createHash("sha256").update(issues[2].body).digest("hex"), phase: "native-linked",
    };
    const h = harness({ issues, parents: { 16: 248 }, comments: { 16: [{
      id: 1, created_at: NOW, user: { type: "Bot", login: "github-actions[bot]" },
      body: `<!-- factory-signal-admission:v1 ${JSON.stringify(admission)} -->`,
    }] } });
    const forged = [{ body: `<!-- factory-signal-admission:v1 ${JSON.stringify(admission)} -->`, user: { type: "User", login: "forger" } }];
    expect(runtime.hasVerifiedSignalScope(issues[2], 16, 248, forged, 248)).toBe(false);
    expect(runtime.hasVerifiedSignalScope(issues[2], 16, 248, h.comments.get(16), 999)).toBe(false);
    expect(await apply(h)).toMatchObject({ ok: true, issue: 300 });
    expect(await apply(h, "em")).toMatchObject({ ok: true, issue: 300 });
    expect(h.github.rest.issues.create).not.toHaveBeenCalled();
    expect(h.requireIssue(16).labels).toContain("needs-triage");
    expect(h.requireIssue(300).labels).toContain("ready-for-ai-dev");
    h.requireIssue(16).labels.push("blocked");
    const blockedSource = await runtime.buildCandidate({ github: h.github, core: h.core, owner: "example", repo: "krypto",
      issue: h.requireIssue(300), activeGoalNumber: 248 });
    expect(blockedSource.scopeProofReasons).toContain("scope-source-blocked");
    h.requireIssue(16).labels = h.requireIssue(16).labels.filter((label) => label !== "blocked");
    h.requireIssue(300).body += "\nForged scope after admission.";
    const candidate = await runtime.buildCandidate({ github: h.github, core: h.core, owner: "example", repo: "krypto",
      issue: h.requireIssue(300), activeGoalNumber: 248 });
    expect(candidate.scopeSourceVerified).toBe(false);
  });

  it.each([
    ["missing dependency declaration", workBody({ Dependencies: "_No response_" }), "dependencies-unknown"],
    ["ambiguous parent", workBody({ "Approved parent goal": "#248 and #274" }), "parent-goal-mismatch"],
    ["duplicate field", `${workBody()}\n\n### Risk tier\n\nrisk:sensitive`, "duplicate-field:Risk tier"],
    ["out-of-scope path", workBody({ "Allowed paths": "src/trading/policy.ts" }), "scope-exceeds-goal"],
  ])("rejects %s with structured reasons", async (_name, body, reason) => {
    const h = harness();
    expect((await apply(h, "pm", 300, body)).reasons).toContain(reason);
    expect(h.github.rest.issues.create).not.toHaveBeenCalled();
    expect(h.github.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it("rejects wrong native parents and open PRs (including closing-keyword linkage)", async () => {
    expect((await apply(harness({ parents: { 300: 16 } }))).reasons).toContain("native-parent-mismatch");
    const h = harness({ pulls: [{ number: 309, body: "Fixes #300" }] });
    expect((await apply(h)).reasons).toContain("already-has-open-pull-request");
  });

  it.each(["blocked", "ready-for-human-review", "factory:claimed"])("does not clear %s", async (state) => {
    const issues = baseIssues();
    issues[2].labels = ["agentic-factory", state, "risk:routine", "priority:P1"];
    const h = harness({ issues });
    expect((await apply(h)).ok).toBe(false);
    expect(h.github.rest.issues.removeLabel).not.toHaveBeenCalled();
  });

  it("refuses stale leases even if lifecycle labels look ready for triage", async () => {
    const h = harness({ comments: { 300: [{
      id: 1, created_at: NOW, user: { type: "Bot", login: "github-actions[bot]" },
      body: '<!-- factory-claim:v1 {"nonce":"old:1:300","owner":"old","issueNumber":300,"expiresAt":"2020-01-01T00:00:00Z"} -->',
    }] } });
    expect((await apply(h)).reasons).toContain("stale-claim-requires-recovery");
  });

  it.each(["wip", "budget"])("honors exhausted %s", async (dimension) => {
    const issues = baseIssues();
    issues[1].body = goalBody(dimension === "wip"
      ? { "Maximum active coding-agent sessions": "0" } : { "Assignment budget": "0" });
    const h = harness({ issues });
    expect((await apply(h)).reasons).toContain(dimension === "wip" ? "concurrency-limit-reached" : "budget-limit-reached");
    expect(h.github.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it("does not free assignment budget when a claimed issue's parent field becomes ambiguous", async () => {
    const issues = [...baseIssues(), issue(400, {
      labels: ["agentic-factory", "blocked"],
      body: workBody({ "Approved parent goal": "#248 or #274" }),
    })];
    const h = harness({ issues, comments: { 400: [{
      id: 1, created_at: NOW, user: { type: "Bot", login: "github-actions[bot]" },
      body: '<!-- factory-claim:v1 {"nonce":"old:1:400","owner":"old","issueNumber":400,"expiresAt":"2020-01-01T00:00:00Z"} -->',
    }] } });
    expect(await runtime.countBudgetConsumption(h.github, "example", "krypto", 248, h.core)).toBe(Infinity);
    expect((await apply(h)).reasons).toContain("budget-limit-reached");
  });

  it("fails on missing write permissions rather than inventing capabilities", async () => {
    const h = harness({ failWrite: true });
    expect((await apply(h)).reasons).toContain("intake-permission-denied");
    expect(h.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it("leaves failed or uncertain handoffs visibly reserved and never redispatches", async () => {
    const h = harness({ failDispatch: true });
    expect((await apply(h)).reasons).toContain("handoff-delivery-uncertain-human-recovery");
    expect((await apply(h)).reasons).toContain("intake-reservation-unresolved-human-recovery");
    expect(h.github.rest.actions.createWorkflowDispatch).toHaveBeenCalledTimes(1);
  });

  it("preserves a concurrent human body edit and refuses stale snapshots", async () => {
    const h = harness();
    const old = proposal(h);
    h.requireIssue(300).body += "\nHuman's newer constraints.";
    const result = await intake.applyWorkItemProposal({ github: h.github, core: h.core, context: h.context(), stage: "pm", proposal: old, now: NOW });
    expect(result.reasons).toContain("stale-proposal");
    expect(h.requireIssue(300).body).toContain("Human's newer constraints.");
    expect(h.github.rest.issues.update).not.toHaveBeenCalled();
  });

  it("never overwrites a concurrent hard stop with a full label replacement", async () => {
    const h = harness({ beforeLabels: (item) => item.labels.push("blocked") });
    expect((await apply(h)).reasons).toContain("intake-write-verification-failed");
    expect(h.requireIssue(300).labels).toContain("blocked");
    expect(h.github.rest.issues.removeLabel).not.toHaveBeenCalledWith(expect.objectContaining({ name: "blocked" }));
    expect(h.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it("uses the native /parent API and preserves unknown dependencies in the promoter", async () => {
    const h = harness();
    const candidate = await promoter.buildCandidate({ github: h.github, core: h.core, owner: "example", repo: "krypto",
      issue: issue(300, { body: workBody({ Dependencies: "_No response_" }) }), activeGoalNumber: 248 });
    expect(candidate.parentGoalNumber).toBe(248);
    expect(candidate.dependencyStates).toBeNull();
    expect(h.github.request).toHaveBeenCalledWith("GET /repos/{owner}/{repo}/issues/{issue_number}/parent", expect.objectContaining({ issue_number: 300 }));
  });
});

describe("trusted intake workflow wiring", () => {
  const parseWorkflow = (name: string) => {
    const text = readFileSync(resolve(".github", "workflows", name), "utf8");
    return YAML.parse(name.endsWith(".md") ? text.split("---")[1] : text);
  };
  it.each(["pm-triage.md", "em-planning.md"])("%s enforces one trusted safe-output path", (name) => {
    const workflow = parseWorkflow(name);
    expect(workflow.permissions.issues).toBe("read");
    expect(workflow["safe-outputs"]["create-issue"]).toBeUndefined();
    expect(workflow["safe-outputs"]["add-labels"]).toBeUndefined();
    expect(workflow.concurrency).toEqual({ group: "factory-queue-controller", "cancel-in-progress": false });
    const job = workflow["safe-outputs"].jobs["apply-work-item"];
    expect(job.if).toContain("needs.detection.outputs.detection_success == 'true'");
    expect(job.permissions.issues).toBe("write");
    expect(job.steps[0].with.ref).toBe("${{ github.event.repository.default_branch }}");
    expect(job.steps[0].with["persist-credentials"]).toBe(false);
  });
  it("gives the scheduled readiness workflow only read scopes", () => {
    const workflow = parseWorkflow("factory-readiness.yml");
    expect(Object.values(workflow.permissions).every((value) => value === "read")).toBe(true);
    expect(workflow.on.schedule).toHaveLength(1);
  });
});
