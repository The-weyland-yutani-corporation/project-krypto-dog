"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const runtime = require("../../.github/scripts/agentic-queue-runtime.cjs");
const queue = require("../../.github/scripts/agentic-queue-controller.cjs");
const policy = require("../../.github/scripts/agentic-factory-policy.cjs");
const reads = require("./factory-read.cjs");

const MAX_DETAIL_ISSUES = 200;
const SIGNAL_MARKER = /<!-- factory-signal:v1 ([a-f0-9]{64}) -->/;

function ageHours(value, now) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? Math.max(0, Math.floor((Date.parse(now) - time) / 3600000)) : null;
}

function issueParent(issue) {
  const sections = runtime.extractIssueFormSections(issue.body);
  return runtime.parseIssueReference(runtime.getIssueFormSection(sections, "Approved parent goal"));
}

function isWork(issue) {
  const labels = runtime.normalizeLabels(issue.labels);
  return !issue.pull_request && !labels.includes("report") &&
    !labels.includes(runtime.CONTROL_LABEL) && !labels.includes(runtime.GOAL_LABEL);
}

function latestHumanApplication(events, label) {
  const event = runtime.findLatestLabelApplicationEvent(events, label);
  return event && runtime.isHumanActorType(event.actor?.type) ? event : null;
}

