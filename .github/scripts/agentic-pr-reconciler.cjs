"use strict";

const MERGE_CONTEXT = "Agentic merge policy";
const REVIEW_CHECK_NAME = "Agentic code review";
const AUTO_MERGE_LABEL = "agentic-automerge";
const EXHAUSTED_LABEL = "self-heal-exhausted";
const BLOCKED_LABEL = "blocked";

const TRUSTED_AGENT_AUTHORS = new Set([
  "github-actions[bot]",
  "copilot-swe-agent[bot]",
]);
const TRUSTED_REVIEW_ASSOCIATIONS = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
]);
const BLOCKING_LABELS = new Set([
  BLOCKED_LABEL,
  EXHAUSTED_LABEL,
  "needs-qa",
  "security-review",
  "trading-safety",
  "ready-for-human-review",
]);
const FAILING_CONCLUSIONS = new Set([
  "cancelled",
  "failure",
  "startup_failure",
  "timed_out",
]);
const LOW_RISK_STATUSES = new Set(["added", "modified"]);

function getLabels(pullRequest) {
  return new Set(
    (pullRequest.labels || [])
      .map((label) => label && label.name)
      .filter(Boolean),
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

function isTrustedAgentPullRequest(pullRequest, repository) {
  const labels = getLabels(pullRequest);
  const title = pullRequest.title || "";

  return (
    isSameRepositoryPullRequest(pullRequest, repository) &&
    TRUSTED_AGENT_AUTHORS.has(pullRequest.user && pullRequest.user.login) &&
    labels.has(AUTO_MERGE_LABEL) &&
    (title.startsWith("[ai-dev] ") || title.startsWith("[docs-sync] "))
  );
}

function isLowRiskPath(filename) {
  if (
    typeof filename !== "string" ||
    !/^docs\/.*\.(gif|jpe?g|md|png|txt|webp)$/i.test(filename)
  ) {
    return false;
  }

  return !/(^|\/)(agentic|auth|backup|database|deploy(?:ment)?|env|guardrails?|incident|migrations?|oncall|operator|policy|production|release|rollback|runbooks?|secrets?|security|trading|workflows?)(\/|[-_.])/i.test(
    filename,
  );
}

function isLowRiskChange(files) {
  return (
    files.length > 0 &&
    files.every(
      (file) =>
        LOW_RISK_STATUSES.has(file.status) &&
        isLowRiskPath(file.filename) &&
        (!file.previous_filename || isLowRiskPath(file.previous_filename)),
    )
  );
}

function getReviewState(pullRequest, reviews, sha) {
  const latestDecisiveReview = new Map();

  for (const review of reviews) {
    if (review.state === "COMMENTED") {
      continue;
    }
    const login = review.user && review.user.login;
    if (login) {
      latestDecisiveReview.set(login, review);
    }
  }

  const isCurrentTrustedHumanReview = (review) =>
    review.commit_id === sha &&
    review.user &&
    review.user.type === "User" &&
    review.user.login !== (pullRequest.user && pullRequest.user.login) &&
    TRUSTED_REVIEW_ASSOCIATIONS.has(review.author_association);

  const decisiveReviews = [...latestDecisiveReview.values()];
  return {
    hasCurrentHumanApproval: decisiveReviews.some(
      (review) =>
        review.state === "APPROVED" &&
        isCurrentTrustedHumanReview(review),
    ),
    hasCurrentHumanChangesRequested: decisiveReviews.some(
      (review) =>
        review.state === "CHANGES_REQUESTED" &&
        isCurrentTrustedHumanReview(review),
    ),
  };
}

function hasBlockingLabel(pullRequest) {
  const labels = getLabels(pullRequest);
  const title = pullRequest.title || "";

  return (
    [...BLOCKING_LABELS].some((label) => labels.has(label)) ||
    (labels.has("docs-sync") && !title.startsWith("[docs-sync] "))
  );
}

function evaluateMergePolicy({ pullRequest, files, reviews, repository }) {
  const sha = pullRequest.head.sha;
  const sameRepository = isSameRepositoryPullRequest(
    pullRequest,
    repository,
  );
  const trustedAgent = isTrustedAgentPullRequest(pullRequest, repository);
  const lowRisk = isLowRiskChange(files);
  const blockingLabel = hasBlockingLabel(pullRequest);
  const {
    hasCurrentHumanApproval,
    hasCurrentHumanChangesRequested,
  } = getReviewState(pullRequest, reviews, sha);

  let state = "pending";
  let description = "A current human approval is required";

  if (pullRequest.draft) {
    description = "Draft pull requests cannot merge";
  } else if (hasCurrentHumanChangesRequested) {
    description = "A current human review requests changes";
  } else if (hasCurrentHumanApproval) {
    state = "success";
    description = "Current human approval satisfies policy";
  } else if (trustedAgent && lowRisk && !blockingLabel) {
    state = "success";
    description = "Allowlisted low-risk agent pull request";
  } else if (trustedAgent && blockingLabel) {
    description = "A blocking review label requires human approval";
  } else if (trustedAgent) {
    description = "Non-allowlisted changes require human approval";
  }

  return {
    state,
    description,
    sameRepository,
    trustedAgent,
    lowRisk,
    hasBlockingLabel: blockingLabel,
    hasCurrentHumanApproval,
    hasCurrentHumanChangesRequested,
  };
}

function canAttemptSelfHeal({
  sameRepository,
  draft,
  trustedAgent,
  lowRisk,
  hasBlockingLabel: blockingLabel,
  ciNeedsDispatch,
  reviewShouldDispatch,
  ciHeld,
  reviewHeld,
}) {
  return (
    sameRepository &&
    !draft &&
    trustedAgent &&
    lowRisk &&
    !blockingLabel &&
    !ciNeedsDispatch &&
    !reviewShouldDispatch &&
    !ciHeld &&
    !reviewHeld
  );
}

function countRepairAttempts(commits) {
  return commits.filter(
    (commit) =>
      TRUSTED_AGENT_AUTHORS.has(commit.author && commit.author.login) &&
      commit.commit &&
      typeof commit.commit.message === "string" &&
      commit.commit.message.includes("[self-heal]"),
  ).length;
}

function pullRequestDispatchInputs(number) {
  return {
    pr: String(number),
    aw_context: JSON.stringify({
      item_type: "pull_request",
      item_number: number,
    }),
  };
}

function latestNamedCheck(checkRuns, name) {
  return checkRuns
    .filter((check) => check.name === name)
    .sort((left, right) => right.id - left.id)[0];
}

function hasFailedCiRun(ciRuns) {
  const latestRun = ciRuns[0];
  return Boolean(
    latestRun &&
      latestRun.status === "completed" &&
      FAILING_CONCLUSIONS.has(latestRun.conclusion),
  );
}

function hasFailedReviewCheck(checkRuns) {
  const reviewCheck = latestNamedCheck(checkRuns, REVIEW_CHECK_NAME);
  return (
    reviewCheck &&
    reviewCheck.status === "completed" &&
    !["action_required", "neutral", "skipped", "success"].includes(
      reviewCheck.conclusion,
    )
  );
}

function getErrorStatus(error) {
  return error && typeof error === "object" ? error.status : undefined;
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function reconcileAgenticPullRequests({ github, context, core }) {
  const { owner, repo } = context.repo;
  const repository = `${owner}/${repo}`;

  const pullRequests = await github.paginate(github.rest.pulls.list, {
    owner,
    repo,
    state: "open",
    per_page: 100,
  });

  const listRuns = async (workflowId, headSha) => {
    try {
      const response = await github.rest.actions.listWorkflowRuns({
        owner,
        repo,
        workflow_id: workflowId,
        head_sha: headSha,
        per_page: 100,
      });
      return response.data.workflow_runs.sort(
        (left, right) => right.id - left.id,
      );
    } catch (error) {
      if (getErrorStatus(error) === 404) {
        core.warning(`Workflow ${workflowId} is not available yet.`);
        return [];
      }
      throw error;
    }
  };

  const dispatch = async (workflowId, ref, inputs = {}) => {
    core.info(`Dispatching ${workflowId} on ${ref}.`);
    await github.rest.actions.createWorkflowDispatch({
      owner,
      repo,
      workflow_id: workflowId,
      ref,
      inputs,
    });
  };

  const approveHeldRun = async (run) => {
    core.info(`Approving held ${run.name} run ${run.id}.`);
    await github.rest.actions.approveWorkflowRun({
      owner,
      repo,
      run_id: run.id,
    });
  };

  const listReviews = async (pullNumber) => {
    try {
      return await github.paginate(github.rest.pulls.listReviews, {
        owner,
        repo,
        pull_number: pullNumber,
        per_page: 100,
      });
    } catch (error) {
      if (
        getErrorStatus(error) === 403 ||
        getErrorStatus(error) === 404
      ) {
        core.warning(
          `Could not read reviews for PR #${pullNumber}; keeping the merge policy fail-closed.`,
        );
        return [];
      }
      throw error;
    }
  };

  const ensureStatus = async (sha, state, description, targetUrl) => {
    const statuses = await github.paginate(
      github.rest.repos.listCommitStatusesForRef,
      {
        owner,
        repo,
        ref: sha,
        per_page: 100,
      },
    );
    const current = statuses.find(
      (status) => status.context === MERGE_CONTEXT,
    );

    if (
      current &&
      current.state === state &&
      current.description === description
    ) {
      return;
    }

    await github.rest.repos.createCommitStatus({
      owner,
      repo,
      sha,
      state,
      context: MERGE_CONTEXT,
      description,
      target_url: targetUrl,
    });
  };

  const addLabels = async (pullRequest, labels) => {
    const present = getLabels(pullRequest);
    const missing = labels.filter((label) => !present.has(label));
    if (missing.length === 0) {
      return;
    }

    await github.rest.issues.addLabels({
      owner,
      repo,
      issue_number: pullRequest.number,
      labels: missing,
    });
  };

  for (const pullRequest of pullRequests) {
    try {
      const number = pullRequest.number;
      const sha = pullRequest.head.sha;
      const [files, reviews, commits, checkRuns, ciRuns, reviewRuns] =
        await Promise.all([
          github.paginate(github.rest.pulls.listFiles, {
            owner,
            repo,
            pull_number: number,
            per_page: 100,
          }),
          listReviews(number),
          github.paginate(github.rest.pulls.listCommits, {
            owner,
            repo,
            pull_number: number,
            per_page: 100,
          }),
          github.paginate(github.rest.checks.listForRef, {
            owner,
            repo,
            ref: sha,
            per_page: 100,
          }),
          listRuns("ci.yml", sha),
          listRuns("code-review.lock.yml", sha),
        ]);

      const policy = evaluateMergePolicy({
        pullRequest,
        files,
        reviews,
        repository,
      });

      await ensureStatus(
        sha,
        policy.state,
        policy.description,
        pullRequest.html_url,
      );

      if (!policy.sameRepository || pullRequest.draft) {
        continue;
      }

      const ciNeedsDispatch = ciRuns.length === 0;
      const reviewNeedsDispatch = reviewRuns.length === 0;
      const ciHeld = ciRuns[0] && ciRuns[0].conclusion === "action_required";
      const reviewHeld =
        reviewRuns[0] && reviewRuns[0].conclusion === "action_required";
      const reviewShouldDispatch =
        reviewNeedsDispatch || (policy.trustedAgent && reviewHeld);

      if (ciNeedsDispatch) {
        await dispatch("ci.yml", pullRequest.head.ref);
      }

      if (reviewShouldDispatch) {
        await dispatch(
          "code-review.lock.yml",
          pullRequest.head.ref,
          pullRequestDispatchInputs(number),
        );
      }

      if (policy.trustedAgent && ciHeld) {
        await approveHeldRun(ciRuns[0]);
      }

      if (
        !canAttemptSelfHeal({
          sameRepository: policy.sameRepository,
          draft: pullRequest.draft,
          trustedAgent: policy.trustedAgent,
          lowRisk: policy.lowRisk,
          hasBlockingLabel: policy.hasBlockingLabel,
          ciNeedsDispatch,
          reviewShouldDispatch,
          ciHeld,
          reviewHeld,
        })
      ) {
        continue;
      }

      const ciFailure = hasFailedCiRun(ciRuns);
      const reviewFailure = hasFailedReviewCheck(checkRuns);
      if (!ciFailure && !reviewFailure) {
        continue;
      }

      if (countRepairAttempts(commits) >= 2) {
        await addLabels(pullRequest, [EXHAUSTED_LABEL, BLOCKED_LABEL]);
        continue;
      }

      const healRuns = await listRuns("pr-self-heal.lock.yml", sha);
      if (healRuns.length === 0) {
        await dispatch(
          "pr-self-heal.lock.yml",
          pullRequest.head.ref,
          pullRequestDispatchInputs(number),
        );
        continue;
      }

      if (healRuns[0].status === "completed") {
        await addLabels(pullRequest, [EXHAUSTED_LABEL, BLOCKED_LABEL]);
      }
    } catch (error) {
      core.warning(
        `Failed to reconcile PR #${pullRequest.number}: ${getErrorMessage(error)}`,
      );
    }
  }
}

module.exports = {
  AUTO_MERGE_LABEL,
  BLOCKED_LABEL,
  BLOCKING_LABELS,
  EXHAUSTED_LABEL,
  LOW_RISK_STATUSES,
  MERGE_CONTEXT,
  REVIEW_CHECK_NAME,
  TRUSTED_AGENT_AUTHORS,
  canAttemptSelfHeal,
  countRepairAttempts,
  evaluateMergePolicy,
  getReviewState,
  hasBlockingLabel,
  hasFailedCiRun,
  hasFailedReviewCheck,
  isLowRiskChange,
  isLowRiskPath,
  isSameRepositoryPullRequest,
  isTrustedAgentPullRequest,
  pullRequestDispatchInputs,
  reconcileAgenticPullRequests,
};
