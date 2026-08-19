"use strict";

const {
  CODE_REVIEW_CHECK,
  FACTORY_MODE_LABELS,
  FACTORY_MODES,
  HUMAN_BOUNDARY_APPROVAL_CHECK,
  QA_CHECK,
  RISK_TIERS,
  SECURITY_CHECK,
  TRADING_SAFETY_CHECK,
  determineRiskTier,
  areChangedFilesWithinAllowedPaths,
  areAllowedPathPatternsWithin,
  compareRiskTiers,
  getSpecialistChecks,
  isKnownRiskTier,
  maxRiskTier,
  normalizeAllowedPathPatterns,
  resolveFactoryModeFromLabels,
} = require("./agentic-factory-policy.cjs");
const {
  parseClaimPayload,
} = require("./agentic-queue-controller.cjs");

const MERGE_CONTEXT = "Agentic merge policy";
const REVIEW_CHECK_NAME = CODE_REVIEW_CHECK;
const QA_CHECK_NAME = QA_CHECK;
const SECURITY_CHECK_NAME = SECURITY_CHECK;
const TRADING_SAFETY_CHECK_NAME = TRADING_SAFETY_CHECK;
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
]);
const FAILING_CONCLUSIONS = new Set([
  "cancelled",
  "failure",
  "startup_failure",
  "timed_out",
]);
const LOW_RISK_STATUSES = new Set(["added", "modified"]);
const PASSING_CHECK_CONCLUSIONS = new Set([
  "neutral",
  "skipped",
  "success",
]);

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
  const body = pullRequest.body || "";

  return (
    isSameRepositoryPullRequest(pullRequest, repository) &&
    TRUSTED_AGENT_AUTHORS.has(pullRequest.user && pullRequest.user.login) &&
    labels.has(AUTO_MERGE_LABEL) &&
    ((pullRequest.user.login === "github-actions[bot]" &&
      title.startsWith("[docs-sync] ")) ||
      (pullRequest.user.login === "copilot-swe-agent[bot]" &&
        title.startsWith("[ai-dev] ") &&
        /<!-- factory-claim:[^>\s]+ -->/.test(body) &&
        /Refs #\d+(?!\d)/.test(body)))
  );
}

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

function getAgentImplementationReference(pullRequest) {
  const isImplementation =
    (pullRequest.user &&
      pullRequest.user.login === "copilot-swe-agent[bot]") ||
    (pullRequest.title || "").startsWith("[ai-dev] ");
  if (!isImplementation) {
    return { required: false, valid: true };
  }

  const body = typeof pullRequest.body === "string" ? pullRequest.body : "";
  const claimMatches = [
    ...body.matchAll(/<!-- factory-claim:([^>\s]+) -->/g),
  ];
  const issueMatches = [...body.matchAll(/Refs #(\d+)(?!\d)/g)];
  const issueNumbers = [
    ...new Set(issueMatches.map((match) => Number(match[1]))),
  ];
  if (claimMatches.length !== 1 || issueNumbers.length !== 1) {
    return { required: true, valid: false };
  }
  return {
    required: true,
    valid: true,
    nonce: claimMatches[0][1],
    issueNumber: issueNumbers[0],
  };

}

async function verifyAgentImplementationProvenance({
  github,
  owner,
  repo,
  pullRequest,
  core,
}) {
  const reference = getAgentImplementationReference(pullRequest);
  if (!reference.required) {
    return { valid: true };
  }
  if (!reference.valid) {
    return { valid: false };
  }

  try {
    const [{ data: issue }, comments] = await Promise.all([
      github.rest.issues.get({
        owner,
        repo,
        issue_number: reference.issueNumber,
      }),
      github.paginate(github.rest.issues.listComments, {
        owner,
        repo,
        issue_number: reference.issueNumber,
        per_page: 100,
      }),
    ]);
    const lifecycleLabels = getLabels(issue);
    if (
      ![
        "factory:claimed",
        "factory:implementing",
        "factory:pr-open",
        "factory:repairing",
      ].some((label) => lifecycleLabels.has(label))
    ) {
      return { valid: false };
    }
    const issueRiskLabels = [...lifecycleLabels].filter((label) =>
      Object.values(RISK_TIERS).includes(label),
    );
    if (issueRiskLabels.length !== 1) {
      return { valid: false };
    }
    const allowedPathResult = normalizeAllowedPathPatterns(
      getIssueFormSection(issue.body, "Allowed paths"),
    );
    if (!allowedPathResult.valid) {
      return { valid: false };
    }
    const declaredGoalNumber = Number(
      /#(\d+)/.exec(
        getIssueFormSection(issue.body, "Approved parent goal") || "",
      )?.[1],
    );
    if (!Number.isInteger(declaredGoalNumber) || declaredGoalNumber <= 0) {
      return { valid: false };
    }
    const parentResponse = await github.request(
      "GET /repos/{owner}/{repo}/issues/{issue_number}/parent",
      {
        owner,
        repo,
        issue_number: reference.issueNumber,
      },
    );
    if (
      !parentResponse.data ||
      parentResponse.data.number !== declaredGoalNumber
    ) {
      return { valid: false };
    }
    const [{ data: goal }, goalTimeline] = await Promise.all([
      github.rest.issues.get({
        owner,
        repo,
        issue_number: declaredGoalNumber,
      }),
      github.paginate(github.rest.issues.listEventsForTimeline, {
        owner,
        repo,
        issue_number: declaredGoalNumber,
        per_page: 100,
      }),
    ]);
    const goalLabels = getLabels(goal);
    if (
      goal.state !== "open" ||
      !goalLabels.has("factory:goal") ||
      !goalLabels.has("factory:goal-approved")
    ) {
      return { valid: false };
    }
    const latestGoalApproval = goalTimeline
      .filter(
        (event) =>
          event.event === "labeled" &&
          event.label &&
          event.label.name === "factory:goal-approved",
      )
      .sort(
        (left, right) =>
          Date.parse(right.created_at || "") -
          Date.parse(left.created_at || ""),
      )[0];
    if (
      !latestGoalApproval ||
      !latestGoalApproval.actor ||
      latestGoalApproval.actor.type !== "User"
    ) {
      return { valid: false };
    }
    const goalMaxRiskTier = getIssueFormSection(
      goal.body,
      "Maximum autonomous risk tier",
    );
    const goalAllowedPathResult = normalizeAllowedPathPatterns(
      getIssueFormSection(goal.body, "Allowed paths"),
    );
    if (
      !isKnownRiskTier(goalMaxRiskTier) ||
      !goalAllowedPathResult.valid ||
      !areAllowedPathPatternsWithin(
        allowedPathResult.patterns,
        goalAllowedPathResult.patterns,
      )
    ) {
      return { valid: false };
    }

    const latest = comments
      .filter(
        (comment) =>
          comment.user &&
          comment.user.login === "github-actions[bot]" &&
          typeof comment.body === "string" &&
          comment.body.includes("<!-- factory-claim:v1 "),
      )
      .sort(
        (left, right) =>
          Date.parse(right.created_at || "") -
            Date.parse(left.created_at || "") ||
          (right.id || 0) - (left.id || 0),
      )[0];
    if (!latest) {
      return { valid: false };
    }
    const match = /<!-- factory-claim:v1 (.+?) -->/s.exec(latest.body);
    if (!match) {
      return { valid: false };
    }
    const parsed = parseClaimPayload(match[1]);
    return {
      valid: Boolean(
        parsed.valid &&
        parsed.claim.issueNumber === reference.issueNumber &&
        parsed.claim.nonce === reference.nonce,
      ),
      riskLabel: issueRiskLabels[0],
      allowedPaths: allowedPathResult.patterns,
      goalMaxRiskTier,
    };
  } catch (error) {
    core.warning(
      `Could not verify factory claim provenance for PR #${pullRequest.number}: ${getErrorMessage(error)}`,
    );
    return { valid: false };
  }
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

function requiresSecurityReview(filename) {
  return require("./agentic-factory-policy.cjs").requiresSecurityCheck(filename);
}

function requiresTradingSafetyReview(filename) {
  return require("./agentic-factory-policy.cjs").requiresTradingSafetyCheck(
    filename,
  );
}

function getRequiredSpecialistChecks(files) {
  return getSpecialistChecks(files);
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

function getPolicyFiles(files) {
  return files.flatMap((file) => {
    const entries = [file];
    if (file.previous_filename) {
      entries.push({
        filename: file.previous_filename,
        status: file.status,
      });
    }
    return entries;
  });
}

function getDeclaredRiskLabel(pullRequest) {
  const labels = getLabels(pullRequest);
  if (labels.has("ready-for-human-review")) {
    return RISK_TIERS.BOUNDARY;
  }
  const riskLabels = [...labels].filter((label) =>
    Object.values(RISK_TIERS).includes(label),
  );
  if (riskLabels.length === 0) {
    return undefined;
  }
  return riskLabels.length === 1 ? riskLabels[0] : "risk:invalid";
}

function getRequestedChecks(pullRequest) {
  const labels = getLabels(pullRequest);
  return [
    ...(labels.has("needs-qa") ? [QA_CHECK_NAME] : []),
    ...(labels.has("security-review") ? [SECURITY_CHECK_NAME] : []),
    ...(labels.has("trading-safety") ? [TRADING_SAFETY_CHECK_NAME] : []),
  ];
}

function getAgentApprovalState(
  files,
  checkRuns,
  declaredRiskLabel,
  requestedChecks = [],
) {
  const riskPolicy = determineRiskTier({
    files: getPolicyFiles(files),
    issueRiskLabel: declaredRiskLabel,
  });
  const observedSpecialistChecks = [
    QA_CHECK_NAME,
    SECURITY_CHECK_NAME,
    TRADING_SAFETY_CHECK_NAME,
  ].filter((name) => latestNamedCheck(checkRuns, name));
  const requiredSpecialistChecks = [
    ...(riskPolicy.tier === RISK_TIERS.ROUTINE ? [] : [QA_CHECK_NAME]),
    ...getRequiredSpecialistChecks(files),
    ...requestedChecks,
    ...observedSpecialistChecks,
  ];
  const deduplicatedSpecialistChecks = [...new Set(requiredSpecialistChecks)];
  const requiredChecks = [
    REVIEW_CHECK_NAME,
    ...deduplicatedSpecialistChecks,
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
    requiredSpecialistChecks: deduplicatedSpecialistChecks,
    riskTier: riskPolicy.tier,
    riskReasons: riskPolicy.reasons,
    requiresHumanBoundaryApproval:
      riskPolicy.requiresHumanBoundaryApproval,
  };
}

function evaluateMergePolicy({
  pullRequest,
  files,
  reviews,
  checkRuns = [],
  repository,
  factoryMode = FACTORY_MODES.ACTIVE,
  agentImplementationProvenance = true,
  issueRiskLabel,
  issueAllowedPaths,
  goalMaxRiskTier,
}) {
  const sha = pullRequest.head.sha;
  const sameRepository = isSameRepositoryPullRequest(
    pullRequest,
    repository,
  );
  const requiresVerifiedAgentProvenance =
    getAgentImplementationReference(pullRequest).required;
  const implementationScopeValid =
    !requiresVerifiedAgentProvenance ||
    areChangedFilesWithinAllowedPaths(files, issueAllowedPaths);
  const trustedAgent =
    isTrustedAgentPullRequest(pullRequest, repository) &&
    agentImplementationProvenance;
  const factoryEnrolled = getLabels(pullRequest).has(AUTO_MERGE_LABEL);
  const factoryModeBlocksAction =
    factoryEnrolled && factoryMode !== FACTORY_MODES.ACTIVE;
  const lowRisk = isLowRiskChange(files);
  const hardBlockingLabel = hasBlockingLabel(pullRequest);
  const requestedChecks = getRequestedChecks(pullRequest);
  const prRiskLabel = getDeclaredRiskLabel(pullRequest);
  const declaredRiskLabel =
    issueRiskLabel === undefined
      ? prRiskLabel
      : prRiskLabel === undefined
        ? issueRiskLabel
        : maxRiskTier(prRiskLabel, issueRiskLabel);
  const agentApproval = getAgentApprovalState(
    files,
    checkRuns,
    declaredRiskLabel,
    requestedChecks,
  );
  const unresolvedRequestedCheck = requestedChecks.some(
    (name) => agentApproval.checkStates[name] !== "success",
  );
  const blockingLabel = hardBlockingLabel || unresolvedRequestedCheck;
  const riskExceedsGoal =
    requiresVerifiedAgentProvenance &&
    agentImplementationProvenance &&
    (!isKnownRiskTier(goalMaxRiskTier) ||
      compareRiskTiers(agentApproval.riskTier, goalMaxRiskTier) > 0);
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
  } else if (hardBlockingLabel) {
    description = "A blocking review label requires changes";
  } else if (
    requiresVerifiedAgentProvenance &&
    !agentImplementationProvenance
  ) {
    description = "Factory claim provenance is invalid";
  } else if (!implementationScopeValid) {
    description = "PR changes escape issue allowed paths";
  } else if (riskExceedsGoal) {
    description = "PR risk exceeds approved goal";
  } else if (factoryModeBlocksAction) {
    description =
      factoryMode === FACTORY_MODES.SHADOW
        ? "Factory shadow mode does not authorize merge"
        : "Factory is paused";
  } else if (!sameRepository) {
    if (hasCurrentHumanApproval) {
      state = "success";
      description = "Current human approval satisfies fork policy";
    } else {
      description = "A current human approval is required for forked changes";
    }
  } else if (agentApproval.failedCheck) {
    description = `${agentApproval.failedCheck} requires changes`;
  } else if (agentApproval.waitingCheck) {
    description = `Waiting for ${agentApproval.waitingCheck}`;
  } else if (
    agentApproval.requiresHumanBoundaryApproval &&
    !hasCurrentHumanApproval
  ) {
    description = "Boundary change requires current human approval";
  } else if (agentApproval.approved) {
    state = "success";
    description = agentApproval.requiresHumanBoundaryApproval
      ? "Current-head human and agent reviews approve boundary PR"
      : "Current-head agent reviews approve this PR";
  }

  return {
    state,
    description,
    sameRepository,
    trustedAgent,
    agentImplementationProvenance,
    requiresVerifiedAgentProvenance,
    implementationScopeValid,
    riskExceedsGoal,
    factoryMode,
    factoryModeBlocksAction,
    lowRisk,
    hasBlockingLabel: blockingLabel,
    hasCurrentHumanApproval,
    hasCurrentHumanChangesRequested,
    agentApproved: agentApproval.approved,
    agentCheckStates: agentApproval.checkStates,
    requiredSpecialistChecks: agentApproval.requiredSpecialistChecks,
    riskTier: agentApproval.riskTier,
    riskReasons: agentApproval.riskReasons,
    requiresHumanBoundaryApproval:
      agentApproval.requiresHumanBoundaryApproval,
  };
}

function canAttemptSelfHeal({
  sameRepository,
  draft,
  trustedAgent,
  lowRisk,
  riskTier,
  hasBlockingLabel: blockingLabel,
  ciNeedsDispatch,
  reviewShouldDispatch,
  ciHeld,
  reviewHeld,
  specialistReviewPending = false,
}) {
  const effectiveRiskTier =
    riskTier || (lowRisk ? RISK_TIERS.ROUTINE : RISK_TIERS.BOUNDARY);
  return (
    sameRepository &&
    !draft &&
    trustedAgent &&
    getRepairAttemptLimit(effectiveRiskTier) > 0 &&
    !blockingLabel &&
    !ciNeedsDispatch &&
    !reviewShouldDispatch &&
    !ciHeld &&
    !reviewHeld &&
    !specialistReviewPending
  );
}

function getRepairAttemptLimit(riskTier) {
  if (riskTier === RISK_TIERS.ROUTINE) {
    return 2;
  }
  if (riskTier === RISK_TIERS.SENSITIVE) {
    return 1;
  }
  return 0;
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
  let factoryMode = FACTORY_MODES.PAUSED;
  let factoryControlIssue;
  try {
    const controlIssues = await github.paginate(
      github.rest.issues.listForRepo,
      {
        owner,
        repo,
        state: "open",
        labels: "factory-control",
        per_page: 100,
      },
    );
    if (controlIssues.length === 1) {
      factoryControlIssue = controlIssues[0];
      factoryMode = resolveFactoryModeFromLabels(controlIssues[0].labels);
      if (factoryMode === FACTORY_MODES.ACTIVE) {
        const timeline = await github.paginate(
          github.rest.issues.listEventsForTimeline,
          {
            owner,
            repo,
            issue_number: controlIssues[0].number,
            per_page: 100,
          },
        );
        const activeEvents = timeline
          .filter(
            (event) =>
              event.event === "labeled" &&
              event.label &&
              event.label.name === "factory-mode:active",
          )
          .sort(
            (left, right) =>
              Date.parse(right.created_at || "") -
              Date.parse(left.created_at || ""),
          );
        if (
          activeEvents.length === 0 ||
          !activeEvents[0].actor ||
          activeEvents[0].actor.type !== "User"
        ) {
          factoryMode = FACTORY_MODES.PAUSED;
          core.warning(
            "Factory active mode lacks a current human label event; keeping enrolled PRs paused.",
          );
        }
      }
    } else {
      core.warning(
        `Expected exactly one open factory-control issue; found ${controlIssues.length}.`,
      );
    }
  } catch (error) {
    core.warning(
      `Could not resolve factory mode; keeping enrolled PRs paused: ${getErrorMessage(error)}`,
    );
  }

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

  const ensureStatus = async (
    sha,
    state,
    description,
    targetUrl,
    contextName = MERGE_CONTEXT,
  ) => {
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
      (status) => status.context === contextName,
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
      context: contextName,
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

  let factoryPausedThisRun = false;
  const pauseFactoryControl = async (controlIssue, reason) => {
    if (factoryPausedThisRun || factoryMode !== FACTORY_MODES.ACTIVE) {
      return;
    }
    if (!controlIssue) {
      core.warning(`Cannot pause factory without one control issue: ${reason}`);
      return;
    }
    const labels = getLabels(controlIssue);
    for (const label of labels) {
      if (Object.hasOwn(FACTORY_MODE_LABELS, label)) {
        try {
          await github.rest.issues.removeLabel({
            owner,
            repo,
            issue_number: controlIssue.number,
            name: label,
          });
        } catch (error) {
          if (getErrorStatus(error) !== 404) {
            core.warning(
              `Could not remove ${label} while pausing factory: ${getErrorMessage(error)}`,
            );
          }
        }
      }
    }
    await github.rest.issues.addLabels({
      owner,
      repo,
      issue_number: controlIssue.number,
      labels: ["factory-mode:paused"],
    });
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: controlIssue.number,
      body: [
        "<!-- agentic-pr-reconciler:v1 factory-pause -->",
        "**Factory paused by PR reconciler**",
        `- Reason: ${reason}`,
        "- Automation cannot unpause; a human must restore `factory-mode:active`.",
      ].join("\n"),
    });
    factoryPausedThisRun = true;
    factoryMode = FACTORY_MODES.PAUSED;
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
        qaRuns,
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
          listRuns("qa-test-plan.lock.yml", sha),
          listRuns("security-review.lock.yml", sha),
          listRuns("trading-safety-review.lock.yml", sha),
        ]);

      const implementationProvenance =
        await verifyAgentImplementationProvenance({
          github,
          owner,
          repo,
          pullRequest,
          core,
        });
      const policy = evaluateMergePolicy({
        pullRequest,
        files,
        reviews,
        checkRuns,
        repository,
        factoryMode,
        agentImplementationProvenance:
          implementationProvenance.valid,
        issueRiskLabel: implementationProvenance.riskLabel,
        issueAllowedPaths: implementationProvenance.allowedPaths,
        goalMaxRiskTier: implementationProvenance.goalMaxRiskTier,
      });

      await ensureStatus(
        sha,
        policy.state,
        policy.description,
        pullRequest.html_url,
      );
      if (policy.requiresHumanBoundaryApproval) {
        await ensureStatus(
          sha,
          policy.hasCurrentHumanApproval &&
            !policy.hasCurrentHumanChangesRequested
            ? "success"
            : "pending",
          policy.hasCurrentHumanApproval
            ? "Current-head human approval satisfies boundary policy"
            : "Boundary change requires current-head human approval",
          pullRequest.html_url,
          HUMAN_BOUNDARY_APPROVAL_CHECK,
        );
      }

      if (
        !policy.sameRepository ||
        pullRequest.draft ||
        policy.factoryModeBlocksAction
      ) {
        continue;
      }
      if (policy.requiresHumanBoundaryApproval) {
        await addLabels(pullRequest, ["ready-for-human-review"]);
      }
      if (policy.riskExceedsGoal) {
        await pauseFactoryControl(
          factoryControlIssue,
          `PR #${number} risk ${policy.riskTier} exceeds its approved goal ceiling.`,
        );
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
      const qaRequired =
        policy.requiredSpecialistChecks.includes(QA_CHECK_NAME);
      const tradingSafetyRequired =
        policy.requiredSpecialistChecks.includes(
          TRADING_SAFETY_CHECK_NAME,
        );
      const securityShouldDispatch =
        securityRequired &&
        policy.agentCheckStates[SECURITY_CHECK_NAME] !== "success" &&
        (securityRuns.length === 0 ||
          securityRuns[0].conclusion === "action_required");
      const qaShouldDispatch =
        qaRequired &&
        policy.agentCheckStates[QA_CHECK_NAME] !== "success" &&
        (qaRuns.length === 0 ||
          qaRuns[0].conclusion === "action_required");
      const tradingSafetyShouldDispatch =
        tradingSafetyRequired &&
        policy.agentCheckStates[TRADING_SAFETY_CHECK_NAME] !== "success" &&
        (tradingSafetyRuns.length === 0 ||
          tradingSafetyRuns[0].conclusion === "action_required");
      const specialistReviewPending = policy.requiredSpecialistChecks.some(
        (name) =>
          policy.agentCheckStates[name] === "missing" ||
          policy.agentCheckStates[name] === "pending",
      );

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

      if (qaShouldDispatch) {
        await dispatch(
          "qa-test-plan.lock.yml",
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
          riskTier: policy.riskTier,
          hasBlockingLabel: policy.hasBlockingLabel,
          ciNeedsDispatch,
          reviewShouldDispatch,
          ciHeld,
          reviewHeld,
          specialistReviewPending,
        })
      ) {
        continue;
      }

      const ciFailure = hasFailedCiRun(ciRuns);
      const reviewFailure =
        hasFailedReviewCheck(checkRuns) ||
        policy.requiredSpecialistChecks.some(
          (name) => policy.agentCheckStates[name] === "failure",
        );
      if (!ciFailure && !reviewFailure) {
        continue;
      }

      const repairAttemptLimit = getRepairAttemptLimit(policy.riskTier);
      if (countRepairAttempts(commits) >= repairAttemptLimit) {
        await addLabels(pullRequest, [EXHAUSTED_LABEL, BLOCKED_LABEL]);
        await pauseFactoryControl(
          factoryControlIssue,
          `PR #${number} exhausted its autonomous repair budget.`,
        );
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
        await pauseFactoryControl(
          factoryControlIssue,
          `PR #${number} completed a repair run without producing a recoverable head.`,
        );
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
  QA_CHECK_NAME,
  REVIEW_CHECK_NAME,
  SECURITY_CHECK_NAME,
  TRUSTED_AGENT_AUTHORS,
  TRADING_SAFETY_CHECK_NAME,
  canAttemptSelfHeal,
  countRepairAttempts,
  evaluateMergePolicy,
  getAgentApprovalState,
  getCheckState,
  getDeclaredRiskLabel,
  getAgentImplementationReference,
  getIssueFormSection,
  getPolicyFiles,
  getRequestedChecks,
  getRepairAttemptLimit,
  getRequiredSpecialistChecks,
  getReviewState,
  hasBlockingLabel,
  hasFailedCiRun,
  hasFailedReviewCheck,
  isLowRiskChange,
  isLowRiskPath,
  isSameRepositoryPullRequest,
  isTrustedAgentPullRequest,
  verifyAgentImplementationProvenance,
  pullRequestDispatchInputs,
  requiresSecurityReview,
  requiresTradingSafetyReview,
  reconcileAgenticPullRequests,
  targetDispatchInputs,
};
