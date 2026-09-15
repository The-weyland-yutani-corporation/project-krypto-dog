"use strict";

const { createHash } = require("node:crypto");
const {
  CONTROL_LABEL, GOAL_LABEL, GOAL_APPROVED_LABEL, FACTORY_LABEL, PRIORITY_LABELS,
  CANDIDATE_FORM_HEADINGS, normalizeLabels, determineFactoryMode, resolveActiveGoal,
  inspectIssueForm, getIssueFormSection, parseCandidateSections, isHumanActorType,
  resolveLatestLabelApplicationActorType, countInFlight, countBudgetConsumption, buildCandidate,
  resolveGoalScopeEvidence,
  nativeParentMatchesRepository,
  formatMachineReceipt, parseMachineReceipt,
} = require("./agentic-queue-runtime.cjs");
const { evaluateEligibility } = require("./agentic-queue-controller.cjs");
const {
  LIFECYCLE_STATE_VALUES, RISK_TIER_LABELS, BLOCKING_QUEUE_LABELS, QUEUE_READY_LABEL,
  applyLifecycleTransition, isKnownRiskTier, rankRiskTier, classifyPathTier, areAllowedPathPatternsWithin,
} = require("./agentic-factory-policy.cjs");
const { REQUIRED_WORK_ITEM_HEADINGS, diagnoseGoalIssue, linkedPullRequestNumbers } = require("./agentic-factory-readiness.cjs");

const RECEIPT = /<!-- factory-intake:v1 (.+?) -->/g;
const RESULT_RECEIPT = /<!-- factory-intake-result:v1 (.+?) -->/g;
const STAGES = Object.freeze({
  pm: { actor: "product-manager", from: "needs-triage", to: "ready-for-planning" },
  em: { actor: "engineering-manager", from: "ready-for-planning", to: QUEUE_READY_LABEL },
});
const stripReceipts = (body) => body.replace(RECEIPT, "").trim();
const hash = (value) => createHash("sha256").update(value).digest("hex");

async function loadIntakeAuthority({ github, context, core, now = new Date().toISOString() }) {
  const { owner, repo } = context.repo;
  const list = async (labels) => {
    const issues = await github.paginate(github.rest.issues.listForRepo, {
      owner, repo, state: "open", labels: labels.join(","), per_page: 100,
    });
    if (!Array.isArray(issues)) throw new Error("Malformed issue list");
    return issues.filter((issue) => !issue.pull_request);
  };
  try {
    const control = determineFactoryMode(await list([CONTROL_LABEL]));
    if (!["active", "shadow"].includes(control.mode)) return { ok: false, reasons: ["factory-not-active", control.reason], mode: control.mode };
    if (control.mode === "active" && !isHumanActorType(await resolveLatestLabelApplicationActorType({
      github, owner, repo, core, issueNumber: control.controlIssue.number, labelName: "factory-mode:active",
    }))) return { ok: false, reasons: ["active-mode-not-human-applied"], mode: "paused" };
    const goals = await list([GOAL_LABEL, GOAL_APPROVED_LABEL]);
    const resolved = resolveActiveGoal(goals);
    if (!resolved.valid) return { ok: false, reasons: [resolved.reason], mode: control.mode };
    const diagnostic = diagnoseGoalIssue(goals[0]);
    if (diagnostic.reasons.length) return { ok: false, reasons: diagnostic.reasons, mode: control.mode };
    if (!isHumanActorType(await resolveLatestLabelApplicationActorType({
      github, owner, repo, core, issueNumber: resolved.goal.number, labelName: GOAL_APPROVED_LABEL,
    }))) return { ok: false, reasons: ["goal-approval-not-human-applied"], mode: control.mode };
    const config = {
      factoryMode: control.mode, goalApproved: true, goalNumber: resolved.goal.number,
      ...resolved.goal, goalMilestone: resolved.goal.milestone, allowedMilestones: [resolved.goal.milestone],
      currentInFlightCount: await countInFlight(github, owner, repo),
      currentBudgetUsed: await countBudgetConsumption(github, owner, repo, resolved.goal.number, core),
      now,
    };
    return {
      ok: true, reasons: [], mode: control.mode, config, goalIssue: goals[0],
      revision: hash(JSON.stringify([control.controlIssue, goals[0], config.currentInFlightCount, config.currentBudgetUsed])),
    };
  } catch (error) {
    core.warning(`Intake authorization read failed: ${error.message}`);
    return { ok: false, reasons: ["authorization-api-incomplete"], mode: "paused" };
  }
}

