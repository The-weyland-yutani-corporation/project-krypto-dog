import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { baseIssues, harness, NOW } from "./fixtures/factory-intake";

const runtime = require("../../.github/scripts/agentic-queue-runtime.cjs");

const hasOpenPR = (h: ReturnType<typeof harness>) => runtime.resolveHasOpenPullRequest({
  github: h.github, core: h.core, owner: "example", repo: "krypto", issueNumber: 300,
});

describe("canonical linked-open-PR detection", () => {
  it.each(["Refs", "Ref", "Fixes", "Fixed", "Fix", "Closes", "Closed", "Close", "Resolves", "Resolved", "Resolve", "fixes"])(
    "protects an existing %s #300 PR without depending on indexed search",
    async (keyword) => {
      const h = harness({ pulls: [{ number: 900, body: `${keyword} #300` }] });
      expect(await hasOpenPR(h)).toBe(true);
      expect(h.github.rest.search.issuesAndPullRequests).not.toHaveBeenCalled();
    },
  );

  it.each(["Refs #3000", "Fixes #30", "References issue #300 in a discussion.", "Fixes foreign/other#300"])(
    "does not associate unrelated text: %s",
    async (body) => {
      expect(await hasOpenPR(harness({ pulls: [{ number: 900, body }] }))).toBe(false);
    },
  );

  it("recognizes a claim-only PR without a Refs marker", async () => {
    const h = harness({ pulls: [{ number: 900, body: runtime.buildClaimCommentBody({
      nonce: "run:1:300", owner: "queue", issueNumber: 300, expiresAt: NOW,
    }) }] });
    expect(await hasOpenPR(h)).toBe(true);
  });

  it("matches native links by actual PR URL rather than a foreign issue's equal number", () => {
    const url = "https://api.github.com/repos/example/krypto/pulls/900";
    const pulls = [{ number: 900, body: "Implementation details.", url }];
    expect(runtime.linkedPullRequestNumbers(pulls, 300, [{
      source: { issue: { number: 900, pull_request: { url } } },
    }])).toEqual([900]);
    expect(runtime.linkedPullRequestNumbers(pulls, 300, [{
      source: { issue: { number: 900, pull_request: { url: "https://api.github.com/repos/foreign/other/pulls/900" } } },
    }])).toEqual([]);
  });

  it("does not claim or dispatch a ready issue whose implementation PR uses Closes", async () => {
    const issues = baseIssues();
    issues[2].labels = ["agentic-factory", "ready-for-ai-dev", "risk:routine", "priority:P1"];
    const h = harness({ issues, pulls: [{ number: 900, body: "Closes #300" }] });
    const result = await runtime.runFactoryQueueController({
      github: h.github, core: h.core, context: h.context(),
      config: { now: NOW, runId: "review-regression", attempt: 1 },
    });
    expect(result.selected).toBeNull();
    expect(result.rejections).toContainEqual(expect.objectContaining({
      number: 300, reasons: expect.arrayContaining(["already-has-open-pull-request"]),
    }));
    expect(h.github.rest.issues.createComment).not.toHaveBeenCalled();
    expect(h.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it("uses the paginated pull list so a closing reference beyond the first page is protected", async () => {
    const pulls = Array.from({ length: 100 }, (_, index) => ({ number: 900 + index, body: `Refs #${5000 + index}` }));
    pulls.push({ number: 1100, body: "Closes #300" });
    const h = harness({ pulls });
    expect(await hasOpenPR(h)).toBe(true);
    expect(h.github.paginate).toHaveBeenCalledWith(h.github.rest.pulls.list, expect.objectContaining({ state: "open", per_page: 100 }));
  });

  it("fails closed when listing open PRs is unavailable", async () => {
    const h = harness();
    h.github.rest.pulls.list.mockRejectedValueOnce(new Error("missing pull-requests read permission"));
    expect(await hasOpenPR(h)).toBe(true);
    expect(h.core.warning).toHaveBeenCalled();
  });

  it("fails closed when native link evidence is unavailable", async () => {
    const h = harness();
    h.github.rest.issues.listEventsForTimeline.mockRejectedValueOnce(new Error("timeline unavailable"));
    expect(await hasOpenPR(h)).toBe(true);
    expect(h.core.warning).toHaveBeenCalled();
  });
});

describe("trusted promoter runtime packaging", () => {
  it("explicitly checks out canonical policy data alongside the runtime scripts", () => {
    const workflow = YAML.parse(readFileSync(resolve(".github", "workflows", "factory-backlog-promoter.yml"), "utf8"));
    const checkout = workflow.jobs["promote-backlog"].steps[0];
    expect(checkout.with.ref).toBe("${{ github.event.repository.default_branch }}");
    expect(checkout.with["persist-credentials"]).toBe(false);
    expect(checkout.with["sparse-checkout"].split(/\r?\n/)).toEqual(expect.arrayContaining([
      ".github/scripts", ".github/agentic-policy.json",
    ]));
    expect(() => require("../../.github/scripts/agentic-backlog-promoter-runtime.cjs")).not.toThrow();
  });
});
