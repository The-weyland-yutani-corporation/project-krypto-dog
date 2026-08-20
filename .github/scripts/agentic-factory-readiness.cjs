"use strict";

/**
 * Deterministic, read-only readiness preflight for the autonomous SDLC factory.
 *
 * The pure evaluators consume an already-collected snapshot and return stable
 * blocker/warning/pass codes. The GitHub adapter below only performs GET/list
 * operations against the trusted default branch and repository metadata. It
 * never labels, comments, dispatches, merges, deploys, or changes factory mode.
 */

const crypto = require("node:crypto");
const policy = require("./agentic-factory-policy.cjs");
const queue = require("./agentic-queue-controller.cjs");
const queueRuntime = require("./agentic-queue-runtime.cjs");
const lifecycle = require("./agentic-lifecycle-reconciler.cjs");

const PREFLIGHT_MODES = Object.freeze({
  BASELINE: "baseline",
  CANARY: "canary",
});

const FINDING_LEVELS = Object.freeze({
  BLOCKER: "blocker",
  WARNING: "warning",
  PASS: "pass",
});

const CI_WORKFLOW_ID = "ci.yml";
const DEV_WORKFLOW_ID = "azure-deploy-dev.yml";
const DEV_WORKFLOW_NAME = "Azure deploy dev";
const DEV_WORKFLOW_PATH = ".github/workflows/azure-deploy-dev.yml";
const DEV_SUCCESS_DESCRIPTION =
  "Exact-SHA dev shadow deployment and scheduled execution passed";
const READINESS_COMMAND = "/factory-readiness";
const FACTORY_CONTROL_ENVIRONMENT = "factory-control";
const DEVELOPMENT_BRANCH_POLICIES = Object.freeze([
  "develop/azure",
  "main",
]);
const CANARY_PATH = "docs/e2e/factory-full-heartbeat.md";
const GOAL_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const AUTOMATIC_DEV_EVIDENCE_EVENTS = Object.freeze(["workflow_run"]);
const HUMAN_RETRY_DEV_EVIDENCE_EVENTS = Object.freeze(["workflow_dispatch"]);
const MAX_SUMMARY_TEXT = 240;
const MAX_SUMMARY_DETAIL = 1200;
const MAX_SUMMARY_FINDINGS_PER_LEVEL = 100;
const GITHUB_ACTIONS_APP_SLUG = "github-actions";
const GITHUB_ACTIONS_BOT_LOGIN = "github-actions[bot]";
const GITHUB_ACTIONS_BOT_ID = 41898282;
const COMMAND_KEYS = Object.freeze(
  new Map([
    ["mode", "mode"],
    ["goal", "goalIssue"],
    ["canary", "canaryIssue"],
    ["active-event", "activeEvent"],
    ["sha", "evidenceSha"],
    ["goal-digest", "goalDigest"],
    ["gh-aw-token-attested", "ghAwAgentTokenAttested"],
    [
      "actions-pr-attested",
      "actionsCanCreatePullRequestsAttested",
    ],
  ]),
);

const REQUIRED_FACTORY_WORKFLOW_PATHS = Object.freeze([
  ".github/workflows/ci.yml",
  ".github/workflows/opportunity-discovery.lock.yml",
  ".github/workflows/pm-triage.lock.yml",
  ".github/workflows/em-planning.lock.yml",
  ".github/workflows/rubber-duck-architecture.lock.yml",
  ".github/workflows/factory-queue-controller.yml",
  ".github/workflows/implement-ticket.lock.yml",
  ".github/workflows/agentic-pr-reconciler.yml",
  ".github/workflows/agentic-lifecycle-reconciler.yml",
  ".github/workflows/code-review.lock.yml",
  ".github/workflows/qa-test-plan.lock.yml",
  ".github/workflows/security-review.lock.yml",
  ".github/workflows/trading-safety-review.lock.yml",
  ".github/workflows/pr-self-heal.lock.yml",
  ".github/workflows/azure-deploy-dev.yml",
  ".github/workflows/agentic-factory-full-e2e.yml",
  ".github/workflows/agentic-factory-readiness.yml",
]);

const REQUIRED_FACTORY_SOURCE_PATHS = Object.freeze([
  ".github/agentic-policy.json",
  ".github/ISSUE_TEMPLATE/factory-goal.yml",
  ".github/ISSUE_TEMPLATE/agentic-work-item.yml",
  ".github/scripts/agentic-factory-policy.cjs",
  ".github/scripts/agentic-queue-controller.cjs",
  ".github/scripts/agentic-queue-runtime.cjs",
  ".github/scripts/agentic-pr-reconciler.cjs",
  ".github/scripts/agentic-lifecycle-reconciler.cjs",
  ".github/scripts/agentic-factory-readiness.cjs",
  ".github/workflows/copilot-setup-steps.yml",
  ".github/workflows/opportunity-discovery.md",
  ".github/workflows/pm-triage.md",
  ".github/workflows/em-planning.md",
  ".github/workflows/rubber-duck-architecture.md",
  ".github/workflows/implement-ticket.md",
  ".github/workflows/code-review.md",
  ".github/workflows/qa-test-plan.md",
  ".github/workflows/security-review.md",
  ".github/workflows/trading-safety-review.md",
  ".github/workflows/pr-self-heal.md",
  ...REQUIRED_FACTORY_WORKFLOW_PATHS,
]);

function getErrorStatus(error) {
  return error && typeof error === "object" ? error.status : undefined;
}

function isSha(value) {
  return typeof value === "string" && /^[a-f0-9]{40}$/i.test(value);
}

function parseOptionalIssueNumber(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return { provided: false, valid: true, value: undefined };
  }
  const text = String(value).trim();
  if (!/^[1-9]\d*$/.test(text)) {
    return { provided: true, valid: false, value: undefined };
  }
  const parsed = Number(text);
  return {
    provided: true,
    valid: Number.isSafeInteger(parsed),
    value: Number.isSafeInteger(parsed) ? parsed : undefined,
  };
}

function parseExplicitBoolean(value) {
  if (value === true || value === "true") {
    return true;
  }
  if (value === false || value === "false") {
    return false;
  }
  return null;
}

function parseWorkflowInputs(inputs = {}) {
  const source = inputs && typeof inputs === "object" ? inputs : {};
  const rawMode =
    typeof source.mode === "string" ? source.mode.trim().toLowerCase() : "";
  const mode = Object.values(PREFLIGHT_MODES).includes(rawMode)
    ? rawMode
    : undefined;
  const rawEvidenceSha =
    typeof source.evidenceSha === "string" ? source.evidenceSha.trim() : "";
  const rawGoalDigest =
    typeof source.goalDigest === "string"
      ? source.goalDigest.trim()
      : "";

  return {
    mode,
    rawMode,
    goalIssue: parseOptionalIssueNumber(source.goalIssue),
    canaryIssue: parseOptionalIssueNumber(source.canaryIssue),
    evidenceSha: {
      provided: rawEvidenceSha !== "",
      valid: rawEvidenceSha === "" || isSha(rawEvidenceSha),
      value: rawEvidenceSha === "" ? undefined : rawEvidenceSha.toLowerCase(),
    },
    goalDigest: {
      provided: rawGoalDigest !== "",
      valid: rawGoalDigest === "" || GOAL_DIGEST_PATTERN.test(rawGoalDigest),
      value: rawGoalDigest === "" ? undefined : rawGoalDigest,
    },
    attestations: {
      ghAwAgentToken: parseExplicitBoolean(source.ghAwAgentTokenAttested),
      actionsCanCreatePullRequests: parseExplicitBoolean(
        source.actionsCanCreatePullRequestsAttested,
      ),
    },
  };
}

function parseIssueCommentCommand(body) {
  if (typeof body !== "string") {
    return {
      recognized: false,
      valid: false,
      errors: ["comment-body-missing"],
      inputs: {},
    };
  }

  const text = body.trim();
  if (!text.startsWith(READINESS_COMMAND)) {
    return {
      recognized: false,
      valid: false,
      errors: ["command-not-recognized"],
      inputs: {},
    };
  }

  const errors = [];
  if (
    body !== text ||
    /[^\S ]/.test(text) ||
    / {2,}/.test(text)
  ) {
    errors.push("command-whitespace-noncanonical");
  }
  const tokens = text.split(" ");
  if (tokens[0] !== READINESS_COMMAND) {
    errors.push("command-prefix-invalid");
  }

  const inputs = {};
  const seen = new Set();
  for (const token of tokens.slice(1)) {
    const separator = token.indexOf("=");
    if (
      separator <= 0 ||
      separator === token.length - 1 ||
      token.indexOf("=", separator + 1) !== -1
    ) {
      errors.push("command-token-malformed");
      continue;
    }
    const key = token.slice(0, separator);
    const value = token.slice(separator + 1);
    const inputName = COMMAND_KEYS.get(key);
    if (!inputName) {
      errors.push(`command-key-unknown:${key}`);
      continue;
    }
    if (seen.has(key)) {
      errors.push(`command-key-duplicate:${key}`);
      continue;
    }
    seen.add(key);
    inputs[inputName] = value;
  }
  if (!seen.has("mode")) {
    errors.push("command-mode-missing");
  }

  return {
    recognized: true,
    valid: errors.length === 0,
    errors: [...new Set(errors)].sort(),
    inputs,
  };
}

function makeFinding(level, code, message, details) {
  return {
    level,
    code,
    message,
    ...(details === undefined ? {} : { details }),
  };
}

