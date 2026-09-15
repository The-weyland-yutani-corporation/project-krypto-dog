"use strict";

const {
  CONTROL_LABEL, GOAL_LABEL, GOAL_APPROVED_LABEL, MODE_LABELS,
  CANDIDATE_FORM_HEADINGS, GOAL_FORM_HEADINGS, GOAL_REQUIRED_NARRATIVE_HEADINGS,
  IN_FLIGHT_LABELS, POST_QUEUE_LIFECYCLE_LABELS, CLAIM_MARKER_PATTERN,
  normalizeLabels, inspectIssueForm, getIssueFormSection, parseCandidateSections,
  parseNonNegativeInteger, determineFactoryMode, resolveActiveGoal,
  areAllCheckboxesChecked, findLatestLabelApplicationEvent, isHumanActorType, isValidTimestamp,
  resolveGoalScopeEvidence, getGoalScopeAnchors, hasVerifiedSignalScope,
  nativeParentMatchesRepository,
} = require("./agentic-queue-runtime.cjs");
const { evaluateEligibility, evaluateClaimState, parseClaimPayload } = require("./agentic-queue-controller.cjs");
const {
  BLOCKING_QUEUE_LABELS, normalizeAllowedPathPatterns, isKnownRiskTier,
} = require("./agentic-factory-policy.cjs");
const { createReadOnlyReader } = require("./agentic-readiness-reader.cjs");
const policy = require("../agentic-policy.json");

const REQUIRED_WORK_ITEM_HEADINGS = Object.freeze(
  Object.values(CANDIDATE_FORM_HEADINGS).filter((heading) => heading !== CANDIDATE_FORM_HEADINGS.context),
);
const MODEL_VARIABLES = Object.freeze([
  "GH_AW_MODEL_AGENT_COPILOT", "GH_AW_MODEL_DETECTION_COPILOT", "GH_AW_DEFAULT_MODEL_COPILOT",
]);
const unique = (values) => [...new Set(values)];

function diagnoseGoalIssue(issue) {
  const inspected = inspectIssueForm(issue.body, Object.values(GOAL_FORM_HEADINGS));
  const { sections } = inspected;
  const reasons = [...inspected.reasons];
  if (!issue.milestone?.title || !Number.isSafeInteger(issue.milestone?.number)) reasons.push("goal-missing-milestone");
  if (GOAL_REQUIRED_NARRATIVE_HEADINGS.some((heading) => !getIssueFormSection(sections, heading))) {
    reasons.push("goal-incomplete-narrative");
  }
  const boundaries = getIssueFormSection(sections, GOAL_FORM_HEADINGS.boundaries);
  if (!areAllCheckboxesChecked(boundaries) || (boundaries?.match(/^-\s*\[[xX]\]/gm) || []).length !== 3) {
    reasons.push("goal-boundaries-not-fully-checked");
  }
  if (!normalizeAllowedPathPatterns(getIssueFormSection(sections, GOAL_FORM_HEADINGS.allowedPaths)).valid) {
    reasons.push("goal-invalid-allowed-paths");
  }
  if (!isKnownRiskTier(getIssueFormSection(sections, GOAL_FORM_HEADINGS.maxRisk))) reasons.push("goal-invalid-max-risk");
  const wip = parseNonNegativeInteger(getIssueFormSection(sections, GOAL_FORM_HEADINGS.maxWip));
  const budget = parseNonNegativeInteger(getIssueFormSection(sections, GOAL_FORM_HEADINGS.assignmentBudget));
  if (wip === null || wip > 2) reasons.push("goal-invalid-max-wip");
  if (budget === null) reasons.push("goal-invalid-assignment-budget");
  const resolution = resolveActiveGoal([issue]);
  if (!resolution.valid) reasons.push(resolution.reason);
  return { number: issue.number, reasons: unique(reasons), config: resolution.goal, maxWip: wip, assignmentBudget: budget };
}

function readClaim(comments, issueNumber) {
  if (!Array.isArray(comments)) return {};
  const ordered = [...comments].sort((a, b) => Date.parse(a.created_at || "") - Date.parse(b.created_at || "") || a.id - b.id);
  let claim = null;
  for (const comment of ordered) {
    const match = CLAIM_MARKER_PATTERN.exec(comment.body || "");
    if (!match) continue;
    const parsed = parseClaimPayload(match[1]);
    claim = parsed.valid && parsed.claim.issueNumber === issueNumber ? parsed.claim : {};
  }
  return claim;
}

