"use strict";

/**
 * Deterministic issue/session/PR/dev lifecycle reconciler for the
 * safety-bounded autonomous SDLC factory (specs/agentic-factory-contract.md
 * sections 5, 9, 10, 13, 15).
 *
 * This reconciler NEVER executes issue/PR-authored code. It only reads
 * issue/PR/check/deployment state through the GitHub API and applies
 * deterministic lifecycle-label transitions, exactly-one-risk-label PR
 * enrollment, native squash auto-merge enablement (only when already
 * enrolled via `agentic-automerge`), and exact-SHA dev-evidence-gated
 * issue closure. It never merges a PR itself and never bypasses reviews or
 * required checks.
 *
 * Fail-closed rule (mirrored from agentic-factory-policy.cjs): whenever a
 * claim, PR correlation, or state transition is missing, malformed,
 * ambiguous, or illegal, the result is `blocked` with an audit comment --
 * never a silent pass-through and never a forced/implicit transition.
 *
 * Every exported function below is either pure (parsers/classifiers/path
 * resolvers -- no `github` argument, safe to unit test directly) or an
 * async orchestration function that only calls the injected `github`
 * client. `reconcileFactoryLifecycle` isolates failures per issue: an API
 * error for one issue is warned (and the issue is fail-closed to `blocked`
 * when possible) without interrupting reconciliation of the others.
 */

const policy = require("./agentic-factory-policy.cjs");
const queueController = require("./agentic-queue-controller.cjs");
const queueRuntime = require("./agentic-queue-runtime.cjs");
const {
  AgenticIdentityError,
  actorNodeId,
  isConfiguredAssignmentActor,
  isGitHubActionsBot,
  isResolvedCopilotActor,
  normalizeConfiguredUserNodeId,
  resolveRepositoryCopilotIdentity,
} = require("./agentic-identity.cjs");

const { LIFECYCLE_STATES } = policy;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// The exact six post-queue lifecycle labels this reconciler processes.
// `factory:claimed` and `factory:implementing` progress toward an open PR;
// `factory:pr-open`/`factory:repairing` track the open PR; `factory:merged`
// and `factory:deployed-dev` track post-merge dev evidence.
const TARGET_LIFECYCLE_LABELS = Object.freeze([
  LIFECYCLE_STATES.CLAIMED,
  LIFECYCLE_STATES.IMPLEMENTING,
  LIFECYCLE_STATES.PR_OPEN,
  LIFECYCLE_STATES.REPAIRING,
  LIFECYCLE_STATES.MERGED,
  LIFECYCLE_STATES.DEPLOYED_DEV,
]);

// The full known lifecycle-label vocabulary, used to enforce "exactly one"
// lifecycle label semantics (agentic-factory-contract.md §5).
const LIFECYCLE_STATE_SET = new Set(policy.LIFECYCLE_STATE_VALUES);

// Matches the queue controller's persisted issue-comment claim marker
// exactly: `<!-- factory-claim:v1 { ...json... } -->`. The captured group is
// handed to `agentic-queue-controller.cjs`'s `parseClaimPayload`, which never
// throws and fails closed on any malformed shape.
const CLAIM_MARKER_PATTERN = /<!-- factory-claim:v1 (.+?) -->/s;
const ASSIGNMENT_MARKER_PATTERN =
  /<!-- factory-assignment:v1 (.+?) -->/s;
const MAX_CLAIM_LEASE_MS =
  queueRuntime.DEFAULT_LEASE_MINUTES * 60 * 1000;
const MAX_ASSIGNMENT_PAIR_SKEW_MS = 5 * 1000;

const PR_TITLE_PREFIX = "[ai-dev] ";

const AGENTIC_FACTORY_LABEL = "agentic-factory";
const AUTO_MERGE_LABEL = "agentic-automerge";
const NEEDS_AI_REVIEW_LABEL = "needs-ai-review";

const FACTORY_CONTROL_LABEL = "factory-control";
const ACTIVE_MODE_LABEL = "factory-mode:active";
const PAUSED_MODE_LABEL = "factory-mode:paused";

const SELF_HEAL_COMMIT_MARKER = "[self-heal]";

const DEV_EVIDENCE_STATUS_CONTEXT = "Dev deployment evidence";
const DEV_ENVIRONMENT = "development";
const DEV_EVIDENCE_TIMEOUT_MS = 6 * 60 * 60 * 1000;

const AUDIT_COMMENT_MARKER_PREFIX = "<!-- agentic-lifecycle-reconciler:v1 issue=";
const CONTROL_COMMENT_MARKER = "<!-- agentic-lifecycle-reconciler:v1 factory-control-pause -->";

class FactoryTrustSourceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "FactoryTrustSourceError";
    this.code = code;
  }
}

const ENABLE_AUTO_MERGE_MUTATION = `
  mutation EnableAgenticAutoMerge($pullRequestId: ID!) {
    enablePullRequestAutoMerge(
      input: { pullRequestId: $pullRequestId, mergeMethod: SQUASH }
    ) {
      pullRequest { number }
    }
  }
`;

// ---------------------------------------------------------------------------
// Small generic helpers
// ---------------------------------------------------------------------------

