"use strict";

const { AGENTIC_POLICY } = require("./agentic-policy.cjs");

const STAGES = Object.freeze([
  { label: "needs-rubber-duck", workflow: "rubber-duck-architecture.lock.yml", input: "target" },
  { label: "needs-triage", workflow: "pm-triage.lock.yml", input: "issue" },
  { label: "ready-for-planning", workflow: "em-planning.lock.yml", input: "scope" },
]);
const IN_FLIGHT = new Set(["factory:claimed", "factory:implementing", "factory:pr-open", "factory:repairing"]);

function names(issue) {
  return new Set((issue.labels || []).map((label) => typeof label === "string" ? label : label.name));
}

function dispatchDecision(runs, correlation, maxAttempts = 2) {
  if (!Array.isArray(runs)) throw new Error("Workflow run history is unavailable.");
  if (runs.some((run) => run.status !== "completed")) return "running";
  const matching = runs.filter((run) => run.display_title === correlation);
  if (matching.some((run) => run.conclusion === "success")) return "completed";
  return matching.length >= maxAttempts ? "attempts-exhausted" : "dispatch";
}

// Invoked in the queue's global concurrency group. Explicit dispatch repairs
// handoffs suppressed by GitHub's GITHUB_TOKEN event-recursion protection.
async function runFactoryIntake({ github, context, core, queueResult, now = new Date().toISOString() }) {
  if (!AGENTIC_POLICY.autonomy.enabled || queueResult.mode !== "active" ||
      queueResult.autoPaused || queueResult.blocked || !queueResult.activeGoal ||
      queueResult.dispatched || !(queueResult.budgetRemaining > 0)) return;
  if (!Number.isFinite(Date.parse(now))) throw new Error("Intake requires a valid clock.");
  const { owner, repo } = context.repo;
  const defaultBranch = context.payload?.repository?.default_branch;
  if (!defaultBranch) throw new Error("Intake requires the repository default branch.");
  const goal = queueResult.activeGoal;
  const issues = (await github.paginate(github.rest.issues.listForRepo, {
    owner, repo, state: "open", labels: "agentic-factory", per_page: 100,
  })).filter((issue) => !issue.pull_request);
  if (issues.filter((issue) => [...names(issue)].some((label) => IN_FLIGHT.has(label))).length >= goal.concurrencyLimit) {
    core.info("Intake waiting: active implementation WIP is full.");
    return;
  }

  const day = new Date(now).toISOString().slice(0, 10);
  const ownedIssues = (await github.paginate(
    "GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues",
    { owner, repo, issue_number: goal.number, per_page: 100 },
  )).filter((issue) => issue.state === "open" && !issue.pull_request);
  const cache = new Map();
  const runsFor = async (workflow) => {
    if (!cache.has(workflow)) {
      const today = await github.paginate(github.rest.actions.listWorkflowRuns, {
        owner, repo, workflow_id: workflow, per_page: 100,
        created: `>=${day}`,
      });
      const outstanding = [];
      for (const status of ["queued", "in_progress", "waiting", "pending", "requested"]) {
        outstanding.push(...await github.paginate(github.rest.actions.listWorkflowRuns, {
          owner, repo, workflow_id: workflow, per_page: 100, status,
        }));
      }
      cache.set(workflow, [...today, ...outstanding]);
    }
    return cache.get(workflow);
  };
  const candidates = ownedIssues.filter((issue) => {
    const labels = names(issue);
    return !labels.has("blocked") && !labels.has("factory:goal") &&
      STAGES.some((stage) => labels.has(stage.label));
  }).sort((left, right) => left.number - right.number);

  for (const issue of candidates) {
    const stages = STAGES.filter((stage) => names(issue).has(stage.label));
    if (stages.length !== 1) {
      core.warning(`Issue #${issue.number} has ambiguous intake state; it was not dispatched.`);
      continue;
    }
    const stage = stages[0];
    const correlation = `factory-intake:${day}:${issue.number}:${stage.workflow}`;
    const reason = dispatchDecision(await runsFor(stage.workflow), correlation);
    if (reason !== "dispatch") {
      core.info(`Issue #${issue.number}: ${stage.workflow} ${reason}.`);
      continue;
    }
    await github.rest.actions.createWorkflowDispatch({
      owner, repo, workflow_id: stage.workflow, ref: defaultBranch,
      inputs: {
        [stage.input]: String(issue.number),
        correlation_id: correlation,
        aw_context: JSON.stringify({ item_type: "issue", item_number: issue.number }),
      },
    });
    core.info(`Dispatched ${stage.workflow} for issue #${issue.number}.`);
    return;
  }

  // Discovery has a separate one-attempt/day cap; dispatch uncertainty is never retried here.
  if (ownedIssues.some((issue) => names(issue).has("ready-for-ai-dev"))) return;
  const workflow = "opportunity-discovery.lock.yml";
  const correlation = `factory-intake:${day}:discovery`;
  const reason = dispatchDecision(await runsFor(workflow), correlation, 1);
  if (reason !== "dispatch") {
    core.info(`Opportunity discovery: ${reason}.`);
    return;
  }
  await github.rest.actions.createWorkflowDispatch({
    owner, repo, workflow_id: workflow, ref: defaultBranch,
    inputs: { correlation_id: correlation, focus: `Standing repository mission #${goal.number}` },
  });
  core.info(`Dispatched daily opportunity discovery for mission #${goal.number}.`);
}

module.exports = { STAGES, dispatchDecision, runFactoryIntake };
