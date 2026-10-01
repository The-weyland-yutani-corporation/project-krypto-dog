// @ts-check
"use strict";

/**
 * Deterministic decision core for factory backlog promotion.
 *
 * The queue controller (`agentic-queue-controller.cjs`) only ever *selects*
 * among issues that are already queue-eligible. Nothing in the factory moves a
 * raw backlog issue into that eligible set, so a repository can sit with a
 * large `agentic-factory` backlog while the queue controller correctly reports
 * "no eligible candidate" on every pass.
 *
 * This module closes that gap without widening any authority boundary. It
 * decides, for each backlog issue, whether the issue may be labelled
 * `factory:ready` so the existing queue controller can see it.
 *
 * Authority rules (these are deliberate and must not be relaxed):
 *
 * - Promotion NEVER invents authorization. It only materializes signals a
 *   human already wrote into the issue: the declared parent goal, the declared
 *   risk tier, and the declared allowed paths. If any of those is absent or
 *   unparsable, the issue is not promoted.
 * - Promotion NEVER widens the approved goal. An issue whose allowed paths do
 *   not nest within the goal's allowed paths, or whose declared risk tier
 *   exceeds the goal's ceiling, is reported as scope-blocked so a human can
 *   decide whether to widen the goal. It is never promoted anyway.
 * - Promotion NEVER auto-promotes `risk:boundary`. Boundary work is never
 *   auto-merged (factory contract §7/§14), so routing it through autonomous
 *   dispatch would burn a WIP slot on work that must stop for a human.
 * - Promotion is a no-op unless the factory mode is `active`. `shadow`
 *   evaluates and reports without mutating anything; `paused` does nothing.
 *
 * This module performs no GitHub API calls. It is pure so it can be unit
 * tested exhaustively; all I/O lives in `agentic-backlog-promoter-runtime.cjs`.
 */

const {
  RISK_TIER_LABELS,
  RISK_TIERS,
  rankRiskTier,
  isKnownRiskTier,
  QUEUE_READY_LABEL,
  BLOCKING_QUEUE_LABELS,
  LIFECYCLE_STATE_VALUES,
  isLegalLifecycleTransition,
  areAllowedPathPatternsWithin,
} = require("./agentic-factory-policy.cjs");

/**
 * Readiness fields a candidate issue must have authored before it can be
 * promoted. These mirror the queue controller's own readiness gate so that a
 * promoted issue is actually selectable rather than immediately rejected.
 */
const READINESS_FIELDS = Object.freeze([
  "hasAcceptanceCriteria",
  "hasValidationPlan",
  "hasScopeDefinition",
  "hasRollbackPlan",
]);

/**
 * The only upstream lifecycle states promotion may transition *from*.
 *
 * The transition table legally permits several later states (e.g.
 * `factory:claimed -> ready-for-ai-dev`) because a repair path needs them.
 * Promotion must never use those: an issue that is claimed, implementing, or
 * has a PR open is in-flight work owned by another part of the factory.
 * Restricting the source states to the two pre-dispatch planning states keeps
 * promotion a strictly forward, pre-dispatch move.
 */
const PROMOTABLE_FROM_STATES = Object.freeze(["ready-for-planning", "needs-rubber-duck"]);

/**
 * Rejection reasons that mean "a human must widen or re-scope the approved
 * goal", as opposed to "the issue body is incomplete". These drive the
 * scope-widening report the operator uses to decide what to broaden.
 */
const SCOPE_BLOCKED_REASONS = Object.freeze([
  "scope-exceeds-goal",
  "risk-exceeds-goal-max",
  "parent-goal-mismatch",
  "milestone-conflict",
]);

/** Reasons that mean the issue text itself is not ready for autonomous work. */
const AUTHORING_BLOCKED_REASONS = Object.freeze([
  "missing-parent-goal",
  "missing-declared-risk-tier",
  "unknown-declared-risk-tier",
  "invalid-allowed-paths",
  "dependencies-unknown",
  "dependencies-not-closed",
]);

