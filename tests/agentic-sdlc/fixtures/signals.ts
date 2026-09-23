export const NOW = "2026-09-15T07:05:00.000Z";
export const SHA = "a".repeat(40);
export const REPOSITORY = "example/krypto";
export const RUN_REF = `https://github.com/${REPOSITORY}/actions/runs/310`;
export const ORACLE_REF = `https://github.com/${REPOSITORY}/blob/${SHA}/tests/trading/policy.test.ts`;

export type Issue = {
  number: number;
  id: number;
  title: string;
  state: string;
  body: string;
  labels: string[];
  milestone: { number: number; title: string } | null;
  created_at: string;
  updated_at: string;
  user: { login: string; type: string };
  repository_url: string;
};
type Event = { event: string; label: { name: string }; actor: { type: string }; created_at: string };
type Comment = { id: number; body: string; user: { login: string }; created_at: string; updated_at: string };
type Params = Record<string, unknown>;

export const goalBody = [
  ["Objective", "Finish the bounded safety tests for #16."],
  ["Measurable success condition", "The scoped regression no longer fails."],
  ["Allowed scope", "Only narrowly necessary implementation and tests for #16."],
  ["Allowed paths", "src/trading/**\ntests/**"],
  ["Explicit non-goals", "No new maintenance scope, strategy, live or production changes."],
  ["Maximum autonomous risk tier", "risk:sensitive"],
  ["Maximum active coding-agent sessions", "1"],
  ["Assignment budget", "12"],
  ["Required evidence", "Current-head checks and genuine exact-SHA dev evidence."],
  ["Pause and stop conditions", "Stop on blocked work, exhausted budget, or scope escape."],
  ["Human-only boundaries", "- [x] Production remains human-only.\n- [x] Live remains human-only.\n- [x] Automation may not unpause itself."],
].map(([heading, body]) => `### ${heading}\n\n${body}`).join("\n\n");

export function issue(number: number, labels: string[], body = ""): Issue {
  return {
    number, id: number + 1000, labels, body, title: `Work ${number}`, state: "open",
    milestone: { number: 7, title: "v2.1 Safety and Correctness" },
    created_at: "2026-09-01T00:00:00Z", updated_at: NOW,
    user: { login: "operator", type: "User" },
    repository_url: `https://api.github.com/repos/${REPOSITORY}`,
  };
}