async function readIntakeCandidate({ github, context, core, issue, activeGoalNumber }) {
  const { owner, repo } = context.repo;
  const candidate = await buildCandidate({ github, owner, repo, core, issue, activeGoalNumber });
  let parentStatus = "unknown";
  try {
    const response = await github.request("GET /repos/{owner}/{repo}/issues/{issue_number}/parent", { owner, repo, issue_number: issue.number });
    if (!nativeParentMatchesRepository(response.data, owner, repo)) throw new Error("Native parent repository is unverified");
    candidate.nativeParentGoalNumber = response.data.number;
    parentStatus = "present";
  } catch (error) {
    if (error.status === 404) parentStatus = "absent";
    else core.warning(`Intake native parent read failed for #${issue.number}: ${error.message}`);
  }
  try {
    const pulls = await github.paginate(github.rest.pulls.list, { owner, repo, state: "open", per_page: 100 });
    const timeline = await github.paginate(github.rest.issues.listEventsForTimeline, { owner, repo, issue_number: issue.number, per_page: 100 });
    if (!Array.isArray(pulls) || !Array.isArray(timeline)) throw new Error("Incomplete open PR or timeline read");
    candidate.hasOpenPullRequest ||= linkedPullRequestNumbers(pulls, issue.number, timeline).length > 0;
  } catch (error) {
    core.warning(`Intake open PR read failed for #${issue.number}: ${error.message}`);
    candidate.hasOpenPullRequest = true;
  }
  return { ...candidate, parentStatus, dependencyNumbers: parseCandidateSections(issue).dependencyNumbers };
}

