"use strict";

/**
 * Deterministic GitHub queue-controller runtime for the safety-bounded
 * autonomous SDLC factory.
 *
 * This module is the adapter layer: it is the only place that talks to the
 * GitHub API. It reads issues/sub-issues/milestones/labels/issue-form bodies
 * as the source of truth, builds a compact `QueueCandidate` list, and hands
 * the actual selection decision to the pure `agentic-queue-controller.cjs`
 * core (`selectNextIssue`). It never weakens that core's eligibility rules.
 *
 * Fail-closed rule: whenever a GitHub read fails, or a piece of source data
 * is missing/malformed, the corresponding dimension resolves to the most
 * conservative value (non-leaf, unknown dependency, blocking claim, "no
 * active goal", "paused" mode, etc.) rather than an implicit allow. Nothing
 * here silently retries a failure into a permissive default.
 */

const {
  QUEUE_READY_LABEL,
  LIFECYCLE_STATES,
  LIFECYCLE_STATE_VALUES,
  RISK_TIER_LABELS,
  isKnownRiskTier,
  normalizeAllowedPathPatterns,
} = require("./agentic-factory-policy.cjs");

const {
  buildClaimPayload,
  serializeClaimPayload,
  parseClaimPayload,
  selectNextIssue,
} = require("./agentic-queue-controller.cjs");
const { AGENTIC_POLICY } = require("./agentic-policy.cjs");
const { AUTONOMOUS_GOAL_LABEL, isAutonomousGoal, ensureAutonomousGoal } = require("./agentic-autonomy.cjs");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONTROL_LABEL = "factory-control";

const MODE_LABEL_TO_MODE = Object.freeze({
  "factory-mode:shadow": "shadow",
  "factory-mode:active": "active",
  "factory-mode:paused": "paused",
});
const MODE_LABELS = Object.freeze(Object.keys(MODE_LABEL_TO_MODE));
const PAUSED_MODE_LABEL = "factory-mode:paused";

// "factory:goal" is a classification label (not a lifecycle state) applied
// by the "Autonomous factory goal" issue template.
const GOAL_LABEL = "factory:goal";
const GOAL_APPROVED_LABEL = "factory:goal-approved";
const FACTORY_LABEL = "agentic-factory";
const READY_LABEL = QUEUE_READY_LABEL;
const CLAIMED_LABEL = LIFECYCLE_STATES.CLAIMED;
const BLOCKED_LABEL = LIFECYCLE_STATES.BLOCKED;

// Labels that represent "an implementation is currently in flight" for
// concurrency accounting (config.currentInFlightCount).
const IN_FLIGHT_LABELS = Object.freeze([
  LIFECYCLE_STATES.CLAIMED,
  LIFECYCLE_STATES.IMPLEMENTING,
  LIFECYCLE_STATES.PR_OPEN,
  LIFECYCLE_STATES.REPAIRING,
]);

// Labels that mean "this issue has, at some point, consumed one assignment
// budget unit" -- i.e. every state at/after the queue controller claimed it,
// including terminal states. Used for config.currentBudgetUsed accounting.
const POST_QUEUE_LIFECYCLE_LABELS = Object.freeze([
  LIFECYCLE_STATES.CLAIMED,
  LIFECYCLE_STATES.IMPLEMENTING,
  LIFECYCLE_STATES.PR_OPEN,
  LIFECYCLE_STATES.REPAIRING,
  LIFECYCLE_STATES.HUMAN_BOUNDARY_REVIEW,
  LIFECYCLE_STATES.BLOCKED,
  LIFECYCLE_STATES.MERGED,
  LIFECYCLE_STATES.DEPLOYED_DEV,
  LIFECYCLE_STATES.DONE,
]);

const IMPLEMENT_WORKFLOW_ID = "implement-ticket.lock.yml";
const DEFAULT_LEASE_MINUTES = 120;

// Per the factory contract (specs/factory.md), a goal's
// max_wip may only ever start at 1 and may never be raised above 2 without a
// new governance artifact. A parsed value outside {0, 1, 2} is malformed-for-purpose and
// fails closed to 0 (blocks all dispatch), same as an unparsable value.
const MAX_ALLOWED_CONCURRENCY_LIMIT = 2;

const CLAIM_MARKER_PATTERN = /<!-- factory-claim:v1 (.+?) -->/s;

const PRIORITY_LABEL_TO_PRIORITY = Object.freeze({
  "priority:P0": "P0",
  "priority:P1": "P1",
  "priority:P2": "P2",
});
const PRIORITY_LABELS = Object.freeze(Object.keys(PRIORITY_LABEL_TO_PRIORITY));

const CANDIDATE_FORM_HEADINGS = Object.freeze({
  parentGoal: "Approved parent goal",
  acceptance: "Acceptance criteria",
  validation: "Validation plan",
  scope: "Scope and non-goals",
  allowedPaths: "Allowed paths",
  risk: "Risk tier",
  rollback: "Rollback or safe reversal",
  dependencies: "Dependencies",
});

const GOAL_FORM_HEADINGS = Object.freeze({
  objective: "Objective",
  successCondition: "Measurable success condition",
  allowedScope: "Allowed scope",
  allowedPaths: "Allowed paths",
  nonGoals: "Explicit non-goals",
  maxRisk: "Maximum autonomous risk tier",
  maxWip: "Maximum active coding-agent sessions",
  assignmentBudget: "Assignment budget",
  requiredEvidence: "Required evidence",
  pauseConditions: "Pause and stop conditions",
  boundaries: "Human-only boundaries",
});

// Narrative sections that must be non-empty for a goal to be considered a
// complete, human-authored authorization (beyond the numeric/dropdown
// fields, which fail closed per-field instead -- see resolveActiveGoal).
const GOAL_REQUIRED_NARRATIVE_HEADINGS = Object.freeze([
  GOAL_FORM_HEADINGS.objective,
  GOAL_FORM_HEADINGS.successCondition,
  GOAL_FORM_HEADINGS.allowedScope,
  GOAL_FORM_HEADINGS.nonGoals,
  GOAL_FORM_HEADINGS.requiredEvidence,
  GOAL_FORM_HEADINGS.pauseConditions,
]);

// ---------------------------------------------------------------------------
// Generic, pure issue-form parsing helpers
// ---------------------------------------------------------------------------

/**
 * Splits a rendered GitHub issue-form body into `{ heading: content }`
 * sections at each `### Heading` boundary. Pure and side-effect free.
 *
 * Fails closed on a duplicate rendered heading: if the same heading text
 * appears more than once, that heading's value is omitted entirely (never
 * "last value wins," never "first value wins") so every downstream reader
 * (`getIssueFormSection`) sees it as missing. This mirrors the
 * `matches.length === 1` rule the PR merge-provenance parser
 * (`getIssueFormSection` in `agentic-pr-reconciler.cjs`) already applies,
 * so queue-selection parsing and merge-provenance parsing agree on
 * ambiguous/duplicated issue-form content instead of silently disagreeing.
 *
 * @param {unknown} body
 * @returns {Record<string, string>}
 */