export function makeGithub() {
  const issues = [
    issue(233, ["factory-control", "factory-mode:active"]),
    issue(248, ["agentic-factory", "factory:goal", "factory:goal-approved"], goalBody),
    issue(16, ["agentic-factory"]),
  ];
  const parents = new Map([[16, 248]]);
  const events = new Map<number, Event[]>([
    [233, [{ event: "labeled", label: { name: "factory-mode:active" }, actor: { type: "User" }, created_at: NOW }]],
    [248, [{ event: "labeled", label: { name: "factory:goal-approved" }, actor: { type: "User" }, created_at: NOW }]],
  ]);
  const comments = new Map<number, Comment[]>();
  const pulls: Record<string, unknown>[] = [];
  const failedRun = {
    id: 310, head_sha: SHA, head_branch: "main", status: "completed", conclusion: "failure",
    path: ".github/workflows/ci.yml", created_at: "2026-09-15T06:00:00Z",
    repository: { full_name: REPOSITORY },
  };
  const evalRuns = [{
    id: 311, head_sha: SHA, head_branch: "main", status: "completed", conclusion: "success",
    path: ".github/workflows/agentic-evals.yml", updated_at: NOW, created_at: NOW,
  }];
  const failures = new Map<string, number>();
  const request = jest.fn(async (route: string, params: Params = {}): Promise<{ data: unknown }> => {
    if (failures.has(route)) throw Object.assign(new Error("fixture API failure"), { status: failures.get(route) });
    const number = Number(params.issue_number);
    const page = Number(params.page || 1);
    const pageRows = (rows: unknown[]) => ({ data: rows.slice((page - 1) * 100, page * 100) });
    switch (route) {
      case "GET /repos/{owner}/{repo}/issues": {
        const required = String(params.labels || "").split(",").filter(Boolean);
        return pageRows(issues.filter((item) => (params.state === "all" || item.state === "open") &&
          required.every((label) => item.labels.includes(label))));
      }
      case "GET /repos/{owner}/{repo}/issues/{issue_number}/timeline":
        return pageRows(events.get(number) || []);
      case "GET /repos/{owner}/{repo}/issues/{issue_number}/comments":
        return pageRows(comments.get(number) || []);
      case "GET /repos/{owner}/{repo}":
        return { data: { default_branch: "main" } };
      case "GET /repos/{owner}/{repo}/branches/{branch}":
        return { data: { commit: { sha: SHA } } };
      case "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs":
        return { data: { workflow_runs: params.workflow_id === "ci.yml" ? [failedRun] : evalRuns,
          total_count: params.workflow_id === "ci.yml" ? 1 : evalRuns.length } };
      case "GET /repos/{owner}/{repo}/actions/runs/{run_id}":
        return { data: failedRun };
      case "GET /repos/{owner}/{repo}/contents/{path}":
        return { data: { type: "file" } };
      case "GET /repos/{owner}/{repo}/issues/{issue_number}/parent":
        if (!parents.has(number)) throw Object.assign(new Error("no parent"), { status: 404 });
        return { data: { number: parents.get(number), repository_url: `https://api.github.com/repos/${REPOSITORY}` } };
      case "GET /repos/{owner}/{repo}/issues/{issue_number}": {
        const result = issues.find((item) => item.number === number);
        if (!result) throw Object.assign(new Error("issue not found"), { status: 404 });
        return { data: result };
      }
      case "POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues": {
        const child = issues.find((item) => item.id === Number(params.sub_issue_id));
        if (!child) throw new Error("unknown sub-issue");
        parents.set(child.number, number);
        return { data: child };
      }
      case "GET /repos/{owner}/{repo}/pulls":
        return pageRows(pulls);
      default:
        throw new Error(`unexpected fixture request: ${route}`);
    }
  });
  const create = jest.fn(async (params: Params) => {
    const created = issue(500 + issues.length, params.labels as string[], String(params.body));
    created.title = String(params.title);
    created.created_at = NOW;
    created.user = { type: "Bot", login: "github-actions[bot]" };
    issues.push(created);
    return { data: created };
  });
  const createComment = jest.fn(async (params: Params) => {
    const number = Number(params.issue_number);
    const current = comments.get(number) || [];
    current.push({ id: current.length + 1, body: String(params.body), user: { login: "github-actions[bot]" }, created_at: NOW, updated_at: NOW });
    comments.set(number, current);
    return { data: current[current.length - 1] };
  });
  const get = jest.fn(async (params: Params) => ({ data: issues.find((item) => item.number === Number(params.issue_number)) }));
  const update = jest.fn(async (params: Params) => {
    const target = issues.find((item) => item.number === Number(params.issue_number));
    if (!target) throw new Error("unknown issue");
    if (typeof params.body === "string") target.body = params.body;
    return { data: target };
  });
  const dispatch = jest.fn(async (_params: Params) => ({ status: 204 }));
  return {
    github: { request, rest: { issues: { create, createComment, get, update }, actions: { createWorkflowDispatch: dispatch } } },
    issues, parents, events, comments, pulls, failedRun, evalRuns, failures,
  };
}

export function signalPayload(fingerprintFor: (source: Record<string, string>) => string) {
  const source = {
    kind: "workflow-run", key: ".github/workflows/ci.yml:failure", ref: RUN_REF, sha: SHA,
    windowStart: "2026-09-14T07:00:00Z", windowEnd: "2026-09-15T07:00:00Z",
  };
  return {
    signal: {
      schemaVersion: 1, fingerprint: fingerprintFor(source), source, observedAt: NOW,
      severity: "warning", evidenceRefs: [RUN_REF], completeness: "complete",
      summary: "The scoped safety regression failed.",
    },
    proposal: {
      goalNumber: 248, scopeIssueNumber: 16, title: "Repair the scoped safety regression",
      riskTier: "risk:sensitive", allowedPaths: ["tests/trading/policy.test.ts"], dependencyNumbers: [] as number[],
      hypothesis: "Fixing the scoped test defect restores the independently checked safety invariant.",
      baseline: { metric: "failing-workflow-runs", value: 1, unit: "runs", evidenceRef: RUN_REF },
      oracle: { metric: "failing-workflow-runs", value: 0, unit: "runs", evidenceRef: ORACLE_REF },
      rollback: "Revert the scoped test commit if the independent invariant regresses.",
      expectedOutcome: "The invariant holds in a real post-merge run; no trading-edge claim.",
      scope: "Only the test work for issue 16.", nonGoals: "No strategy, trading authority, deployment or policy changes.",
      acceptanceCriteria: "The independently specified safety regression passes without weakening the invariant.",
      validationPlan: "npm test -- --runInBand tests/trading/policy.test.ts",
    },
  };
}