function normalizeStringArray(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

/**
 * Resolves the goal's risk ceiling, failing closed to the most restrictive
 * tier when the configured value is missing or unknown.
 *
 * @param {{maxGoalRiskTier?: unknown}} config
 * @returns {string}
 */
function resolveGoalRiskCeiling(config) {
  const declared = config && config.maxGoalRiskTier;
  return typeof declared === "string" && isKnownRiskTier(declared) ? declared : RISK_TIERS.ROUTINE;
}

/**
 * Evaluates one backlog issue against the active goal.
 *
 * @param {object} candidate Parsed candidate issue.
 * @param {object} config Promoter configuration derived from the active goal.
 * @returns {{number: number|undefined, promotable: boolean, reasons: string[], bucket: string, plan: object|null}}
 */
function evaluatePromotion(candidate, config) {
  if (!candidate || typeof candidate !== "object") {
    return { number: undefined, promotable: false, reasons: ["invalid-candidate"], bucket: "invalid", plan: null };
  }

  const reasons = [];

  // The factory light switch is authoritative and fail-closed. `shadow` is
  // evaluated (so the report is still produced) but the runtime refuses to
  // mutate; `paused` never reaches this function at all.
  if (!config || typeof config !== "object" || !["active", "shadow"].includes(config.factoryMode)) {
    return {
      number: candidate.number,
      promotable: false,
      reasons: ["factory-not-active"],
      bucket: "factory",
      plan: null,
    };
  }

  if (!Number.isInteger(candidate.number) || candidate.number <= 0) {
    reasons.push("invalid-issue-number");
  }

  // --- Goal authorization -------------------------------------------------
  // The goal is the authorization object. Promotion may only ever act inside
  // an approved goal; it can never substitute for one.
  if (config.goalApproved !== true) {
    reasons.push("goal-not-approved");
  }
  if (!Number.isInteger(candidate.parentGoalNumber) || candidate.parentGoalNumber <= 0) {
    reasons.push("missing-parent-goal");
  } else if (candidate.parentGoalNumber !== config.goalNumber) {
    // The issue declares a different parent goal than the single active one.
    // This is a scope decision for a human, not something promotion may
    // silently re-point.
    reasons.push("parent-goal-mismatch");
  }

  // --- Issue state --------------------------------------------------------
  if (candidate.state !== "open") {
    reasons.push("not-open");
  }
  if (candidate.isLeaf !== true) {
    reasons.push("not-leaf");
  }

  const labels = normalizeStringArray(candidate.labels);

  // Lifecycle handling. The queue controller requires exactly one lifecycle
  // label and it must be the ready label, so promotion may only either add
  // the ready label to an issue with no lifecycle state, or perform a legal
  // transition from a single upstream state (removing the old label to
  // preserve the "exactly one lifecycle label" invariant).
  //
  // `blocked` and `ready-for-human-review` are deliberately excluded even
  // though the transition table permits `blocked -> ready-for-ai-dev`:
  // clearing them is a human judgment, never an automated one.
  const lifecycleLabels = labels.filter((label) => LIFECYCLE_STATE_VALUES.includes(label));
  const blockingLabels = labels.filter((label) => BLOCKING_QUEUE_LABELS.includes(label));
  let lifecycleToRemove = [];

  if (blockingLabels.length > 0) {
    reasons.push("blocked-by-label");
  } else if (lifecycleLabels.length > 1) {
    reasons.push("conflicting-lifecycle-labels");
  } else if (lifecycleLabels.length === 1) {
    if (lifecycleLabels[0] === QUEUE_READY_LABEL) {
      reasons.push("already-ready");
    } else if (!PROMOTABLE_FROM_STATES.includes(lifecycleLabels[0])) {
      // Later lifecycle states are in-flight work owned elsewhere in the
      // factory, even where the transition table would permit the move.
      reasons.push("already-in-lifecycle");
    } else if (!isLegalLifecycleTransition(lifecycleLabels[0], QUEUE_READY_LABEL)) {
      reasons.push("illegal-lifecycle-transition");
    } else {
      lifecycleToRemove = [lifecycleLabels[0]];
    }
  }

  // --- Risk tier ----------------------------------------------------------
  // The declared tier comes from the issue-form "Risk tier" field, i.e. from
  // whoever authored the ticket. Promotion materializes that human statement
  // into a label; it never classifies risk on its own.
  const existingRiskLabels = labels.filter((label) => RISK_TIER_LABELS.includes(label));
  const declaredRiskTier =
    typeof candidate.declaredRiskTier === "string" ? candidate.declaredRiskTier.trim() : "";

  let effectiveRiskTier = null;
  if (declaredRiskTier === "") {
    reasons.push("missing-declared-risk-tier");
  } else if (!isKnownRiskTier(declaredRiskTier)) {
    reasons.push("unknown-declared-risk-tier");
  } else if (existingRiskLabels.length > 1) {
    reasons.push("conflicting-risk-labels");
  } else if (existingRiskLabels.length === 1 && existingRiskLabels[0] !== declaredRiskTier) {
    // A label that disagrees with the declared tier is ambiguous provenance.
    reasons.push("risk-label-conflicts-with-declaration");
  } else {
    effectiveRiskTier = declaredRiskTier;
  }

  if (effectiveRiskTier === RISK_TIERS.BOUNDARY) {
    // Boundary work requires current-head human approval and is never
    // auto-merged; dispatching it autonomously only consumes a WIP slot.
    reasons.push("risk-boundary-requires-human");
  }
  if (effectiveRiskTier !== null && effectiveRiskTier !== RISK_TIERS.BOUNDARY) {
    if (rankRiskTier(effectiveRiskTier) > rankRiskTier(resolveGoalRiskCeiling(config))) {
      reasons.push("risk-exceeds-goal-max");
    }
  }

  // --- Scope --------------------------------------------------------------
  if (candidate.hasScopeDefinition !== true) {
    reasons.push("invalid-allowed-paths");
  } else if (
    !areAllowedPathPatternsWithin(candidate.allowedPaths, normalizeStringArray(config.goalAllowedPaths))
  ) {
    reasons.push("scope-exceeds-goal");
  }

  // --- Milestone ----------------------------------------------------------
  // Promotion may bind an unmilestoned issue to the goal's milestone, because
  // the issue already declares that goal as its parent. It must never move an
  // issue off a milestone a human deliberately set.
  const goalMilestone = typeof config.goalMilestone === "string" ? config.goalMilestone.trim() : "";
  const candidateMilestone =
    typeof candidate.milestone === "string" ? candidate.milestone.trim() : "";
  let milestoneToSet = null;
  if (goalMilestone === "") {
    reasons.push("goal-missing-milestone");
  } else if (candidateMilestone === "") {
    milestoneToSet = goalMilestone;
  } else if (candidateMilestone !== goalMilestone) {
    reasons.push("milestone-conflict");
  }

  // --- Readiness ----------------------------------------------------------
  for (const field of READINESS_FIELDS) {
    if (candidate[field] !== true) {
      reasons.push(`readiness-incomplete:${field}`);
    }
  }

  // --- Dependencies -------------------------------------------------------
  const dependencyStates = Array.isArray(candidate.dependencyStates)
    ? candidate.dependencyStates
    : null;
  if (!dependencyStates) {
    reasons.push("dependencies-unknown");
  } else if (dependencyStates.some((state) => state !== "closed")) {
    reasons.push("dependencies-not-closed");
  }

  // --- In-flight signals --------------------------------------------------
  if (normalizeStringArray(candidate.assignees).length > 0) {
    reasons.push("already-assigned");
  }
  if (candidate.hasOpenPullRequest === true) {
    reasons.push("already-has-open-pull-request");
  }
  if (candidate.hasOpenSession === true) {
    reasons.push("already-has-open-session");
  }

  if (reasons.length > 0) {
    return {
      number: candidate.number,
      promotable: false,
      reasons,
      bucket: classifyBucket(reasons),
      plan: null,
    };
  }

  const addLabels = [QUEUE_READY_LABEL];
  if (existingRiskLabels.length === 0 && effectiveRiskTier !== null) {
    addLabels.push(effectiveRiskTier);
  }

  return {
    number: candidate.number,
    promotable: true,
    reasons: [],
    bucket: "promotable",
    plan: {
      addLabels,
      removeLabels: lifecycleToRemove,
      milestone: milestoneToSet,
      riskTier: effectiveRiskTier,
    },
  };
}

/**
 * Buckets a rejection so the operator report can separate "widen the goal"
 * from "finish authoring the ticket" from "already moving".
 *
 * @param {string[]} reasons
 * @returns {string}
 */
function classifyBucket(reasons) {
  if (reasons.some((reason) => SCOPE_BLOCKED_REASONS.includes(reason))) {
    return "scope-blocked";
  }
  if (
    reasons.some(
      (reason) => AUTHORING_BLOCKED_REASONS.includes(reason) || reason.startsWith("readiness-incomplete:"),
    )
  ) {
    return "authoring-incomplete";
  }
  if (
    reasons.some((reason) =>
      [
        "already-ready",
        "already-in-lifecycle",
        "conflicting-lifecycle-labels",
        "illegal-lifecycle-transition",
        "blocked-by-label",
        "already-assigned",
        "already-has-open-pull-request",
        "already-has-open-session",
      ].includes(reason),
    )
  ) {
    return "in-flight";
  }
  if (reasons.includes("risk-boundary-requires-human")) {
    return "boundary-requires-human";
  }
  return "ineligible";
}

/**
 * Evaluates the whole backlog and returns a bounded promotion plan plus a
 * grouped report.
 *
 * `maxPromotions` bounds how many issues a single pass may promote. This keeps
 * a misconfiguration from flooding the queue in one run; the queue controller
 * still dispatches at most one issue per pass regardless.
 *
 * @param {object[]} candidates
 * @param {object} config
 */
function planPromotions(candidates, config) {
  const list = Array.isArray(candidates) ? candidates : [];
  const evaluations = list.map((candidate) => evaluatePromotion(candidate, config));

  const limitRaw = config && config.maxPromotions;
  const maxPromotions = Number.isInteger(limitRaw) && limitRaw >= 0 ? limitRaw : 0;

  const promotable = evaluations
    .filter((evaluation) => evaluation.promotable)
    .sort((a, b) => (a.number || 0) - (b.number || 0));

  const promotions = promotable.slice(0, maxPromotions);
  const deferred = promotable.slice(maxPromotions).map((evaluation) => ({
    number: evaluation.number,
    reasons: ["promotion-limit-reached"],
    bucket: "deferred",
  }));

  const rejections = evaluations
    .filter((evaluation) => !evaluation.promotable)
    .map((evaluation) => ({
      number: evaluation.number,
      reasons: evaluation.reasons,
      bucket: evaluation.bucket,
    }))
    .concat(deferred);

  return {
    advisory: Boolean(config && config.factoryMode === "shadow"),
    promotions,
    rejections,
    counts: summarizeBuckets(rejections, promotions.length),
  };
}

/**
 * @param {Array<{bucket: string}>} rejections
 * @param {number} promotedCount
 */
function summarizeBuckets(rejections, promotedCount) {
  const counts = { promotable: promotedCount };
  for (const rejection of rejections) {
    counts[rejection.bucket] = (counts[rejection.bucket] || 0) + 1;
  }
  return counts;
}

module.exports = {
  READINESS_FIELDS,
  SCOPE_BLOCKED_REASONS,
  AUTHORING_BLOCKED_REASONS,
  resolveGoalRiskCeiling,
  evaluatePromotion,
  classifyBucket,
  planPromotions,
  summarizeBuckets,
};
