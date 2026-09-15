"use strict";

const crypto = require("node:crypto");
const policy = require("../../.github/scripts/agentic-factory-policy.cjs");
const runtime = require("../../.github/scripts/agentic-queue-runtime.cjs");
const queue = require("../../.github/scripts/agentic-queue-controller.cjs");
const { stableStringify } = require("./collect-factory-health.cjs");

const SCHEMA_VERSION = 1;
const MAX_AGE_MS = 24 * 3600000;
const SOURCE_KINDS = ["workflow-run", "entropy-rule", "repository-test", "human-feedback"];

function fingerprintFor(source) {
  return crypto.createHash("sha256").update(`${source.kind}:${source.key}`).digest("hex");
}

function text(value, max = 2000) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]|<!--|^#{1,6}\s/m.test(value);
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => key in value);
}

function validateSignal(signal, { now, repository }) {
  const reasons = [];
  if (!exactKeys(signal, ["schemaVersion", "fingerprint", "source", "observedAt", "severity", "evidenceRefs", "completeness", "summary"]) ||
      signal.schemaVersion !== SCHEMA_VERSION) return ["invalid-signal-schema"];
  const source = signal.source;
  if (!exactKeys(source, ["kind", "key", "ref", "sha", "windowStart", "windowEnd"]) ||
      !SOURCE_KINDS.includes(source.kind) || !text(source.key, 200) ||
      !/^[a-f0-9]{40}$/.test(source.sha || "")) return ["invalid-signal-source"];
  if (signal.fingerprint !== fingerprintFor(source)) reasons.push("invalid-fingerprint");
  if (!["info", "warning", "error", "critical"].includes(signal.severity) || !text(signal.summary)) reasons.push("invalid-signal-content");
  if (signal.completeness !== "complete") reasons.push("incomplete-signal");
  const observed = Date.parse(signal.observedAt);
  const start = Date.parse(source.windowStart);
  const end = Date.parse(source.windowEnd);
  const clock = Date.parse(now);
  if (![observed, start, end, clock].every(Number.isFinite) || start >= end ||
      end > observed || observed > clock + 300000 || clock - observed > MAX_AGE_MS ||
      clock - end > MAX_AGE_MS || end - start > 7 * 86400000) reasons.push("stale-or-invalid-window");
  const validRef = (ref) => typeof ref === "string" && ref.length <= 1000 &&
    ref.startsWith(`https://github.com/${repository}/`) &&
    !/[\s<>@]/.test(ref) && /^https:\/\/github\.com\/[^/]+\/[^/]+\/(?:actions\/runs\/\d+(?:\/|$)|issues\/\d+(?:#|$)|blob\/[a-f0-9]{40}\/)/.test(ref);
  if (!validRef(source.ref) || !Array.isArray(signal.evidenceRefs) ||
      signal.evidenceRefs.length < 1 || signal.evidenceRefs.length > 10 ||
      !signal.evidenceRefs.every(validRef)) reasons.push("invalid-evidence-refs");
  return reasons;
}

function validateProposal(proposal) {
  if (!exactKeys(proposal, [
    "goalNumber", "scopeIssueNumber", "title", "riskTier", "allowedPaths", "dependencyNumbers",
    "hypothesis", "baseline", "oracle", "rollback", "expectedOutcome", "scope", "nonGoals",
    "acceptanceCriteria", "validationPlan",
  ])) return ["invalid-proposal-schema"];
  const reasons = [];
  if (![proposal.goalNumber, proposal.scopeIssueNumber].every((number) => Number.isSafeInteger(number) && number > 0)) {
    reasons.push("invalid-goal-lineage");
  }
  for (const field of ["title", "hypothesis", "rollback", "expectedOutcome", "scope", "nonGoals", "acceptanceCriteria", "validationPlan"]) {
    if (!text(proposal[field], field === "title" ? 160 : 2000)) reasons.push(`invalid-proposal-${field}`);
  }
  if (!Array.isArray(proposal.allowedPaths) || proposal.allowedPaths.length < 1 || proposal.allowedPaths.length > 20 ||
      !proposal.allowedPaths.every((value) => typeof value === "string" && /^[\w./-]+$/.test(value) &&
        !value.startsWith("/") && !value.split("/").some((part) => ["", ".", ".."].includes(part)))) {
    reasons.push("invalid-proposal-paths");
  }
  if (!Array.isArray(proposal.dependencyNumbers) || proposal.dependencyNumbers.length > 10 ||
      !proposal.dependencyNumbers.every((number) => Number.isSafeInteger(number) && number > 0)) reasons.push("invalid-proposal-dependencies");
  if (!policy.isKnownRiskTier(proposal.riskTier)) reasons.push("invalid-proposal-risk");
  for (const field of ["baseline", "oracle"]) {
    const metric = proposal[field];
    if (!exactKeys(metric, ["metric", "value", "unit", "evidenceRef"]) || !text(metric.metric, 100) ||
        !text(metric.unit, 40) || !Number.isFinite(metric.value) || !text(metric.evidenceRef, 1000)) {
      reasons.push(`invalid-${field}`);
    }
  }
  if (proposal.baseline?.metric !== proposal.oracle?.metric || proposal.baseline?.unit !== proposal.oracle?.unit ||
      proposal.baseline?.evidenceRef === proposal.oracle?.evidenceRef) reasons.push("missing-independent-oracle");
  return reasons;
}

function proposalBody(signal, proposal) {
  const section = (heading, value) => `### ${heading}\n\n${value.replace(/@/g, "&#64;")}`;
  return [
    section("Work type", "product-triage"),
    section("Approved parent goal", `#${proposal.goalNumber}`),
    section("Problem or goal", proposal.hypothesis),
    section("Scope and non-goals", `${proposal.scope}\n\nNon-goals: ${proposal.nonGoals}`),
    section("Allowed paths", proposal.allowedPaths.join("\n")),
    section("Risk tier", proposal.riskTier),
    section("Priority", "priority:P1"),
    section("Dependencies", proposal.dependencyNumbers.length ? proposal.dependencyNumbers.map((number) => `#${number}`).join("\n") : "None"),
    section("Acceptance criteria", proposal.acceptanceCriteria),
    section("Validation plan", proposal.validationPlan),
    section("Rollback or safe reversal", proposal.rollback),
    section("Context, links, or constraints", [
      `<!-- factory-signal:v1 ${signal.fingerprint} -->`,
      `Scope source: #${proposal.scopeIssueNumber}`,
      `Observed: ${signal.observedAt}; source SHA: ${signal.source.sha}.`,
      `Hypothesis: ${proposal.hypothesis}`,
      `Baseline: ${stableStringify(proposal.baseline)}`,
      `Independent oracle: ${stableStringify(proposal.oracle)}`,
      `Expected outcome: ${proposal.expectedOutcome}`,
      `Evidence: ${signal.evidenceRefs.join("\n")}`,
      "Admission is not readiness, completion, trading edge, or authority to change goals/policy.",
      `<!-- factory-signal-evidence:v1 ${Buffer.from(JSON.stringify({ signal, proposal })).toString("base64")} -->`,
    ].join("\n\n")),
  ].join("\n\n");
}

function preflight({ signal, proposal, observation, nativeScopeParent, dependencyStates, now, repository }) {
  const reasons = [...validateSignal(signal, { now, repository }), ...validateProposal(proposal)];
  if (reasons.length) return { eligible: false, reasons };
  const { state, issues } = observation;
  if (Object.values(observation.sources).some((value) => value.completeness !== "complete")) reasons.push("source-incomplete");
  const duplicates = issues.filter((issue) => (issue.body || "").includes(`<!-- factory-signal:v1 ${signal.fingerprint} -->`));
  if (duplicates.length) reasons.push("duplicate-signal");
  if (state.sha !== signal.source.sha) reasons.push("stale-source-sha");
  if (state.mode.mode !== "active") reasons.push(`factory-${state.mode.mode}`);
  const goal = state.goals.active;
  if (!signal.evidenceRefs.includes(proposal.baseline.evidenceRef) ||
      !proposal.oracle.evidenceRef.startsWith(`https://github.com/${repository}/blob/${signal.source.sha}/tests/`)) {
    reasons.push("oracle-or-baseline-not-evidence-bound");
  }
  if (!goal || goal.number !== proposal.goalNumber || state.goals.resolution !== "ok") reasons.push("goal-not-authorized");
  const scope = issues.find((issue) => issue.number === proposal.scopeIssueNumber && !issue.pull_request);
  if (!scope || nativeScopeParent !== proposal.goalNumber || proposal.scopeIssueNumber === proposal.goalNumber) {
    reasons.push("scope-not-direct-goal-work");
  }
  if (scope && runtime.normalizeLabels(scope.labels).includes(runtime.BLOCKED_LABEL)) reasons.push("scope-work-blocked");
  if (scope && scope.state !== "open") reasons.push("scope-work-not-open");
  if (goal) {
    const goalIssue = issues.find((issue) => issue.number === goal.number);
    const sections = runtime.extractIssueFormSections(goalIssue?.body);
    const boundedScope = [
      runtime.getIssueFormSection(sections, "Objective"),
      runtime.getIssueFormSection(sections, "Allowed scope"),
    ].filter(Boolean).join("\n");
    const authorizedReferences = [...boundedScope.matchAll(/#(\d+)\b/g)].map((match) => Number(match[1]));
    if (!authorizedReferences.includes(proposal.scopeIssueNumber)) reasons.push("goal-scope-not-explicitly-authorized");
    const risk = policy.determineRiskTier({
      files: proposal.allowedPaths.map((filename) => ({ filename, status: "modified" })),
      issueRiskLabel: proposal.riskTier,
    });
    if (risk.tier !== proposal.riskTier) reasons.push("risk-below-path-floor");
    if (proposal.riskTier === policy.RISK_TIERS.BOUNDARY) reasons.push("boundary-requires-human-work");
    const body = proposalBody(signal, proposal);
    // This is a hypothetical readiness check only. No ready label is persisted.
    const parsed = runtime.parseCandidateSections({ number: 1, body, labels: [proposal.riskTier] }, goal.number);
    const projected = {
      ...parsed, number: 1, state: "open", isLeaf: true,
      labels: [policy.QUEUE_READY_LABEL, proposal.riskTier], milestone: goal.milestone,
      parentGoalNumber: goal.number, parentGoalApproved: true,
      allowedPaths: proposal.allowedPaths, dependencyStates, createdAt: now,
    };
    reasons.push(...queue.evaluateEligibility(projected, {
      factoryMode: state.mode.mode, goalApproved: true, goalNumber: goal.number,
      allowedMilestones: [goal.milestone], goalAllowedPaths: goal.goalAllowedPaths,
      maxGoalRiskTier: goal.maxGoalRiskTier, concurrencyLimit: Math.min(1, goal.concurrencyLimit),
      currentInFlightCount: state.capacity.inFlight === null || state.capacity.queued === null ? null
        : state.capacity.inFlight + state.capacity.queued,
      dailyBudgetLimit: goal.dailyBudgetLimit, currentBudgetUsed: state.capacity.budgetUsed, now,
    }));
  }
  if (!state.evalCapacity.available) reasons.push("evaluation-capacity-unavailable");
  if (state.blockReasons.includes("blocked-work") || state.blockReasons.includes("claim-recovery-required")) reasons.push("hard-stop");
  return { eligible: reasons.length === 0, reasons: [...new Set(reasons)].sort(), duplicateIssue: duplicates[0]?.number || null };
}

module.exports = { SCHEMA_VERSION, MAX_AGE_MS, SOURCE_KINDS, fingerprintFor, validateSignal, validateProposal, proposalBody, preflight };