function linkedPullRequestNumbers(pulls, issueNumber, timeline = []) {
  const refs = new RegExp(`\\b(?:refs?|fix(?:es|ed)?|close[sd]?|resolve[sd]?)\\s+#${issueNumber}(?!\\d)`, "i");
  return unique((pulls || []).filter((pr) => {
    if (refs.test(pr.body || "")) return true;
    const marker = CLAIM_MARKER_PATTERN.exec(pr.body || "");
    const parsed = marker ? parseClaimPayload(marker[1]) : null;
    return parsed?.valid && parsed.claim.issueNumber === issueNumber ||
      (timeline || []).some((event) => event.source?.issue?.pull_request && event.source.issue.number === pr.number);
  }).map((pr) => pr.number)).sort((a, b) => a - b);
}

function inspectIntakeReceipts(comments) {
  const reservations = [];
  const results = [];
  const reasons = [];
  for (const comment of comments || []) {
    for (const match of (comment.body || "").matchAll(/<!-- factory-intake(-result)?:v1 (.+?) -->/g)) {
      if (comment.user?.type !== "Bot" || !policy.identities.trustedAgentAuthors.includes(comment.user?.login)) {
        reasons.push("untrusted-intake-receipt");
        continue;
      }
      try {
        const record = JSON.parse(match[2]);
        if (!["pm", "em"].includes(record.stage) || typeof record.fingerprint !== "string") throw new Error("Invalid receipt");
        (match[1] ? results : reservations).push(record);
      } catch {
        reasons.push("malformed-intake-receipt");
      }
    }
  }
  const entries = reservations.map((reservation) => {
    const matches = results.filter((result) => result.stage === reservation.stage && result.fingerprint === reservation.fingerprint);
    const recorded = matches.length === 1 && matches[0].completed === true;
    if (!recorded) reasons.push("intake-reservation-unresolved-human-recovery");
    return { stage: reservation.stage, fingerprint: reservation.fingerprint,
      status: recorded ? "completion-recorded" : "reserved-unresolved",
      implementingIssue: recorded ? matches[0].issue : null };
  });
  return { entries, reasons: unique(reasons) };
}

async function collectReadinessSnapshot({ github, context, config = {} }) {
  const { owner, repo } = context.repo;
  const reader = createReadOnlyReader({ github, owner, repo, maxPages: config.maxPages, maxRequests: config.maxRequests });
  const base = "GET /repos/{owner}/{repo}";
  const validIssue = (issue) => Number.isSafeInteger(issue.number) && ["open", "closed"].includes(issue.state);
  const issues = (await reader.list(`${base}/issues`, { state: "all", sort: "created", direction: "asc" }, undefined,
    (issue) => validIssue(issue) && Array.isArray(issue.labels)))
    .filter((issue) => !issue.pull_request);
  const pulls = await reader.list(`${base}/pulls`, { state: "open" }, undefined, validIssue);
  const repository = await reader.get(base, {}, { validate: (data) => typeof data.default_branch === "string" });
  const branchProtection = repository?.default_branch
    ? await reader.get(`${base}/branches/{branch}/protection`, { branch: repository.default_branch })
    : undefined;
  const workflowPermissions = await reader.get(`${base}/actions/permissions/workflow`);
  const actionsPermissions = await reader.get(`${base}/actions/permissions`);
  const variables = await reader.list(`${base}/actions/variables`, {}, "variables");
  const workflows = await reader.list(`${base}/actions/workflows`, {}, "workflows");
  const maxIssues = Number.isSafeInteger(config.maxIssues) && config.maxIssues > 0 ? config.maxIssues : 300;
  const scopeAnchors = issues.filter((issue) => normalizeLabels(issue.labels).includes(GOAL_LABEL)).flatMap((issue) => getGoalScopeAnchors(issue.body));
  const relevant = issues.filter((issue) => issue.state === "open" || scopeAnchors.includes(issue.number) ||
    normalizeLabels(issue.labels).some((label) => POST_QUEUE_LIFECYCLE_LABELS.includes(label)));
  if (relevant.length > maxIssues) {
    reader.reads.push({ resource: "issue-enrichment", complete: false, reason: "issue-limit-reached", count: maxIssues, total: relevant.length });
  }
  const details = {};
  // Four fixed readers bound both API pressure and the duration of a scheduled pass.
  const pending = relevant.slice(0, maxIssues);
  let index = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (index < pending.length) {
      const issue = pending[index++];
      const params = { issue_number: issue.number };
      const prefix = `${base}/issues/{issue_number}`;
      const timeline = await reader.list(`${prefix}/timeline`, params, undefined, (item) => typeof item.event === "string");
      const comments = await reader.list(`${prefix}/comments`, params, undefined, (item) => typeof item.body === "string");
      const parent = await reader.get(`${prefix}/parent`, params, { absent404: true, validate: (item) => nativeParentMatchesRepository(item, owner, repo) });
      const subIssues = await reader.list(`${prefix}/sub_issues`, params, undefined, validIssue);
      const blockedBy = await reader.list(`${prefix}/dependencies/blocked_by`, params, undefined, validIssue);
      details[issue.number] = { timeline, comments, parent, subIssues, blockedBy };
    }
  }));
  const snapshot = {
    schemaVersion: 1, observedAt: config.now || new Date().toISOString(), repository: { owner, repo },
    issues, pulls, details,
    capabilities: {
      repositoryPermissions: repository?.permissions || null,
      defaultBranch: repository?.default_branch || null,
      branchProtection: branchProtection || null,
      workflowPermissions: workflowPermissions || null,
      actionsPermissions: actionsPermissions || null,
      modelVariables: variables.filter((variable) => MODEL_VARIABLES.includes(variable.name)),
      workflows: workflows.map(({ path, state }) => ({ path, state })),
      // Availability must come from actual provider evidence, never from a configured model name.
      modelAvailability: config.modelAvailability || [],
    },
    reads: reader.reads.sort((a, b) => a.resource.localeCompare(b.resource)),
  };
  return snapshot;
}

