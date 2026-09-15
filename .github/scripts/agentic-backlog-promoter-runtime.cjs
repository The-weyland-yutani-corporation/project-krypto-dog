// @ts-check
"use strict";

/**
 * GitHub I/O runtime for factory backlog promotion.
 *
 * Reads the factory control mode and the single approved goal, evaluates every
 * open `agentic-factory` backlog issue with the pure core
 * (`agentic-backlog-promoter.cjs`), and — only in `factory-mode:active` —
 * applies `ready-for-ai-dev` (plus the human-declared risk label and the goal's
 * milestone) so the existing queue controller can select the issue.
 *
 * This workflow never executes issue-authored code. Issue and comment content
 * is treated strictly as untrusted data: it is parsed for structured fields and
 * never interpreted as instructions.
 *
 * Fail-closed behavior mirrors the queue controller:
 * - a missing/ambiguous control mode resolves to `paused`;
 * - `factory-mode:active` must have been most recently applied by a human;
 * - `factory:goal-approved` must have been most recently applied by a human;
 * - any API read failure degrades the affected candidate to "not promotable".
 */

const {
  CONTROL_LABEL,
  GOAL_LABEL,
  GOAL_APPROVED_LABEL,
  FACTORY_LABEL,
  extractIssueFormSections,
  getIssueFormSection,
  normalizeLabels,
  isHumanActorType,
  findLatestLabelApplicationEvent,
  determineFactoryMode,
  resolveActiveGoal,
  countInFlight,
  countBudgetConsumption,
} = require("./agentic-queue-runtime.cjs");

const { planPromotions } = require("./agentic-backlog-promoter.cjs");
const queueRuntime = require("./agentic-queue-runtime.cjs");
const { readIntakeCandidate, loadIntakeAuthority, applySelectiveLabels } = require("./agentic-intake-runtime.cjs");
const { diagnoseGoalIssue } = require("./agentic-factory-readiness.cjs");

const RISK_HEADING = "Risk tier";
const ACTIVE_MODE_LABEL = "factory-mode:active";

/** Default ceiling on promotions per pass; overridable via workflow input. */
const DEFAULT_MAX_PROMOTIONS = 5;

function describeError(error) {
  if (error && typeof error === "object" && "message" in error) {
    return String(error.message);
  }
  return String(error);
}

async function listIssuesWithLabels(github, owner, repo, labels, state) {
  const issues = await github.paginate(github.rest.issues.listForRepo, {
    owner,
    repo,
    state,
    labels: labels.join(","),
    per_page: 100,
  });
  // The issues API also returns pull requests carrying the requested labels.
  return issues.filter((issue) => !issue.pull_request);
}

/**
 * Resolves the actor type behind the most recent application of a label.
 * Fails closed to `null` when the timeline cannot be read.
 */
async function resolveLatestLabelApplicationActorType({ github, owner, repo, issueNumber, labelName, core }) {
  let events;
  try {
    events = await github.paginate(github.rest.issues.listEventsForTimeline, {
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 100,
    });
  } catch (error) {
    core.warning(
      `Failed to read the timeline for issue #${issueNumber} while verifying "${labelName}" was human-applied: ${describeError(
        error,
      )} (fail closed).`,
    );
    return null;
  }

  const latest = findLatestLabelApplicationEvent(events, labelName);
  if (!latest) {
    core.warning(
      `No "labeled" timeline event found for "${labelName}" on issue #${issueNumber} (fail closed).`,
    );
    return null;
  }
  return latest.actor && typeof latest.actor.type === "string" ? latest.actor.type : null;
}

/** Every open sub-issue makes the candidate a non-leaf. Fails closed. */
async function resolveIsLeaf({ github, owner, repo, issueNumber, core }) {
  return queueRuntime.resolveIsLeaf({ github, owner, repo, issueNumber, core });
}

/**
 * Resolves the candidate's native GitHub sub-issue parent. The issue-form
 * "Approved parent goal" text alone is only a claim; the native relationship
 * is what corroborates it.
 */
async function resolveNativeParentGoalNumber({ github, owner, repo, issueNumber, core }) {
  return queueRuntime.resolveNativeParentGoalNumber({ github, owner, repo, issueNumber, core });
}

async function resolveDependencyStates({ github, owner, repo, dependencyNumbers, core }) {
  return queueRuntime.resolveDependencyStates({ github, owner, repo, dependencyNumbers, core });
}

/**
 * Builds the promoter's view of one backlog issue.
 */