function extractIssueFormSections(body) {
  if (typeof body !== "string") {
    return {};
  }

  const valuesByHeading = new Map();
  let current = null;
  let buffer = [];

  const flush = () => {
    if (current !== null) {
      if (!valuesByHeading.has(current)) {
        valuesByHeading.set(current, []);
      }
      valuesByHeading.get(current).push(buffer.join("\n").trim());
    }
    buffer = [];
  };

  for (const line of body.split(/\r?\n/)) {
    const match = /^###\s+(.+?)\s*$/.exec(line);
    if (match) {
      flush();
      current = match[1].trim();
      continue;
    }
    if (current !== null) {
      buffer.push(line);
    }
  }
  flush();

  const sections = {};
  for (const [heading, values] of valuesByHeading) {
    if (values.length === 1) {
      sections[heading] = values[0];
    }
  }

  return sections;
}

/**
 * Reads a single issue-form section, treating both "not present" and
 * GitHub's own "_No response_" placeholder (rendered for blank optional
 * fields) as missing. Fails closed to `undefined` rather than `""`.
 *
 * @param {Record<string, string>} sections
 * @param {string} heading
 * @returns {string|undefined}
 */
function getIssueFormSection(sections, heading) {
  const value = sections && sections[heading];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "_No response_") {
    return undefined;
  }
  return trimmed;
}

/**
 * Extracts the first `#123`-style issue reference from free text.
 *
 * @param {unknown} text
 * @returns {number|undefined}
 */
function parseIssueReference(text) {
  if (typeof text !== "string") {
    return undefined;
  }
  const match = /#(\d+)/.exec(text);
  return match ? Number(match[1]) : undefined;
}

/**
 * Parses the "Dependencies" issue-form field: `"None"` (case-insensitive)
 * becomes an empty list; otherwise every `#123` reference is extracted.
 * Any other content (missing field, or freeform text with no "None" and no
 * parseable issue reference) fails closed to `null` ("unknown").
 *
 * @param {unknown} text
 * @returns {number[]|null}
 */
