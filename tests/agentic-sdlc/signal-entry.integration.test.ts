import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { makeGithub, signalPayload, NOW, SHA, REPOSITORY, issue } from "./fixtures/signals";

const root = path.resolve(__dirname, "../..");
const contract = jest.requireActual<{
  fingerprintFor(source: Record<string, string>): string;
  validateSignal(signal: unknown, context: unknown): string[];
  proposalBody(signal: unknown, proposal: unknown): string;
}>("../../scripts/agentic/signal-contract.cjs");
const intake = jest.requireActual<{
  runSignalIntake(options: unknown): Promise<{ action: string; reasons: string[]; issueNumber: number; ready: boolean; completed: boolean }>;
  runSafeOutput(options: unknown): Promise<{ action: string; issueNumber: number }>;
}>("../../scripts/agentic/signal-intake.cjs");
const runtime = jest.requireActual<{
  parseCandidateSections(issue: unknown, goal: number): Record<string, unknown>;
}>("../../.github/scripts/agentic-queue-runtime.cjs");
const policy = jest.requireActual<{
  isLegalLifecycleTransition(from: string, to: string): boolean;
  getLifecycleTransitionOwner(from: string, to: string): string;
}>("../../.github/scripts/agentic-factory-policy.cjs");

function setup() {
  const fixture = makeGithub();
  const payload = signalPayload(contract.fingerprintFor);
  const options = { github: fixture.github, owner: "example", repo: "krypto", now: NOW, repoRoot: root, ...payload };
  return { fixture, payload, options };
}