function evaluateRepositorySnapshot(snapshot, add) {
  if (
    !snapshot ||
    typeof snapshot.defaultBranch !== "string" ||
    snapshot.defaultBranch.trim() === "" ||
    !isSha(snapshot.defaultBranchSha)
  ) {
    add(
      FINDING_LEVELS.BLOCKER,
      "DEFAULT_BRANCH_IDENTITY_INVALID",
      "The trusted default branch name or head SHA is missing or malformed.",
    );
    return;
  }

  add(
    FINDING_LEVELS.PASS,
    "DEFAULT_BRANCH_IDENTITY_VALID",
    "The repository default branch and exact head SHA were resolved.",
    {
      branch: snapshot.defaultBranch,
      sha: snapshot.defaultBranchSha,
    },
  );

  if (snapshot.defaultBranchProtected !== true) {
    add(
      FINDING_LEVELS.BLOCKER,
      "DEFAULT_BRANCH_NOT_PROTECTED",
      "The trusted default branch is not reported as protected.",
      { branch: snapshot.defaultBranch },
    );
  } else {
    add(
      FINDING_LEVELS.PASS,
      "DEFAULT_BRANCH_PROTECTED",
      "The trusted default branch is protected.",
      { branch: snapshot.defaultBranch },
    );
  }

  if (!isSha(snapshot.finalDefaultBranchSha)) {
    add(
      FINDING_LEVELS.BLOCKER,
      "DEFAULT_BRANCH_FINAL_HEAD_INVALID",
      "The final default-branch head re-read is missing or malformed.",
    );
  } else if (snapshot.finalDefaultBranchSha !== snapshot.defaultBranchSha) {
    add(
      FINDING_LEVELS.BLOCKER,
      "DEFAULT_BRANCH_MOVED_DURING_PREFLIGHT",
      "The default-branch head changed while readiness was being evaluated.",
      {
        initialSha: snapshot.defaultBranchSha,
        finalSha: snapshot.finalDefaultBranchSha,
      },
    );
  } else {
    add(
      FINDING_LEVELS.PASS,
      "DEFAULT_BRANCH_HEAD_STABLE",
      "The final default-branch head re-read matches the evaluated head.",
      { sha: snapshot.defaultBranchSha },
    );
  }

  if (!isSha(snapshot.trustedScriptSha)) {
    add(
      FINDING_LEVELS.BLOCKER,
      "TRUSTED_SCRIPT_SHA_INVALID",
      "The checked-out readiness-script SHA is missing or malformed.",
    );
  } else if (snapshot.trustedScriptSha !== snapshot.defaultBranchSha) {
    add(
      FINDING_LEVELS.BLOCKER,
      "TRUSTED_SCRIPT_SHA_STALE",
      "The readiness script was not loaded from the exact default-branch head being evaluated.",
      {
        scriptSha: snapshot.trustedScriptSha,
        defaultBranchSha: snapshot.defaultBranchSha,
      },
    );
  } else {
    add(
      FINDING_LEVELS.PASS,
      "TRUSTED_SCRIPT_SHA_CURRENT",
      "The readiness script was loaded from the exact default-branch head being evaluated.",
      { sha: snapshot.trustedScriptSha },
    );
  }

  if (snapshot.treeTruncated === true) {
    add(
      FINDING_LEVELS.BLOCKER,
      "DEFAULT_BRANCH_TREE_TRUNCATED",
      "The default-branch Git tree response was truncated; required files cannot be proven present.",
    );
  }

  if (!Array.isArray(snapshot.treePaths)) {
    add(
      FINDING_LEVELS.BLOCKER,
      "DEFAULT_BRANCH_TREE_INVALID",
      "The default-branch file inventory is missing or malformed.",
    );
  } else {
    const present = new Set(snapshot.treePaths);
    const missing = REQUIRED_FACTORY_SOURCE_PATHS.filter(
      (requiredPath) => !present.has(requiredPath),
    );
    if (missing.length > 0) {
      add(
        FINDING_LEVELS.BLOCKER,
        "DEFAULT_BRANCH_FACTORY_FILES_MISSING",
        "Required factory files are missing from the trusted default branch.",
        { paths: missing },
      );
    } else {
      add(
        FINDING_LEVELS.PASS,
        "DEFAULT_BRANCH_FACTORY_FILES_PRESENT",
        "All required factory files are present on the trusted default branch.",
        { count: REQUIRED_FACTORY_SOURCE_PATHS.length },
      );
    }
  }

  if (!Array.isArray(snapshot.workflows)) {
    add(
      FINDING_LEVELS.BLOCKER,
      "DEFAULT_BRANCH_WORKFLOW_INVENTORY_INVALID",
      "The Actions workflow inventory is missing or malformed.",
    );
    return;
  }

  const missing = [];
  const inactive = [];
  const ambiguous = [];
  for (const requiredPath of REQUIRED_FACTORY_WORKFLOW_PATHS) {
    const matches = snapshot.workflows.filter(
      (workflow) => workflow && workflow.path === requiredPath,
    );
    if (matches.length === 0) {
      missing.push(requiredPath);
    } else if (matches.length > 1) {
      ambiguous.push(requiredPath);
    } else if (matches[0].state !== "active") {
      inactive.push({
        path: requiredPath,
        state:
          typeof matches[0].state === "string" ? matches[0].state : "unknown",
      });
    }
  }

  if (missing.length > 0) {
    add(
      FINDING_LEVELS.BLOCKER,
      "DEFAULT_BRANCH_WORKFLOWS_MISSING",
      "Required factory workflows are not registered from the default branch.",
      { paths: missing },
    );
  }
  if (inactive.length > 0) {
    add(
      FINDING_LEVELS.BLOCKER,
      "DEFAULT_BRANCH_WORKFLOWS_INACTIVE",
      "Required factory workflows are registered but not active.",
      { workflows: inactive },
    );
  }
  if (ambiguous.length > 0) {
    add(
      FINDING_LEVELS.BLOCKER,
      "DEFAULT_BRANCH_WORKFLOWS_AMBIGUOUS",
      "Required workflow paths appeared more than once in the workflow inventory.",
      { paths: ambiguous },
    );
  }
  if (missing.length === 0 && inactive.length === 0 && ambiguous.length === 0) {
    add(
      FINDING_LEVELS.PASS,
      "DEFAULT_BRANCH_WORKFLOWS_ACTIVE",
      "All required default-branch factory workflows are active.",
      { count: REQUIRED_FACTORY_WORKFLOW_PATHS.length },
    );
  }
}

function evaluateOrderedLabelEvent({
  events,
  labelName,
  missingCode,
  ambiguousCode,
  passCode,
  subject,
  add,
}) {
  const resolution = queueRuntime.resolveLatestLabelApplicationEvent(
    events,
    labelName,
  );
  if (!resolution.valid) {
    add(
      FINDING_LEVELS.BLOCKER,
      resolution.reason === "missing-label-event" ? missingCode : ambiguousCode,
      `${subject} does not have one unambiguous latest label-application event.`,
      { label: labelName, reason: resolution.reason },
    );
    return null;
  }
  const event = resolution.event;
  add(
    FINDING_LEVELS.PASS,
    passCode,
    `${subject} has one deterministically ordered latest label event; actor type and token attribution are not treated as human proof.`,
    { label: labelName, eventId: event.id, createdAt: event.created_at },
  );
  return event;
}

function evaluateFactoryControl(controlIssues, add) {
  const issues = Array.isArray(controlIssues) ? controlIssues : [];
  const resolution = queueRuntime.determineFactoryMode(issues);

  if (resolution.reason !== "ok") {
    const codeByReason = {
      "missing-control-issue": "CONTROL_ISSUE_MISSING",
      "multiple-control-issues": "CONTROL_ISSUE_AMBIGUOUS",
      "missing-mode-label": "CONTROL_MODE_LABEL_MISSING",
      "conflicting-mode-labels": "CONTROL_MODE_LABEL_AMBIGUOUS",
    };
    add(
      FINDING_LEVELS.BLOCKER,
      codeByReason[resolution.reason] || "CONTROL_STATE_INVALID",
      "Factory control must resolve from exactly one open control issue with exactly one canonical mode label.",
      { reason: resolution.reason, count: issues.length },
    );
    return {
      mode: policy.FACTORY_MODES.PAUSED,
      valid: false,
      issueNumber: null,
      activeEventId: null,
    };
  }

  const issue = resolution.controlIssue;
  if (!issue || issue.state !== "open") {
    add(
      FINDING_LEVELS.BLOCKER,
      "CONTROL_ISSUE_NOT_OPEN",
      "The singleton factory control issue is not open.",
      { issue: issue && issue.number },
    );
    return {
      mode: policy.FACTORY_MODES.PAUSED,
      valid: false,
      issueNumber: issue && issue.number,
      activeEventId: null,
    };
  }

  add(
    FINDING_LEVELS.PASS,
    "CONTROL_SINGLETON_MODE_VALID",
    "Exactly one open factory control issue carries exactly one canonical mode label.",
    { issue: issue.number, mode: resolution.mode },
  );

  if (resolution.mode === policy.FACTORY_MODES.PAUSED) {
    add(
      FINDING_LEVELS.BLOCKER,
      "CONTROL_MODE_PAUSED",
      "The factory is paused and is not ready for a shadow rehearsal or activation.",
      { issue: issue.number },
    );
    return {
      mode: resolution.mode,
      valid: false,
      issueNumber: issue.number,
      activeEventId: null,
    };
  }

  if (resolution.mode === policy.FACTORY_MODES.SHADOW) {
    add(
      FINDING_LEVELS.PASS,
      "CONTROL_MODE_SHADOW",
      "The factory remains in non-mutating shadow mode pending explicit human activation.",
      { issue: issue.number },
    );
    return {
      mode: resolution.mode,
      valid: true,
      issueNumber: issue.number,
      activeEventId: null,
    };
  }

  const activeLabel = Object.entries(policy.FACTORY_MODE_LABELS).find(
    ([, mode]) => mode === policy.FACTORY_MODES.ACTIVE,
  )[0];
  const activeEvent = evaluateOrderedLabelEvent({
    events: issue.timelineEvents,
    labelName: activeLabel,
    missingCode: "CONTROL_ACTIVE_EVENT_MISSING",
    ambiguousCode: "CONTROL_ACTIVE_EVENT_AMBIGUOUS",
    passCode: "CONTROL_ACTIVE_EVENT_ORDERED",
    subject: "Active factory mode",
    add,
  });
  return {
    mode: resolution.mode,
    valid: activeEvent !== null,
    issueNumber: issue.number,
    activeEventId: activeEvent ? Number(activeEvent.id) : null,
  };
}

function evaluateProtectedEnvironment(
  snapshot,
  expectedName,
  codePrefix,
  add,
) {
  if (
    !snapshot ||
    snapshot.readable !== true ||
    snapshot.name !== expectedName
  ) {
    add(
      FINDING_LEVELS.BLOCKER,
      `${codePrefix}_ENVIRONMENT_UNREADABLE`,
      `The ${expectedName} environment configuration could not be read and matched exactly.`,
      {
        name: snapshot && snapshot.name,
        status: snapshot && snapshot.errorStatus,
      },
    );
    return false;
  }

  const rules = Array.isArray(snapshot.protectionRules)
    ? snapshot.protectionRules
    : [];
  const reviewerRules = rules.filter(
    (rule) => rule && rule.type === "required_reviewers",
  );
  const reviewerRule = reviewerRules[0];
  const reviewers =
    reviewerRule && Array.isArray(reviewerRule.reviewers)
      ? reviewerRule.reviewers
      : [];
  const reviewersValid =
    reviewerRules.length === 1 &&
    reviewers.length > 0 &&
    reviewers.every((reviewer) =>
      ["User", "Team"].includes(reviewer && reviewer.type),
    ) &&
    reviewerRule.prevent_self_review === true;
  if (!reviewersValid) {
    add(
      FINDING_LEVELS.BLOCKER,
      `${codePrefix}_ENVIRONMENT_REVIEWERS_INVALID`,
      `The ${expectedName} environment must have required reviewers and prevent self-review.`,
      {
        reviewerRules: reviewerRules.length,
        reviewerCount: reviewers.length,
        preventSelfReview:
          reviewerRule && reviewerRule.prevent_self_review === true,
      },
    );
  } else {
    add(
      FINDING_LEVELS.PASS,
      `${codePrefix}_ENVIRONMENT_REVIEWERS_VALID`,
      `The ${expectedName} environment has required reviewers and prevents self-review.`,
      { reviewerCount: reviewers.length },
    );
  }

  const adminBypassDisabled = snapshot.canAdminsBypass === false;
  if (!adminBypassDisabled) {
    add(
      FINDING_LEVELS.BLOCKER,
      `${codePrefix}_ENVIRONMENT_ADMIN_BYPASS_ENABLED`,
      `The ${expectedName} environment must prevent administrators from bypassing its protection rules.`,
      { canAdminsBypass: snapshot.canAdminsBypass },
    );
  } else {
    add(
      FINDING_LEVELS.PASS,
      `${codePrefix}_ENVIRONMENT_ADMIN_BYPASS_DISABLED`,
      `The ${expectedName} environment prevents administrator bypass.`,
    );
  }

  const branchPolicy = snapshot.deploymentBranchPolicy;
  const branchPolicyValid =
    branchPolicy &&
    branchPolicy.protected_branches === true &&
    branchPolicy.custom_branch_policies === false;
  if (!branchPolicyValid) {
    add(
      FINDING_LEVELS.BLOCKER,
      `${codePrefix}_ENVIRONMENT_BRANCH_POLICY_INVALID`,
      `The ${expectedName} environment must be restricted to protected branches.`,
    );
  } else {
    add(
      FINDING_LEVELS.PASS,
      `${codePrefix}_ENVIRONMENT_BRANCH_POLICY_VALID`,
      `The ${expectedName} environment is restricted to protected branches.`,
    );
  }

  return reviewersValid && adminBypassDisabled && branchPolicyValid;
}

function evaluateDevelopmentEnvironment(snapshot, add) {
  if (
    !snapshot ||
    snapshot.readable !== true ||
    snapshot.name !== lifecycle.DEV_ENVIRONMENT
  ) {
    add(
      FINDING_LEVELS.BLOCKER,
      "DEVELOPMENT_ENVIRONMENT_UNREADABLE",
      "The development environment configuration could not be read and matched exactly.",
      {
        name: snapshot && snapshot.name,
        status: snapshot && snapshot.errorStatus,
      },
    );
    return false;
  }

  const rules = Array.isArray(snapshot.protectionRules)
    ? snapshot.protectionRules
    : [];
  const reviewerRules = rules.filter(
    (rule) => rule && rule.type === "required_reviewers",
  );
  if (reviewerRules.length !== 0) {
    add(
      FINDING_LEVELS.BLOCKER,
      "DEVELOPMENT_ENVIRONMENT_REVIEWERS_UNEXPECTED",
      "The autonomous development environment must not require a human reviewer.",
      { reviewerRules: reviewerRules.length },
    );
  } else {
    add(
      FINDING_LEVELS.PASS,
      "DEVELOPMENT_ENVIRONMENT_AUTONOMOUS",
      "The development environment has no human reviewer gate.",
    );
  }

  const branchPolicy = snapshot.deploymentBranchPolicy;
  const customPolicyEnabled =
    branchPolicy &&
    branchPolicy.protected_branches === false &&
    branchPolicy.custom_branch_policies === true;
  const rawPolicies = Array.isArray(snapshot.branchPolicies)
    ? snapshot.branchPolicies
    : [];
  const actualPolicies = rawPolicies
    .map((policyEntry) =>
      policyEntry &&
      policyEntry.type === "branch" &&
      typeof policyEntry.name === "string"
        ? policyEntry.name
        : null,
    )
    .filter((name) => name !== null)
    .sort();
  const expectedPolicies = [...DEVELOPMENT_BRANCH_POLICIES].sort();
  const exactPolicies =
    customPolicyEnabled &&
    rawPolicies.length === expectedPolicies.length &&
    actualPolicies.length === expectedPolicies.length &&
    actualPolicies.every((name, index) => name === expectedPolicies[index]);
  if (!exactPolicies) {
    add(
      FINDING_LEVELS.BLOCKER,
      "DEVELOPMENT_ENVIRONMENT_BRANCH_POLICY_INVALID",
      "The development environment must allow exactly the reviewed main and develop/azure branch policies.",
      { actual: actualPolicies, expected: expectedPolicies },
    );
  } else {
    add(
      FINDING_LEVELS.PASS,
      "DEVELOPMENT_ENVIRONMENT_BRANCH_POLICY_VALID",
      "The development environment allows exactly the reviewed main and develop/azure branches.",
      { branches: actualPolicies },
    );
  }

  return reviewerRules.length === 0 && exactPolicies;
}

