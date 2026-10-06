"use strict";

/**
 * Deterministic, dependency-free policy core for the safety-bounded
 * autonomous SDLC factory.
 *
 * This module is pure and side-effect free: it never calls GitHub, never
 * reads the filesystem, and never uses randomness or wall-clock time
 * implicitly (all "now" values are explicit inputs where relevant). It is
 * intended to be `require()`d directly by the reconciler, the queue
 * controller, and tests.
 *
 * Fail-closed rule: whenever inputs are missing, malformed, or unknown, the
 * result must be the most conservative (highest) risk tier or an explicit
 * "not allowed" result, never a silent pass-through.
 */

// ---------------------------------------------------------------------------
// Risk tiers
// ---------------------------------------------------------------------------

const RISK_TIERS = Object.freeze({
  ROUTINE: "risk:routine",
  SENSITIVE: "risk:sensitive",
  BOUNDARY: "risk:boundary",
});

const FACTORY_MODES = Object.freeze({
  SHADOW: "shadow",
  ACTIVE: "active",
  PAUSED: "paused",
});
const FACTORY_MODE_LABELS = Object.freeze({
  "factory-mode:shadow": FACTORY_MODES.SHADOW,
  "factory-mode:active": FACTORY_MODES.ACTIVE,
  "factory-mode:paused": FACTORY_MODES.PAUSED,
});

function resolveFactoryModeFromLabels(labels) {
  if (!Array.isArray(labels)) {
    return FACTORY_MODES.PAUSED;
  }
  const matches = labels
    .map((label) => (typeof label === "string" ? label : label && label.name))
    .filter((label) => Object.hasOwn(FACTORY_MODE_LABELS, label));
  if (matches.length !== 1) {
    return FACTORY_MODES.PAUSED;
  }
  return FACTORY_MODE_LABELS[matches[0]];
}

// Ordered from least to most conservative. Index is used for ranking/max.
const RISK_TIER_ORDER = Object.freeze([
  RISK_TIERS.ROUTINE,
  RISK_TIERS.SENSITIVE,
  RISK_TIERS.BOUNDARY,
]);

function rankRiskTier(tier) {
  return RISK_TIER_ORDER.indexOf(tier);
}

function isKnownRiskTier(tier) {
  return rankRiskTier(tier) !== -1;
}

function compareRiskTiers(left, right) {
  return rankRiskTier(left) - rankRiskTier(right);
}

// Returns the more conservative (higher-ranked) of two tiers. Unknown tiers
// are treated as boundary so callers cannot accidentally lower risk with a
// malformed value.
function maxRiskTier(left, right) {
  const leftRank = isKnownRiskTier(left) ? rankRiskTier(left) : rankRiskTier(RISK_TIERS.BOUNDARY);
  const rightRank = isKnownRiskTier(right) ? rankRiskTier(right) : rankRiskTier(RISK_TIERS.BOUNDARY);
  return leftRank >= rightRank ? (isKnownRiskTier(left) ? left : RISK_TIERS.BOUNDARY) : (isKnownRiskTier(right) ? right : RISK_TIERS.BOUNDARY);
}

// ---------------------------------------------------------------------------
// Minimum-risk path classification
// ---------------------------------------------------------------------------

// Keyword denylist mirrored from the merge-policy's low-risk docs allowlist:
// documentation touching any of these topics is never routine, even when it
// lives under docs/.
const SENSITIVE_DOC_KEYWORDS =
  /(^|\/)(agentic|auth|backup|database|deploy(?:ment)?|env|guardrails?|incident|migrations?|oncall|operator|policy|production|release|rollback|runbooks?|secrets?|security|trading|workflows?)(\/|[-_.]|$)/i;

const ROUTINE_PATTERNS = [
  // Frontend routes/pages/layouts, excluding API routes and the admin surface.
  /^src\/app\/(?!api\/|admin\/).*/,
  /^src\/components\//,
  /^src\/hooks\//,
  /^public\//,
  /^tests\/(?!.*(?:agent|auth|database|db|deploy|guardrail|migration|security|trading)).*/,
  /^scenarios\//,
  /^docs\/.*\.(md|png|jpe?g|gif|webp)$/i,
  /^(README|CHANGELOG)\.md$/i,
  /^LICENSE$/i,
];