async function buildCandidate({ github, owner, repo, issue, activeGoalNumber, core }) {
  const parsed = await readIntakeCandidate({ github, context: { repo: { owner, repo } }, core, issue, activeGoalNumber });
  const sections = extractIssueFormSections(issue.body);
  const declaredRiskTier = getIssueFormSection(sections, RISK_HEADING);
  const bodyParentGoalNumber = parsed.parentGoalNumber;
  const parentGoalNumber =
    Number.isInteger(bodyParentGoalNumber) && parsed.nativeParentGoalNumber === bodyParentGoalNumber
      ? bodyParentGoalNumber
      : undefined;
  return {
    ...parsed,
    number: issue.number,
    title: typeof issue.title === "string" ? issue.title : "",
    parentGoalNumber,
    bodyParentGoalNumber,
    declaredRiskTier,
    issue,
  };
}

/**
 * Applies the promotion plan for one issue: milestone binding, the declared
 * risk label, and `ready-for-ai-dev`.
 */
async function applyPromotion({ github, owner, repo, promotion, goalMilestoneNumber, core, candidate, expectedConfig }) {
  const issueNumber = promotion.number;
  try {
    const authority = await loadIntakeAuthority({ github, context: { repo: { owner, repo } }, core, now: expectedConfig.now });
    if (!authority.ok || authority.mode !== "active" ||
      authority.config.goalNumber !== expectedConfig.goalNumber) return { ok: false, reason: "authorization-changed" };
    const fresh = await github.rest.issues.get({ owner, repo, issue_number: issueNumber });
    if (fresh.data.updated_at !== candidate.issue.updated_at || fresh.data.body !== candidate.issue.body ||
      JSON.stringify(fresh.data.labels) !== JSON.stringify(candidate.issue.labels)) return { ok: false, reason: "concurrent-issue-change" };
    const refreshed = await buildCandidate({ github, owner, repo, issue: fresh.data, activeGoalNumber: authority.config.goalNumber, core });
    const { evaluatePromotion } = require("./agentic-backlog-promoter.cjs");
    const verifiedPlan = evaluatePromotion(refreshed, authority.config);
    if (!verifiedPlan.promotable) return { ok: false, reason: verifiedPlan.reasons.join(",") };
    // GitHub issue PATCH has no documented CAS. Do not overwrite a human's
    // milestone; immutable PM intake can materialize a new, correctly bound leaf.
    if (verifiedPlan.plan.milestone) return { ok: false, reason: "milestone-binding-requires-intake" };
    const labels = [...new Set(refreshed.labels.filter((label) => !verifiedPlan.plan.removeLabels.includes(label)).concat(verifiedPlan.plan.addLabels))];
    await applySelectiveLabels({ github, owner, repo, issue: fresh.data, labels });
    const persisted = await github.rest.issues.get({ owner, repo, issue_number: issueNumber });
    if (JSON.stringify(normalizeLabels(persisted.data.labels).sort()) !== JSON.stringify(labels.sort()) ||
      persisted.data.milestone?.number !== goalMilestoneNumber) return { ok: false, reason: "promotion-verification-failed" };
  } catch (error) {
    core.warning(`Failed to apply promotion for #${issueNumber}: ${describeError(error)}.`);
    return { ok: false, reason: error.status === 403 ? "promotion-permission-denied" : "promotion-write-failed" };
  }

  return { ok: true };
}

/**
 * Renders the operator report. The scope-blocked section is the actionable
 * one: it lists exactly which issues would be promotable if a human widened
 * the approved goal, and what each one is asking for.
 */
