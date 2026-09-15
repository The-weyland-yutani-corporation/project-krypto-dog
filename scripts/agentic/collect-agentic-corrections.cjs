/**
 * Staged, report-only CorrectionOps collector.
 *
 * This module is intentionally CommonJS and dependency-free so a GH-AW workflow
 * can run it as `node scripts/agentic/collect-agentic-corrections.cjs` inside a
 * trusted default-branch checkout without `npm ci`, `npx`, or any runtime
 * package. It measures — it never learns, tunes, or applies anything.
 *
 * What it does (v1, measurement only):
 *
 *   - Reconstructs *predictions* the factory already made, from the real GH-AW
 *     run artifacts downloaded by `gh aw logs --artifacts all`:
 *       * PM triage runs (`pm-triage`): the requested `add-labels` and `noop`
 *         safe outputs plus their target item.
 *       * Specialist-routing runs (`code-review`): the requested `add-labels`
 *         limited to `security-review` / `trading-safety`, plus the *immutable*
 *         path routes derived deterministically from the PR's changed filenames
 *         via the canonical reconciler helper.
 *   - Reconstructs *trusted truth* from later GitHub label events authored
 *     by a `User` collaborator with `admin`/`maintain`/`write` permission, after
 *     the prediction was applied. Bot and untrusted-user activity is retained as
 *     provenance but never scored.
 *   - Computes a deterministic, byte-stable, field-level diff and a versioned
 *     JSON report (match / mismatch / pending, correction rate, sample size,
 *     immutable-route conflicts, content/instruction/model groupings).
 *
 * Design invariants (kept in lockstep with the MonitorOps and entropy
 * collectors, which this collector reuses for its command runner / safe-path /
 * window / JSON helpers):
 *
 *   - Pure functions do the parsing, diffing, and report assembly, and take
 *     already-parsed data, so unit tests never touch GitHub. All GitHub access
 *     flows through one injected command runner whose default uses `spawnSync`
 *     with `shell: false` — never a shell string — so nothing this collector
 *     receives is interpolated into a shell.
 *   - JSONL parsing is fail-loud: a malformed line throws with its file + line,
 *     it is never silently skipped.
 *   - No raw content is stored or emitted — ever. No issue body, comment body,
 *     prompt text, event body, or review body. Only stable ids, label/route
 *     names, counts, timestamps, and content *hashes*.
 *   - `cache-memory` stores only normalized snapshots and watermarks (90-day
 *     retention). A cache miss re-baselines: it can never fabricate a correction
 *     or suppress a report. The published state hash embedded in prior report
 *     issues (`<!-- correction-state-hash: ... -->`) is authoritative over cache.
 *   - Deterministic trading authorization, guardrails, leases, reconciliation,
 *     operator pause, and paper/live behavior are NEVER scored or learned. The
 *     relevant-field vocabularies below are structurally limited to PM triage
 *     state labels and specialist routing, and a human disagreement can never
 *     weaken or rewrite an immutable path route — such a conflict is surfaced as
 *     a safety warning instead.
 *   - When invoked by a workflow, every output/cache path must resolve under
 *     `/tmp/gh-aw/`. The collector is read-only toward GitHub and only writes the
 *     JSON/cache paths it was explicitly asked to write.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const factory = require("./collect-factory-health.cjs");
const reports = require("./factory-report.cjs");
const reads = require("./factory-read.cjs");

const REPORT_SCHEMA_VERSION = 1;

/** Marker embedded in report issue bodies; authoritative published-hash source. */
const STATE_HASH_MARKER_PREFIX = "<!-- correction-state-hash:";
const STATE_HASH_MARKER_RE =
  /<!--\s*correction-state-hash:\s*([a-f0-9]{64})\s*-->/i;

/** Maximum normalized records retained across cache cycles (dedupe + cap). */
const MAX_RETAINED_RECORDS = 500;

/**
 * Relevant PM-triage state-label vocabulary. Mirrors the `pm-triage` workflow's
 * `add-labels.allowed` list, minus the structural `agentic-factory` marker which
 * is not a factory *decision* to score. Kept as an explicit constant so a change
 * to the workflow's vocabulary is a visible, reviewed change here too.
 *
 * NOTE: none of these are trading authorization, guardrail, lease,
 * reconciliation, or paper/live fields — those are structurally out of scope.
 */
const PM_TRIAGE_RELEVANT_LABELS = Object.freeze([
  "ai:research",
  "docs-sync",
  "needs-qa",
  "needs-rubber-duck",
  "needs-triage",
  "ready-for-planning",
  "security-review",
  "trading-safety",
]);

/**
 * Canonical specialist routes. Each route has:
 *   - `id`         — the immutable canonical route id.
 *   - `label`      — the semantic escalation label a run may request.
 *   - `checkName`  — the reconciler's required-check name for the immutable path.
 * Human disagreement may correct the *semantic* label but never the immutable
 * route (see `diffRoutingRecord`).
 */
const SPECIALIST_ROUTES = Object.freeze([
  Object.freeze({
    id: "security",
    label: "security-review",
    checkName: "Security review",
  }),
  Object.freeze({
    id: "trading-safety",
    label: "trading-safety",
    checkName: "Trading safety review",
  }),
]);

const ROUTE_LABELS = Object.freeze(SPECIALIST_ROUTES.map((r) => r.label));
const TRUSTED_PERMISSIONS = Object.freeze(["admin", "maintain", "write"]);

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => String(a).localeCompare(String(b), "en"));
}

/**
 * Fail-loud JSONL parser. Every non-blank line must be valid JSON or this throws
 * with the file label and 1-based line number. A blank/whitespace line is
 * skipped (trailing newline tolerance), never a malformed one.
 */
function parseJsonl(text, label) {
  if (typeof text !== "string") {
    throw new Error(`${label || "jsonl"}: expected string input`);
  }
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line));
    } catch (error) {
      throw new Error(
        `${label || "jsonl"}: malformed JSON on line ${i + 1}: ${(error && error.message) || error}`,
      );
    }
  }
  return out;
}

/** True when an ISO timestamp is strictly after `afterIso`. Unknown → false. */
function isAfter(iso, afterIso) {
  if (typeof iso !== "string" || typeof afterIso !== "string") return false;
  const t = Date.parse(iso);
  const a = Date.parse(afterIso);
  if (Number.isNaN(t) || Number.isNaN(a)) return false;
  return t > a;
}

// ---------------------------------------------------------------------------
// Artifact parsing (pure) — the real `gh aw logs --artifacts all` shape
// ---------------------------------------------------------------------------

/**
 * Normalize an `aw_info.json` object. Only the provenance fields we score are
 * kept; nothing free-form (and never a body) is retained.
 */