function matchesRoutinePath(filename) {
  if (/^docs\//i.test(filename) && SENSITIVE_DOC_KEYWORDS.test(filename)) {
    return false;
  }
  return ROUTINE_PATTERNS.some((pattern) => pattern.test(filename));
}

// Reversible trading, guardrail, auth, DB/migrations, agent, deployment,
// dependency, and infra code: reviewable, but not a human-boundary gate.
const SENSITIVE_PATTERNS = [
  /^src\/trading\//,
  /^src\/guardrails\//,
  /^src\/agent\//,
  /^src\/tools\//,
  /^src\/backtest\//,
  /^src\/db\//,
  /^drizzle\//,
  /^supabase\/migrations\//,
  /^src\/deployment\//,
  /^src\/lib\//,
  /^src\/app\/api\//,
  /^src\/app\/admin\//,
  // Top-level framework wiring such as src/proxy.ts, src/instrumentation.ts.
  /^src\/[^/]+\.tsx?$/,
  /^tests\//,
  /^scripts\//,
  /^infra\//,
  /^supabase\/config\.toml$/,
  /^package(?:-lock)?\.json$/,
  /^(?:eslint|jest|next|postcss|drizzle)\.config\.[^/]+$/,
  /^tsconfig(?:\.[^/]+)?\.json$/,
  /^(?:components\.json|Dockerfile|\.dockerignore|\.gitignore|\.nvmrc)$/,
  /^docker-compose\.ya?ml$/,
  /^\.env(?:\..*)?$/,
  /^DESIGN\.md$/,
  // Canonical specifications are operational and architectural context.
  // Factory, governance, and any non-canonical proposal are elevated to
  // boundary separately.
  /^specs\//,
];

function matchesSensitivePath(filename) {
  return (
    SENSITIVE_PATTERNS.some((pattern) => pattern.test(filename)) ||
    (/^docs\//i.test(filename) && SENSITIVE_DOC_KEYWORDS.test(filename))
  );
}

// Control-plane, factory-governance, and human-boundary scope. Checked
// before routine/sensitive so it always wins on overlap.
const BOUNDARY_PATTERNS = [
  /^\.github\/workflows\//,
  /^\.github\/scripts\//,
  /^\.github\/agents\//,
  /^\.github\/skills\//,
  /^\.github\/CODEOWNERS$/i,
  /^\.github\/BACKLOG_GOVERNANCE\.md$/i,
  /^\.github\/copilot-instructions\.md$/i,
  /^docs\/agentic-(?:software-factory|workflows-map)\.md$/i,
  /^specs\/(?:factory|governance)\.md$/i,
  /^specs\/(?!product\.md$|operations\.md$|evaluation\.md$|factory\.md$|governance\.md$).+/i,
  // Branch/repo-policy docs, wherever they live.
  /(^|\/)(branch-protection|repo-policy)(\.|\/|$)/i,
  // Secrets/permissions/identity policy.
  /(^|\/)(secrets?|permissions?|identity)-policy(\.|\/|$)/i,
  /(^|\/)(iam|rbac)(\/|[-_.]|$)/i,
];

function matchesBoundaryPath(filename) {
  return BOUNDARY_PATTERNS.some((pattern) => pattern.test(filename));
}

/**
 * Classifies a single repo-relative path into a risk tier. Unknown/ambiguous
 * paths fail closed to boundary rather than defaulting to routine.
 *
 * @param {string} filename
 * @returns {string} one of RISK_TIERS
 */
function classifyPathTier(filename) {
  if (typeof filename !== "string" || filename.trim() === "") {
    return RISK_TIERS.BOUNDARY;
  }
  if (matchesBoundaryPath(filename)) {
    return RISK_TIERS.BOUNDARY;
  }
  if (matchesRoutinePath(filename)) {
    return RISK_TIERS.ROUTINE;
  }
  if (matchesSensitivePath(filename)) {
    return RISK_TIERS.SENSITIVE;
  }
  return RISK_TIERS.BOUNDARY;
}

function normalizeAllowedPathPatterns(value) {
  if (typeof value !== "string") {
    return { valid: false, patterns: [], reason: "allowed-paths-not-string" };
  }
  const patterns = value
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s+/, ""))
    .map((line) => line.replace(/^`|`$/g, ""))
    .filter(Boolean);
  if (patterns.length === 0) {
    return { valid: false, patterns: [], reason: "allowed-paths-empty" };
  }
  for (const pattern of patterns) {
    if (
      pattern.startsWith("/") ||
      pattern.includes("\\") ||
      pattern.split("/").includes("..") ||
      (pattern.includes("*") && !pattern.endsWith("/**")) ||
      pattern.slice(0, -3).includes("*")
    ) {
      return {
        valid: false,
        patterns: [],
        reason: `invalid-allowed-path:${pattern}`,
      };
    }
  }
  return { valid: true, patterns: [...new Set(patterns)] };
}