function getErrorStatus(error) {
  return error && typeof error === "object" ? error.status : undefined;
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function labelNames(entity) {
  const labels = entity && Array.isArray(entity.labels) ? entity.labels : [];
  return labels
    .map((label) => (typeof label === "string" ? label : label && label.name))
    .filter((name) => typeof name === "string" && name.length > 0);
}

function latestById(list) {
  return [...(Array.isArray(list) ? list : [])].sort(
    (left, right) => (right && right.id) - (left && left.id),
  )[0];
}

// ---------------------------------------------------------------------------
// Claim marker parsing (pure)
// ---------------------------------------------------------------------------

/**
 * Extracts the raw JSON payload text from a single comment body's claim
 * marker, or `null` if the marker is not present at all. Never throws.
 *
 * @param {unknown} body
 * @returns {string|null}
 */
function extractClaimMarkerPayload(body) {
  if (typeof body !== "string") {
    return null;
  }
  const match = CLAIM_MARKER_PATTERN.exec(body);
  return match ? match[1] : null;
}

function parseClaimNonce(nonce, issueNumber) {
  if (typeof nonce !== "string") {
    return null;
  }
  const match = /^(\d+):(\d+):(\d+)$/.exec(nonce);
  if (!match || Number(match[3]) !== issueNumber) {
    return null;
  }
  return {
    runId: match[1],
    runAttempt: match[2],
  };
}

function parseTrustedClaimEntry(entry, issueNumber, nowMs) {
  const parsed = queueController.parseClaimPayload(entry.payload);
  if (!parsed.valid) {
    return { valid: false, reason: `malformed-claim:${parsed.reason}` };
  }
  if (parsed.claim.issueNumber !== issueNumber) {
    return {
      valid: false,
      reason: "malformed-claim:issue-number-mismatch",
    };
  }

  const nonce = parseClaimNonce(parsed.claim.nonce, issueNumber);
  if (
    !nonce ||
    parsed.claim.owner !==
      `queue-controller:${nonce.runId}:${nonce.runAttempt}`
  ) {
    return {
      valid: false,
      reason: "malformed-claim:run-identity-mismatch",
    };
  }

  const createdAtMs = Date.parse(entry.comment.created_at || "");
  const expiresAtMs = Date.parse(parsed.claim.expiresAt || "");
  if (
    Number.isNaN(createdAtMs) ||
    Number.isNaN(expiresAtMs) ||
    createdAtMs >= expiresAtMs ||
    expiresAtMs - createdAtMs > MAX_CLAIM_LEASE_MS ||
    (Number.isFinite(nowMs) && createdAtMs > nowMs)
  ) {
    return {
      valid: false,
      reason: "malformed-claim:invalid-server-time-window",
    };
  }

  return {
    valid: true,
    claim: {
      ...parsed.claim,
      commentId: entry.comment.id,
      createdAt: new Date(createdAtMs).toISOString(),
    },
    createdAtMs,
    expiresAtMs,
  };
}

/**
 * Resolves the latest authoritative queue-controller claim. Marker comments
 * from any actor other than GitHub Actions are ignored and can never replace a
 * trusted claim. Trusted malformed or overlapping claims fail closed.
 */
function resolveLatestIssueClaim(comments, issueNumber, now) {
  const nowMs = Date.parse(now || "");
  const trustedEntries = (Array.isArray(comments) ? comments : [])
    .map((comment) => ({
      comment,
      payload: extractClaimMarkerPayload(comment && comment.body),
    }))
    .filter(
      (entry) =>
        entry.payload !== null && isGitHubActionsBot(entry.comment.user),
    )
    .sort(
      (left, right) =>
        Date.parse(left.comment.created_at || "") -
          Date.parse(right.comment.created_at || "") ||
        (left.comment.id || 0) - (right.comment.id || 0),
    );

  if (trustedEntries.length === 0) {
    return { state: "no-claim-comment", reason: "missing-trusted-claim" };
  }

  const parsedEntries = [];
  for (const entry of trustedEntries) {
    const parsed = parseTrustedClaimEntry(entry, issueNumber, nowMs);
    if (!parsed.valid) {
      return { state: "malformed", reason: parsed.reason };
    }
    parsedEntries.push(parsed);
  }

  for (let index = 1; index < parsedEntries.length; index += 1) {
    if (
      parsedEntries[index].createdAtMs <
      parsedEntries[index - 1].expiresAtMs
    ) {
      return {
        state: "malformed",
        reason: "malformed-claim:overlapping-trusted-claims",
      };
    }
  }

  return {
    state: "valid",
    claim: parsedEntries[parsedEntries.length - 1].claim,
  };
}

function currentAssigneeState({
  assignees,
  copilotIdentity,
  assignmentActorNodeId,
}) {
  const actors = Array.isArray(assignees) ? assignees : [];
  const copilot = actors.filter((actor) =>
    isResolvedCopilotActor(actor, copilotIdentity),
  );
  const assignmentActor = actors.filter((actor) =>
    isConfiguredAssignmentActor(actor, assignmentActorNodeId),
  );
  const expected = actors.filter(
    (actor) =>
      isResolvedCopilotActor(actor, copilotIdentity) ||
      isConfiguredAssignmentActor(actor, assignmentActorNodeId),
  );

  if (expected.length !== actors.length) {
    return { state: "invalid", reason: "unexpected-current-assignee" };
  }
  if (copilot.length > 1 || assignmentActor.length > 1) {
    return { state: "invalid", reason: "duplicate-current-assignee" };
  }
  if (actors.length === 0 || copilot.length === 0 || assignmentActor.length === 0) {
    return { state: "incomplete", reason: "assignment-pair-not-settled" };
  }
  if (actors.length !== 2) {
    return { state: "invalid", reason: "invalid-current-assignee-count" };
  }
  return { state: "valid" };
}

function assignmentMutationFingerprint(timeline) {
  return JSON.stringify(
    (Array.isArray(timeline) ? timeline : [])
      .filter(
        (event) =>
          event &&
          (event.event === "assigned" || event.event === "unassigned"),
      )
      .map((event) => ({
        id: event.id,
        event: event.event,
        createdAt: event.created_at,
        actorNodeId: actorNodeId(event.actor),
        assigneeNodeId: actorNodeId(event.assignee),
      }))
      .sort((left, right) =>
        String(left.id).localeCompare(String(right.id)),
      ),
  );
}

function classifyAssignmentEvidence({
  issue,
  timeline,
  claim,
  copilotIdentity,
  assignmentActorNodeId,
  now,
}) {
  const current = currentAssigneeState({
    assignees: issue && issue.assignees,
    copilotIdentity,
    assignmentActorNodeId,
  });
  if (current.state === "invalid") {
    return current;
  }

  const claimCreatedAtMs = Date.parse(claim.createdAt || "");
  const expiresAtMs = Date.parse(claim.expiresAt || "");
  const nowMs = Date.parse(now || "");
  if (
    Number.isNaN(claimCreatedAtMs) ||
    Number.isNaN(expiresAtMs) ||
    Number.isNaN(nowMs)
  ) {
    return { state: "invalid", reason: "invalid-assignment-time-context" };
  }

  const mutations = [];
  for (const event of Array.isArray(timeline) ? timeline : []) {
    if (
      !event ||
      (event.event !== "assigned" && event.event !== "unassigned")
    ) {
      continue;
    }
    const eventMs = Date.parse(event.created_at || "");
    if (Number.isNaN(eventMs)) {
      return {
        state: "invalid",
        reason: "assignment-event-timestamp-malformed",
      };
    }

    if (!Number.isInteger(event.id) && typeof event.id !== "string") {
      return { state: "invalid", reason: "assignment-event-id-malformed" };
    }
    if (eventMs <= claimCreatedAtMs) {
      continue;
    }
    mutations.push({ event, eventMs });
  }
  mutations.sort(
    (left, right) =>
      left.eventMs - right.eventMs ||
      String(left.event.id).localeCompare(String(right.event.id)),
  );

  const inWindow = mutations.filter(
    ({ eventMs }) => eventMs < expiresAtMs,
  );
  const expectedEvents = inWindow.filter(
    ({ event }) =>
      event.event === "assigned" &&
      isConfiguredAssignmentActor(event.actor, assignmentActorNodeId) &&
      (isResolvedCopilotActor(event.assignee, copilotIdentity) ||
        isConfiguredAssignmentActor(
          event.assignee,
          assignmentActorNodeId,
        )),
  );
  const unexpectedMutation = mutations.find(
    ({ event }) => !expectedEvents.some(({ event: expected }) => expected.id === event.id),
  );
  if (unexpectedMutation) {
    return { state: "invalid", reason: "assignment-mutated-after-claim" };
  }

  const botEvents = expectedEvents.filter(({ event }) =>
    isResolvedCopilotActor(event.assignee, copilotIdentity),
  );
  const userEvents = expectedEvents.filter(({ event }) =>
    isConfiguredAssignmentActor(event.assignee, assignmentActorNodeId),
  );
  if (botEvents.length > 1 || userEvents.length > 1) {
    return { state: "invalid", reason: "duplicate-assignment-event-pair" };
  }
  if (
    botEvents.length === 0 ||
    userEvents.length === 0 ||
    current.state === "incomplete"
  ) {
    return nowMs < expiresAtMs
      ? { state: "incomplete", reason: "assignment-evidence-pending" }
      : { state: "invalid", reason: "assignment-evidence-expired" };
  }
  if (
    Math.abs(botEvents[0].eventMs - userEvents[0].eventMs) >
    MAX_ASSIGNMENT_PAIR_SKEW_MS
  ) {
    return { state: "invalid", reason: "assignment-event-pair-skew" };
  }

  const pairEvents = [botEvents[0], userEvents[0]].sort(
    (left, right) =>
      left.eventMs - right.eventMs ||
      String(left.event.id).localeCompare(String(right.event.id)),
  );
  const pair = {
    assignedAt: new Date(pairEvents[0].eventMs).toISOString(),
    eventIds: pairEvents.map(({ event }) => event.id),
  };

  return {
    state: "valid",
    evidence: {
      nonce: claim.nonce,
      assignedAt: pair.assignedAt,
      eventIds: pair.eventIds,
      copilotNodeId: copilotIdentity.nodeId,
      assignmentActorNodeId,
    },
  };
}

function buildAssignmentMarker(evidence) {
  return `<!-- factory-assignment:v1 ${JSON.stringify(evidence)} -->`;
}

function assignmentAttestationEntries(comments, nonce) {
  return (Array.isArray(comments) ? comments : [])
    .map((comment) => {
      const match =
        typeof comment.body === "string"
          ? ASSIGNMENT_MARKER_PATTERN.exec(comment.body)
          : null;
      return match
        ? { comment, payload: match[1] }
        : null;
    })
    .filter(Boolean)
    .filter((entry) => isGitHubActionsBot(entry.comment.user))
    .map((entry) => {
      try {
        return { ...entry, evidence: JSON.parse(entry.payload) };
      } catch {
        return { ...entry, evidence: null };
      }
    })
    .filter((entry) => entry.evidence?.nonce === nonce);
}

function resolveAssignmentAttestation(comments, claim) {
  const entries = assignmentAttestationEntries(comments, claim.nonce);
  if (entries.length !== 1) {
    return { valid: false, reason: "assignment-attestation-not-unique" };
  }
  try {
    const evidence = entries[0].evidence;
    if (
      !evidence ||
      evidence.nonce !== claim.nonce ||
      !Array.isArray(evidence.eventIds) ||
      evidence.eventIds.length !== 2
    ) {
      return { valid: false, reason: "assignment-attestation-malformed" };
    }
    return { valid: true, evidence };
  } catch {
    return { valid: false, reason: "assignment-attestation-malformed" };
  }
}

// ---------------------------------------------------------------------------
// Risk label lookup (pure)
// ---------------------------------------------------------------------------

function getRiskLabels(issue) {
  const names = labelNames(issue);
  return names.filter((name) => policy.RISK_TIER_LABELS.includes(name));
}

/**
 * A correlated PR must end up with *exactly one* risk label -- the issue's.
 * If the PR already carries more than one risk label, or exactly one that
 * differs from the issue's, enrolling it would either leave conflicting
 * labels or silently overwrite an existing declaration. Both are treated as
 * a conservative block instead.
 *
 * @param {string[]} pullRequestRiskLabels
 * @param {string} issueRiskLabel
 * @returns {boolean}
 */
function hasConflictingPullRequestRiskLabel(pullRequestRiskLabels, issueRiskLabel) {
  return (
    pullRequestRiskLabels.length > 1 ||
    (pullRequestRiskLabels.length === 1 && pullRequestRiskLabels[0] !== issueRiskLabel)
  );
}

// ---------------------------------------------------------------------------
// Issue-form "### Heading" section extraction (pure)
// ---------------------------------------------------------------------------

/**
 * Extracts the value of a single `### <heading>` GitHub issue-form section
 * from a rendered issue body. Fails closed to `undefined` -- never a partial
 * or best-guess value -- when the body isn't a string, the heading doesn't
 * appear exactly once, or its value is empty/`_No response_`. Mirrors
 * `agentic-pr-reconciler.cjs`'s own `getIssueFormSection` exactly, since
 * both read the same issue-form convention.
 *
 * @param {unknown} body
 * @param {string} heading
 * @returns {string|undefined}
 */
function getIssueFormSection(body, heading) {
  if (typeof body !== "string") {
    return undefined;
  }
  const sections = body.split(/^###\s+/m).slice(1);
  const matches = [];
  for (const section of sections) {
    const newline = section.indexOf("\n");
    const name = (newline === -1 ? section : section.slice(0, newline)).trim();
    if (name === heading) {
      const value = (newline === -1 ? "" : section.slice(newline + 1)).trim();
      matches.push(value && value !== "_No response_" ? value : undefined);
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

// ---------------------------------------------------------------------------
// PR correlation (pure)
// ---------------------------------------------------------------------------

function buildClaimNonceMarker(nonce) {
  return `<!-- factory-claim:${nonce} -->`;
}

function buildRefsMarker(issueNumber) {
  return `Refs #${issueNumber}`;
}

/**
 * A PR is a *candidate* for an issue purely by exact-substring presence of
 * both the claim-nonce marker and the `Refs #<issue>` marker in its body --
 * regardless of whether it is otherwise well-formed. Candidacy is evaluated
 * separately from validity so that a same-nonce PR that fails one of the
 * other checks (fork head, title, author, base) is still counted toward the
 * "more than one/any malformed candidate" fail-closed rule instead of being
 * silently ignored.
 *
 * @param {object} pullRequest
 * @param {number} issueNumber
 * @param {string} nonce
 * @returns {boolean}
 */
function isCandidatePullRequest(pullRequest, issueNumber, nonce) {
  const body = typeof pullRequest.body === "string" ? pullRequest.body : "";
  return (
    body.includes(buildClaimNonceMarker(nonce)) &&
    body.includes(buildRefsMarker(issueNumber))
  );
}

/**
 * A candidate is *valid* only when every conservative correlation
 * requirement holds: same-repository head, `[ai-dev] ` title prefix, an
 * author matching the resolved canonical Copilot actor identity, and a base
 * ref matching the exact repository default branch. Title/author alone are
 * never sufficient, and the author is matched by stable actor identity
 * rather than by presentation login.
 *
 * @param {object} pullRequest
 * @param {string} repository
 * @param {string} defaultBranch
 * @returns {boolean}
 */
function isValidCandidatePullRequest(
  pullRequest,
  repository,
  defaultBranch,
  copilotIdentity,
) {
  const sameRepositoryHead = Boolean(
    pullRequest.head &&
      pullRequest.head.repo &&
      typeof pullRequest.head.repo.full_name === "string" &&
      pullRequest.head.repo.full_name === repository,
  );
  const titleOk =
    typeof pullRequest.title === "string" &&
    pullRequest.title.startsWith(PR_TITLE_PREFIX);
  const authorOk = isResolvedCopilotActor(
    pullRequest.user,
    copilotIdentity,
  );
  const baseOk = Boolean(
    pullRequest.base &&
      typeof pullRequest.base.ref === "string" &&
      pullRequest.base.ref === defaultBranch,
  );

  return sameRepositoryHead && titleOk && authorOk && baseOk;
}

/**
 * Conservatively correlates a candidate list of same-repo PRs to a claimed
 * issue. Returns every raw candidate plus its valid/malformed partition.
 *
 * @param {{pullRequests: object[], issueNumber: number, nonce: string, repository: string, defaultBranch: string}} input
 * @returns {{candidates: object[], valid: object[], malformed: object[]}}
 */
function correlatePullRequests({
  pullRequests,
  issueNumber,
  nonce,
  repository,
  defaultBranch,
  copilotIdentity,
}) {
  const candidates = (Array.isArray(pullRequests) ? pullRequests : []).filter(
    (pullRequest) => isCandidatePullRequest(pullRequest, issueNumber, nonce),
  );
  const valid = candidates.filter((pullRequest) =>
    isValidCandidatePullRequest(
      pullRequest,
      repository,
      defaultBranch,
      copilotIdentity,
    ),
  );
  const malformed = candidates.filter(
    (pullRequest) =>
      !isValidCandidatePullRequest(
        pullRequest,
        repository,
        defaultBranch,
        copilotIdentity,
      ),
  );

  return { candidates, valid, malformed };
}

// ---------------------------------------------------------------------------
// Self-heal / repair detection (pure)
// ---------------------------------------------------------------------------

function hasTrustedSelfHealCommit(commits, copilotIdentity) {
  return (Array.isArray(commits) ? commits : []).some(
    (commit) =>
      commit &&
      commit.author &&
      (isGitHubActionsBot(commit.author) ||
        isResolvedCopilotActor(commit.author, copilotIdentity)) &&
      commit.commit &&
      typeof commit.commit.message === "string" &&
      commit.commit.message.includes(SELF_HEAL_COMMIT_MARKER),
  );
}

function hasPendingCheckRuns(checkRuns) {
  return (Array.isArray(checkRuns) ? checkRuns : []).some(
    (check) => check && check.status !== "completed",
  );
}

/**
 * Determines the lifecycle state an *open* correlated PR implies: still
 * under active, incomplete self-heal (`factory:repairing`) or otherwise
 * open and current (`factory:pr-open`). Merged/closed PRs are handled by
 * the caller before this is consulted.
 *
 * @param {{hasPendingSelfHeal: boolean}} input
 * @returns {string}
 */
function determineOpenPullRequestState({ hasPendingSelfHeal }) {
  return hasPendingSelfHeal
    ? LIFECYCLE_STATES.REPAIRING
    : LIFECYCLE_STATES.PR_OPEN;
}

// ---------------------------------------------------------------------------
// Lifecycle transition legality (pure)
// ---------------------------------------------------------------------------

/**
 * Resolves whether a lifecycle transition is legal, composing the one
 * documented multi-hop case that collapses into a single label write:
 * `factory:repairing -> factory:merged` (via `factory:pr-open`, both hops
 * legal). `factory:merged -> factory:done` is deliberately NOT composited
 * here: verified dev evidence only ever authorizes `factory:merged ->
 * factory:deployed-dev` in the run it is verified (a direct, single-hop
 * legal transition); `factory:deployed-dev -> factory:done` (plus issue
 * closure) always happens in a separate, later reconciliation pass. Every
 * hop is validated through `agentic-factory-policy.cjs`'s
 * `applyLifecycleTransition` -- nothing here bypasses or reimplements the
 * policy's legality table.
 *
 * @param {string} from
 * @param {string} to
 * @returns {{allowed: boolean, path: string[]}}
 */
function resolveLifecycleTransitionPath(from, to) {
  const direct = policy.applyLifecycleTransition({ from, to });
  if (direct.allowed) {
    return { allowed: true, path: [from, to] };
  }

  if (from === LIFECYCLE_STATES.REPAIRING && to === LIFECYCLE_STATES.MERGED) {
    const first = policy.applyLifecycleTransition({
      from: LIFECYCLE_STATES.REPAIRING,
      to: LIFECYCLE_STATES.PR_OPEN,
    });
    const second = policy.applyLifecycleTransition({
      from: LIFECYCLE_STATES.PR_OPEN,
      to: LIFECYCLE_STATES.MERGED,
    });
    if (first.allowed && second.allowed) {
      return {
        allowed: true,
        path: [LIFECYCLE_STATES.REPAIRING, LIFECYCLE_STATES.PR_OPEN, LIFECYCLE_STATES.MERGED],
      };
    }
  }

  return { allowed: false, path: [] };
}

// ---------------------------------------------------------------------------
// Exactly-one lifecycle label computation (pure)
// ---------------------------------------------------------------------------

/**
 * Computes the deterministic label add/remove set that enforces "exactly
 * one lifecycle label:" every other known lifecycle label is removed and
 * the target is added (unless already present).
 *
 * @param {string[]} currentLabelNames
 * @param {string} target
 * @returns {{toRemove: string[], toAdd: string[]}}
 */
function computeLifecycleLabelChange(currentLabelNames, target) {
  const names = Array.isArray(currentLabelNames) ? currentLabelNames : [];
  const toRemove = names.filter(
    (name) => LIFECYCLE_STATE_SET.has(name) && name !== target,
  );
  const toAdd = names.includes(target) ? [] : [target];
  return { toRemove, toAdd };
}

// ---------------------------------------------------------------------------
// Dev evidence evaluation (pure)
// ---------------------------------------------------------------------------

function evaluateCommitStatusOutcome(statuses, context) {
  const relevant = (Array.isArray(statuses) ? statuses : []).filter(
    (status) => status && status.context === context,
  );
  const latest = latestById(relevant);
  if (!latest) {
    return "pending";
  }
  if (latest.state === "success") {
    return "success";
  }
  if (latest.state === "failure" || latest.state === "error") {
    return "failure";
  }
  return "pending";
}

function evaluateDeploymentOutcome(deployments, deploymentStatusesByDeployment) {
  const allStatuses = (Array.isArray(deployments) ? deployments : []).flatMap(
    (deployment) =>
      (deploymentStatusesByDeployment && deploymentStatusesByDeployment[deployment.id]) || [],
  );
  const latest = latestById(allStatuses);
  if (!latest) {
    return "pending";
  }
  if (latest.state === "success") {
    return "success";
  }
  if (latest.state === "failure" || latest.state === "error") {
    return "failure";
  }
  return "pending";
}

/**
 * Combines the exact-SHA `Dev deployment evidence` commit status and the
 * exact-SHA `development` GitHub Deployment into one fail-closed outcome:
 * `"success"` only when both are success; `"failure"` when either reports
 * failure/error; `"pending"` for anything missing or still in flight.
 *
 * @param {{statuses: object[], deployments: object[], deploymentStatusesByDeployment: Record<number, object[]>}} input
 * @returns {"success"|"failure"|"pending"}
 */
function evaluateDevEvidence({ statuses, deployments, deploymentStatusesByDeployment }) {
  const statusOutcome = evaluateCommitStatusOutcome(statuses, DEV_EVIDENCE_STATUS_CONTEXT);
  const deploymentOutcome = evaluateDeploymentOutcome(deployments, deploymentStatusesByDeployment);

  if (statusOutcome === "failure" || deploymentOutcome === "failure") {
    return "failure";
  }
  if (statusOutcome === "success" && deploymentOutcome === "success") {
    return "success";
  }
  return "pending";
}

// ---------------------------------------------------------------------------
// Audit comment (pure body/marker construction; async I/O wrapper below)
// ---------------------------------------------------------------------------

function buildAuditCommentMarker(issueNumber) {
  return `${AUDIT_COMMENT_MARKER_PREFIX}${issueNumber} -->`;
}

function findManagedAuditComment(comments, issueNumber) {
  const marker = buildAuditCommentMarker(issueNumber);
  return (Array.isArray(comments) ? comments : []).find(
    (comment) => typeof comment.body === "string" && comment.body.includes(marker),
  );
}

/**
 * Builds the concise, stable-marker audit comment body for a single
 * mutation: claim nonce, issue, PR, head/merge SHA, transition, and URLs.
 *
 * @param {object} fields
 * @returns {string}
 */
function buildAuditCommentBody({
  issueNumber,
  nonce,
  transition,
  reason,
  prNumber,
  prUrl,
  headSha,
  mergeSha,
  candidatePulls,
}) {
  const lines = [
    buildAuditCommentMarker(issueNumber),
    "**Agentic lifecycle reconciler audit**",
    `- Issue: #${issueNumber}`,
    `- Claim nonce: ${nonce ? `\`${nonce}\`` : "unknown"}`,
    `- Transition: \`${transition}\``,
  ];
  if (reason) {
    lines.push(`- Reason: \`${reason}\``);
  }
  if (Number.isInteger(prNumber)) {
    lines.push(`- Pull request: #${prNumber}${prUrl ? ` (${prUrl})` : ""}`);
  }
  if (headSha) {
    lines.push(`- Head SHA: \`${headSha}\``);
  }
  if (mergeSha) {
    lines.push(`- Merge SHA: \`${mergeSha}\``);
  }
  if (Array.isArray(candidatePulls) && candidatePulls.length > 0) {
    lines.push(`- Candidate pull requests: ${candidatePulls.map((number) => `#${number}`).join(", ")}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// GitHub-calling helpers
// ---------------------------------------------------------------------------

async function safeRemoveLabel({ github, owner, repo, issueNumber, name }) {
  try {
    await github.rest.issues.removeLabel({
      owner,
      repo,
      issue_number: issueNumber,
      name,
    });
  } catch (error) {
    if (getErrorStatus(error) === 404) {
      return;
    }
    throw error;
  }
}

/**
 * Deterministically enforces "exactly one lifecycle label": removes every
 * other known lifecycle label present and adds the target if missing.
 */
async function replaceLifecycleLabel({ github, owner, repo, issueNumber, currentLabelNames, target }) {
  const { toRemove, toAdd } = computeLifecycleLabelChange(currentLabelNames, target);
  for (const name of toRemove) {
    await safeRemoveLabel({ github, owner, repo, issueNumber, name });
  }
  if (toAdd.length > 0) {
    await github.rest.issues.addLabels({
      owner,
      repo,
      issue_number: issueNumber,
      labels: toAdd,
    });
  }
}

async function upsertAuditComment({ github, owner, repo, issue, comments, body }) {
  const existing = findManagedAuditComment(comments, issue.number);
  if (existing) {
    await github.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body,
    });
    return;
  }
  await github.rest.issues.createComment({
    owner,
    repo,
    issue_number: issue.number,
    body,
  });
}

async function ensureAssignmentAttestation({
  github,
  owner,
  repo,
  issueNumber,
  comments,
  evidence,
}) {
  const entries = assignmentAttestationEntries(comments, evidence.nonce);
  if (entries.length > 0) {
    if (
      entries.length === 1 &&
      JSON.stringify(entries[0].evidence) === JSON.stringify(evidence)
    ) {
      return { valid: true, created: false };
    }
    return { valid: false, reason: "assignment-attestation-conflict" };
  }
  await github.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body: [
      buildAssignmentMarker(evidence),
      "**Factory assignment provenance accepted**",
      `- Claim nonce: \`${evidence.nonce}\``,
      `- Assigned at: \`${evidence.assignedAt}\``,
      `- Assignment event IDs: ${evidence.eventIds
        .map((id) => `\`${id}\``)
        .join(", ")}`,
    ].join("\n"),
  });
  return { valid: true, created: true };
}

/**
 * Raw mutation: sets the issue's lifecycle label to `to` (no legality
 * check -- see `transitionOrBlock` for the validated entry point) and
 * writes/updates the stable-marker audit comment.
 */
async function recordTransition({ github, owner, repo, issue, comments, from, to, reason, ...evidence }) {
  await replaceLifecycleLabel({
    github,
    owner,
    repo,
    issueNumber: issue.number,
    currentLabelNames: labelNames(issue),
    target: to,
  });
  const body = buildAuditCommentBody({
    issueNumber: issue.number,
    transition: `${from} -> ${to}`,
    reason,
    ...evidence,
  });
  await upsertAuditComment({ github, owner, repo, issue, comments, body });
}

/**
 * Validated transition entry point: resolves legality via
 * `resolveLifecycleTransitionPath` first. An illegal transition never
 * applies the requested label -- it fails closed to `blocked` with an
 * `illegal-transition:<from>-><to>` reason instead.
 */
async function transitionOrBlock({ github, owner, repo, issue, comments, from, to, reason, ...evidence }) {
  const resolution = resolveLifecycleTransitionPath(from, to);
  if (!resolution.allowed) {
    await recordTransition({
      github,
      owner,
      repo,
      issue,
      comments,
      from,
      to: LIFECYCLE_STATES.BLOCKED,
      reason: `illegal-transition:${from}->${to}`,
      ...evidence,
    });
    return { allowed: false };
  }

  await recordTransition({ github, owner, repo, issue, comments, from, to, reason, ...evidence });
  return { allowed: true };
}

function blockIssue({ github, owner, repo, issue, comments, from, reason, ...evidence }) {
  return transitionOrBlock({
    github,
    owner,
    repo,
    issue,
    comments,
    from,
    to: LIFECYCLE_STATES.BLOCKED,
    reason,
    ...evidence,
  });
}

/**
 * Validates that a correlated, still-open PR's exact changed-file scope
 * (both current and previous/renamed-from filenames) stays entirely within
 * the issue's own `### Allowed paths` section -- an exact repo-relative
 * file, or a terminal `path/**` glob, per file/pattern; nothing fuzzier.
 * This is a hard provenance/scope invariant (not an ordinary risk/label
 * check): a missing/invalid `Allowed paths` section, or any changed
 * (including renamed-from) file outside it, MUST block enrollment/auto-merge
 * rather than silently trusting the PR's own diff.
 *
 * @returns {{ok: boolean, reason?: string}}
 */
async function validateAllowedPathsScope({ github, owner, repo, issue, pullRequest }) {
  const allowedPathsSection = getIssueFormSection(issue.body, "Allowed paths");
  const normalized = policy.normalizeAllowedPathPatterns(allowedPathsSection);
  if (!normalized.valid) {
    return { ok: false, reason: `invalid-allowed-paths:${normalized.reason}` };
  }

  const files = await github.paginate(github.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pullRequest.number,
    per_page: 100,
  });

  if (!policy.areChangedFilesWithinAllowedPaths(files, normalized.patterns)) {
    return { ok: false, reason: "changed-files-outside-allowed-paths" };
  }

  return { ok: true };
}

/**
 * Adds any missing labels to the PR and returns an updated PR object with
 * those labels merged in-memory, so that the same reconciliation pass sees
 * the PR as enrolled (e.g. for an immediate `ensureAutoMergeEnabled` check)
 * without needing to re-fetch it.
 */
async function ensurePullRequestLabels({ github, owner, repo, pullRequest, labels }) {
  const present = new Set(labelNames(pullRequest));
  const missing = labels.filter((label) => !present.has(label));
  if (missing.length === 0) {
    return pullRequest;
  }
  await github.rest.issues.addLabels({
    owner,
    repo,
    issue_number: pullRequest.number,
    labels: missing,
  });
  return {
    ...pullRequest,
    labels: [...(pullRequest.labels || []), ...missing.map((name) => ({ name }))],
  };
}

async function blockPullRequestCandidates({ github, owner, repo, candidates }) {
  for (const pullRequest of candidates) {
    const present = new Set(labelNames(pullRequest));
    if (present.has(LIFECYCLE_STATES.BLOCKED)) {
      continue;
    }
    await github.rest.issues.addLabels({
      owner,
      repo,
      issue_number: pullRequest.number,
      labels: [LIFECYCLE_STATES.BLOCKED],
    });
  }
}

// GitHub's `enablePullRequestAutoMerge` mutation can reject a request while
// the head commit's status/check state has not settled yet (mergeable_state
// still resolving). These are transient, retryable conditions -- not policy
// violations -- so they must never fail-close the issue; the next scheduled
// reconciler pass simply retries.
const RETRYABLE_AUTO_MERGE_ERROR_SUBSTRINGS = Object.freeze([
  "clean status",
  "unstable status",
  "pending status",
]);

function isRetryableAutoMergeStateError(error) {
  const message = getErrorMessage(error);
  return RETRYABLE_AUTO_MERGE_ERROR_SUBSTRINGS.some((substring) => message.includes(substring));
}

/**
 * Enables native squash auto-merge for a verified, non-draft, open,
 * `agentic-automerge`-enrolled PR via GraphQL. Idempotent: a PR that is
 * already merged, closed, draft, not enrolled, or already has auto-merge
 * enabled is left untouched. Never bypasses branch protection/required
 * reviews -- those still gate the native auto-merge itself.
 *
 * A known clean/unstable/pending mergeable-state error from GitHub (the
 * head's status has not settled yet) is treated as a retryable no-op: it is
 * logged and swallowed so the next reconciler pass retries, rather than
 * fail-closing the issue to `blocked` over a transient condition. Any other,
 * unexpected error is rethrown so the caller's per-issue isolation applies.
 */
async function ensureAutoMergeEnabled({ github, core, pullRequest }) {
  if (!pullRequest || pullRequest.draft || pullRequest.merged_at || pullRequest.state === "closed") {
    return;
  }
  if (!labelNames(pullRequest).includes(AUTO_MERGE_LABEL)) {
    return;
  }
  if (pullRequest.auto_merge) {
    return;
  }
  if (typeof pullRequest.node_id !== "string" || pullRequest.node_id === "") {
    return;
  }

  try {
    await github.graphql(ENABLE_AUTO_MERGE_MUTATION, {
      pullRequestId: pullRequest.node_id,
    });
  } catch (error) {
    if (isRetryableAutoMergeStateError(error)) {
      core.info(
        `Pull request #${pullRequest.number}'s head status has not settled yet; the next reconciler pass will retry enabling auto-merge.`,
      );
      return;
    }
    throw error;
  }
}

async function closeIssueAsCompleted({ github, owner, repo, issue }) {
  await github.rest.issues.update({
    owner,
    repo,
    issue_number: issue.number,
    state: "closed",
    state_reason: "completed",
  });
}

/**
 * Pauses the singleton `factory-control` issue from `active`/`shadow` to
 * `factory-mode:paused`. Idempotent and one-directional: automation never
 * unpauses, and re-detecting the same trigger against an already-paused
 * control issue is a no-op (no duplicate label churn or comment).
 */
async function pauseFactoryControl({ github, core, owner, repo, reason }) {
  const controlIssues = await github.paginate(github.rest.issues.listForRepo, {
    owner,
    repo,
    state: "open",
    labels: FACTORY_CONTROL_LABEL,
    per_page: 100,
  });

  if (controlIssues.length !== 1) {
    core.warning(
      `Expected exactly one open factory-control issue to pause; found ${controlIssues.length}.`,
    );
    return;
  }

  const controlIssue = controlIssues[0];
  const mode = policy.resolveFactoryModeFromLabels(controlIssue.labels);
  if (mode !== policy.FACTORY_MODES.ACTIVE && mode !== policy.FACTORY_MODES.SHADOW) {
    // Already paused (or unresolvable, which is already fail-closed to
    // paused): automation never unpauses and never re-applies the pause.
    return;
  }

  const currentNames = labelNames(controlIssue);
  const modeLabelsToRemove = currentNames.filter((name) =>
    Object.hasOwn(policy.FACTORY_MODE_LABELS, name),
  );
  for (const name of modeLabelsToRemove) {
    await safeRemoveLabel({ github, owner, repo, issueNumber: controlIssue.number, name });
  }
  await github.rest.issues.addLabels({
    owner,
    repo,
    issue_number: controlIssue.number,
    labels: [PAUSED_MODE_LABEL],
  });

  await github.rest.issues.createComment({
    owner,
    repo,
    issue_number: controlIssue.number,
    body: [
      CONTROL_COMMENT_MARKER,
      "**Factory paused by lifecycle reconciler**",
      `- Reason: ${reason}`,
      "- Automation cannot unpause; a human-operator must restore `factory-mode:active`.",
    ].join("\n"),
  });
}

// ---------------------------------------------------------------------------
// Per-issue reconciliation
// ---------------------------------------------------------------------------

/**
 * Handles an issue currently at `factory:claimed`.
 *
 * - No assignee, claim still within its lease window: unchanged (no silent
 *   renew/requeue either way -- the lease's own `expiresAt` is the only
 *   authority).
 * - No assignee, claim's `expiresAt` is at/past `now` (a stale lease that
 *   was never picked up by an assignment-worker): this is a queue/lease
 *   integrity failure, not an ordinary item outcome, so it fails closed to
 *   `blocked` with a dedicated audit reason and best-effort pauses the
 *   factory, same severity as the other provenance-corruption triggers.
 * - Assigned to a documented Copilot login: advances to
 *   `factory:implementing`. Once assigned/implementing, work may continue
 *   even after the original claim's `expiresAt` has passed -- staleness
 *   only matters while the claim is still unassigned.
 * - Assigned to anything else: blocks as an unknown assignee (unchanged).
 */
async function handleClaimedState({
  github,
  core,
  owner,
  repo,
  issue,
  comments,
  claim,
  currentState,
  now,
  copilotIdentity,
  assignmentActorNodeId,
}) {
  let timeline;
  try {
    timeline = await github.paginate(
      github.rest.issues.listEventsForTimeline,
      {
        owner,
        repo,
        issue_number: issue.number,
        per_page: 100,
      },
    );
  } catch (error) {
    throw new FactoryTrustSourceError(
      "assignment-timeline-unavailable",
      `Could not read assignment timeline for issue #${issue.number}: ${getErrorMessage(error)}`,
    );
  }

  const result = classifyAssignmentEvidence({
    issue,
    timeline,
    claim,
    copilotIdentity,
    assignmentActorNodeId,
    now,
  });
  if (result.state === "incomplete") {
    return;
  }
  if (result.state === "invalid") {
    await blockIssue({
      github,
      owner,
      repo,
      issue,
      comments,
      from: currentState,
      reason: result.reason,
      nonce: claim.nonce,
    });
    await pauseFactoryControl({
      github,
      core,
      owner,
      repo,
      reason: `Issue #${issue.number} has invalid Copilot assignment provenance (${result.reason}).`,
    });
    return;
  }

  let firstIssueRead;
  let finalTimeline;
  let finalIssueRead;
  let lastTimeline;
  try {
    firstIssueRead = (
      await github.rest.issues.get({
        owner,
        repo,
        issue_number: issue.number,
      })
    ).data;
    finalTimeline = await github.paginate(
      github.rest.issues.listEventsForTimeline,
      {
        owner,
        repo,
        issue_number: issue.number,
        per_page: 100,
      },
    );
    finalIssueRead = (
      await github.rest.issues.get({
        owner,
        repo,
        issue_number: issue.number,
      })
    ).data;
    lastTimeline = await github.paginate(
      github.rest.issues.listEventsForTimeline,
      {
        owner,
        repo,
        issue_number: issue.number,
        per_page: 100,
      },
    );
  } catch (error) {
    throw new FactoryTrustSourceError(
      "assignment-final-reread-failed",
      `Could not complete the final assignment reread for issue #${issue.number}: ${getErrorMessage(error)}`,
    );
  }
  const firstAssignees = currentAssigneeState({
    assignees: firstIssueRead.assignees,
    copilotIdentity,
    assignmentActorNodeId,
  });
  const finalResult = classifyAssignmentEvidence({
    issue: finalIssueRead,
    timeline: lastTimeline,
    claim,
    copilotIdentity,
    assignmentActorNodeId,
    now,
  });
  if (
    firstAssignees.state !== "valid" ||
    assignmentMutationFingerprint(finalTimeline) !==
      assignmentMutationFingerprint(lastTimeline) ||
    finalResult.state !== "valid" ||
    JSON.stringify(finalResult.evidence) !==
      JSON.stringify(result.evidence)
  ) {
    await blockIssue({
      github,
      owner,
      repo,
      issue,
      comments,
      from: currentState,
      reason: "assignment-changed-before-transition",
      nonce: claim.nonce,
    });
    await pauseFactoryControl({
      github,
      core,
      owner,
      repo,
      reason: `Issue #${issue.number}'s assignees changed before the lifecycle transition.`,
    });
    return;
  }

  const attestation = await ensureAssignmentAttestation({
    github,
    owner,
    repo,
    issueNumber: issue.number,
    comments,
    evidence: finalResult.evidence,
  });
  if (!attestation.valid) {
    await blockIssue({
      github,
      owner,
      repo,
      issue,
      comments,
      from: currentState,
      reason: attestation.reason,
      nonce: claim.nonce,
    });
    await pauseFactoryControl({
      github,
      core,
      owner,
      repo,
      reason: `Issue #${issue.number} has conflicting assignment attestations.`,
    });
    return;
  }
  await transitionOrBlock({
    github,
    owner,
    repo,
    issue,
    comments,
    from: currentState,
    to: LIFECYCLE_STATES.IMPLEMENTING,
    reason: "copilot-assignment-provenance-verified",
    nonce: claim.nonce,
  });
}

async function verifyPersistedAssignmentProvenance({
  github,
  owner,
  repo,
  issue,
  comments,
  claim,
  now,
  copilotIdentity,
  assignmentActorNodeId,
}) {
  const attestation = resolveAssignmentAttestation(comments, claim);
  if (!attestation.valid) {
    return attestation;
  }

  let timeline;
  let firstIssueRead;
  let finalIssueRead;
  let finalTimeline;
  try {
    firstIssueRead = (
      await github.rest.issues.get({
        owner,
        repo,
        issue_number: issue.number,
      })
    ).data;
    timeline = await github.paginate(
      github.rest.issues.listEventsForTimeline,
      {
        owner,
        repo,
        issue_number: issue.number,
        per_page: 100,
      },
    );
    finalIssueRead = (
      await github.rest.issues.get({
        owner,
        repo,
        issue_number: issue.number,
      })
    ).data;
    finalTimeline = await github.paginate(
      github.rest.issues.listEventsForTimeline,
      {
        owner,
        repo,
        issue_number: issue.number,
        per_page: 100,
      },
    );
  } catch (error) {
    throw new FactoryTrustSourceError(
      "assignment-provenance-reread-failed",
      `Could not revalidate assignment provenance for issue #${issue.number}: ${getErrorMessage(error)}`,
    );
  }

  const firstAssignees = currentAssigneeState({
    assignees: firstIssueRead.assignees,
    copilotIdentity,
    assignmentActorNodeId,
  });
  const current = classifyAssignmentEvidence({
    issue: finalIssueRead,
    timeline: finalTimeline,
    claim,
    copilotIdentity,
    assignmentActorNodeId,
    now,
  });
  if (
    firstAssignees.state !== "valid" ||
    assignmentMutationFingerprint(timeline) !==
      assignmentMutationFingerprint(finalTimeline) ||
    current.state !== "valid"
  ) {
    return {
      valid: false,
      reason: current.reason || "assignment-provenance-invalid",
    };
  }
  const accepted = attestation.evidence;
  const observed = current.evidence;
  if (
    accepted.copilotNodeId !== observed.copilotNodeId ||
    accepted.assignmentActorNodeId !== observed.assignmentActorNodeId ||
    accepted.assignedAt !== observed.assignedAt ||
    JSON.stringify(accepted.eventIds) !== JSON.stringify(observed.eventIds)
  ) {
    return { valid: false, reason: "assignment-attestation-drift" };
  }
  return { valid: true };
}

async function handleMergedEvidence({
  github,
  core,
  owner,
  repo,
  issue,
  comments,
  claim,
  pullRequest,
  now,
}) {
  const sha = pullRequest.merge_commit_sha;
  if (typeof sha !== "string" || sha.trim() === "") {
    await blockIssue({
      github,
      owner,
      repo,
      issue,
      comments,
      from: LIFECYCLE_STATES.MERGED,
      reason: "missing-merge-commit-sha",
      nonce: claim.nonce,
      prNumber: pullRequest.number,
      prUrl: pullRequest.html_url,
    });
    return;
  }

  const [statuses, deployments] = await Promise.all([
    github.paginate(github.rest.repos.listCommitStatusesForRef, {
      owner,
      repo,
      ref: sha,
      per_page: 100,
    }),
    github.paginate(github.rest.repos.listDeployments, {
      owner,
      repo,
      sha,
      environment: DEV_ENVIRONMENT,
      per_page: 100,
    }),
  ]);

  const deploymentStatusesByDeployment = {};
  for (const deployment of deployments) {
    deploymentStatusesByDeployment[deployment.id] = await github.paginate(
      github.rest.repos.listDeploymentStatuses,
      { owner, repo, deployment_id: deployment.id, per_page: 100 },
    );
  }

  const outcome = evaluateDevEvidence({ statuses, deployments, deploymentStatusesByDeployment });

  if (outcome === "pending") {
    const mergedAt = Date.parse(pullRequest.merged_at || "");
    const currentTime = Date.parse(now || "");
    if (
      Number.isNaN(mergedAt) ||
      Number.isNaN(currentTime) ||
      currentTime - mergedAt >= DEV_EVIDENCE_TIMEOUT_MS
    ) {
      await blockIssue({
        github,
        owner,
        repo,
        issue,
        comments,
        from: LIFECYCLE_STATES.MERGED,
        reason: "dev-evidence-timeout",
        nonce: claim.nonce,
        prNumber: pullRequest.number,
        prUrl: pullRequest.html_url,
        mergeSha: sha,
      });
      await pauseFactoryControl({
        github,
        core,
        owner,
        repo,
        reason: `Dev deployment evidence timed out for issue #${issue.number} at SHA ${sha}.`,
      });
    }
    return;
  }

  if (outcome === "failure") {
    await blockIssue({
      github,
      owner,
      repo,
      issue,
      comments,
      from: LIFECYCLE_STATES.MERGED,
      reason: "dev-evidence-failed",
      nonce: claim.nonce,
      prNumber: pullRequest.number,
      prUrl: pullRequest.html_url,
      mergeSha: sha,
    });
    await pauseFactoryControl({
      github,
      core,
      owner,
      repo,
      reason: `Dev deployment evidence failed for issue #${issue.number} at SHA ${sha}.`,
    });
    return;
  }

  // Verified dev evidence authorizes exactly one hop this run:
  // `factory:merged -> factory:deployed-dev`. The issue is deliberately NOT
  // closed here and does NOT advance to `factory:done` in the same pass --
  // that always happens on a later, separate reconciliation pass (see
  // `handleDeployedDevState`), so evidence verification and issue closure
  // are never collapsed into a single step.
  await transitionOrBlock({
    github,
    owner,
    repo,
    issue,
    comments,
    from: LIFECYCLE_STATES.MERGED,
    to: LIFECYCLE_STATES.DEPLOYED_DEV,
    reason: "dev-evidence-verified",
    nonce: claim.nonce,
    prNumber: pullRequest.number,
    prUrl: pullRequest.html_url,
    mergeSha: sha,
  });
}

async function handlePullRequestState({
  github,
  core,
  owner,
  repo,
  repository,
  defaultBranch,
  issue,
  comments,
  claim,
  currentState,
  now,
  copilotIdentity,
}) {
  const pullRequests = await github.paginate(github.rest.pulls.list, {
    owner,
    repo,
    state: "all",
    per_page: 100,
  });

  const { candidates, valid, malformed } = correlatePullRequests({
    pullRequests,
    issueNumber: issue.number,
    nonce: claim.nonce,
    repository,
    defaultBranch,
    copilotIdentity,
  });

  if (candidates.length === 0) {
    if (currentState === LIFECYCLE_STATES.IMPLEMENTING) {
      // Zero candidates while implementing simply stays -- the agent has
      // not opened its PR yet.
      return;
    }
    await blockIssue({
      github,
      owner,
      repo,
      issue,
      comments,
      from: currentState,
      reason: "correlated-pull-request-missing",
      nonce: claim.nonce,
    });
    return;
  }

  if (candidates.length > 1 || malformed.length > 0) {
    // A duplicate or provenance-malformed PR candidate is the exactly-one-PR
    // invariant (contract §10) being violated -- queue/provenance
    // corruption, not an ordinary per-issue failure -- so this both blocks
    // the issue/candidates AND best-effort pauses the factory (§15's
    // explicit duplicate-PR pause trigger).
    await blockPullRequestCandidates({ github, owner, repo, candidates });
    const corruptionReason =
      candidates.length > 1 ? "duplicate-pull-request-candidates" : "malformed-pull-request-candidate";
    await blockIssue({
      github,
      owner,
      repo,
      issue,
      comments,
      from: currentState,
      reason: corruptionReason,
      nonce: claim.nonce,
      candidatePulls: candidates.map((pullRequest) => pullRequest.number),
    });
    await pauseFactoryControl({
      github,
      core,
      owner,
      repo,
      reason: `Issue #${issue.number} correlated to ${corruptionReason === "duplicate-pull-request-candidates" ? "more than one pull request candidate" : "a provenance-malformed pull request candidate"} (${candidates.map((pullRequest) => `#${pullRequest.number}`).join(", ")}); this is queue/provenance corruption, not an ordinary item failure.`,
    });
    return;
  }

  let pullRequest = valid[0];

  if (pullRequest.merged_at) {
    if (currentState !== LIFECYCLE_STATES.MERGED) {
      const result = await transitionOrBlock({
        github,
        owner,
        repo,
        issue,
        comments,
        from: currentState,
        to: LIFECYCLE_STATES.MERGED,
        reason: "pull-request-merged",
        nonce: claim.nonce,
        prNumber: pullRequest.number,
        prUrl: pullRequest.html_url,
        mergeSha: pullRequest.merge_commit_sha,
      });
      if (!result.allowed) {
        return;
      }
    }
    await handleMergedEvidence({
      github,
      core,
      owner,
      repo,
      issue,
      comments,
      claim,
      pullRequest,
      now,
    });
    return;
  }

  if (pullRequest.state === "closed") {
    await transitionOrBlock({
      github,
      owner,
      repo,
      issue,
      comments,
      from: currentState,
      to: LIFECYCLE_STATES.BLOCKED,
      reason: "pull-request-closed-unmerged",
      nonce: claim.nonce,
      prNumber: pullRequest.number,
      prUrl: pullRequest.html_url,
    });
    return;
  }

  // From here on the PR is genuinely still open, so enrollment and/or
  // auto-merge enablement are both in play this pass. Both require the
  // PR's full changed-file scope (current AND previous/renamed-from
  // filenames) to stay entirely within the issue's own `### Allowed paths`
  // section -- a hard provenance/scope invariant, checked on every pass
  // (not just at first enrollment) so a later commit can't silently widen
  // scope past what the issue declared.
  const scopeCheck = await validateAllowedPathsScope({ github, owner, repo, issue, pullRequest });
  if (!scopeCheck.ok) {
    await blockIssue({
      github,
      owner,
      repo,
      issue,
      comments,
      from: currentState,
      reason: scopeCheck.reason,
      nonce: claim.nonce,
      prNumber: pullRequest.number,
      prUrl: pullRequest.html_url,
    });
    await pauseFactoryControl({
      github,
      core,
      owner,
      repo,
      reason: `Issue #${issue.number}'s correlated pull request #${pullRequest.number} has changed files outside its declared "Allowed paths" scope (${scopeCheck.reason}); this is a provenance/scope invariant violation, not an ordinary item failure.`,
    });
    return;
  }

  if (currentState === LIFECYCLE_STATES.IMPLEMENTING) {
    const riskLabels = getRiskLabels(issue);
    if (riskLabels.length !== 1) {
      await blockIssue({
        github,
        owner,
        repo,
        issue,
        comments,
        from: currentState,
        reason: "invalid-issue-risk-label-count",
        nonce: claim.nonce,
        prNumber: pullRequest.number,
        prUrl: pullRequest.html_url,
      });
      return;
    }
    const issueRiskLabel = riskLabels[0];

    const pullRequestRiskLabels = getRiskLabels(pullRequest);
    if (hasConflictingPullRequestRiskLabel(pullRequestRiskLabels, issueRiskLabel)) {
      await blockIssue({
        github,
        owner,
        repo,
        issue,
        comments,
        from: currentState,
        reason: "conflicting-pull-request-risk-label",
        nonce: claim.nonce,
        prNumber: pullRequest.number,
        prUrl: pullRequest.html_url,
      });
      return;
    }

    pullRequest = await ensurePullRequestLabels({
      github,
      owner,
      repo,
      pullRequest,
      labels: [AGENTIC_FACTORY_LABEL, AUTO_MERGE_LABEL, NEEDS_AI_REVIEW_LABEL, issueRiskLabel],
    });
  }

  const [commits, checkRuns] = await Promise.all([
    github.paginate(github.rest.pulls.listCommits, {
      owner,
      repo,
      pull_number: pullRequest.number,
      per_page: 100,
    }),
    github.paginate(github.rest.checks.listForRef, {
      owner,
      repo,
      ref: pullRequest.head.sha,
      per_page: 100,
    }),
  ]);
  const hasPendingSelfHeal =
    hasTrustedSelfHealCommit(commits, copilotIdentity) &&
    hasPendingCheckRuns(checkRuns);
  const desired = determineOpenPullRequestState({ hasPendingSelfHeal });

  if (desired !== currentState) {
    const result = await transitionOrBlock({
      github,
      owner,
      repo,
      issue,
      comments,
      from: currentState,
      to: desired,
      reason: hasPendingSelfHeal ? "self-heal-in-progress" : "self-heal-resolved",
      nonce: claim.nonce,
      prNumber: pullRequest.number,
      prUrl: pullRequest.html_url,
      headSha: pullRequest.head.sha,
    });
    if (!result.allowed) {
      return;
    }
  }

  await ensureAutoMergeEnabled({ github, core, pullRequest });
}

async function handleDeployedDevState({ github, owner, repo, issue, comments, claim, currentState }) {
  const result = await transitionOrBlock({
    github,
    owner,
    repo,
    issue,
    comments,
    from: currentState,
    to: LIFECYCLE_STATES.DONE,
    reason: "dev-evidence-previously-verified",
    nonce: claim.nonce,
  });
  if (result.allowed) {
    await closeIssueAsCompleted({ github, owner, repo, issue });
  }
}

async function reconcileIssue({
  github,
  core,
  owner,
  repo,
  repository,
  defaultBranch,
  issue,
  now,
  copilotIdentity,
  assignmentActorNodeId,
}) {
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: issue.number,
    per_page: 100,
  });

  const presentLifecycleLabels = labelNames(issue).filter((name) => LIFECYCLE_STATE_SET.has(name));
  if (presentLifecycleLabels.length !== 1) {
    // Ambiguous or missing lifecycle state: there is no single legitimate
    // `from` to validate a transition against, so this fails closed
    // directly rather than through `transitionOrBlock`. This is a hard
    // invariant violation ("exactly one lifecycle label", contract §5) --
    // queue/provenance corruption, not an ordinary per-issue failure -- so
    // it also best-effort pauses the factory, matching the §15 duplicate-PR
    // pause trigger's severity.
    await recordTransition({
      github,
      owner,
      repo,
      issue,
      comments,
      from: presentLifecycleLabels.join("+") || "none",
      to: LIFECYCLE_STATES.BLOCKED,
      reason: "ambiguous-lifecycle-state",
    });
    await pauseFactoryControl({
      github,
      core,
      owner,
      repo,
      reason: `Issue #${issue.number} has an ambiguous/missing lifecycle state (labels: ${presentLifecycleLabels.join(", ") || "none"}); this is queue/provenance corruption, not an ordinary item failure.`,
    });
    return;
  }

  const currentState = presentLifecycleLabels[0];
  if (!TARGET_LIFECYCLE_LABELS.includes(currentState)) {
    // Outside this reconciler's scope (e.g. already `blocked`/`factory:done`
    // or an earlier-pipeline label); nothing to do.
    return;
  }

  const claimResolution = resolveLatestIssueClaim(
    comments,
    issue.number,
    now,
  );
  if (claimResolution.state !== "valid") {
    await blockIssue({
      github,
      owner,
      repo,
      issue,
      comments,
      from: currentState,
      reason: claimResolution.reason,
    });
    return;
  }
  const claim = claimResolution.claim;

  if (currentState === LIFECYCLE_STATES.CLAIMED) {
    await handleClaimedState({
      github,
      core,
      owner,
      repo,
      issue,
      comments,
      claim,
      currentState,
      now,
      copilotIdentity,
      assignmentActorNodeId,
    });
    return;
  }

  if (currentState !== LIFECYCLE_STATES.CLAIMED) {
    const assignment = await verifyPersistedAssignmentProvenance({
      github,
      owner,
      repo,
      issue,
      comments,
      claim,
      now,
      copilotIdentity,
      assignmentActorNodeId,
    });
    if (!assignment.valid) {
      await blockIssue({
        github,
        owner,
        repo,
        issue,
        comments,
        from: currentState,
        reason: assignment.reason,
        nonce: claim.nonce,
      });
      await pauseFactoryControl({
        github,
        core,
        owner,
        repo,
        reason: `Issue #${issue.number} no longer has valid assignment provenance (${assignment.reason}).`,
      });
      return;
    }
  }

  if (currentState === LIFECYCLE_STATES.DEPLOYED_DEV) {
    await handleDeployedDevState({
      github,
      owner,
      repo,
      issue,
      comments,
      claim,
      currentState,
    });
    return;
  }

  await handlePullRequestState({
    github,
    core,
    owner,
    repo,
    repository,
    defaultBranch,
    issue,
    comments,
    claim,
    currentState,
    now,
    copilotIdentity,
  });
}

async function tryEmergencyBlock({ github, core, owner, repo, issue, error }) {
  try {
    await replaceLifecycleLabel({
      github,
      owner,
      repo,
      issueNumber: issue.number,
      currentLabelNames: labelNames(issue),
      target: LIFECYCLE_STATES.BLOCKED,
    });
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: issue.number,
      body: buildAuditCommentBody({
        issueNumber: issue.number,
        transition: "* -> blocked",
        reason: "reconciler-internal-error",
      }) + `\n- Detail: ${getErrorMessage(error)}`,
    });
  } catch (innerError) {
    core.warning(
      `Could not fail-close issue #${issue.number} after an internal error: ${getErrorMessage(innerError)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Finds the most recent `"labeled"` timeline event applying the given label
 * name, ranked by `created_at` (not array order, since a paginated timeline
 * is not guaranteed to already be sorted). Pure: operates only on an
 * already-fetched events array. Multiple label/unlabel cycles are possible
 * over an issue's lifetime; only the latest application is authoritative
 * for "who currently authorized this."
 *
 * @param {unknown} events
 * @param {string} labelName
 * @returns {{event: string, label: {name: string}, actor?: {type?: string}}|undefined}
 */
function findLatestLabelApplicationEvent(events, labelName) {
  const list = Array.isArray(events) ? events : [];
  return list
    .filter(
      (event) => event && event.event === "labeled" && event.label && event.label.name === labelName,
    )
    .sort((left, right) => Date.parse(right.created_at || "") - Date.parse(left.created_at || ""))[0];
}

/**
 * Resolves the singleton `factory-control` issue's mode. Fails closed to
 * `paused` whenever the control issue is missing, duplicated, its mode
 * can't be read at all, or -- matching `agentic-pr-reconciler.cjs` and
 * `agentic-queue-runtime.cjs`'s own human-authorization gate -- an
 * `active` label was not most recently applied by a human (`actor.type ===
 * "User"`) on the control issue's timeline. A bot/app-applied
 * `factory-mode:active`, a missing "labeled" timeline event, or a timeline
 * read failure are all treated as non-active (fail-closed), never as
 * authorization to run. `shadow`/`paused` never require this check, since
 * neither authorizes any mutation in the first place.
 */
async function resolveFactoryMode({ github, core, owner, repo }) {
  try {
    const controlIssues = await github.paginate(github.rest.issues.listForRepo, {
      owner,
      repo,
      state: "open",
      labels: FACTORY_CONTROL_LABEL,
      per_page: 100,
    });
    if (controlIssues.length !== 1) {
      core.warning(
        `Expected exactly one open factory-control issue; found ${controlIssues.length}. Treating factory mode as paused (fail-closed).`,
      );
      return policy.FACTORY_MODES.PAUSED;
    }

    const controlIssue = controlIssues[0];
    const mode = policy.resolveFactoryModeFromLabels(controlIssue.labels);
    if (mode !== policy.FACTORY_MODES.ACTIVE) {
      return mode;
    }

    const timeline = await github.paginate(github.rest.issues.listEventsForTimeline, {
      owner,
      repo,
      issue_number: controlIssue.number,
      per_page: 100,
    });
    const latestActiveEvent = findLatestLabelApplicationEvent(timeline, ACTIVE_MODE_LABEL);
    if (!latestActiveEvent || !latestActiveEvent.actor || latestActiveEvent.actor.type !== "User") {
      core.warning(
        `"${ACTIVE_MODE_LABEL}" on the factory-control issue #${controlIssue.number} was not most-recently applied by a human user; treating factory mode as paused (fail-closed).`,
      );
      return policy.FACTORY_MODES.PAUSED;
    }

    return policy.FACTORY_MODES.ACTIVE;
  } catch (error) {
    core.warning(
      `Could not resolve factory mode; treating as paused (fail-closed): ${getErrorMessage(error)}`,
    );
    return policy.FACTORY_MODES.PAUSED;
  }
}