describe("offline signal -> native goal child -> normal PM/EM intake", () => {
  it("previews by default with no GitHub mutations", async () => {
    const { fixture, options } = setup();
    expect(await intake.runSignalIntake(options)).toMatchObject({ action: "preview-eligible", ready: false, completed: false });
    expect(fixture.github.rest.issues.create).not.toHaveBeenCalled();
    expect(fixture.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it("creates exactly one complete direct-goal child and dispatches ordinary triage, never ready by fiat", async () => {
    const { fixture, options } = setup();
    const receipt = await intake.runSignalIntake({ ...options, apply: true });
    expect(receipt.action).toBe("created-triage-dispatched");
    const child = fixture.issues.find((item) => item.number === receipt.issueNumber)!;
    expect(fixture.parents.get(child.number)).toBe(248);
    expect(child.milestone?.title).toBe("v2.1 Safety and Correctness");
    expect(child.labels).toEqual(["agentic-factory", "needs-triage", "risk:sensitive"]);
    expect(child.body).toContain("Scope source: #16\n");
    expect(child.body).toContain(`<!-- factory-signal:v1 ${options.signal.fingerprint} -->`);
    const admission = fixture.comments.get(16)?.[0];
    expect(admission?.user.login).toBe("github-actions[bot]");
    expect(admission?.body).toContain(`"bodySha256":"${crypto.createHash("sha256").update(child.body).digest("hex")}"`);
    expect(admission?.body).toContain(`"issueNumber":${child.number}`);
    expect(runtime.parseCandidateSections(child, 248)).toMatchObject({
      hasAcceptanceCriteria: true, hasValidationPlan: true, hasScopeDefinition: true,
      hasRiskAssessment: true, hasRollbackPlan: true, parentGoalApproved: true,
    });
    expect(fixture.github.rest.actions.createWorkflowDispatch).toHaveBeenCalledWith({
      owner: "example", repo: "krypto", workflow_id: "pm-triage.lock.yml", ref: "main",
      inputs: { issue: String(child.number), aw_context: JSON.stringify({ item_type: "issue", item_number: child.number }) },
    });
    expect(policy.isLegalLifecycleTransition("needs-triage", "ready-for-planning")).toBe(true);
    expect(policy.getLifecycleTransitionOwner("needs-triage", "ready-for-planning")).toBe("product-manager");
    expect(policy.isLegalLifecycleTransition("ready-for-planning", "ready-for-ai-dev")).toBe(true);
    expect(policy.getLifecycleTransitionOwner("ready-for-planning", "ready-for-ai-dev")).toBe("engineering-manager");
    const replay = await intake.runSignalIntake({ ...options, apply: true });
    expect(replay.reasons).toContain("duplicate-signal");
    expect(fixture.github.rest.issues.create).toHaveBeenCalledTimes(1);
    expect(fixture.github.rest.actions.createWorkflowDispatch).toHaveBeenCalledTimes(1);
  });

  it.each(["", "@refs/heads/main", "@refs/tags/v2.1.0", "@refs/pull/600/merge"])(
    "corroborates a canonical signal against a workflow path with suffix %j",
    async (suffix) => {
      const { fixture, options } = setup();
      fixture.failedRun.path += suffix;
      expect(await intake.runSignalIntake({ ...options, apply: true })).toMatchObject({ action: "created-triage-dispatched" });
      expect(fixture.github.request).toHaveBeenCalledWith(
        "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs",
        expect.objectContaining({ workflow_id: "ci.yml", head_sha: SHA, branch: "main", created: `>=${options.signal.source.windowStart}` }),
      );
      expect(fixture.github.rest.issues.create).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["@notes", "@refs/", "@refs/heads/"])("rejects unrelated or incomplete workflow suffix %j", async (suffix) => {
    const { fixture, options } = setup();
    fixture.failedRun.path += suffix;
    expect((await intake.runSignalIntake({ ...options, apply: true })).reasons).toContain("source-run-not-corroborated");
    expect(fixture.github.rest.issues.create).not.toHaveBeenCalled();
  });

  it.each(["wrong-sha", "outside-window", "recovered"])("preserves %s rejection for ref-suffixed workflow paths", async (variant) => {
    const { fixture, options } = setup();
    fixture.failedRun.path += "@refs/heads/main";
    if (variant === "wrong-sha") fixture.failedRun.head_sha = "b".repeat(40);
    if (variant === "outside-window") fixture.failedRun.created_at = options.signal.source.windowEnd;
    if (variant === "recovered") fixture.failedRun.conclusion = "success";
    expect((await intake.runSignalIntake({ ...options, apply: true })).reasons).toContain("source-run-not-corroborated");
    expect(fixture.github.rest.issues.create).not.toHaveBeenCalled();
  });

  it("rejects a superseded ref-suffixed failure after querying the normalized workflow ID", async () => {
    const { fixture, options } = setup();
    fixture.failedRun.path += "@refs/tags/v2.1.0";
    const request = fixture.github.request.getMockImplementation()!;
    fixture.github.request.mockImplementation(async (route, params = {}) => {
      if (route === "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs" && params.workflow_id === "ci.yml") {
        return { data: { workflow_runs: [{ ...fixture.failedRun, id: 312, conclusion: "success" }], total_count: 1 } };
      }
      return request(route, params);
    });
    expect((await intake.runSignalIntake({ ...options, apply: true })).reasons).toContain("source-run-superseded");
    expect(fixture.github.rest.issues.create).not.toHaveBeenCalled();
  });

  it.each(["paused", "shadow"])("does not create work in %s mode", async (mode) => {
    const { fixture, options } = setup();
    fixture.issues[0].labels = ["factory-control", `factory-mode:${mode}`];
    const receipt = await intake.runSignalIntake({ ...options, apply: true });
    expect(receipt.reasons).toContain(`factory-${mode}`);
    expect(fixture.github.rest.issues.create).not.toHaveBeenCalled();
  });

  it("rechecks a human pause immediately before the first mutation", async () => {
    const { fixture, options } = setup();
    const request = fixture.github.request.getMockImplementation()!;
    let reads = 0;
    fixture.github.request.mockImplementation(async (route, params = {}) => {
      if (route === "GET /repos/{owner}/{repo}/issues" && params.state === "all" && ++reads === 3) {
        fixture.issues[0].labels = ["factory-control", "factory-mode:paused"];
      }
      return request(route, params);
    });
    expect(await intake.runSignalIntake({ ...options, apply: true })).toMatchObject({
      action: "rejected", reasons: ["authorization-changed-before-creation"],
    });
    expect(fixture.github.rest.issues.create).not.toHaveBeenCalled();
  });

  it("enters through the actual typed safe-output adapter with one immutable source receipt", async () => {
    const { fixture, payload } = setup();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "signal-safe-output-"));
    const outputPath = path.join(directory, "output.json");
    fs.writeFileSync(outputPath, JSON.stringify({ items: [{ type: "submit_signal", payload: JSON.stringify(payload) }] }));
    const summary = {
      addHeading: jest.fn().mockReturnThis(), addCodeBlock: jest.fn().mockReturnThis(),
      write: jest.fn(async () => undefined),
    };
    jest.useFakeTimers().setSystemTime(new Date(NOW));
    try {
      const result = await intake.runSafeOutput({
        github: fixture.github, repoRoot: root, outputPath, core: { info: jest.fn(), summary },
        context: { repo: { owner: "example", repo: "krypto" }, ref: "refs/heads/main", payload: { repository: { default_branch: "main" } } },
      });
      expect(result.action).toBe("created-triage-dispatched");
      expect(fixture.github.rest.issues.create).toHaveBeenCalledTimes(1);
      expect(fixture.parents.get(result.issueNumber)).toBe(248);
      expect(fixture.comments.get(16)?.[0].body).toContain("factory-signal-admission:v1");
    } finally {
      jest.useRealTimers();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["stale", "partial", "wrong-sha", "scope", "unlisted-anchor", "boundary", "no-oracle"])("rejects %s evidence or proposals", async (variant) => {
    const { fixture, options } = setup();
    if (variant === "stale") options.signal.observedAt = "2026-09-10T00:00:00Z";
    if (variant === "partial") options.signal.completeness = "partial";
    if (variant === "wrong-sha") options.signal.source.sha = "b".repeat(40);
    if (variant === "scope") options.proposal.allowedPaths = ["src/components/widget.tsx"];
    if (variant === "unlisted-anchor") {
      fixture.issues.push(issue(17, ["agentic-factory"]));
      fixture.parents.set(17, 248);
      options.proposal.scopeIssueNumber = 17;
    }
    if (variant === "boundary") {
      options.proposal.riskTier = "risk:boundary";
      options.proposal.allowedPaths = [".github/workflows/ci.yml"];
    }
    if (variant === "no-oracle") options.proposal.oracle.evidenceRef = options.proposal.baseline.evidenceRef;
    const receipt = await intake.runSignalIntake({ ...options, apply: true });
    expect(receipt.action).toBe("rejected");
    expect(receipt.reasons.length).toBeGreaterThan(0);
    expect(fixture.github.rest.issues.create).not.toHaveBeenCalled();
  });

  it("distinguishes conflicting goals and exhausted budgets without changing either", async () => {
    const { fixture, options } = setup();
    fixture.issues.push({ ...fixture.issues[1], number: 274 });
    expect((await intake.runSignalIntake({ ...options, apply: true })).reasons).toContain("goal-not-authorized");
    fixture.issues.pop();
    fixture.issues[1].body = fixture.issues[1].body.replace("### Assignment budget\n\n12", "### Assignment budget\n\n0");
    expect((await intake.runSignalIntake({ ...options, apply: true })).reasons).toContain("budget-limit-reached");
    expect(fixture.github.rest.issues.create).not.toHaveBeenCalled();
    expect(fixture.github.rest.issues.update).not.toHaveBeenCalled();
  });

  it("rejects incomplete API reads and unavailable current-SHA evaluation capacity", async () => {
    const { fixture, options } = setup();
    fixture.failures.set("GET /repos/{owner}/{repo}/issues", 503);
    expect((await intake.runSignalIntake({ ...options, apply: true })).reasons).toContain("source-incomplete");
    fixture.failures.clear();
    fixture.evalRuns[0].head_sha = "c".repeat(40);
    expect((await intake.runSignalIntake({ ...options, apply: true })).reasons).toContain("evaluation-capacity-unavailable");
    expect(fixture.github.rest.issues.create).not.toHaveBeenCalled();
  });

  it("does not turn an uncorroborated source assertion into work", async () => {
    const { fixture, options } = setup();
    fixture.failedRun.conclusion = "success";
    expect((await intake.runSignalIntake({ ...options, apply: true })).reasons).toContain("source-run-not-corroborated");
    expect(fixture.github.rest.issues.create).not.toHaveBeenCalled();
  });

  it("leaves explicit partial creation evidence on link failure and never duplicates it on replay", async () => {
    const { fixture, options } = setup();
    fixture.failures.set("POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues", 503);
    await expect(intake.runSignalIntake({ ...options, apply: true })).rejects.toMatchObject({
      intakeReceipt: { action: "incomplete", ready: false, completed: false },
    });
    fixture.failures.clear();
    expect((await intake.runSignalIntake({ ...options, apply: true })).reasons).toContain("duplicate-signal");
    expect(fixture.github.rest.issues.create).toHaveBeenCalledTimes(1);
    expect(fixture.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it("validates stable fingerprints independently of window and SHA changes", () => {
    const source = signalPayload(contract.fingerprintFor).signal.source;
    expect(contract.fingerprintFor(source)).toBe(contract.fingerprintFor({ ...source, sha: "b".repeat(40) }));
    const payload = signalPayload(contract.fingerprintFor);
    expect(contract.validateSignal(payload.signal, { now: NOW, repository: REPOSITORY })).toEqual([]);
    payload.signal.source.sha = SHA;
    payload.signal.fingerprint = "0".repeat(64);
    expect(contract.validateSignal(payload.signal, { now: NOW, repository: REPOSITORY })).toContain("invalid-fingerprint");
  });
});