function isPathAllowed(filename, patterns) {
  if (
    typeof filename !== "string" ||
    filename.length === 0 ||
    !Array.isArray(patterns) ||
    patterns.length === 0
  ) {
    return false;
  }
  return patterns.some((pattern) => {
    if (pattern.endsWith("/**")) {
      const prefix = pattern.slice(0, -3);
      return filename === prefix || filename.startsWith(`${prefix}/`);
    }
    return filename === pattern;
  });
}

function areChangedFilesWithinAllowedPaths(files, patterns) {
  return (
    Array.isArray(files) &&
    files.length > 0 &&
    files.every((file) =>
      [file && file.filename, file && file.previous_filename]
        .filter(Boolean)
        .every((filename) => isPathAllowed(filename, patterns)),
    )
  );
}

function areAllowedPathPatternsWithin(childPatterns, parentPatterns) {
  if (
    !Array.isArray(childPatterns) ||
    childPatterns.length === 0 ||
    !Array.isArray(parentPatterns) ||
    parentPatterns.length === 0
  ) {
    return false;
  }
  return childPatterns.every((child) =>
    parentPatterns.some((parent) => {
      if (!parent.endsWith("/**")) {
        return child === parent;
      }
      const parentPrefix = parent.slice(0, -3);
      const childBase = child.endsWith("/**") ? child.slice(0, -3) : child;
      return (
        childBase === parentPrefix ||
        childBase.startsWith(`${parentPrefix}/`)
      );
    }),
  );
}

// ---------------------------------------------------------------------------
// Destructive migration detection
// ---------------------------------------------------------------------------

function isMigrationFile(filename) {
  return (
    typeof filename === "string" &&
    (/^supabase\/migrations\//.test(filename) ||
      /^drizzle\//.test(filename) ||
      /\.sql$/i.test(filename))
  );
}

const DESTRUCTIVE_SQL_PATTERNS = Object.freeze([
  { name: "drop-table", pattern: /\bDROP\s+TABLE\b/i },
  { name: "drop-column", pattern: /\bDROP\s+COLUMN\b/i },
  { name: "drop-schema", pattern: /\bDROP\s+SCHEMA\b/i },
  { name: "truncate", pattern: /\bTRUNCATE\b/i },
  {
    name: "destructive-alter-type",
    pattern:
      /\bALTER\s+(?:TABLE\s+\S+\s+)?(?:ALTER|MODIFY)\s+COLUMN\s+\S+\s+(?:SET\s+DATA\s+)?TYPE\b/i,
  },
  { name: "revoke", pattern: /\bREVOKE\b/i },
  {
    name: "grant-broadening",
    pattern: /\bGRANT\b[\s\S]*?\b(PUBLIC|ALL)\b/i,
  },
]);

function extractAddedLines(patch) {
  return patch
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}

/**
 * Deterministically scans a migration file's patch or full content for
 * destructive SQL statements.
 *
 * @param {{filename?: string, patch?: string, content?: string}} file
 * @returns {string[]} names of matched destructive statement kinds (empty if none/not applicable)
 */
function detectDestructiveMigrationStatements(file) {
  if (!file || typeof file !== "object" || !isMigrationFile(file.filename)) {
    return [];
  }

  const text =
    typeof file.patch === "string"
      ? extractAddedLines(file.patch)
      : typeof file.content === "string"
        ? file.content
        : "";

  if (!text) {
    return [];
  }

  return DESTRUCTIVE_SQL_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(
    ({ name }) => name,
  );
}

