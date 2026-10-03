"use strict";

// Backstop sweeper that re-arms GitHub's *native* auto-merge for enrolled
// pull requests whose merge evidence is already complete on the current head.
//
// Authority boundary (deliberate, do not weaken):
//   - This module NEVER merges. It does not call the pull-request merge or
//     branch-update REST endpoints, never creates or completes a check run,
//     and never applies or removes a label. Its single mutation is the
//     GraphQL `enablePullRequestAutoMerge` mutation, which *queues* a merge
//     that branch protection still gates in full. Passing checks never
//     delegates operational authority; GitHub remains the enforcement point.
//   - It exists because arming is currently one-shot: `[docs-sync]` pull
//     requests are armed by the gh-aw `auto_merge: true` safe output at
//     creation, and `[ai-dev]` pull requests are armed by the lifecycle
//     reconciler only along the issue-driven path. A pull request whose issue
//     path returns early, or whose one-shot arming hit a transient GitHub
//     state error, can otherwise sit fully green and never merge.
//
// Everything here is fail-closed: any unresolved, ambiguous, or unreadable
// signal declines to arm rather than arming optimistically.

const { AGENTIC_POLICY } = require("./agentic-policy.cjs");
const {
  FACTORY_MODES,
  resolveFactoryModeFromLabels,
} = require("./agentic-factory-policy.cjs");

const {
  autoMergeLabel: AUTO_MERGE_LABEL,
  mergeBlockingLabels: MERGE_BLOCKING_LABELS,
  passingCheckConclusions: PASSING_CHECK_CONCLUSIONS,
  requiredContexts: REQUIRED_CONTEXTS,
} = AGENTIC_POLICY;

const FACTORY_CONTROL_LABEL = "factory-control";
const ACTIVE_MODE_LABEL = "factory-mode:active";
const HUMAN_REVIEW_LABEL = "ready-for-human-review";

const ENABLE_AUTO_MERGE_MUTATION = `
  mutation EnableAgenticAutoMerge($pullRequestId: ID!) {
    enablePullRequestAutoMerge(
      input: { pullRequestId: $pullRequestId, mergeMethod: SQUASH }
    ) {
      pullRequest { number }
    }
  }
`;

// GitHub rejects `enablePullRequestAutoMerge` while the head commit's
// mergeable state is still settling. Those are transient and retryable, not
// policy violations, so they are logged and swallowed for the next pass.
const RETRYABLE_AUTO_MERGE_ERROR_SUBSTRINGS = Object.freeze([
  "clean status",
  "unstable status",
  "pending status",
]);

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isRetryableAutoMergeStateError(error) {
  const message = getErrorMessage(error);
  return RETRYABLE_AUTO_MERGE_ERROR_SUBSTRINGS.some((substring) =>
    message.includes(substring),
  );
}

function getLabels(item) {
  return new Set(
    (item.labels || []).map((label) => label && label.name).filter(Boolean),
  );
}

function isSameRepositoryPullRequest(pullRequest, repository) {
  return Boolean(
    pullRequest.head &&
      pullRequest.head.repo &&
      typeof pullRequest.head.repo.full_name === "string" &&
      pullRequest.head.repo.full_name.toLowerCase() ===
        repository.toLowerCase(),
  );
}

function latestNamedCheck(checkRuns, name) {
  return checkRuns
    .filter((check) => check.name === name)
    .sort((left, right) => right.id - left.id)[0];
}

function getCheckState(checkRuns, name) {
  const check = latestNamedCheck(checkRuns, name);
  if (!check) {
    return "missing";
  }
  if (check.status !== "completed") {
    return "pending";
  }
  return PASSING_CHECK_CONCLUSIONS.has(check.conclusion)
    ? "success"
    : "failure";
}

/**
 * Decides whether native auto-merge should be armed for one pull request.
 *
 * Returns `{ arm, reason }`. `arm` is true only when every gate below is
 * satisfied on the *current head SHA*; `reason` always explains the outcome
 * so a declined sweep is auditable from the run log.
 */
function evaluateAutoMergeArming({
  pullRequest,
  checkRuns = [],
  repository,
  factoryMode = FACTORY_MODES.PAUSED,
}) {
  if (pullRequest.state && pullRequest.state !== "open") {
    return { arm: false, reason: "pull-request-not-open" };
  }
  if (pullRequest.merged_at) {
    return { arm: false, reason: "already-merged" };
  }
  if (pullRequest.draft) {
    return { arm: false, reason: "draft" };
  }

  const labels = getLabels(pullRequest);
  if (!labels.has(AUTO_MERGE_LABEL)) {
    return { arm: false, reason: "not-enrolled" };
  }
  // Forks are never armed here: fork policy requires a current human approval,
  // and that decision stays with a human reviewer, not this sweeper.
  if (!isSameRepositoryPullRequest(pullRequest, repository)) {
    return { arm: false, reason: "forked-head" };
  }
  const blockingLabel = [...MERGE_BLOCKING_LABELS].find((label) =>
    labels.has(label),
  );
  if (blockingLabel) {
    return { arm: false, reason: `blocking-label:${blockingLabel}` };
  }
  if (labels.has(HUMAN_REVIEW_LABEL)) {
    return {
      arm: false,
      reason: `blocking-label:${HUMAN_REVIEW_LABEL}`,
    };
  }
  if (factoryMode !== FACTORY_MODES.ACTIVE) {
    return { arm: false, reason: `factory-mode:${factoryMode}` };
  }
  if (pullRequest.auto_merge) {
    return { arm: false, reason: "already-armed" };
  }
  if (
    typeof pullRequest.node_id !== "string" ||
    pullRequest.node_id === ""
  ) {
    return { arm: false, reason: "missing-node-id" };
  }

  // This is a backstop for PRs that are already complete, so every required
  // branch-protection context must be green before arming.
  const pendingContext = REQUIRED_CONTEXTS.find(
    (name) => getCheckState(checkRuns, name) !== "success",
  );
  if (pendingContext) {
    return {
      arm: false,
      reason: `required-context:${pendingContext}:${getCheckState(checkRuns, pendingContext)}`,
    };
  }

  return { arm: true, reason: "merge-evidence-complete" };
}