function parseAwInfo(json) {
  if (!json || typeof json !== "object") {
    throw new Error("aw_info.json: expected an object");
  }
  const runId =
    json.run_id !== undefined && json.run_id !== null
      ? String(json.run_id)
      : null;
  if (!runId) {
    throw new Error("aw_info.json: missing run_id");
  }
  const workflowName =
    typeof json.workflow_name === "string" && json.workflow_name.trim() !== ""
      ? json.workflow_name.trim()
      : typeof json.workflow === "string"
        ? json.workflow.trim()
        : null;
  return {
    workflow: normalizeWorkflowId(workflowName),
    runId,
    headSha:
      typeof json.head_sha === "string"
        ? json.head_sha
        : typeof json.sha === "string"
          ? json.sha
          : null,
    model: typeof json.model === "string" ? json.model : null,
    workflowVersion:
      typeof json.version === "string"
        ? json.version
        : typeof json.agent_version === "string"
          ? json.agent_version
          : typeof json.engine_version === "string"
            ? json.engine_version
            : null,
    createdAt:
      typeof json.created_at === "string" ? json.created_at : null,
    engineVersion:
      typeof json.engine_version === "string" ? json.engine_version : null,
  };
}

function normalizeWorkflowId(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  return value
    .trim()
    .replace(/\.lock\.yml$/i, "")
    .replace(/\.(md|ya?ml)$/i, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

/**
 * Compute a stable content hash for the instruction/workflow version from the
 * prompt import tree and prompt text. The import tree encodes every imported
 * instruction file; hashing it plus the rendered prompt yields a deterministic
 * "which instructions produced this run" fingerprint without storing any text.
 */
function computeInstructionHash(input) {
  const src = input || {};
  const treeString = factory.stableStringify(
    src.importTree === undefined ? null : src.importTree,
  );
  const promptString = typeof src.promptText === "string" ? src.promptText : "";
  return sha256(`tree:${treeString}\nprompt:${sha256(promptString)}`);
}

/**
 * Extract the requested safe-output items for a given type from a parsed
 * `safeoutputs.jsonl` array. Each entry is `{ type, ... }`.
 */
function selectSafeOutputs(items, type) {
  return (Array.isArray(items) ? items : []).filter(
    (it) => it && typeof it === "object" && it.type === type,
  );
}

/** Normalize a requested-label safe output into a sorted string[] of labels. */
function safeOutputLabels(item) {
  if (!item || typeof item !== "object") return [];
  const raw = item.labels;
  if (!Array.isArray(raw)) return [];
  return uniqueSorted(raw.filter((l) => typeof l === "string" && l.trim() !== ""));
}

/** Read `item_number` (or `item`/`issue`/`number`) as a positive integer or null. */
function safeOutputItemNumber(item) {
  if (!item || typeof item !== "object") return null;
  for (const key of ["item_number", "item", "issue", "number", "pull_number"]) {
    const v = item[key];
    if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
    if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v.trim());
  }
  return null;
}

/**
 * Find the earliest applied timestamp among applied safe-output items whose type
 * is one of `types`. The applied file (`safe-output-items/safe-output-items.jsonl`)
 * records the actual applied result with a timestamp. Returns null when absent.
 */
function appliedTimestamp(appliedItems, types) {
  const wanted = new Set(types);
  let best = null;
  for (const it of Array.isArray(appliedItems) ? appliedItems : []) {
    if (!it || typeof it !== "object") continue;
    if (it.type !== undefined && !wanted.has(it.type)) continue;
    const ts =
      typeof it.applied_at === "string"
        ? it.applied_at
        : typeof it.timestamp === "string"
          ? it.timestamp
          : typeof it.created_at === "string"
            ? it.created_at
            : null;
    if (typeof ts === "string" && !Number.isNaN(Date.parse(ts))) {
      if (best === null || Date.parse(ts) < Date.parse(best)) best = ts;
    }
  }
  return best;
}

/**
 * Build a PM-triage prediction record from the parsed artifact pieces.
 * `predictedLabels` is the union of requested `add-labels` restricted to the
 * relevant vocabulary; `predictedNoop` is whether a `noop` safe output was
 * requested (and no relevant label was). Returns null when no item can be
 * resolved (nothing to score).
 */
function extractPmTriagePrediction(input) {
  const src = input || {};
  const awInfo = src.awInfo || {};
  const requested = Array.isArray(src.safeOutputs) ? src.safeOutputs : [];
  const labelOutputs = selectSafeOutputs(requested, "add-labels").concat(
    selectSafeOutputs(requested, "add_labels"),
  );
  const noopOutputs = selectSafeOutputs(requested, "noop");

  const predictedLabels = uniqueSorted(
    labelOutputs
      .flatMap(safeOutputLabels)
      .filter((l) => PM_TRIAGE_RELEVANT_LABELS.includes(l)),
  );

  let itemNumber = null;
  for (const out of [...labelOutputs, ...noopOutputs]) {
    const n = safeOutputItemNumber(out);
    if (n) {
      itemNumber = n;
      break;
    }
  }
  if (itemNumber === null && typeof src.itemNumber === "number") {
    itemNumber = src.itemNumber;
  }
  if (itemNumber === null) return null;

  const predictedNoop = noopOutputs.length > 0 && predictedLabels.length === 0;

  return {
    kind: "pm-triage",
    id: `${awInfo.workflow || "pm-triage"}:${awInfo.runId}:${itemNumber}`,
    workflow: awInfo.workflow || "pm-triage",
    runId: awInfo.runId,
    headSha: awInfo.headSha || null,
    model: awInfo.model || null,
    workflowVersion: awInfo.workflowVersion || null,
    instructionHash: src.instructionHash || null,
    itemNumber,
    itemType: "issue",
    predictedLabels,
    predictedNoop,
    evidenceArtifactIds: uniqueSorted(
      [awInfo.runId, ...(src.evidenceArtifactIds || [])].filter(Boolean),
    ),
    createdAt: awInfo.createdAt || null,
    appliedAt:
      appliedTimestamp(src.appliedItems, [
        "add-labels",
        "add_labels",
        "noop",
      ]) || awInfo.createdAt || null,
  };
}

/**
 * Build a specialist-routing prediction record from a `code-review` run.
 * `semanticPredictedRoutes` come from requested `add-labels` limited to the
 * route labels; `immutableRoutes` are derived deterministically from the PR's
 * changed filenames via the canonical reconciler helper (`deriveImmutableRoutes`).
 * The two are stored separately and never merged. Returns null when no PR number
 * resolves.
 */
function extractSpecialistRoutingPrediction(input) {
  const src = input || {};
  const awInfo = src.awInfo || {};
  const requested = Array.isArray(src.safeOutputs) ? src.safeOutputs : [];
  const labelOutputs = selectSafeOutputs(requested, "add-labels").concat(
    selectSafeOutputs(requested, "add_labels"),
  );

  const semanticPredictedRoutes = uniqueSorted(
    labelOutputs
      .flatMap(safeOutputLabels)
      .filter((l) => ROUTE_LABELS.includes(l))
      .map(labelToRouteId),
  );

  let itemNumber = null;
  for (const out of labelOutputs) {
    const n = safeOutputItemNumber(out);
    if (n) {
      itemNumber = n;
      break;
    }
  }
  if (itemNumber === null && typeof src.itemNumber === "number") {
    itemNumber = src.itemNumber;
  }
  if (itemNumber === null) return null;

  const immutableRoutes = deriveImmutableRoutes(src.changedFiles || []);

  return {
    kind: "specialist-routing",
    id: `${awInfo.workflow || "code-review"}:${awInfo.runId}:${itemNumber}`,
    workflow: awInfo.workflow || "code-review",
    runId: awInfo.runId,
    headSha: awInfo.headSha || null,
    model: awInfo.model || null,
    workflowVersion: awInfo.workflowVersion || null,
    instructionHash: src.instructionHash || null,
    itemNumber,
    itemType: "pull_request",
    semanticPredictedRoutes,
    immutableRoutes,
    changedFileCount: Array.isArray(src.changedFiles)
      ? src.changedFiles.length
      : 0,
    evidenceArtifactIds: uniqueSorted(
      [awInfo.runId, ...(src.evidenceArtifactIds || [])].filter(Boolean),
    ),
    createdAt: awInfo.createdAt || null,
    appliedAt:
      appliedTimestamp(src.appliedItems, ["add-labels", "add_labels"]) ||
      awInfo.createdAt ||
      null,
  };
}

function labelToRouteId(label) {
  const route = SPECIALIST_ROUTES.find((r) => r.label === label);
  return route ? route.id : label;
}

/**
 * Derive the canonical immutable specialist routes from a list of changed
 * filenames, reusing the reconciler's authoritative helper so the routing policy
 * is never re-derived here. Falls back to an empty route set when the reconciler
 * is unavailable (it is always present in a real checkout).
 */
function deriveImmutableRoutes(changedFiles, reconcilerOverride) {
  const reconciler = reconcilerOverride || loadReconciler();
  if (!reconciler || typeof reconciler.getRequiredSpecialistChecks !== "function") {
    return [];
  }
  const files = (Array.isArray(changedFiles) ? changedFiles : [])
    .map((f) => (typeof f === "string" ? { filename: f } : f))
    .filter((f) => f && typeof f.filename === "string");
  const checks = reconciler.getRequiredSpecialistChecks(files);
  const byCheck = new Map(SPECIALIST_ROUTES.map((r) => [r.checkName, r.id]));
  return uniqueSorted(
    checks.map((name) => byCheck.get(name)).filter(Boolean),
  );
}

let _reconcilerCache;
function loadReconciler(repoRoot) {
  if (_reconcilerCache !== undefined) return _reconcilerCache;
  try {
    const root = repoRoot || factory.resolveRepoRoot();
    _reconcilerCache = require(
      path.join(root, ".github", "scripts", "agentic-pr-reconciler.cjs"),
    );
  } catch {
    _reconcilerCache = null;
  }
  return _reconcilerCache;
}

// ---------------------------------------------------------------------------
// Trusted truth (pure)
// ---------------------------------------------------------------------------

/** True when an actor is a `User` with a trusted collaborator permission. */
function isTrustedActor(actorType, permission) {
  return (
    actorType === "User" &&
    typeof permission === "string" &&
    TRUSTED_PERMISSIONS.includes(permission)
  );
}

/**
 * Reduce a list of already-normalized label events into a final truth over a set
 * of relevant labels, counting only trusted human events strictly after
 * `afterIso`. Each event: `{ label, action: "labeled"|"unlabeled", actorType,
 * permission, createdAt }`.
 *
 * Returns `{ acted: Set<label>, present: Set<label>, botExcluded, untrustedExcluded }`:
 *   - `acted`   — relevant labels a trusted human touched (add or remove).
 *   - `present` — relevant labels whose final trusted-human state is "present".
 */
function deriveLabelTruth(events, relevantLabels, afterIso) {
  const relevant = new Set(relevantLabels);
  const ordered = (Array.isArray(events) ? events : [])
    .filter((e) => e && relevant.has(e.label))
    .filter((e) => afterIso == null || isAfter(e.createdAt, afterIso))
    .slice()
    .sort((a, b) => {
      const ta = Date.parse(a.createdAt) || 0;
      const tb = Date.parse(b.createdAt) || 0;
      return ta - tb;
    });

  const acted = new Set();
  const present = new Set();
  let botExcluded = 0;
  let untrustedExcluded = 0;

  for (const e of ordered) {
    if (!isTrustedActor(e.actorType, e.permission)) {
      if (e.actorType === "Bot") botExcluded += 1;
      else untrustedExcluded += 1;
      continue;
    }
    acted.add(e.label);
    if (e.action === "labeled") present.add(e.label);
    else if (e.action === "unlabeled") present.delete(e.label);
  }

  return { acted, present, botExcluded, untrustedExcluded };
}

// ---------------------------------------------------------------------------
// Deterministic field-level diff (pure)
// ---------------------------------------------------------------------------

/**
 * Diff a PM-triage prediction against the derived trusted truth.
 *
 * Semantics:
 *   - Only relevant labels a trusted human *acted on* are scorable fields.
 *   - No human action on any relevant field → status "pending" (never "match").
 *   - For each acted field: `match` when predicted membership equals final
 *     trusted-human membership; otherwise it is a `correction`.
 *   - The record is a `mismatch` (correction) iff any acted field disagrees.
 */
function diffPmTriageRecord(prediction, truth) {
  const predicted = new Set(prediction.predictedLabels || []);
  const acted = [...truth.acted].sort((a, b) => a.localeCompare(b, "en"));

  if (acted.length === 0) {
    return {
      id: prediction.id,
      kind: prediction.kind,
      workflow: prediction.workflow,
      itemNumber: prediction.itemNumber,
      instructionHash: prediction.instructionHash,
      model: prediction.model,
      workflowVersion: prediction.workflowVersion || null,
      status: "pending",
      correction: false,
      fields: [],
      immutableRouteConflicts: [],
    };
  }

  const fields = acted.map((label) => {
    const predictedMember = predicted.has(label);
    const truthMember = truth.present.has(label);
    return {
      field: `label:${label}`,
      predicted: predictedMember,
      truth: truthMember,
      outcome: predictedMember === truthMember ? "match" : "mismatch",
    };
  });

  const mismatch = fields.some((f) => f.outcome === "mismatch");
  return {
    id: prediction.id,
    kind: prediction.kind,
    workflow: prediction.workflow,
    itemNumber: prediction.itemNumber,
    instructionHash: prediction.instructionHash,
    model: prediction.model,
    workflowVersion: prediction.workflowVersion || null,
    status: mismatch ? "mismatch" : "match",
    correction: mismatch,
    fields,
    immutableRouteConflicts: [],
  };
}

/**
 * Diff a specialist-routing prediction against trusted truth.
 *
 * Semantics:
 *   - Scorable fields are route labels a trusted human acted on.
 *   - No human action → "pending".
 *   - A human *removal* of a predicted specialist label is a semantic
 *     correction, but if that route is still in `immutableRoutes` the removal
 *     cannot override the immutable path route — it is surfaced as a safety
 *     warning conflict and the immutable route is preserved. The record is still
 *     scored as a semantic mismatch so measurement is honest, but
 *     `immutableRouteConflicts` records that safety routing was NOT weakened.
 */
function diffRoutingRecord(prediction, truth) {
  const predicted = new Set(prediction.semanticPredictedRoutes || []);
  const immutable = new Set(prediction.immutableRoutes || []);
  const actedRoutes = [...truth.acted]
    .map(labelToRouteId)
    .filter((id) => SPECIALIST_ROUTES.some((r) => r.id === id));
  const actedSorted = uniqueSorted(actedRoutes);

  const base = {
    id: prediction.id,
    kind: prediction.kind,
    workflow: prediction.workflow,
    itemNumber: prediction.itemNumber,
    instructionHash: prediction.instructionHash,
    model: prediction.model,
    workflowVersion: prediction.workflowVersion || null,
    immutableRoutes: uniqueSorted([...immutable]),
    semanticPredictedRoutes: uniqueSorted([...predicted]),
  };

  const semanticGaps = [...immutable]
    .filter((routeId) => !predicted.has(routeId))
    .sort((a, b) => a.localeCompare(b, "en"))
    .map((routeId) => ({
      route: routeId,
      note: "semantic routing omitted a specialist route required by immutable path policy; immutable route preserved",
    }));

  if (actedSorted.length === 0) {
    return Object.assign(base, {
      status: "pending",
      correction: false,
      fields: [],
      immutableRouteConflicts: semanticGaps,
    });
  }

  const presentRoutes = new Set(
    [...truth.present].map(labelToRouteId),
  );
  const conflicts = [...semanticGaps];
  const fields = actedSorted.map((routeId) => {
    const predictedMember = predicted.has(routeId);
    const truthMember = presentRoutes.has(routeId);
    // A human removed a predicted route that immutable policy still requires:
    // record the safety conflict; immutable routing is NOT weakened.
    if (predictedMember && !truthMember && immutable.has(routeId)) {
      conflicts.push({
        route: routeId,
        note: "trusted human removed a predicted specialist label that immutable path routing still requires; immutable route preserved",
      });
    }
    return {
      field: `route:${routeId}`,
      predicted: predictedMember,
      truth: truthMember,
      immutableRequired: immutable.has(routeId),
      outcome: predictedMember === truthMember ? "match" : "mismatch",
    };
  });

  const mismatch = fields.some((f) => f.outcome === "mismatch");
  return Object.assign(base, {
    status: mismatch ? "mismatch" : "match",
    correction: mismatch,
    fields,
    immutableRouteConflicts: conflicts,
  });
}

/** Route the diff based on record kind. */
function diffRecord(prediction, truth) {
  if (prediction.kind === "specialist-routing") {
    return diffRoutingRecord(prediction, truth);
  }
  return diffPmTriageRecord(prediction, truth);
}

// ---------------------------------------------------------------------------
// Aggregation, dedupe/cap, material hash (pure)
// ---------------------------------------------------------------------------

/**
 * Deduplicate records by stable id (`workflow:runId:itemNumber`), keeping the
 * most recently created record for a given id, then cap the retained set to the
 * `MAX_RETAINED_RECORDS` newest by `createdAt`. Deterministic ordering.
 */
function dedupeAndCap(records, cap) {
  const limit = typeof cap === "number" && cap > 0 ? cap : MAX_RETAINED_RECORDS;
  const byId = new Map();
  for (const r of Array.isArray(records) ? records : []) {
    if (!r || typeof r.id !== "string") continue;
    const existing = byId.get(r.id);
    if (!existing) {
      byId.set(r.id, r);
      continue;
    }
    const a = Date.parse(existing.createdAt) || 0;
    const b = Date.parse(r.createdAt) || 0;
    if (b >= a) byId.set(r.id, r);
  }
  const all = [...byId.values()].sort((x, y) => {
    const tx = Date.parse(x.createdAt) || 0;
    const ty = Date.parse(y.createdAt) || 0;
    if (tx !== ty) return ty - tx; // newest first
    return x.id.localeCompare(y.id, "en");
  });
  return all.slice(0, limit).sort((x, y) => x.id.localeCompare(y.id, "en"));
}

/** Compute correction rate as mismatch / (match + mismatch); null when sample=0. */
function computeCorrectionRate(diffs) {
  let match = 0;
  let mismatch = 0;
  for (const d of Array.isArray(diffs) ? diffs : []) {
    if (d.status === "match") match += 1;
    else if (d.status === "mismatch") mismatch += 1;
  }
  const sampleSize = match + mismatch;
  return {
    match,
    mismatch,
    sampleSize,
    correctionRate: sampleSize === 0 ? null : mismatch / sampleSize,
  };
}

/** Group scored diffs by a key extractor, returning stable-sorted counts. */
function groupBy(diffs, keyFn) {
  const groups = {};
  for (const d of Array.isArray(diffs) ? diffs : []) {
    const key = keyFn(d) || "unknown";
    if (!groups[key]) {
      groups[key] = { match: 0, mismatch: 0, pending: 0 };
    }
    if (d.status === "match") groups[key].match += 1;
    else if (d.status === "mismatch") groups[key].mismatch += 1;
    else groups[key].pending += 1;
  }
  const ordered = {};
  for (const key of Object.keys(groups).sort((a, b) => a.localeCompare(b, "en"))) {
    ordered[key] = groups[key];
  }
  return ordered;
}

/** The material subset of a report used for noop suppression (no timestamps). */
function buildMaterialView(report) {
  return {
    schemaVersion: report.schemaVersion,
    window: report.window || null,
    completeness: report.completeness || null,
    sources: report.sources || null,
    diffs: (report.diffs || [])
      .map((d) => ({
        id: d.id,
        status: d.status,
        correction: d.correction,
        instructionHash: d.instructionHash || null,
        workflowVersion: d.workflowVersion || null,
        model: d.model || null,
        fields: (d.fields || []).map((f) => ({
          field: f.field,
          outcome: f.outcome,
        })),
        immutableRouteConflicts: (d.immutableRouteConflicts || []).map((c) => ({
          route: c.route,
        })),
      }))
      .sort((a, b) => a.id.localeCompare(b.id, "en")),
    diffSummary: report.diffSummary,
    correctionRate: report.correctionRate,
    sampleSize: report.sampleSize,
    immutableRouteConflicts: (report.immutableRouteConflicts || [])
      .map((c) => ({ id: c.id, route: c.route }))
      .sort((a, b) =>
        `${a.id}:${a.route}`.localeCompare(`${b.id}:${b.route}`, "en"),
      ),
  };
}

function computeMaterialHash(report) {
  return sha256(factory.stableStringify(buildMaterialView(report)));
}

/**
 * Assemble the full versioned report from prediction records, their trusted
 * truths, and the diff results. Pure and deterministic apart from
 * `generatedAt`/`commit`, which are excluded from the material hash.
 */
function buildReport(input) {
  const src = input || {};
  const predictions = dedupeAndCap(src.predictions, src.cap);
  const diffs = (src.diffs || [])
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id, "en"));

  const rate = computeCorrectionRate(diffs);
  const pendingCount = diffs.filter((d) => d.status === "pending").length;

  const immutableRouteConflicts = diffs
    .flatMap((d) =>
      (d.immutableRouteConflicts || []).map((c) => ({
        id: d.id,
        itemNumber: d.itemNumber,
        route: c.route,
        note: c.note,
      })),
    )
    .sort((a, b) =>
      `${a.id}:${a.route}`.localeCompare(`${b.id}:${b.route}`, "en"),
    );

  const predictionSummary = {
    total: predictions.length,
    byWorkflow: countBy(predictions, (p) => p.workflow),
    byKind: countBy(predictions, (p) => p.kind),
  };

  const truthSummary = {
    trustedActors: src.trustedActorCount == null ? null : src.trustedActorCount,
    botExcluded: src.botExcluded || 0,
    untrustedExcluded: src.untrustedExcluded || 0,
  };

  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    mode: "staged",
    generatedAt: src.generatedAt || null,
    commit: src.commit || null,
    window: src.window || null,
    predictionSummary,
    truthSummary,
    diffSummary: {
      match: rate.match,
      mismatch: rate.mismatch,
      pending: pendingCount,
    },
    pendingCount,
    sampleSize: rate.sampleSize,
    correctionRate: rate.correctionRate,
    immutableRouteConflicts,
    versionGroupings: {
      byInstructionHash: groupBy(diffs, (d) => d.instructionHash),
      byWorkflowVersion: groupBy(diffs, (d) => d.workflowVersion),
      byModel: groupBy(diffs, (d) => d.model),
    },
    diffs,
    materialHash: null,
    baselineDelta: null,
  };
  report.materialHash = computeMaterialHash(report);
  return report;
}

