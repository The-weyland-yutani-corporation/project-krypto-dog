"use strict";

/**
 * Deterministic, dependency-free queue controller for the safety-bounded
 * autonomous SDLC factory.
 *
 * This module never calls GitHub directly. It is a pure decision core: given
 * a compact list of issue candidates and a controller configuration, it
 * selects at most one eligible issue (or none) using deterministic
 * eligibility rules and ordering, and reports structured rejection reasons
 * for every candidate that was not selected.
 *
 * @typedef {Object} QueueCandidate
 * @property {number} number GitHub issue number.
 * @property {string[]} labels Current issue labels.
 * @property {string|null|undefined} milestone Milestone title, if any.
 * @property {number} parentGoalNumber Approved parent goal issue number.
 * @property {boolean} parentGoalApproved Whether the parent goal issue is approved/active.
 * @property {string[]} dependencyStates State ("open"/"closed") of each blocking dependency issue.
 * @property {"open"|"closed"} state Issue open/closed state.
 * @property {boolean} isLeaf Whether the issue has no open child/tracking issues.
 * @property {boolean} hasAcceptanceCriteria
 * @property {boolean} hasValidationPlan
 * @property {boolean} hasScopeDefinition
 * @property {boolean} hasRiskAssessment
 * @property {boolean} hasRollbackPlan
 * @property {string[]} [assignees]
 * @property {boolean} [hasOpenPullRequest]
 * @property {boolean} [hasOpenSession]
 * @property {QueueClaim|null} [activeClaim]
 * @property {"P0"|"P1"|"P2"|string} [priority]
 * @property {string} createdAt ISO-8601 timestamp.
 * @property {string} [updatedAt] ISO-8601 timestamp.
 *
 * @typedef {Object} QueueClaim
 * @property {string} owner
 * @property {string} expiresAt ISO-8601 timestamp.
 *
 * @typedef {Object} QueueControllerConfig
 * @property {"active"|"shadow"} factoryMode Anything else is treated as inactive.
 * @property {boolean} goalApproved Whether the active goal is approved.
 * @property {string[]} allowedMilestones Ordered allow-list; order also defines milestone priority.
 * @property {number} concurrencyLimit Maximum concurrent in-flight implementations.
 * @property {number} currentInFlightCount Current in-flight implementation count.
 * @property {number} dailyBudgetLimit Legacy field name for the goal's total assignment budget.
 * @property {number} currentBudgetUsed Assignments already consumed under the goal.
 * @property {string} maxGoalRiskTier Maximum risk tier the active goal permits (RISK_TIERS value).
 * @property {string[]} goalAllowedPaths Machine-readable goal scope.
 * @property {string} [now] ISO-8601 "current time" used for lease staleness checks.
 */

const {
  RISK_TIER_LABELS,
  rankRiskTier,
  isKnownRiskTier,
  RISK_TIERS,
  QUEUE_READY_LABEL,
  BLOCKING_QUEUE_LABELS,
  LIFECYCLE_STATE_VALUES,
  areAllowedPathPatternsWithin,
} = require("./agentic-factory-policy.cjs");

const READINESS_FIELDS = Object.freeze([
  "hasAcceptanceCriteria",
  "hasValidationPlan",
  "hasScopeDefinition",
  "hasRiskAssessment",
  "hasRollbackPlan",
]);

const PRIORITY_ORDER = Object.freeze(["P0", "P1"]);

/**
 * Priority rank: P0 = 0, P1 = 1, everything else (including P2 and unknown
 * values) is grouped together at rank 2.
 *
 * @param {string} priority
 * @returns {number}
 */
function priorityRank(priority) {
  const index = PRIORITY_ORDER.indexOf(priority);
  return index === -1 ? PRIORITY_ORDER.length : index;
}

function isValidTimestamp(value) {
  return typeof value === "string" && value.trim() !== "" && !Number.isNaN(Date.parse(value));
}

// ---------------------------------------------------------------------------
// Lease / claim helpers
// ---------------------------------------------------------------------------

/**
 * Evaluates whether a claim (lease) is currently blocking selection.
 * Malformed leases fail closed: they are treated as still blocking rather
 * than silently reclaimed.
 *
 * @param {QueueClaim|null|undefined} claim
 * @param {string|undefined} nowIso
 * @returns {{present: boolean, blocking: boolean, malformed: boolean, expired?: boolean, reason: string}}
 */
