"use strict";

const { jest: mocker } = require("@jest/globals");
const { createHash } = require("node:crypto");
const evidence = require("../../../.github/scripts/agentic-review-evidence.cjs");

const SHA = "a".repeat(40);
const BASE = "b".repeat(40);
const REPOSITORY = "example/project-krypto-dog";
const NOW = Date.parse("2026-09-15T01:00:00Z");
const START = "2026-09-15T00:00:00Z";
const END = "2026-09-15T00:01:00Z";
const ACTIONS = { login: "github-actions[bot]", type: "Bot", id: 41898282, node_id: "BOT_actions" };

function blob(text) {
  const buffer = Buffer.from(text);
  return {
    sha: createHash("sha1").update(`blob ${buffer.length}\0`).update(buffer).digest("hex"),
    content: buffer.toString("base64"), encoding: "base64", size: buffer.length,
  };
}

function page(items, params, key) {
  const offset = ((params.page || 1) - 1) * (params.per_page || 100);
  const batch = items.slice(offset, offset + (params.per_page || 100));
  return { data: key ? { [key]: batch, total_count: items.length } : batch,
    headers: offset + batch.length < items.length ? { link: '<next>; rel="next"' } : {} };
}

function harness(checkName = "QA verification") {
  const workflowId = evidence.REVIEW_WORKFLOWS[checkName];
  const context = {
    repo: { owner: "example", repo: "project-krypto-dog" },
    eventName: "workflow_dispatch", ref: "refs/heads/main", sha: BASE, runId: 900,
    payload: { repository: { default_branch: "main", full_name: REPOSITORY } },
  };
  const env = {
    CHECK_NAME: checkName, REVIEW_WORKFLOW_ID: workflowId,
    EXPECTED_PR_NUMBER: "7", EXPECTED_HEAD_SHA: SHA, TRUSTED_WORKFLOW_SHA: BASE,
    GITHUB_RUN_ID: "900", GITHUB_RUN_ATTEMPT: "1",
    CORRELATION_ID: evidence.correlationId(workflowId, 7, SHA),
  };
  const before = blob("export const value = 1;\n");
  const after = blob("export const value = 2;\n");
  const filename = "src/lib/example.ts";
  const pull = {
    number: 7, title: "Improve example", state: "open", draft: false,
    body: "The author says every test passed. This is not evidence.",
    labels: [], user: { login: "author", type: "User" },
    head: { sha: SHA, ref: "candidate", repo: { full_name: REPOSITORY } },
    base: { sha: BASE, ref: "main", repo: { full_name: REPOSITORY } },
    changed_files: 1, created_at: "2026-09-14T00:00:00Z",
    html_url: `https://github.com/${REPOSITORY}/pull/7`,
  };
  const ciRun = {
    id: 500, run_attempt: 1, event: "pull_request", path: ".github/workflows/ci.yml",
    head_sha: SHA, head_branch: "candidate", check_suite_id: 600,
    status: "completed", conclusion: "success",
    created_at: START, updated_at: END, repository: { full_name: REPOSITORY },
    pull_requests: [{ number: 7, head: { sha: SHA }, base: { sha: BASE } }],
  };
  const state = {
    pull,
    files: [{ filename, status: "modified", sha: after.sha, additions: 1, deletions: 1,
      patch: "@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;" }],
    contents: new Map([[`${BASE}:${filename}`, before], [`${SHA}:${filename}`, after]]),
    blobs: new Map([[before.sha, before], [after.sha, after]]),
    runs: [ciRun],
    jobs: new Map([[500, evidence.CI_CHECKS.map((name, index) => ({
      id: 501 + index, name, status: "completed", conclusion: "success", run_attempt: 1,
      started_at: START, completed_at: END,
    }))]]),
    artifacts: new Map([[500, [{ id: 700, name: "retained-test-evidence", digest: `sha256:${"c".repeat(64)}`,
      expired: false, size_in_bytes: 123, created_at: START, expires_at: "2026-09-29T00:00:00Z",
      workflow_run: { id: 500, head_sha: SHA } }]]]),
    checks: evidence.CI_CHECKS.map((name, index) => ({
      id: 501 + index, name, head_sha: SHA, app: { slug: "github-actions" },
      status: "completed", conclusion: "success", completed_at: END,
      details_url: `https://github.com/${REPOSITORY}/actions/runs/500/job/${501 + index}`,
      check_suite: { id: 600 },
    })),
    issues: new Map(),
    timeline: [],
    comments: [],
    controls: [],
    reviews: [],
    commits: [],
    nextCheckId: 10000,
  };
  for (const [name, workflow] of Object.entries(evidence.REVIEW_WORKFLOWS)) {
    const id = name === checkName ? 900 : 910 + state.runs.length;
    state.runs.push({
      id, run_attempt: 1, event: "workflow_dispatch", path: `.github/workflows/${workflow}`,
      head_sha: BASE, head_branch: "main", repository: { full_name: REPOSITORY },
      status: "completed", conclusion: "success", created_at: START, updated_at: END,
      display_title: evidence.correlationId(workflow, 7, SHA),
    });
    state.jobs.set(id, [{ id: id + 100, name: "Prepare trusted review evidence",
      status: "completed", conclusion: "success", started_at: START, completed_at: END }]);
    state.artifacts.set(id, [{ id: id + 1000, name: `review-evidence-${id}-1`,
      digest: `sha256:${"d".repeat(64)}`, expired: false,
      created_at: "2026-09-15T00:00:30Z", workflow_run: { id, head_sha: BASE } }]);
  }
  state.issues.set(7, { ...pull, pull_request: {} });
  const required = (value, message) => {
    if (value === undefined) throw new Error(`Unexpected API request: ${message}`);
    return value;
  };
  const trees = new Map();
  function buildTrees(ref) {
    const root = {};
    for (const [key, value] of state.contents) {
      if (!key.startsWith(`${ref}:`)) continue;
      const parts = key.slice(ref.length + 1).split("/");
      let directory = root;
      for (const part of parts.slice(0, -1)) directory = directory[part] ||= {};
      directory[parts.at(-1)] = value;
    }
    function addTree(directory, location) {
      const sha = createHash("sha1").update(`tree:${ref}:${location}`).digest("hex");
      const tree = Object.entries(directory).map(([name, value]) => value.sha
        ? { path: name, type: "blob", mode: value.mode || "100644", sha: value.sha }
        : { path: name, type: "tree", mode: "040000", sha: addTree(value, `${location}/${name}`) });
      trees.set(sha, { sha, tree, truncated: false });
      return sha;
    }
    return addTree(root, "");
  }
  const rest = {
    pulls: {
      get: mocker.fn(async () => ({ data: structuredClone(state.pull) })),
      list: mocker.fn(async (params) => page([state.pull], params)),
      listFiles: mocker.fn(async (params) => page(state.files, params)),
      listReviews: mocker.fn(async (params) => page(state.reviews, params)),
      listCommits: mocker.fn(async (params) => page(state.commits, params)),
    },
    checks: {
      listForRef: mocker.fn(async (params) =>
        page(state.checks.filter((check) => check.head_sha === params.ref), params, "check_runs")),
      create: mocker.fn(async (params) => {
        const check = { ...structuredClone(params), id: state.nextCheckId++, app: { slug: "github-actions" } };
        state.checks.push(check);
        return { data: check };
      }),
      update: mocker.fn(async (params) => {
        const check = required(state.checks.find((item) => item.id === params.check_run_id), "check update");
        Object.assign(check, structuredClone(params));
        return { data: check };
      }),
    },
    actions: {
      getWorkflowRun: mocker.fn(async (params) => ({
        data: structuredClone(required(state.runs.find((run) => run.id === params.run_id), `run ${params.run_id}`)),
      })),
      listWorkflowRuns: mocker.fn(async (params) =>
        page(state.runs.filter((run) => run.path === `.github/workflows/${params.workflow_id}`), params, "workflow_runs")),
      listJobsForWorkflowRunAttempt: mocker.fn(async (params) =>
        page(required(state.jobs.get(params.run_id), `jobs ${params.run_id}`), params, "jobs")),
      listJobsForWorkflowRun: mocker.fn(async (params) =>
        page(required(state.jobs.get(params.run_id), `jobs ${params.run_id}`), params, "jobs")),
      listWorkflowRunArtifacts: mocker.fn(async (params) =>
        page(required(state.artifacts.get(params.run_id), `artifacts ${params.run_id}`), params, "artifacts")),
      createWorkflowDispatch: mocker.fn(async () => ({})),
    },
    repos: {
      compareCommitsWithBasehead: mocker.fn(async () => ({ data: { merge_base_commit: { sha: BASE } } })),
      getContent: mocker.fn(async (params) => ({
        data: required(state.contents.get(`${params.ref}:${params.path}`), `contents ${params.ref}:${params.path}`),
      })),
    },
    git: {
      getCommit: mocker.fn(async (params) => ({
        data: { sha: params.commit_sha, tree: { sha: buildTrees(params.commit_sha) } },
      })),
      getTree: mocker.fn(async (params) => ({ data: required(trees.get(params.tree_sha), "Git tree") })),
      getBlob: mocker.fn(async (params) => ({
        data: required(state.blobs.get(params.file_sha), `blob ${params.file_sha}`),
      })),
    },
    issues: {
      get: mocker.fn(async (params) => ({
        data: required(state.issues.get(params.issue_number), `issue ${params.issue_number}`),
      })),
      listEventsForTimeline: mocker.fn(async (params) => page(state.timeline, params)),
      listComments: mocker.fn(async (params) => page(state.comments, params)),
      listForRepo: mocker.fn(async (params) => page(state.controls, params)),
      addLabels: mocker.fn(async () => ({})),
      removeLabel: mocker.fn(async () => ({})),
      createComment: mocker.fn(async () => ({})),
    },
  };
  const github = {
    rest,
    request: mocker.fn(async () => ({ data: { number: 10 } })),
    paginate: mocker.fn(async (method, params) => {
      const response = await method({ ...params, per_page: 100, page: 1 });
      if (Array.isArray(response.data)) return response.data;
      throw new Error("Unexpected generic pagination");
    }),
  };
  const core = {
    warning: mocker.fn(), info: mocker.fn(), setOutput: mocker.fn(),
    summary: { addRaw: mocker.fn().mockReturnThis(), write: mocker.fn() },
  };
  function addReview(name = "Agentic code review", verdict = "pass", overrides = {}) {
    const { proofOverrides = {}, ...checkOverrides } = overrides;
    const run = state.runs.find((item) => item.path === `.github/workflows/${evidence.REVIEW_WORKFLOWS[name]}`);
    const proof = {
      packetDigest: "e".repeat(64), checkName: name, headSha: SHA, pullNumber: 7,
      workflowSha: BASE, runId: run.id, runAttempt: 1,
      ciFingerprint: name === "Agentic code review" ? null : evidence.ciFingerprint(state.checks, SHA),
      verdict,
      ...proofOverrides,
    };
    const check = {
      id: state.nextCheckId++, name, head_sha: SHA, app: { slug: "github-actions" },
      status: "completed", conclusion: verdict === "pass" ? "success" : "failure",
      external_id: `agentic-review:v1:${proof.packetDigest}`,
      output: { title: name, summary: `<!-- ${evidence.REVIEW_MARKER} ${JSON.stringify(proof)} -->\nreview` },
      ...checkOverrides,
    };
    state.checks.push(check);
    return check;
  }
  function factoryScope() {
    state.pull.title = "[ai-dev] Implement approved issue";
    state.pull.body = "<!-- factory-claim:42:1:20 -->\nRefs #20";
    state.issues.set(20, {
      number: 20, state: "open", labels: [{ name: "risk:sensitive" }],
      body: "### Approved parent goal\n\n#10\n\n### Allowed paths\n\nsrc/lib/**\n\n### Acceptance criteria\n\nThe value is two.",
      updated_at: START,
    });
    state.issues.set(10, {
      number: 10, state: "open", labels: [{ name: "factory:goal" }, { name: "factory:goal-approved" }],
      body: "### Allowed paths\n\nsrc/**\n\n### Maximum autonomous risk tier\n\nrisk:sensitive",
      updated_at: START,
    });
    state.timeline.push({ id: 30, event: "labeled", label: { name: "factory:goal-approved" },
      actor: { login: "owner", type: "User" }, created_at: START });
    state.comments.push({ id: 40, created_at: START, user: ACTIONS,
      body: `<!-- factory-claim:v1 ${JSON.stringify({
        nonce: "42:1:20", owner: "queue-controller:42:1", issueNumber: 20,
        expiresAt: "2026-09-15T01:00:00Z",
      })} -->` });
  }
  return { github, context, env, core, state, addReview, factoryScope };
}

function verdict(packet, value = "pass", overrides = {}) {
  return {
    schema_version: "1", pull_request_number: String(packet.number), head_sha: packet.headSha,
    packet_digest: packet.packetDigest, verdict: value,
    reason: value === "infrastructure" ? "provider_unavailable" : "none",
    title: "Exact-head result", summary: "Source-addressed review of the supplied immutable packet.",
    ...overrides,
  };
}

module.exports = { harness, verdict, page, blob, evidence, SHA, BASE, REPOSITORY, NOW, START, END };
