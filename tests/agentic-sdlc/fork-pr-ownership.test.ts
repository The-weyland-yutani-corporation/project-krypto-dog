import { baseIssues, harness, NOW } from "./fixtures/factory-intake";

const runtime = require("../../.github/scripts/agentic-queue-runtime.cjs");
const intake = require("../../.github/scripts/agentic-intake-runtime.cjs");
const readiness = require("../../.github/scripts/agentic-factory-readiness.cjs");
const repository = { owner: "example", repo: "krypto" };
const trustedRepo = { id: 10, full_name: "example/krypto" };
const forkRepo = { id: 20, full_name: "outsider/krypto" };
const url = "https://api.github.com/repos/example/krypto/pulls/900";
const claim = runtime.buildClaimCommentBody({
  nonce: "run:1:300", owner: "queue", issueNumber: 300, expiresAt: NOW,
});
const nativeTimeline = [{ source: { issue: { number: 900, pull_request: { url } } } }];

function pull(body: string, headRepo: unknown = trustedRepo, baseRepo: unknown = trustedRepo) {
  return { number: 900, body, url, head: { repo: headRepo }, base: { repo: baseRepo } };
}

function hasOpenPR(h: ReturnType<typeof harness>) {
  return runtime.resolveHasOpenPullRequest({ github: h.github, core: h.core, ...repository, issueNumber: 300 });
}

describe("PR ownership requires trusted same-repository heads", () => {
  it.each(["Refs #300", "Fixes #300", "Closes #300", "Resolves #300", claim])(
    "does not let a fork-backed PR take ownership through %s",
    async (body) => {
      const pr = pull(body, forkRepo);
      expect(runtime.linkedPullRequestNumbers([pr], 300, [], repository)).toEqual([]);
      expect(await hasOpenPR(harness({ pulls: [pr] }))).toBe(false);
      expect(await hasOpenPR(harness({ pulls: [pull(body)] }))).toBe(true);
    },
  );

  it("ignores fork-backed native links while preserving exact same-repo URL linkage", async () => {
    expect(runtime.linkedPullRequestNumbers([pull("Details", forkRepo)], 300, nativeTimeline, repository)).toEqual([]);
    expect(runtime.linkedPullRequestNumbers([pull("Details")], 300, nativeTimeline, repository)).toEqual([900]);
    for (const headRepo of [forkRepo, trustedRepo]) {
      const h = harness({ pulls: [pull("Details", headRepo)] });
      h.github.rest.issues.listEventsForTimeline.mockResolvedValueOnce([Object.assign({
        event: "cross-referenced", created_at: NOW, actor: { type: "User", login: "contributor" }, label: { name: "" },
      }, nativeTimeline[0])]);
      expect(await hasOpenPR(h)).toBe(headRepo === trustedRepo);
    }
  });

  it.each([
    undefined,
    null,
    {},
    { id: 10 },
    { full_name: "example/krypto" },
    { id: 20, full_name: "example/krypto" },
    { id: 10, full_name: "outsider/krypto" },
    { id: 10, full_name: 123 },
  ])("treats missing or ambiguous head identity as non-authoritative: %j", async (headRepo) => {
    const pr = { ...pull("Fixes #300"), head: { repo: headRepo } };
    expect(runtime.linkedPullRequestNumbers([pr], 300, nativeTimeline, repository)).toEqual([]);
    const h = harness({ pulls: [pr] });
    expect(await hasOpenPR(h)).toBe(false);
    expect(h.core.warning).not.toHaveBeenCalled();
  });

  it("does not accept internally matching foreign repositories as the trusted repository", async () => {
    expect(await hasOpenPR(harness({ pulls: [pull("Refs #300", forkRepo, forkRepo)] }))).toBe(false);
    expect(await hasOpenPR(harness({ pulls: [pull("Refs #300", trustedRepo, forkRepo)] }))).toBe(false);
    expect(await hasOpenPR(harness({ pulls: [pull("Refs #300", trustedRepo, { id: 10, full_name: "foreign/other" })] }))).toBe(false);
  });

  it.each([{ head: null }, { base: null }, { base: { repo: {} } }])(
    "does not crash or claim ownership for incomplete PR repository envelopes: %j",
    async (missing) => {
      expect(await hasOpenPR(harness({ pulls: [{ ...pull("Refs #300"), ...missing }] }))).toBe(false);
    },
  );

  it("does not let a fork PR suppress a ready issue's claim or dispatch", async () => {
    const issues = baseIssues();
    issues[2].labels = ["agentic-factory", "ready-for-ai-dev", "risk:routine", "priority:P1"];
    const h = harness({ issues, pulls: [pull("Closes #300", forkRepo)] });
    const result = await runtime.runFactoryQueueController({
      github: h.github, core: h.core, context: h.context(),
      config: { now: NOW, runId: "fork-regression", attempt: 1 },
    });
    expect(result).toMatchObject({ selected: { number: 300 }, claimed: true, dispatched: true });
    expect(h.github.rest.actions.createWorkflowDispatch).toHaveBeenCalledTimes(1);
  });

  it("does not let a fork PR suppress a legitimately enrolled PM source", async () => {
    const h = harness({ pulls: [pull("Fixes #300", forkRepo)] });
    const source = h.requireIssue(300);
    const result = await intake.applyWorkItemProposal({
      github: h.github, core: h.core, context: h.context(), stage: "pm", now: NOW,
      proposal: { issue: 300, body: source.body, expected_body: source.body, expected_updated_at: source.updated_at },
    });
    expect(result).toMatchObject({ ok: true, applied: true, issue: 300 });
    expect(h.github.rest.actions.createWorkflowDispatch).toHaveBeenCalledTimes(1);
  });

  it("preserves fork PRs in read-only disposition without attributing issue ownership", () => {
    const issues = baseIssues();
    issues[2].labels = ["agentic-factory", "ready-for-ai-dev", "risk:routine", "priority:P1"];
    const report = readiness.buildFactoryReadinessReport({
      observedAt: NOW, repository, issues, pulls: [pull("Resolves #300", forkRepo)], reads: [],
      details: Object.fromEntries(issues.map((issue) => [issue.number, {
        parent: { number: 248, repository_url: "https://api.github.com/repos/example/krypto" },
        comments: [], subIssues: [], blockedBy: [],
        timeline: issue.labels.map((name) => ({ event: "labeled", label: { name }, actor: { type: "User" }, created_at: NOW })),
      }])),
      capabilities: { modelVariables: [], modelAvailability: [], workflows: [] },
    });
    expect(report.candidates.find((candidate: { number: number }) => candidate.number === 300)).toMatchObject({
      linkedPullRequests: [], hypotheticalReady: true,
    });
    expect(report.capacity.ownershipSignals).not.toContain(300);
    expect(report.pullRequests).toContainEqual(expect.objectContaining({
      number: 900, issues: [], ownershipAuthoritative: false, apply: false,
    }));
  });
});