// ---------------------------------------------------------------------------
// Path-derived + issue-declared risk aggregation
// ---------------------------------------------------------------------------

/**
 * @param {Array<{filename: string, patch?: string, content?: string}>} files
 * @returns {{tier: string, reasons: string[], destructiveMigrations: Array<{filename: string, matches: string[]}>}}
 */
function determinePathRisk(files) {
  if (!Array.isArray(files) || files.length === 0) {
    return {
      tier: RISK_TIERS.BOUNDARY,
      reasons: ["malformed-or-empty-file-list"],
      destructiveMigrations: [],
    };
  }

  let tier = RISK_TIERS.ROUTINE;
  const reasons = [];
  const destructiveMigrations = [];

  for (const file of files) {
    if (
      !file ||
      typeof file !== "object" ||
      typeof file.filename !== "string" ||
      file.filename.trim() === ""
    ) {
      tier = RISK_TIERS.BOUNDARY;
      reasons.push("malformed-file-entry");
      continue;
    }

    const pathTier = classifyPathTier(file.filename);
    tier = maxRiskTier(tier, pathTier);
    if (pathTier !== RISK_TIERS.ROUTINE) {
      reasons.push(`${pathTier}:${file.filename}`);
    }

    if (
      isMigrationFile(file.filename) &&
      typeof file.patch !== "string" &&
      typeof file.content !== "string"
    ) {
      tier = RISK_TIERS.BOUNDARY;
      reasons.push(`migration-content-unavailable:${file.filename}`);
      continue;
    }

    const destructiveMatches = detectDestructiveMigrationStatements(file);
    if (destructiveMatches.length > 0) {
      tier = RISK_TIERS.BOUNDARY;
      destructiveMigrations.push({ filename: file.filename, matches: destructiveMatches });
      reasons.push(`destructive-migration:${file.filename}`);
    }
  }

  return { tier, reasons, destructiveMigrations };
}

/**
 * @param {unknown} label
 * @returns {{tier: string|null, valid: boolean, provided: boolean}}
 */
function normalizeIssueRiskLabel(label) {
  if (label === undefined) {
    return { tier: null, valid: true, provided: false };
  }
  if (typeof label === "string" && isKnownRiskTier(label)) {
    return { tier: label, valid: true, provided: true };
  }
  // Unknown/invalid declared tier fails closed to boundary.
  return { tier: RISK_TIERS.BOUNDARY, valid: false, provided: true };
}

/**
 * Computes the overall risk tier for a change: the more conservative of the
 * path-derived tier and any issue-declared tier. Declared risk may only
 * raise, never lower, the path-derived tier.
 *
 * @param {{files?: Array<{filename: string, patch?: string, content?: string}>, issueRiskLabel?: string}} input
 */
function determineRiskTier({ files, issueRiskLabel } = {}) {
  const pathResult = determinePathRisk(files);
  const issueResult = normalizeIssueRiskLabel(issueRiskLabel);

  const tier = maxRiskTier(pathResult.tier, issueResult.tier || RISK_TIERS.ROUTINE);

  const reasons = [...pathResult.reasons];
  if (issueResult.provided && !issueResult.valid) {
    reasons.push("invalid-issue-risk-label");
  } else if (issueResult.provided) {
    reasons.push(`issue-declared:${issueResult.tier}`);
  }

  return {
    tier,
    pathTier: pathResult.tier,
    issueTier: issueResult.provided ? issueResult.tier : null,
    issueRiskValid: issueResult.valid,
    reasons,
    destructiveMigrations: pathResult.destructiveMigrations,
    requiredChecks: getRequiredChecks(tier, files),
    requiresHumanBoundaryApproval: tier === RISK_TIERS.BOUNDARY,
  };
}

// ---------------------------------------------------------------------------
// Required checks
// ---------------------------------------------------------------------------

const QUALITY_GATES_CHECK = "Quality and evidence gates";
const MIGRATIONS_CHECK = "PostgreSQL migrations and execution";
const CODE_REVIEW_CHECK = "Agentic code review";
const QA_CHECK = "QA verification";
const SECURITY_CHECK = "Security review";
const TRADING_SAFETY_CHECK = "Trading safety review";