function parseDependencyReferences(text) {
  if (typeof text !== "string") {
    return null;
  }
  const trimmed = text.trim();
  if (trimmed === "") {
    return null;
  }
  if (/^none$/i.test(trimmed)) {
    return [];
  }
  const matches = Array.from(trimmed.matchAll(/#(\d+)/g)).map((match) => Number(match[1]));
  if (matches.length === 0) {
    return null;
  }
  return Array.from(new Set(matches));
}

/**
 * Parses a non-negative base-10 integer strictly (no signs, no decimals, no
 * surrounding text). Returns `null` on anything malformed.
 *
 * @param {unknown} text
 * @returns {number|null}
 */
function parseNonNegativeInteger(text) {
  if (typeof text !== "string") {
    return null;
  }
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Normalizes a GitHub `labels` array (which may hold plain strings or
 * `{name}` objects) into a plain string array.
 *
 * @param {unknown} labels
 * @returns {string[]}
 */
function normalizeLabels(labels) {
  if (!Array.isArray(labels)) {
    return [];
  }
  return labels
    .map((label) => (typeof label === "string" ? label : label && label.name))
    .filter((name) => typeof name === "string" && name.length > 0);
}

/**
 * Parses a rendered GitHub issue-form checkboxes section (each option
 * renders as a markdown task-list line, `- [x] Label` or `- [ ] Label`) and
 * requires that at least one checkbox line is present and every one of them
 * is checked. Used for the goal template's "Human-only boundaries" section,
 * where all three checkboxes are required for a goal to be authorized.
 *
 * @param {unknown} sectionText
 * @returns {boolean}
 */
function areAllCheckboxesChecked(sectionText) {
  if (typeof sectionText !== "string") {
    return false;
  }
  const checkboxLines = sectionText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^-\s*\[[ xX]\]/.test(line));
  if (checkboxLines.length === 0) {
    return false;
  }
  return checkboxLines.every((line) => /^-\s*\[[xX]\]/.test(line));
}

/**
 * Finds the most recent `"labeled"` timeline event for a given label name.
 * Pure: operates only on an already-fetched events array. Multiple
 * label/unlabel cycles are possible over an issue's lifetime; only the
 * latest application of the label is authoritative for "who currently
 * authorized this."
 *
 * @param {unknown} events
 * @param {string} labelName
 * @returns {{event: string, label: {name: string}, actor?: {type?: string, login?: string}}|undefined}
 */
function findLatestLabelApplicationEvent(events, labelName) {
  return (Array.isArray(events) ? events : [])
    .filter(
      (event) =>
        event &&
        event.event === "labeled" &&
        event.label &&
        event.label.name === labelName,
    )
    .sort(
      (left, right) =>
        Date.parse(right.created_at || "") -
        Date.parse(left.created_at || ""),
    )[0];
}

/**
 * A label application is only "human-derived" when its actor is a GitHub
 * `User` -- never a `Bot` or `App` (i.e. never a workflow token acting on
 * its own behalf). Fails closed to `false` for any other/unknown value.
 *
 * @param {unknown} actorType
 * @returns {boolean}
 */
function isHumanActorType(actorType) {
  return actorType === "User";
}

function describeError(error) {
  if (error && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
}

function getErrorStatus(error) {
  return error && typeof error === "object" ? error.status : undefined;
}

/**
 * Validates that a value is a non-empty, parseable ISO-8601 timestamp.
 * Used to gate every "now"-dependent computation (claim staleness,
 * selection, and lease-expiry arithmetic) so an invalid clock input fails
 * closed instead of throwing a `RangeError` out of `Date.toISOString()`.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isValidTimestamp(value) {
  return typeof value === "string" && value.trim() !== "" && !Number.isNaN(Date.parse(value));
}

// ---------------------------------------------------------------------------
// Factory control (mode) resolution
// ---------------------------------------------------------------------------

/**
 * Resolves the factory's mode from the open `factory-control` issue(s).
 * Fails closed to `"paused"` for anything but exactly one control issue
 * carrying exactly one mode label. Automation must never unpause itself:
 * this function only ever reads labels, it never writes them.
 *
 * @param {Array<{number: number, labels: unknown}>} controlIssues
 * @returns {{mode: "shadow"|"active"|"paused", reason: string, controlIssue: object|null}}
 */
function determineFactoryMode(controlIssues) {
  const issues = Array.isArray(controlIssues) ? controlIssues : [];

  if (issues.length === 0) {
    return { mode: "paused", reason: "missing-control-issue", controlIssue: null };
  }
  if (issues.length > 1) {
    return { mode: "paused", reason: "multiple-control-issues", controlIssue: null };
  }

  const issue = issues[0];
  const labels = normalizeLabels(issue.labels);
  const present = MODE_LABELS.filter((label) => labels.includes(label));

  if (present.length === 0) {
    return { mode: "paused", reason: "missing-mode-label", controlIssue: issue };
  }
  if (present.length > 1) {
    return { mode: "paused", reason: "conflicting-mode-labels", controlIssue: issue };
  }

  return { mode: MODE_LABEL_TO_MODE[present[0]], reason: "ok", controlIssue: issue };
}

// ---------------------------------------------------------------------------
// Active goal resolution
// ---------------------------------------------------------------------------

/**
 * Resolves the single active, approved goal from the open issues carrying
 * both `factory:goal` and `factory:goal-approved`. Parses the goal's
 * issue-form fields, failing closed per-field per the factory contract
 * (unknown risk tier -> most restrictive "routine" ceiling still applies via
 * `resolveMaxGoalRiskTier`-equivalent defaulting; unknown WIP/budget -> 0,
 * which blocks all dispatch).
 *
 * @param {Array<{number: number, milestone: unknown, body: unknown}>} goalIssues
 * @returns {{valid: boolean, reason: string, goal: object|null}}
 */
function resolveActiveGoal(goalIssues, { autonomous = false } = {}) {
  const issues = Array.isArray(goalIssues) ? goalIssues : [];

  if (issues.length === 0) {
    return { valid: false, reason: "missing-active-goal", goal: null };
  }
  if (issues.length > 1) {
    return { valid: false, reason: "multiple-active-goals", goal: null };
  }

  const issue = issues[0];
  if (autonomous && !isAutonomousGoal(issue)) {
    return { valid: false, reason: "autonomous-goal-policy-mismatch", goal: null };
  }
  const milestoneTitle =
    issue.milestone && typeof issue.milestone.title === "string" ? issue.milestone.title.trim() : "";
  if (milestoneTitle === "") {
    return { valid: false, reason: "goal-missing-milestone", goal: null };
  }

  const sections = extractIssueFormSections(issue.body);

  // A goal is only a complete, human-derived authorization when every
  // narrative section is actually filled in and all three "Human-only
  // boundaries" checkboxes are checked. These are structural prerequisites
  // (unlike the numeric/dropdown fields below, which fail closed per-field
  // instead of invalidating the whole goal) -- an incomplete goal
  // authorizes nothing at all.
  const hasCompleteNarrative = GOAL_REQUIRED_NARRATIVE_HEADINGS.every(
    (heading) => getIssueFormSection(sections, heading) !== undefined,
  );
  if (!hasCompleteNarrative) {
    return { valid: false, reason: "goal-incomplete-narrative", goal: null };
  }

  const boundariesChecked = areAllCheckboxesChecked(
    getIssueFormSection(sections, autonomous ? "Execution boundaries" : GOAL_FORM_HEADINGS.boundaries),
  );
  if (!boundariesChecked) {
    return { valid: false, reason: "goal-boundaries-not-fully-checked", goal: null };
  }

  // "Allowed paths" is the goal's machine-readable scope ceiling: every
  // descendant candidate's own allowed paths must nest within it (enforced
  // by the pure core's `areAllowedPathPatternsWithin` check). An invalid or
  // missing goal-level scope ceiling authorizes nothing -- it is a
  // structural prerequisite, not a per-field default.
  const goalAllowedPathsRaw = getIssueFormSection(sections, GOAL_FORM_HEADINGS.allowedPaths);
  const goalAllowedPathsResult = normalizeAllowedPathPatterns(goalAllowedPathsRaw);
  if (!goalAllowedPathsResult.valid) {
    return { valid: false, reason: "goal-invalid-allowed-paths", goal: null };
  }

  const maxRiskRaw = getIssueFormSection(sections, GOAL_FORM_HEADINGS.maxRisk);
  const maxGoalRiskTier = isKnownRiskTier(maxRiskRaw) ? maxRiskRaw : "risk:routine";

  const maxWipRaw = getIssueFormSection(sections, GOAL_FORM_HEADINGS.maxWip);
  const parsedConcurrencyRaw = parseNonNegativeInteger(maxWipRaw);

  const budgetRaw = getIssueFormSection(sections, GOAL_FORM_HEADINGS.assignmentBudget);
  const parsedBudget = parseNonNegativeInteger(budgetRaw);

  const fieldWarnings = [];
  if (!isKnownRiskTier(maxRiskRaw)) {
    fieldWarnings.push("goal-malformed-max-risk-tier-defaulted-to-routine");
  }

  // The factory contract hard-caps max_wip at 2 (§12): 0 is a deliberate
  // block, 1/2 are the only permitted positive values, and anything higher
  // is out-of-contract and must fail closed to 0 rather than silently
  // permitting extra concurrency.
  let concurrencyLimit;
  if (parsedConcurrencyRaw === null) {
    concurrencyLimit = 0;
    fieldWarnings.push("goal-malformed-max-wip-defaulted-to-zero");
  } else if (parsedConcurrencyRaw > MAX_ALLOWED_CONCURRENCY_LIMIT) {
    concurrencyLimit = 0;
    fieldWarnings.push("goal-max-wip-exceeds-contract-ceiling-defaulted-to-zero");
  } else {
    concurrencyLimit = parsedConcurrencyRaw;
  }

  if (parsedBudget === null) {
    fieldWarnings.push("goal-malformed-assignment-budget-defaulted-to-zero");
  }

  return {
    valid: true,
    reason: "ok",
    goal: {
      number: issue.number,
      milestone: milestoneTitle,
      maxGoalRiskTier,
      concurrencyLimit,
      dailyBudgetLimit: parsedBudget === null ? 0 : parsedBudget,
      goalAllowedPaths: goalAllowedPathsResult.patterns,
      fieldWarnings,
    },
  };
}

// ---------------------------------------------------------------------------
// Candidate parsing (pure section extraction; async enrichment below)
// ---------------------------------------------------------------------------

/**
 * Derives candidate priority from the issue's labels: exactly one of
 * `priority:P0`/`priority:P1`/`priority:P2` elevates ordering. Zero or more
 * than one match falls back to the default (undefined) rank rather than
 * ever elevating ambiguous/conflicting priority signal.
 *
 * @param {string[]} labels
 * @returns {"P0"|"P1"|"P2"|undefined}
 */
function derivePriority(labels) {
  const present = labels.filter((label) => PRIORITY_LABELS.includes(label));
  if (present.length !== 1) {
    return undefined;
  }
  return PRIORITY_LABEL_TO_PRIORITY[present[0]];
}

/**
 * Parses the pure, synchronous portion of a candidate issue's issue-form
 * sections and labels. Does not perform any GitHub API calls.
 *
 * @param {{number: number, body: unknown, labels: unknown, milestone: unknown, state: unknown, created_at: unknown}} issue
 * @param {number|undefined} activeGoalNumber
 */
function parseCandidateSections(issue, activeGoalNumber) {
  const labels = normalizeLabels(issue.labels);
  const sections = extractIssueFormSections(issue.body);

  const parentGoalNumber = parseIssueReference(
    getIssueFormSection(sections, CANDIDATE_FORM_HEADINGS.parentGoal),
  );
  const parentGoalApproved =
    Number.isInteger(activeGoalNumber) &&
    Number.isInteger(parentGoalNumber) &&
    parentGoalNumber === activeGoalNumber;

  const dependencyNumbers = parseDependencyReferences(
    getIssueFormSection(sections, CANDIDATE_FORM_HEADINGS.dependencies),
  );

  // The issue-form "Risk tier" value is only an authoritative risk
  // assessment when it exactly matches the issue's own exactly-one risk
  // label (RISK_TIER_LABELS). Any mismatch, or zero/multiple risk labels,
  // fails closed: the declared assessment cannot be trusted.
  const riskTierText = getIssueFormSection(sections, CANDIDATE_FORM_HEADINGS.risk);
  const riskLabelsPresent = labels.filter((label) => RISK_TIER_LABELS.includes(label));
  const hasRiskAssessment =
    isKnownRiskTier(riskTierText) &&
    riskLabelsPresent.length === 1 &&
    riskLabelsPresent[0] === riskTierText;

  // "Scope and non-goals" is only a complete scope definition when it is
  // non-empty AND the required "Allowed paths" section parses into a valid,
  // normalized set of exact-file/terminal-glob patterns (shared
  // `normalizeAllowedPathPatterns` from the policy core). A missing section,
  // an empty list, or any invalid wildcard/traversal form fails closed.
  const scopeText = getIssueFormSection(sections, CANDIDATE_FORM_HEADINGS.scope);
  const allowedPathsRaw = getIssueFormSection(sections, CANDIDATE_FORM_HEADINGS.allowedPaths);
  const allowedPathsResult = normalizeAllowedPathPatterns(allowedPathsRaw);

  return {
    labels,
    milestone:
      issue.milestone && typeof issue.milestone.title === "string" ? issue.milestone.title : null,
    parentGoalNumber,
    parentGoalApproved,
    dependencyNumbers,
    hasAcceptanceCriteria:
      getIssueFormSection(sections, CANDIDATE_FORM_HEADINGS.acceptance) !== undefined,
    hasValidationPlan:
      getIssueFormSection(sections, CANDIDATE_FORM_HEADINGS.validation) !== undefined,
    hasScopeDefinition: scopeText !== undefined && allowedPathsResult.valid,
    allowedPaths: allowedPathsResult.valid ? allowedPathsResult.patterns : [],
    allowedPathsReason: allowedPathsResult.valid ? undefined : allowedPathsResult.reason,
    hasRiskAssessment,
    hasRollbackPlan: getIssueFormSection(sections, CANDIDATE_FORM_HEADINGS.rollback) !== undefined,
    priority: derivePriority(labels),
    state: issue.state === "closed" ? "closed" : "open",
    createdAt: issue.created_at,
  };
}

// ---------------------------------------------------------------------------
// GitHub read helpers
// ---------------------------------------------------------------------------

async function listIssuesWithLabels(github, owner, repo, labels, state) {
  const issues = await github.paginate(github.rest.issues.listForRepo, {
    owner,
    repo,
    state,
    labels: labels.join(","),
    per_page: 100,
  });
  // The issues API also returns pull requests carrying the requested labels;
  // exclude them since this runtime only ever selects issues.
  return issues.filter((issue) => !issue.pull_request);
}

async function countInFlight(github, owner, repo) {
  const seen = new Set();
  for (const label of IN_FLIGHT_LABELS) {
    const issues = await listIssuesWithLabels(github, owner, repo, [label], "open");
    for (const issue of issues) {
      seen.add(issue.number);
    }
  }
  return seen.size;
}

/**
 * Checks whether an issue's comments contain *any* `factory-claim:v1`
 * marker, valid or malformed. Presence alone (not validity) is what proves
 * the queue controller actually claimed and dispatched this issue at some
 * point -- which is what "consumed one assignment-budget unit" means. A
 * comment-listing failure fails closed by conservatively counting the
 * issue (never under-counting budget consumption).
 */
async function hasFactoryClaimMarker({ github, owner, repo, issueNumber, core, since }) {
  let comments;
  try {
    comments = await github.paginate(github.rest.issues.listComments, {
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 100,
    });
  } catch (error) {
    core.warning(
      `Failed to list comments for issue #${issueNumber} while accounting for assignment budget: ${describeError(
        error,
      )}; conservatively counting it as having consumed a budget unit (fail closed).`,
    );
    return true;
  }

  return comments.some((comment) => {
    if (!CLAIM_MARKER_PATTERN.test(typeof comment.body === "string" ? comment.body : "")) return false;
    if (!since) return true;
    // Missing server timestamps consume budget rather than silently undercounting.
    return !isValidTimestamp(comment.created_at) || Date.parse(comment.created_at) >= Date.parse(since);
  });
}

/**
 * Counts assignment-budget consumption for the active goal: an issue only
 * consumes a unit if (a) it carries a post-queue lifecycle label (it was
 * claimed at some point, including terminal states), (b) its "Approved
 * parent goal" resolves to this goal, and (c) it actually carries a
 * factory-claim marker (valid or malformed). A pre-queue `blocked` issue
 * that was never claimed by the queue controller must not consume budget.
 */
async function countBudgetConsumption(github, owner, repo, goalNumber, core, since) {
  const seen = new Set();
  for (const label of POST_QUEUE_LIFECYCLE_LABELS) {
    const issues = await listIssuesWithLabels(github, owner, repo, [label], "all");
    for (const issue of issues) {
      if (seen.has(issue.number)) {
        continue;
      }
      const sections = extractIssueFormSections(issue.body);
      const parentNumber = parseIssueReference(
        getIssueFormSection(sections, CANDIDATE_FORM_HEADINGS.parentGoal),
      );
      if (!Number.isInteger(parentNumber) || parentNumber !== goalNumber) {
        continue;
      }
      const claimed = await hasFactoryClaimMarker({
        github,
        owner,
        repo,
        issueNumber: issue.number,
        core,
        since,
      });
      if (claimed) {
        seen.add(issue.number);
      }
    }
  }
  return seen.size;
}

/**
 * Fetches dependency issue states in declared order. Fails closed to `null`
 * (unknown) the instant any dependency lookup fails, per the contract's
 * `dependencies-unknown` rejection.
 */
async function resolveDependencyStates({ github, owner, repo, issueNumber, dependencyNumbers, core }) {
  if (!Array.isArray(dependencyNumbers)) {
    return null;
  }

  const states = [];
  for (const dependencyNumber of dependencyNumbers) {
    try {
      const response = await github.rest.issues.get({
        owner,
        repo,
        issue_number: dependencyNumber,
      });
      states.push(response.data.state === "closed" ? "closed" : "open");
    } catch (error) {
      core.warning(
        `Failed to fetch dependency #${dependencyNumber} for issue #${issueNumber}: ${describeError(
          error,
        )}; dependency state is unknown (fail closed).`,
      );
      return null;
    }
  }
  return states;
}

/**
 * Determines whether a candidate issue is a leaf (no open sub-issues). A
 * failed sub-issues lookup fails closed to non-leaf: it must not be
 * silently treated as "no children."
 */
async function resolveIsLeaf({ github, owner, repo, issueNumber, core }) {
  try {
    const response = await github.request(
      "GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues",
      { owner, repo, issue_number: issueNumber },
    );
    const subIssues = Array.isArray(response.data) ? response.data : [];
    return subIssues.every((subIssue) => !subIssue || subIssue.state !== "open");
  } catch (error) {
    core.warning(
      `Failed to fetch sub-issues for issue #${issueNumber}: ${describeError(
        error,
      )}; treating as non-leaf (fail closed).`,
    );
    return false;
  }
}

/**
 * Resolves the candidate's *native* GitHub sub-issue parent (as opposed to
 * the "Approved parent goal" issue-form text, which is merely a
 * human-readable claim). Goal ancestry must be verified through GitHub's
 * own sub-issue relationship, not only through free text a caller could
 * type into any issue body. A missing parent, a fetch failure, or an
 * unparsable response all fail closed to `undefined` -- never silently
 * treated as "matches."
 */
async function resolveNativeParentGoalNumber({ github, owner, repo, issueNumber, core }) {
  try {
    const response = await github.request("GET /repos/{owner}/{repo}/issues/{issue_number}/parent", {
      owner,
      repo,
      issue_number: issueNumber,
    });
    const parent = response && response.data;
    if (!parent || !Number.isInteger(parent.number)) {
      core.warning(
        `Issue #${issueNumber} has no resolvable native sub-issue parent; native goal ancestry cannot be verified (fail closed).`,
      );
      return undefined;
    }
    return parent.number;
  } catch (error) {
    if (getErrorStatus(error) === 404) {
      core.warning(
        `Issue #${issueNumber} is not a native GitHub sub-issue of any parent; native goal ancestry cannot be verified (fail closed).`,
      );
    } else {
      core.warning(
        `Failed to resolve the native sub-issue parent for issue #${issueNumber}: ${describeError(
          error,
        )}; native goal ancestry is unknown (fail closed).`,
      );
    }
    return undefined;
  }
}

/**
 * Fetches an issue's timeline and returns the actor `type` (`"User"`,
 * `"Bot"`, `"App"`, ...) of the most recent application of the given
 * label. Fails closed to `null` on a fetch failure or a missing "labeled"
 * event -- callers must treat `null` the same as a non-human actor.
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
      )}; treating as not human-applied (fail closed).`,
    );
    return null;
  }

  const latest = findLatestLabelApplicationEvent(events, labelName);
  if (!latest) {
    core.warning(
      `No "labeled" timeline event was found for "${labelName}" on issue #${issueNumber}; cannot verify it was human-applied (fail closed).`,
    );
    return null;
  }

  return latest.actor && typeof latest.actor.type === "string" ? latest.actor.type : null;
}

/**
 * Conservatively searches for an open pull request already linked to this
 * issue via an exact `Refs #N` marker or an embedded claim marker for this
 * issue number. A search failure fails closed to `true` (already has an
 * open PR) rather than risking a duplicate PR.
 */
async function resolveHasOpenPullRequest({ github, owner, repo, issueNumber, core }) {
  const query = `repo:${owner}/${repo} is:pr is:open "Refs #${issueNumber}"`;
  let items;
  try {
    const response = await github.rest.search.issuesAndPullRequests({ q: query, per_page: 20 });
    items = Array.isArray(response.data && response.data.items) ? response.data.items : [];
  } catch (error) {
    core.warning(
      `Open pull request search failed for issue #${issueNumber}: ${describeError(
        error,
      )}; treating issue as already having an open pull request (fail closed).`,
    );
    return true;
  }

  const refBoundary = new RegExp(`Refs #${issueNumber}(?!\\d)`);
  return items.some((item) => {
    const body = typeof item.body === "string" ? item.body : "";
    if (refBoundary.test(body)) {
      return true;
    }
    const markerMatch = CLAIM_MARKER_PATTERN.exec(body);
    if (!markerMatch) {
      return false;
    }
    const parsed = parseClaimPayload(markerMatch[1]);
    return parsed.valid && parsed.claim.issueNumber === issueNumber;
  });
}

/**
 * Reads the most recent `<!-- factory-claim:v1 {...} -->` marker from an
 * issue's comments and returns the full parsed claim (`nonce`, `owner`,
 * `issueNumber`, `expiresAt`) so callers can verify an exact claim, not just
 * its owner/expiry. A comment-listing failure, or a marker that fails to
 * parse, fails closed to an intentionally malformed claim object (which
 * `evaluateClaimState` in the pure core treats as blocking) -- it is never
 * treated as "no claim."
 */
async function findActiveClaim({ github, owner, repo, issueNumber, core }) {
  let comments;
  try {
    comments = await github.paginate(github.rest.issues.listComments, {
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 100,
    });
  } catch (error) {
    core.warning(
      `Failed to list comments for issue #${issueNumber}: ${describeError(
        error,
      )}; treating claim state as malformed (fail closed).`,
    );
    return {};
  }

  let latestMarker;
  const orderedComments = [...comments].sort(
    (left, right) =>
      Date.parse(left.created_at || "") -
        Date.parse(right.created_at || "") ||
      (left.id || 0) - (right.id || 0),
  );
  for (const comment of orderedComments) {
    const body = typeof comment.body === "string" ? comment.body : "";
    const match = CLAIM_MARKER_PATTERN.exec(body);
    if (match) {
      latestMarker = match[1];
    }
  }

  if (latestMarker === undefined) {
    return null;
  }

  const parsed = parseClaimPayload(latestMarker);
  if (!parsed.valid) {
    core.warning(
      `Malformed claim marker found on issue #${issueNumber} (${parsed.reason}); treating as an active malformed claim (fail closed).`,
    );
    return {};
  }

  return { nonce: parsed.claim.nonce, owner: parsed.claim.owner, issueNumber: parsed.claim.issueNumber, expiresAt: parsed.claim.expiresAt };
}

/**
 * Builds the compact, fail-closed `QueueCandidate` for a single issue,
 * combining the pure section parse with the async enrichment reads.
 */
async function buildCandidate({ github, owner, repo, issue, activeGoalNumber, core }) {
  const parsed = parseCandidateSections(issue, activeGoalNumber);

  const dependencyStates = await resolveDependencyStates({
    github,
    owner,
    repo,
    issueNumber: issue.number,
    dependencyNumbers: parsed.dependencyNumbers,
    core,
  });

  const isLeaf = await resolveIsLeaf({ github, owner, repo, issueNumber: issue.number, core });

  // The issue-form "Approved parent goal" text is only a human-readable
  // claim; it must also be corroborated by GitHub's own native sub-issue
  // parent relationship. A mismatch or an unresolvable native parent fails
  // the whole ancestry check closed, regardless of what the body text says.
  const nativeParentGoalNumber = await resolveNativeParentGoalNumber({
    github,
    owner,
    repo,
    issueNumber: issue.number,
    core,
  });
  const nativeParentGoalApproved =
    Number.isInteger(activeGoalNumber) && nativeParentGoalNumber === activeGoalNumber;
  if (nativeParentGoalNumber !== undefined && !nativeParentGoalApproved) {
    core.warning(
      `Issue #${issue.number}'s native sub-issue parent is #${nativeParentGoalNumber}, which does not match the active goal #${activeGoalNumber}; failing closed.`,
    );
  }

  if (parsed.allowedPathsReason) {
    core.warning(
      `Issue #${issue.number} has an invalid or missing "Allowed paths" section (${parsed.allowedPathsReason}); scope definition is treated as incomplete (fail closed).`,
    );
  }

  const assignees = Array.isArray(issue.assignees)
    ? issue.assignees.map((assignee) => assignee && assignee.login).filter(Boolean)
    : [];

  const hasOpenPullRequest = await resolveHasOpenPullRequest({
    github,
    owner,
    repo,
    issueNumber: issue.number,
    core,
  });

  const activeClaim = await findActiveClaim({ github, owner, repo, issueNumber: issue.number, core });

  return {
    number: issue.number,
    labels: parsed.labels,
    milestone: parsed.milestone,
    parentGoalNumber: parsed.parentGoalNumber,
    parentGoalApproved: parsed.parentGoalApproved && nativeParentGoalApproved,
    dependencyStates,
    state: parsed.state,
    isLeaf,
    hasAcceptanceCriteria: parsed.hasAcceptanceCriteria,
    hasValidationPlan: parsed.hasValidationPlan,
    hasScopeDefinition: parsed.hasScopeDefinition,
    allowedPaths: parsed.allowedPaths,
    hasRiskAssessment: parsed.hasRiskAssessment,
    hasRollbackPlan: parsed.hasRollbackPlan,
    assignees,
    hasOpenPullRequest,
    hasOpenSession: assignees.length > 0,
    activeClaim,
    priority: parsed.priority,
    createdAt: parsed.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Claim application (active mode only)
// ---------------------------------------------------------------------------

function buildClaimCommentBody(claimPayload) {
  return [
    `<!-- factory-claim:v1 ${serializeClaimPayload(claimPayload)} -->`,
    "",
    `Claimed by \`${claimPayload.owner}\` (nonce \`${claimPayload.nonce}\`). This lease expires at ${claimPayload.expiresAt}; it is not silently renewed or reclaimed after expiry.`,
  ].join("\n");
}

/**
 * Re-reads the issue's labels and claim comment after mutation and verifies
 * they exactly match what was just applied: exactly one known lifecycle
 * label, and it must be `factory:claimed`; and the persisted claim marker's
 * nonce, owner, issueNumber, and expiresAt must all match exactly what was
 * just posted. Any mismatch, including a read failure, is a verification
 * failure.
 */
async function verifyClaim({ github, owner, repo, core, issueNumber, claimPayload }) {
  let freshIssue;
  try {
    const response = await github.rest.issues.get({ owner, repo, issue_number: issueNumber });
    freshIssue = response.data;
  } catch (error) {
    core.warning(
      `Failed to re-read issue #${issueNumber} to verify claim: ${describeError(error)}`,
    );
    return { ok: false, reason: "claim-verification-read-failed" };
  }

  const labels = normalizeLabels(freshIssue.labels);
  const lifecycleLabelsPresent = labels.filter((label) => LIFECYCLE_STATE_VALUES.includes(label));
  if (lifecycleLabelsPresent.length !== 1 || lifecycleLabelsPresent[0] !== CLAIMED_LABEL) {
    core.warning(
      `Claim verification failed for issue #${issueNumber}: expected exactly one lifecycle label ("${CLAIMED_LABEL}"), found [${lifecycleLabelsPresent.join(
        ", ",
      )}].`,
    );
    return { ok: false, reason: "claim-verification-label-mismatch" };
  }

  const activeClaim = await findActiveClaim({ github, owner, repo, issueNumber, core });
  if (
    !activeClaim ||
    activeClaim.nonce !== claimPayload.nonce ||
    activeClaim.owner !== claimPayload.owner ||
    activeClaim.issueNumber !== claimPayload.issueNumber ||
    activeClaim.expiresAt !== claimPayload.expiresAt
  ) {
    core.warning(
      `Claim verification failed for issue #${issueNumber}: the persisted claim marker does not exactly match the claim just posted.`,
    );
    return { ok: false, reason: "claim-verification-marker-mismatch" };
  }

  return { ok: true };
}

/**
 * Applies a claim in fail-closed order: add `factory:claimed`, remove
 * `ready-for-ai-dev`, post the machine-readable claim comment, then
 * re-read and verify the exact claim. Any step failing stops immediately
 * and reports which step failed; nothing is retried automatically.
 */
async function applyClaim({ github, owner, repo, core, issueNumber, claimPayload }) {
  try {
    await github.rest.issues.addLabels({ owner, repo, issue_number: issueNumber, labels: [CLAIMED_LABEL] });
  } catch (error) {
    core.warning(`Failed to add "${CLAIMED_LABEL}" to issue #${issueNumber}: ${describeError(error)}`);
    return { ok: false, reason: "add-claimed-label-failed" };
  }

  try {
    await github.rest.issues.removeLabel({ owner, repo, issue_number: issueNumber, name: READY_LABEL });
  } catch (error) {
    core.warning(
      `Failed to remove "${READY_LABEL}" from issue #${issueNumber}: ${describeError(error)}`,
    );
    return { ok: false, reason: "remove-ready-label-failed" };
  }

  try {
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body: buildClaimCommentBody(claimPayload),
    });
  } catch (error) {
    core.warning(`Failed to post claim comment on issue #${issueNumber}: ${describeError(error)}`);
    return { ok: false, reason: "claim-comment-failed" };
  }

  return verifyClaim({ github, owner, repo, core, issueNumber, claimPayload });
}

/**
 * Fail-closed failure handling: best-effort removes every other known
 * lifecycle label (preserving the "exactly one lifecycle label" invariant),
 * adds `blocked`, and comments the failure. Never restores
 * `ready-for-ai-dev` automatically and never selects a replacement
 * candidate in the same run. A "label not found" response is expected and
 * ignored (most lifecycle labels will not be present); any other removal
 * failure is only warned about, since blocking the issue is best-effort by
 * design and must not itself throw.
 */
async function markBlocked({ github, owner, repo, core, issueNumber, reason }) {
  for (const label of LIFECYCLE_STATE_VALUES) {
    if (label === BLOCKED_LABEL) {
      continue;
    }
    try {
      await github.rest.issues.removeLabel({ owner, repo, issue_number: issueNumber, name: label });
    } catch (error) {
      if (getErrorStatus(error) !== 404) {
        core.warning(
          `Failed to remove lifecycle label "${label}" from issue #${issueNumber} while blocking it: ${describeError(
            error,
          )}`,
        );
      }
    }
  }

  try {
    await github.rest.issues.addLabels({ owner, repo, issue_number: issueNumber, labels: [BLOCKED_LABEL] });
  } catch (error) {
    core.warning(`Failed to add "${BLOCKED_LABEL}" to issue #${issueNumber}: ${describeError(error)}`);
  }

  try {
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body: `Automated queue-controller claim/dispatch failed (\`${reason}\`). This issue has been marked \`${BLOCKED_LABEL}\` and requires human-operator review before it can return to the queue; it will not be restored to \`${READY_LABEL}\` automatically.`,
    });
  } catch (error) {
    core.warning(`Failed to comment failure on issue #${issueNumber}: ${describeError(error)}`);
  }
}

/**
 * The circuit breaker: best-effort atomically replaces the singleton
 * control issue's current mode label with `factory-mode:paused` and posts
 * exactly one audit comment explaining why. Preserves the "exactly one
 * mode label" invariant the same way `markBlocked` preserves "exactly one
 * lifecycle label": every other known mode label is removed first
 * (ignoring only a "label not found" 404; any other removal failure is
 * only warned about), then `factory-mode:paused` is added.
 *
 * Automation may pause the factory this way, but this function must never
 * be used to apply `factory-mode:active` -- only a human-operator may
 * resume active dispatch.
 */
async function autoPauseFactory({ github, owner, repo, core, controlIssueNumber, reason }) {
  for (const label of MODE_LABELS) {
    if (label === PAUSED_MODE_LABEL) {
      continue;
    }
    try {
      await github.rest.issues.removeLabel({ owner, repo, issue_number: controlIssueNumber, name: label });
    } catch (error) {
      if (getErrorStatus(error) !== 404) {
        core.warning(
          `Failed to remove mode label "${label}" from control issue #${controlIssueNumber} while auto-pausing: ${describeError(
            error,
          )}`,
        );
      }
    }
  }

  try {
    await github.rest.issues.addLabels({
      owner,
      repo,
      issue_number: controlIssueNumber,
      labels: [PAUSED_MODE_LABEL],
    });
  } catch (error) {
    core.warning(
      `Failed to add "${PAUSED_MODE_LABEL}" to control issue #${controlIssueNumber} while auto-pausing: ${describeError(
        error,
      )}`,
    );
  }

  try {
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: controlIssueNumber,
      body: `Automated circuit breaker: the queue controller set \`${PAUSED_MODE_LABEL}\` because ${reason}. Automation can pause the factory this way, but it can never unpause it -- only a human-operator changing this issue's mode label may resume \`factory-mode:active\`.`,
    });
  } catch (error) {
    core.warning(
      `Failed to post the auto-pause audit comment on control issue #${controlIssueNumber}: ${describeError(
        error,
      )}`,
    );
  }
}