function countBy(list, keyFn) {
  const out = {};
  for (const item of Array.isArray(list) ? list : []) {
    const key = keyFn(item) || "unknown";
    out[key] = (out[key] || 0) + 1;
  }
  const ordered = {};
  for (const key of Object.keys(out).sort((a, b) => a.localeCompare(b, "en"))) {
    ordered[key] = out[key];
  }
  return ordered;
}

// ---------------------------------------------------------------------------
// Report state / noop suppression (published-hash authoritative over cache)
// ---------------------------------------------------------------------------

function readPublishedHash(issues) {
  const rows = (Array.isArray(issues) ? issues : [])
    .map((issue) => {
      const body = issue && typeof issue.body === "string" ? issue.body : "";
      const match = body.match(STATE_HASH_MARKER_RE);
      return match
        ? {
            hash: match[1].toLowerCase(),
            createdAt: issue.updatedAt || issue.updated_at || issue.createdAt || issue.created_at || "",
            number: Number(issue.number) || 0,
          }
        : null;
    })
    .filter(Boolean)
    .sort((left, right) => {
      const time =
        (Date.parse(right.createdAt) || 0) -
        (Date.parse(left.createdAt) || 0);
      return time !== 0 ? time : right.number - left.number;
    });
  return rows.length > 0 ? rows[0].hash : null;
}

