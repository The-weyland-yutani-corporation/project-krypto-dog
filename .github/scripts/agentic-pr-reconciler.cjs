"use strict";

const { AGENTIC_POLICY } = require("./agentic-policy.cjs");

const {
  autoMergeLabel: AUTO_MERGE_LABEL,
  blockedLabel: BLOCKED_LABEL,
  exhaustedLabel: EXHAUSTED_LABEL,
  failingConclusions: FAILING_CONCLUSIONS,
  lowRiskPathPattern: LOW_RISK_PATH_PATTERN,
  lowRiskStatuses: LOW_RISK_STATUSES,
  maxRepairCommits: MAX_REPAIR_COMMITS,
  mergeBlockingLabels: MERGE_BLOCKING_LABELS,
  mergeContext: MERGE_CONTEXT,
  nonRepairableReviewConclusions: NON_REPAIRABLE_REVIEW_CONCLUSIONS,
  passingCheckConclusions: PASSING_CHECK_CONCLUSIONS,
  reviewCheckName: REVIEW_CHECK_NAME,
  securityCheckName: SECURITY_CHECK_NAME,
  securityExactPaths: SECURITY_EXACT_PATHS,
  securityPathPatterns: SECURITY_PATH_PATTERNS,
  selfHealBlockingLabels: SELF_HEAL_BLOCKING_LABELS,
  sensitiveTokenPattern: SENSITIVE_DOC_TOKEN_PATTERN,
  tradingSafetyCheckName: TRADING_SAFETY_CHECK_NAME,
  tradingSafetyExactPaths: TRADING_SAFETY_EXACT_PATHS,
  tradingSafetyPathPatterns: TRADING_SAFETY_PATH_PATTERNS,
  trustedAgentAuthors: TRUSTED_AGENT_AUTHORS,
  trustedReviewAssociations: TRUSTED_REVIEW_ASSOCIATIONS,
} = AGENTIC_POLICY;

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
    !LOW_RISK_PATH_PATTERN.test(filename)
  ) {
    return false;
  }

  return !SENSITIVE_DOC_TOKEN_PATTERN.test(filename);
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

function requiresSecurityReview(filename) {
  return Boolean(
    typeof filename === "string" &&
      (SECURITY_EXACT_PATHS.has(filename) ||
        SECURITY_PATH_PATTERNS.some((pattern) => pattern.test(filename))),
  );
}

function requiresTradingSafetyReview(filename) {
  return Boolean(
    typeof filename === "string" &&
      (TRADING_SAFETY_EXACT_PATHS.has(filename) ||
        TRADING_SAFETY_PATH_PATTERNS.some((pattern) => pattern.test(filename))),
  );
}