const BASELINE_REQUIRED_CHECKS = Object.freeze([
  QUALITY_GATES_CHECK,
  MIGRATIONS_CHECK,
  CODE_REVIEW_CHECK,
]);

// Mirrors the path scope documented for high-risk trading-safety review in
// docs/agentic-workflows-map.md.
function requiresSecurityCheck(filename) {
  return (
    typeof filename === "string" &&
    (/^\.github\//.test(filename) ||
      /^src\/app\/api\/(?:admin|auth)\//.test(filename) ||
      /^src\/deployment\//.test(filename) ||
      /^src\/lib\/.*(?:auth|csrf|secure-compare).*\.ts$/.test(filename) ||
      filename === "src/proxy.ts" ||
      filename === ".env.example" ||
      /^(?:docker-compose\.yml|next\.config\.[^/]+|package(?:-lock)?\.json)$/.test(
        filename,
      ) ||
      /^specs\//.test(filename))
  );
}

function requiresTradingSafetyCheck(filename) {
  return (
    typeof filename === "string" &&
    (    /^src\/(?:agent|backtest|db|guardrails|tools|trading)\//.test(filename) ||
    /^src\/app\/api\/agent\//.test(filename) ||
    /^(?:drizzle|supabase\/migrations)\//.test(filename) ||
    /^specs\//.test(filename))
  );
}

/**
 * @param {Array<{filename?: string, previous_filename?: string}>} files
 * @returns {string[]}
 */
function getSpecialistChecks(files) {
  const filenames = (Array.isArray(files) ? files : []).flatMap((file) =>
    [file && file.filename, file && file.previous_filename].filter(
      (name) => typeof name === "string" && name.length > 0,
    ),
  );

  const checks = [];
  if (filenames.some(requiresSecurityCheck)) {
    checks.push(SECURITY_CHECK);
  }
  if (filenames.some(requiresTradingSafetyCheck)) {
    checks.push(TRADING_SAFETY_CHECK);
  }
  return checks;
}

function requiresHumanBoundaryApproval(tier) {
  return tier === RISK_TIERS.BOUNDARY;
}

/**
 * Computes the full, deduplicated, ordered set of required checks for a
 * change at a given risk tier.
 *
 * @param {string} tier one of RISK_TIERS
 * @param {Array<{filename?: string, previous_filename?: string}>} [files]
 * @returns {string[]}
 */
function getRequiredChecks(tier, files) {
  const resolvedTier = isKnownRiskTier(tier) ? tier : RISK_TIERS.BOUNDARY;
  const checks = [...BASELINE_REQUIRED_CHECKS];

  if (resolvedTier === RISK_TIERS.SENSITIVE || resolvedTier === RISK_TIERS.BOUNDARY) {
    checks.push(QA_CHECK);
  }

  checks.push(...getSpecialistChecks(files));

  return [...new Set(checks)];
}

// ---------------------------------------------------------------------------
// Lifecycle states and transitions
// ---------------------------------------------------------------------------

// State names reuse the existing factory labels documented in
// docs/agentic-software-factory.md and docs/agentic-workflows-map.md so this
// module composes directly with real issue/PR labels.
const LIFECYCLE_STATES = Object.freeze({
  OPPORTUNITY: "opportunity",
  NEEDS_TRIAGE: "needs-triage",
  READY_FOR_PLANNING: "ready-for-planning",
  NEEDS_RUBBER_DUCK: "needs-rubber-duck",
  READY_FOR_AI_DEV: "ready-for-ai-dev",
  CLAIMED: "factory:claimed",
  IMPLEMENTING: "factory:implementing",
  PR_OPEN: "factory:pr-open",
  REPAIRING: "factory:repairing",
  HUMAN_BOUNDARY_REVIEW: "ready-for-human-review",
  BLOCKED: "blocked",
  MERGED: "factory:merged",
  DEPLOYED_DEV: "factory:deployed-dev",
  DONE: "factory:done",
});

const LIFECYCLE_STATE_VALUES = Object.freeze(Object.values(LIFECYCLE_STATES));
const LIFECYCLE_STATE_SET = new Set(LIFECYCLE_STATE_VALUES);

// This hard blocking state requires a human operator to resume it. Boundary
// review is also queue-blocking, but it may advance after a current-head
// human approval.
const BLOCKING_LIFECYCLE_STATE = LIFECYCLE_STATES.BLOCKED;

const WILDCARD_STATE = "*";

// Legal state transitions with owner metadata (the role authorized to
// perform the transition). "*" means "any known state".
const LIFECYCLE_TRANSITIONS = Object.freeze([
  { from: LIFECYCLE_STATES.OPPORTUNITY, to: LIFECYCLE_STATES.NEEDS_RUBBER_DUCK, owner: "product-manager" },
  { from: LIFECYCLE_STATES.OPPORTUNITY, to: LIFECYCLE_STATES.NEEDS_TRIAGE, owner: "product-manager" },
  { from: LIFECYCLE_STATES.NEEDS_TRIAGE, to: LIFECYCLE_STATES.READY_FOR_PLANNING, owner: "product-manager" },
  { from: LIFECYCLE_STATES.NEEDS_TRIAGE, to: LIFECYCLE_STATES.NEEDS_RUBBER_DUCK, owner: "product-manager" },
  { from: LIFECYCLE_STATES.READY_FOR_PLANNING, to: LIFECYCLE_STATES.NEEDS_RUBBER_DUCK, owner: "engineering-manager" },
  { from: LIFECYCLE_STATES.READY_FOR_PLANNING, to: LIFECYCLE_STATES.READY_FOR_AI_DEV, owner: "engineering-manager" },
  { from: LIFECYCLE_STATES.NEEDS_RUBBER_DUCK, to: LIFECYCLE_STATES.READY_FOR_PLANNING, owner: "rubber-duck" },
  { from: LIFECYCLE_STATES.NEEDS_RUBBER_DUCK, to: LIFECYCLE_STATES.READY_FOR_AI_DEV, owner: "rubber-duck" },
  { from: LIFECYCLE_STATES.READY_FOR_AI_DEV, to: LIFECYCLE_STATES.CLAIMED, owner: "queue-controller" },
  { from: LIFECYCLE_STATES.CLAIMED, to: LIFECYCLE_STATES.READY_FOR_AI_DEV, owner: "queue-controller" },
  { from: LIFECYCLE_STATES.CLAIMED, to: LIFECYCLE_STATES.IMPLEMENTING, owner: "assignment-worker" },
  { from: LIFECYCLE_STATES.IMPLEMENTING, to: LIFECYCLE_STATES.PR_OPEN, owner: "lifecycle-reconciler" },
  { from: LIFECYCLE_STATES.PR_OPEN, to: LIFECYCLE_STATES.REPAIRING, owner: "lifecycle-reconciler" },
  { from: LIFECYCLE_STATES.REPAIRING, to: LIFECYCLE_STATES.PR_OPEN, owner: "lifecycle-reconciler" },
  { from: LIFECYCLE_STATES.PR_OPEN, to: LIFECYCLE_STATES.HUMAN_BOUNDARY_REVIEW, owner: "lifecycle-reconciler" },
  { from: LIFECYCLE_STATES.PR_OPEN, to: LIFECYCLE_STATES.MERGED, owner: "merge-policy" },
  { from: LIFECYCLE_STATES.HUMAN_BOUNDARY_REVIEW, to: LIFECYCLE_STATES.MERGED, owner: "human-operator" },
  { from: LIFECYCLE_STATES.MERGED, to: LIFECYCLE_STATES.DEPLOYED_DEV, owner: "deployment-reconciler" },
  { from: LIFECYCLE_STATES.DEPLOYED_DEV, to: LIFECYCLE_STATES.DONE, owner: "lifecycle-reconciler" },
  { from: LIFECYCLE_STATES.HUMAN_BOUNDARY_REVIEW, to: LIFECYCLE_STATES.BLOCKED, owner: "human-operator" },
  // The lifecycle reconciler fails closed when an automated phase cannot
  // establish a safe next state. Only a human may resume.
  { from: WILDCARD_STATE, to: LIFECYCLE_STATES.BLOCKED, owner: "lifecycle-reconciler" },
  { from: LIFECYCLE_STATES.BLOCKED, to: LIFECYCLE_STATES.READY_FOR_PLANNING, owner: "human-operator" },
  { from: LIFECYCLE_STATES.BLOCKED, to: LIFECYCLE_STATES.READY_FOR_AI_DEV, owner: "human-operator" },
]);

function findLifecycleTransition(from, to) {
  if (!LIFECYCLE_STATE_SET.has(from) || !LIFECYCLE_STATE_SET.has(to)) {
    return undefined;
  }
  return LIFECYCLE_TRANSITIONS.find(
    (transition) => (transition.from === from || transition.from === WILDCARD_STATE) && transition.to === to,
  );
}

function isLegalLifecycleTransition(from, to) {
  return Boolean(findLifecycleTransition(from, to));
}

function getLifecycleTransitionOwner(from, to) {
  const transition = findLifecycleTransition(from, to);
  return transition ? transition.owner : undefined;
}

/**
 * Applies a lifecycle transition, failing closed for any unknown state,
 * illegal transition, or actor/owner mismatch.
 *
 * @param {{from: string, to: string, actor?: string}} input
 * @returns {{allowed: boolean, from: string, to: string, owner?: string, reason?: string}}
 */
function applyLifecycleTransition({ from, to, actor } = {}) {
  if (
    typeof from !== "string" ||
    typeof to !== "string" ||
    !LIFECYCLE_STATE_SET.has(from) ||
    !LIFECYCLE_STATE_SET.has(to)
  ) {
    return { allowed: false, from, to, reason: "unknown-lifecycle-state" };
  }

  const owner = getLifecycleTransitionOwner(from, to);
  if (!owner) {
    return { allowed: false, from, to, reason: "illegal-lifecycle-transition" };
  }

  if (actor !== undefined && actor !== owner) {
    return {
      allowed: false,
      from,
      to,
      owner,
      reason: "actor-not-authorized-for-transition",
    };
  }

  return { allowed: true, from, to, owner };
}

// ---------------------------------------------------------------------------
// Queue-facing constants (shared with the queue controller)
// ---------------------------------------------------------------------------

const QUEUE_READY_LABEL = LIFECYCLE_STATES.READY_FOR_AI_DEV;
const BLOCKING_QUEUE_LABELS = Object.freeze([
  LIFECYCLE_STATES.BLOCKED,
  LIFECYCLE_STATES.HUMAN_BOUNDARY_REVIEW,
]);
const RISK_TIER_LABELS = Object.freeze([...RISK_TIER_ORDER]);

module.exports = {
  FACTORY_MODES,
  FACTORY_MODE_LABELS,
  resolveFactoryModeFromLabels,
  RISK_TIERS,
  RISK_TIER_ORDER,
  RISK_TIER_LABELS,
  rankRiskTier,
  isKnownRiskTier,
  compareRiskTiers,
  maxRiskTier,
  classifyPathTier,
  normalizeAllowedPathPatterns,
  isPathAllowed,
  areChangedFilesWithinAllowedPaths,
  areAllowedPathPatternsWithin,
  matchesBoundaryPath,
  matchesSensitivePath,
  matchesRoutinePath,
  isMigrationFile,
  DESTRUCTIVE_SQL_PATTERNS,
  detectDestructiveMigrationStatements,
  determinePathRisk,
  normalizeIssueRiskLabel,
  determineRiskTier,
  QUALITY_GATES_CHECK,
  MIGRATIONS_CHECK,
  CODE_REVIEW_CHECK,
  QA_CHECK,
  SECURITY_CHECK,
  TRADING_SAFETY_CHECK,
  BASELINE_REQUIRED_CHECKS,
  requiresSecurityCheck,
  requiresTradingSafetyCheck,
  getSpecialistChecks,
  requiresHumanBoundaryApproval,
  getRequiredChecks,
  LIFECYCLE_STATES,
  LIFECYCLE_STATE_VALUES,
  BLOCKING_LIFECYCLE_STATE,
  LIFECYCLE_TRANSITIONS,
  isLegalLifecycleTransition,
  getLifecycleTransitionOwner,
  applyLifecycleTransition,
  QUEUE_READY_LABEL,
  BLOCKING_QUEUE_LABELS,
};
