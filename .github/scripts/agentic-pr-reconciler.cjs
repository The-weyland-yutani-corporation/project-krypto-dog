"use strict";

const { AGENTIC_POLICY } = require("./agentic-policy.cjs");
const {
  CODE_REVIEW_CHECK,
  FACTORY_MODE_LABELS,
  FACTORY_MODES,
  HUMAN_BOUNDARY_APPROVAL_CHECK,
  QA_CHECK,
  RISK_TIERS,
  SECURITY_CHECK,
  TRADING_SAFETY_CHECK,
  areAllowedPathPatternsWithin,
  areChangedFilesWithinAllowedPaths,
  compareRiskTiers,
  determineRiskTier,
  isKnownRiskTier,
  maxRiskTier,
  normalizeAllowedPathPatterns,
  resolveFactoryModeFromLabels,
} = require("./agentic-factory-policy.cjs");
const {
  AgenticIdentityError,
  isGitHubActionsBot,
  isResolvedCopilotActor,
  normalizeConfiguredUserNodeId,
  resolveRepositoryCopilotIdentity,
} = require("./agentic-identity.cjs");
const {
  resolveLatestIssueClaim,
  verifyPersistedAssignmentProvenance,
} = require("./agentic-lifecycle-reconciler.cjs");
const {
  DISPATCH_MARKER,
  DISPATCH_LEASE_MS,
  REVIEW_MARKER,
  REVIEW_WORKFLOWS,
  EvidenceError,
  ciFingerprint,
  collectCiEvidence,
  dispatchReservation,
  getDeclaredRiskLabel,
  getPolicyFiles,
  getRequestedChecks,
  hasNewerReviewAttempt,
  infrastructureRetryDecision,
  isBoundCiRun,
  isBoundReviewRun,
  latestBoundReviewRun,
  markIncompleteReviewAttempt,
  readPages,
  receipt,
  reviewDispatchDecision,
  semanticReviewOutcome,
  trustedReviewSource,
} = require("./agentic-review-evidence.cjs");

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
  securityExactPaths: SECURITY_EXACT_PATHS,
  securityPathPatterns: SECURITY_PATH_PATTERNS,
  selfHealBlockingLabels: SELF_HEAL_BLOCKING_LABELS,
  sensitiveTokenPattern: SENSITIVE_DOC_TOKEN_PATTERN,
  tradingSafetyExactPaths: TRADING_SAFETY_EXACT_PATHS,
  tradingSafetyPathPatterns: TRADING_SAFETY_PATH_PATTERNS,
  trustedAgentAuthors: TRUSTED_AGENT_AUTHORS,
  trustedReviewAssociations: TRUSTED_REVIEW_ASSOCIATIONS,
} = AGENTIC_POLICY;

const REVIEW_CHECK_NAME = CODE_REVIEW_CHECK;
const QA_CHECK_NAME = QA_CHECK;
const SECURITY_CHECK_NAME = SECURITY_CHECK;
const TRADING_SAFETY_CHECK_NAME = TRADING_SAFETY_CHECK;

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