async function dispatchImplementation({ github, owner, repo, core, defaultBranch, issueNumber, claimNonce }) {
  try {
    await github.rest.actions.createWorkflowDispatch({
      owner,
      repo,
      workflow_id: IMPLEMENT_WORKFLOW_ID,
      ref: defaultBranch,
      inputs: {
        issue: String(issueNumber),
        claim_nonce: claimNonce,
        aw_context: JSON.stringify({ item_type: "issue", item_number: issueNumber }),
      },
    });
    return { ok: true };
  } catch (error) {
    core.warning(`Failed to dispatch ${IMPLEMENT_WORKFLOW_ID} for issue #${issueNumber}: ${describeError(error)}`);
    return { ok: false, reason: "dispatch-failed" };
  }
}

async function resolveDefaultBranch({ github, owner, repo, configuredDefaultBranch }) {
  if (typeof configuredDefaultBranch === "string" && configuredDefaultBranch.trim() !== "") {
    return configuredDefaultBranch;
  }
  const response = await github.rest.repos.get({ owner, repo });
  return response.data.default_branch;
}

/**
 * Shared failure handler for the three ways an active-mode claim/dispatch
 * attempt can fail (claim mutation/verification failure, default-branch
 * lookup failure, dispatch failure): blocks the affected issue (never
 * restoring `ready-for-ai-dev` automatically) and trips the circuit
 * breaker on the control issue so the factory does not keep attempting
 * dispatch on a repeat trigger. Only a human-operator may resume
 * `factory-mode:active` afterward.
 */