function renderReport({ mode, controlReason, goalReason, goal, plan, candidatesByNumber, applied }) {
  const lines = [];
  lines.push("# Factory backlog promoter");
  lines.push("");
  lines.push(`- Factory mode: \`${mode}\` (${controlReason})`);
  lines.push(`- Active goal: ${goal ? `#${goal.number} (milestone \`${goal.milestone}\`)` : `none (${goalReason})`}`);

  if (!goal) {
    lines.push("");
    lines.push(
      "> No single approved goal could be resolved, so nothing can be promoted. The queue controller is subject to the same rule and will also refuse to dispatch.",
    );
    return lines.join("\n");
  }

  lines.push(`- Goal risk ceiling: \`${goal.maxGoalRiskTier}\``);
  lines.push(`- Goal allowed paths: ${goal.goalAllowedPaths.map((p) => `\`${p}\``).join(", ") || "_none_"}`);
  lines.push("");
  lines.push("## Outcome");
  lines.push("");
  lines.push("| Bucket | Count |");
  lines.push("| --- | --- |");
  for (const [bucket, count] of Object.entries(plan.counts)) {
    lines.push(`| ${bucket} | ${count} |`);
  }

  if (plan.promotions.length > 0) {
    lines.push("");
    lines.push(plan.advisory ? "## Would promote (shadow mode — not applied)" : "## Promoted");
    lines.push("");
    for (const promotion of plan.promotions) {
      const candidate = candidatesByNumber.get(promotion.number);
      const status = applied.get(promotion.number);
      const suffix = status && status.ok === false ? ` — **failed: ${status.reason}**` : "";
      lines.push(
        `- #${promotion.number} ${candidate ? candidate.title : ""} → \`${promotion.plan.addLabels.join("`, `")}\`${suffix}`,
      );
    }
  }

  const scopeBlocked = plan.rejections.filter((rejection) => rejection.bucket === "scope-blocked");
  lines.push("");
  lines.push("## Goal-scope blockers (additional blockers may also apply)");
  lines.push("");
  if (scopeBlocked.length === 0) {
    lines.push("_None._");
  } else {
    lines.push(
      "Review every listed reason; these issues are not necessarily otherwise ready. Re-scoping work or changing an approved goal is a **human decision** — this workflow never widens it.",
    );
    lines.push("");
    lines.push("| Issue | Blocking reason | Requested scope |");
    lines.push("| --- | --- | --- |");
    for (const rejection of scopeBlocked) {
      const candidate = candidatesByNumber.get(rejection.number);
      const requested = candidate
        ? [
            candidate.allowedPaths.length > 0 ? candidate.allowedPaths.map((p) => `\`${p}\``).join(" ") : "",
            candidate.declaredRiskTier ? `risk \`${candidate.declaredRiskTier}\`` : "",
          ]
            .filter(Boolean)
            .join(" · ")
        : "";
      lines.push(`| #${rejection.number} | ${rejection.reasons.join(", ")} | ${requested} |`);
    }
  }

  const authoring = plan.rejections.filter((rejection) => rejection.bucket === "authoring-incomplete");
  lines.push("");
  lines.push(`## Incomplete tickets (${authoring.length})`);
  lines.push("");
  if (authoring.length === 0) {
    lines.push("_None._");
  } else {
    lines.push("These need their issue-form sections completed before they can be promoted.");
    lines.push("");
    for (const rejection of authoring.slice(0, 50)) {
      lines.push(`- #${rejection.number}: ${rejection.reasons.join(", ")}`);
    }
    if (authoring.length > 50) {
      lines.push(`- _…and ${authoring.length - 50} more._`);
    }
  }

  return lines.join("\n");
}

/**
 * Entry point invoked by `.github/workflows/factory-backlog-promoter.yml`.
 */
