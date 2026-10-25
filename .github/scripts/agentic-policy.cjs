"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_POLICY_PATH = path.join(
  __dirname,
  "..",
  "agentic-policy.json",
);

function invalid(message) {
  throw new Error(`Invalid agentic policy: ${message}`);
}

function object(value, location) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${location} must be an object`);
  }
  return value;
}

function exactKeys(value, expected, location) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    invalid(`${location} keys must be exactly: ${wanted.join(", ")}`);
  }
}

function string(value, location) {
  if (typeof value !== "string" || value.length === 0) {
    invalid(`${location} must be a non-empty string`);
  }
  return value;
}

function positiveInteger(value, location) {
  if (!Number.isInteger(value) || value <= 0) {
    invalid(`${location} must be a positive integer`);
  }
  return value;
}

function boolean(value, location) {
  if (typeof value !== "boolean") {
    invalid(`${location} must be a boolean`);
  }
  return value;
}

function strings(value, location, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    invalid(`${location} must be ${allowEmpty ? "an" : "a non-empty"} array`);
  }
  const result = value.map((entry, index) =>
    string(entry, `${location}[${index}]`),
  );
  if (new Set(result).size !== result.length) {
    invalid(`${location} must not contain duplicates`);
  }
  return Object.freeze(result);
}

function patterns(value, location) {
  return strings(value, location, { allowEmpty: true }).map(
    (source, index) => {
      if (!source.startsWith("^")) {
        invalid(`${location}[${index}] must be anchored at the path root`);
      }
      try {
        return new RegExp(source);
      } catch (error) {
        invalid(`${location}[${index}] is not a valid regular expression`);
      }
    },
  );
}

function loadAgenticPolicy(policyPath = DEFAULT_POLICY_PATH) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(policyPath, "utf8"));
  } catch (error) {
    invalid(`cannot read ${policyPath}: ${error.message}`);
  }

  const root = object(parsed, "root");
  exactKeys(
    root,
    [
      "schemaVersion",
      "autonomy",
      "merge",
      "identities",
      "labels",
      "conclusions",
      "lowRiskDocs",
      "specialistRouting",
      "selfHeal",
      "productionDelivery",
      "wip",
      "authority",
    ],
    "root",
  );
  if (root.schemaVersion !== 1) {
    invalid("schemaVersion must be 1");
  }

  const autonomy = object(root.autonomy, "autonomy");
  exactKeys(autonomy, [
    "enabled", "goalTitle", "milestone", "objective", "allowedPaths",
    "maxRiskTier", "maxActiveAssignments", "maxAssignmentsPerDay", "tradingResearch",
  ], "autonomy");
  const research = object(autonomy.tradingResearch, "autonomy.tradingResearch");
  exactKeys(research, ["market", "startingCapitalUSD", "targetDailyNetProfitUSD", "paperOnly", "allowLeverage"], "autonomy.tradingResearch");
  if (research.market !== "ETH/USDC" || research.paperOnly !== true || research.allowLeverage !== false) {
    invalid("autonomy.tradingResearch must remain unleveraged ETH/USDC paper evaluation");
  }
  const tradingResearch = Object.freeze({
    market: research.market,
    startingCapitalUSD: positiveInteger(research.startingCapitalUSD, "autonomy.tradingResearch.startingCapitalUSD"),
    targetDailyNetProfitUSD: positiveInteger(research.targetDailyNetProfitUSD, "autonomy.tradingResearch.targetDailyNetProfitUSD"),
    paperOnly: true,
    allowLeverage: false,
  });
  const allowedPaths = strings(autonomy.allowedPaths, "autonomy.allowedPaths");
  for (const scope of allowedPaths) {
    const segments = scope.split("/");
    if (scope.startsWith("/") || scope.includes("\\") || scope.includes(":") ||
        segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
        /[?[\]{}]/.test(scope) ||
        (scope.includes("*") && (!scope.endsWith("/**") || scope.slice(0, -3).includes("*")))) {
      invalid("autonomy.allowedPaths must contain exact relative files or terminal directory/** patterns");
    }
  }
  if (!["risk:routine", "risk:sensitive", "risk:boundary"].includes(autonomy.maxRiskTier)) {
    invalid("autonomy.maxRiskTier must be a known risk tier");
  }
  const maxActiveAssignments = positiveInteger(autonomy.maxActiveAssignments, "autonomy.maxActiveAssignments");
  if (maxActiveAssignments > 2) {
    invalid("autonomy.maxActiveAssignments must not exceed 2");
  }
  const autonomousDelivery = Object.freeze({
    enabled: boolean(autonomy.enabled, "autonomy.enabled"),
    goalTitle: string(autonomy.goalTitle, "autonomy.goalTitle"),
    milestone: string(autonomy.milestone, "autonomy.milestone"),
    objective: string(autonomy.objective, "autonomy.objective"),
    tradingResearch,
    allowedPaths,
    maxRiskTier: autonomy.maxRiskTier,
    maxActiveAssignments,
    maxAssignmentsPerDay: positiveInteger(autonomy.maxAssignmentsPerDay, "autonomy.maxAssignmentsPerDay"),
  });

  const merge = object(root.merge, "merge");
  exactKeys(
    merge,
    [
      "requiredContexts",
      "reviewCheck",
      "securityCheck",
      "tradingSafetyCheck",
    ],
    "merge",
  );
  const identities = object(root.identities, "identities");
  exactKeys(
    identities,
    [
      "copilotSuggestedActorLogin",
      "copilotBotNodeId",
      "copilotBotDatabaseId",
      "trustedAgentAuthors",
      "trustedReviewAssociations",
    ],
    "identities",
  );
  const labels = object(root.labels, "labels");
  exactKeys(
    labels,
    [
      "autoMerge",
      "blocked",
      "selfHealExhausted",
      "mergeBlocking",
      "selfHealBlocking",
    ],
    "labels",
  );
  const conclusions = object(root.conclusions, "conclusions");
  exactKeys(conclusions, ["failing", "passingChecks"], "conclusions");
  const lowRiskDocs = object(root.lowRiskDocs, "lowRiskDocs");
  exactKeys(
    lowRiskDocs,
    ["statuses", "pathPattern", "sensitiveTokenPattern"],
    "lowRiskDocs",
  );
  const specialistRouting = object(
    root.specialistRouting,
    "specialistRouting",
  );
  exactKeys(
    specialistRouting,
    ["security", "tradingSafety"],
    "specialistRouting",
  );
  const security = object(
    specialistRouting.security,
    "specialistRouting.security",
  );
  exactKeys(
    security,
    ["exactPaths", "patterns"],
    "specialistRouting.security",
  );
  const tradingSafety = object(
    specialistRouting.tradingSafety,
    "specialistRouting.tradingSafety",
  );
  exactKeys(
    tradingSafety,
    ["exactPaths", "patterns"],
    "specialistRouting.tradingSafety",
  );
  const selfHeal = object(root.selfHeal, "selfHeal");
  exactKeys(
    selfHeal,
    ["maxRepairCommits", "nonRepairableReviewConclusions"],
    "selfHeal",
  );
  const wip = object(root.wip, "wip");
  const production = object(root.productionDelivery, "productionDelivery");
  exactKeys(production, ["maxDeferredRetries", "retryDelayMinutes", "evidenceTimeoutMinutes"], "productionDelivery");
  for (const key of Object.keys(production)) positiveInteger(production[key], `productionDelivery.${key}`);
  if (production.maxDeferredRetries > 2 || production.retryDelayMinutes < 15 ||
      production.retryDelayMinutes > 60 || production.evidenceTimeoutMinutes > 360 ||
      production.evidenceTimeoutMinutes <= production.retryDelayMinutes) {
    invalid("productionDelivery must retain bounded retries, a 15-60 minute delay and at most six hours of evidence waiting");
  }
  exactKeys(wip, ["maxOpenActionableOpportunities"], "wip");
  const authority = object(root.authority, "authority");
  exactKeys(
    authority,
    ["forksRequireHumanApproval", "humanOnly", "paperOnly"],
    "authority",
  );
  if (authority.paperOnly !== true) {
    invalid("authority.paperOnly must be true: every environment is permanently paper-only");
  }

  const lowRiskPathSource = string(
    lowRiskDocs.pathPattern,
    "lowRiskDocs.pathPattern",
  );
  if (!lowRiskPathSource.startsWith("^") || !lowRiskPathSource.endsWith("$")) {
    invalid("lowRiskDocs.pathPattern must be anchored at both ends");
  }
  const sensitiveTokenSource = string(
    lowRiskDocs.sensitiveTokenPattern,
    "lowRiskDocs.sensitiveTokenPattern",
  );
  if (
    !sensitiveTokenSource.startsWith("(^|/)") ||
    !sensitiveTokenSource.endsWith("(/|[-_.])")
  ) {
    invalid(
      "lowRiskDocs.sensitiveTokenPattern must enforce path-token boundaries",
    );
  }

  let lowRiskPathPattern;
  let sensitiveTokenPattern;
  try {
    lowRiskPathPattern = new RegExp(lowRiskPathSource, "i");
    sensitiveTokenPattern = new RegExp(sensitiveTokenSource, "i");
  } catch {
    invalid("low-risk documentation patterns must be valid regular expressions");
  }

  return Object.freeze({
    schemaVersion: 1,
    autonomy: autonomousDelivery,
    productionDelivery: Object.freeze({ ...production }),
    policyPath,
    requiredContexts: strings(
      merge.requiredContexts,
      "merge.requiredContexts",
    ),
    reviewCheckName: string(merge.reviewCheck, "merge.reviewCheck"),
    securityCheckName: string(
      merge.securityCheck,
      "merge.securityCheck",
    ),
    tradingSafetyCheckName: string(
      merge.tradingSafetyCheck,
      "merge.tradingSafetyCheck",
    ),
    copilotSuggestedActorLogin: string(
      identities.copilotSuggestedActorLogin,
      "identities.copilotSuggestedActorLogin",
    ),
    copilotBotNodeId: string(identities.copilotBotNodeId, "identities.copilotBotNodeId"),
    copilotBotDatabaseId: positiveInteger(identities.copilotBotDatabaseId, "identities.copilotBotDatabaseId"),
    trustedAgentAuthors: new Set(
      strings(
        identities.trustedAgentAuthors,
        "identities.trustedAgentAuthors",
      ),
    ),
    trustedReviewAssociations: new Set(
      strings(
        identities.trustedReviewAssociations,
        "identities.trustedReviewAssociations",
      ),
    ),
    autoMergeLabel: string(labels.autoMerge, "labels.autoMerge"),
    blockedLabel: string(labels.blocked, "labels.blocked"),
    exhaustedLabel: string(
      labels.selfHealExhausted,
      "labels.selfHealExhausted",
    ),
    mergeBlockingLabels: new Set(
      strings(labels.mergeBlocking, "labels.mergeBlocking"),
    ),
    selfHealBlockingLabels: new Set(
      strings(labels.selfHealBlocking, "labels.selfHealBlocking"),
    ),
    failingConclusions: new Set(
      strings(conclusions.failing, "conclusions.failing"),
    ),
    passingCheckConclusions: new Set(
      strings(conclusions.passingChecks, "conclusions.passingChecks"),
    ),
    lowRiskStatuses: new Set(
      strings(lowRiskDocs.statuses, "lowRiskDocs.statuses"),
    ),
    lowRiskPathPattern,
    sensitiveTokenPattern,
    securityExactPaths: new Set(
      strings(
        security.exactPaths,
        "specialistRouting.security.exactPaths",
        { allowEmpty: true },
      ),
    ),
    securityPathPatterns: patterns(
      security.patterns,
      "specialistRouting.security.patterns",
    ),
    tradingSafetyExactPaths: new Set(
      strings(
        tradingSafety.exactPaths,
        "specialistRouting.tradingSafety.exactPaths",
        { allowEmpty: true },
      ),
    ),
    tradingSafetyPathPatterns: patterns(
      tradingSafety.patterns,
      "specialistRouting.tradingSafety.patterns",
    ),
    maxRepairCommits: positiveInteger(
      selfHeal.maxRepairCommits,
      "selfHeal.maxRepairCommits",
    ),
    nonRepairableReviewConclusions: new Set(
      strings(
        selfHeal.nonRepairableReviewConclusions,
        "selfHeal.nonRepairableReviewConclusions",
      ),
    ),
    maxOpenActionableOpportunities: positiveInteger(
      wip.maxOpenActionableOpportunities,
      "wip.maxOpenActionableOpportunities",
    ),
    forksRequireHumanApproval: boolean(
      authority.forksRequireHumanApproval,
      "authority.forksRequireHumanApproval",
    ),
    humanOnlyAuthority: strings(
      authority.humanOnly,
      "authority.humanOnly",
    ),
    paperOnly: boolean(authority.paperOnly, "authority.paperOnly"),
  });
}

const AGENTIC_POLICY = loadAgenticPolicy();

module.exports = {
  AGENTIC_POLICY,
  DEFAULT_POLICY_PATH,
  loadAgenticPolicy,
};