async function haltActiveModeOnFailure({
  github,
  owner,
  repo,
  core,
  controlIssueNumber,
  issueNumber,
  reason,
  result,
}) {
  result.blocked = true;
  result.blockedReason = reason;
  await markBlocked({ github, owner, repo, core, issueNumber, reason });

  await autoPauseFactory({
    github,
    owner,
    repo,
    core,
    controlIssueNumber,
    reason: `the claim/dispatch attempt for issue #${issueNumber} failed (\`${reason}\`)`,
  });
  result.autoPaused = true;
  result.autoPauseReason = reason;

  return result;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Runs one deterministic queue-controller pass: resolves factory mode,
 * resolves the active goal, builds candidates from open
 * `ready-for-ai-dev` + `agentic-factory` issues, and -- only in `active`
 * mode -- claims and dispatches at most one selected candidate.
 *
 * @param {{github: object, context: {repo: {owner: string, repo: string}}, core: object, config?: object}} input
 */
async function runFactoryQueueController({ github, context, core, config = {} }) {
  const { owner, repo } = context.repo;
  const autonomous = config.autonomous === true && AGENTIC_POLICY.autonomy.enabled;

  const now = typeof config.now === "string" ? config.now : new Date().toISOString();
  const nowIsValid = isValidTimestamp(now);
  const leaseMinutes =
    Number.isFinite(config.leaseMinutes) && config.leaseMinutes > 0
      ? config.leaseMinutes
      : DEFAULT_LEASE_MINUTES;

  const controlIssues = await listIssuesWithLabels(github, owner, repo, [CONTROL_LABEL], "open");
  let controlResult = determineFactoryMode(controlIssues);

  // Shadow/paused may be automation-applied (a workflow pausing itself is
  // exactly the safety behavior we want). "active" is different: it is the
  // one label a workflow with issues:write could apply to itself to grant
  // its own activation, so it must be traced back to a human timeline
  // event, never merely to "the label is currently present."
  if (controlResult.mode === "active") {
    const activeModeActorType = await resolveLatestLabelApplicationActorType({
      github,
      owner,
      repo,
      issueNumber: controlResult.controlIssue.number,
      labelName: "factory-mode:active",
      core,
    });
    if (!isHumanActorType(activeModeActorType)) {
      core.warning(
        `"factory-mode:active" on issue #${controlResult.controlIssue.number} was not most-recently applied by a human user (actor type: ${
          activeModeActorType ?? "unknown"
        }); the factory is treated as paused (fail closed). Automation cannot activate itself.`,
      );
      controlResult = {
        mode: "paused",
        reason: "active-mode-not-human-applied",
        controlIssue: controlResult.controlIssue,
      };
    }
  }

  core.info(`Factory control mode resolved to "${controlResult.mode}" (${controlResult.reason}).`);
  if (controlResult.reason !== "ok") {
    core.warning(
      `Factory control issue resolution failed (${controlResult.reason}); the factory is treated as paused. Automation cannot unpause itself -- only a human-operator changing the control issue's mode label can.`,
    );
  }

  const result = {
    mode: controlResult.mode,
    controlReason: controlResult.reason,
    activeGoal: null,
    activeGoalReason: null,
    budgetRemaining: null,
    selected: null,
    rejections: [],
    claimed: false,
    dispatched: false,
    blocked: false,
    blockedReason: null,
    autoPaused: false,
    autoPauseReason: null,
    timeValid: nowIsValid,
  };

  if (controlResult.mode === "paused") {
    return result;
  }

  // "now" gates every downstream selection/claim-staleness/lease-expiry
  // computation. An invalid clock input must fail closed here -- before any
  // selection is attempted or expiry arithmetic is done -- rather than
  // risk throwing out of `Date.toISOString()` or minting a malformed lease.
  if (!nowIsValid) {
    core.warning(
      `Invalid or unparseable "now" timestamp (${JSON.stringify(
        now,
      )}); refusing to select, claim, or dispatch this run (fail closed).`,
    );
    return result;
  }

  if (autonomous && controlResult.mode === "active") {
    await ensureAutonomousGoal({ github, owner, repo });
  }
  const goalIssues = await listIssuesWithLabels(
    github,
    owner,
    repo,
    [GOAL_LABEL, autonomous ? AUTONOMOUS_GOAL_LABEL : GOAL_APPROVED_LABEL],
    "open",
  );
  const goalResult = resolveActiveGoal(goalIssues, { autonomous });
  result.activeGoalReason = goalResult.reason;

  if (!goalResult.valid) {
    core.warning(
      `Active goal resolution failed (${goalResult.reason}); no candidate can be authorized this run.`,
    );
    return result;
  }

  // "factory:goal-approved" is the label that turns this issue into a live
  // authorization; it must have been most-recently applied by a human
  // operator, never merely "currently present," since a workflow with
  // issues:write could otherwise grant its own scope.
  const approvalActorType = autonomous ? null : await resolveLatestLabelApplicationActorType({
    github,
    owner,
    repo,
    issueNumber: goalResult.goal.number,
    labelName: GOAL_APPROVED_LABEL,
    core,
  });
  if (!autonomous && !isHumanActorType(approvalActorType)) {
    core.warning(
      `"${GOAL_APPROVED_LABEL}" on goal #${goalResult.goal.number} was not most-recently applied by a human user (actor type: ${
        approvalActorType ?? "unknown"
      }); the goal is treated as unapproved (fail closed). Automation cannot approve its own scope.`,
    );
    result.activeGoalReason = "goal-approval-not-human-applied";
    return result;
  }

  result.activeGoal = goalResult.goal;
  for (const warning of goalResult.goal.fieldWarnings) {
    core.warning(`Active goal #${goalResult.goal.number}: ${warning}.`);
  }

  const candidateIssues = await listIssuesWithLabels(
    github,
    owner,
    repo,
    [READY_LABEL, FACTORY_LABEL],
    "open",
  );

  const currentInFlightCount = await countInFlight(github, owner, repo);
  const currentBudgetUsed = await countBudgetConsumption(
    github, owner, repo, goalResult.goal.number, core,
    autonomous ? `${now.slice(0, 10)}T00:00:00.000Z` : undefined,
  );
  result.budgetRemaining = Math.max(0, goalResult.goal.dailyBudgetLimit - currentBudgetUsed);

  const queueConfig = {
    factoryMode: controlResult.mode,
    goalApproved: true,
    allowedMilestones: [goalResult.goal.milestone],
    concurrencyLimit: goalResult.goal.concurrencyLimit,
    currentInFlightCount,
    dailyBudgetLimit: goalResult.goal.dailyBudgetLimit,
    currentBudgetUsed,
    maxGoalRiskTier: goalResult.goal.maxGoalRiskTier,
    goalAllowedPaths: goalResult.goal.goalAllowedPaths,
    now,
  };

  const candidates = [];
  for (const issue of candidateIssues) {
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

  const selection = selectNextIssue(candidates, queueConfig);
  result.selected = selection.selected;
  result.rejections = selection.rejections;

  for (const rejection of selection.rejections) {
    core.info(`Issue #${rejection.number} rejected: ${rejection.reasons.join(", ")}.`);
    if (rejection.reasons.includes("stale-claim-requires-recovery")) {
      core.warning(
        `Issue #${rejection.number} has an expired claim lease that was NOT silently reclaimed; it requires explicit human/lifecycle-reconciler recovery before it can be selected again.`,
      );
    }
  }

  // Circuit breaker: an expired, unrecovered claim lease anywhere in the
  // candidate pool is an accounting-integrity signal (specs/agentic-factory-
  // contract.md §15), not just a rejection reason for that one issue. In
  // active mode this must pause the factory *before* selecting or
  // dispatching any other candidate this run -- shadow mode stays
  // mutation-free and does not trip this breaker.
  if (controlResult.mode === "active") {
    const staleClaimRejections = selection.rejections.filter((rejection) =>
      rejection.reasons.includes("stale-claim-requires-recovery"),
    );
    if (staleClaimRejections.length > 0) {
      const staleIssueNumbers = staleClaimRejections.map((rejection) => `#${rejection.number}`).join(", ");
      const reason = `issue(s) ${staleIssueNumbers} carry an expired, unrecovered claim lease`;
      core.warning(
        `Circuit breaker: pausing the factory before selecting or dispatching any candidate this run because ${reason}.`,
      );
      await autoPauseFactory({
        github,
        owner,
        repo,
        core,
        controlIssueNumber: controlResult.controlIssue.number,
        reason,
      });
      result.autoPaused = true;
      result.autoPauseReason = "stale-claim-requires-recovery";
      return result;
    }
  }

  if (controlResult.mode === "shadow" || selection.advisory) {
    core.info(
      `Shadow mode: advisory selection is ${
        selection.selected ? `issue #${selection.selected.number}` : "none"
      }. No labels, comments, or dispatch were changed.`,
    );
    return result;
  }

  // Active mode.
  if (!selection.selected) {
    core.info("Active mode: no eligible candidate was selected this run.");
    return result;
  }

  const selectedIssue = selection.selected;
  const runId =
    typeof config.runId === "string" && config.runId.trim() !== ""
      ? config.runId
      : typeof process.env.GITHUB_RUN_ID === "string"
        ? process.env.GITHUB_RUN_ID
        : "";
  const attempt = Number.isInteger(config.attempt)
    ? config.attempt
    : Number.parseInt(process.env.GITHUB_RUN_ATTEMPT || "1", 10) || 1;
  const claimOwnerId =
    typeof config.claimOwner === "string" && config.claimOwner.trim() !== ""
      ? config.claimOwner
      : `queue-controller:${runId}:${attempt}`;
  const expiresAt = new Date(Date.parse(now) + leaseMinutes * 60000).toISOString();

  const claimPayload = buildClaimPayload({
    runId,
    attempt,
    issueNumber: selectedIssue.number,
    owner: claimOwnerId,
    expiresAt,
  });

  core.info(`Active mode: claiming issue #${selectedIssue.number} with nonce ${claimPayload.nonce}.`);
  const claimResult = await applyClaim({
    github,
    owner,
    repo,
    core,
    issueNumber: selectedIssue.number,
    claimPayload,
  });

  if (!claimResult.ok) {
    return haltActiveModeOnFailure({
      github,
      owner,
      repo,
      core,
      controlIssueNumber: controlResult.controlIssue.number,
      issueNumber: selectedIssue.number,
      reason: claimResult.reason,
      result,
    });
  }

  result.claimed = true;
  result.claim = claimPayload;

  let defaultBranch;
  try {
    defaultBranch = await resolveDefaultBranch({
      github,
      owner,
      repo,
      configuredDefaultBranch: config.defaultBranch,
    });
  } catch (error) {
    core.warning(`Failed to resolve the default branch: ${describeError(error)}`);
    return haltActiveModeOnFailure({
      github,
      owner,
      repo,
      core,
      controlIssueNumber: controlResult.controlIssue.number,
      issueNumber: selectedIssue.number,
      reason: "default-branch-lookup-failed",
      result,
    });
  }

  const dispatchResult = await dispatchImplementation({
    github,
    owner,
    repo,
    core,
    defaultBranch,
    issueNumber: selectedIssue.number,
    claimNonce: claimPayload.nonce,
  });

  if (!dispatchResult.ok) {
    return haltActiveModeOnFailure({
      github,
      owner,
      repo,
      core,
      controlIssueNumber: controlResult.controlIssue.number,
      issueNumber: selectedIssue.number,
      reason: dispatchResult.reason,
      result,
    });
  }

  result.dispatched = true;
  return result;
}

module.exports = {
  // Entry point.
  runFactoryQueueController,
  // Constants.
  CONTROL_LABEL,
  MODE_LABELS,
  MODE_LABEL_TO_MODE,
  PAUSED_MODE_LABEL,
  GOAL_LABEL,
  GOAL_APPROVED_LABEL,
  FACTORY_LABEL,
  READY_LABEL,
  CLAIMED_LABEL,
  BLOCKED_LABEL,
  IN_FLIGHT_LABELS,
  POST_QUEUE_LIFECYCLE_LABELS,
  IMPLEMENT_WORKFLOW_ID,
  DEFAULT_LEASE_MINUTES,
  MAX_ALLOWED_CONCURRENCY_LIMIT,
  CLAIM_MARKER_PATTERN,
  PRIORITY_LABELS,
  PRIORITY_LABEL_TO_PRIORITY,
  // Pure parsing helpers.
  extractIssueFormSections,
  getIssueFormSection,
  parseIssueReference,
  parseDependencyReferences,
  parseNonNegativeInteger,
  normalizeLabels,
  isValidTimestamp,
  areAllCheckboxesChecked,
  findLatestLabelApplicationEvent,
  isHumanActorType,
  determineFactoryMode,
  countBudgetConsumption,
  resolveActiveGoal,
  parseCandidateSections,
  buildClaimCommentBody,
};