function buildFactoryState({ issues, details, sources, now, sha, defaultBranch, evalRuns }) {
  const complete = Object.values(sources).every((value) => value.completeness === "complete");
  const open = issues.filter((issue) => issue.state === "open" && !issue.pull_request);
  const controls = open.filter((issue) => runtime.normalizeLabels(issue.labels).includes(runtime.CONTROL_LABEL));
  let mode = runtime.determineFactoryMode(controls);
  const control = mode.controlIssue;
  const modeEvent = control
    ? runtime.findLatestLabelApplicationEvent(details[control.number]?.events, `factory-mode:${mode.mode}`)
    : null;
  if (mode.mode === "active" && !latestHumanApplication(details[control.number]?.events, "factory-mode:active")) {
    mode = { ...mode, mode: "paused", reason: "active-mode-not-human-applied" };
  }
  const goals = open.filter((issue) => runtime.normalizeLabels(issue.labels).includes(runtime.GOAL_LABEL));
  const approved = goals.filter((issue) => runtime.normalizeLabels(issue.labels).includes(runtime.GOAL_APPROVED_LABEL));
  let resolution = runtime.resolveActiveGoal(approved);
  if (resolution.valid && !latestHumanApplication(details[resolution.goal.number]?.events, runtime.GOAL_APPROVED_LABEL)) {
    resolution = { valid: false, reason: "goal-approval-not-human-applied", goal: null };
  }
  const goal = resolution.goal;
  const work = issues.filter(isWork);
  const inFlight = work.filter((issue) => issue.state === "open" &&
    runtime.normalizeLabels(issue.labels).some((label) => runtime.IN_FLIGHT_LABELS.includes(label)));
  const goalWork = goal ? work.filter((issue) => issueParent(issue) === goal.number) : [];
  const queued = goalWork.filter((issue) => issue.state === "open" &&
    (runtime.normalizeLabels(issue.labels).includes(policy.QUEUE_READY_LABEL) || SIGNAL_MARKER.test(issue.body || "")));
  const consumed = goalWork.filter((issue) =>
    runtime.normalizeLabels(issue.labels).some((label) => runtime.POST_QUEUE_LIFECYCLE_LABELS.includes(label)) &&
    (details[issue.number]?.comments || []).some((comment) => runtime.CLAIM_MARKER_PATTERN.test(comment.body || "")));
  const stages = work.filter((issue) => issue.state === "open").map((issue) => {
    const labels = runtime.normalizeLabels(issue.labels);
    const states = labels.filter((label) => policy.LIFECYCLE_STATE_VALUES.includes(label));
    const event = states.length === 1
      ? runtime.findLatestLabelApplicationEvent(details[issue.number]?.events, states[0]) : null;
    return {
      number: issue.number, states, stageSince: event?.created_at || null,
      stageAgeHours: ageHours(event?.created_at, now), issueAgeHours: ageHours(issue.created_at, now),
    };
  }).filter((item) => item.states.length);
  const claims = work.filter((issue) => issue.state === "open" &&
    runtime.normalizeLabels(issue.labels).some((label) => runtime.IN_FLIGHT_LABELS.includes(label))).flatMap((issue) => {
    const comments = (details[issue.number]?.comments || []).filter((comment) =>
      runtime.CLAIM_MARKER_PATTERN.test(comment.body || ""));
    if (!comments.length) return [];
    const latest = comments.slice().sort((a, b) => b.id - a.id)[0];
    const parsed = queue.parseClaimPayload(latest.body.match(runtime.CLAIM_MARKER_PATTERN)[1]);
    return [{
      issue: issue.number,
      ...queue.evaluateClaimState(parsed.valid ? parsed.claim : { malformed: true }, now),
    }];
  });
  const latestEval = (evalRuns || []).filter((run) => run.head_sha === sha &&
    run.head_branch === defaultBranch).sort((a, b) => b.id - a.id)[0];
  const evalBusy = (evalRuns || []).filter((run) => run.status !== "completed").length;
  const evalCapacity = {
    available: complete && Boolean(latestEval && latestEval.conclusion === "success" &&
      latestEval.status === "completed" && ageHours(latestEval.updated_at, now) <= 24 && evalBusy === 0),
    runId: latestEval?.id || null, sha, busy: complete ? evalBusy : null,
    reason: latestEval ? latestEval.conclusion || latestEval.status : "no-current-sha-evaluation",
  };
  const blockReasons = [];
  const incompleteSources = Object.values(sources).filter((value) => value.completeness !== "complete");
  const incompleteReason = incompleteSources.every((value) => /limit-reached$/.test(value.reason || ""))
    ? "observation-incomplete" : "infrastructure-failure";
  if (!complete) blockReasons.push(incompleteReason);
  if (mode.mode !== "active") blockReasons.push(mode.mode === "paused" ? "paused" : "shadow");
  if (mode.reason !== "ok") blockReasons.push(mode.reason);
  if (!resolution.valid) blockReasons.push(resolution.reason);
  if (goal && consumed.length >= goal.dailyBudgetLimit) blockReasons.push("budget-exhausted");
  if (goal && inFlight.length + queued.length >= Math.min(1, goal.concurrencyLimit)) blockReasons.push("wip-full");
  if (goalWork.some((issue) => issue.state === "open" && runtime.normalizeLabels(issue.labels).includes(runtime.BLOCKED_LABEL))) {
    blockReasons.push("blocked-work");
  }
  if (claims.some((claim) => claim.expired || claim.reason === "malformed-claim")) blockReasons.push("claim-recovery-required");
  if (!evalCapacity.available) blockReasons.push("evaluation-unavailable");
  const workState = !complete ? incompleteReason : mode.mode !== "active" ? mode.mode
    : resolution.reason === "multiple-active-goals" ? "conflicting-goals"
      : !goal ? "no-approved-goal"
        : blockReasons.includes("budget-exhausted") ? "budget-exhausted"
          : blockReasons.includes("blocked-work") ? "blocked-work"
            : inFlight.length || queued.length ? "existing-work" : "no-work";
  return {
    schemaVersion: 1, sha, defaultBranch,
    mode: { mode: mode.mode, reason: mode.reason, controlIssue: control?.number || null,
      since: modeEvent?.created_at || null, ageHours: ageHours(modeEvent?.created_at, now) },
    goals: {
      resolution: resolution.reason, active: goal,
      items: goals.map((issue) => ({
        number: issue.number, approvedLabelPresent: approved.includes(issue),
        validation: runtime.resolveActiveGoal([issue]).reason,
        approvalAgeHours: ageHours(latestHumanApplication(details[issue.number]?.events, runtime.GOAL_APPROVED_LABEL)?.created_at, now),
        updatedAgeHours: ageHours(issue.updated_at, now),
      })),
    },
    capacity: {
      inFlight: complete ? inFlight.length : null, queued: complete ? queued.length : null,
      budgetUsed: complete && goal ? consumed.length : null, budgetLimit: goal?.dailyBudgetLimit ?? null,
      concurrencyLimit: goal ? Math.min(1, goal.concurrencyLimit) : null,
      completeness: complete ? "complete" : "partial",
    },
    activity: {
      assignmentUnitsConsumed: complete && goal ? consumed.length : null,
      repairEntries: complete ? Object.values(details).flatMap((detail) => detail.events || [])
        .filter((event) => event.event === "labeled" && event.label?.name === policy.LIFECYCLE_STATES.REPAIRING).length : null,
      repairEntryScope: "retained issue timelines; label entries, not inferred repair commits",
    },
    stages, claims, evalCapacity, workState, blockReasons,
  };
}