function buildFactoryReadinessReport(snapshot) {
  const open = snapshot.issues.filter((issue) => issue.state === "open");
  const approved = open.filter((issue) => {
    const labels = normalizeLabels(issue.labels);
    return labels.includes(GOAL_LABEL) && labels.includes(GOAL_APPROVED_LABEL);
  });
  const controls = open.filter((issue) => normalizeLabels(issue.labels).includes(CONTROL_LABEL));
  const mode = determineFactoryMode(controls);
  const goalResolution = resolveActiveGoal(approved);
  const failures = snapshot.reads.filter((read) => !read.complete);
  const resourceIncomplete = (path) => failures.some((read) => read.resource.includes(path));
  const detailsFor = (issue) => snapshot.details[issue.number] || {};
  const approvalHuman = (issue, label) => isHumanActorType(
    findLatestLabelApplicationEvent(detailsFor(issue).timeline, label)?.actor?.type,
  );
  const modeReasons = mode.mode === "active" && !approvalHuman(mode.controlIssue, "factory-mode:active")
    ? ["active-mode-not-human-applied"] : [];
  const capacityComplete = !resourceIncomplete("/issues") && !resourceIncomplete("issue-enrichment");
  const ambiguousBudgetIssues = snapshot.issues.filter((issue) =>
    normalizeLabels(issue.labels).some((label) => POST_QUEUE_LIFECYCLE_LABELS.includes(label)) &&
    !parseCandidateSections(issue).parentGoalNumber &&
    detailsFor(issue).comments?.some((comment) => CLAIM_MARKER_PATTERN.test(comment.body || ""))).map((issue) => issue.number);
  const inFlight = open.filter((issue) => normalizeLabels(issue.labels).some((label) => IN_FLIGHT_LABELS.includes(label))).map((issue) => issue.number);
  const goals = open.filter((issue) => normalizeLabels(issue.labels).includes(GOAL_LABEL)).map((issue) => {
    const diagnostic = diagnoseGoalIssue(issue);
    const labels = normalizeLabels(issue.labels);
    const reasons = [...diagnostic.reasons];
    if (!labels.includes(GOAL_APPROVED_LABEL)) reasons.push("goal-not-approved");
    else if (!approvalHuman(issue, GOAL_APPROVED_LABEL)) reasons.push("goal-approval-not-human-applied");
    const consumedIssues = snapshot.issues.filter((candidate) => {
      const parsed = parseCandidateSections(candidate);
      return parsed.parentGoalNumber === issue.number &&
        parsed.labels.some((label) => POST_QUEUE_LIFECYCLE_LABELS.includes(label)) &&
        (!Array.isArray(detailsFor(candidate).comments) ||
          detailsFor(candidate).comments.some((comment) => CLAIM_MARKER_PATTERN.test(comment.body || "")));
    }).map((candidate) => candidate.number);
    return { ...diagnostic, reasons: unique(reasons), consumedIssues,
      budgetUsed: capacityComplete && ambiguousBudgetIssues.length === 0 ? consumedIssues.length : null };
  }).sort((a, b) => a.number - b.number);
  const globalReasons = [
    ...(mode.mode !== "active" ? [`factory-mode:${mode.mode}`] : []), ...modeReasons,
    ...(mode.reason !== "ok" ? [mode.reason] : []),
    ...(!goalResolution.valid ? [goalResolution.reason] : []),
    ...(failures.length ? ["api-incomplete"] : []),
    ...(!isValidTimestamp(snapshot.observedAt) ? ["invalid-observed-at"] : []),
    ...(ambiguousBudgetIssues.length ? ["budget-association-ambiguous"] : []),
  ];
  const candidateReports = open.filter((issue) => {
    const labels = normalizeLabels(issue.labels);
    return !labels.includes(GOAL_LABEL) && !labels.includes(CONTROL_LABEL);
  }).sort((a, b) => a.number - b.number).map((issue) => {
    const parsed = parseCandidateSections(issue);
    const goal = goals.find((item) => item.number === parsed.parentGoalNumber);
    const goalIssue = snapshot.issues.find((item) => item.number === parsed.parentGoalNumber);
    const detail = detailsFor(issue);
    const fields = inspectIssueForm(issue.body, REQUIRED_WORK_ITEM_HEADINGS);
    const scopeSource = snapshot.details[parsed.scopeSourceIssueNumber];
    const scopeSourceIssue = snapshot.issues.find((item) => item.number === parsed.scopeSourceIssueNumber);
    const scopeProof = resolveGoalScopeEvidence(goalIssue?.body, issue, issue.body, scopeSource?.comments,
      hasVerifiedSignalScope(issue, parsed.scopeSourceIssueNumber, goalIssue?.number, scopeSource?.comments,
        nativeParentMatchesRepository(scopeSource?.parent, snapshot.repository.owner, snapshot.repository.repo) ? scopeSource.parent.number : null));
    const nativeParent = Number.isSafeInteger(detail.parent?.number) ? detail.parent.number : null;
    const linkedPrs = linkedPullRequestNumbers(snapshot.pulls, issue.number, detail.timeline);
    const activeClaim = readClaim(detail.comments, issue.number);
    const intake = inspectIntakeReceipts(detail.comments);
    const dependencies = unique([...(parsed.dependencyNumbers || []), ...(detail.blockedBy || []).map((item) => item.number)])
      .map((number) => ({ number, state: detail.blockedBy?.find((item) => item.number === number)?.state ||
        snapshot.issues.find((item) => item.number === number)?.state || "unknown" }));
    const candidate = {
      ...parsed, number: issue.number,
      scopeProofReasons: scopeProof.reasons, scopeSourceVerified: scopeProof.reasons.length === 0,
      parentGoalApproved: Boolean(goal && goal.reasons.length === 0 && nativeParent === goal.number),
      dependencyStates: Array.isArray(parsed.dependencyNumbers) && Array.isArray(detail.blockedBy) ? dependencies.map(({ state }) => state) : null,
      isLeaf: Array.isArray(detail.subIssues) && detail.subIssues.every((child) => child?.state === "closed"),
      activeClaim, assignees: (issue.assignees || []).map((assignee) => assignee.login),
      hasOpenSession: (issue.assignees || []).length > 0, hasOpenPullRequest: linkedPrs.length > 0,
    };
    const config = goal?.config;
    const reasons = unique([
      ...fields.reasons,
      ...intake.reasons,
      ...scopeProof.reasons,
      ...(goal?.config?.goalScopeAnchors?.length && parsed.scopeSourceIssueNumber && parsed.scopeSourceIssueNumber !== issue.number
        ? !scopeSourceIssue || scopeSourceIssue.state !== "open" ? ["scope-source-not-open"] :
          normalizeLabels(scopeSourceIssue.labels).some((label) => BLOCKING_QUEUE_LABELS.includes(label)) ? ["scope-source-blocked"] : []
        : []),
      ...(!nativeParent ? ["missing-native-parent"] : nativeParent !== parsed.parentGoalNumber ? ["native-parent-mismatch"] : []),
      ...(goal?.reasons || ["unresolved-parent-goal"]),
      ...evaluateEligibility(candidate, {
        factoryMode: "shadow", goalApproved: goal?.reasons.length === 0,
        allowedMilestones: config ? [config.milestone] : [], goalAllowedPaths: config?.goalAllowedPaths || [],
        goalScopeAnchors: config?.goalScopeAnchors || [],
        maxGoalRiskTier: config?.maxGoalRiskTier, concurrencyLimit: config?.concurrencyLimit || 0,
        currentInFlightCount: capacityComplete ? inFlight.length : Infinity,
        dailyBudgetLimit: config?.dailyBudgetLimit || 0, currentBudgetUsed: goal?.budgetUsed ?? Infinity,
        now: snapshot.observedAt,
      }),
      ...(linkedPrs.length > 1 ? ["multiple-open-pull-requests"] : []),
      ...(resourceIncomplete(`/issues/${issue.number}/`) || !snapshot.details[issue.number] ? ["candidate-api-incomplete"] : []),
    ]);
    const authorizationReasons = unique([...globalReasons, ...reasons,
      ...(goalResolution.goal?.number !== parsed.parentGoalNumber ? ["not-single-active-goal-child"] : [])]);
    const claimState = evaluateClaimState(activeClaim, snapshot.observedAt);
    return {
      number: issue.number, title: issue.title, labels: parsed.labels,
      milestone: parsed.milestone, parentGoalNumber: parsed.parentGoalNumber || null, nativeParentGoalNumber: nativeParent,
      dependencies, declaredDependenciesComplete: Array.isArray(parsed.dependencyNumbers),
      linkedPullRequests: linkedPrs, assignees: candidate.assignees, claimState, intake,
      reasons, hypotheticalReady: reasons.length === 0, authorized: authorizationReasons.length === 0,
      authorizationReasons,
    };
  });
  const variablesReadable = !resourceIncomplete("/actions/variables");
  const configuredModel = (name) => snapshot.capabilities.modelVariables.find((variable) => variable.name === name)?.value;
  const defaultModel = configuredModel("GH_AW_DEFAULT_MODEL_COPILOT");
  const modelReport = (variable) => {
    const effective = configuredModel(variable) || defaultModel || "claude-sonnet-4.6";
    const observations = snapshot.capabilities.modelAvailability.filter((item) => item.model === effective);
    return {
      configured: variablesReadable, effective: variablesReadable ? effective : null, compiledFallback: "claude-sonnet-4.6",
      source: configuredModel(variable) ? "stage-override" : defaultModel ? "default-override" : "compiled-fallback",
      runtimeSupported: "unknown", providerAvailable: "unknown",
      retainedObservations: observations,
      reason: "Configuration and historical observations are not proof of current end-to-end capability.",
    };
  };
  const protection = snapshot.capabilities.branchProtection;
  const requiredContexts = protection?.required_status_checks?.contexts;
  const ownershipSignals = candidateReports.filter((candidate) =>
    candidate.claimState.present || candidate.linkedPullRequests.length > 0 || candidate.assignees.length > 0).map((candidate) => candidate.number);
  const unaccountedOwnership = ownershipSignals.filter((number) => !inFlight.includes(number));
  if (unaccountedOwnership.length) {
    globalReasons.push("wip-label-accounting-inconsistent");
    for (const candidate of candidateReports) {
      candidate.authorized = false;
      candidate.authorizationReasons.push("wip-label-accounting-inconsistent");
    }
  }
  return {
    schemaVersion: 1, observedAt: snapshot.observedAt, repository: snapshot.repository,
    readOnly: true, selectionAttempted: false, claimsAttempted: false,
    authorizationScope: "Snapshot of queue issue policy; never permission to act or proof of end-to-end capability.",
    mode: { ...mode, controlIssue: mode.controlIssue?.number || null, reasons: modeReasons,
      controls: controls.map((issue) => ({ number: issue.number, labels: normalizeLabels(issue.labels).filter((label) => MODE_LABELS.includes(label)) })) },
    goals: { resolution: goalResolution.reason, activeGoalNumber: goalResolution.goal?.number || null, items: goals },
    capacity: {
      inFlight, inFlightCount: capacityComplete ? inFlight.length : null, accountingBasis: "canonical-lifecycle-labels",
      ownershipSignals, unaccountedOwnership, ambiguousBudgetIssues,
      requiresHumanReconciliation: unaccountedOwnership.length > 0 || ambiguousBudgetIssues.length > 0,
      complete: capacityComplete && ambiguousBudgetIssues.length === 0,
    },
    capabilities: { ...snapshot.capabilities, tokenWriteAccess: "unverified-by-read-only-probe",
      protection: {
        readable: Boolean(protection), strict: protection?.required_status_checks?.strict ?? null,
        enforceAdmins: protection?.enforce_admins?.enabled ?? null,
        missingRequiredContexts: Array.isArray(requiredContexts) ? policy.merge.requiredContexts.filter((name) => !requiredContexts.includes(name)) : null,
        checkAppBindings: protection?.required_status_checks?.checks || null,
      },
      models: { agent: modelReport("GH_AW_MODEL_AGENT_COPILOT"), detection: modelReport("GH_AW_MODEL_DETECTION_COPILOT") } },
    completeness: { complete: failures.length === 0, reads: snapshot.reads.length, errors: failures },
    authorizationReasons: unique(globalReasons), candidates: candidateReports,
    disposition: candidateReports.map((candidate) => {
      const preserve = candidate.claimState.present || candidate.linkedPullRequests.length > 0 || candidate.assignees.length > 0;
      const humanOnly = preserve || candidate.labels.some((label) => BLOCKING_QUEUE_LABELS.includes(label)) ||
        candidate.intake.reasons.length > 0 ||
        candidate.reasons.some((reason) => /parent|conflict|lifecycle-label|risk-label|api-incomplete|scope-source|goal-prose-scope-unproven/.test(reason));
      const mapped = candidate.intake.entries.some((entry) => entry.implementingIssue && entry.implementingIssue !== candidate.number);
      return {
        number: candidate.number, disposition: preserve ? "preserve-in-flight" : humanOnly ? "human-recovery" :
          mapped ? "source-mapped-to-implementation-leaf" : candidate.hypotheticalReady ? "ready-but-not-selected" : "needs-authoring",
        humanOnly, reasons: candidate.authorizationReasons,
        proposedAction: preserve ? "Inspect existing claim/PR evidence; never mint a replacement claim or close/reparent automatically." :
          humanOnly ? "Human resolves topology, hard blocks or ambiguity after reviewing this snapshot." :
          "Use bounded PM/EM intake only after a single current goal and active mode authorize this exact scope.",
        apply: false,
      };
    }),
    pullRequests: snapshot.pulls.map((pr) => ({
      number: pr.number, draft: pr.draft, head: pr.head?.sha || null,
      issues: candidateReports.filter((candidate) => candidate.linkedPullRequests.includes(pr.number)).map((candidate) => candidate.number),
      disposition: "preserve-existing-pr", apply: false,
    })),
    humanOperations: [
      "Resolve singleton goal/approval and milestone/field ambiguity; automation never chooses a goal or renews its budget.",
      "Review claim, blocked-work and PR topology individually; do not bulk close, reparent, clear blocks or forge nonces.",
      "Confirm capabilities and scoped credentials, then explicitly unpause if appropriate; no production/live/architecture authority is implied.",
    ],
  };
}