function evaluateProtectedInvocation(
  snapshot,
  control,
  repository,
  request,
  add,
) {
  let valid = true;
  if (
    !snapshot ||
    snapshot.eventName !== "issue_comment" ||
    snapshot.action !== "created"
  ) {
    valid = false;
    add(
      FINDING_LEVELS.BLOCKER,
      "INVOCATION_EVENT_INVALID",
      "Readiness must be invoked by a newly created issue comment.",
      {
        eventName: snapshot && snapshot.eventName,
        action: snapshot && snapshot.action,
      },
    );
  }

  if (!snapshot || snapshot.runAttempt !== 1) {
    valid = false;
    add(
      FINDING_LEVELS.BLOCKER,
      "INVOCATION_RERUN_REJECTED",
      "Workflow reruns are rejected; create a new protected command instead.",
      { runAttempt: snapshot && snapshot.runAttempt },
    );
  }
  if (
    !snapshot ||
    !Number.isSafeInteger(snapshot.runId) ||
    snapshot.runId <= 0
  ) {
    valid = false;
    add(
      FINDING_LEVELS.BLOCKER,
      "INVOCATION_RUN_ID_INVALID",
      "The protected approval record is missing a valid workflow run ID.",
    );
  }

  if (
    !snapshot ||
    !isSha(snapshot.workflowSha) ||
    snapshot.workflowRef !== `refs/heads/${repository.defaultBranch}` ||
    snapshot.workflowSha !== repository.defaultBranchSha ||
    snapshot.workflowSha !== repository.trustedScriptSha
  ) {
    valid = false;
    add(
      FINDING_LEVELS.BLOCKER,
      "INVOCATION_DEFAULT_HEAD_MISMATCH",
      "The event workflow SHA, checkout SHA, and evaluated default head must match exactly.",
      {
        workflowSha: snapshot && snapshot.workflowSha,
        workflowRef: snapshot && snapshot.workflowRef,
        defaultBranchSha: repository.defaultBranchSha,
        scriptSha: repository.trustedScriptSha,
      },
    );
  }

  const command = snapshot && snapshot.command;
  if (!command || command.recognized !== true || command.valid !== true) {
    valid = false;
    add(
      FINDING_LEVELS.BLOCKER,
      "INVOCATION_COMMAND_INVALID",
      "The readiness issue-comment command is missing or malformed.",
      { errors: command && command.errors },
    );
  } else if (
    JSON.stringify(parseWorkflowInputs(command.inputs)) !==
    JSON.stringify(request)
  ) {
    valid = false;
    add(
      FINDING_LEVELS.BLOCKER,
      "INVOCATION_COMMAND_REQUEST_MISMATCH",
      "The evaluated request does not match the final protected comment command.",
    );
  }
  const approvedEvent = parseOptionalIssueNumber(
    command && command.inputs && command.inputs.activeEvent,
  );
  if (control.mode === policy.FACTORY_MODES.ACTIVE) {
    if (
      !approvedEvent.provided ||
      !approvedEvent.valid ||
      approvedEvent.value !== control.activeEventId
    ) {
      valid = false;
      add(
        FINDING_LEVELS.BLOCKER,
        "INVOCATION_ACTIVE_EVENT_APPROVAL_MISMATCH",
        "Active mode requires the protected command to name the exact latest active label-event ID.",
        {
          approvedEventId: approvedEvent.value,
          latestEventId: control.activeEventId,
        },
      );
    } else {
      add(
        FINDING_LEVELS.PASS,
        "INVOCATION_ACTIVE_EVENT_APPROVAL_MATCH",
        "The protected command names the exact latest active label-event ID.",
        { eventId: control.activeEventId },
      );
    }
  } else if (approvedEvent.provided) {
    valid = false;
    add(
      FINDING_LEVELS.BLOCKER,
      "INVOCATION_ACTIVE_EVENT_NOT_APPLICABLE",
      "active-event is only accepted when the current factory mode is active.",
      { mode: control.mode },
    );
  }

  if (
    !snapshot ||
    snapshot.commentExists !== true ||
    snapshot.commentBodyUnchanged !== true ||
    snapshot.commentUnedited !== true
  ) {
    valid = false;
    add(
      FINDING_LEVELS.BLOCKER,
      "INVOCATION_COMMENT_STALE_OR_EDITED",
      "The triggering command was deleted, edited, or changed after the event.",
    );
  }

  if (
    !Number.isInteger(control.issueNumber) ||
    !snapshot ||
    snapshot.issueNumber !== control.issueNumber ||
    snapshot.isPullRequest === true
  ) {
    valid = false;
    add(
      FINDING_LEVELS.BLOCKER,
      "INVOCATION_CONTROL_ISSUE_MISMATCH",
      "The readiness command must target the singleton factory-control issue, not a pull request.",
      {
        commandIssue: snapshot && snapshot.issueNumber,
        controlIssue: control.issueNumber,
      },
    );
  }

  if (
    !snapshot ||
    snapshot.approvalEnvironmentName !== FACTORY_CONTROL_ENVIRONMENT ||
    snapshot.protectedGatePassed !== true
  ) {
    valid = false;
    add(
      FINDING_LEVELS.BLOCKER,
      "INVOCATION_PROTECTED_GATE_MISSING",
      "The command did not execute through the dedicated factory-control approval gate.",
    );
  }

  const environmentValid = evaluateProtectedEnvironment(
    snapshot && snapshot.environment,
    FACTORY_CONTROL_ENVIRONMENT,
    "FACTORY_CONTROL",
    add,
  );
  valid = valid && environmentValid;

  if (valid) {
    add(
      FINDING_LEVELS.PASS,
      "INVOCATION_PROTECTED_APPROVAL_VALID",
      "The current control-issue command ran once at the exact default head through the protected factory-control environment.",
      {
        issue: snapshot.issueNumber,
        commentId: snapshot.commentId,
        runId: snapshot.runId,
      },
    );
  }
  return valid;
}

function evaluateManualAttestations(request, protectedApprovalValid, add) {
  const attestations =
    request && request.attestations && typeof request.attestations === "object"
      ? request.attestations
      : {};
  const checks = [
    {
      value: attestations.ghAwAgentToken,
      missingCode: "ATTEST_GH_AW_AGENT_TOKEN_MISSING",
      malformedCode: "ATTEST_GH_AW_AGENT_TOKEN_MALFORMED",
      untrustedCode: "ATTEST_GH_AW_AGENT_TOKEN_PROTECTED_APPROVAL_MISSING",
      passCode: "ATTEST_GH_AW_AGENT_TOKEN_CONFIRMED",
      description:
        "GH_AW_AGENT_TOKEN existence and least-authority suitability",
    },
    {
      value: attestations.actionsCanCreatePullRequests,
      missingCode: "ATTEST_ACTIONS_PR_CREATION_MISSING",
      malformedCode: "ATTEST_ACTIONS_PR_CREATION_MALFORMED",
      untrustedCode: "ATTEST_ACTIONS_PR_CREATION_PROTECTED_APPROVAL_MISSING",
      passCode: "ATTEST_ACTIONS_PR_CREATION_CONFIRMED",
      description: "repository Actions pull-request creation capability",
    },
  ];

  for (const check of checks) {
    if (check.value === null) {
      add(
        FINDING_LEVELS.BLOCKER,
        check.malformedCode,
        `The manual attestation for ${check.description} is malformed.`,
      );
    } else if (check.value !== true) {
      add(
        FINDING_LEVELS.BLOCKER,
        check.missingCode,
        `A protected factory-control reviewer must approve an explicit attestation for ${check.description}; the preflight never infers it.`,
      );
    } else if (protectedApprovalValid !== true) {
      add(
        FINDING_LEVELS.BLOCKER,
        check.untrustedCode,
        `The ${check.description} attestation was not approved through the protected factory-control environment.`,
      );
    } else {
      add(
        FINDING_LEVELS.PASS,
        check.passCode,
        `The protected command explicitly attests ${check.description}; the preflight does not infer it.`,
      );
    }
  }
}

function resolveLatestByNumericId(items) {
  const values = Array.isArray(items) ? items : [];
  if (values.length === 0) {
    return { valid: false, reason: "missing", value: null };
  }
  const normalized = [];
  for (const value of values) {
    const id = Number(value && value.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return { valid: false, reason: "invalid-id", value: null };
    }
    normalized.push({ id, value });
  }
  normalized.sort((left, right) => right.id - left.id);
  if (normalized.length > 1 && normalized[0].id === normalized[1].id) {
    return { valid: false, reason: "ambiguous-id", value: null };
  }
  return { valid: true, reason: "ok", value: normalized[0].value };
}

function isGitHubActionsCreator(value) {
  if (
    !value ||
    !value.creator ||
    value.creator.login !== GITHUB_ACTIONS_BOT_LOGIN ||
    value.creator.type !== "Bot" ||
    Number(value.creator.id) !== GITHUB_ACTIONS_BOT_ID
  ) {
    return false;
  }
  const app = value.performed_via_github_app;
  return !app || app.slug === GITHUB_ACTIONS_APP_SLUG;
}

function isExactActionsRunUrl(value, run, repositoryFullName) {
  if (
    typeof value !== "string" ||
    !run ||
    typeof run.html_url !== "string" ||
    value !== run.html_url ||
    typeof repositoryFullName !== "string" ||
    !URL.canParse(value)
  ) {
    return false;
  }
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    url.hostname === "github.com" &&
    url.pathname ===
      `/${repositoryFullName}/actions/runs/${Number(run.id)}` &&
    url.search === "" &&
    url.hash === ""
  );
}