/**
 * Reconciles every open issue carrying one of the six post-queue factory
 * lifecycle labels. Each issue is processed independently: an API failure
 * for one issue is warned and fail-closed (when possible) without
 * interrupting reconciliation of the others.
 *
 * Only `factory-mode:active` authorizes any lifecycle mutation, PR
 * enrollment/auto-merge enablement, or issue closure (contract §2): a
 * `shadow`, `paused`, missing, or conflicting control-issue mode performs no
 * mutations at all this pass and is logged as an advisory no-op.
 *
 * @param {{github: object, context: {repo: {owner: string, repo: string}}, core: object, now?: string, assignmentActorNodeId?: string}} input
 * @param {string} [input.now] ISO-8601 "current time" used only for the
 *   stale-unassigned-claim check (contract §9's `evaluateClaimState`). Injected
 *   so callers/tests can pass a deterministic value; defaults to the actual
 *   current time (`new Date().toISOString()`).
 */
async function reconcileFactoryLifecycle({
  github,
  context,
  core,
  now,
  assignmentActorNodeId,
}) {
  const resolvedNow = typeof now === "string" && now.trim() !== "" ? now : new Date().toISOString();
  const { owner, repo } = context.repo;
  const repository = `${owner}/${repo}`;

  const factoryMode = await resolveFactoryMode({ github, core, owner, repo });
  if (factoryMode !== policy.FACTORY_MODES.ACTIVE) {
    core.info(
      `Factory mode is '${factoryMode}'; the lifecycle reconciler is performing no mutations this pass (advisory/no-op).`,
    );
    return;
  }

  let defaultBranch;
  try {
    const repoInfo = await github.rest.repos.get({ owner, repo });
    defaultBranch = repoInfo.data.default_branch;
  } catch (error) {
    core.warning(
      `Could not resolve the default branch; no lifecycle reconciliation will be attempted this run: ${getErrorMessage(error)}`,
    );
    return;
  }

  let configuredAssignmentActorNodeId;
  let copilotIdentity;
  try {
    configuredAssignmentActorNodeId =
      normalizeConfiguredUserNodeId(assignmentActorNodeId);
    copilotIdentity = await resolveRepositoryCopilotIdentity({
      github,
      owner,
      repo,
    });
  } catch (error) {
    const code =
      error instanceof AgenticIdentityError
        ? error.code
        : "copilot-identity-unexpected-error";
    await pauseFactoryControl({
      github,
      core,
      owner,
      repo,
      reason: `Canonical Copilot identity resolution failed (${code}).`,
    });
    throw new FactoryTrustSourceError(
      code,
      "Canonical Copilot identity could not be established",
    );
  }

  const issuesByNumber = new Map();
  for (const label of TARGET_LIFECYCLE_LABELS) {
    const found = await github.paginate(github.rest.issues.listForRepo, {
      owner,
      repo,
      state: "open",
      labels: label,
      per_page: 100,
    });
    for (const issue of found) {
      issuesByNumber.set(issue.number, issue);
    }
  }

  for (const issue of issuesByNumber.values()) {
    try {
      await reconcileIssue({
        github,
        core,
        owner,
        repo,
        repository,
        defaultBranch,
        issue,
        now: resolvedNow,
        copilotIdentity,
        assignmentActorNodeId: configuredAssignmentActorNodeId,
      });
    } catch (error) {
      if (error instanceof FactoryTrustSourceError) {
        await pauseFactoryControl({
          github,
          core,
          owner,
          repo,
          reason: `Lifecycle trust-source failure (${error.code}).`,
        });
        throw error;
      }
      core.warning(
        `Lifecycle reconciliation failed for issue #${issue.number}: ${getErrorMessage(error)}`,
      );
      await tryEmergencyBlock({ github, core, owner, repo, issue, error });
    }
  }
}