function validateWorkItemProposal({ issue, candidate, authority, stage, body, expectedBody, expectedUpdatedAt }) {
  const definition = STAGES[stage];
  const reasons = [...(authority.reasons || [])];
  if (!definition) return { ok: false, reasons: ["invalid-intake-stage"] };
  if (typeof body !== "string" || body.length > 20000 || typeof issue.body !== "string") {
    return { ok: false, reasons: ["invalid-proposal-body"] };
  }
  const cleanBody = stripReceipts(body);
  const fingerprint = hash(JSON.stringify([stage, issue.number, cleanBody]));
  const labels = normalizeLabels(issue.labels);
  if (issue.pull_request || issue.state !== "open" || !labels.includes(FACTORY_LABEL) ||
    labels.includes(GOAL_LABEL) || labels.includes(CONTROL_LABEL)) reasons.push("not-open-factory-work-item");
  if (issue.body !== expectedBody || issue.updated_at !== expectedUpdatedAt) reasons.push("stale-proposal");
  const lifecycle = labels.filter((label) => LIFECYCLE_STATE_VALUES.includes(label));
  if (lifecycle.length !== 1) reasons.push("conflicting-lifecycle-labels");
  if (labels.some((label) => BLOCKING_QUEUE_LABELS.includes(label))) reasons.push("blocked-by-label");
  if (lifecycle[0] !== definition.from ||
    !applyLifecycleTransition({ from: lifecycle[0], to: definition.to, actor: definition.actor }).allowed) {
    reasons.push("illegal-intake-transition");
  }
  const fields = inspectIssueForm(cleanBody, REQUIRED_WORK_ITEM_HEADINGS);
  reasons.push(...fields.reasons);
  const risk = getIssueFormSection(fields.sections, CANDIDATE_FORM_HEADINGS.risk);
  const priority = getIssueFormSection(fields.sections, CANDIDATE_FORM_HEADINGS.priority);
  const existingRisk = labels.filter((label) => RISK_TIER_LABELS.includes(label));
  if (!isKnownRiskTier(risk)) reasons.push("invalid-declared-risk");
  if (!PRIORITY_LABELS.includes(priority)) reasons.push("invalid-declared-priority");
  if (existingRisk.length > 1) reasons.push("conflicting-risk-labels");
  if (existingRisk.length === 1 && rankRiskTier(risk) < rankRiskTier(existingRisk[0])) reasons.push("risk-cannot-be-lowered");
  const proposedLabels = labels.filter((label) => !LIFECYCLE_STATE_VALUES.includes(label) &&
    !RISK_TIER_LABELS.includes(label) && !PRIORITY_LABELS.includes(label)).concat([definition.to, risk, priority].filter(Boolean));
  const parsed = parseCandidateSections({ ...issue, body: cleanBody, labels: proposedLabels }, authority.config?.goalNumber);
  const original = parseCandidateSections(issue);
  const scopeEvidence = resolveGoalScopeEvidence(authority.goalIssue?.body, issue, cleanBody);
  reasons.push(...scopeEvidence.reasons.filter((reason) =>
    reason !== "scope-source-provenance-unverified" || candidate.scopeSourceVerified !== true));
  const signalMarkers = Array.from(issue.body.matchAll(/<!-- factory-signal[^]*? -->/g), (match) => match[0]);
  if (signalMarkers.some((marker) => !cleanBody.includes(marker))) reasons.push("source-evidence-not-preserved");
  if (original.parentGoalNumber !== authority.config?.goalNumber || parsed.parentGoalNumber !== original.parentGoalNumber) reasons.push("parent-goal-mismatch");
  if (original.allowedPaths.length && !areAllowedPathPatternsWithin(parsed.allowedPaths, original.allowedPaths)) reasons.push("proposal-widens-existing-scope");
  if (parsed.allowedPaths.some((path) => rankRiskTier(classifyPathTier(path)) > rankRiskTier(risk))) reasons.push("risk-below-path-floor");
  if (risk === "risk:boundary") reasons.push("risk-boundary-requires-human");
  if (candidate.parentStatus === "unknown") reasons.push("native-parent-unknown");
  if (candidate.parentStatus === "present" && candidate.nativeParentGoalNumber !== authority.config?.goalNumber) reasons.push("native-parent-mismatch");
  if (parsed.milestone && parsed.milestone !== authority.config?.goalMilestone) reasons.push("milestone-conflict");
  const createLeaf = stage === "pm" && (cleanBody !== stripReceipts(issue.body) || !parsed.milestone || candidate.parentStatus === "absent");
  if (createLeaf && authority.config?.goalScopeAnchors?.length &&
    !authority.config.goalScopeAnchors.includes(issue.number)) reasons.push("derived-scope-revision-requires-anchor-planning");
  if (stage === "em" && (cleanBody !== stripReceipts(issue.body) || !parsed.milestone || candidate.parentStatus !== "present")) {
    reasons.push("immutable-work-item-revision-required");
  }
  // Changing dependency references requires a fresh enriched candidate, never inherited states.
  if (JSON.stringify(parsed.dependencyNumbers) !== JSON.stringify(candidate.dependencyNumbers)) reasons.push("dependency-evidence-mismatch");
  const projected = {
    ...candidate, ...parsed, number: issue.number,
    labels: proposedLabels.filter((label) => label !== definition.to).concat(QUEUE_READY_LABEL),
    milestone: authority.config?.goalMilestone,
    parentGoalApproved: authority.ok && parsed.parentGoalNumber === authority.config?.goalNumber &&
      (candidate.parentStatus === "absent" || candidate.nativeParentGoalNumber === authority.config?.goalNumber),
  };
  reasons.push(...evaluateEligibility(projected, authority.config));
  return {
    ok: reasons.length === 0, reasons: [...new Set(reasons)],
    plan: {
      body: cleanBody,
      labels: proposedLabels, milestone: authority.goalIssue?.milestone?.number,
      createLeaf, fingerprint,
      scopeSourceIssue: scopeEvidence.sourceIssue,
    },
  };
}

function sameOwnedSnapshot(left, right) {
  return ["body", "title", "state"].every((field) => left[field] === right[field]) &&
    ["labels", "assignees", "milestone"].every((field) => JSON.stringify(left[field]) === JSON.stringify(right[field]));
}