function evaluateEvidence(snapshot, repository, add) {
  if (!snapshot || !isSha(snapshot.sha)) {
    add(
      FINDING_LEVELS.BLOCKER,
      "EVIDENCE_SHA_INVALID",
      "The exact evidence SHA is missing or malformed.",
    );
    return;
  }

  if (snapshot.commitExists !== true) {
    add(
      FINDING_LEVELS.BLOCKER,
      "EVIDENCE_SHA_NOT_FOUND",
      "The exact evidence SHA does not resolve to a repository commit.",
      { sha: snapshot.sha },
    );
  }

  if (
    snapshot.sha !== repository.defaultBranchSha ||
    snapshot.sha !== repository.finalDefaultBranchSha
  ) {
    add(
      FINDING_LEVELS.BLOCKER,
      "EVIDENCE_SHA_STALE",
      "Readiness evidence is not for the stable trusted default-branch head.",
      {
        evidenceSha: snapshot.sha,
        initialSha: repository.defaultBranchSha,
        finalSha: repository.finalDefaultBranchSha,
      },
    );
  } else {
    add(
      FINDING_LEVELS.PASS,
      "EVIDENCE_SHA_CURRENT",
      "Readiness evidence targets the stable trusted default-branch head exactly.",
      { sha: snapshot.sha },
    );
  }

  const exactPushRuns = (Array.isArray(snapshot.ciRuns)
    ? snapshot.ciRuns
    : []
  ).filter(
    (run) =>
      run &&
      run.head_sha === snapshot.sha &&
      run.event === "push" &&
      run.head_branch === repository.defaultBranch &&
      run.repository &&
      run.repository.full_name === repository.fullName &&
      run.head_repository &&
      run.head_repository.full_name === repository.fullName,
  );
  const pushResolution = resolveLatestByNumericId(exactPushRuns);
  const latestPushRun = pushResolution.value;
  if (!pushResolution.valid) {
    add(
      FINDING_LEVELS.BLOCKER,
      pushResolution.reason === "missing"
        ? "EVIDENCE_PUSH_CI_MISSING"
        : "EVIDENCE_PUSH_CI_AMBIGUOUS",
      "An unambiguous exact-SHA push-triggered CI run could not be established.",
      { reason: pushResolution.reason, sha: snapshot.sha },
    );
  } else if (
    latestPushRun.name === "CI" &&
    latestPushRun.path === ".github/workflows/ci.yml" &&
    latestPushRun.status === "completed" &&
    latestPushRun.conclusion === "success"
  ) {
    add(
      FINDING_LEVELS.PASS,
      "EVIDENCE_PUSH_CI_SUCCESS",
      "The latest exact-SHA trusted push-triggered CI run succeeded.",
      { runId: latestPushRun.id, sha: snapshot.sha },
    );
  } else {
    add(
      FINDING_LEVELS.BLOCKER,
      latestPushRun.name !== "CI" ||
        latestPushRun.path !== ".github/workflows/ci.yml"
        ? "EVIDENCE_PUSH_CI_INVALID"
        : latestPushRun.status === "completed"
          ? "EVIDENCE_PUSH_CI_FAILED"
          : "EVIDENCE_PUSH_CI_PENDING",
      "The latest exact-SHA trusted push-triggered CI run is not successful.",
      {
        runId: latestPushRun.id,
        status: latestPushRun.status,
        conclusion: latestPushRun.conclusion,
      },
    );
  }

  const developmentValid = evaluateDevelopmentEnvironment(
    snapshot.developmentEnvironment,
    add,
  );

  const workflow = snapshot.devWorkflow;
  const workflowValid =
    workflow &&
    Number.isSafeInteger(Number(workflow.id)) &&
    workflow.name === DEV_WORKFLOW_NAME &&
    workflow.path === DEV_WORKFLOW_PATH &&
    workflow.state === "active";
  if (!workflowValid) {
    add(
      FINDING_LEVELS.BLOCKER,
      "EVIDENCE_DEV_WORKFLOW_INVALID",
      "The trusted Azure dev evidence workflow identity is missing, inactive, or mismatched.",
    );
  }

  const exactDevRuns = (Array.isArray(snapshot.devRuns)
    ? snapshot.devRuns
    : []
  ).filter(
    (run) =>
      run &&
      run.head_sha === snapshot.sha &&
      run.head_branch === repository.defaultBranch &&
      run.repository &&
      run.repository.full_name === repository.fullName &&
      run.head_repository &&
      run.head_repository.full_name === repository.fullName,
  );
  const devResolution = resolveLatestByNumericId(exactDevRuns);
  const producerRun = devResolution.value;
  let producerValid = false;
  if (!devResolution.valid) {
    add(
      FINDING_LEVELS.BLOCKER,
      devResolution.reason === "missing"
        ? "EVIDENCE_DEV_PRODUCER_MISSING"
        : "EVIDENCE_DEV_PRODUCER_AMBIGUOUS",
      "An unambiguous exact-SHA Azure dev evidence producer run could not be established.",
      { reason: devResolution.reason },
    );
  } else {
    const automatic =
      AUTOMATIC_DEV_EVIDENCE_EVENTS.includes(producerRun.event) &&
      Number.isSafeInteger(Number(producerRun.run_attempt)) &&
      Number(producerRun.run_attempt) >= 1;
    const manualActor = producerRun.triggering_actor || producerRun.actor;
    const protectedHumanRetry =
      HUMAN_RETRY_DEV_EVIDENCE_EVENTS.includes(producerRun.event) &&
      producerRun.run_attempt === 1 &&
      manualActor &&
      manualActor.type === "User";
    producerValid =
      workflowValid &&
      developmentValid &&
      producerRun.workflow_id === Number(workflow.id) &&
      producerRun.name === DEV_WORKFLOW_NAME &&
      producerRun.path === DEV_WORKFLOW_PATH &&
      producerRun.status === "completed" &&
      producerRun.conclusion === "success" &&
      isExactActionsRunUrl(
        producerRun.html_url,
        producerRun,
        repository.fullName,
      ) &&
      (automatic || protectedHumanRetry);
    if (!producerValid) {
      add(
        FINDING_LEVELS.BLOCKER,
        "EVIDENCE_DEV_PRODUCER_INVALID",
        "The latest exact-SHA Azure dev run lacks trusted workflow identity, allowed event/ref, first attempt, successful conclusion, or protected retry provenance.",
        {
          runId: producerRun.id,
          event: producerRun.event,
          runAttempt: producerRun.run_attempt,
          status: producerRun.status,
          conclusion: producerRun.conclusion,
        },
      );
    } else {
      add(
        FINDING_LEVELS.PASS,
        "EVIDENCE_DEV_PRODUCER_VALID",
        automatic
          ? "The latest exact-SHA Azure dev evidence came from the documented automatic producer event."
          : "The latest exact-SHA Azure dev evidence came from a protected human-dispatch retry event.",
        { runId: producerRun.id, event: producerRun.event },
      );
    }
  }

  const statusResolution = resolveLatestByNumericId(
    (Array.isArray(snapshot.statuses) ? snapshot.statuses : []).filter(
      (status) => status && status.context === lifecycle.DEV_EVIDENCE_STATUS_CONTEXT,
    ),
  );
  const status = statusResolution.value;
  const statusValid =
    producerValid &&
    statusResolution.valid &&
    status.state === "success" &&
    status.description === DEV_SUCCESS_DESCRIPTION &&
    isGitHubActionsCreator(status) &&
    isExactActionsRunUrl(
      status.target_url,
      producerRun,
      repository.fullName,
    );
  if (!statusValid) {
    add(
      FINDING_LEVELS.BLOCKER,
      statusResolution.reason === "missing"
        ? "EVIDENCE_DEV_STATUS_MISSING"
        : statusResolution.valid
          ? "EVIDENCE_DEV_STATUS_INVALID"
          : "EVIDENCE_DEV_STATUS_AMBIGUOUS",
      "The latest exact-SHA Dev deployment evidence status is not a successful GitHub Actions status correlated to the producer run.",
      { reason: statusResolution.reason, state: status && status.state },
    );
  } else {
    add(
      FINDING_LEVELS.PASS,
      "EVIDENCE_DEV_STATUS_SUCCESS",
      "The latest Dev deployment evidence status is successful and correlated to the trusted producer run.",
      { runId: producerRun.id, sha: snapshot.sha },
    );
  }

  const deploymentResolution = resolveLatestByNumericId(
    (Array.isArray(snapshot.deployments) ? snapshot.deployments : []).filter(
      (deployment) =>
        deployment &&
        deployment.sha === snapshot.sha &&
        deployment.environment === lifecycle.DEV_ENVIRONMENT &&
        deployment.transient_environment === true &&
        deployment.production_environment === false,
    ),
  );
  const deployment = deploymentResolution.value;
  const deploymentStatusResolution = resolveLatestByNumericId(
    deployment &&
      snapshot.deploymentStatusesByDeployment &&
      snapshot.deploymentStatusesByDeployment[deployment.id],
  );
  const deploymentStatus = deploymentStatusResolution.value;
  const deploymentValid =
    producerValid &&
    statusValid &&
    deploymentResolution.valid &&
    deploymentStatusResolution.valid &&
    deployment.description === DEV_SUCCESS_DESCRIPTION &&
    isGitHubActionsCreator(deployment) &&
    deploymentStatus.state === "success" &&
    deploymentStatus.description === DEV_SUCCESS_DESCRIPTION &&
    isGitHubActionsCreator(deploymentStatus) &&
    isExactActionsRunUrl(
      deploymentStatus.log_url,
      producerRun,
      repository.fullName,
    );
  if (deploymentValid) {
    add(
      FINDING_LEVELS.PASS,
      "EVIDENCE_DEVELOPMENT_DEPLOYMENT_SUCCESS",
      "The latest explicit development Deployment is successful and correlated to the trusted exact-SHA producer run.",
      {
        deploymentId: deployment.id,
        runId: producerRun.id,
      },
    );
  } else {
    add(
      FINDING_LEVELS.BLOCKER,
      deploymentResolution.reason === "ambiguous-id" ||
        deploymentStatusResolution.reason === "ambiguous-id"
        ? "EVIDENCE_DEVELOPMENT_DEPLOYMENT_AMBIGUOUS"
        : "EVIDENCE_DEVELOPMENT_DEPLOYMENT_INVALID",
      "The latest explicit development Deployment and status must be unambiguous, successful GitHub Actions evidence correlated to the producer run.",
      {
        deploymentReason: deploymentResolution.reason,
        statusReason: deploymentStatusResolution.reason,
      },
    );
  }
}

function normalizeDigestText(value) {
  return typeof value === "string"
    ? value.replace(/\r\n?/g, "\n").trim()
    : "";
}

function computeGoalAuthorizationDigest(issue) {
  if (!issue || !Number.isSafeInteger(issue.number)) {
    return { valid: false, reason: "goal-identity-invalid", digest: null };
  }
  const milestone = issue.milestone;
  if (
    !milestone ||
    !Number.isSafeInteger(Number(milestone.id)) ||
    !Number.isSafeInteger(Number(milestone.number)) ||
    typeof milestone.node_id !== "string" ||
    milestone.node_id.trim() === "" ||
    typeof milestone.title !== "string" ||
    milestone.title.trim() === ""
  ) {
    return { valid: false, reason: "milestone-identity-invalid", digest: null };
  }

  const sections = queueRuntime.extractIssueFormSections(issue.body);
  const narrative = {};
  for (const heading of queueRuntime.GOAL_REQUIRED_NARRATIVE_HEADINGS) {
    const value = queueRuntime.getIssueFormSection(sections, heading);
    if (value === undefined) {
      return {
        valid: false,
        reason: `goal-field-invalid:${heading}`,
        digest: null,
      };
    }
    narrative[heading] = normalizeDigestText(value);
  }
  const paths = policy.normalizeAllowedPathPatterns(
    queueRuntime.getIssueFormSection(
      sections,
      queueRuntime.GOAL_FORM_HEADINGS.allowedPaths,
    ),
  );
  const boundaries = queueRuntime.validateCanonicalGoalBoundaries(
    queueRuntime.getIssueFormSection(
      sections,
      queueRuntime.GOAL_FORM_HEADINGS.boundaries,
    ),
  );
  const maxRisk = queueRuntime.getIssueFormSection(
    sections,
    queueRuntime.GOAL_FORM_HEADINGS.maxRisk,
  );
  const maxWip = queueRuntime.parseNonNegativeInteger(
    queueRuntime.getIssueFormSection(
      sections,
      queueRuntime.GOAL_FORM_HEADINGS.maxWip,
    ),
  );
  const assignmentBudget = queueRuntime.parseNonNegativeInteger(
    queueRuntime.getIssueFormSection(
      sections,
      queueRuntime.GOAL_FORM_HEADINGS.assignmentBudget,
    ),
  );
  if (
    !paths.valid ||
    !boundaries.valid ||
    !policy.isKnownRiskTier(maxRisk) ||
    maxWip === null ||
    assignmentBudget === null
  ) {
    return {
      valid: false,
      reason: "goal-authorization-fields-invalid",
      digest: null,
    };
  }

  const canonical = {
    schemaVersion: 1,
    goal: {
      number: issue.number,
      milestone: {
        id: Number(milestone.id),
        number: Number(milestone.number),
        nodeId: milestone.node_id.trim(),
        title: milestone.title.trim(),
      },
    },
    authorization: {
      narrative,
      allowedPaths: [...paths.patterns].sort(),
      maxRisk,
      maxWip,
      assignmentBudget,
      boundaries: [...queueRuntime.GOAL_BOUNDARY_STATEMENTS],
    },
  };
  const serialized = JSON.stringify(canonical);
  return {
    valid: true,
    reason: "ok",
    digest: crypto.createHash("sha256").update(serialized).digest("hex"),
    canonical,
  };
}

