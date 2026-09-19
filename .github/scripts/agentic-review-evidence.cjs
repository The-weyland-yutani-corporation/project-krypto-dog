"use strict";

const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { AGENTIC_POLICY } = require("./agentic-policy.cjs");
const {
  CODE_REVIEW_CHECK,
  QA_CHECK,
  SECURITY_CHECK,
  TRADING_SAFETY_CHECK,
  HUMAN_BOUNDARY_APPROVAL_CHECK,
  RISK_TIERS,
  compareRiskTiers,
  determineRiskTier,
  isKnownRiskTier,
  maxRiskTier,
  normalizeAllowedPathPatterns,
  areAllowedPathPatternsWithin,
  areChangedFilesWithinAllowedPaths,
} = require("./agentic-factory-policy.cjs");
const {
  getIssueFormSection,
  resolveLatestIssueClaim,
} = require("./agentic-lifecycle-reconciler.cjs");

const REVIEW_WORKFLOWS = Object.freeze({
  [CODE_REVIEW_CHECK]: "code-review.lock.yml",
  [QA_CHECK]: "qa-test-plan.lock.yml",
  [SECURITY_CHECK]: "security-review.lock.yml",
  [TRADING_SAFETY_CHECK]: "trading-safety-review.lock.yml",
});
const REVIEW_LABELS = Object.freeze({
  [QA_CHECK]: "needs-qa", [SECURITY_CHECK]: "security-review", [TRADING_SAFETY_CHECK]: "trading-safety",
});
const CI_CHECKS = Object.freeze(
  [...AGENTIC_POLICY.requiredContexts].filter(
    (name) => name !== AGENTIC_POLICY.mergeContext && !REVIEW_WORKFLOWS[name],
  ),
);
const MAX_PAGES = 30;
const MAX_CONTENT_BYTES = 8 * 1024 * 1024;
const MAX_INFRA_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5 * 60 * 1000;
const DISPATCH_LEASE_MS = 45 * 60 * 1000;
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const REVIEW_MARKER = "agentic-review-evidence:v1";
const CI_MARKER = "agentic-ci-evidence:v1";
const CI_ATTEMPT_MARKER = "agentic-ci-attempt:v1";
const DISPATCH_MARKER = "agentic-review-dispatch:v1";
const INFRA_REASONS = new Set([
  "access_unavailable",
  "evidence_unavailable",
  "partial_evidence",
  "ci_pending",
  "provider_unavailable",
  "tool_unavailable",
]);

class EvidenceError extends Error {
  constructor(code, source) {
    super(`${code}: ${source}`);
    this.code = code;
    this.source = source;
  }
}

function requireEvidence(condition, code, source) {
  if (!condition) throw new EvidenceError(code, source);
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function correlationId(workflowId, number, sha) {
  return `agentic-pr:${number}:${sha}:${workflowId}`;
}

async function readApi(operation, source) {
  try {
    return await operation();
  } catch (error) {
    if ([401, 403].includes(error.status)) {
      throw new EvidenceError("access_unavailable", source);
    }
    if ([404, 408, 409, 429].includes(error.status) || error.status >= 500) {
      throw new EvidenceError("evidence_unavailable", source);
    }
    throw error;
  }
}

// Do not silently accept GitHub's 1,000-run / 3,000-file caps or a changing page set.
async function readPages(method, params, key, expectedCount) {
  const items = [];
  let total = expectedCount;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await readApi(
      () => method({ ...params, per_page: 100, page }),
      `${key || "items"} page ${page}`,
    );
    const batch = key ? response.data[key] : response.data;
    requireEvidence(Array.isArray(batch), "partial_evidence", key || "items");
    if (key) {
      const count = response.data.total_count;
      requireEvidence(
        Number.isSafeInteger(count) && count >= 0 &&
          (total === undefined || count === total),
        "partial_evidence",
        `${key} total_count`,
      );
      total = count;
    }
    items.push(...batch);
    const hasNext = /rel="next"/.test(response.headers?.link || "");
    if (!hasNext && batch.length < 100) {
      requireEvidence(
        total === undefined || items.length === total,
        "partial_evidence",
        `${key || "items"} expected ${total}, received ${items.length}`,
      );
      const ids = items.map((item) => item.id ?? item.filename);
      requireEvidence(
        ids.every((id) => id !== undefined) && new Set(ids).size === ids.length,
        "partial_evidence",
        `${key || "items"} duplicate/missing identities`,
      );
      return items;
    }
  }
  throw new EvidenceError("partial_evidence", `${key || "items"} pagination limit`);
}

function labels(item) {
  return new Set((item.labels || []).map((label) => label.name));
}

function getPolicyFiles(files) {
  return files.flatMap((file) => file.previous_filename
    ? [file, { filename: file.previous_filename, status: file.status }]
    : [file]);
}

function getDeclaredRiskLabel(pullRequest) {
  const present = labels(pullRequest);
  if (present.has("ready-for-human-review")) return RISK_TIERS.BOUNDARY;
  const risks = [...present].filter((label) => Object.values(RISK_TIERS).includes(label));
  return risks.length > 1 ? "risk:invalid" : risks[0];
}

function getRequestedChecks(pullRequest) {
  return Object.entries(REVIEW_LABELS).filter(([, label]) => labels(pullRequest).has(label)).map(([name]) => name);
}

function sourceUrl(repository, suffix) {
  return `https://api.github.com/repos/${repository}/${suffix}`;
}