function evaluateClaimState(claim, nowIso) {
  if (claim === null || claim === undefined) {
    return { present: false, blocking: false, malformed: false, reason: "no-claim" };
  }

  if (
    typeof claim !== "object" ||
    typeof claim.owner !== "string" ||
    claim.owner.trim() === "" ||
    !isValidTimestamp(claim.expiresAt)
  ) {
    return { present: true, blocking: true, malformed: true, reason: "malformed-claim" };
  }

  if (!isValidTimestamp(nowIso)) {
    // Cannot evaluate staleness without a valid "now"; fail closed.
    return { present: true, blocking: true, malformed: false, reason: "unknown-now-fail-closed" };
  }

  const expired = Date.parse(claim.expiresAt) <= Date.parse(nowIso);
  return {
    present: true,
    blocking: !expired,
    malformed: false,
    expired,
    reason: expired ? "claim-expired" : "claim-active",
  };
}

function isLeaseStale(claim, nowIso) {
  const state = evaluateClaimState(claim, nowIso);
  return state.present && !state.malformed && Boolean(state.expired);
}

// ---------------------------------------------------------------------------
// Claim nonce / payload helpers (deterministic, no randomness)
// ---------------------------------------------------------------------------

/**
 * Builds a unique, deterministic claim nonce from the run id, attempt
 * number, and issue number. No randomness is used: the same inputs always
 * produce the same nonce, which is what makes claims safe to retry.
 *
 * @param {{runId: string, attempt: number, issueNumber: number}} input
 * @returns {string}
 */
function buildClaimNonce({ runId, attempt, issueNumber } = {}) {
  if (
    typeof runId !== "string" ||
    runId.trim() === "" ||
    !Number.isInteger(attempt) ||
    attempt < 0 ||
    !Number.isInteger(issueNumber)
  ) {
    throw new TypeError(
      "buildClaimNonce requires a non-empty runId, a non-negative integer attempt, and an integer issueNumber",
    );
  }
  return `${runId}:${attempt}:${issueNumber}`;
}

/**
 * Builds a deterministic claim payload ready to be persisted (e.g. as an
 * issue comment or label metadata).
 *
 * @param {{runId: string, attempt: number, issueNumber: number, owner: string, expiresAt: string}} input
 * @returns {{nonce: string, owner: string, issueNumber: number, expiresAt: string}}
 */
function buildClaimPayload({ runId, attempt, issueNumber, owner, expiresAt } = {}) {
  const nonce = buildClaimNonce({ runId, attempt, issueNumber });
  if (typeof owner !== "string" || owner.trim() === "") {
    throw new TypeError("buildClaimPayload requires a non-empty owner");
  }
  if (!isValidTimestamp(expiresAt)) {
    throw new TypeError("buildClaimPayload requires a valid ISO-8601 expiresAt");
  }
  return { nonce, owner, issueNumber, expiresAt };
}

function serializeClaimPayload(payload) {
  return JSON.stringify(payload);
}

/**
 * Parses and validates a serialized claim payload. Never throws: returns a
 * structured, fail-closed result instead.
 *
 * @param {string} serialized
 * @returns {{valid: boolean, claim?: object, reason?: string}}
 */
function parseClaimPayload(serialized) {
  if (typeof serialized !== "string") {
    return { valid: false, reason: "not-a-string" };
  }

  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return { valid: false, reason: "invalid-json" };
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof parsed.nonce !== "string" ||
    parsed.nonce.trim() === "" ||
    typeof parsed.owner !== "string" ||
    parsed.owner.trim() === "" ||
    !Number.isInteger(parsed.issueNumber) ||
    !isValidTimestamp(parsed.expiresAt)
  ) {
    return { valid: false, reason: "invalid-claim-shape" };
  }

  return { valid: true, claim: parsed };
}

// ---------------------------------------------------------------------------
// Idempotency / correlation helpers
// ---------------------------------------------------------------------------

/**
 * A correlation id is the same deterministic nonce used for claims, exposed
 * separately so callers can correlate a queue selection run with downstream
 * dispatch/claim operations without recomputing the formula inline.
 */
function buildCorrelationId({ runId, attempt, issueNumber }) {
  return buildClaimNonce({ runId, attempt, issueNumber });
}

