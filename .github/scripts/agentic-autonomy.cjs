"use strict";

const { AGENTIC_POLICY } = require("./agentic-policy.cjs");

const AUTONOMOUS_GOAL_LABEL = "factory:autonomous-goal";
const GOAL_MARKER = "<!-- factory-autonomous-goal:v1 -->";

function renderAutonomousGoal(config = AGENTIC_POLICY.autonomy) {
  const fields = [
    ["Objective", config.objective],
    ["Measurable success condition", "Deliver evidence-backed improvements through current-head automated checks and merge to main; record exact-SHA deployment evidence separately."],
    ["Allowed scope", "Select, triage, plan, implement, review, and repair bounded repository changes without per-change human approval."],
    ["Allowed paths", config.allowedPaths.join("\n")],
    ["Explicit non-goals", "No real-money order execution, fund transfers, secret disclosure, permission bypass, weakened application safety, or unverified success claims."],
    ["Maximum autonomous risk tier", config.maxRiskTier],
    ["Maximum active coding-agent sessions", String(config.maxActiveAssignments)],
    ["Assignment budget", String(config.maxAssignmentsPerDay)],
    ["Required evidence", "Passing current-head quality, migrations, code review, and risk-selected QA/security/trading-safety checks. Scope, assignment, and PR provenance must agree."],
    ["Pause and stop conditions", "Honor the emergency factory control. Isolate failed items, cap retries and daily assignments, and stop on ambiguous provenance or duplicate work."],
    ["Execution boundaries", "- [x] Required automated verification stays enabled.\n- [x] Real-money execution remains disabled.\n- [x] The emergency pause is never cleared by a scheduled loop."],
  ];
  return `${GOAL_MARKER}\n\n${fields.map(([heading, value]) => `### ${heading}\n\n${value}`).join("\n\n")}`;
}

function isAutonomousGoal(issue, config = AGENTIC_POLICY.autonomy) {
  return Boolean(
    config.enabled && issue && !issue.pull_request &&
    issue.state === "open" &&
    issue.user?.type === "Bot" && issue.user.login === "github-actions[bot]" &&
    (issue.labels || []).some((label) => (typeof label === "string" ? label : label.name) === AUTONOMOUS_GOAL_LABEL) &&
    issue.title === config.goalTitle &&
    issue.body?.replace(/\r\n/g, "\n").trim() === renderAutonomousGoal(config) &&
    issue.milestone?.title === config.milestone,
  );
}

// Called only by the globally serialized queue workflow, after its mode gate.
// Existing records are never rewritten or adopted by title after partial writes.
async function ensureAutonomousGoal({ github, owner, repo }) {
  const config = AGENTIC_POLICY.autonomy;
  if (!config.enabled) return;
  const existing = (await github.paginate(github.rest.issues.listForRepo, {
    owner, repo, state: "all", labels: AUTONOMOUS_GOAL_LABEL, per_page: 100,
  })).filter((issue) => !issue.pull_request);
  if (existing.length > 0) {
    if (existing.length !== 1 || !isAutonomousGoal(existing[0])) {
      throw new Error("Autonomous goal is closed, duplicated, or differs from repository policy; refusing to replace it.");
    }
    return existing[0];
  }
  const milestones = await github.paginate(github.rest.issues.listMilestones, {
    owner, repo, state: "all", per_page: 100,
  });
  const matching = milestones.filter((milestone) => milestone.title === config.milestone);
  if (matching.length > 1 || matching.some((milestone) => milestone.state !== "open")) {
    throw new Error("Autonomous milestone is ambiguous or closed.");
  }
  const milestone = matching[0] || (await github.rest.issues.createMilestone({
    owner, repo, title: config.milestone,
  })).data;
  try {
    await github.rest.issues.getLabel({ owner, repo, name: AUTONOMOUS_GOAL_LABEL });
  } catch (error) {
    if (error.status !== 404) throw error;
    await github.rest.issues.createLabel({
      owner, repo, name: AUTONOMOUS_GOAL_LABEL, color: "0e8a16",
      description: "Standing delivery mission bound to repository policy",
    });
  }
  const { data: goal } = await github.rest.issues.create({
    owner, repo, title: config.goalTitle, body: renderAutonomousGoal(config),
    milestone: milestone.number,
    labels: ["agentic-factory", "factory:goal", "factory:goal-approved", AUTONOMOUS_GOAL_LABEL],
  });
  if (!isAutonomousGoal(goal)) {
    throw new Error("Created autonomous goal could not be verified; no further dispatch is authorized.");
  }
  return goal;
}

module.exports = { AUTONOMOUS_GOAL_LABEL, GOAL_MARKER, renderAutonomousGoal, isAutonomousGoal, ensureAutonomousGoal };