function evaluateGoal(snapshot, request, protectedApprovalValid, add) {
  const goalRequest =
    request && request.goalIssue && typeof request.goalIssue === "object"
      ? request.goalIssue
      : { provided: false, valid: true, value: undefined };
  const required = request && request.mode === PREFLIGHT_MODES.CANARY;
  if (!goalRequest.provided) {
    add(
      required ? FINDING_LEVELS.BLOCKER : FINDING_LEVELS.WARNING,
      required ? "GOAL_REQUIRED" : "GOAL_NOT_EVALUATED_BASELINE",
      required
        ? "Canary mode requires an explicit goal issue number."
        : "Baseline mode does not require or evaluate a goal.",
    );
    return { evaluated: false, valid: false, goal: null };
  }
  if (!goalRequest.valid) {
    add(
      required ? FINDING_LEVELS.BLOCKER : FINDING_LEVELS.WARNING,
      "GOAL_NUMBER_INVALID",
      "The supplied goal issue number is not a positive integer.",
    );
    return { evaluated: false, valid: false, goal: null };
  }

  const issue = snapshot && snapshot.issue;
  let valid = true;
  if (!issue || issue.number !== goalRequest.value) {
    add(
      FINDING_LEVELS.BLOCKER,
      "GOAL_ISSUE_NOT_FOUND",
      "The requested goal issue could not be resolved.",
      { issue: goalRequest.value },
    );
    return { evaluated: true, valid: false, goal: null };
  }

  const labels = queueRuntime.normalizeLabels(issue.labels);
  if (issue.state !== "open") {
    valid = false;
    add(
      FINDING_LEVELS.BLOCKER,
      "GOAL_NOT_OPEN",
      "The requested goal issue is not open.",
      { issue: issue.number },
    );
  } else {
    add(
      FINDING_LEVELS.PASS,
      "GOAL_OPEN",
      "The requested goal issue is open.",
      { issue: issue.number },
    );
  }

  if (!labels.includes(queueRuntime.GOAL_LABEL)) {
    valid = false;
    add(
      FINDING_LEVELS.BLOCKER,
      "GOAL_CLASSIFICATION_MISSING",
      "The requested issue lacks the canonical factory goal classification.",
      { issue: issue.number },
    );
  } else {
    add(
      FINDING_LEVELS.PASS,
      "GOAL_CLASSIFICATION_PRESENT",
      "The requested issue carries the canonical factory goal classification.",
      { issue: issue.number },
    );
  }

  if (!labels.includes(queueRuntime.GOAL_APPROVED_LABEL)) {
    valid = false;
    add(
      FINDING_LEVELS.BLOCKER,
      "GOAL_APPROVAL_LABEL_MISSING",
      "The requested goal is not currently approved.",
      { issue: issue.number },
    );
  } else {
    const ordered = evaluateOrderedLabelEvent({
      events: snapshot.timelineEvents,
      labelName: queueRuntime.GOAL_APPROVED_LABEL,
      missingCode: "GOAL_APPROVAL_EVENT_MISSING",
      ambiguousCode: "GOAL_APPROVAL_EVENT_AMBIGUOUS",
      passCode: "GOAL_APPROVAL_EVENT_ORDERED",
      subject: "Factory goal approval",
      add,
    });
    valid = valid && ordered !== null;
  }

  const milestone = issue.milestone;
  const milestoneIdentityValid =
    milestone &&
    Number.isSafeInteger(Number(milestone.id)) &&
    Number.isSafeInteger(Number(milestone.number)) &&
    typeof milestone.node_id === "string" &&
    milestone.node_id.trim() !== "" &&
    typeof milestone.title === "string" &&
    milestone.title.trim() !== "";
  if (!milestoneIdentityValid) {
    valid = false;
    add(
      FINDING_LEVELS.BLOCKER,
      "GOAL_MILESTONE_IDENTITY_INVALID",
      "The goal is not bound to one complete milestone identity.",
      { issue: issue.number },
    );
  } else {
    add(
      FINDING_LEVELS.PASS,
      "GOAL_MILESTONE_VALID",
      "The goal is bound to a complete milestone identity.",
      {
        milestoneId: Number(milestone.id),
        milestoneNumber: Number(milestone.number),
        milestoneTitle: milestone.title,
      },
    );
  }

  const sections = queueRuntime.extractIssueFormSections(issue.body);
  const missingNarrative = queueRuntime.GOAL_REQUIRED_NARRATIVE_HEADINGS.filter(
    (heading) =>
      queueRuntime.getIssueFormSection(sections, heading) === undefined,
  );
  if (missingNarrative.length > 0) {
    valid = false;
    add(
      FINDING_LEVELS.BLOCKER,
      "GOAL_FIELDS_INCOMPLETE",
      "Required goal narrative fields are missing, blank, or ambiguous.",
      { fields: missingNarrative },
    );
  } else {
    add(
      FINDING_LEVELS.PASS,
      "GOAL_FIELDS_COMPLETE",
      "All required goal narrative fields are present and unambiguous.",
    );
  }

  const boundaries = queueRuntime.validateCanonicalGoalBoundaries(
    queueRuntime.getIssueFormSection(
      sections,
      queueRuntime.GOAL_FORM_HEADINGS.boundaries,
    ),
  );
  if (!boundaries.valid) {
    valid = false;
    add(
      FINDING_LEVELS.BLOCKER,
      "GOAL_BOUNDARIES_INVALID",
      "The goal must contain exactly the three canonical checked human-only boundary statements.",
      { reason: boundaries.reason },
    );
  } else {
    add(
      FINDING_LEVELS.PASS,
      "GOAL_BOUNDARIES_CONFIRMED",
      "The goal contains exactly the three canonical checked human-only boundary statements.",
    );
  }

  const allowedPaths = policy.normalizeAllowedPathPatterns(
    queueRuntime.getIssueFormSection(
      sections,
      queueRuntime.GOAL_FORM_HEADINGS.allowedPaths,
    ),
  );
  if (!allowedPaths.valid) {
    valid = false;
    add(
      FINDING_LEVELS.BLOCKER,
      "GOAL_PATH_SCOPE_INVALID",
      "The goal's machine-readable allowed-path scope is missing or invalid.",
      { reason: allowedPaths.reason },
    );
  } else if (
    allowedPaths.patterns.length !== 1 ||
    allowedPaths.patterns[0] !== CANARY_PATH
  ) {
    valid = false;
    add(
      FINDING_LEVELS.BLOCKER,
      "GOAL_CANARY_PATH_BOUND_INVALID",
      "Canary readiness requires the goal scope to be exactly the factory heartbeat document.",
      { paths: allowedPaths.patterns, required: [CANARY_PATH] },
    );
  } else {
    add(
      FINDING_LEVELS.PASS,
      "GOAL_CANARY_PATH_BOUND_VALID",
      "The goal scope is exactly the factory heartbeat document.",
      { paths: allowedPaths.patterns },
    );
  }

  const maxRisk = queueRuntime.getIssueFormSection(
    sections,
    queueRuntime.GOAL_FORM_HEADINGS.maxRisk,
  );
  if (maxRisk !== policy.RISK_TIERS.ROUTINE) {
    valid = false;
    add(
      FINDING_LEVELS.BLOCKER,
      "GOAL_CANARY_RISK_BOUND_INVALID",
      "Canary readiness requires the goal risk ceiling to be exactly risk:routine.",
      { value: maxRisk },
    );
  } else {
    add(
      FINDING_LEVELS.PASS,
      "GOAL_CANARY_RISK_BOUND_VALID",
      "The goal risk ceiling is exactly risk:routine.",
      { value: maxRisk },
    );
  }

  const maxWip = queueRuntime.parseNonNegativeInteger(
    queueRuntime.getIssueFormSection(
      sections,
      queueRuntime.GOAL_FORM_HEADINGS.maxWip,
    ),
  );
  if (
    maxWip !== 1
  ) {
    valid = false;
    add(
      FINDING_LEVELS.BLOCKER,
      "GOAL_CANARY_WIP_BOUND_INVALID",
      "Canary readiness requires max_wip to be exactly 1.",
      { value: maxWip },
    );
  } else if (
    !Number.isInteger(snapshot.currentInFlightCount) ||
    snapshot.currentInFlightCount < 0
  ) {
    valid = false;
    add(
      FINDING_LEVELS.BLOCKER,
      "GOAL_WIP_USAGE_INVALID",
      "Current factory WIP usage could not be established.",
    );
  } else if (snapshot.currentInFlightCount !== 0) {
    valid = false;
    add(
      FINDING_LEVELS.BLOCKER,
      "GOAL_CANARY_WIP_NOT_EMPTY",
      "Canary readiness requires the single WIP unit to remain unused.",
      { used: snapshot.currentInFlightCount, limit: maxWip },
    );
  } else {
    add(
      FINDING_LEVELS.PASS,
      "GOAL_CANARY_WIP_AVAILABLE",
      "The goal has exactly one unused WIP unit.",
      { used: snapshot.currentInFlightCount, limit: maxWip },
    );
  }

  const budget = queueRuntime.parseNonNegativeInteger(
    queueRuntime.getIssueFormSection(
      sections,
      queueRuntime.GOAL_FORM_HEADINGS.assignmentBudget,
    ),
  );
  if (budget !== 1) {
    valid = false;
    add(
      FINDING_LEVELS.BLOCKER,
      "GOAL_CANARY_ASSIGNMENT_BOUND_INVALID",
      "Canary readiness requires the assignment budget to be exactly 1.",
      { value: budget },
    );
  } else if (
    !Number.isInteger(snapshot.currentBudgetUsed) ||
    snapshot.currentBudgetUsed < 0
  ) {
    valid = false;
    add(
      FINDING_LEVELS.BLOCKER,
      "GOAL_ASSIGNMENT_USAGE_INVALID",
      "Current goal assignment-budget usage could not be established.",
    );
  } else if (snapshot.currentBudgetUsed !== 0) {
    valid = false;
    add(
      FINDING_LEVELS.BLOCKER,
      "GOAL_CANARY_ASSIGNMENT_NOT_EMPTY",
      "Canary readiness requires the single assignment unit to remain unused.",
      { used: snapshot.currentBudgetUsed, limit: budget },
    );
  } else {
    add(
      FINDING_LEVELS.PASS,
      "GOAL_CANARY_ASSIGNMENT_AVAILABLE",
      "The goal has exactly one unused assignment unit.",
      { used: snapshot.currentBudgetUsed, limit: budget },
    );
  }

  const digestResult = computeGoalAuthorizationDigest(issue);
  const approvedDigest =
    request && request.goalDigest && request.goalDigest.valid
      ? request.goalDigest.value
      : undefined;
  if (!request || !request.goalDigest || !request.goalDigest.provided) {
    valid = false;
    add(
      FINDING_LEVELS.BLOCKER,
      "GOAL_APPROVAL_DIGEST_MISSING",
      "Canary readiness requires a protected approval record containing the current canonical goal digest.",
    );
  } else if (!request.goalDigest.valid) {
    valid = false;
    add(
      FINDING_LEVELS.BLOCKER,
      "GOAL_APPROVAL_DIGEST_MALFORMED",
      "The protected goal approval digest must be 64 lowercase hexadecimal characters.",
    );
  } else if (!digestResult.valid) {
    valid = false;
    add(
      FINDING_LEVELS.BLOCKER,
      "GOAL_AUTHORIZATION_DIGEST_UNAVAILABLE",
      "The current goal authorization and milestone identity could not be canonically digested.",
      { reason: digestResult.reason },
    );
  } else if (approvedDigest !== digestResult.digest) {
    valid = false;
    add(
      FINDING_LEVELS.BLOCKER,
      "GOAL_APPROVAL_DIGEST_MISMATCH",
      "The protected approval digest does not match the current goal authorization fields and milestone identity.",
      { approved: approvedDigest, current: digestResult.digest },
    );
  } else if (protectedApprovalValid !== true) {
    valid = false;
    add(
      FINDING_LEVELS.BLOCKER,
      "GOAL_APPROVAL_DIGEST_UNPROTECTED",
      "The matching goal digest was not approved through the protected factory-control environment.",
    );
  } else {
    add(
      FINDING_LEVELS.PASS,
      "GOAL_APPROVAL_DIGEST_MATCH",
      "The protected approval digest matches the current goal authorization fields and milestone identity.",
      { digest: digestResult.digest },
    );
  }

  const approvedGoalIssues =
    snapshot && Array.isArray(snapshot.approvedGoalIssues)
      ? snapshot.approvedGoalIssues
      : null;
  let canonical = {
    valid: false,
    reason: "approved-goal-inventory-invalid",
    goal: null,
  };
  if (approvedGoalIssues === null) {
    valid = false;
    add(
      FINDING_LEVELS.BLOCKER,
      "GOAL_APPROVED_INVENTORY_INVALID",
      "The open approved-goal inventory is missing or malformed.",
    );
  } else {
    canonical = queueRuntime.resolveActiveGoal(approvedGoalIssues);
    if (!canonical.valid) {
      valid = false;
      add(
        FINDING_LEVELS.BLOCKER,
        canonical.reason === "multiple-active-goals"
          ? "GOAL_APPROVED_SET_AMBIGUOUS"
          : "GOAL_CANONICAL_RESOLUTION_FAILED",
        "The canonical queue-runtime goal resolver rejected the open approved-goal set.",
        { reason: canonical.reason, count: approvedGoalIssues.length },
      );
    } else if (canonical.goal.number !== issue.number) {
      valid = false;
      add(
        FINDING_LEVELS.BLOCKER,
        "GOAL_APPROVED_SET_MISMATCH",
        "The requested goal is not the singleton goal selected by the canonical queue runtime.",
        { requested: issue.number, selected: canonical.goal.number },
      );
    } else {
      add(
        FINDING_LEVELS.PASS,
        "GOAL_CANONICAL_RESOLUTION_VALID",
        "The requested goal is the singleton goal accepted by the canonical queue runtime.",
      );
    }
  }

  if (
    canonical.valid &&
    canonical.goal &&
    canonical.goal.number === issue.number
  ) {
    add(
      FINDING_LEVELS.PASS,
      "GOAL_APPROVED_SET_SINGLETON",
      "Exactly one open approved goal exists and it is the requested goal.",
      { issue: issue.number },
    );
  }

  return {
    evaluated: true,
    valid,
    digest: digestResult.valid ? digestResult.digest : null,
    goal:
      canonical.valid &&
      canonical.goal &&
      canonical.goal.number === issue.number
        ? canonical.goal
        : null,
  };
}

