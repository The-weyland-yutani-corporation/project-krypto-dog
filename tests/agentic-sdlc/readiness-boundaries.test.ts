import { baseIssues, FixtureComment, issue, NOW } from "./fixtures/factory-intake";

const { createReadOnlyReader } = require("../../.github/scripts/agentic-readiness-reader.cjs");
const readiness = require("../../.github/scripts/agentic-factory-readiness.cjs");
const repository = { owner: "example", repo: "krypto" };
const nextLink = '<https://api.github.com/repos/example/krypto/issues?per_page=100&page=2>; rel="next"';
const rows = (count: number, offset = 0) => Array.from({ length: count }, (_, number) => ({ number: offset + number + 1 }));

describe("readiness pagination boundaries", () => {
  it.each([99, 100])("accepts an authoritative terminal page of %i items without a total", async (count) => {
    const github = { request: jest.fn(async () => ({ data: rows(count), headers: {} })) };
    const reader = createReadOnlyReader({ github, ...repository, maxPages: 1 });
    expect(await reader.list("GET /repos/{owner}/{repo}/issues")).toHaveLength(count);
    expect(reader.reads).toEqual([expect.objectContaining({ complete: true, pages: 1, count })]);
    expect(github.request).toHaveBeenCalledTimes(1);
  });

  it.each([1, 100])("follows next from a full page and accepts the terminal %i-item page", async (lastCount) => {
    const github = { request: jest.fn(async (_route: string, params: { page: number }) => params.page === 1
      ? { data: rows(100), headers: { link: nextLink } }
      : { data: rows(lastCount, 100), headers: {} }) };
    const reader = createReadOnlyReader({ github, ...repository, maxPages: 2 });
    expect(await reader.list("GET /repos/{owner}/{repo}/issues")).toHaveLength(100 + lastCount);
    expect(reader.reads[0]).toMatchObject({ complete: true, pages: 2, count: 100 + lastCount });
    expect(github.request).toHaveBeenCalledTimes(2);
  });

  it("does not treat a page limit as terminal when next is present", async () => {
    const reader = createReadOnlyReader({
      github: { request: async () => ({ data: rows(100), headers: { link: nextLink } }) },
      ...repository, maxPages: 1,
    });
    expect(await reader.list("GET /repos/{owner}/{repo}/issues")).toHaveLength(100);
    expect(reader.reads[0]).toMatchObject({ complete: false, reason: "api-list-incomplete" });
  });

  it("accepts a full last page with only previous/first links and a consistent total", async () => {
    const github = { request: jest.fn(async (_route: string, params: { page: number }) => ({
      data: { items: rows(100, (params.page - 1) * 100), total_count: 200 },
      headers: params.page === 1 ? { Link: nextLink } : {
        Link: '<https://api.github.com/repos/example/krypto/issues?page=1>; rel="prev", <https://api.github.com/repos/example/krypto/issues?page=1>; rel="first"',
      },
    })) };
    const reader = createReadOnlyReader({ github, ...repository, maxPages: 2 });
    expect(await reader.list("GET /repos/{owner}/{repo}/issues", {}, "items")).toHaveLength(200);
    expect(reader.reads[0]).toMatchObject({ complete: true, pages: 2 });
  });

  it("keeps request-limit truncation explicit even when another page exists", async () => {
    const github = { request: jest.fn(async () => ({ data: rows(100), headers: { link: nextLink } })) };
    const reader = createReadOnlyReader({ github, ...repository, maxRequests: 1 });
    await reader.list("GET /repos/{owner}/{repo}/issues");
    expect(reader.reads[0]).toMatchObject({ complete: false, count: 100, reason: "api-list-incomplete" });
    expect(github.request).toHaveBeenCalledTimes(1);
  });

  it("does not accept a changing total as a complete snapshot", async () => {
    const reader = createReadOnlyReader({
      github: { request: async (_route: string, params: { page: number }) => ({
        data: { items: rows(100, (params.page - 1) * 100), total_count: params.page === 1 ? 200 : 201 },
        headers: params.page === 1 ? { link: nextLink } : {},
      }) }, ...repository,
    });
    await reader.list("GET /repos/{owner}/{repo}/issues", {}, "items");
    expect(reader.reads[0].complete).toBe(false);
  });

  it.each([
    undefined,
    null,
    [],
    { link: null },
    { link: "" },
    { link: 123 },
    { link: "not a Link header" },
    { link: '<https://api.github.com/repos/example/krypto/issues?page=2>; title="next"' },
    { link: `${nextLink}, ${nextLink}` },
    { link: nextLink, Link: nextLink },
    { link: '<https://api.github.com/repos/example/krypto/issues?page=1>; rel="next"' },
    { link: '<https://api.github.com/repos/example/krypto/issues?page=4>; rel="next"' },
    { link: '<https://api.github.com/repos/example/krypto/issues?after=ambiguous>; rel="next"' },
  ])("keeps missing or malformed pagination metadata incomplete: %j", async (headers) => {
    const reader = createReadOnlyReader({ github: { request: async () => ({ data: rows(99), headers }) }, ...repository });
    await reader.list("GET /repos/{owner}/{repo}/issues");
    expect(reader.reads[0]).toMatchObject({ complete: false, reason: "api-list-incomplete" });
  });

  it.each([
    { total_count: 101 },
    { total_count: 99 },
    { total_count: -1 },
    { total_count: "100" },
    { total_count: null },
  ])("does not allow a missing next link to override conflicting/invalid total metadata: %j", async (metadata) => {
    const reader = createReadOnlyReader({
      github: { request: async () => ({ data: { items: rows(100), ...metadata }, headers: {} }) }, ...repository,
    });
    await reader.list("GET /repos/{owner}/{repo}/issues", {}, "items");
    expect(reader.reads[0].complete).toBe(false);
  });
});