/**
 * Decide whether the report is materially new. The published hash (from prior
 * report issues) is authoritative; the cache is only used to compute a delta.
 * A cache miss never suppresses a report.
 */
function decideChange(input) {
  const currentHash = input.currentHash;
  const publishedHash = input.publishedHash || null;
  const cached = input.cachedReport || null;
  const cacheHit = Boolean(cached);
  const changed =
    publishedHash == null ? true : publishedHash !== currentHash;
  let delta = null;
  if (cacheHit && changed && cached.materialHash) {
    delta = computeDelta(cached, input.currentReport);
  }
  return { changed, cacheHit, publishedHash, delta };
}

function computeDelta(previous, current) {
  const key = (d) => d.id;
  const prev = new Map(
    (previous.diffs || []).map((d) => [key(d), d.status]),
  );
  const cur = new Map((current.diffs || []).map((d) => [key(d), d.status]));
  const added = [...cur.keys()].filter((k) => !prev.has(k)).sort();
  const removed = [...prev.keys()].filter((k) => !cur.has(k)).sort();
  const changedStatus = [...cur.keys()]
    .filter((k) => prev.has(k) && prev.get(k) !== cur.get(k))
    .map((k) => ({ id: k, from: prev.get(k), to: cur.get(k) }))
    .sort((a, b) => a.id.localeCompare(b.id, "en"));
  return { added, removed, changedStatus };
}