module.exports = {
  // Entry point
  reconcileFactoryLifecycle,
  // Constants useful to callers/tests
  TARGET_LIFECYCLE_LABELS,
  PR_TITLE_PREFIX,
  AGENTIC_FACTORY_LABEL,
  AUTO_MERGE_LABEL,
  NEEDS_AI_REVIEW_LABEL,
  FACTORY_CONTROL_LABEL,
  ACTIVE_MODE_LABEL,
  PAUSED_MODE_LABEL,
  DEV_EVIDENCE_STATUS_CONTEXT,
  DEV_ENVIRONMENT,
  DEV_EVIDENCE_TIMEOUT_MS,
  CLAIM_MARKER_PATTERN,
  ASSIGNMENT_MARKER_PATTERN,
  // Pure parsers/classifiers/resolvers
  extractClaimMarkerPayload,
  resolveLatestIssueClaim,
  classifyAssignmentEvidence,
  currentAssigneeState,
  resolveAssignmentAttestation,
  verifyPersistedAssignmentProvenance,
  getRiskLabels,
  buildClaimNonceMarker,
  buildRefsMarker,
  isCandidatePullRequest,
  isValidCandidatePullRequest,
  correlatePullRequests,
  hasTrustedSelfHealCommit,
  hasPendingCheckRuns,
  determineOpenPullRequestState,
  resolveLifecycleTransitionPath,
  computeLifecycleLabelChange,
  hasConflictingPullRequestRiskLabel,
  isRetryableAutoMergeStateError,
  findLatestLabelApplicationEvent,
  getIssueFormSection,
  evaluateCommitStatusOutcome,
  evaluateDeploymentOutcome,
  evaluateDevEvidence,
  buildAuditCommentMarker,
  findManagedAuditComment,
  buildAuditCommentBody,
  labelNames,
  // Orchestration helpers (async, github-calling) exposed for direct testing
  replaceLifecycleLabel,
  recordTransition,
  transitionOrBlock,
  blockIssue,
  ensurePullRequestLabels,
  validateAllowedPathsScope,
  blockPullRequestCandidates,
  ensureAutoMergeEnabled,
  closeIssueAsCompleted,
  pauseFactoryControl,
  resolveFactoryMode,
  reconcileIssue,
};