function snapshot(extra = issue(400, { labels: ["bug"] }), comments: FixtureComment[] = [], pulls: unknown[] = []) {
  const issues = [...baseIssues(), extra];
  issues[2].labels = ["agentic-factory", "ready-for-ai-dev", "risk:routine", "priority:P1"];
  return {
    observedAt: NOW, repository, issues, pulls, reads: [],
    details: Object.fromEntries(issues.map((item) => [item.number, {
      parent: { number: 248, repository_url: "https://api.github.com/repos/example/krypto" },
      comments: item.number === 400 ? comments : [], subIssues: [], blockedBy: [],
      timeline: item.labels.map((name) => ({ event: "labeled", label: { name }, actor: { type: "User" }, created_at: NOW })),
    }])),
    capabilities: { modelVariables: [], modelAvailability: [], workflows: [] },
  };
}

const claim = {
  id: 1, created_at: NOW, updated_at: NOW, user: { type: "Bot", login: "github-actions[bot]" },
  body: '<!-- factory-claim:v1 {"nonce":"run:1:400","owner":"queue","issueNumber":400,"expiresAt":"2026-09-16T00:00:00Z"} -->',
};
const linkedPR = {
  number: 900, body: "Fixes #400",
  head: { repo: { id: 10, full_name: "example/krypto" } },
  base: { repo: { id: 10, full_name: "example/krypto" } },
};