// ---------------------------------------------------------------------------
// Cache (normalized snapshots + watermarks only)
// ---------------------------------------------------------------------------

function loadCache(cachePath, inlineCache) {
  if (inlineCache !== undefined) return inlineCache;
  if (!cachePath || !fs.existsSync(cachePath)) return null;
  return factory.parseJsonSafe(fs.readFileSync(cachePath, "utf8"), null);
}

function buildCacheRecord(report, watermarks, predictions) {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    savedAt: report.generatedAt,
    materialHash: report.materialHash,
    watermarks: watermarks || {},
    predictions: dedupeAndCap(predictions || []).map((prediction) => ({
      ...prediction,
      evidenceArtifactIds: uniqueSorted(
        prediction.evidenceArtifactIds || [],
      ),
    })),
    diffs: (report.diffs || []).map((d) => ({
      id: d.id,
      status: d.status,
      correction: d.correction,
    })),
  };
}

// ---------------------------------------------------------------------------
// GitHub IO (read-only; injected runner). Never exercised by unit tests.
// ---------------------------------------------------------------------------

/** Resolve `owner/repo` from an explicit option, env, or `gh repo view`. */
function resolveRepository(runner, explicit) {
  if (typeof explicit === "string" && explicit.includes("/")) return explicit;
  if (
    typeof process.env.GITHUB_REPOSITORY === "string" &&
    process.env.GITHUB_REPOSITORY.includes("/")
  ) {
    return process.env.GITHUB_REPOSITORY;
  }
  const parsed = factory.runJson(
    runner,
    ["repo", "view", "--json", "nameWithOwner"],
    "gh repo view",
  );
  if (!parsed || typeof parsed.nameWithOwner !== "string") {
    throw new Error("could not resolve repository (owner/repo)");
  }
  return parsed.nameWithOwner;
}

/**
 * Download the needed GH-AW runs + artifacts for a workflow into `outputDir`
 * using an argv-safe `gh aw logs` invocation with an explicit count/window and
 * repository, and no repo writes. Returns the list of created run folders.
 */