async function runBacklogPromoter({ github, context, core, config = {} }) {
  const { owner, repo } = context.repo;
  const dryRun = config.dryRun === true;
  const maxPromotions = Number.isInteger(config.maxPromotions)
    ? config.maxPromotions
    : DEFAULT_MAX_PROMOTIONS;

  const result = {
    mode: "paused",
    controlReason: null,
    goalReason: null,
    promoted: [],
    plan: null,
  };

  // --- Control mode -------------------------------------------------------
  const controlIssues = await listIssuesWithLabels(github, owner, repo, [CONTROL_LABEL], "open");
  let controlResult = determineFactoryMode(controlIssues);

  if (controlResult.mode === "active") {
    const actorType = await resolveLatestLabelApplicationActorType({
      github,
      owner,
      repo,
      issueNumber: controlResult.controlIssue.number,
      labelName: ACTIVE_MODE_LABEL,
      core,
    });
    if (!isHumanActorType(actorType)) {
      core.warning(
        `"${ACTIVE_MODE_LABEL}" on issue #${controlResult.controlIssue.number} was not most-recently applied by a human (actor type: ${
          actorType ?? "unknown"
        }); treating the factory as paused. Automation cannot activate itself.`,
      );
      controlResult = { mode: "paused", reason: "active-mode-not-human-applied", controlIssue: controlResult.controlIssue };
    }
  }

  result.mode = controlResult.mode;
  result.controlReason = controlResult.reason;
  core.info(`Factory control mode resolved to "${controlResult.mode}" (${controlResult.reason}).`);

  if (controlResult.mode === "paused") {
    const summary = [
      "# Factory backlog promoter",
      "",
      `- Factory mode: \`paused\` (${controlResult.reason})`,
      "",
      "> The factory is paused, so no backlog issue was evaluated or promoted. Only a human-operator can resume it.",
    ].join("\n");
    await core.summary.addRaw(summary).write();
    return result;
  }

  // --- Active goal --------------------------------------------------------
  const goalIssues = await listIssuesWithLabels(
    github,
    owner,
    repo,
    [GOAL_LABEL, GOAL_APPROVED_LABEL],
    "open",
  );
  const goalResult = resolveActiveGoal(goalIssues);
  result.goalReason = goalResult.reason;

  if (!goalResult.valid) {
    core.warning(`Active goal resolution failed (${goalResult.reason}); nothing can be promoted.`);
    await core.summary
      .addRaw(
        renderReport({
          mode: controlResult.mode,
          controlReason: controlResult.reason,
          goalReason: goalResult.reason,
          goal: null,
          plan: null,
          candidatesByNumber: new Map(),
          applied: new Map(),
        }),
      )
      .write();
    return result;
  }

  const approvalActorType = await resolveLatestLabelApplicationActorType({
    github,
    owner,
    repo,
    issueNumber: goalResult.goal.number,
    labelName: GOAL_APPROVED_LABEL,
    core,
  });
  if (!isHumanActorType(approvalActorType)) {
    core.warning(
      `"${GOAL_APPROVED_LABEL}" on goal #${goalResult.goal.number} was not most-recently applied by a human (actor type: ${
        approvalActorType ?? "unknown"
      }); nothing can be promoted (fail closed).`,
    );
    result.goalReason = "goal-approval-not-human-applied";
    return result;
  }

  const goalIssue = goalIssues[0];
  const goalDiagnostics = diagnoseGoalIssue(goalIssue);
  if (goalDiagnostics.reasons.length) {
    result.goalReason = goalDiagnostics.reasons.join(",");
    core.warning(`Goal fields are incomplete: ${result.goalReason}`);
    return result;
  }
  const goalMilestoneNumber =
    goalIssue.milestone && Number.isInteger(goalIssue.milestone.number)
      ? goalIssue.milestone.number
      : null;

  // --- Candidates ---------------------------------------------------------
  const backlogIssues = await listIssuesWithLabels(github, owner, repo, [FACTORY_LABEL], "open");
  const candidates = [];
  for (const issue of backlogIssues) {
    if (normalizeLabels(issue.labels).includes(GOAL_LABEL)) {
      continue; // goals are not implementable candidates
    }
    candidates.push(
      await buildCandidate({
        github,
        owner,
        repo,
        issue,
        activeGoalNumber: goalResult.goal.number,
        core,
      }),
    );
  }

  const promoterConfig = {
    factoryMode: controlResult.mode,
    goalApproved: true,
    goalNumber: goalResult.goal.number,
    goalMilestone: goalResult.goal.milestone,
    goalAllowedPaths: goalResult.goal.goalAllowedPaths,
    goalScopeAnchors: goalResult.goal.goalScopeAnchors,
    maxGoalRiskTier: goalResult.goal.maxGoalRiskTier,
    concurrencyLimit: goalResult.goal.concurrencyLimit,
    currentInFlightCount: await countInFlight(github, owner, repo),
    dailyBudgetLimit: goalResult.goal.dailyBudgetLimit,
    currentBudgetUsed: await countBudgetConsumption(github, owner, repo, goalResult.goal.number, core),
    now: config.now || new Date().toISOString(),
    maxPromotions,
  };
  const plan = planPromotions(candidates, promoterConfig);
  // A manual dry-run must never render planned labels as already applied.
  plan.advisory ||= dryRun;
  result.plan = plan;

  const candidatesByNumber = new Map(candidates.map((candidate) => [candidate.number, candidate]));
  const applied = new Map();

  // Shadow mode evaluates and reports but never mutates.
  const shouldApply = controlResult.mode === "active" && !dryRun;
  if (shouldApply) {
    for (const promotion of plan.promotions) {
      const outcome = await applyPromotion({
        github,
        owner,
        repo,
        promotion,
        goalMilestoneNumber,
        core,
        candidate: candidatesByNumber.get(promotion.number),
        expectedConfig: promoterConfig,
      });
      applied.set(promotion.number, outcome);
      if (outcome.ok) {
        result.promoted.push(promotion.number);
        core.info(`Promoted issue #${promotion.number} to the factory queue.`);
      }
    }
  } else {
    core.info(
      `No labels were applied (mode="${controlResult.mode}", dryRun=${dryRun}); this pass is advisory only.`,
    );
  }

  await core.summary
    .addRaw(
      renderReport({
        mode: controlResult.mode,
        controlReason: controlResult.reason,
        goalReason: goalResult.reason,
        goal: goalResult.goal,
        plan,
        candidatesByNumber,
        applied,
      }),
    )
    .write();

  return result;
}

module.exports = {
  DEFAULT_MAX_PROMOTIONS,
  listIssuesWithLabels,
  resolveIsLeaf,
  resolveNativeParentGoalNumber,
  resolveDependencyStates,
  buildCandidate,
  renderReport,
  runBacklogPromoter,
};