function receipt(check, marker) {
  const prefix = `<!-- ${marker} `;
  const summary = check.output?.summary;
  if (typeof summary !== "string" || !summary.startsWith(prefix)) return null;
  const end = summary.indexOf(" -->\n", prefix.length);
  if (end === -1) return null;
  try {
    return JSON.parse(summary.slice(prefix.length, end));
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function reviewVerdictItems(data) {
  requireEvidence(data && Array.isArray(data.items), "invalid_verdict", "safe-output items");
  const items = data.items.filter((item) => item.type === "create_pr_check");
  requireEvidence(items.length === 1, "invalid_verdict",
    `Expected exactly one create_pr_check item; found ${items.length}`);
  requireEvidence(items[0].verdict !== "pass" ||
    ((!data.errors || (Array.isArray(data.errors) && data.errors.length === 0)) &&
      !data.items.some((item) => ["noop", "report_incomplete", "missing_tool", "missing_data"].includes(item.type))),
  "invalid_verdict", "pass conflicts with incomplete safe outputs");
  return items;
}

function isActionsCheck(check, sha) {
  return check.head_sha === sha && check.app?.slug === "github-actions";
}

function latestCheck(checks, name, sha) {
  return checks.filter((check) => check.name === name && isActionsCheck(check, sha))
    .sort((left, right) => right.id - left.id)[0];
}

function ciFingerprint(checks, sha) {
  return digest(CI_CHECKS.map((name) => {
    const check = latestCheck(checks, name, sha);
    return check
      ? [name, check.id, check.status, check.conclusion, check.completed_at || null,
        check.external_id || null]
      : [name, "missing"];
  }));
}

function ciState(checks, sha) {
  const required = CI_CHECKS.map((name) => latestCheck(checks, name, sha));
  if (required.some((check) => !check || check.status !== "completed")) return "pending";
  if (required.some((check) => ["cancelled", "timed_out", "action_required", "startup_failure", "skipped", "neutral"]
    .includes(check.conclusion))) return "unavailable";
  if (required.some((check) => check.conclusion !== "success" && check.conclusion !== "failure")) return "unavailable";
  return required.some((check) => check.conclusion === "failure") ? "failure" : "success";
}

function boundReviewReceipt(check, sha) {
  const proof = receipt(check, REVIEW_MARKER);
  return isActionsCheck(check, sha) && Boolean(REVIEW_WORKFLOWS[check.name]) &&
    proof?.headSha === sha && proof.checkName === check.name &&
    DIGEST.test(proof.packetDigest || "") &&
    check.external_id === `agentic-review:v1:${proof.packetDigest}`;
}

function semanticReviewOutcome(check, sha) {
  if (!isActionsCheck(check, sha) || !REVIEW_WORKFLOWS[check.name]) return "unknown";
  if (check.status !== "completed") return "pending";
  const proof = receipt(check, REVIEW_MARKER);
  if (proof?.headSha === sha && proof.checkName === check.name &&
      proof.verdict === "infrastructure" && check.conclusion === "action_required" &&
      INFRA_REASONS.has(proof.reason) &&
      check.external_id === `agentic-review-incomplete:v1:${proof.runId}:${proof.runAttempt}:${sha}`) {
    return "infrastructure";
  }
  if (!boundReviewReceipt(check, sha)) return "unknown";
  if (proof.verdict === "pass" && check.conclusion === "success") return "pass";
  if (proof.verdict === "reject" && check.conclusion === "failure") return "reject";
  if (proof.verdict === "infrastructure" && check.conclusion === "action_required" &&
      INFRA_REASONS.has(proof.reason)) return "infrastructure";
  return "unknown";
}

function isBoundReviewRun(run, checkName, sha, number, repository, defaultBranch) {
  return run.path === `.github/workflows/${REVIEW_WORKFLOWS[checkName]}` &&
    run.repository?.full_name?.toLowerCase() === repository.toLowerCase() &&
    run.event === "workflow_dispatch" && run.head_branch === defaultBranch &&
    SHA.test(run.head_sha || "") && Number.isSafeInteger(run.id) &&
    Number.isInteger(run.run_attempt) && run.run_attempt > 0 &&
    run.display_title === correlationId(REVIEW_WORKFLOWS[checkName], number, sha);
}

function latestBoundReviewRun(runs, checkName, sha, number, repository, defaultBranch) {
  return runs.filter((run) => isBoundReviewRun(run, checkName, sha, number, repository, defaultBranch))
    .sort((left, right) => right.id - left.id || right.run_attempt - left.run_attempt)[0];
}

function isBoundCiRun(run, sha, number, repository, defaultBranch) {
  return run.path === ".github/workflows/ci.yml" &&
    run.repository?.full_name?.toLowerCase() === repository.toLowerCase() &&
    run.event === "workflow_dispatch" && run.head_branch === defaultBranch &&
    SHA.test(run.head_sha || "") && Number.isSafeInteger(run.id) &&
    Number.isInteger(run.run_attempt) && run.run_attempt > 0 &&
    run.display_title === correlationId("ci.yml", number, sha);
}

function trustedReviewSource(check, runs, repository, defaultBranch) {
  const proof = receipt(check, REVIEW_MARKER);
  if (!proof || !SHA.test(proof.workflowSha || "") ||
      !Number.isSafeInteger(proof.runId) || proof.runId < 1 ||
      !Number.isSafeInteger(proof.runAttempt) || proof.runAttempt < 1 ||
      !Number.isSafeInteger(proof.pullNumber) || proof.pullNumber < 1 ||
      typeof repository !== "string" || repository.length === 0 ||
      typeof defaultBranch !== "string" || defaultBranch.length === 0) return false;
  const run = runs.find((candidate) => candidate.id === proof.runId);
  if (!run || run.path !== `.github/workflows/${REVIEW_WORKFLOWS[check.name]}` ||
      run.repository?.full_name?.toLowerCase() !== repository.toLowerCase() ||
      !Number.isInteger(run.run_attempt) || run.run_attempt < 1 ||
      proof.runAttempt > run.run_attempt) return false;
  if (run.event === "workflow_dispatch") {
    return run.head_sha === proof.workflowSha &&
      isBoundReviewRun(run, check.name, check.head_sha, proof.pullNumber, repository, defaultBranch);
  }
  return run.event === "pull_request" && run.head_sha === check.head_sha &&
    run.pull_requests?.some((pull) => pull.number === proof.pullNumber &&
      pull.head.sha === check.head_sha && pull.base.sha === proof.workflowSha);
}

function trustedReviewOutcome(check, sha, runs, repository, defaultBranch) {
  const outcome = semanticReviewOutcome(check, sha);
  if (!["pass", "reject", "infrastructure"].includes(outcome)) return outcome;
  return trustedReviewSource(check, runs, repository, defaultBranch) ? outcome : "unknown";
}

function trustedReviewReceipt(check, sha, runs, repository, defaultBranch) {
  return boundReviewReceipt(check, sha) &&
    trustedReviewSource(check, runs, repository, defaultBranch);
}

function hasNewerReviewAttempt(check, runs, repository, defaultBranch) {
  const proof = receipt(check, REVIEW_MARKER);
  if (!proof) return true;
  const latest = latestBoundReviewRun(runs, check.name, check.head_sha, proof.pullNumber, repository, defaultBranch);
  return Boolean(latest && (latest.id > proof.runId ||
    (latest.id === proof.runId && latest.run_attempt > proof.runAttempt)));
}

async function markIncompleteReviewAttempt({
  github, context, checkName, sha, number, run, runs, checks, defaultBranch, pullCreatedAt,
}) {
  const repository = `${context.repo.owner}/${context.repo.repo}`;
  const branch = defaultBranch || context.payload?.repository?.default_branch;
  const reviewRuns = runs ||
    await collectReviewRuns(github, context, REVIEW_WORKFLOWS[checkName], pullCreatedAt);
  if (!run || run.status !== "completed" || checks.some((check) =>
    check.name === checkName &&
      trustedReviewOutcome(check, sha, reviewRuns, repository, branch) === "reject")) return null;
  requireEvidence(isBoundReviewRun(run, checkName, sha, number,
    repository, branch),
  "invalid_context", "authoritative incomplete review attempt");
  const existing = checks.find((check) => {
    const proof = receipt(check, REVIEW_MARKER);
    return isActionsCheck(check, sha) && check.name === checkName &&
      proof?.runId === run.id && proof.runAttempt === run.run_attempt &&
      (trustedReviewReceipt(check, sha, reviewRuns, repository, branch) ||
        trustedReviewOutcome(check, sha, reviewRuns, repository, branch) === "infrastructure");
  });
  if (existing?.status === "completed") return null;
  const proof = {
    checkName, headSha: sha, pullNumber: number, runId: run.id, runAttempt: run.run_attempt,
    workflowSha: run.head_sha, verdict: "infrastructure", reason: "evidence_unavailable",
    wrapperConclusion: run.conclusion, packetDigest: null,
  };
  const input = {
    ...context.repo, name: checkName, status: "completed", conclusion: "action_required",
    external_id: `agentic-review-incomplete:v1:${run.id}:${run.run_attempt}:${sha}`,
    details_url: `https://github.com/${context.repo.owner}/${context.repo.repo}/actions/runs/${run.id}`,
    output: { title: "Trusted review attempt produced no verdict",
      summary: `<!-- ${REVIEW_MARKER} ${JSON.stringify(proof)} -->\n` +
        "Infrastructure/incomplete evidence, not a substantive code rejection. An older same-head success does not satisfy this attempt." },
  };
  const result = existing
    ? await github.rest.checks.update({ ...input, check_run_id: existing.id })
    : await github.rest.checks.create({ ...input, head_sha: sha });
  requireEvidence(result.data?.id, "evidence_unavailable", "incomplete-attempt check publication");
  if (existing) Object.assign(existing, result.data);
  else checks.push(result.data);
  return result.data;
}

function infrastructureRetryDecision({ runs, now, reservation }) {
  if (runs.some((run) => run.status !== "completed")) {
    return { dispatch: false, reason: "in_flight" };
  }
  const dispatched = runs.filter((run) => run.event === "workflow_dispatch");
  const attempts = Math.max(
    dispatched.reduce((sum, run) => sum + (run.run_attempt || 1), 0),
    reservation?.attempt || 0,
  );
  if (attempts >= MAX_INFRA_ATTEMPTS) return { dispatch: false, reason: "infrastructure_exhausted" };
  const observed = reservation && dispatched.some((run) =>
    Date.parse(run.created_at) >= Date.parse(reservation.reservedAt));
  if (reservation && !observed && Date.parse(reservation.expiresAt) > now) {
    return { dispatch: false, reason: "dispatch_reserved" };
  }
  const latest = [...dispatched].sort((left, right) => right.id - left.id)[0];
  if (latest) {
    const finished = Date.parse(latest.updated_at || latest.created_at);
    if (!Number.isFinite(finished) || !Number.isFinite(now)) {
      return { dispatch: false, reason: "infrastructure_timestamp_unavailable" };
    }
    if (now - finished < RETRY_DELAY_MS) return { dispatch: false, reason: "infrastructure_backoff" };
  }
  return { dispatch: true, reason: "missing_or_infrastructure", attempt: attempts + 1 };
}

function reviewDispatchDecision({
  checks, runs, checkName, sha, now, reservation, repository, defaultBranch,
}) {
  const relevant = checks.filter((check) => check.name === checkName && isActionsCheck(check, sha));
  const outcomeFor = (check) =>
    trustedReviewOutcome(check, sha, runs, repository, defaultBranch);
  if (relevant.some((check) => outcomeFor(check) === "reject")) {
    return { dispatch: false, reason: "substantive_rejection" };
  }
  const current = latestCheck(relevant, checkName, sha);
  const outcome = current ? outcomeFor(current) : "unknown";
  const proof = current && receipt(current, REVIEW_MARKER);
  if (outcome === "pass" &&
      (checkName === CODE_REVIEW_CHECK || proof.ciFingerprint === ciFingerprint(checks, sha))) {
    return { dispatch: false, reason: "current_verdict" };
  }
  if (checkName !== CODE_REVIEW_CHECK && !["success", "failure"].includes(ciState(checks, sha))) {
    return { dispatch: false, reason: "ci_pending" };
  }
  return infrastructureRetryDecision({ runs, now, reservation });
}

function dispatchReservation(checks, workflowId, sha, number) {
  const name = `Evidence dispatch: ${workflowId}`;
  const check = latestCheck(checks, name, sha);
  if (!check) return null;
  const data = receipt(check, DISPATCH_MARKER);
  requireEvidence(
    data?.correlationId === correlationId(workflowId, number, sha) &&
      Number.isInteger(data.attempt) && data.attempt > 0 &&
      data.attempt <= MAX_INFRA_ATTEMPTS && Number.isFinite(Date.parse(data.expiresAt)),
    "invalid_context", "dispatch reservation",
  );
  return data;
}

function trustedContext(context, env) {
  const repository = `${context.repo.owner}/${context.repo.repo}`;
  const payload = context.payload || {};
  requireEvidence(typeof payload.repository?.default_branch === "string" &&
    payload.repository.default_branch.length > 0, "invalid_context", "approved default branch");
  const workflowId = env.REVIEW_WORKFLOW_ID || "ci.yml";
  const trustedWorkflowSha = payload.pull_request?.base.sha || context.sha;
  requireEvidence(SHA.test(trustedWorkflowSha || ""), "invalid_context", "trusted workflow SHA");
  requireEvidence(
    env.TRUSTED_WORKFLOW_SHA === trustedWorkflowSha,
    "invalid_context", "trusted source checkout",
  );
  if (payload.pull_request) {
    requireEvidence(payload.pull_request.base?.ref === payload.repository?.default_branch,
      "invalid_context", "native review requires an approved default-branch base");
  }
  if (context.eventName === "workflow_dispatch") {
    requireEvidence(
      context.ref === `refs/heads/${payload.repository?.default_branch}`,
      "invalid_context", "dispatch must use the trusted default branch",
    );
  }
  const rawNumber = payload.pull_request?.number || env.EXPECTED_PR_NUMBER || payload.issue?.number;
  const number = /^\d+$/.test(String(rawNumber || "")) ? Number(rawNumber) : null;
  const headSha = payload.pull_request?.head.sha || env.EXPECTED_HEAD_SHA || null;
  requireEvidence(!headSha || SHA.test(headSha), "invalid_context", "expected head SHA");
  requireEvidence(!headSha || number > 0, "invalid_context", "head SHA requires a PR number");
  requireEvidence(!number || Number.isSafeInteger(number), "invalid_context", "PR number");
  if (payload.inputs?.aw_context) {
    let aw;
    try {
      aw = JSON.parse(payload.inputs.aw_context);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new EvidenceError("invalid_context", "dispatch aw_context");
    }
    requireEvidence(aw && typeof aw === "object" &&
      (!aw.item_number || Number(aw.item_number) === number) &&
      (aw.item_type !== "pull_request" || number > 0),
    "invalid_context", "dispatch item identity");
  }
  const runId = Number(env.GITHUB_RUN_ID || context.runId);
  const runAttempt = Number(env.GITHUB_RUN_ATTEMPT || 1);
  requireEvidence(Number.isSafeInteger(runId) && runId > 0 &&
    Number.isSafeInteger(runAttempt) && runAttempt > 0, "invalid_context", "workflow run/attempt");
  return {
    repository, workflowId, trustedWorkflowSha, number, headSha,
    runId, runAttempt,
  };
}

function reviewEventRelevant(context, checkName) {
  const label = REVIEW_LABELS[checkName];
  return !label || !["issues", "pull_request"].includes(context.eventName) ||
    context.payload.action !== "labeled" || context.payload.label?.name === label;
}

async function readPull(github, context, number) {
  const response = await readApi(
    () => github.rest.pulls.get({ ...context.repo, pull_number: number }),
    `pulls/${number}`,
  );
  const pull = response.data;
  const repository = `${context.repo.owner}/${context.repo.repo}`;
  requireEvidence(
    pull.number === number && pull.state === "open" && !pull.draft &&
      pull.head?.repo?.full_name?.toLowerCase() === repository.toLowerCase() &&
      pull.base?.repo?.full_name?.toLowerCase() === repository.toLowerCase() &&
      SHA.test(pull.head.sha) && SHA.test(pull.base.sha),
    "invalid_context", `open, same-repository PR #${number}`,
  );
  return pull;
}

async function collectScope(github, context, pull, files) {
  const body = pull.body || "";
  const claims = [...body.matchAll(/<!-- factory-claim:([^>\s]+) -->/g)];
  const refs = [...new Set([...body.matchAll(/Refs #(\d+)(?!\d)/g)].map((match) => Number(match[1])))];
  if (!(pull.title || "").startsWith("[ai-dev] ") && claims.length === 0) {
    return { kind: "non_factory", authority: "none", digest: digest(["non_factory"]) };
  }
  requireEvidence(claims.length === 1 && refs.length === 1, "scope_unverified", "factory reference");
  const issueNumber = refs[0];
  const { data: issue } = await readApi(
    () => github.rest.issues.get({ ...context.repo, issue_number: issueNumber }),
    `issues/${issueNumber}`,
  );
  const { data: parent } = await readApi(
    () => github.request("GET /repos/{owner}/{repo}/issues/{issue_number}/parent", {
      ...context.repo, issue_number: issueNumber,
    }),
    `issues/${issueNumber}/parent`,
  );
  const declaredParent = /#(\d+)/.exec(getIssueFormSection(issue.body, "Approved parent goal") || "");
  requireEvidence(parent.number === Number(declaredParent?.[1]), "scope_unverified", "native parent goal");
  const { data: goal } = await readApi(
    () => github.rest.issues.get({ ...context.repo, issue_number: parent.number }),
    `issues/${parent.number}`,
  );
  const timeline = await readPages(github.rest.issues.listEventsForTimeline, {
    ...context.repo, issue_number: goal.number,
  });
  const approval = timeline.filter((event) =>
    ["labeled", "unlabeled"].includes(event.event) && event.label?.name === "factory:goal-approved",
  ).sort((left, right) => right.id - left.id)[0];
  const comments = await readPages(github.rest.issues.listComments, {
    ...context.repo, issue_number: issueNumber,
  });
  const claim = resolveLatestIssueClaim(comments, issueNumber);
  const allowed = normalizeAllowedPathPatterns(getIssueFormSection(issue.body, "Allowed paths"));
  const goalAllowed = normalizeAllowedPathPatterns(getIssueFormSection(goal.body, "Allowed paths"));
  const riskLabel = getDeclaredRiskLabel(issue);
  const goalMaxRiskTier = getIssueFormSection(goal.body, "Maximum autonomous risk tier");
  requireEvidence(
    issue.state === "open" && goal.state === "open" &&
      labels(goal).has("factory:goal") && labels(goal).has("factory:goal-approved") &&
      approval?.event === "labeled" && approval.actor?.type === "User" &&
      claim.state === "valid" && claim.claim.nonce === claims[0][1] &&
      isKnownRiskTier(riskLabel) && isKnownRiskTier(goalMaxRiskTier) &&
      allowed.valid && goalAllowed.valid &&
      areAllowedPathPatternsWithin(allowed.patterns, goalAllowed.patterns) &&
      areChangedFilesWithinAllowedPaths(files, allowed.patterns),
    "scope_unverified", "approved goal, claim, and allowed paths",
  );
  const scope = {
    kind: "factory",
    authority: "scope evidence only; never merge, activation, or boundary approval",
    claim: claim.claim.nonce,
    issue: { number: issue.number, body: issue.body, updatedAt: issue.updated_at,
      labels: [...labels(issue)].sort(), source: sourceUrl(pull.base.repo.full_name, `issues/${issue.number}`) },
    goal: { number: goal.number, body: goal.body, updatedAt: goal.updated_at,
      labels: [...labels(goal)].sort(), source: sourceUrl(pull.base.repo.full_name, `issues/${goal.number}`) },
    approval: { id: approval.id, actor: approval.actor.login, createdAt: approval.created_at,
      source: sourceUrl(pull.base.repo.full_name, `issues/${goal.number}/timeline`) },
    allowedPaths: allowed.patterns,
    goalAllowedPaths: goalAllowed.patterns,
    riskLabel, goalMaxRiskTier,
  };
  return { ...scope, digest: digest(scope) };
}

async function collectCiEvidence(github, context, sha, checks) {
  const repository = `${context.repo.owner}/${context.repo.repo}`;
  const sources = [];
  const artifacts = [];
  const runs = new Map();
  for (const name of CI_CHECKS) {
    const check = latestCheck(checks, name, sha);
    if (!check) continue;
    const bridge = receipt(check, CI_MARKER);
    const attempt = receipt(check, CI_ATTEMPT_MARKER);
    const match = new RegExp(`^https://github\\.com/${repository}/actions/runs/(\\d+)(?:/job/(\\d+))?$`, "i")
      .exec(check.details_url || "");
    requireEvidence(Boolean(match), "evidence_unavailable", `${name} run source`);
    const runId = Number(match[1]);
    if (!runs.has(runId)) {
      const { data: run } = await readApi(
        () => github.rest.actions.getWorkflowRun({ ...context.repo, run_id: runId }),
        `actions/runs/${runId}`,
      );
      requireEvidence(
        run.id === runId && run.path === ".github/workflows/ci.yml" &&
          run.repository?.full_name?.toLowerCase() === repository.toLowerCase(),
        "evidence_unavailable", `${name} trusted CI workflow`,
      );
      const jobs = await readPages(github.rest.actions.listJobsForWorkflowRun, {
        ...context.repo, run_id: runId, filter: "all",
      }, "jobs");
      const retained = await readPages(github.rest.actions.listWorkflowRunArtifacts, {
        ...context.repo, run_id: runId,
      }, "artifacts");
      artifacts.push(...retained.map((artifact) => ({
        id: artifact.id, name: artifact.name, digest: artifact.digest || null,
        sizeInBytes: artifact.size_in_bytes, expired: artifact.expired,
        createdAt: artifact.created_at, expiresAt: artifact.expires_at,
        runId, attemptScope: "run_wide", headSha: sha,
        source: sourceUrl(repository, `actions/artifacts/${artifact.id}`),
      })));
      runs.set(runId, { run, jobs });
    }
    const { run, jobs } = runs.get(runId);
    if (attempt) {
      requireEvidence(check.status !== "completed" && attempt.headSha === sha &&
        attempt.checkName === name && attempt.runId === runId &&
        attempt.runAttempt <= run.run_attempt && attempt.workflowSha === run.head_sha &&
        check.external_id === `${CI_ATTEMPT_MARKER}:${runId}:${attempt.runAttempt}:${name}` &&
        isBoundCiRun(run, sha, attempt.pullNumber, repository, context.payload.repository.default_branch),
      "evidence_unavailable", `${name} pending CI attempt provenance`);
      sources.push({ name, checkId: check.id, runId, runAttempt: attempt.runAttempt,
        status: check.status, conclusion: null, phase: "pending",
        source: sourceUrl(repository, `check-runs/${check.id}`) });
      continue;
    }
    const jobId = bridge ? bridge.jobId : Number(match[2]);
    const job = jobs.find((candidate) => candidate.id === jobId && candidate.name === name);
    requireEvidence(
      job && job.status === check.status && job.conclusion === check.conclusion &&
        Number.isInteger(job.run_attempt) && job.run_attempt > 0 && job.run_attempt <= run.run_attempt,
      "partial_evidence", `${name} job outcome/freshness`,
    );
    if (bridge) {
      requireEvidence(
        bridge.headSha === sha && bridge.runId === runId &&
          bridge.runAttempt === job.run_attempt && bridge.workflowSha === run.head_sha &&
          bridge.checkName === name && bridge.jobId === job.id &&
          check.external_id === `agentic-ci:v1:${runId}:${job.run_attempt}:${job.id}:${sha}` &&
          run.event === "workflow_dispatch" &&
          run.head_branch === context.payload.repository.default_branch &&
          run.display_title === correlationId("ci.yml", bridge.pullNumber, sha),
        "evidence_unavailable", `${name} dispatched CI provenance`,
      );
    } else {
      requireEvidence(
        run.head_sha === sha && ["pull_request", "push"].includes(run.event) &&
          check.check_suite?.id === run.check_suite_id && job.id === check.id,
        "evidence_unavailable", `${name} exact-head CI provenance`,
      );
    }
    sources.push({
      name, checkId: check.id, jobId: job.id, runId, runAttempt: job.run_attempt,
      status: check.status, conclusion: check.conclusion,
      workflowSha: bridge?.workflowSha || run.head_sha, event: run.event,
      source: sourceUrl(repository, `check-runs/${check.id}`),
    });
  }
  return {
    complete: true, state: ciState(checks, sha), fingerprint: ciFingerprint(checks, sha),
    requiredChecks: [...CI_CHECKS], checks: sources, artifacts,
    evidenceDigest: digest({ sources, artifacts }),
  };
}

async function collectDiff(github, context, pull, files, includeContent) {
  const { data: comparison } = await readApi(
    () => github.rest.repos.compareCommitsWithBasehead({
      ...context.repo, basehead: `${pull.base.sha}...${pull.head.sha}`, per_page: 1,
    }),
    `compare/${pull.base.sha}...${pull.head.sha}`,
  );
  const mergeBaseSha = comparison.merge_base_commit?.sha;
  requireEvidence(SHA.test(mergeBaseSha || ""), "partial_evidence", "diff merge base");
  const identity = {
    headSha: pull.head.sha, baseSha: pull.base.sha, mergeBaseSha,
    files: files.map((file) => ({
      filename: file.filename, previousFilename: file.previous_filename || null,
      status: file.status, sha: file.sha, additions: file.additions, deletions: file.deletions,
    })),
  };
  if (!includeContent) return { ...identity, digest: digest(identity) };
  let bytes = 0;
  const roots = new Map();
  const trees = new Map();
  async function contentAt(filename, ref) {
    if (!roots.has(ref)) {
      const { data: commit } = await readApi(
        () => github.rest.git.getCommit({ ...context.repo, commit_sha: ref }), `git/commits/${ref}`,
      );
      requireEvidence(commit.sha === ref && SHA.test(commit.tree?.sha || ""), "partial_evidence", "commit tree");
      roots.set(ref, commit.tree.sha);
    }
    let treeSha = roots.get(ref);
    let entry;
    const parts = filename.split("/");
    for (const [index, part] of parts.entries()) {
      if (!trees.has(treeSha)) {
        const { data: tree } = await readApi(
          () => github.rest.git.getTree({ ...context.repo, tree_sha: treeSha }), `git/trees/${treeSha}`,
        );
        requireEvidence(Array.isArray(tree.tree) && !tree.truncated, "partial_evidence", "complete Git tree");
        trees.set(treeSha, tree.tree);
      }
      const entries = trees.get(treeSha).filter((node) => node.path === part);
      entry = entries[0];
      requireEvidence(entries.length === 1 && SHA.test(entry.sha || "") &&
        entry.type === (index === parts.length - 1 ? "blob" : "tree"),
      "partial_evidence", `literal Git path ${filename}`);
      treeSha = entry.sha;
    }
    // The Contents API follows symlinks; Git trees/blobs preserve the reviewed bytes.
    const { data: blob } = await readApi(
      () => github.rest.git.getBlob({ ...context.repo, file_sha: entry.sha }),
      `git/blobs/${entry.sha}`,
    );
    const buffer = Buffer.from(blob.content || "", "base64");
    bytes += buffer.length;
    requireEvidence(
      blob.encoding === "base64" && buffer.length === blob.size && bytes <= MAX_CONTENT_BYTES &&
        createHash("sha1").update(`blob ${buffer.length}\0`).update(buffer).digest("hex") === entry.sha,
      "partial_evidence", `bounded, complete blob ${filename}`,
    );
    const text = buffer.toString("utf8");
    const utf8 = !buffer.includes(0) && Buffer.from(text).equals(buffer);
    return {
      ref, path: filename, sha: entry.sha, mode: entry.mode, size: buffer.length,
      sha256: createHash("sha256").update(buffer).digest("hex"),
      encoding: utf8 ? "utf8" : "base64", content: utf8 ? text : buffer.toString("base64"),
      source: sourceUrl(pull.base.repo.full_name, `git/blobs/${entry.sha}`),
    };
  }
  const contents = [];
  for (const file of files) {
    const before = file.status === "added" ? null :
      await contentAt(file.previous_filename || file.filename, mergeBaseSha);
    const after = file.status === "removed" ? null : await contentAt(file.filename, pull.head.sha);
    requireEvidence((after || before).sha === file.sha, "partial_evidence", `diff/blob identity ${file.filename}`);
    contents.push({
      filename: file.filename,
      before, after,
      patch: file.patch || null,
      patchIsAdvisory: true,
    });
  }
  return { ...identity, digest: digest(identity), contents, contentComplete: true };
}

async function collectReviewRuns(github, context, workflowId, createdAt) {
  const params = { ...context.repo, workflow_id: workflowId };
  if (createdAt) {
    requireEvidence(Number.isFinite(Date.parse(createdAt)), "invalid_context", "review run lower bound");
    params.created = `>=${createdAt}`;
  }
  return readPages(github.rest.actions.listWorkflowRuns, params, "workflow_runs");
}

async function collectReviewPacket({ github, context, env, includeContent = true }) {
  const identity = trustedContext(context, env);
  const checkName = env.CHECK_NAME;
  requireEvidence(REVIEW_WORKFLOWS[checkName] === identity.workflowId, "invalid_context", "review role");
  requireEvidence(identity.number > 0, "invalid_context", "PR number");
  const pull = await readPull(github, context, identity.number);
  requireEvidence(!identity.headSha || identity.headSha === pull.head.sha, "head_moved", "PR head");
  identity.headSha = pull.head.sha;
  identity.correlationId = correlationId(identity.workflowId, identity.number, identity.headSha);
  requireEvidence(!env.CORRELATION_ID || env.CORRELATION_ID === identity.correlationId, "invalid_context", "correlation");
  const files = await readPages(github.rest.pulls.listFiles, {
    ...context.repo, pull_number: pull.number,
  }, undefined, pull.changed_files);
  requireEvidence(Number.isSafeInteger(pull.changed_files) && files.length > 0, "partial_evidence", "changed files");
  const scope = await collectScope(github, context, pull, files);
  const checks = await readPages(github.rest.checks.listForRef, {
    ...context.repo, ref: pull.head.sha, filter: "all",
  }, "check_runs");
  const runs = await collectReviewRuns(github, context, identity.workflowId, pull.created_at);
  const outcomeFor = (check) => trustedReviewOutcome(
    check, pull.head.sha, runs, identity.repository, context.payload.repository.default_branch,
  );
  let ci;
  try {
    ci = await collectCiEvidence(github, context, pull.head.sha, checks);
  } catch (error) {
    if (!(error instanceof EvidenceError)) throw error;
    ci = { complete: false, state: "unavailable", reason: error.code, source: error.source };
  }
  const rejected = checks.some((check) => check.name === checkName &&
    outcomeFor(check) === "reject");
  const requiresCi = checkName !== CODE_REVIEW_CHECK;
  const prior = latestCheck(checks, checkName, pull.head.sha);
  const alreadyReviewed = context.eventName !== "workflow_dispatch" &&
    prior && outcomeFor(prior) === "pass" &&
    (!requiresCi || receipt(prior, REVIEW_MARKER).ciFingerprint === ci.fingerprint);
  const ready = !rejected && !alreadyReviewed &&
    (!requiresCi || (ci.complete && ["success", "failure"].includes(ci.state)));
  const diff = await collectDiff(github, context, pull, files, includeContent && ready);
  const declared = getDeclaredRiskLabel(pull);
  const risk = determineRiskTier({
    files: getPolicyFiles(files),
    issueRiskLabel: scope.riskLabel ? (declared ? maxRiskTier(declared, scope.riskLabel) : scope.riskLabel) : declared,
  });
  requireEvidence(scope.kind !== "factory" || compareRiskTiers(risk.tier, scope.goalMaxRiskTier) <= 0,
    "scope_unverified", "risk exceeds approved goal");
  const finalPull = await readPull(github, context, pull.number);
  requireEvidence(
    finalPull.head.sha === pull.head.sha && finalPull.base.sha === pull.base.sha &&
      finalPull.changed_files === pull.changed_files && finalPull.body === pull.body &&
      JSON.stringify([...labels(finalPull)].sort()) === JSON.stringify([...labels(pull)].sort()),
    "head_moved", "PR snapshot changed during collection",
  );
  const packet = {
    schemaVersion: 1, ...identity, checkName, pullCreatedAt: pull.created_at, ready,
    reason: rejected ? "substantive_rejection" : alreadyReviewed ? "current_verdict" :
      ready ? "ready" : ci.reason || "ci_pending",
    requiresCi, requiredChecks: [...new Set([
      ...risk.requiredChecks,
      ...getRequestedChecks(pull),
    ])],
    riskTier: risk.tier, scope, diff, ci,
    source: sourceUrl(identity.repository, `pulls/${pull.number}`),
  };
  return { ...packet, packetDigest: digest(packet) };
}

async function prepareReviewEvidence({ github, context, core, env = process.env }) {
  const output = path.join(env.RUNNER_TEMP, "review-evidence", "packet.json");
  let packet;
  let target;
  try {
    target = trustedContext(context, env);
    if (!reviewEventRelevant(context, env.CHECK_NAME)) {
      packet = { schemaVersion: 1, ready: false, reason: "irrelevant_label" };
    } else if (!context.payload.pull_request && !env.EXPECTED_HEAD_SHA) {
      if (!target.number) {
        requireEvidence(!env.CORRELATION_ID, "invalid_context", "correlated dispatch needs a PR");
        packet = { schemaVersion: 1, kind: "non_pr", ready: true };
      } else {
        const { data: issue } = await readApi(
          () => github.rest.issues.get({ ...context.repo, issue_number: target.number }),
          `issues/${target.number}`,
        );
        if (!issue.pull_request) packet = { schemaVersion: 1, kind: "non_pr", ready: true };
      }
    }
    packet ||= await collectReviewPacket({ github, context, env });
  } catch (error) {
    if (!(error instanceof EvidenceError)) throw error;
    core.warning(error.message);
    packet = { schemaVersion: 1, ...target, ready: false, outcome: "infrastructure",
      reason: error.code, source: error.source };
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  for (const change of packet.diff?.contents || []) {
    for (const blob of [change.before, change.after].filter(Boolean)) {
      const relative = `blobs/${blob.sha}.${blob.encoding === "utf8" ? "txt" : "base64"}`;
      const filename = path.join(path.dirname(output), relative);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, blob.content);
      blob.contentFile = relative;
      delete blob.content;
    }
  }
  delete packet.packetDigest;
  packet.packetDigest = digest(packet);
  fs.writeFileSync(output, JSON.stringify(packet, null, 2));
  core.setOutput("ready", String(packet.ready));
  core.setOutput("packet_digest", packet.packetDigest || "");
  core.setOutput("packet_path", path.dirname(output));
  core.setOutput("reason", packet.reason || "non_pr");
  await core.summary.addRaw(`Review evidence: ${packet.reason || "non_pr"}\n`).write();
  return packet;
}

async function recordReviewAttempt({ github, context, env = process.env, packet }) {
  const target = trustedContext(context, env);
  const { packetDigest, ...body } = packet;
  requireEvidence(packetDigest === env.PACKET_DIGEST && digest(body) === packetDigest,
    "invalid_packet", "preparation-job digest");
  if (packet.kind === "non_pr") return { ready: true, reason: "non_pr" };
  if (["irrelevant_label", "current_verdict"].includes(packet.reason)) return { ready: false, reason: packet.reason };
  requireEvidence(REVIEW_WORKFLOWS[env.CHECK_NAME] === target.workflowId, "invalid_context", "review role");
  requireEvidence(packet.number === target.number && packet.workflowId === target.workflowId &&
    packet.trustedWorkflowSha === target.trustedWorkflowSha &&
    packet.runId === target.runId && packet.runAttempt === target.runAttempt,
  "invalid_packet", "attempt target and trusted workflow binding");
  const pull = await readPull(github, context, target.number);
  requireEvidence((!target.headSha || target.headSha === pull.head.sha) &&
    (!packet.headSha || packet.headSha === pull.head.sha),
  "head_moved", "review attempt head");
  const checks = await readPages(github.rest.checks.listForRef, {
    ...context.repo, ref: pull.head.sha, filter: "all",
  }, "check_runs");
  const runs = await collectReviewRuns(github, context, target.workflowId, pull.created_at);
  if (checks.some((check) => check.name === env.CHECK_NAME &&
      trustedReviewOutcome(
        check, pull.head.sha, runs, target.repository, context.payload.repository.default_branch,
      ) === "reject")) {
    return { ready: false, reason: "substantive_rejection_preserved" };
  }
  const proof = {
    packetDigest, checkName: env.CHECK_NAME, headSha: pull.head.sha, pullNumber: pull.number,
    workflowSha: target.trustedWorkflowSha, runId: target.runId, runAttempt: target.runAttempt,
    verdict: packet.ready ? "pending" : "infrastructure",
    reason: packet.ready ? null : INFRA_REASONS.has(packet.reason) ? packet.reason : "evidence_unavailable",
    detail: packet.reason, ciFingerprint: packet.requiresCi ? packet.ci?.fingerprint : null,
  };
  const existing = checks.find((check) => check.name === env.CHECK_NAME &&
    isActionsCheck(check, pull.head.sha) &&
    check.external_id === `agentic-review:v1:${packetDigest}` &&
    receipt(check, REVIEW_MARKER)?.packetDigest === packetDigest &&
    trustedReviewReceipt(
      check, pull.head.sha, runs, target.repository, context.payload.repository.default_branch,
    ));
  if (existing) return { ready: existing.status !== "completed" && packet.ready, checkId: existing.id };
  const { data: check } = await github.rest.checks.create({
    ...context.repo, name: env.CHECK_NAME, head_sha: pull.head.sha,
    external_id: `agentic-review:v1:${packetDigest}`,
    status: packet.ready ? "in_progress" : "completed",
    ...(packet.ready ? {} : { conclusion: "action_required" }),
    details_url: `https://github.com/${target.repository}/actions/runs/${target.runId}`,
    output: { title: packet.ready ? "Trusted review attempt in progress" : "Review evidence unavailable",
      summary: `<!-- ${REVIEW_MARKER} ${JSON.stringify(proof)} -->\n` +
        "Only this bound attempt's structured verdict may complete the check; no older success is reused." },
  });
  requireEvidence(check?.id, "evidence_unavailable", "review-attempt publication");
  return { ready: packet.ready, checkId: check.id };
}

async function publishReviewVerdict({ github, context, env = process.env, packet, items }) {
  requireEvidence(packet && packet.schemaVersion === 1 && packet.ready, "invalid_packet", "ready packet");
  const { packetDigest, ...body } = packet;
  requireEvidence(DIGEST.test(packetDigest || "") && digest(body) === packetDigest,
    "invalid_packet", "packet digest");
  const expected = trustedContext(context, env);
  requireEvidence(
    packet.repository === expected.repository && packet.workflowId === expected.workflowId &&
      packet.trustedWorkflowSha === expected.trustedWorkflowSha &&
      packet.number === expected.number && (!expected.headSha || packet.headSha === expected.headSha) &&
      packet.runId === expected.runId && packet.runAttempt === expected.runAttempt &&
      packet.checkName === env.CHECK_NAME,
    "invalid_packet", "workflow/attempt/target binding",
  );
  const artifacts = await readPages(github.rest.actions.listWorkflowRunArtifacts, {
    ...context.repo, run_id: packet.runId,
  }, "artifacts");
  const preparations = await readPages(github.rest.actions.listJobsForWorkflowRunAttempt, {
    ...context.repo, run_id: packet.runId, attempt_number: packet.runAttempt,
  }, "jobs");
  const preparedBy = preparations.filter((job) => job.name === "Prepare trusted review evidence");
  const retained = artifacts.filter((artifact) =>
    artifact.name === `review-evidence-${packet.runId}-${packet.runAttempt}`);
  const artifact = retained[0];
  const prepared = preparedBy[0];
  // v0.81.6 safe jobs cannot depend directly on preparation-job outputs. The
  // immutable same-run artifact must have been sealed before any model ran.
  requireEvidence(
    preparedBy.length === 1 && prepared.status === "completed" && prepared.conclusion === "success" &&
      retained.length === 1 && !artifact.expired && /^sha256:[a-f0-9]{64}$/.test(artifact.digest || "") &&
      artifact.workflow_run?.id === packet.runId &&
      Date.parse(artifact.created_at) >= Date.parse(prepared.started_at) &&
      Date.parse(artifact.created_at) <= Date.parse(prepared.completed_at),
    "invalid_packet", "immutable artifact from the trusted preparation job",
  );
  requireEvidence(Array.isArray(items) && items.length === 1, "invalid_verdict", "exactly one verdict");
  const item = items[0];
  requireEvidence(
    item.schema_version === "1" && Number(item.pull_request_number) === packet.number &&
      item.head_sha === packet.headSha && item.packet_digest === packetDigest &&
      ["pass", "reject", "infrastructure"].includes(item.verdict) &&
      typeof item.title === "string" && item.title.length > 0 && item.title.length <= 256 &&
      typeof item.summary === "string" && item.summary.length > 0 && item.summary.length <= 60000 &&
      (item.verdict === "infrastructure" ? INFRA_REASONS.has(item.reason) : item.reason === "none"),
    "invalid_verdict", "structured verdict and evidence binding",
  );
  const fresh = await collectReviewPacket({ github, context, env, includeContent: false });
  requireEvidence(
    fresh.headSha === packet.headSha && fresh.diff.digest === packet.diff.digest &&
      fresh.scope.digest === packet.scope.digest &&
      (!packet.requiresCi || JSON.stringify(fresh.requiredChecks) === JSON.stringify(packet.requiredChecks)) &&
      (!packet.requiresCi || (fresh.ci.fingerprint === packet.ci.fingerprint &&
        fresh.ci.evidenceDigest === packet.ci.evidenceDigest)),
    "stale_evidence", "head, scope, requirements, or CI attempts changed",
  );
  const checks = await readPages(github.rest.checks.listForRef, {
    ...context.repo, ref: packet.headSha, filter: "all",
  }, "check_runs");
  const previous = checks.filter((check) => check.name === packet.checkName && isActionsCheck(check, packet.headSha));
  const { data: executingRun } = await readApi(
    () => github.rest.actions.getWorkflowRun({ ...context.repo, run_id: packet.runId }),
    `actions/runs/${packet.runId}`,
  );
  requireEvidence(executingRun.path === `.github/workflows/${packet.workflowId}` &&
    executingRun.repository?.full_name?.toLowerCase() === packet.repository.toLowerCase() &&
    executingRun.run_attempt === packet.runAttempt,
  "invalid_context", "review workflow run");
  const runs = await collectReviewRuns(github, context, packet.workflowId, packet.pullCreatedAt);
  if (previous.some((check) => trustedReviewOutcome(
    check, packet.headSha, runs, packet.repository, context.payload.repository.default_branch,
  ) === "reject")) {
    return { published: false, reason: "substantive_rejection_preserved" };
  }
  const latest = latestBoundReviewRun(runs, packet.checkName, packet.headSha, packet.number,
    packet.repository, context.payload.repository.default_branch);
  requireEvidence(!latest || latest.id < packet.runId ||
    (latest.id === packet.runId && latest.run_attempt === packet.runAttempt),
  "stale_evidence", "newer trusted review attempt");
  const replay = previous.find((check) => {
    const proof = receipt(check, REVIEW_MARKER);
    return check.status === "completed" && proof?.packetDigest === packetDigest &&
      proof.runId === packet.runId && proof.runAttempt === packet.runAttempt &&
      ["pass", "reject", "infrastructure"].includes(trustedReviewOutcome(
        check, packet.headSha, runs, packet.repository, context.payload.repository.default_branch,
      ));
  });
  if (replay) {
    requireEvidence(receipt(replay, REVIEW_MARKER).verdict === item.verdict,
      "invalid_verdict", "conflicting replay verdict");
    return { published: false, reason: "idempotent_replay" };
  }
  requireEvidence(
    item.verdict !== "pass" || (!packet.requiresCi || packet.ci.state === "success"),
    "invalid_verdict", "required CI is not successful",
  );
  const proof = {
    packetDigest, checkName: packet.checkName, headSha: packet.headSha,
    pullNumber: packet.number, workflowSha: packet.trustedWorkflowSha,
    runId: packet.runId, runAttempt: packet.runAttempt, correlationId: packet.correlationId,
    verdict: item.verdict, reason: item.verdict === "infrastructure" ? item.reason : null,
    ciFingerprint: packet.requiresCi ? packet.ci.fingerprint : null,
    scopeDigest: packet.scope.digest, diffDigest: packet.diff.digest,
    packetArtifact: { id: artifact.id, digest: artifact.digest, preparationJobId: prepared.id },
  };
  const input = {
    ...context.repo, name: packet.checkName,
    external_id: `agentic-review:v1:${packetDigest}`, status: "completed",
    conclusion: { pass: "success", reject: "failure", infrastructure: "action_required" }[item.verdict],
    completed_at: new Date().toISOString(),
    details_url: `https://github.com/${packet.repository}/actions/runs/${packet.runId}`,
    output: { title: item.title, summary: `<!-- ${REVIEW_MARKER} ${JSON.stringify(proof)} -->\n${item.summary}` },
  };
  const pending = previous.find((check) => check.status !== "completed" &&
    check.external_id === `agentic-review:v1:${packetDigest}` &&
    receipt(check, REVIEW_MARKER)?.packetDigest === packetDigest &&
    trustedReviewReceipt(
      check, packet.headSha, runs, packet.repository, context.payload.repository.default_branch,
    ));
  const check = pending
    ? await github.rest.checks.update({ ...input, check_run_id: pending.id })
    : await github.rest.checks.create({ ...input, head_sha: packet.headSha });
  return { published: true, checkId: check.data.id };
}

async function prepareCiDispatch({ github, context, env = process.env }) {
  const target = trustedContext(context, { ...env, REVIEW_WORKFLOW_ID: "ci.yml" });
  requireEvidence(context.eventName === "workflow_dispatch", "invalid_context", "CI dispatch event");
  if (!target.headSha && !target.number && !env.CORRELATION_ID) {
    return { ...target, headSha: context.sha, publish: false };
  }
  requireEvidence(target.number > 0 && SHA.test(target.headSha || ""), "invalid_context", "CI PR and head required");
  const pull = await readPull(github, context, target.number);
  requireEvidence(pull.head.sha === target.headSha, "head_moved", "CI PR head");
  requireEvidence(env.CORRELATION_ID === correlationId("ci.yml", target.number, target.headSha),
    "invalid_context", "CI correlation");
  return { ...target, publish: true };
}

async function beginCiChecks({ github, context, env = process.env, preparation }) {
  const target = await prepareCiDispatch({ github, context, env });
  requireEvidence(digest(target) === digest(preparation), "invalid_packet", "CI attempt preparation binding");
  if (!target.publish) return;
  const checks = await readPages(github.rest.checks.listForRef, {
    ...context.repo, ref: target.headSha, filter: "all",
  }, "check_runs");
  for (const name of CI_CHECKS) {
    if (checks.some((check) => {
      const proof = receipt(check, CI_ATTEMPT_MARKER) || receipt(check, CI_MARKER);
      return isActionsCheck(check, target.headSha) && check.name === name &&
        proof?.runId === target.runId && proof.runAttempt === target.runAttempt;
    })) continue;
    const proof = { headSha: target.headSha, workflowSha: target.trustedWorkflowSha,
      pullNumber: target.number, runId: target.runId, runAttempt: target.runAttempt, checkName: name };
    await github.rest.checks.create({
      ...context.repo, head_sha: target.headSha, name, status: "in_progress",
      external_id: `${CI_ATTEMPT_MARKER}:${target.runId}:${target.runAttempt}:${name}`,
      details_url: `https://github.com/${target.repository}/actions/runs/${target.runId}`,
      output: { title: "Trusted exact-head CI attempt in progress",
        summary: `<!-- ${CI_ATTEMPT_MARKER} ${JSON.stringify(proof)} -->\n` +
          "Required CI is pending for this dispatch; older same-head successes are not reused." },
    });
  }
}

async function publishCiChecks({ github, context, env = process.env, preparation, outcomes }) {
  const target = await prepareCiDispatch({ github, context, env });
  requireEvidence(target.publish && digest(target) === digest(preparation), "invalid_packet", "CI preparation binding");
  const { data: run } = await readApi(
    () => github.rest.actions.getWorkflowRun({ ...context.repo, run_id: target.runId }),
    `actions/runs/${target.runId}`,
  );
  requireEvidence(
    run.path === ".github/workflows/ci.yml" && run.event === "workflow_dispatch" &&
      run.head_sha === target.trustedWorkflowSha && run.run_attempt === target.runAttempt &&
      run.display_title === env.CORRELATION_ID,
    "invalid_context", "trusted CI workflow run",
  );
  const jobs = await readPages(github.rest.actions.listJobsForWorkflowRunAttempt, {
    ...context.repo, run_id: target.runId, attempt_number: target.runAttempt,
  }, "jobs");
  const existing = await readPages(github.rest.checks.listForRef, {
    ...context.repo, ref: target.headSha, filter: "all",
  }, "check_runs");
  const plan = CI_CHECKS.map((name) => {
    const candidates = jobs.filter((job) => job.name === name);
    const job = candidates[0];
    requireEvidence(candidates.length === 1 && job.status === "completed" &&
      job.conclusion === outcomes[name], "partial_evidence", `${name} completed job outcome`);
    return { name, job };
  });
  for (const { name, job } of plan) {
    const externalId = `agentic-ci:v1:${target.runId}:${target.runAttempt}:${job.id}:${target.headSha}`;
    if (existing.some((check) => isActionsCheck(check, target.headSha) && check.external_id === externalId)) continue;
    const proof = {
      headSha: target.headSha, workflowSha: target.trustedWorkflowSha, pullNumber: target.number,
      runId: target.runId, runAttempt: target.runAttempt, jobId: job.id, checkName: name,
    };
    const input = {
      ...context.repo, name, external_id: externalId, status: "completed",
      conclusion: ["success", "failure", "cancelled", "timed_out", "skipped", "action_required"].includes(job.conclusion)
        ? job.conclusion : "action_required",
      details_url: `https://github.com/${target.repository}/actions/runs/${target.runId}/job/${job.id}`,
      completed_at: new Date().toISOString(),
      output: { title: name, summary: `<!-- ${CI_MARKER} ${JSON.stringify(proof)} -->\n` +
        `Trusted dispatch tested ${target.headSha}; source job ${job.id}: ${job.conclusion}.` },
    };
    const pending = existing.find((check) => check.name === name && isActionsCheck(check, target.headSha) &&
      check.external_id === `${CI_ATTEMPT_MARKER}:${target.runId}:${target.runAttempt}:${name}` &&
      check.status !== "completed");
    if (pending) await github.rest.checks.update({ ...input, check_run_id: pending.id });
    else await github.rest.checks.create({ ...input, head_sha: target.headSha });
  }
}

module.exports = {
  CI_CHECKS, CI_MARKER, CI_ATTEMPT_MARKER, REVIEW_MARKER, DISPATCH_MARKER, REVIEW_WORKFLOWS, HUMAN_BOUNDARY_APPROVAL_CHECK,
  MAX_INFRA_ATTEMPTS, RETRY_DELAY_MS, DISPATCH_LEASE_MS, EvidenceError,
  readPages, digest, correlationId, latestCheck, ciFingerprint, ciState, receipt,
  getPolicyFiles, getDeclaredRiskLabel, getRequestedChecks,
  reviewVerdictItems,
  semanticReviewOutcome, trustedReviewSource, trustedReviewOutcome, infrastructureRetryDecision,
  isBoundReviewRun, latestBoundReviewRun, hasNewerReviewAttempt, markIncompleteReviewAttempt,
  isBoundCiRun,
  reviewDispatchDecision, reviewEventRelevant, dispatchReservation, collectCiEvidence, collectReviewPacket,
  prepareReviewEvidence, recordReviewAttempt, publishReviewVerdict, prepareCiDispatch, beginCiChecks, publishCiChecks,
};