function ghDownloadRuns(runner, options) {
  const opts = options || {};
  const outputDir = opts.outputDir;
  fs.mkdirSync(outputDir, { recursive: true });
  const args = [
    "aw",
    "logs",
    opts.workflow,
    "--repo",
    opts.repository,
    "--count",
    String(opts.count || 50),
    "--start-date",
    opts.window.start.slice(0, 10),
    "--end-date",
    opts.window.end.slice(0, 10),
    "--artifacts",
    "all",
    "--no-staged",
    "--output",
    outputDir,
  ];
  const result = runner("gh", args);
  if (result.status !== 0) {
    throw new Error(
      `gh aw logs (${opts.workflow}) failed (${result.status}): ${result.stderr || "no error output"}`,
    );
  }
  if (!fs.existsSync(outputDir)) return [];
  return fs
    .readdirSync(outputDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(outputDir, e.name))
    .sort((a, b) => a.localeCompare(b, "en"));
}

/** Read + parse one run folder's artifacts into the raw pieces (fail-loud). */
function readRunFolder(dir) {
  const readIf = (rel) => {
    const abs = path.join(dir, rel);
    return fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
  };
  const awInfoText = readIf("aw_info.json");
  if (awInfoText === null) return null; // not a run folder we can score
  const awInfo = parseAwInfo(JSON.parse(awInfoText));

  const safeText = readIf("safeoutputs.jsonl");
  const safeOutputs = safeText === null ? [] : parseJsonl(safeText, "safeoutputs.jsonl");

  const appliedText =
    readIf(path.join("safe-outputs-items", "safe-output-items.jsonl")) ||
    readIf(path.join("safe-output-items", "safe-output-items.jsonl"));
  const appliedItems =
    appliedText === null
      ? []
      : parseJsonl(appliedText, "safe-output-items.jsonl");

  const importTreeText = readIf(
    path.join("aw-prompts", "prompt-import-tree.json"),
  );
  const promptText = readIf(path.join("aw-prompts", "prompt.txt"));
  const instructionHash = computeInstructionHash({
    importTree: importTreeText === null ? null : JSON.parse(importTreeText),
    promptText: promptText || "",
  });

  return { awInfo, safeOutputs, appliedItems, instructionHash };
}

/** Fetch a PR's changed filenames (path metadata only), read-only. */
function ghChangedFiles(runner, repository, prNumber) {
  const [owner, repo] = repository.split("/");
  const result = reads.readPages(runner, `/repos/${owner}/${repo}/pulls/${prNumber}/files`);
  return reads.requireComplete(result, "correction-changed-files").map((file) => file.filename)
    .filter((filename) => typeof filename === "string");
}

/**
 * Fetch trusted-filtered label truth events for an issue or pull request.
 * Bots/untrusted actors are retained as counts only. Permissions are looked up
 * once per actor and cached in `permCache` for the run.
 */
function ghLabelEvents(runner, repository, itemNumber, permCache) {
  const [owner, repo] = repository.split("/");
  const result = reads.readPages(runner, `/repos/${owner}/${repo}/issues/${itemNumber}/events`);
  const events = reads.requireComplete(result, "correction-label-events");
  const normalized = [];
  for (const e of events) {
    if (!e || !["labeled", "unlabeled"].includes(e.event) || typeof e.label?.name !== "string") continue;
    normalized.push({
      label: e.label.name,
      action: e.event,
      actorType: e.actor?.type,
      permission: e.actor?.type === "User" ? resolvePermission(runner, repository, e.actor.login, permCache) : null,
      createdAt: e.created_at,
    });
  }
  return normalized;
}

/** Resolve + cache a collaborator's repository permission (read-only). */
function resolvePermission(runner, repository, login, permCache) {
  if (typeof login !== "string" || login === "") return null;
  if (permCache && permCache.has(login)) return permCache.get(login);
  const [owner, repo] = repository.split("/");
  let permission = null;
  const result = runner("gh", [
    "api",
    `/repos/${owner}/${repo}/collaborators/${login}/permission`,
    "--jq",
    ".permission",
  ]);
  if (result.status !== 0) throw new Error("correction-human-permission-unavailable");
  permission = result.stdout.trim() || null;
  if (permCache) permCache.set(login, permission);
  return permission;
}

function ghReportIssues(runner, repository, titlePrefix) {
  const [owner, repo] = repository.split("/");
  const result = factory.runJson(
    runner,
    [
      "issue",
      "list",
      "--repo",
      `${owner}/${repo}`,
      "--state",
      "all",
      "--search",
      `${titlePrefix} in:title`,
      "--limit",
      "1000",
      "--json",
      "number,body,createdAt,updatedAt,title,state,labels,author",
    ],
    "gh issue list for published correction state",
  );
  if (!Array.isArray(result) || result.length >= 1000) throw new Error("correction-report-history-incomplete");
  return result;
}

// ---------------------------------------------------------------------------
// Top-level collection orchestrator
// ---------------------------------------------------------------------------

/**
 * Collect the full correction report. In production this downloads runs and
 * queries GitHub read-only through the injected runner. In tests, callers pass
 * `predictions` + `truthByItem` directly (or use the fixtures path) so no GitHub
 * access happens. Returns `{ report, decision, cacheRecord }`.
 */
function collect(options) {
  const opts = options || {};
  const now = opts.now instanceof Date ? opts.now : new Date(opts.now || Date.now());
  const repoRoot = opts.repoRoot || factory.resolveRepoRoot();
  const window = opts.window || factory.computeWindow("governance", now);
  const commit = opts.commit || null;
  const cache = loadCache(opts.cachePath, opts.cache);

  let predictions = opts.predictions;
  let truthByItem = opts.truthByItem;
  let trustedActorCount = opts.trustedActorCount;
  let botExcluded = opts.botExcluded || 0;
  let untrustedExcluded = opts.untrustedExcluded || 0;
  let publishedHash = opts.publishedHash || null;
  let canonicalReport = null;
  let sources = opts.sources || null;

  if (!predictions) {
    // Live path: download runs and reconstruct predictions + truth from GitHub.
    const runner = opts.runner || factory.createRunner({ cwd: repoRoot });
    const repository = resolveRepository(runner, opts.repository);
    const logsRoot =
      opts.logsRoot || path.join("/tmp", "gh-aw", "correction-logs");
    const permCache = new Map();
    const built = livePredictionsAndTruth({
      runner,
      repository,
      window,
      logsRoot,
      count: opts.count || 50,
      permCache,
      reconciler: loadReconciler(repoRoot),
      priorPredictions:
        cache && Array.isArray(cache.predictions) ? cache.predictions : [],
    });
    predictions = built.predictions;
    truthByItem = built.truthByItem;
    trustedActorCount = permCache
      ? [...permCache.values()].filter((p) => TRUSTED_PERMISSIONS.includes(p)).length
      : null;
    botExcluded = built.botExcluded;
    untrustedExcluded = built.untrustedExcluded;
    sources = built.sources;
    if (opts.reportTitlePrefix) {
      const issues = opts.reportIssues || ghReportIssues(runner, repository, opts.reportTitlePrefix);
      canonicalReport = reports.canonicalReport(issues, "corrections");
      publishedHash = readPublishedHash(issues.filter((issue) => issue.number === canonicalReport.number));
    }
  }

  const capped = dedupeAndCap(predictions, opts.cap);
  const diffs = capped.map((prediction) => {
    const truth =
      (truthByItem && truthByItem[prediction.id]) ||
      (truthByItem && truthByItem[String(prediction.itemNumber)]) || {
        acted: new Set(),
        present: new Set(),
      };
    const normalizedTruth = normalizeTruth(truth);
    return diffRecord(prediction, normalizedTruth);
  });

  const report = buildReport({
    predictions: capped,
    diffs,
    window,
    generatedAt: now.toISOString(),
    commit,
    trustedActorCount,
    botExcluded,
    untrustedExcluded,
    cap: opts.cap,
  });
  report.canonicalReport = canonicalReport;
  report.sources = sources;
  report.completeness = sources && Object.values(sources).some((source) => source.completeness !== "complete")
    ? "partial" : "complete";
  report.materialHash = computeMaterialHash(report);

  const cacheRepresentsPublished = Boolean(
    cache && publishedHash && cache.materialHash && cache.materialHash === publishedHash,
  );
  const decision = decideChange({
    currentHash: report.materialHash,
    publishedHash,
    cachedReport: cacheRepresentsPublished ? cache : null,
    currentReport: report,
  });

  report.baselineDelta = {
    publishedHash: decision.publishedHash,
    cacheHash: cache && cache.materialHash ? cache.materialHash : null,
    changed: decision.changed,
    cacheHit: decision.cacheHit,
    delta: decision.delta,
  };
  report.shouldReport =
    decision.changed && hasNewTrustedEvidence(report, decision);

  const watermarks = buildWatermarks(capped);
  const cacheRecord = buildCacheRecord(report, watermarks, capped);
  return { report, decision, cacheRecord };
}