function evaluateCanary(snapshot, request, goalEvaluation, observedAt, add) {
  const canaryRequest =
    request && request.canaryIssue && typeof request.canaryIssue === "object"
      ? request.canaryIssue
      : { provided: false, valid: true, value: undefined };
  const goalRequest =
    request && request.goalIssue && typeof request.goalIssue === "object"
      ? request.goalIssue
      : { provided: false, valid: true, value: undefined };
  const required = request && request.mode === PREFLIGHT_MODES.CANARY;
  if (!canaryRequest.provided) {
    add(
      required ? FINDING_LEVELS.BLOCKER : FINDING_LEVELS.WARNING,
      required ? "CANARY_REQUIRED" : "CANARY_NOT_EVALUATED_BASELINE",
      required
        ? "Canary mode requires an explicit canary issue number."
        : "Baseline mode does not require or evaluate a canary.",
    );
    return { evaluated: false, valid: false, selectedNumber: null };
  }
  if (!canaryRequest.valid) {
    add(
      required ? FINDING_LEVELS.BLOCKER : FINDING_LEVELS.WARNING,
      "CANARY_NUMBER_INVALID",
      "The supplied canary issue number is not a positive integer.",
    );
    return { evaluated: false, valid: false, selectedNumber: null };
  }

  const candidate = snapshot && snapshot.candidate;
  if (!candidate || candidate.number !== canaryRequest.value) {
    add(
      FINDING_LEVELS.BLOCKER,
      "CANARY_ISSUE_NOT_FOUND",
      "The requested canary issue could not be resolved into a queue candidate.",
      { issue: canaryRequest.value },
    );
    return { evaluated: true, valid: false, selectedNumber: null };
  }

  let valid = true;
  const expectedGoal = goalRequest.value;
  if (
    !Number.isInteger(expectedGoal) ||
    candidate.parentGoalNumber !== expectedGoal ||
    candidate.nativeParentGoalNumber !== expectedGoal ||
    candidate.parentGoalApproved !== true
  ) {
    valid = false;
    add(
      FINDING_LEVELS.BLOCKER,
      "CANARY_NATIVE_PARENT_INVALID",
      "The canary's rendered and native parent must both match the approved goal.",
      {
        expected: expectedGoal,
        rendered: candidate.parentGoalNumber,
        native: candidate.nativeParentGoalNumber,
      },
    );
  } else {
    add(
      FINDING_LEVELS.PASS,
      "CANARY_NATIVE_PARENT_VALID",
      "The canary's rendered and native parent both match the approved goal.",
      { goal: expectedGoal },
    );
  }

  if (candidate.state !== "open" || candidate.isLeaf !== true) {
    valid = false;
    add(
      FINDING_LEVELS.BLOCKER,
      "CANARY_NOT_OPEN_LEAF",
      "The canary must be open and have no open native sub-issues.",
      { state: candidate.state, isLeaf: candidate.isLeaf },
    );
  } else {
    add(
      FINDING_LEVELS.PASS,
      "CANARY_OPEN_LEAF",
      "The canary is open and has no open native sub-issues.",
    );
  }

  const missingReadiness = queue.READINESS_FIELDS.filter(
    (field) => candidate[field] !== true,
  );
  if (missingReadiness.length > 0) {
    valid = false;
    add(
      FINDING_LEVELS.BLOCKER,
      "CANARY_READINESS_INCOMPLETE",
      "The canary is missing one or more canonical queue-readiness fields.",
      { fields: missingReadiness },
    );
  } else {
    add(
      FINDING_LEVELS.PASS,
      "CANARY_READINESS_COMPLETE",
      "All canonical queue-readiness fields are complete.",
    );
  }

  const goalPaths =
    goalEvaluation.goal && Array.isArray(goalEvaluation.goal.goalAllowedPaths)
      ? goalEvaluation.goal.goalAllowedPaths
      : [];
  if (
    candidate.hasScopeDefinition !== true ||
    goalPaths.length !== 1 ||
    goalPaths[0] !== CANARY_PATH ||
    !Array.isArray(candidate.allowedPaths) ||
    candidate.allowedPaths.length !== 1 ||
    candidate.allowedPaths[0] !== CANARY_PATH
  ) {
    valid = false;
    add(
      FINDING_LEVELS.BLOCKER,
      "CANARY_SCOPE_INVALID",
      "The goal and canary scopes must both be exactly the factory heartbeat document.",
      { canaryPaths: candidate.allowedPaths, goalPaths, required: [CANARY_PATH] },
    );
  } else {
    add(
      FINDING_LEVELS.PASS,
      "CANARY_SCOPE_VALID",
      "The goal and canary scopes are exactly the factory heartbeat document.",
      { paths: candidate.allowedPaths },
    );
  }

  const labels = Array.isArray(candidate.labels) ? candidate.labels : [];
  if (!labels.includes(queueRuntime.FACTORY_LABEL)) {
    valid = false;
    add(
      FINDING_LEVELS.BLOCKER,
      "CANARY_FACTORY_LABEL_MISSING",
      "The canary lacks the canonical factory enrollment label.",
    );
  } else {
    add(
      FINDING_LEVELS.PASS,
      "CANARY_FACTORY_LABEL_PRESENT",
      "The canary carries the canonical factory enrollment label.",
    );
  }

  const lifecycleLabels = labels.filter((label) =>
    policy.LIFECYCLE_STATE_VALUES.includes(label),
  );
  if (
    lifecycleLabels.length !== 1 ||
    lifecycleLabels[0] !== policy.QUEUE_READY_LABEL
  ) {
    valid = false;
    add(
      FINDING_LEVELS.BLOCKER,
      "CANARY_LIFECYCLE_INVALID",
      "The canary must carry exactly one lifecycle label and it must be queue-ready.",
      { labels: lifecycleLabels },
    );
  } else {
    add(
      FINDING_LEVELS.PASS,
      "CANARY_LIFECYCLE_READY",
      "The canary carries exactly the queue-ready lifecycle label.",
    );
  }

  const riskLabels = labels.filter((label) =>
    policy.RISK_TIER_LABELS.includes(label),
  );
  if (
    riskLabels.length !== 1 ||
    riskLabels[0] !== policy.RISK_TIERS.ROUTINE ||
    candidate.hasRiskAssessment !== true
  ) {
    valid = false;
    add(
      FINDING_LEVELS.BLOCKER,
      "CANARY_RISK_INVALID",
      "The canary must have exactly risk:routine and match its rendered risk field.",
      { labels: riskLabels },
    );
  } else {
    add(
      FINDING_LEVELS.PASS,
      "CANARY_RISK_VALID",
      "The canary has the exact routine, matching risk assessment.",
      { risk: riskLabels[0] },
    );
  }

  if (!Array.isArray(candidate.dependencyStates)) {
    valid = false;
    add(
      FINDING_LEVELS.BLOCKER,
      "CANARY_DEPENDENCIES_UNKNOWN",
      "The canary's dependency state could not be established.",
    );
  } else if (candidate.dependencyStates.some((state) => state !== "closed")) {
    valid = false;
    add(
      FINDING_LEVELS.BLOCKER,
      "CANARY_DEPENDENCIES_OPEN",
      "The canary has an unresolved dependency.",
      { states: candidate.dependencyStates },
    );
  } else {
    add(
      FINDING_LEVELS.PASS,
      "CANARY_DEPENDENCIES_CLEAR",
      "The canary has no unresolved dependencies.",
    );
  }

  const claim = queue.evaluateClaimState(candidate.activeClaim, observedAt);
  if (claim.malformed) {
    valid = false;
    add(
      FINDING_LEVELS.BLOCKER,
      "CANARY_CLAIM_MALFORMED",
      "The canary has a malformed claim and must be recovered explicitly.",
    );
  } else if (claim.expired) {
    valid = false;
    add(
      FINDING_LEVELS.BLOCKER,
      "CANARY_CLAIM_STALE",
      "The canary has an expired claim and must be recovered explicitly.",
    );
  } else if (claim.blocking) {
    valid = false;
    add(
      FINDING_LEVELS.BLOCKER,
      "CANARY_CLAIM_ACTIVE",
      "The canary already has an active claim.",
    );
  } else {
    add(
      FINDING_LEVELS.PASS,
      "CANARY_CLAIM_CLEAR",
      "The canary has no current or stale claim.",
    );
  }

  if (!Array.isArray(candidate.assignees) || candidate.assignees.length > 0) {
    valid = false;
    add(
      FINDING_LEVELS.BLOCKER,
      "CANARY_ASSIGNEE_PRESENT_OR_UNKNOWN",
      "The canary must have a known-empty assignee list.",
      { assignees: candidate.assignees },
    );
  } else {
    add(
      FINDING_LEVELS.PASS,
      "CANARY_UNASSIGNED",
      "The canary has no assignee.",
    );
  }

  if (candidate.hasOpenSession !== false) {
    valid = false;
    add(
      FINDING_LEVELS.BLOCKER,
      "CANARY_SESSION_PRESENT_OR_UNKNOWN",
      "The canary must not have an open coding-agent session.",
    );
  } else {
    add(
      FINDING_LEVELS.PASS,
      "CANARY_SESSION_CLEAR",
      "The canary has no open coding-agent session.",
    );
  }

  if (candidate.hasOpenPullRequest !== false) {
    valid = false;
    add(
      FINDING_LEVELS.BLOCKER,
      "CANARY_PULL_REQUEST_PRESENT_OR_UNKNOWN",
      "The canary must not already have an open pull request.",
    );
  } else {
    add(
      FINDING_LEVELS.PASS,
      "CANARY_PULL_REQUEST_CLEAR",
      "The canary has no open pull request.",
    );
  }

  const goal = goalEvaluation.goal;
  const config = {
    factoryMode: policy.FACTORY_MODES.SHADOW,
    goalApproved: goalEvaluation.valid,
    allowedMilestones: goal ? [goal.milestone] : [],
    concurrencyLimit: goal ? goal.concurrencyLimit : 0,
    currentInFlightCount:
      snapshot && Number.isInteger(snapshot.currentInFlightCount)
        ? snapshot.currentInFlightCount
        : Number.POSITIVE_INFINITY,
    dailyBudgetLimit: goal ? goal.dailyBudgetLimit : 0,
    currentBudgetUsed:
      snapshot && Number.isInteger(snapshot.currentBudgetUsed)
        ? snapshot.currentBudgetUsed
        : Number.POSITIVE_INFINITY,
    maxGoalRiskTier: goal
      ? goal.maxGoalRiskTier
      : policy.RISK_TIERS.ROUTINE,
    goalAllowedPaths: goal ? goal.goalAllowedPaths : [],
    now: observedAt,
  };
  const eligibilityReasons = queue
    .evaluateEligibility(candidate, config)
    .slice()
    .sort();
  if (eligibilityReasons.length > 0) {
    valid = false;
    add(
      FINDING_LEVELS.BLOCKER,
      "CANARY_QUEUE_INELIGIBLE",
      "The canonical queue controller rejects the canary.",
      { reasons: eligibilityReasons },
    );
  } else {
    add(
      FINDING_LEVELS.PASS,
      "CANARY_QUEUE_ELIGIBLE",
      "The canonical queue controller accepts the canary in shadow evaluation.",
    );
  }

  let selectedNumber = null;
  if (goalEvaluation.valid && Array.isArray(snapshot.queueCandidates)) {
    const selection = queue.selectNextIssue(snapshot.queueCandidates, config);
    selectedNumber = selection.selected ? selection.selected.number : null;
    const competitors = snapshot.queueCandidates
      .filter(
        (other) =>
          other &&
          other.number !== candidate.number &&
          queue.evaluateEligibility(other, config).length === 0,
      )
      .map((other) => other.number)
      .filter(Number.isInteger)
      .sort((left, right) => left - right);

    if (competitors.length > 0) {
      valid = false;
      add(
        FINDING_LEVELS.BLOCKER,
        "CANARY_COMPETING_ELIGIBLE_ISSUES",
        "Other issues are currently queue-eligible and can compete with the canary.",
        { issues: competitors, selected: selectedNumber },
      );
    } else {
      add(
        FINDING_LEVELS.PASS,
        "CANARY_NO_COMPETING_ELIGIBLE_ISSUES",
        "No other issue is currently queue-eligible.",
      );
    }

    if (eligibilityReasons.length === 0 && selectedNumber !== candidate.number) {
      valid = false;
      add(
        FINDING_LEVELS.BLOCKER,
        "CANARY_NOT_NEXT_SELECTION",
        "Deterministic queue ordering would not select the canary next.",
        { selected: selectedNumber },
      );
    } else if (
      eligibilityReasons.length === 0 &&
      selectedNumber === candidate.number
    ) {
      add(
        FINDING_LEVELS.PASS,
        "CANARY_NEXT_SELECTION",
        "Deterministic queue ordering would select the canary next.",
        { issue: candidate.number },
      );
    }
  } else {
    valid = false;
    add(
      FINDING_LEVELS.BLOCKER,
      "CANARY_SELECTION_PREVIEW_UNAVAILABLE",
      "A deterministic queue-selection preview could not be established.",
    );
  }

  return { evaluated: true, valid, selectedNumber };
}