function isIdempotentRetry(previousCorrelationId, currentCorrelationId) {
  return (
    typeof previousCorrelationId === "string" &&
    typeof currentCorrelationId === "string" &&
    previousCorrelationId === currentCorrelationId
  );
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

function resolveMaxGoalRiskTier(config) {
  const candidate = config && config.maxGoalRiskTier;
  return isKnownRiskTier(candidate) ? candidate : RISK_TIERS.ROUTINE;
}

/**
 * Evaluates a single candidate against the controller configuration.
 *
 * @param {QueueCandidate} candidate
 * @param {QueueControllerConfig} config
 * @returns {string[]} empty when eligible; otherwise every applicable rejection reason
 */
function evaluateEligibility(candidate, config) {
  if (!candidate || typeof candidate !== "object") {
    return ["invalid-candidate"];
  }

  if (!config || typeof config !== "object" || !["active", "shadow"].includes(config.factoryMode)) {
    return ["factory-not-active"];
  }

  const reasons = [];

  if (!Number.isInteger(candidate.number) || candidate.number <= 0) {
    reasons.push("invalid-issue-number");
  }

  if (!config.goalApproved || candidate.parentGoalApproved !== true) {
    reasons.push("goal-not-approved");
  }
  if (Array.isArray(config.goalScopeAnchors) && config.goalScopeAnchors.length > 0 &&
    !config.goalScopeAnchors.includes(candidate.number) &&
    (!config.goalScopeAnchors.includes(candidate.scopeSourceIssueNumber) || candidate.scopeSourceVerified !== true)) {
    reasons.push("goal-prose-scope-unproven");
  }
  if (Array.isArray(candidate.scopeProofReasons)) reasons.push(...candidate.scopeProofReasons);
  if (
    !areAllowedPathPatternsWithin(
      candidate.allowedPaths,
      config.goalAllowedPaths,
    )
  ) {
    reasons.push("scope-exceeds-goal");
  }
  if (!Number.isInteger(candidate.parentGoalNumber) || candidate.parentGoalNumber <= 0) {
    reasons.push("missing-parent-goal");
  }

  const allowedMilestones = Array.isArray(config.allowedMilestones) ? config.allowedMilestones : [];
  if (
    typeof candidate.milestone !== "string" ||
    candidate.milestone.trim() === "" ||
    !allowedMilestones.includes(candidate.milestone)
  ) {
    reasons.push("milestone-not-allowed");
  }

  if (candidate.state !== "open" || candidate.isLeaf !== true) {
    reasons.push("not-open-leaf");
  }

  const labels = Array.isArray(candidate.labels) ? candidate.labels : [];
  if (!Array.isArray(candidate.labels)) {
    reasons.push("invalid-label-data");
  }

  if (!labels.includes(QUEUE_READY_LABEL)) {
    reasons.push("missing-ready-label");
  }
  const lifecycleLabels = labels.filter((label) =>
    LIFECYCLE_STATE_VALUES.includes(label),
  );
  if (
    lifecycleLabels.length !== 1 ||
    lifecycleLabels[0] !== QUEUE_READY_LABEL
  ) {
    reasons.push("invalid-lifecycle-label-count");
  }

  const riskLabels = labels.filter((label) => RISK_TIER_LABELS.includes(label));
  if (riskLabels.length !== 1) {
    reasons.push("invalid-risk-label-count");
  }

  const dependencyStates = Array.isArray(candidate.dependencyStates)
    ? candidate.dependencyStates
    : null;
  if (!dependencyStates) {
    reasons.push("dependencies-unknown");
  } else if (dependencyStates.some((state) => state !== "closed")) {
    reasons.push("dependencies-not-closed");
  }

  for (const field of READINESS_FIELDS) {
    if (candidate[field] !== true) {
      reasons.push(`readiness-incomplete:${field}`);
    }
  }

  if (labels.some((label) => BLOCKING_QUEUE_LABELS.includes(label))) {
    reasons.push("blocked-by-label");
  }

  const assignees = Array.isArray(candidate.assignees) ? candidate.assignees : [];
  if (assignees.length > 0) {
    reasons.push("already-assigned");
  }
  if (candidate.hasOpenSession === true) {
    reasons.push("already-has-open-session");
  }
  if (candidate.hasOpenPullRequest === true) {
    reasons.push("already-has-open-pull-request");
  }

  const claimState = evaluateClaimState(candidate.activeClaim, config.now);
  if (claimState.blocking) {
    reasons.push("active-claim");
  } else if (claimState.present && claimState.expired) {
    reasons.push("stale-claim-requires-recovery");
  }

  const concurrencyLimit = Number.isFinite(config.concurrencyLimit) ? config.concurrencyLimit : 0;
  const currentInFlightCount = Number.isFinite(config.currentInFlightCount)
    ? config.currentInFlightCount
    : Infinity;
  if (currentInFlightCount >= concurrencyLimit) {
    reasons.push("concurrency-limit-reached");
  }

  const dailyBudgetLimit = Number.isFinite(config.dailyBudgetLimit) ? config.dailyBudgetLimit : 0;
  const currentBudgetUsed = Number.isFinite(config.currentBudgetUsed)
    ? config.currentBudgetUsed
    : Infinity;
  if (currentBudgetUsed >= dailyBudgetLimit) {
    reasons.push("budget-limit-reached");
  }

  if (riskLabels.length === 1) {
    const candidateRank = rankRiskTier(riskLabels[0]);
    const maxRank = rankRiskTier(resolveMaxGoalRiskTier(config));
    if (candidateRank > maxRank) {
      reasons.push("risk-exceeds-goal-max");
    }
  }

  if (!isValidTimestamp(candidate.createdAt)) {
    reasons.push("invalid-created-at");
  }

  return reasons;
}

// ---------------------------------------------------------------------------
// Deterministic ordering
// ---------------------------------------------------------------------------

function milestoneRank(milestone, allowedMilestones) {
  const index = allowedMilestones.indexOf(milestone);
  return index === -1 ? allowedMilestones.length : index;
}

function createdAtRank(createdAt) {
  const parsed = Date.parse(createdAt);
  return Number.isNaN(parsed) ? Infinity : parsed;
}

/**
 * Deterministic comparator: P0 before P1 before P2/default, then configured
 * milestone order, then oldest createdAt, then lowest issue number.
 *
 * @param {QueueCandidate} a
 * @param {QueueCandidate} b
 * @param {QueueControllerConfig} config
 * @returns {number}
 */
function compareCandidates(a, b, config) {
  const priorityDelta = priorityRank(a.priority) - priorityRank(b.priority);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }

  const allowedMilestones = Array.isArray(config && config.allowedMilestones)
    ? config.allowedMilestones
    : [];
  const milestoneDelta =
    milestoneRank(a.milestone, allowedMilestones) - milestoneRank(b.milestone, allowedMilestones);
  if (milestoneDelta !== 0) {
    return milestoneDelta;
  }

  const createdAtDelta = createdAtRank(a.createdAt) - createdAtRank(b.createdAt);
  if (createdAtDelta !== 0) {
    return createdAtDelta;
  }

  const aNumber = Number.isFinite(a.number) ? a.number : Infinity;
  const bNumber = Number.isFinite(b.number) ? b.number : Infinity;
  return aNumber - bNumber;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Selects at most one eligible candidate using the deterministic ordering
 * rules. In shadow mode, the same algorithm runs and the result is marked
 * advisory rather than being suppressed.
 *
 * @param {QueueCandidate[]} candidates
 * @param {QueueControllerConfig} config
 * @returns {{selected: QueueCandidate|null, advisory: boolean, rejections: Array<{number: number|undefined, reasons: string[]}>}}
 */
function selectNextIssue(candidates, config) {
  const list = Array.isArray(candidates) ? candidates : [];

  const evaluations = list.map((candidate) => ({
    candidate,
    reasons: evaluateEligibility(candidate, config),
  }));

  const eligible = evaluations
    .filter((evaluation) => evaluation.reasons.length === 0)
    .map((evaluation) => evaluation.candidate)
    .sort((a, b) => compareCandidates(a, b, config));

  const selected = eligible[0] || null;
  const rejections = evaluations
    .filter((evaluation) => evaluation.reasons.length > 0)
    .map((evaluation) => ({
      number:
        evaluation.candidate && typeof evaluation.candidate === "object"
          ? evaluation.candidate.number
          : undefined,
      reasons: evaluation.reasons,
    }));
  for (const candidate of eligible.slice(1)) {
    rejections.push({
      number: candidate.number,
      reasons: ["lower-priority-than-selected"],
    });
  }

  const advisory = Boolean(config && config.factoryMode === "shadow");

  return {
    selected,
    advisory,
    rejections,
  };
}

module.exports = {
  READINESS_FIELDS,
  PRIORITY_ORDER,
  priorityRank,
  evaluateClaimState,
  isLeaseStale,
  buildClaimNonce,
  buildClaimPayload,
  serializeClaimPayload,
  parseClaimPayload,
  buildCorrelationId,
  isIdempotentRetry,
  resolveMaxGoalRiskTier,
  evaluateEligibility,
  milestoneRank,
  createdAtRank,
  compareCandidates,
  selectNextIssue,
};