describe("readiness accounts only for canonical factory work", () => {
  it.each(["assignee", "claim", "linked-pr", "lifecycle-label"])("ignores unrelated issue %s evidence", (evidence) => {
    const extra = issue(400, {
      labels: evidence === "lifecycle-label" ? ["factory:claimed"] : ["bug"],
      assignees: evidence === "assignee" ? [{ login: "human" }] : [],
    });
    const report = readiness.buildFactoryReadinessReport(snapshot(extra,
      evidence === "claim" || evidence === "lifecycle-label" ? [claim] : [],
      evidence === "linked-pr" ? [linkedPR] : []));
    expect(report.candidates.map((candidate: { number: number }) => candidate.number)).toEqual([300]);
    expect(report.capacity).toMatchObject({ inFlightCount: 0, ownershipSignals: [], unaccountedOwnership: [], ambiguousBudgetIssues: [] });
    expect(report.goals.items[0].budgetUsed).toBe(0);
    expect(report.authorizationReasons).not.toContain("wip-label-accounting-inconsistent");
    expect(report.candidates[0].authorized).toBe(true);
  });

  it.each(["assignee", "claim", "linked-pr"])("retains legitimate factory %s evidence", (evidence) => {
    const extra = issue(400, {
      labels: ["agentic-factory", "blocked"],
      assignees: evidence === "assignee" ? [{ login: "Copilot" }] : [],
    });
    const report = readiness.buildFactoryReadinessReport(snapshot(extra,
      evidence === "claim" ? [claim] : [], evidence === "linked-pr" ? [linkedPR] : []));
    expect(report.capacity.ownershipSignals).toContain(400);
    expect(report.capacity.unaccountedOwnership).toContain(400);
    expect(report.authorizationReasons).toContain("wip-label-accounting-inconsistent");
    expect(report.candidates.find((candidate: { number: number }) => candidate.number === 300).authorized).toBe(false);
  });

  it("retains malformed trusted factory claim evidence instead of silently dropping it", () => {
    const extra = issue(400, { labels: ["agentic-factory", "blocked"] });
    const report = readiness.buildFactoryReadinessReport(snapshot(extra, [{ ...claim, body: "<!-- factory-claim:v1 malformed -->" }]));
    expect(report.capacity.ownershipSignals).toContain(400);
    expect(report.goals.items[0].budgetUsed).toBe(1);
    expect(report.candidates.find((candidate: { number: number }) => candidate.number === 400).claimState).toMatchObject({
      present: true, blocking: true, malformed: true,
    });
  });

  it("does not attribute unrelated malformed claims to any factory goal budget", () => {
    const extra = issue(400, { labels: ["blocked"], body: "Unrelated support request.", assignees: [{ login: "human" }] });
    const report = readiness.buildFactoryReadinessReport(snapshot(extra, [{ ...claim, body: "<!-- factory-claim:v1 malformed -->" }]));
    expect(report.capacity.ambiguousBudgetIssues).toEqual([]);
    expect(report.goals.items[0].budgetUsed).toBe(0);
    expect(report.candidates[0].authorized).toBe(true);
  });

  it("counts genuine in-flight factory labels without including control/goal issue assignees", () => {
    const input = snapshot(issue(400, { labels: ["agentic-factory", "factory:claimed"], assignees: [{ login: "Copilot" }] }), [claim]);
    input.issues[0].assignees = [{ login: "operator" }];
    input.issues[1].assignees = [{ login: "operator" }];
    const report = readiness.buildFactoryReadinessReport(input);
    expect(report.capacity.inFlight).toEqual([400]);
    expect(report.capacity.ownershipSignals).toEqual([400]);
    expect(report.capacity.unaccountedOwnership).toEqual([]);
    expect(report.goals.items[0].budgetUsed).toBe(1);
  });

  it("does not enrich unrelated issue ownership, while retaining the issue inventory for dependencies", async () => {
    const input = snapshot();
    const github = { request: jest.fn(async (route: string, params: Record<string, unknown>) => {
      if (params.issue_number === 400) throw new Error("Unrelated ownership must not be requested");
      const headers = {};
      if (route === "GET /repos/{owner}/{repo}/issues") return { data: input.issues, headers };
      if (route.endsWith("/pulls")) return { data: [], headers };
      if (route.endsWith("/variables")) return { data: { variables: [], total_count: 0 }, headers };
      if (route.endsWith("/workflows")) return { data: { workflows: [], total_count: 0 }, headers };
      if (route === "GET /repos/{owner}/{repo}") return { data: { default_branch: "main" }, headers };
      if (route.endsWith("/timeline")) return { data: input.details[Number(params.issue_number)].timeline, headers };
      if (route.endsWith("/parent")) return { data: { number: 248, repository_url: "https://api.github.com/repos/example/krypto" }, headers };
      if (route.endsWith("/comments") || route.endsWith("/sub_issues") || route.endsWith("/blocked_by")) return { data: [], headers };
      return { data: {}, headers };
    }) };
    const collected = await readiness.collectReadinessSnapshot({ github, context: { repo: repository }, config: { now: NOW } });
    expect(collected.issues.map((item: { number: number }) => item.number)).toContain(400);
    expect(collected.details[400]).toBeUndefined();
    expect(github.request.mock.calls.some(([, params]) => params.issue_number === 400)).toBe(false);
    expect(readiness.buildFactoryReadinessReport(collected).completeness.complete).toBe(true);
  });
});