function evaluateFactoryReadiness(snapshot) {
  const source = snapshot && typeof snapshot === "object" ? snapshot : {};
  const findings = [];
  const add = (level, code, message, details) => {
    findings.push(makeFinding(level, code, message, details));
  };
  const request =
    source.request && typeof source.request === "object" ? source.request : {};
  const observedAt = source.observedAt;

  if (!Object.values(PREFLIGHT_MODES).includes(request.mode)) {
    add(
      FINDING_LEVELS.BLOCKER,
      "REQUEST_MODE_INVALID",
      "Preflight mode must be exactly baseline or canary.",
      { value: request.rawMode },
    );
  }
  if (!request.evidenceSha || request.evidenceSha.valid !== true) {
    add(
      FINDING_LEVELS.BLOCKER,
      "REQUEST_EVIDENCE_SHA_INVALID",
      "The optional evidence SHA, when supplied, must be exactly 40 hexadecimal characters.",
    );
  }
  if (!request.goalDigest || request.goalDigest.valid !== true) {
    add(
      FINDING_LEVELS.BLOCKER,
      "REQUEST_GOAL_DIGEST_INVALID",
      "The optional goal digest, when supplied, must be exactly 64 lowercase hexadecimal characters.",
    );
  }
  if (!queueRuntime.isValidTimestamp(observedAt)) {
    add(
      FINDING_LEVELS.BLOCKER,
      "OBSERVATION_TIME_INVALID",
      "The preflight observation time is missing or malformed.",
    );
  }

  if (
    request.mode === PREFLIGHT_MODES.BASELINE &&
    ((request.goalIssue && request.goalIssue.provided) ||
      (request.canaryIssue && request.canaryIssue.provided) ||
      (request.goalDigest && request.goalDigest.provided))
  ) {
    add(
      FINDING_LEVELS.BLOCKER,
      "BASELINE_CONTRADICTORY_CANARY_INPUTS",
      "Baseline mode rejects goal, canary, and goal-digest inputs rather than ignoring them.",
    );
  } else if (request.mode === PREFLIGHT_MODES.BASELINE) {
    add(
      FINDING_LEVELS.PASS,
      "BASELINE_OPTIONAL_INPUTS_ABSENT",
      "Baseline mode has no contradictory goal, canary, or goal-digest inputs.",
    );
  }

  evaluateRepositorySnapshot(source.repository, add);
  const control = evaluateFactoryControl(source.controlIssues, add);
  const protectedApprovalValid = evaluateProtectedInvocation(
    source.invocation,
    control,
    source.repository || {},
    request,
    add,
  );
  evaluateManualAttestations(request, protectedApprovalValid, add);
  evaluateEvidence(source.evidence, source.repository || {}, add);
  let goal = { evaluated: false, valid: false, goal: null, digest: null };
  let canary = {
    evaluated: false,
    valid: false,
    selectedNumber: null,
  };
  if (request.mode === PREFLIGHT_MODES.CANARY) {
    goal = evaluateGoal(
      source.goal,
      request,
      protectedApprovalValid,
      add,
    );
    canary = evaluateCanary(
      source.canary,
      request,
      goal,
      observedAt,
      add,
    );
  }

  const allBlockers = findings.filter(
    (finding) => finding.level === FINDING_LEVELS.BLOCKER,
  );
  const baselineReady = allBlockers.length === 0;
  const canaryEvaluated = request.mode === PREFLIGHT_MODES.CANARY;
  const canaryReady =
    canaryEvaluated && baselineReady && goal.valid && canary.valid;
  const selectedReady =
    request.mode === PREFLIGHT_MODES.BASELINE
      ? baselineReady
      : request.mode === PREFLIGHT_MODES.CANARY
        ? canaryReady
        : false;

  return {
    schemaVersion: 2,
    readOnly: true,
    mode: request.mode || null,
    observedAt: queueRuntime.isValidTimestamp(observedAt) ? observedAt : null,
    repository: {
      defaultBranch:
        source.repository && source.repository.defaultBranch
          ? source.repository.defaultBranch
          : null,
      defaultBranchSha:
        source.repository && source.repository.defaultBranchSha
          ? source.repository.defaultBranchSha
          : null,
    },
    controlMode: control.mode,
    evidenceSha:
      source.evidence && source.evidence.sha
        ? source.evidence.sha
        : null,
    goalDigest:
      typeof goal.digest === "string" ? goal.digest : null,
    readiness: {
      baseline: { evaluated: true, ready: baselineReady },
      canary: {
        evaluated: canaryEvaluated,
        ready: canaryEvaluated ? canaryReady : null,
      },
      activation: {
        evaluated: canaryEvaluated,
        ready: canaryEvaluated ? canaryReady : null,
        requiresHumanModeChange:
          canaryEvaluated &&
          control.mode === policy.FACTORY_MODES.SHADOW,
      },
      selected: { mode: request.mode || null, ready: selectedReady },
    },
    summary: {
      blockers: allBlockers.length,
      warnings: findings.filter(
        (finding) => finding.level === FINDING_LEVELS.WARNING,
      ).length,
      passes: findings.filter(
        (finding) => finding.level === FINDING_LEVELS.PASS,
      ).length,
    },
    findings,
  };
}

async function readIssueOrNull({ github, owner, repo, issueNumber }) {
  try {
    const response = await github.rest.issues.get({
      owner,
      repo,
      issue_number: issueNumber,
    });
    return response.data && !response.data.pull_request ? response.data : null;
  } catch (error) {
    if (getErrorStatus(error) === 404) {
      return null;
    }
    throw error;
  }
}

async function readCommentOrNull({
  github,
  owner,
  repo,
  commentId,
}) {
  if (!Number.isSafeInteger(commentId) || commentId <= 0) {
    return null;
  }
  try {
    const response = await github.rest.issues.getComment({
      owner,
      repo,
      comment_id: commentId,
    });
    return response.data || null;
  } catch (error) {
    if (getErrorStatus(error) === 404) {
      return null;
    }
    throw error;
  }
}

async function readEnvironmentSnapshot({
  github,
  owner,
  repo,
  environmentName,
}) {
  try {
    const response = await github.request(
      "GET /repos/{owner}/{repo}/environments/{environment_name}",
      {
        owner,
        repo,
        environment_name: environmentName,
      },
    );
    const data = response.data || {};
    const branchPolicies =
      data.deployment_branch_policy &&
      data.deployment_branch_policy.custom_branch_policies === true
        ? await github.paginate(
            "GET /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies",
            {
              owner,
              repo,
              environment_name: environmentName,
              per_page: 100,
            },
          )
        : [];
    return {
      readable: true,
      name: data.name,
      canAdminsBypass: data.can_admins_bypass,
      protectionRules: data.protection_rules,
      deploymentBranchPolicy: data.deployment_branch_policy,
      branchPolicies,
    };
  } catch (error) {
    if ([403, 404].includes(getErrorStatus(error))) {
      return {
        readable: false,
        name: environmentName,
        errorStatus: getErrorStatus(error),
      };
    }
    throw error;
  }
}

async function readWorkflowOrNull({ github, owner, repo, workflowId }) {
  try {
    const response = await github.rest.actions.getWorkflow({
      owner,
      repo,
      workflow_id: workflowId,
    });
    return response.data || null;
  } catch (error) {
    if (getErrorStatus(error) === 404) {
      return null;
    }
    throw error;
  }
}

async function readTimeline({ github, owner, repo, issueNumber }) {
  return github.paginate(
    github.rest.issues.listEventsForTimeline,
    {
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 100,
    },
  );
}

