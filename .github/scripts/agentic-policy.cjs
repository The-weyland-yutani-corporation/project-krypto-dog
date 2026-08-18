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
      "merge",
      "identities",
      "labels",
      "conclusions",
      "lowRiskDocs",
      "specialistRouting",
      "selfHeal",
      "wip",
      "authority",
    ],
    "root",
  );
  if (root.schemaVersion !== 1) {
    invalid("schemaVersion must be 1");
  }

  const merge = object(root.merge, "merge");
  exactKeys(
    merge,
    [
      "context",
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
    ["trustedAgentAuthors", "trustedReviewAssociations"],
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
  exactKeys(wip, ["maxOpenActionableOpportunities"], "wip");
  const authority = object(root.authority, "authority");
  exactKeys(
    authority,
    ["forksRequireHumanApproval", "humanOnly", "paperOnly"],
    "authority",
  );

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
    policyPath,
    mergeContext: string(merge.context, "merge.context"),
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