function renderReadinessMarkdown(report) {
  return [
    "# Factory readiness (read-only)", "",
    `Mode: **${report.mode.mode}**. Goal resolution: **${report.goals.resolution}**. API complete: **${report.completeness.complete}**.`,
    "Hypothetical readiness is not authorization. No selection, claims, labels, topology or permissions were changed.", "",
    ...report.goals.items.map((goal) => `- Goal #${goal.number}: ${goal.reasons.join(", ") || "fields complete"}; budget ${goal.budgetUsed ?? "unknown"}/${goal.assignmentBudget ?? "unknown"}.`),
    "", "| Issue | Hypothetical ready | Authorized | Reasons |", "| --- | --- | --- | --- |",
    ...report.candidates.map((candidate) => `| #${candidate.number} | ${candidate.hypotheticalReady} | ${candidate.authorized} | ${candidate.authorizationReasons.join(", ").replaceAll("|", "\\|")} |`),
    "", "## Incomplete reads", ...report.completeness.errors.map((error) => `- ${error.resource}: ${error.reason} (${error.status || "unknown status"})`),
  ].join("\n");
}

module.exports = {
  REQUIRED_WORK_ITEM_HEADINGS, MODEL_VARIABLES, diagnoseGoalIssue, readClaim, linkedPullRequestNumbers,
  inspectIntakeReceipts, collectReadinessSnapshot, buildFactoryReadinessReport, renderReadinessMarkdown,
};