async function collectFactoryReadinessState({
  github,
  context,
  core,
  trustedScriptSha,
  now,
  runAttempt,
  runId,
  approvalEnvironmentName,
  protectedGatePassed,
}) {
  const { owner, repo } = context.repo;
  const payload = context.payload || {};
  const payloadComment = payload.comment || {};
  const payloadIssue = payload.issue || {};
  const commentId = Number(payloadComment.id);
  const payloadCommand = parseIssueCommentCommand(payloadComment.body);

  const repositoryResponse = await github.rest.repos.get({ owner, repo });
  const defaultBranch = repositoryResponse.data.default_branch;
  const branchResponse = await github.rest.repos.getBranch({
    owner,
    repo,
    branch: defaultBranch,
  });
  const defaultBranchSha = branchResponse.data.commit.sha;

  const [
    treeResponse,
    workflows,
    controlIssues,
    currentComment,
    factoryControlEnvironment,
    developmentEnvironment,
    devWorkflow,
  ] = await Promise.all([
    github.rest.git.getTree({
      owner,
      repo,
      tree_sha: defaultBranchSha,
      recursive: "true",
    }),
    github.paginate(github.rest.actions.listRepoWorkflows, {
      owner,
      repo,
      per_page: 100,
    }),
    queueRuntime.listIssuesWithLabels(
      github,
      owner,
      repo,
      [queueRuntime.CONTROL_LABEL],
      "open",
    ),
    readCommentOrNull({
      github,
      owner,
      repo,
      commentId,
    }),
    readEnvironmentSnapshot({
      github,
      owner,
      repo,
      environmentName: FACTORY_CONTROL_ENVIRONMENT,
    }),
    readEnvironmentSnapshot({
      github,
      owner,
      repo,
      environmentName: lifecycle.DEV_ENVIRONMENT,
    }),
    readWorkflowOrNull({
      github,
      owner,
      repo,
      workflowId: DEV_WORKFLOW_ID,
    }),
  ]);
  const currentCommand = parseIssueCommentCommand(
    currentComment && currentComment.body,
  );
  const request = parseWorkflowInputs(currentCommand.inputs);

  const controlsWithEvents = [];
  for (const issue of controlIssues) {
    controlsWithEvents.push({
      ...issue,
      timelineEvents: await readTimeline({
        github,
        owner,
        repo,
        issueNumber: issue.number,
      }),
    });
  }

  let goalSnapshot = null;
  if (
    request.mode === PREFLIGHT_MODES.CANARY &&
    request.goalIssue.valid &&
    request.goalIssue.provided
  ) {
    const [issue, approvedGoalIssues, currentInFlightCount, currentBudgetUsed] =
      await Promise.all([
        readIssueOrNull({
          github,
          owner,
          repo,
          issueNumber: request.goalIssue.value,
        }),
        queueRuntime.listIssuesWithLabels(
          github,
          owner,
          repo,
          [queueRuntime.GOAL_APPROVED_LABEL],
          "open",
        ),
        queueRuntime.countInFlight(github, owner, repo),
        queueRuntime.countBudgetConsumption(
          github,
          owner,
          repo,
          request.goalIssue.value,
          core,
        ),
      ]);
    goalSnapshot = {
      issue,
      approvedGoalIssues: issue
        ? approvedGoalIssues.map((approvedIssue) =>
            approvedIssue.number === issue.number ? issue : approvedIssue,
          )
        : approvedGoalIssues,
      timelineEvents: issue
        ? await readTimeline({
            github,
            owner,
            repo,
            issueNumber: issue.number,
          })
        : [],
      currentInFlightCount,
      currentBudgetUsed,
    };
  }

  let canarySnapshot = null;
  if (
    request.mode === PREFLIGHT_MODES.CANARY &&
    request.canaryIssue.valid &&
    request.canaryIssue.provided
  ) {
    const issue = await readIssueOrNull({
      github,
      owner,
      repo,
      issueNumber: request.canaryIssue.value,
    });
    const readyIssues = await queueRuntime.listIssuesWithLabels(
      github,
      owner,
      repo,
      [policy.QUEUE_READY_LABEL],
      "open",
    );
    const issuesByNumber = new Map(
      readyIssues.map((readyIssue) => [readyIssue.number, readyIssue]),
    );
    if (issue) {
      issuesByNumber.set(issue.number, issue);
    }

    const queueCandidates = [];
    for (const candidateIssue of [...issuesByNumber.values()].sort(
      (left, right) => left.number - right.number,
    )) {
      queueCandidates.push(
        await queueRuntime.buildCandidate({
          github,
          owner,
          repo,
          issue: candidateIssue,
          activeGoalNumber: request.goalIssue.value,
          core,
        }),
      );
    }
    canarySnapshot = {
      candidate:
        queueCandidates.find(
          (candidate) => candidate.number === request.canaryIssue.value,
        ) || null,
      queueCandidates,
      currentInFlightCount: goalSnapshot
        ? goalSnapshot.currentInFlightCount
        : undefined,
      currentBudgetUsed: goalSnapshot
        ? goalSnapshot.currentBudgetUsed
        : undefined,
    };
  }

  const targetSha = request.evidenceSha.provided
    ? request.evidenceSha.valid
      ? request.evidenceSha.value
      : null
    : defaultBranchSha;
  let commitExists = targetSha === defaultBranchSha;
  if (isSha(targetSha) && !commitExists) {
    try {
      await github.rest.repos.getCommit({ owner, repo, ref: targetSha });
      commitExists = true;
    } catch (error) {
      if (getErrorStatus(error) !== 404) {
        throw error;
      }
    }
  }

  let ciRuns = [];
  let devRuns = [];
  let statuses = [];
  let deployments = [];
  const deploymentStatusesByDeployment = {};
  if (isSha(targetSha) && commitExists) {
    [ciRuns, devRuns, statuses, deployments] = await Promise.all([
      github.paginate(github.rest.actions.listWorkflowRuns, {
        owner,
        repo,
        workflow_id: CI_WORKFLOW_ID,
        head_sha: targetSha,
        event: "push",
        per_page: 100,
      }),
      github.paginate(github.rest.actions.listWorkflowRuns, {
        owner,
        repo,
        workflow_id: DEV_WORKFLOW_ID,
        head_sha: targetSha,
        per_page: 100,
      }),
      github.paginate(github.rest.repos.listCommitStatusesForRef, {
        owner,
        repo,
        ref: targetSha,
        per_page: 100,
      }),
      github.paginate(github.rest.repos.listDeployments, {
        owner,
        repo,
        sha: targetSha,
        environment: lifecycle.DEV_ENVIRONMENT,
        per_page: 100,
      }),
    ]);
    for (const deployment of deployments) {
      deploymentStatusesByDeployment[deployment.id] = await github.paginate(
        github.rest.repos.listDeploymentStatuses,
        {
          owner,
          repo,
          deployment_id: deployment.id,
          per_page: 100,
        },
      );
    }
  }

  const [finalBranchResponse, finalComment] = await Promise.all([
    github.rest.repos.getBranch({
      owner,
      repo,
      branch: defaultBranch,
    }),
    readCommentOrNull({
      github,
      owner,
      repo,
      commentId,
    }),
  ]);
  const finalCommand = parseIssueCommentCommand(
    finalComment && finalComment.body,
  );
  const commentBodyUnchanged =
    currentComment !== null &&
    finalComment !== null &&
    payloadComment.body === currentComment.body &&
    currentComment.body === finalComment.body &&
    JSON.stringify(payloadCommand) === JSON.stringify(currentCommand) &&
    JSON.stringify(currentCommand) === JSON.stringify(finalCommand);
  const commentUnedited =
    currentComment !== null &&
    finalComment !== null &&
    currentComment.created_at === currentComment.updated_at &&
    finalComment.created_at === finalComment.updated_at;

  return {
    request,
    observedAt: now,
    repository: {
      defaultBranch,
      defaultBranchSha,
      finalDefaultBranchSha: finalBranchResponse.data.commit.sha,
      defaultBranchProtected:
        branchResponse.data.protected === true &&
        finalBranchResponse.data.protected === true,
      fullName:
        typeof repositoryResponse.data.full_name === "string"
          ? repositoryResponse.data.full_name
          : `${owner}/${repo}`,
      trustedScriptSha:
        typeof trustedScriptSha === "string"
          ? trustedScriptSha.trim().toLowerCase()
          : null,
      treePaths: (Array.isArray(treeResponse.data.tree)
        ? treeResponse.data.tree
        : []
      )
        .map((entry) => entry && entry.path)
        .filter((entryPath) => typeof entryPath === "string"),
      treeTruncated: treeResponse.data.truncated === true,
      workflows,
    },
    controlIssues: controlsWithEvents,
    invocation: {
      eventName: context.eventName,
      action: payload.action,
      runAttempt,
      runId,
      workflowSha:
        typeof context.sha === "string"
          ? context.sha.trim().toLowerCase()
          : null,
      workflowRef:
        typeof context.ref === "string" ? context.ref : null,
      issueNumber: Number(payloadIssue.number),
      isPullRequest: Boolean(payloadIssue.pull_request),
      commentId,
      commentExists: currentComment !== null && finalComment !== null,
      commentBodyUnchanged,
      commentUnedited,
      command: finalCommand,
      approvalEnvironmentName,
      protectedGatePassed,
      environment: factoryControlEnvironment,
    },
    goal: goalSnapshot,
    canary: canarySnapshot,
    evidence: {
      sha: targetSha,
      commitExists,
      ciRuns,
      devRuns,
      devWorkflow,
      statuses,
      deployments,
      deploymentStatusesByDeployment,
      developmentEnvironment,
    },
  };
}

function escapeMarkdownValue(value, limit = MAX_SUMMARY_TEXT) {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/`/g, "&#96;")
    .replace(/\|/g, "&#124;")
    .replace(/\\/g, "&#92;")
    .replace(/\*/g, "&#42;")
    .replace(/_/g, "&#95;")
    .replace(/\[/g, "&#91;")
    .replace(/\]/g, "&#93;")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function safeSummaryDetails(details) {
  if (details === undefined) {
    return "";
  }
  return escapeMarkdownValue(JSON.stringify(details), MAX_SUMMARY_DETAIL);
}

function formatReadinessSummary(report) {
  const tableValue = (value) => escapeMarkdownValue(value, 128);
  const lines = [
    "# Agentic factory readiness preflight",
    "",
    "> Deterministic read-only report. No labels, comments, dispatches, merges, deployments, settings, or mode changes were performed.",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Requested mode | ${tableValue(report.mode || "invalid")} |`,
    `| Default branch | ${tableValue(report.repository.defaultBranch || "unknown")} |`,
    `| Default-branch SHA | ${tableValue(report.repository.defaultBranchSha || "unknown")} |`,
    `| Evidence SHA | ${tableValue(report.evidenceSha || "unknown")} |`,
    `| Current goal digest | ${tableValue(report.goalDigest || "not evaluated")} |`,
    `| Current factory mode | ${tableValue(report.controlMode || "unknown")} |`,
    `| Baseline ready | ${tableValue(report.readiness.baseline.ready)} |`,
    `| Canary ready | ${tableValue(report.readiness.canary.ready === null ? "not evaluated" : report.readiness.canary.ready)} |`,
    `| Activation ready | ${tableValue(report.readiness.activation.ready === null ? "not evaluated" : report.readiness.activation.ready)} |`,
    `| Selected result | ${tableValue(report.readiness.selected.ready)} |`,
    "",
    "## Human setup prerequisites",
    "",
    "- Protect the repository default branch.",
    "- Configure the `factory-control` Environment with required reviewers, self-review prevention, administrator-bypass prevention, and protected-branch restrictions.",
    "- Retain `development` without required reviewers and with exactly the `main` and `develop/azure` branch policies.",
    "",
  ];

  for (const level of [
    FINDING_LEVELS.BLOCKER,
    FINDING_LEVELS.WARNING,
    FINDING_LEVELS.PASS,
  ]) {
    const allMatches = report.findings.filter(
      (finding) => finding.level === level,
    );
    const matches = allMatches.slice(0, MAX_SUMMARY_FINDINGS_PER_LEVEL);
    lines.push(
      `## ${level[0].toUpperCase()}${level.slice(1)} (${allMatches.length})`,
    );
    lines.push("");
    if (matches.length === 0) {
      lines.push("- None.");
    } else {
      for (const finding of matches) {
        const detail = safeSummaryDetails(finding.details);
        lines.push(
          `- **${escapeMarkdownValue(finding.code, 96)}** — ${escapeMarkdownValue(
            finding.message,
          )}${detail === "" ? "" : ` — ${detail}`}`,
        );
      }
      if (allMatches.length > matches.length) {
        lines.push(
          `- ${allMatches.length - matches.length} additional finding(s) omitted from the bounded summary.`,
        );
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

async function runFactoryReadinessPreflight({
  github,
  context,
  core,
  trustedScriptSha,
  runAttempt,
  runId,
  approvalEnvironmentName,
  protectedGatePassed,
  now = new Date().toISOString(),
}) {
  const collect = () =>
    collectFactoryReadinessState({
      github,
      context,
      core,
      trustedScriptSha,
      now,
      runAttempt,
      runId,
      approvalEnvironmentName,
      protectedGatePassed,
    });
  let snapshot = await collect();
  let report = evaluateFactoryReadiness(snapshot);
  if (report.readiness.selected.ready) {
    // A second complete read closes issue/label/evidence/environment TOCTOU
    // windows and ends with the collector's final default-head re-read.
    snapshot = await collect();
    report = evaluateFactoryReadiness(snapshot);
  }
  const blockerCodes = report.findings
    .filter((finding) => finding.level === FINDING_LEVELS.BLOCKER)
    .map((finding) => finding.code)
    .slice(0, 50)
    .join(",");
  core.info(
    `Factory readiness result: mode=${report.mode || "invalid"} ready=${report.readiness.selected.ready} blockers=${report.summary.blockers} codes=${blockerCodes || "none"}`,
  );
  await core.summary.addRaw(formatReadinessSummary(report)).write();
  if (!report.readiness.selected.ready) {
    core.setFailed(
      `Factory readiness preflight found ${report.summary.blockers} blocker(s) for ${report.mode || "invalid"} mode.`,
    );
  }
  return report;
}

module.exports = {
  PREFLIGHT_MODES,
  FINDING_LEVELS,
  CI_WORKFLOW_ID,
  DEV_WORKFLOW_ID,
  DEV_WORKFLOW_NAME,
  DEV_WORKFLOW_PATH,
  DEV_SUCCESS_DESCRIPTION,
  READINESS_COMMAND,
  FACTORY_CONTROL_ENVIRONMENT,
  DEVELOPMENT_BRANCH_POLICIES,
  CANARY_PATH,
  REQUIRED_FACTORY_WORKFLOW_PATHS,
  REQUIRED_FACTORY_SOURCE_PATHS,
  isSha,
  parseOptionalIssueNumber,
  parseExplicitBoolean,
  parseWorkflowInputs,
  parseIssueCommentCommand,
  makeFinding,
  evaluateRepositorySnapshot,
  evaluateOrderedLabelEvent,
  evaluateFactoryControl,
  evaluateProtectedEnvironment,
  evaluateDevelopmentEnvironment,
  evaluateProtectedInvocation,
  evaluateManualAttestations,
  resolveLatestByNumericId,
  isGitHubActionsCreator,
  isExactActionsRunUrl,
  evaluateEvidence,
  computeGoalAuthorizationDigest,
  evaluateGoal,
  evaluateCanary,
  evaluateFactoryReadiness,
  readIssueOrNull,
  readCommentOrNull,
  readEnvironmentSnapshot,
  readWorkflowOrNull,
  readTimeline,
  collectFactoryReadinessState,
  escapeMarkdownValue,
  safeSummaryDetails,
  formatReadinessSummary,
  runFactoryReadinessPreflight,
};