/** Normalize a truth shape that may use arrays instead of Sets (fixtures). */
function normalizeTruth(truth) {
  const toSet = (v) => (v instanceof Set ? v : new Set(Array.isArray(v) ? v : []));
  return {
    acted: toSet(truth.acted),
    present: toSet(truth.present),
    botExcluded: truth.botExcluded || 0,
    untrustedExcluded: truth.untrustedExcluded || 0,
  };
}

/** A report is worth publishing only when at least one record is scored. */
function hasNewTrustedEvidence(report, decision) {
  if (!decision.publishedHash || !decision.delta) {
    return report.sampleSize > 0 || report.immutableRouteConflicts.length > 0;
  }
  const byId = new Map((report.diffs || []).map((diff) => [diff.id, diff]));
  const scoredAdded = (decision.delta.added || []).some((id) => {
    const diff = byId.get(id);
    return diff && diff.status !== "pending";
  });
  const scoredChange = (decision.delta.changedStatus || []).some(
    (change) => change.to !== "pending",
  );
  return (
    scoredAdded ||
    scoredChange ||
    report.immutableRouteConflicts.length > 0
  );
}

/** Newest seen run createdAt per workflow — the incremental watermark. */
function buildWatermarks(predictions) {
  const wm = {};
  for (const p of predictions) {
    const cur = wm[p.workflow];
    if (!cur || (Date.parse(p.createdAt) || 0) > (Date.parse(cur) || 0)) {
      wm[p.workflow] = p.createdAt;
    }
  }
  return wm;
}

/** Live reconstruction of predictions + trusted truth (read-only GitHub). */
function livePredictionsAndTruth(ctx) {
  const freshPredictions = [];
  const truthByItem = {};
  let botExcluded = 0;
  let untrustedExcluded = 0;
  const sources = {};

  const plans = [
    { workflow: "pm-triage", kind: "pm-triage" },
    { workflow: "code-review", kind: "specialist-routing" },
  ];

  for (const plan of plans) {
    const outputDir = path.join(ctx.logsRoot, plan.workflow);
    const folders = ghDownloadRuns(ctx.runner, {
      workflow: plan.workflow,
      repository: ctx.repository,
      count: ctx.count,
      window: ctx.window,
      outputDir,
    });
    sources[plan.workflow] = {
      completeness: folders.length >= ctx.count ? "partial" : "complete",
      records: folders.length, limit: ctx.count, reason: folders.length >= ctx.count ? "run-sample-limit-reached" : null,
    };
    for (const folder of folders) {
      const raw = readRunFolder(folder);
      if (!raw) throw new Error("correction-run-artifact-unavailable");
      if (
        !raw.awInfo.createdAt ||
        !factory.isWithinWindow(raw.awInfo.createdAt, ctx.window)
      ) {
        continue;
      }
      let prediction;
      if (plan.kind === "specialist-routing") {
        const itemNumber = firstItemNumber(raw.safeOutputs);
        const changedFiles = itemNumber
          ? ghChangedFiles(ctx.runner, ctx.repository, itemNumber)
          : [];
        prediction = extractSpecialistRoutingPrediction(
          Object.assign({}, raw, { changedFiles, reconciler: ctx.reconciler }),
        );
      } else {
        prediction = extractPmTriagePrediction(raw);
      }
      if (!prediction) continue;
      freshPredictions.push(prediction);
    }
  }
  const predictions = dedupeAndCap([
    ...(ctx.priorPredictions || []),
    ...freshPredictions,
  ]);
  for (const prediction of predictions) {
    const relevant =
      prediction.kind === "specialist-routing"
        ? ROUTE_LABELS
        : PM_TRIAGE_RELEVANT_LABELS;
    const events = ghLabelEvents(
      ctx.runner,
      ctx.repository,
      prediction.itemNumber,
      ctx.permCache,
    ).filter((event) => Date.parse(event.createdAt) < Date.parse(ctx.window.end));
    const truth = deriveLabelTruth(events, relevant, prediction.appliedAt);
    botExcluded += truth.botExcluded;
    untrustedExcluded += truth.untrustedExcluded;
    truthByItem[prediction.id] = truth;
  }
  return { predictions, truthByItem, botExcluded, untrustedExcluded, sources };
}

