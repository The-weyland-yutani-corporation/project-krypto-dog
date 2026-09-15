export const NOW = "2026-09-15T06:00:00.000Z";
export const MILESTONE = { number: 1, title: "v2.1 Safety and Correctness" };

export interface FixtureIssue {
  id: number;
  number: number;
  title: string;
  body: string;
  labels: string[];
  milestone: typeof MILESTONE | null;
  state: string;
  assignees: { login: string }[];
  created_at: string;
  updated_at: string;
}

export function form(fields: Record<string, string>) {
  return Object.entries(fields).map(([heading, content]) => `### ${heading}\n\n${content}`).join("\n\n");
}

export function goalBody(overrides: Record<string, string> = {}) {
  return form({
    Objective: "Improve authorized correctness tests.",
    "Measurable success condition": "One substantive verified development improvement per week when authorized work exists.",
    "Allowed scope": "Tests of existing behavior.",
    "Allowed paths": "tests/unit/**",
    "Explicit non-goals": "No production, live, secrets, accounts or architectural acceptance.",
    "Maximum autonomous risk tier": "risk:sensitive",
    "Maximum active coding-agent sessions": "1",
    "Assignment budget": "12",
    "Required evidence": "Targeted regressions and exact-head CI.",
    "Pause and stop conditions": "Unknown state or exhausted budget.",
    "Human-only boundaries": "- [x] Production deployment remains human-approved.\n- [x] Live-trading enablement remains human-approved.\n- [x] Automation may pause itself but may not unpause itself.",
    ...overrides,
  });
}

export function workBody(overrides: Record<string, string> = {}) {
  return form({
    "Work type": "implementation",
    "Approved parent goal": "#248",
    "Problem or goal": "A deterministic boundary lacks a regression.",
    "Scope and non-goals": "Add a focused regression; no behavior change.",
    "Allowed paths": "tests/unit/example.test.ts",
    "Risk tier": "risk:routine",
    Priority: "priority:P1",
    Dependencies: "None",
    "Acceptance criteria": "The regression fails on the original defect and passes on the repair.",
    "Validation plan": "npm test -- --runInBand tests/unit/example.test.ts",
    "Rollback or safe reversal": "Revert only the test change.",
    "Context, links, or constraints": "Hypothesis: stronger regression detection. Baseline: missing edge. Oracle: exact failing assertion.",
    ...overrides,
  });
}

export function issue(number: number, overrides: Partial<FixtureIssue> = {}): FixtureIssue {
  return {
    number, id: number * 100, title: `Work ${number}`, body: workBody(),
    labels: ["agentic-factory", "needs-triage", "risk:routine", "priority:P1"],
    milestone: MILESTONE, state: "open", assignees: [], created_at: NOW, updated_at: NOW, ...overrides,
  };
}

export function baseIssues() {
  return [
    issue(233, { labels: ["factory-control", "factory-mode:active"], body: "Control" }),
    issue(248, { labels: ["agentic-factory", "factory:goal", "factory:goal-approved"], body: goalBody() }),
    issue(300),
  ];
}

type Params = Record<string, unknown>;
export interface FixtureComment {
  id: number; body: string; created_at: string; user: { login: string; type: string };
}