/**
 * Resolves the factory light switch, fail-closed to `paused`.
 *
 * `active` counts only when the current `factory-mode:active` label was
 * applied by a real human `User`; a bot-applied or unattested activation is
 * downgraded to `paused`, matching the PR reconciler.
 */
async function resolveHumanAttestedFactoryMode({ github, core, owner, repo }) {
  try {
    const controlIssues = await github.paginate(
      github.rest.issues.listForRepo,
      {
        owner,
        repo,
        state: "open",
        labels: FACTORY_CONTROL_LABEL,
        per_page: 100,
      },
    );
    if (controlIssues.length !== 1) {
      core.warning(
        `Expected exactly one open factory-control issue; found ${controlIssues.length}. Not arming auto-merge.`,
      );
      return FACTORY_MODES.PAUSED;
    }

    const mode = resolveFactoryModeFromLabels(controlIssues[0].labels);
    if (mode !== FACTORY_MODES.ACTIVE) {
      return mode;
    }

    const timeline = await github.paginate(
      github.rest.issues.listEventsForTimeline,
      {
        owner,
        repo,
        issue_number: controlIssues[0].number,
        per_page: 100,
      },
    );
    const latestActivation = timeline
      .filter(
        (event) =>
          event.event === "labeled" &&
          event.label &&
          event.label.name === ACTIVE_MODE_LABEL,
      )
      .sort(
        (left, right) =>
          Date.parse(right.created_at || "") -
          Date.parse(left.created_at || ""),
      )[0];

    if (
      !latestActivation ||
      !latestActivation.actor ||
      latestActivation.actor.type !== "User"
    ) {
      core.warning(
        "Factory active mode lacks a current human label event; not arming auto-merge.",
      );
      return FACTORY_MODES.PAUSED;
    }

    return FACTORY_MODES.ACTIVE;
  } catch (error) {
    core.warning(
      `Could not resolve factory mode; not arming auto-merge: ${getErrorMessage(error)}`,
    );
    return FACTORY_MODES.PAUSED;
  }
}

/**
 * Sweeps every open pull request and re-arms native auto-merge for those
 * whose merge evidence is already complete. Per-PR failures are isolated and
 * warned so one bad pull request cannot stall the sweep.
 */
async function sweepAutoMergeReadyPullRequests({ github, context, core }) {
  const { owner, repo } = context.repo;
  const repository = `${owner}/${repo}`;

  const factoryMode = await resolveHumanAttestedFactoryMode({
    github,
    core,
    owner,
    repo,
  });

  const pullRequests = await github.paginate(github.rest.pulls.list, {
    owner,
    repo,
    state: "open",
    per_page: 100,
  });

  const armed = [];
  const declined = [];

  for (const pullRequest of pullRequests) {
    try {
      // Cheap pre-filter so the sweeper does not spend a check-runs request
      // on every unrelated pull request in the repository.
      const preflight = evaluateAutoMergeArming({
        pullRequest,
        checkRuns: [],
        repository,
        factoryMode,
      });
      if (
        !preflight.arm &&
        !preflight.reason.startsWith("merge-policy:") &&
        !preflight.reason.startsWith("required-context:")
      ) {
        declined.push({ number: pullRequest.number, reason: preflight.reason });
        continue;
      }

      const checkRuns = await github.paginate(github.rest.checks.listForRef, {
        owner,
        repo,
        ref: pullRequest.head.sha,
        per_page: 100,
      });

      const decision = evaluateAutoMergeArming({
        pullRequest,
        checkRuns,
        repository,
        factoryMode,
      });
      if (!decision.arm) {
        declined.push({ number: pullRequest.number, reason: decision.reason });
        continue;
      }

      await github.graphql(ENABLE_AUTO_MERGE_MUTATION, {
        pullRequestId: pullRequest.node_id,
      });
      core.info(
        `Re-armed native auto-merge for PR #${pullRequest.number} (${decision.reason}).`,
      );
      armed.push({ number: pullRequest.number, reason: decision.reason });
    } catch (error) {
      if (isRetryableAutoMergeStateError(error)) {
        core.info(
          `PR #${pullRequest.number}'s head status has not settled yet; the next sweep will retry.`,
        );
        declined.push({
          number: pullRequest.number,
          reason: "head-state-unsettled",
        });
        continue;
      }
      core.warning(
        `Failed to sweep PR #${pullRequest.number}: ${getErrorMessage(error)}`,
      );
      declined.push({ number: pullRequest.number, reason: "sweep-error" });
    }
  }

  core.info(
    `Auto-merge sweep complete in factory mode "${factoryMode}": armed ${armed.length}, declined ${declined.length}.`,
  );

  return { factoryMode, armed, declined };
}

module.exports = {
  ACTIVE_MODE_LABEL,
  AUTO_MERGE_LABEL,
  ENABLE_AUTO_MERGE_MUTATION,
  FACTORY_CONTROL_LABEL,
  REQUIRED_CONTEXTS,
  evaluateAutoMergeArming,
  getCheckState,
  isRetryableAutoMergeStateError,
  isSameRepositoryPullRequest,
  resolveHumanAttestedFactoryMode,
  sweepAutoMergeReadyPullRequests,
};