function firstItemNumber(safeOutputs) {
  for (const out of Array.isArray(safeOutputs) ? safeOutputs : []) {
    const n = safeOutputItemNumber(out);
    if (n) return n;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Deterministic fixtures contract mode (`--check`) — never contacts GitHub
// ---------------------------------------------------------------------------

/**
 * Run the diff engine over a committed contract fixture directory and return the
 * report. The fixture dir must contain `predictions.json` (array) and
 * `truth.json` (map of prediction id → { acted, present }). Optional
 * `expected-report.json` is compared for byte-stable drift.
 */
function runFixtureContract(fixtureDir) {
  const predictionsPath = path.join(fixtureDir, "predictions.json");
  const truthPath = path.join(fixtureDir, "truth.json");
  if (!fs.existsSync(predictionsPath) || !fs.existsSync(truthPath)) {
    throw new Error(
      `fixture contract requires predictions.json and truth.json in ${fixtureDir}`,
    );
  }
  const predictions = JSON.parse(fs.readFileSync(predictionsPath, "utf8"));
  const truthByItem = JSON.parse(fs.readFileSync(truthPath, "utf8"));
  const { report } = collect({
    predictions,
    truthByItem,
    now: new Date("2000-01-01T00:00:00.000Z"),
    window: { mode: "governance", days: 7, start: "2000-01-01", end: "2000-01-08" },
    commit: "fixture",
    trustedActorCount: null,
  });
  const expectedPath = path.join(fixtureDir, "expected-report.json");
  let drift = null;
  if (fs.existsSync(expectedPath)) {
    const expected = fs.readFileSync(expectedPath, "utf8").replace(/\r\n/g, "\n").trim();
    const actual = JSON.stringify(report, null, 2).trim();
    if (expected !== actual) drift = { expectedPath };
  }
  return { report, drift, expectedExists: fs.existsSync(expectedPath) };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { workflowMode: false, count: 50 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--out") args.out = argv[++i];
    else if (a === "--cache") args.cache = argv[++i];
    else if (a === "--repo") args.repo = argv[++i];
    else if (a === "--count") args.count = Number(argv[++i]);
    else if (a === "--report-prefix") args.reportPrefix = argv[++i];
    else if (a === "--workflow-mode") args.workflowMode = true;
    else if (a === "--workflow-root") args.workflowRoot = argv[++i];
    else if (a === "--logs-root") args.logsRoot = argv[++i];
    else if (a === "--check") args.check = true;
    else if (a === "--fixtures") args.fixtures = argv[++i];
    else if (a === "--now") args.now = argv[++i];
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

const HELP = `Staged CorrectionOps collector (report-only)

Usage:
  node scripts/agentic/collect-agentic-corrections.cjs [options]

Options:
  --out <path>            Write the JSON report to this path (else stdout).
  --cache <path>          Read prior + write updated cache record here.
  --repo <owner/repo>     Repository to read (default: env / gh repo view).
  --count <n>             Runs per workflow to download (default: 50).
  --report-prefix <s>     Report title prefix used to read the published hash.
  --logs-root <dir>       Where to download run logs (default /tmp/gh-aw/correction-logs).
  --workflow-mode         Enforce that --out/--cache resolve under /tmp/gh-aw/.
  --workflow-root <dir>   Override the workflow-mode root (default /tmp/gh-aw).
  --check --fixtures <d>  Deterministic contract mode over a fixture dir (no gh).
  --now <iso>             Override the collection instant (testing only).
  -h, --help              Show this help.

The collector is read-only toward GitHub, stores no raw content, and only
writes the paths it is given. It never applies a prompt, policy, label, or
code change; it improves measurement only.`;

function main(argv, deps) {
  const d = deps || {};
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`error: ${(error && error.message) || error}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }

  // Deterministic contract mode: no GitHub, compares against committed fixtures.
  if (args.check) {
    const fixtureDir = args.fixtures
      ? path.resolve(args.fixtures)
      : path.join(
          d.repoRoot || factory.resolveRepoRoot(),
          "tests",
          "agentic-sdlc",
          "fixtures",
          "corrections",
          "contract",
        );
    try {
      const { drift, expectedExists } = runFixtureContract(fixtureDir);
      if (!expectedExists) {
        process.stderr.write(
          `error: no expected-report.json in ${fixtureDir}\n`,
        );
        return 1;
      }
      if (drift) {
        process.stderr.write(
          `\n✗ CorrectionOps contract drift: report does not match ${drift.expectedPath}\n` +
            "  Owning gate: scripts/agentic/collect-agentic-corrections.cjs (npm run corrections:check)\n",
        );
        return 1;
      }
      process.stdout.write("✓ CorrectionOps deterministic contract passed\n");
      return 0;
    } catch (error) {
      process.stderr.write(
        `error: corrections contract failed: ${(error && error.message) || error}\n`,
      );
      return 1;
    }
  }

  const pathOpts = {
    workflowMode: args.workflowMode,
    workflowRoot: args.workflowRoot,
  };
  let outPath;
  let cachePath;
  try {
    outPath = args.out ? factory.validateOutputPath(args.out, pathOpts) : null;
    cachePath = args.cache
      ? factory.validateOutputPath(args.cache, pathOpts)
      : null;
  } catch (error) {
    process.stderr.write(`error: ${(error && error.message) || error}\n`);
    return 2;
  }

  let report;
  let cacheRecord;
  try {
    ({ report, cacheRecord } = collect({
      now: args.now ? new Date(args.now) : d.now || new Date(),
      repoRoot: d.repoRoot,
      repository: args.repo || d.repository,
      count: args.count,
      cachePath,
      cache: d.cache,
      logsRoot: args.logsRoot || d.logsRoot,
      reportTitlePrefix: args.reportPrefix,
      runner: d.runner,
      predictions: d.predictions,
      truthByItem: d.truthByItem,
      publishedHash: d.publishedHash,
    }));
  } catch (error) {
    process.stderr.write(
      `error: correction collection failed: ${(error && error.message) || error}\n`,
    );
    if (outPath) {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, `${JSON.stringify(reports.failureReceipt("corrections",
        args.now || new Date().toISOString(), "correction-collection-failed"), null, 2)}\n`);
    }
    return 1;
  }

  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, json);
    process.stdout.write(
      `correction report written: ${outPath} (shouldReport=${report.shouldReport}, sampleSize=${report.sampleSize})\n`,
    );
  } else {
    process.stdout.write(json);
  }
  if (cachePath) {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, `${JSON.stringify(cacheRecord, null, 2)}\n`);
  }
  return report.completeness === "complete" ? 0 : 1;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = {
  REPORT_SCHEMA_VERSION,
  STATE_HASH_MARKER_PREFIX,
  MAX_RETAINED_RECORDS,
  PM_TRIAGE_RELEVANT_LABELS,
  SPECIALIST_ROUTES,
  ROUTE_LABELS,
  TRUSTED_PERMISSIONS,
  sha256,
  parseJsonl,
  isAfter,
  parseAwInfo,
  normalizeWorkflowId,
  computeInstructionHash,
  selectSafeOutputs,
  safeOutputLabels,
  safeOutputItemNumber,
  appliedTimestamp,
  extractPmTriagePrediction,
  extractSpecialistRoutingPrediction,
  labelToRouteId,
  deriveImmutableRoutes,
  isTrustedActor,
  deriveLabelTruth,
  diffPmTriageRecord,
  diffRoutingRecord,
  diffRecord,
  dedupeAndCap,
  computeCorrectionRate,
  groupBy,
  buildMaterialView,
  computeMaterialHash,
  buildReport,
  readPublishedHash,
  decideChange,
  computeDelta,
  loadCache,
  buildCacheRecord,
  buildWatermarks,
  readRunFolder,
  firstItemNumber,
  runFixtureContract,
  collect,
  parseArgs,
  main,
};