function getRequiredSpecialistChecks(files) {
  const required = [];
  const filenames = files.flatMap((file) =>
    [file.filename, file.previous_filename].filter(Boolean),
  );

  if (filenames.some(requiresSecurityReview)) {
    required.push(SECURITY_CHECK_NAME);
  }
  if (filenames.some(requiresTradingSafetyReview)) {
    required.push(TRADING_SAFETY_CHECK_NAME);
  }
  return required;
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

function hasAnyBlockingLabel(pullRequest, blockingLabels) {
  const labels = getLabels(pullRequest);
  const title = pullRequest.title || "";

  return (
    [...blockingLabels].some((label) => labels.has(label)) ||
    (labels.has("docs-sync") && !title.startsWith("[docs-sync] "))
  );
}

function hasBlockingLabel(pullRequest) {
  return hasAnyBlockingLabel(pullRequest, MERGE_BLOCKING_LABELS);
}

function hasSelfHealBlockingLabel(pullRequest) {
  return hasAnyBlockingLabel(pullRequest, SELF_HEAL_BLOCKING_LABELS);
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

function getAgentApprovalState(files, checkRuns) {
  const requiredSpecialistChecks = getRequiredSpecialistChecks(files);
  const requiredChecks = [
    REVIEW_CHECK_NAME,
    ...requiredSpecialistChecks,
  ];
  const checkStates = Object.fromEntries(
    requiredChecks.map((name) => [name, getCheckState(checkRuns, name)]),
  );
  const failedCheck = requiredChecks.find(
    (name) => checkStates[name] === "failure",
  );
  const waitingCheck = requiredChecks.find(
    (name) =>
      checkStates[name] === "missing" ||
      checkStates[name] === "pending",
  );

  return {
    approved: !failedCheck && !waitingCheck,
    checkStates,
    failedCheck,
    waitingCheck,
    requiredSpecialistChecks,
  };
}

function evaluateMergePolicy({
  pullRequest,
  files,
  reviews,
  checkRuns = [],
  repository,
}) {
  const sha = pullRequest.head.sha;
  const sameRepository = isSameRepositoryPullRequest(
    pullRequest,
    repository,
  );
  const trustedAgent = isTrustedAgentPullRequest(pullRequest, repository);
  const lowRisk = isLowRiskChange(files);
  const blockingLabel = hasBlockingLabel(pullRequest);
  const selfHealBlockingLabel = hasSelfHealBlockingLabel(pullRequest);
  const agentApproval = getAgentApprovalState(files, checkRuns);
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
  } else if (blockingLabel) {
    description = "A blocking review label requires changes";
  } else if (!sameRepository) {
    description = "A current human approval is required for forked changes";
  } else if (agentApproval.failedCheck) {
    description = `${agentApproval.failedCheck} requires changes`;
  } else if (agentApproval.waitingCheck) {
    description = `Waiting for ${agentApproval.waitingCheck}`;
  } else if (agentApproval.approved) {
    state = "success";
    description = "Current-head agent reviews approve this PR";
  }

  return {
    state,
    description,
    sameRepository,
    trustedAgent,
    lowRisk,
    hasBlockingLabel: blockingLabel,
    hasSelfHealBlockingLabel: selfHealBlockingLabel,
    hasCurrentHumanApproval,
    hasCurrentHumanChangesRequested,
    agentApproved: agentApproval.approved,
    agentCheckStates: agentApproval.checkStates,
    requiredSpecialistChecks: agentApproval.requiredSpecialistChecks,
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

function targetDispatchInputs(number) {
  return {
    target: String(number),
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
    !NON_REPAIRABLE_REVIEW_CONCLUSIONS.has(reviewCheck.conclusion)
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

  const ensureCheckRun = async (
    sha,
    state,
    description,
    targetUrl,
    checkRuns,
  ) => {
    const status = state === "success" ? "completed" : "in_progress";
    const conclusion = state === "success" ? "success" : null;
    const current = latestNamedCheck(checkRuns, MERGE_CONTEXT);

    if (
      current &&
      current.status === status &&
      (current.conclusion || null) === conclusion &&
      current.output &&
      current.output.summary === description
    ) {
      return;
    }

    await github.rest.checks.create({
      owner,
      repo,
      name: MERGE_CONTEXT,
      head_sha: sha,
      status,
      ...(conclusion ? { conclusion } : {}),
      details_url: targetUrl,
      output: {
        title: MERGE_CONTEXT,
        summary: description,
      },
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
      const [
        files,
        reviews,
        commits,
        checkRuns,
        ciRuns,
        reviewRuns,
        securityRuns,
        tradingSafetyRuns,
      ] = await Promise.all([
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
          listRuns("security-review.lock.yml", sha),
          listRuns("trading-safety-review.lock.yml", sha),
        ]);

      const policy = evaluateMergePolicy({
        pullRequest,
        files,
        reviews,
        checkRuns,
        repository,
      });

      await ensureCheckRun(
        sha,
        policy.state,
        policy.description,
        pullRequest.html_url,
        checkRuns,
      );

      if (!policy.sameRepository || pullRequest.draft) {
        continue;
      }

      const ciNeedsDispatch = ciRuns.length === 0;
      const reviewNeedsDispatch = reviewRuns.length === 0;
      const ciHeld = ciRuns[0] && ciRuns[0].conclusion === "action_required";
      const reviewHeld =
        reviewRuns[0] && reviewRuns[0].conclusion === "action_required";
      const reviewShouldDispatch = reviewNeedsDispatch || reviewHeld;
      const securityRequired =
        policy.requiredSpecialistChecks.includes(SECURITY_CHECK_NAME);
      const tradingSafetyRequired =
        policy.requiredSpecialistChecks.includes(
          TRADING_SAFETY_CHECK_NAME,
        );
      const securityShouldDispatch =
        securityRequired &&
        policy.agentCheckStates[SECURITY_CHECK_NAME] !== "success" &&
        (securityRuns.length === 0 ||
          securityRuns[0].conclusion === "action_required");
      const tradingSafetyShouldDispatch =
        tradingSafetyRequired &&
        policy.agentCheckStates[TRADING_SAFETY_CHECK_NAME] !== "success" &&
        (tradingSafetyRuns.length === 0 ||
          tradingSafetyRuns[0].conclusion === "action_required");

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

      if (securityShouldDispatch) {
        await dispatch(
          "security-review.lock.yml",
          pullRequest.head.ref,
          targetDispatchInputs(number),
        );
      }

      if (tradingSafetyShouldDispatch) {
        await dispatch(
          "trading-safety-review.lock.yml",
          pullRequest.head.ref,
          targetDispatchInputs(number),
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
          hasBlockingLabel: policy.hasSelfHealBlockingLabel,
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

      if (countRepairAttempts(commits) >= MAX_REPAIR_COMMITS) {
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
  AGENTIC_POLICY,
  AUTO_MERGE_LABEL,
  BLOCKED_LABEL,
  MERGE_BLOCKING_LABELS,
  SELF_HEAL_BLOCKING_LABELS,
  EXHAUSTED_LABEL,
  LOW_RISK_STATUSES,
  MAX_REPAIR_COMMITS,
  MERGE_CONTEXT,
  REVIEW_CHECK_NAME,
  SECURITY_CHECK_NAME,
  TRUSTED_AGENT_AUTHORS,
  TRADING_SAFETY_CHECK_NAME,
  canAttemptSelfHeal,
  countRepairAttempts,
  evaluateMergePolicy,
  getAgentApprovalState,
  getCheckState,
  getRequiredSpecialistChecks,
  getReviewState,
  hasBlockingLabel,
  hasSelfHealBlockingLabel,
  hasFailedCiRun,
  hasFailedReviewCheck,
  isLowRiskChange,
  isLowRiskPath,
  isSameRepositoryPullRequest,
  isTrustedAgentPullRequest,
  pullRequestDispatchInputs,
  requiresSecurityReview,
  requiresTradingSafetyReview,
  reconcileAgenticPullRequests,
  targetDispatchInputs,
};