async function readFactoryState({ github, owner, repo, now = new Date().toISOString() }) {
  if (!runtime.isValidTimestamp(now)) throw new Error("invalid-observation-time");
  const params = { owner, repo };
  const issueRead = await reads.readApiPages(github, "GET /repos/{owner}/{repo}/issues",
    { ...params, state: "all", sort: "updated", direction: "desc" }, { now });
  const issues = issueRead.data.filter((issue) => !issue.pull_request);
  const sources = { issues: issueRead.source };
  const details = {};
  const relevant = issues.filter((issue) => {
    const labels = runtime.normalizeLabels(issue.labels);
    if (labels.includes("report")) return false;
    return labels.includes(runtime.FACTORY_LABEL) || labels.includes(runtime.CONTROL_LABEL) ||
      labels.includes(runtime.GOAL_LABEL) || SIGNAL_MARKER.test(issue.body || "");
  });
  if (relevant.length > MAX_DETAIL_ISSUES) {
    sources.details = reads.source("partial", MAX_DETAIL_ISSUES, now, "issue-detail-limit-reached", relevant.length);
  }
  for (const issue of relevant.slice(0, MAX_DETAIL_ISSUES)) {
    const events = await reads.readApiPages(github, "GET /repos/{owner}/{repo}/issues/{issue_number}/timeline",
      { ...params, issue_number: issue.number }, { now });
    sources[`timeline-${issue.number}`] = events.source;
    let comments = { data: [], source: reads.source("complete", 0, now) };
    if (isWork(issue) && (runtime.normalizeLabels(issue.labels).some((label) =>
      runtime.POST_QUEUE_LIFECYCLE_LABELS.includes(label)) || SIGNAL_MARKER.test(issue.body || ""))) {
      comments = await reads.readApiPages(github, "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
        { ...params, issue_number: issue.number }, { now });
      sources[`comments-${issue.number}`] = comments.source;
    }
    details[issue.number] = { events: events.data, comments: comments.data };
  }
  const repository = (await github.request("GET /repos/{owner}/{repo}", params)).data;
  const defaultBranch = repository.default_branch;
  if (typeof defaultBranch !== "string" || !defaultBranch) throw new Error("default-branch-unavailable");
  const branch = (await github.request("GET /repos/{owner}/{repo}/branches/{branch}",
    { ...params, branch: defaultBranch })).data;
  const sha = branch.commit?.sha;
  if (typeof sha !== "string" || !/^[a-f0-9]{40}$/.test(sha)) throw new Error("default-sha-unavailable");
  const evals = await reads.readApiPages(github, "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs",
    { ...params, workflow_id: "agentic-evals.yml", branch: defaultBranch,
      created: `>=${new Date(Date.parse(now) - 7 * 86400000).toISOString()}` },
    { now, key: "workflow_runs" });
  sources.evaluations = evals.source;
  const state = buildFactoryState({ issues, details, sources, now, sha, defaultBranch, evalRuns: evals.data });
  return { state, sources, issues, details };
}