async function applySelectiveLabels({ github, owner, repo, issue, labels }) {
  const original = normalizeLabels(issue.labels);
  const removable = original.filter((label) => !labels.includes(label) &&
    (LIFECYCLE_STATE_VALUES.includes(label) || RISK_TIER_LABELS.includes(label) || PRIORITY_LABELS.includes(label)));
  if (removable.some((label) => BLOCKING_QUEUE_LABELS.includes(label))) throw new Error("Cannot clear a human-owned hard stop");
  await github.rest.issues.addLabels({ owner, repo, issue_number: issue.number, labels: labels.filter((label) => !original.includes(label)) });
  // Selective removal cannot erase a concurrently added hard stop, unlike replacing all labels.
  for (const name of removable) {
    try {
      await github.rest.issues.removeLabel({ owner, repo, issue_number: issue.number, name });
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
}

function parseReceipts(comments, pattern, kind) {
  const records = [];
  for (const comment of comments) {
    for (const match of (comment.body || "").matchAll(pattern)) {
      const parsed = parseMachineReceipt(comment, kind);
      if (!parsed) throw new Error(`Untrusted, wrapped or edited intake receipt: ${match[0].slice(0, 35)}`);
      records.push(parsed);
    }
  }
  return records;
}

function resolveIntakeTarget(context) {
  const inputs = context.payload?.inputs || {};
  const candidates = [];
  if (context.payload?.issue?.number !== undefined) candidates.push(context.payload.issue.number);
  for (const value of [inputs.issue, inputs.scope]) {
    if (value === undefined || value === "") continue;
    if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null;
    candidates.push(Number(value));
  }
  if (inputs.aw_context) {
    let supplied;
    try { supplied = JSON.parse(inputs.aw_context); } catch { return null; }
    if (supplied?.item_type !== "issue") return null;
    candidates.push(supplied.item_number);
  }
  if (!candidates.length || candidates.some((number) => !Number.isSafeInteger(number) || number <= 0 || number !== candidates[0])) return null;
  return candidates[0];
}

async function applyWorkItemProposal({ github, context, core, stage, proposal, now, dryRun = false }) {
  const { owner, repo } = context.repo;
  const target = resolveIntakeTarget(context);
  if (!Number.isSafeInteger(target) || target <= 0 || proposal.issue !== target) return { ok: false, reasons: ["proposal-target-mismatch"] };
  const authority = await loadIntakeAuthority({ github, context, core, now });
  if (!authority.ok) return authority;
  let issueResponse;
  try {
    issueResponse = await github.rest.issues.get({ owner, repo, issue_number: target });
  } catch (error) {
    core.warning(`Intake issue read failed: ${error.message}`);
    return { ok: false, reasons: ["issue-read-failed"] };
  }
  const issue = issueResponse.data;
  if (!STAGES[stage] || typeof proposal.body !== "string") return { ok: false, reasons: ["invalid-proposal"] };
  const fingerprint = hash(JSON.stringify([stage, target, stripReceipts(proposal.body)]));
  try {
    const comments = await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: target, per_page: 100 });
    if (!Array.isArray(comments)) throw new Error("Missing receipt list");
    const reservations = parseReceipts(comments, RECEIPT, "reservation").filter((item) => item.stage === stage);
    if (reservations.length) {
      const results = parseReceipts(comments, RESULT_RECEIPT, "result").filter((item) => item.stage === stage && item.fingerprint === fingerprint);
      if (reservations.length !== 1 || reservations[0].fingerprint !== fingerprint) return { ok: false, reasons: ["intake-already-reserved-different-proposal"] };
      if (results.length === 1 && results[0].completed === true) {
        return { ok: true, replayed: true, applied: false, dispatched: false, issue: results[0].issue, handoff: "previously-recorded" };
      }
      return { ok: false, reasons: ["intake-reservation-unresolved-human-recovery"], fingerprint, evidence: results };
    }
  } catch (error) {
    core.warning(`Intake receipt read failed: ${error.message}`);
    return { ok: false, reasons: ["intake-receipt-unverifiable"] };
  }
  const proposedIssue = { ...issue, body: proposal.body };
  const candidate = await readIntakeCandidate({ github, context, core, issue: proposedIssue, activeGoalNumber: authority.config.goalNumber });
  candidate.dependencyNumbers = parseCandidateSections(proposedIssue).dependencyNumbers;
  const validation = validateWorkItemProposal({
    issue, candidate, authority, stage, body: proposal.body, expectedBody: proposal.expected_body, expectedUpdatedAt: proposal.expected_updated_at,
  });
  if (!validation.ok) return validation;
  if (dryRun || authority.mode !== "active") return { ok: true, advisory: true, applied: false, plan: validation.plan };
  let materialized = issue;
  let reserved = false;
  try {
    const freshAuthority = await loadIntakeAuthority({ github, context, core, now });
    const fresh = await github.rest.issues.get({ owner, repo, issue_number: target });
    if (!freshAuthority.ok || freshAuthority.revision !== authority.revision ||
      fresh.data.updated_at !== issue.updated_at || !sameOwnedSnapshot(fresh.data, issue)) {
      return { ok: false, reasons: ["concurrent-intake-change"] };
    }
    await github.rest.issues.createComment({
      owner, repo, issue_number: target,
      body: formatMachineReceipt("reservation", { stage, fingerprint, sourceIssue: target, state: "reserved" }),
    });
    reserved = true;
    if (validation.plan.createLeaf) {
      let body = validation.plan.body;
      if (validation.plan.scopeSourceIssue && !/^Scope source:/m.test(body)) {
        const heading = `### ${CANDIDATE_FORM_HEADINGS.context}`;
        const provenance = `Scope source: #${validation.plan.scopeSourceIssue}`;
        body = body.includes(heading) ? body.replace(heading, `${heading}\n\n${provenance}`) : `${body}\n\n${heading}\n\n${provenance}`;
      }
      const sourceFingerprint = /<!-- factory-signal:v1 ([a-f0-9]{64}) -->/.exec(issue.body)?.[1] || null;
      const created = await github.rest.issues.create({
        owner, repo, title: `[plan] ${issue.title}`.slice(0, 240),
        body: `<!-- factory-intake-leaf:v1 ${JSON.stringify({ sourceIssue: target, sourceFingerprint, fingerprint })} -->\n\n${body}`,
        labels: validation.plan.labels.filter((label) => !LIFECYCLE_STATE_VALUES.includes(label)).concat("needs-triage"),
        milestone: validation.plan.milestone,
      });
      materialized = created.data;
      if (!Number.isSafeInteger(materialized?.id) || !Number.isSafeInteger(materialized?.number)) throw new Error("Created leaf response is incomplete");
      await github.request("POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues", {
        owner, repo, issue_number: authority.config.goalNumber, sub_issue_id: materialized.id, replace_parent: false,
      });
    }
    const parent = await github.request("GET /repos/{owner}/{repo}/issues/{issue_number}/parent", { owner, repo, issue_number: materialized.number });
    if (!nativeParentMatchesRepository(parent.data, owner, repo) || parent.data.number !== authority.config.goalNumber) {
      return { ok: false, reasons: ["native-parent-verification-failed"] };
    }
    const source = await github.rest.issues.get({ owner, repo, issue_number: target });
    if (!sameOwnedSnapshot(source.data, issue)) return { ok: false, reasons: ["concurrent-intake-change"], reserved };
    await applySelectiveLabels({ github, owner, repo, issue: materialized, labels: validation.plan.labels });
    const verified = await github.rest.issues.get({ owner, repo, issue_number: materialized.number });
    if (verified.data.body !== materialized.body ||
      JSON.stringify(normalizeLabels(verified.data.labels).sort()) !== JSON.stringify([...validation.plan.labels].sort()) ||
      verified.data.milestone?.number !== validation.plan.milestone) {
      return { ok: false, reasons: ["intake-write-verification-failed"], reserved };
    }
  } catch (error) {
    core.warning(`Intake application failed for #${target}: ${error.message}`);
    return { ok: false, reserved, reasons: [error.status === 403 ? "intake-permission-denied" : "intake-write-failed-human-recovery"] };
  }
  if (stage === "pm") {
    try {
      const repository = await github.rest.repos.get({ owner, repo });
      await github.rest.actions.createWorkflowDispatch({
        owner, repo, workflow_id: "em-planning.lock.yml", ref: repository.data.default_branch,
        inputs: { scope: String(materialized.number), aw_context: JSON.stringify({ item_type: "issue", item_number: materialized.number }) },
      });
    } catch (error) {
      core.warning(`Intake handoff for #${target} was reserved but delivery is uncertain: ${error.message}`);
      return { ok: false, applied: true, reasons: ["handoff-delivery-uncertain-human-recovery"], dispatched: false };
    }
  }
  try {
    await github.rest.issues.createComment({
      owner, repo, issue_number: target,
      body: formatMachineReceipt("result", { stage, fingerprint, issue: materialized.number, bodySha256: hash(materialized.body), completed: true, dispatched: stage === "pm" }),
    });
  } catch (error) {
    core.warning(`Intake result persistence failed: ${error.message}`);
    return { ok: false, applied: true, reasons: ["intake-result-unrecorded-human-recovery"], dispatched: stage === "pm" };
  }
  return { ok: true, applied: true, dispatched: stage === "pm", issue: materialized.number };
}

async function runIntakeSafeOutput({ github, context, core, stage, output }) {
  const items = Array.isArray(output?.items) ? output.items.filter((item) => item.type === "apply_work_item") : [];
  if (items.length !== 1) {
    core.setFailed("Intake requires exactly one apply_work_item proposal.");
    return { ok: false, reasons: ["invalid-proposal-count"] };
  }
  const result = await applyWorkItemProposal({ github, context, core, stage, proposal: items[0] });
  await core.summary.addRaw(`## Bounded intake\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``).write();
  if (!result.ok) core.setFailed(`Intake refused: ${result.reasons.join(", ")}`);
  return result;
}

module.exports = { STAGES, loadIntakeAuthority, readIntakeCandidate, validateWorkItemProposal, applySelectiveLabels, resolveIntakeTarget, applyWorkItemProposal, runIntakeSafeOutput };