export function harness(options: {
  issues?: FixtureIssue[];
  parents?: Record<number, number | null>;
  comments?: Record<number, FixtureComment[]>;
  pulls?: { number: number; body: string }[];
  failWrite?: boolean;
  failDispatch?: boolean;
  beforeLabels?: (item: FixtureIssue) => void;
} = {}) {
  const issues = new Map((options.issues || baseIssues()).map((item) => [item.number, structuredClone(item)]));
  const parents = new Map<number, number | null>([[300, 248]]);
  for (const [number, parent] of Object.entries(options.parents || {})) parents.set(Number(number), parent);
  const comments = new Map<number, FixtureComment[]>(Object.entries(options.comments || {}).map(([number, values]) => [Number(number), values]));
  const requireIssue = (number: number) => {
    const found = issues.get(number);
    if (!found) throw Object.assign(new Error("Not found"), { status: 404 });
    return found;
  };
  const writeAllowed = () => {
    if (options.failWrite) throw Object.assign(new Error("Missing issues write permission"), { status: 403 });
  };
  const listForRepo = jest.fn(async (params: Params) => [...issues.values()].filter((item) =>
    (params.state === "all" || item.state === (params.state || "open")) &&
    String(params.labels || "").split(",").filter(Boolean).every((label) => item.labels.includes(label)),
  ).map((item) => structuredClone(item)));
  const get = jest.fn(async (params: Params) => ({ data: structuredClone(requireIssue(Number(params.issue_number))) }));
  const listComments = jest.fn(async (params: Params) => comments.get(Number(params.issue_number)) || []);
  const listEventsForTimeline = jest.fn(async (params: Params) => requireIssue(Number(params.issue_number)).labels.map((name) => ({
    event: "labeled", label: { name }, actor: { type: "User", login: "operator" }, created_at: NOW,
  })));
  const addLabels = jest.fn(async (params: Params) => {
    writeAllowed();
    const item = requireIssue(Number(params.issue_number));
    options.beforeLabels?.(item);
    item.labels = [...new Set(item.labels.concat(Array.isArray(params.labels) ? params.labels : []))];
    return { data: item.labels };
  });
  const removeLabel = jest.fn(async (params: Params) => {
    writeAllowed();
    const item = requireIssue(Number(params.issue_number));
    item.labels = item.labels.filter((name) => name !== params.name);
    return { data: item.labels };
  });
  const createComment = jest.fn(async (params: Params) => {
    writeAllowed();
    const number = Number(params.issue_number);
    const entries = comments.get(number) || [];
    const comment = { id: entries.length + 1, body: String(params.body), created_at: NOW, user: { type: "Bot", login: "github-actions[bot]" } };
    entries.push(comment);
    comments.set(number, entries);
    return { data: comment };
  });
  const create = jest.fn(async (params: Params) => {
    writeAllowed();
    const number = Math.max(...issues.keys()) + 1;
    const item = issue(number, {
      title: String(params.title), body: String(params.body),
      labels: Array.isArray(params.labels) ? params.labels : [],
      milestone: params.milestone === MILESTONE.number ? MILESTONE : null,
    });
    issues.set(number, item);
    return { data: structuredClone(item) };
  });
  const request = jest.fn(async (route: string, params: Params) => {
    const number = Number(params.issue_number);
    if (route.endsWith("/parent")) {
      const parent = parents.get(number);
      if (!parent) throw Object.assign(new Error("No native parent"), { status: 404 });
      return { data: { number: parent } };
    }
    if (route.startsWith("POST ") && route.endsWith("/sub_issues")) {
      writeAllowed();
      const child = [...issues.values()].find((item) => item.id === params.sub_issue_id);
      if (!child || parents.get(child.number)) throw new Error("Refuse missing child or reparenting");
      parents.set(child.number, number);
      return { data: structuredClone(child) };
    }
    if (route.endsWith("/sub_issues")) return { data: [] };
    if (route.endsWith("/dependencies/blocked_by")) return { data: [] };
    throw new Error(`Unmocked route ${route}`);
  });
  const createWorkflowDispatch = jest.fn(async () => {
    if (options.failDispatch) throw Object.assign(new Error("Dispatch unavailable"), { status: 403 });
    return {};
  });
  const summary = { addRaw: jest.fn().mockReturnThis(), write: jest.fn(async () => undefined) };
  const core = { warning: jest.fn(), info: jest.fn(), setFailed: jest.fn(), summary };
  const github = {
    request,
    paginate: jest.fn(async (method: (params: Params) => Promise<unknown>, params: Params) => method(params)),
    rest: {
      issues: { listForRepo, get, listComments, listEventsForTimeline, addLabels, removeLabel, createComment, create, update: jest.fn() },
      pulls: { list: jest.fn(async () => options.pulls || []) },
      search: { issuesAndPullRequests: jest.fn(async () => ({ data: { items: [], total_count: 0, incomplete_results: false } })) },
      actions: { createWorkflowDispatch },
      repos: { get: jest.fn(async () => ({ data: { default_branch: "main" } })) },
    },
  };
  const context = (number = 300) => ({ repo: { owner: "example", repo: "krypto" }, payload: { inputs: { issue: String(number) } } });
  return { github, core, issues, parents, comments, context, requireIssue };
}