async function readSignalOutcomes({ github, owner, repo, observation, window, repoRoot, evidenceReader }) {
  const capability = path.join(repoRoot, ".github", "scripts", "azure", "dev-evidence.cjs");
  const reader = evidenceReader || (fs.existsSync(capability) ? require(capability).readDevEvidence : null);
  if (reader !== null && typeof reader !== "function") throw new Error("invalid-dev-evidence-reader");
  const issueReadComplete = observation.sources.issues.completeness === "complete";
  const pullRead = await reads.readApiPages(github, "GET /repos/{owner}/{repo}/pulls",
    { owner, repo, state: "closed", sort: "updated", direction: "desc" }, { now: window.end });
  const items = [];
  for (const issue of observation.issues.filter(isWork)) {
    const match = (issue.body || "").match(SIGNAL_MARKER);
    const claims = observation.details[issue.number]?.comments || [];
    const claim = claims.filter((comment) => comment.user?.login === "github-actions[bot]" &&
      runtime.CLAIM_MARKER_PATTERN.test(comment.body || "")).sort((a, b) => b.id - a.id)[0];
    const parsed = claim ? queue.parseClaimPayload(claim.body.match(runtime.CLAIM_MARKER_PATTERN)[1]) : null;
    if (!match && !claim) continue;
    const nonce = parsed?.valid && parsed.claim.issueNumber === issue.number ? parsed.claim.nonce : null;
    const correlated = pullRead.data.filter((pr) => nonce && pr.merged_at &&
      pr.head?.repo?.full_name === `${owner}/${repo}` &&
      pr.base?.ref === observation.state.defaultBranch &&
      new RegExp(`\\bRefs #${issue.number}(?!\\d)`).test(pr.body || "") &&
      (pr.body || "").includes(`<!-- factory-claim:${nonce} -->`));
    const pr = correlated.length === 1 ? correlated[0] : null;
    let proof = { outcome: "pending", reason: reader ? "missing-unique-merged-pr" : "dev-evidence-reader-unavailable" };
    if (reader && pr && pullRead.source.completeness === "complete") {
      proof = await reader({ github, owner, repo, sha: pr.merge_commit_sha, pullNumber: pr.number });
      if (proof.outcome === "success" &&
          (proof.receipt?.releaseSha !== pr.merge_commit_sha || proof.receipt?.environmentName !== "dev")) {
        proof = { outcome: "pending", reason: "dev-receipt-binding-mismatch" };
      }
    }
    const sections = runtime.extractIssueFormSections(issue.body);
    const scope = runtime.getIssueFormSection(sections, "Allowed paths") || "";
    const substantive = !/heartbeat|canary/i.test(`${issue.title || ""}\n${scope}`);
    let parent = null;
    try {
      const result = (await github.request("GET /repos/{owner}/{repo}/issues/{issue_number}/parent",
        { owner, repo, issue_number: issue.number })).data;
      const repositoryUrl = `${process.env.GITHUB_API_URL || "https://api.github.com"}/repos/${owner}/${repo}`;
      parent = result.repository_url?.toLowerCase() === repositoryUrl.toLowerCase() ? result.number : null;
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    if (parent !== issueParent(issue)) proof = { outcome: "pending", reason: "native-goal-provenance-mismatch" };
    const admission = match ? await readAdmissionProof({ github, owner, repo, issue, fingerprint: match[1] }) : null;
    if (match && !admission) proof = { outcome: "pending", reason: "signal-admission-proof-unavailable" };
    const measuredOutcome = await measureOutcome({ github, owner, repo, issue, pr, proof });
    items.push({
      fingerprint: match ? match[1] : null, goalNumber: parent, issueNumber: issue.number, claimNonce: nonce,
      pullNumber: pr?.number || null, headSha: pr?.head?.sha || null,
      mergeSha: pr?.merge_commit_sha || null, mergedAt: pr?.merged_at || null,
      development: proof, substantive, measuredOutcome, admission,
    });
  }
  const complete = issueReadComplete && Object.values(observation.sources).every((value) => value.completeness === "complete") &&
    pullRead.source.completeness === "complete" && reader !== null;
  return {
    completeness: complete ? "complete" : "unavailable",
    reason: reader ? (complete ? "collected" : "partial-provenance") : "dev-evidence-reader-unavailable",
    verifiedSubstantive: complete ? items.filter((item) => item.substantive && item.development.outcome === "success" &&
      Date.parse(item.mergedAt) >= Date.parse(window.start) && Date.parse(item.mergedAt) < Date.parse(window.end)).length : null,
    items, paperMetrics: null,
  };
}

async function readAdmissionProof({ github, owner, repo, issue, fingerprint }) {
  const sections = runtime.extractIssueFormSections(issue.body);
  const context = runtime.getIssueFormSection(sections, "Context, links, or constraints") || "";
  const anchors = [...context.matchAll(/^Scope source: #([1-9]\d*)\s*$/gm)];
  if (anchors.length !== 1) return null;
  const sourceIssueNumber = Number(anchors[0][1]);
  const goalNumber = issueParent(issue);
  let parent;
  try {
    const result = (await github.request("GET /repos/{owner}/{repo}/issues/{issue_number}/parent",
      { owner, repo, issue_number: sourceIssueNumber })).data;
    const repositoryUrl = `${process.env.GITHUB_API_URL || "https://api.github.com"}/repos/${owner}/${repo}`;
    parent = result.repository_url?.toLowerCase() === repositoryUrl.toLowerCase() ? result.number : null;
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
  if (parent !== goalNumber) return null;
  const comments = await reads.readApiPages(github, "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
    { owner, repo, issue_number: sourceIssueNumber });
  const bodySha256 = crypto.createHash("sha256").update(issue.body, "utf8").digest("hex");
  const matches = [];
  for (const comment of reads.requireComplete(comments, "signal-admission-proof")) {
    if (comment.user?.login !== "github-actions[bot]" || !comment.created_at ||
        comment.created_at !== comment.updated_at) continue;
    const marker = comment.body?.match(/^<!-- factory-signal-admission:v1 (\{[^\n]+\}) -->$/);
    if (!marker) continue;
    let value;
    try { value = JSON.parse(marker[1]); } catch { return null; }
    if (value.schemaVersion === 1 && value.phase === "native-linked" &&
        value.fingerprint === fingerprint && value.sourceIssueNumber === sourceIssueNumber &&
        value.issueNumber === issue.number && value.goalNumber === goalNumber && value.bodySha256 === bodySha256) {
      matches.push({ ...value, commentId: comment.id });
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

async function measureOutcome({ github, owner, repo, issue, pr, proof }) {
  const pending = { status: "pending", reason: "post-observation-unavailable", baseline: null, observedValue: null };
  const marker = (issue.body || "").match(/<!-- factory-signal-evidence:v1 ([A-Za-z0-9+/=]+) -->/);
  if (!marker || marker[1].length > 40000) return pending;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(marker[1], "base64").toString("utf8"));
  } catch {
    return { ...pending, reason: "malformed-signal-provenance" };
  }
  const contract = require("./signal-contract.cjs");
  if (contract.validateProposal(payload.proposal).length) return { ...pending, reason: "invalid-signal-provenance" };
  pending.baseline = payload.proposal.baseline;
  if (!pr || proof.outcome !== "success" || payload.proposal.baseline.metric !== "failing-workflow-runs" ||
      payload.proposal.oracle.value !== 0 || payload.signal?.source?.kind !== "workflow-run") return pending;
  const workflow = payload.signal.source.key?.split(":")[0]?.split("/").pop();
  if (!workflow || !/^[a-z0-9-]+\.(?:lock\.)?yml$/.test(workflow)) return pending;
  const runs = await reads.readApiPages(github, "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs",
    { owner, repo, workflow_id: workflow, head_sha: pr.merge_commit_sha, branch: pr.base.ref },
    { key: "workflow_runs" });
  if (runs.source.completeness !== "complete") return { ...pending, reason: "post-observation-incomplete" };
  const latest = runs.data.filter((run) => run.head_sha === pr.merge_commit_sha &&
    run.head_branch === pr.base.ref && Date.parse(run.created_at) >= Date.parse(pr.merged_at))
    .sort((a, b) => b.id - a.id)[0];
  if (!latest || latest.status !== "completed" || !["success", "failure"].includes(latest.conclusion)) return pending;
  return {
    status: latest.conclusion === "success" ? "met" : "not-met",
    reason: "independent-post-merge-workflow", baseline: payload.proposal.baseline,
    oracle: payload.proposal.oracle, observedValue: latest.conclusion === "success" ? 0 : 1,
    evidenceRef: `https://github.com/${owner}/${repo}/actions/runs/${latest.id}`,
    sha: latest.head_sha, synthetic: false, tradingEdge: null,
  };
}

module.exports = { MAX_DETAIL_ISSUES, SIGNAL_MARKER, ageHours, issueParent, isWork, latestHumanApplication, buildFactoryState, readFactoryState, readSignalOutcomes, measureOutcome, readAdmissionProof };