function isTrustedAgentPullRequest(
  pullRequest,
  repository,
  copilotIdentity,
) {
  const labels = getLabels(pullRequest);
  const title = pullRequest.title || "";
  const body = pullRequest.body || "";

  const actionsAuthor =
    isGitHubActionsBot(pullRequest.user) &&
    TRUSTED_AGENT_AUTHORS.has(pullRequest.user.login);
  const copilotAuthor = isResolvedCopilotActor(
    pullRequest.user,
    copilotIdentity,
  );
  return (
    isSameRepositoryPullRequest(pullRequest, repository) &&
    labels.has(AUTO_MERGE_LABEL) &&
    ((actionsAuthor &&
      title.startsWith("[docs-sync] ")) ||
      (copilotAuthor &&
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

function getAgentImplementationReference(pullRequest, copilotIdentity) {
  const isImplementation =
    isResolvedCopilotActor(pullRequest.user, copilotIdentity) ||
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
  copilotIdentity,
  assignmentActorNodeId,
  allPullRequests,
}) {
  const reference = getAgentImplementationReference(
    pullRequest,
    copilotIdentity,
  );
  if (!reference.required) {
    return { valid: true };
  }
  if (!reference.valid) {
    return { valid: false };
  }
  const correlated = (Array.isArray(allPullRequests)
    ? allPullRequests
    : []
  ).filter((candidate) => {
    const body =
      typeof candidate.body === "string" ? candidate.body : "";
    return body.includes(
      `<!-- factory-claim:${reference.nonce} -->`,
    );
  });
  if (
    correlated.length !== 1 ||
    correlated[0].number !== pullRequest.number
  ) {
    return {
      valid: false,
      pauseFactory: true,
      reason:
        correlated.length > 1
          ? "duplicate-pull-request-candidates"
          : "correlated-pull-request-mismatch",
    };
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

    const claim = resolveLatestIssueClaim(
      comments,
      reference.issueNumber,
    );
    if (
      claim.state !== "valid" ||
      claim.claim.issueNumber !== reference.issueNumber ||
      claim.claim.nonce !== reference.nonce
    ) {
      return { valid: false, reason: claim.reason };
    }
    const assignment = await verifyPersistedAssignmentProvenance({
      github,
      owner,
      repo,
      issue,
      comments,
      claim: claim.claim,
      now: new Date().toISOString(),
      copilotIdentity,
      assignmentActorNodeId,
    });
    return {
      valid: assignment.valid,
      pauseFactory: !assignment.valid,
      reason: assignment.reason,
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
  const filenames = files.flatMap((file) =>
    [file.filename, file.previous_filename].filter(Boolean),
  );
  return [
    ...(filenames.some(requiresSecurityReview) ? [SECURITY_CHECK_NAME] : []),
    ...(filenames.some(requiresTradingSafetyReview)
      ? [TRADING_SAFETY_CHECK_NAME]
      : []),
  ];
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
  if (checkRuns.some((check) => check.name === name &&
      check.status === "completed" && check.conclusion === "failure")) {
    return "failure";
  }
  const check = latestNamedCheck(checkRuns, name);
  if (!check) {
    return "missing";
  }
  if (check.status !== "completed") {
    return "pending";
  }
  if (check.conclusion === "action_required") return "pending";
  return PASSING_CHECK_CONCLUSIONS.has(check.conclusion)
    ? "success"
    : "failure";
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
  copilotIdentity,
}) {
  const sha = pullRequest.head.sha;
  const sameRepository = isSameRepositoryPullRequest(
    pullRequest,
    repository,
  );
  const requiresVerifiedAgentProvenance =
    getAgentImplementationReference(pullRequest, copilotIdentity).required;
  const implementationScopeValid =
    !requiresVerifiedAgentProvenance ||
    areChangedFilesWithinAllowedPaths(files, issueAllowedPaths);
  const trustedAgent =
    isTrustedAgentPullRequest(
      pullRequest,
      repository,
      copilotIdentity,
    ) &&
    agentImplementationProvenance;
  const factoryEnrolled = getLabels(pullRequest).has(AUTO_MERGE_LABEL);
  const factoryModeBlocksAction =
    factoryEnrolled && factoryMode !== FACTORY_MODES.ACTIVE;
  const lowRisk = isLowRiskChange(files);
  const hardBlockingLabel = hasBlockingLabel(pullRequest);
  const selfHealBlockingLabel = hasSelfHealBlockingLabel(pullRequest);
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
    hasSelfHealBlockingLabel: selfHealBlockingLabel,
    hasSelfHealBlockingLabel: selfHealBlockingLabel,
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

function countRepairAttempts(commits, copilotIdentity) {
  return commits.filter(
    (commit) =>
      (isGitHubActionsBot(commit.author) ||
        isResolvedCopilotActor(commit.author, copilotIdentity)) &&
      commit.commit &&
      typeof commit.commit.message === "string" &&
      commit.commit.message.includes("[self-heal]"),
  ).length;
}

function dispatchCorrelationId(workflowId, number, sha) {
  return `agentic-pr:${number}:${sha}:${workflowId}`;
}

function dispatchMetadata(workflowId, number, sha) {
  return {
    head_sha: sha,
    correlation_id: dispatchCorrelationId(workflowId, number, sha),
  };
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

async function reconcileAgenticPullRequests({
  github,
  context,
  core,
  assignmentActorNodeId,
}) {
  const { owner, repo } = context.repo;
  const repository = `${owner}/${repo}`;
  const defaultBranch =
    (context.payload &&
      context.payload.repository &&
      context.payload.repository.default_branch) ||
    context.repo.default_branch;
  if (!defaultBranch) {
    throw new Error("Repository default branch is unavailable");
  }

  const allPullRequests = await github.paginate(github.rest.pulls.list, {
    owner,
    repo,
    state: "all",
    per_page: 100,
  });
  const pullRequests = allPullRequests.filter(
    (pullRequest) => pullRequest.state === "open",
  );
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

  const listRuns = async (workflowId, headSha, pullNumber, createdAt) => {
      const runs = await readPages(github.rest.actions.listWorkflowRuns, {
        owner,
        repo,
        workflow_id: workflowId,
        ...(createdAt ? { created: `>=${createdAt}` } : {}),
      }, "workflow_runs");
      const correlationId = dispatchCorrelationId(
        workflowId,
        pullNumber,
        headSha,
      );
      return runs
        .filter(
          (run) =>
            run.head_sha === headSha ||
            (run.display_title === correlationId &&
              run.head_branch === defaultBranch &&
              run.event === "workflow_dispatch"),
        )
        .sort((left, right) => right.id - left.id);
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
        throw new EvidenceError("access_unavailable", `human reviews for PR #${pullNumber}`);
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
    contextName = MERGE_CONTEXT,
  ) => {
    const status = state === "success" ? "completed" : "in_progress";
    const conclusion = state === "success" ? "success" : null;
    const namedChecks = checkRuns
      .filter((check) => check.name === contextName)
      .sort((left, right) => right.id - left.id);
    const current = namedChecks[0];
    const currentMatches =
      current &&
      current.status === status &&
      (current.conclusion || null) === conclusion &&
      current.output &&
      current.output.summary === description;

    const desiredCheck = {
      name: contextName,
      status,
      conclusion,
      details_url: targetUrl,
      output: {
        title: contextName,
        summary: description,
      },
    };
    const input = {
      owner,
      repo,
      name: desiredCheck.name,
      status,
      ...(conclusion ? { conclusion } : {}),
      details_url: targetUrl,
      output: desiredCheck.output,
    };

    let resolvedCurrent = current;
    if (currentMatches) {
      resolvedCurrent = current;
    } else if (!current || current.status === "completed") {
      const response = await github.rest.checks.create({
        ...input,
        head_sha: sha,
      });
      const created =
        response && response.data
          ? response.data
          : {
              id:
                Math.max(0, ...checkRuns.map((check) => Number(check.id) || 0)) +
                1,
              ...desiredCheck,
            };
      checkRuns.push(created);
      resolvedCurrent = created;
    } else {
      const response = await github.rest.checks.update({
        ...input,
        check_run_id: current.id,
      });
      Object.assign(current, desiredCheck, response && response.data);
      resolvedCurrent = current;
    }

    for (const stale of namedChecks.slice(1)) {
      if (stale.status === "completed") {
        continue;
      }
      await github.rest.checks.update({
        owner,
        repo,
        check_run_id: stale.id,
        name: contextName,
        status: "completed",
        conclusion: "cancelled",
        details_url: stale.details_url || targetUrl,
        output: {
          title: contextName,
          summary: "Superseded by a newer reconciliation for this head",
        },
      });
      Object.assign(stale, {
        status: "completed",
        conclusion: "cancelled",
        output: {
          title: contextName,
          summary: "Superseded by a newer reconciliation for this head",
        },
      });
    }

    return resolvedCurrent;
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

  const hasCopilotCandidate = pullRequests.some(
    (pullRequest) =>
      (pullRequest.title || "").startsWith("[ai-dev] ") ||
      (pullRequest.user &&
        pullRequest.user.type === "Bot" &&
        pullRequest.user.login !== "github-actions[bot]"),
  );
  let copilotIdentity;
  let configuredAssignmentActorNodeId;
  if (hasCopilotCandidate && factoryMode === FACTORY_MODES.ACTIVE) {
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
      await pauseFactoryControl(
        factoryControlIssue,
        `Canonical Copilot identity resolution failed (${code}).`,
      );
      throw new Error(
        "Canonical Copilot identity could not be established for PR reconciliation",
      );
    }
  }

  const reconciliationErrors = [];
  const recordReconciliationError = (pullRequest, error) => {
    const message = `Failed to reconcile PR #${pullRequest.number}: ${getErrorMessage(error)}`;
    core.warning(message);
    reconciliationErrors.push(new Error(message));
  };

  for (const pullRequest of pullRequests) {
    try {
      const number = pullRequest.number;
      const { data: livePull } = await github.rest.pulls.get({
        owner, repo, pull_number: number,
      });
      if (livePull.state !== "open") continue;
      Object.assign(pullRequest, livePull);
      const sha = pullRequest.head.sha;
      const [
        files,
        reviews,
        commits,
        rawCheckRuns,
        ciRuns,
        rawReviewRuns,
        rawQaRuns,
        rawSecurityRuns,
        rawTradingSafetyRuns,
      ] = await Promise.all([
          readPages(github.rest.pulls.listFiles, {
            owner,
            repo,
            pull_number: number,
          }, undefined, pullRequest.changed_files),
          listReviews(number),
          github.paginate(github.rest.pulls.listCommits, {
            owner,
            repo,
            pull_number: number,
            per_page: 100,
          }),
          readPages(github.rest.checks.listForRef, {
            owner,
            repo,
            ref: sha,
            filter: "all",
          }, "check_runs"),
          listRuns("ci.yml", sha, number, pullRequest.created_at),
          listRuns("code-review.lock.yml", sha, number, pullRequest.created_at),
          listRuns("qa-test-plan.lock.yml", sha, number, pullRequest.created_at),
          listRuns("security-review.lock.yml", sha, number, pullRequest.created_at),
          listRuns("trading-safety-review.lock.yml", sha, number, pullRequest.created_at),
        ]);
      const allRunsByCheck = {
        [REVIEW_CHECK_NAME]: rawReviewRuns,
        [QA_CHECK_NAME]: rawQaRuns,
        [SECURITY_CHECK_NAME]: rawSecurityRuns,
        [TRADING_SAFETY_CHECK_NAME]: rawTradingSafetyRuns,
      };
      const runsByCheck = Object.fromEntries(Object.entries(allRunsByCheck).map(([name, runs]) => [
        name, runs.filter((run) =>
          isBoundReviewRun(run, name, sha, number, repository, defaultBranch) ||
          (run.event === "pull_request" && run.head_sha === sha &&
            run.path === `.github/workflows/${REVIEW_WORKFLOWS[name]}` &&
            run.repository?.full_name?.toLowerCase() === repository.toLowerCase())),
      ]));
      const checkRuns = rawCheckRuns
        .filter((check) => check.head_sha === sha && check.app?.slug === "github-actions")
        .map((check) => {
          if (!REVIEW_WORKFLOWS[check.name] || check.conclusion !== "success") return check;
          const proof = receipt(check, REVIEW_MARKER);
          const current = semanticReviewOutcome(check, sha) === "pass" &&
            trustedReviewSource(check, runsByCheck[check.name], repository, defaultBranch) &&
            !hasNewerReviewAttempt(check, runsByCheck[check.name], repository, defaultBranch) &&
            (check.name === REVIEW_CHECK_NAME || proof.ciFingerprint === ciFingerprint(rawCheckRuns, sha));
          return current ? check : { ...check, status: "in_progress", conclusion: null };
        });
      let ciEvidence;
      try {
        ciEvidence = await collectCiEvidence(github, {
          ...context, payload: { ...context.payload, repository: {
            ...context.payload?.repository, default_branch: defaultBranch,
          } },
        }, sha, rawCheckRuns);
      } catch (error) {
        if (!(error instanceof EvidenceError)) throw error;
        core.warning(`PR #${number} CI evidence unavailable: ${error.message}`);
        ciEvidence = { complete: false, state: "unavailable" };
      }
      const latestCiDispatch = ciRuns.filter((run) =>
        isBoundCiRun(run, sha, number, repository, defaultBranch))
        .sort((left, right) => right.id - left.id || right.run_attempt - left.run_attempt)[0];
      if (latestCiDispatch && ciEvidence.complete && ciEvidence.checks.some((check) =>
        check.runId < latestCiDispatch.id ||
        (check.runId === latestCiDispatch.id && check.runAttempt < latestCiDispatch.run_attempt))) {
        ciEvidence = { ...ciEvidence, complete: false, state: "unavailable" };
      }
      const assertCurrentHead = async () => {
        const { data: current } = await github.rest.pulls.get({ owner, repo, pull_number: number });
        if (current.state !== "open" || current.head.sha !== sha ||
            current.base?.sha !== pullRequest.base?.sha) {
          throw new Error(`PR #${number} changed while reconciling; no stale-head dispatch is permitted`);
        }
        return current;
      };
      const currentPull = await assertCurrentHead();
      Object.assign(pullRequest, currentPull);

      const implementationProvenance =
        await verifyAgentImplementationProvenance({
          github,
          owner,
          repo,
          pullRequest,
          core,
          copilotIdentity,
          assignmentActorNodeId: configuredAssignmentActorNodeId,
          allPullRequests,
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
        copilotIdentity,
      });
      if (policy.state === "success" && (!ciEvidence.complete || ciEvidence.state !== "success")) {
        policy.state = "pending";
        policy.description = "Waiting for successful trusted current-head CI evidence";
      }

      if (policy.requiresHumanBoundaryApproval) {
        await ensureCheckRun(
          sha,
          policy.hasCurrentHumanApproval &&
            !policy.hasCurrentHumanChangesRequested
            ? "success"
            : "pending",
          policy.hasCurrentHumanApproval
            ? "Current-head human approval satisfies boundary policy"
            : "Boundary change requires current-head human approval",
          pullRequest.html_url,
          checkRuns,
          HUMAN_BOUNDARY_APPROVAL_CHECK,
        );
      }

      if (implementationProvenance.pauseFactory) {
        await ensureCheckRun(
          sha,
          policy.state,
          policy.description,
          pullRequest.html_url,
          checkRuns,
        );
        await pauseFactoryControl(
          factoryControlIssue,
          `PR #${number} has invalid assignment/PR provenance (${implementationProvenance.reason || "unknown"}).`,
        );
        continue;
      }
      if (
        policy.requiresVerifiedAgentProvenance &&
        !implementationProvenance.valid
      ) {
        await ensureCheckRun(
          sha,
          policy.state,
          policy.description,
          pullRequest.html_url,
          checkRuns,
        );
        continue;
      }

      const policyOperationsBlocked =
        !policy.sameRepository ||
        pullRequest.draft ||
        policy.factoryModeBlocksAction;
      if (policyOperationsBlocked) {
        await ensureCheckRun(
          sha,
          policy.state,
          policy.description,
          pullRequest.html_url,
          checkRuns,
        );
        continue;
      }

      let policyWriteFailed = false;
      const runPolicyOperation = async (operation) => {
        try {
          await operation();
          return true;
        } catch (error) {
          policyWriteFailed = true;
          recordReconciliationError(pullRequest, error);
          return false;
        }
      };
      for (const checkName of [REVIEW_CHECK_NAME, ...policy.requiredSpecialistChecks]) {
        await runPolicyOperation(async () => {
          const run = latestBoundReviewRun(runsByCheck[checkName], checkName, sha, number, repository, defaultBranch);
          const updated = await markIncompleteReviewAttempt({
            github, context, checkName, sha, number, run, checks: rawCheckRuns, defaultBranch,
          });
          if (updated) {
            const existing = checkRuns.find((check) => check.id === updated.id);
            if (existing) Object.assign(existing, updated);
            else checkRuns.push(updated);
          }
        });
      }
      const humanBoundaryLabelNeeded =
        policy.requiresHumanBoundaryApproval &&
        !getLabels(pullRequest).has("ready-for-human-review");
      const addHumanBoundaryLabel = async () => {
        if (!humanBoundaryLabelNeeded) {
          return true;
        }
        return runPolicyOperation(() =>
          addLabels(pullRequest, ["ready-for-human-review"]),
        );
      };
      const dispatchForPullRequest = async (workflowId, inputs = {}, decision) => {
        return runPolicyOperation(async () => {
          const current = await assertCurrentHead();
          if (current.draft || hasBlockingLabel(current)) {
            throw new Error(`PR #${number} is draft or blocked; dispatch stopped`);
          }
          if (decision) {
            const now = Date.now();
            const reservation = {
              correlationId: dispatchCorrelationId(workflowId, number, sha),
              attempt: decision.attempt,
              reservedAt: new Date(now).toISOString(),
              expiresAt: new Date(now + DISPATCH_LEASE_MS).toISOString(),
            };
            const { data: created } = await github.rest.checks.create({
              owner, repo, head_sha: sha, name: `Evidence dispatch: ${workflowId}`,
              external_id: `${DISPATCH_MARKER}:${number}:${sha}:${workflowId}:${decision.attempt}`,
              status: "completed", conclusion: "neutral",
              output: {
                title: "Bounded infrastructure recovery reservation",
                summary: `<!-- ${DISPATCH_MARKER} ${JSON.stringify(reservation)} -->\n` +
                  "This is a dispatch lease, not CI/review evidence or a repair commit.",
              },
            });
            if (!created?.id) throw new Error("Dispatch reservation was not persisted");
            checkRuns.push(created);
          }
          await assertCurrentHead();
          await dispatch(workflowId, defaultBranch, {
            ...inputs,
            ...dispatchMetadata(workflowId, number, sha),
          });
        });
      };
      if (policy.riskExceedsGoal) {
        await ensureCheckRun(
          sha,
          policy.state,
          policy.description,
          pullRequest.html_url,
          checkRuns,
        );
        await addHumanBoundaryLabel();
        await pauseFactoryControl(
          factoryControlIssue,
          `PR #${number} risk ${policy.riskTier} exceeds its approved goal ceiling.`,
        );
        continue;
      }

      const now = Date.now();
      const ciNeedsDispatch = !ciEvidence.complete || !["success", "failure"].includes(ciEvidence.state);
      const ciDecision = ciNeedsDispatch
        ? infrastructureRetryDecision({
          runs: ciRuns, now,
          reservation: dispatchReservation(checkRuns, "ci.yml", sha, number),
        })
        : { dispatch: false, reason: "current_ci" };
      const ciHeld = ciNeedsDispatch;
      const ciShouldDispatch = ciDecision.dispatch;
      const decisions = Object.fromEntries(
        [REVIEW_CHECK_NAME, ...policy.requiredSpecialistChecks].map((checkName) => [
          checkName,
          checkName !== REVIEW_CHECK_NAME && (!ciEvidence.complete || ciNeedsDispatch)
            ? { dispatch: false, reason: "ci_pending" }
            : reviewDispatchDecision({
              checks: checkRuns, runs: runsByCheck[checkName], checkName, sha, now,
              reservation: dispatchReservation(checkRuns, REVIEW_WORKFLOWS[checkName], sha, number),
            }),
        ]),
      );
      for (const [name, decision] of Object.entries(decisions)) {
        if (decision.reason === "infrastructure_exhausted") {
          core.warning(`PR #${number} ${name}: infrastructure recovery exhausted; human investigation required (no repair commit).`);
        }
      }
      const reviewShouldDispatch = decisions[REVIEW_CHECK_NAME].dispatch;
      const reviewHeld = ["missing", "pending"].includes(policy.agentCheckStates[REVIEW_CHECK_NAME]);
      const securityShouldDispatch = decisions[SECURITY_CHECK_NAME]?.dispatch;
      const qaShouldDispatch = decisions[QA_CHECK_NAME]?.dispatch;
      const tradingSafetyShouldDispatch = decisions[TRADING_SAFETY_CHECK_NAME]?.dispatch;
      const specialistReviewPending = policy.requiredSpecialistChecks.some(
        (name) =>
          policy.agentCheckStates[name] === "missing" ||
          policy.agentCheckStates[name] === "pending",
      );
      const hasPendingPolicyOperations =
        ciShouldDispatch ||
        reviewShouldDispatch ||
        securityShouldDispatch ||
        qaShouldDispatch ||
        tradingSafetyShouldDispatch ||
        humanBoundaryLabelNeeded;

      await ensureCheckRun(
        sha,
        policy.state === "success" && hasPendingPolicyOperations
          ? "pending"
          : policy.state,
        policy.state === "success" && hasPendingPolicyOperations
          ? "Finalizing required reconciliation operations"
          : policy.description,
        pullRequest.html_url,
        checkRuns,
      );

      if (ciShouldDispatch) {
        await dispatchForPullRequest("ci.yml", { pr: String(number) }, ciDecision);
      }

      if (reviewShouldDispatch) {
        await dispatchForPullRequest(
          "code-review.lock.yml",
          pullRequestDispatchInputs(number),
          decisions[REVIEW_CHECK_NAME],
        );
      }

      if (securityShouldDispatch) {
        await dispatchForPullRequest(
          "security-review.lock.yml",
          targetDispatchInputs(number),
          decisions[SECURITY_CHECK_NAME],
        );
      }

      if (qaShouldDispatch) {
        await dispatchForPullRequest(
          "qa-test-plan.lock.yml",
          targetDispatchInputs(number),
          decisions[QA_CHECK_NAME],
        );
      }

      if (tradingSafetyShouldDispatch) {
        await dispatchForPullRequest(
          "trading-safety-review.lock.yml",
          targetDispatchInputs(number),
          decisions[TRADING_SAFETY_CHECK_NAME],
        );
      }

      await addHumanBoundaryLabel();

      if (policy.state === "success" && hasPendingPolicyOperations) {
        await ensureCheckRun(
          sha,
          policyWriteFailed ? "pending" : "success",
          policyWriteFailed
            ? "Reconciler operation failed; retrying"
            : policy.description,
          pullRequest.html_url,
          checkRuns,
        );
      }

      if (
        !canAttemptSelfHeal({
          sameRepository: policy.sameRepository,
          draft: pullRequest.draft,
          trustedAgent: policy.trustedAgent,
          lowRisk: policy.lowRisk,
          riskTier: policy.riskTier,
          hasBlockingLabel: policy.hasSelfHealBlockingLabel,
          ciNeedsDispatch,
          reviewShouldDispatch,
          ciHeld,
          reviewHeld,
          specialistReviewPending,
        })
      ) {
        continue;
      }

      const ciFailure = ciEvidence.complete && ciEvidence.state === "failure";
      const reviewFailure =
        hasFailedReviewCheck(checkRuns) ||
        policy.requiredSpecialistChecks.some(
          (name) => policy.agentCheckStates[name] === "failure",
        );
      if (!ciFailure && !reviewFailure) {
        continue;
      }

      const repairAttemptLimit = getRepairAttemptLimit(policy.riskTier);
      if (
        countRepairAttempts(commits, copilotIdentity) >=
        repairAttemptLimit
      ) {
        await addLabels(pullRequest, [EXHAUSTED_LABEL, BLOCKED_LABEL]);
        await pauseFactoryControl(
          factoryControlIssue,
          `PR #${number} exhausted its autonomous repair budget.`,
        );
        continue;
      }

      const healRuns = await listRuns(
        "pr-self-heal.lock.yml",
        sha,
        number,
        pullRequest.created_at,
      );
      if (healRuns.length === 0) {
        await dispatchForPullRequest(
          "pr-self-heal.lock.yml",
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
      recordReconciliationError(pullRequest, error);
      try {
        await ensureCheckRun(
          pullRequest.head.sha,
          "pending",
          "Reconciliation evidence unavailable; no authorization",
          pullRequest.html_url,
          [],
        );
      } catch (publicationError) {
        recordReconciliationError(pullRequest, publicationError);
      }
    }
  }

  if (reconciliationErrors.length > 0) {
    throw new AggregateError(
      reconciliationErrors,
      `Failed to reconcile ${reconciliationErrors.length} pull request operation(s)`,
    );
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
  hasSelfHealBlockingLabel,
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
