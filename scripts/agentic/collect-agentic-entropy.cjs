/**
 * Report-only agentic entropy collector.
 *
 * This module is intentionally CommonJS and dependency-free so a GH-AW workflow
 * can run it as `node scripts/agentic/collect-agentic-entropy.cjs` inside a
 * trusted checkout without `npm ci`, `npx`, or any runtime package. It is the
 * deterministic layer that scans the repository's *governance surfaces* — the
 * canonical policy, GH-AW workflow sources/locks, instruction and documentation
 * references, architecture boundaries, and (optionally) a MonitorOps snapshot —
 * and emits a single versioned JSON manifest that a weekly report workflow
 * ranks. It never mutates the repository or GitHub.
 *
 * Design invariants (kept in lockstep with the MonitorOps collector):
 *
 *   - Pure functions do the analysis. Each rule takes already-parsed data plus
 *     an injected filesystem/`gh` seam, so unit tests never touch GitHub or a
 *     real working tree. The default `gh` runner uses `spawnSync` with
 *     `shell: false`, so nothing is interpolated into a shell.
 *   - It reuses existing authorities instead of duplicating logic: the canonical
 *     policy loader (`.github/scripts/agentic-policy.cjs`) and the MonitorOps
 *     workflow inventory (`collect-factory-health.cjs`). MonitorOps-collected
 *     data (WIP, telemetry, repeated failures) is consumed from the supplied
 *     snapshot; this collector does NOT re-query GitHub for it.
 *   - Findings are structured, never raw. No issue body, secret, or file content
 *     is persisted — only rule ids, owning paths, bounded evidence, and a
 *     remediation string.
 *   - Missing MonitorOps input is `unknown`, never a false `pass`/`fail`.
 *   - Entropy is reported across explicit dimensions, never collapsed into one
 *     opaque score.
 *   - The published entropy-state hash embedded in prior report issues
 *     (`<!-- entropy-state-hash: ... -->`) is authoritative over cache. A cache
 *     miss can never suppress the next report.
 *   - When invoked by a workflow, every output/cache path must resolve under
 *     `/tmp/gh-aw/`. The collector is read-only toward the repo and GitHub and
 *     only writes the JSON/cache paths it was explicitly asked to write.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const factory = require("./collect-factory-health.cjs");

const MANIFEST_SCHEMA_VERSION = 1;

/** Marker embedded in report issue bodies; authoritative published-hash source. */
const STATE_HASH_MARKER_PREFIX = "<!-- entropy-state-hash:";
const STATE_HASH_MARKER_RE = /<!--\s*entropy-state-hash:\s*([a-f0-9]{64})\s*-->/i;

/** Advisory line-count threshold for a source-file maintainability hotspot. */
const SOURCE_FILE_LINE_THRESHOLD = 500;

/**
 * Backlog-hygiene marker matcher. Deliberately convention-based: only a marker
 * written as a real annotation (`TODO:` / `FIXME(` / `HACK:`) is flagged, so
 * incidental prose ("the TODO scan") and this collector's own vocabulary never
 * produce false positives.
 */
const TODO_MARKER_RE = /\b(?:TODO|FIXME|HACK)\b\s*[:(]/;

/** Generated-doc marker pair the inventory drift gate owns. */
const INVENTORY_START_MARKER = "<!-- generated:workflow-inventory:start -->";
const INVENTORY_END_MARKER = "<!-- generated:workflow-inventory:end -->";

/** Severity vocabulary. Zero-tolerance rules may fail a local `--check`. */
const ZERO_TOLERANCE = "zero-tolerance";
const ADVISORY = "advisory";

/** Status vocabulary for a check. */
const PASS = "pass";
const FAIL = "fail";
const UNKNOWN = "unknown";

// ---------------------------------------------------------------------------
// Small deterministic helpers (self-contained; no external deps)
// ---------------------------------------------------------------------------

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/** Deterministic JSON stringify with sorted object keys (reused from factory). */
const stableStringify = factory.stableStringify;

function readFileIfExists(abs) {
  return fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
}

/**
 * Recursively list repo-relative files under `dir` that pass `filter`, skipping
 * any directory whose name is in `skipDirs`. Deterministic (sorted) output.
 */
function listFiles(repoRoot, dir, filter, skipDirs) {
  const skip = skipDirs || new Set();
  const absDir = path.join(repoRoot, dir);
  if (!fs.existsSync(absDir)) return [];
  const out = [];
  const walk = (relDir) => {
    const entries = fs
      .readdirSync(path.join(repoRoot, relDir), { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const entry of entries) {
      const rel = path.posix.join(relDir, entry.name);
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        walk(rel);
      } else if (entry.isFile() && filter(rel, entry.name)) {
        out.push(rel);
      }
    }
  };
  walk(dir);
  return out;
}

// ---------------------------------------------------------------------------
// Pure rule primitives. Every rule returns { check, violations }.
//   check:      { ruleId, status, severity, summary }
//   violations: [ { ruleId, path, severity, evidence, remediation } ]
// A rule NEVER reads GitHub; MonitorOps data is passed in as `snapshot`.
// ---------------------------------------------------------------------------

function makeCheck(ruleId, severity, status, summary) {
  return { ruleId, severity, status, summary };
}

function makeViolation(ruleId, severity, filePath, evidence, remediation) {
  return { ruleId, severity, path: filePath, evidence, remediation };
}

/** Rule: the canonical policy loads and validates via the trusted loader. */
function rulePolicyValid(ctx) {
  const ruleId = "policy_valid";
  const rel = ".github/agentic-policy.json";
  const loaderRel = ".github/scripts/agentic-policy.cjs";
  const remediation = `fix ${rel} to satisfy ${loaderRel}, then run \`npm run entropy:check\``;
  const abs = path.join(ctx.repoRoot, rel);
  const loaderAbs = path.join(ctx.repoRoot, loaderRel);
  if (!fs.existsSync(abs) || !fs.existsSync(loaderAbs)) {
    return {
      check: makeCheck(ruleId, ZERO_TOLERANCE, FAIL, "canonical policy or loader is missing"),
      violations: [
        makeViolation(ruleId, ZERO_TOLERANCE, rel, { missing: true }, remediation),
      ],
    };
  }
  try {
    ctx.loadAgenticPolicy(abs);
  } catch (error) {
    return {
      check: makeCheck(ruleId, ZERO_TOLERANCE, FAIL, "canonical policy failed validation"),
      violations: [
        makeViolation(
          ruleId,
          ZERO_TOLERANCE,
          rel,
          { reason: String((error && error.message) || error) },
          remediation,
        ),
      ],
    };
  }
  return {
    check: makeCheck(ruleId, ZERO_TOLERANCE, PASS, "canonical policy is valid"),
    violations: [],
  };
}

/**
 * Rule: every active GH-AW source is compiled to a lock, and required generated
 * support files exist. Uses the MonitorOps inventory as the source authority.
 */
function ruleWorkflowSourcesCompiled(ctx) {
  const ruleId = "workflow_sources_compiled";
  const remediation = "run `npm run agentic:compile` and commit the regenerated artifacts";
  const violations = [];
  for (const wf of ctx.inventory) {
    if (wf.active && !wf.compiled) {
      violations.push(
        makeViolation(
          ruleId,
          ZERO_TOLERANCE,
          wf.sourcePath,
          { missingLock: wf.lockPath },
          remediation,
        ),
      );
    }
  }
  for (const support of ctx.requiredSupportFiles) {
    if (!fs.existsSync(path.join(ctx.repoRoot, support))) {
      violations.push(
        makeViolation(
          ruleId,
          ZERO_TOLERANCE,
          support,
          { missingGeneratedSupportFile: true },
          remediation,
        ),
      );
    }
  }
  const status = violations.length === 0 ? PASS : FAIL;
  return {
    check: makeCheck(
      ruleId,
      ZERO_TOLERANCE,
      status,
      status === PASS
        ? "every active GH-AW source is compiled and required support files exist"
        : `${violations.length} source/lock or support-file gap(s)`,
    ),
    violations,
  };
}

/**
 * Rule: every local Markdown file reference in the instruction/doc surfaces
 * resolves. Anchor validation is intentionally out of scope here (the dedicated
 * `npm run agentic:links` gate owns anchors); this entropy rule catches broken
 * *file* references so drift is visible even between full link-check runs.
 */
function ruleDocReferencesResolve(ctx) {
  const ruleId = "doc_references_resolve";
  const remediation =
    "fix or remove the broken reference in the owning file, then run `npm run agentic:links`";
  const violations = [];
  for (const rel of ctx.docSurfaces) {
    const abs = path.join(ctx.repoRoot, rel);
    const markdown = readFileIfExists(abs);
    if (markdown === null) continue;
    const dir = path.dirname(abs);
    for (const ref of extractLocalMarkdownTargets(markdown)) {
      const absTarget = path.resolve(dir, ref.target);
      const relFromRoot = path.relative(ctx.repoRoot, absTarget);
      // GitHub web-relative escapes (e.g. `../../issues`) are not local files.
      if (relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot)) continue;
      if (!fs.existsSync(absTarget)) {
        violations.push(
          makeViolation(
            ruleId,
            ZERO_TOLERANCE,
            rel,
            { line: ref.line, missingReference: ref.target },
            remediation,
          ),
        );
      }
    }
  }
  const status = violations.length === 0 ? PASS : FAIL;
  return {
    check: makeCheck(
      ruleId,
      ZERO_TOLERANCE,
      status,
      status === PASS
        ? "all local instruction/doc file references resolve"
        : `${violations.length} broken local reference(s)`,
    ),
    violations,
  };
}

/** Extract local (non-external) Markdown link targets, ignoring code fences. */
function extractLocalMarkdownTargets(markdown) {
  const scannable = markdown.replace(/```[\s\S]*?```/g, (block) =>
    block.replace(/[^\n]/g, " "),
  );
  const refs = [];
  const lines = scannable.split(/\r?\n/);
  const linkRe = /\]\(([^)]+)\)/g;
  lines.forEach((line, index) => {
    let match;
    while ((match = linkRe.exec(line)) !== null) {
      const raw = match[1].trim().split(/\s+/)[0];
      if (
        !raw ||
        raw.startsWith("http://") ||
        raw.startsWith("https://") ||
        raw.startsWith("mailto:") ||
        raw.startsWith("#")
      ) {
        continue;
      }
      const hashIndex = raw.indexOf("#");
      const target = hashIndex === -1 ? raw : raw.slice(0, hashIndex);
      if (target === "") continue;
      refs.push({ target, line: index + 1 });
    }
  });
  return refs;
}

/** Rule: every `imports:` entry declared by a workflow source exists on disk. */
function ruleWorkflowImportsExist(ctx) {
  const ruleId = "workflow_imports_exist";
  const remediation =
    "fix the `imports:` path in the workflow frontmatter, then run `npm run agentic:compile`";
  const violations = [];
  for (const wf of ctx.inventory) {
    const abs = path.join(ctx.repoRoot, wf.sourcePath);
    const text = readFileIfExists(abs);
    if (text === null) continue;
    for (const entry of parseImports(text)) {
      const importAbs = path.resolve(ctx.repoRoot, entry);
      const relFromRoot = path.relative(ctx.repoRoot, importAbs);
      const escapes = relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot);
      if (escapes || !fs.existsSync(importAbs)) {
        violations.push(
          makeViolation(
            ruleId,
            ZERO_TOLERANCE,
            wf.sourcePath,
            { missingImport: entry },
            remediation,
          ),
        );
      }
    }
  }
  const status = violations.length === 0 ? PASS : FAIL;
  return {
    check: makeCheck(
      ruleId,
      ZERO_TOLERANCE,
      status,
      status === PASS
        ? "every declared workflow import resolves"
        : `${violations.length} missing workflow import(s)`,
    ),
    violations,
  };
}

/** Parse a frontmatter `imports:` list (block or inline) without a YAML dep. */
function parseImports(text) {
  const { frontmatter } = factory.splitFrontmatter(text);
  const lines = frontmatter.split(/\r?\n/);
  const imports = [];
  let inBlock = false;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const topLevel = /^[^\s#]/.test(line);
    if (topLevel) {
      const inline = line.match(/^imports:\s*(.*)$/);
      if (inline) {
        inBlock = true;
        const value = inline[1].trim();
        if (value.startsWith("[")) {
          for (const item of value.slice(1, -1).split(",")) {
            const cleaned = item.trim().replace(/^["']|["']$/g, "");
            if (cleaned) imports.push(cleaned);
          }
          inBlock = false;
        }
      } else {
        inBlock = false;
      }
      continue;
    }
    if (inBlock) {
      const item = line.match(/^\s*-\s*(.+?)\s*$/);
      if (item) {
        imports.push(item[1].replace(/^["']|["']$/g, ""));
      }
    }
  }
  return imports;
}

/**
 * Rule (advisory): a distinctive canonical policy literal is duplicated verbatim
 * in a prose/instruction surface outside the canonical JSON and generated
 * sections. Verbatim copies drift from the single source of truth.
 */
function ruleDuplicatedPolicyLiterals(ctx) {
  const ruleId = "duplicated_policy_literals";
  const remediation =
    "reference `.github/agentic-policy.json` instead of copying its literal values into prose";
  const violations = [];
  const literals = ctx.policyLiterals;
  for (const rel of ctx.proseSurfaces) {
    const text = readFileIfExists(path.join(ctx.repoRoot, rel));
    if (text === null) continue;
    for (const literal of literals) {
      if (literal.length >= 12 && text.includes(literal)) {
        violations.push(
          makeViolation(
            ruleId,
            ADVISORY,
            rel,
            { duplicatedLiteral: literal },
            remediation,
          ),
        );
      }
    }
  }
  const status = violations.length === 0 ? PASS : FAIL;
  return {
    check: makeCheck(
      ruleId,
      ADVISORY,
      status,
      status === PASS
        ? "no canonical policy literals duplicated in prose"
        : `${violations.length} duplicated policy literal(s)`,
    ),
    violations,
  };
}

/**
 * Rule (advisory): actionable-opportunity WIP versus the configured cap. Sourced
 * only from the supplied MonitorOps snapshot — `unknown` when no snapshot was
 * provided or it lacks issue data (never re-queries GitHub).
 */
function ruleOpportunityWipOverCap(ctx) {
  const ruleId = "opportunity_wip_over_cap";
  const remediation =
    "triage the actionable-opportunity backlog (close/defer/promote) until WIP is below the policy cap";
  const issues = ctx.snapshot && ctx.snapshot.issues;
  const open = issues && Number.isFinite(issues.openActionableOpportunities)
    ? issues.openActionableOpportunities
    : null;
  const cap = issues && Number.isFinite(issues.wipCap) ? issues.wipCap : null;
  if (open === null || cap === null) {
    return {
      check: makeCheck(ruleId, ADVISORY, UNKNOWN, "no MonitorOps snapshot for opportunity WIP"),
      violations: [],
    };
  }
  if (open >= cap) {
    return {
      check: makeCheck(ruleId, ADVISORY, FAIL, `actionable WIP ${open} at/over cap ${cap}`),
      violations: [
        makeViolation(
          ruleId,
          ADVISORY,
          ".github/agentic-policy.json",
          { openActionableOpportunities: open, cap },
          remediation,
        ),
      ],
    };
  }
  return {
    check: makeCheck(ruleId, ADVISORY, PASS, `actionable WIP ${open} below cap ${cap}`),
    violations: [],
  };
}

/**
 * Rule (advisory): workflow telemetry coverage and repeated/eval failures.
 * Sourced only from the supplied MonitorOps snapshot — `unknown` when absent.
 */
function ruleWorkflowTelemetryCoverage(ctx) {
  const ruleId = "workflow_telemetry_coverage";
  const remediation =
    "investigate the MonitorOps governance report; restore workflow telemetry or fix the repeatedly failing workflow";
  const snapshot = ctx.snapshot;
  const telemetry = snapshot && snapshot.telemetry;
  if (!snapshot || !telemetry) {
    return {
      check: makeCheck(ruleId, ADVISORY, UNKNOWN, "no MonitorOps snapshot for telemetry coverage"),
      violations: [],
    };
  }
  const violations = [];
  const breaches = (snapshot.thresholds && snapshot.thresholds.breaches) || [];
  for (const breach of breaches) {
    if (
      breach &&
      (breach.id === "repeated_workflow_failure" ||
        breach.id === "eval_or_harness_failure" ||
        breach.id === "telemetry_missing_two_periods")
    ) {
      violations.push(
        makeViolation(
          ruleId,
          ADVISORY,
          breach.workflow
            ? path.posix.join(".github", "workflows", `${breach.workflow}.md`)
            : ".github/workflows",
          { breach: breach.id, evidence: breach.evidence || null },
          remediation,
        ),
      );
    }
  }
  // Coverage gap: an active workflow ran but its cost data is unavailable.
  if (
    Number.isFinite(telemetry.workflowsWithRunData) &&
    Number.isFinite(telemetry.workflowsWithCostData) &&
    telemetry.workflowsWithRunData > 0 &&
    telemetry.workflowsWithCostData < telemetry.workflowsWithRunData
  ) {
    violations.push(
      makeViolation(
        ruleId,
        ADVISORY,
        ".github/workflows",
        {
          workflowsWithRunData: telemetry.workflowsWithRunData,
          workflowsWithCostData: telemetry.workflowsWithCostData,
        },
        remediation,
      ),
    );
  }
  const status = violations.length === 0 ? PASS : FAIL;
  return {
    check: makeCheck(
      ruleId,
      ADVISORY,
      status,
      status === PASS
        ? "workflow telemetry coverage is complete with no repeated failures"
        : `${violations.length} telemetry/failure signal(s)`,
    ),
    violations,
  };
}

/**
 * Rule (advisory): architecture boundary hotspots. Read-only structural scan of
 * the accepted boundaries (ADR 0009): the read-only decision/model modules must
 * not import paper execution, and deterministic trading code must not import
 * agent/model packages. Reported as advisory hotspots; the authoritative gate is
 * ESLint + the architecture-boundaries test.
 */
function ruleArchitectureBoundaryHotspots(ctx) {
  const ruleId = "architecture_boundary_hotspots";
  const remediation =
    "remove the cross-boundary import (see specs/decisions/0009-agent-legible-architecture-boundaries.md); the authoritative gate is ESLint + tests";
  const violations = [];
  for (const rel of ["src/agent/decision.ts", "src/agent/llm.ts"]) {
    const text = readFileIfExists(path.join(ctx.repoRoot, rel));
    if (text === null) continue;
    if (/from ["'][^"']*paper-execut(?:or|ion)/.test(text)) {
      violations.push(
        makeViolation(ruleId, ADVISORY, rel, { importsPaperExecution: true }, remediation),
      );
    }
  }
  for (const rel of ctx.tradingSources) {
    const text = readFileIfExists(path.join(ctx.repoRoot, rel));
    if (text === null) continue;
    if (/from ["']@\/agent\//.test(text)) {
      violations.push(
        makeViolation(ruleId, ADVISORY, rel, { importsAgentModule: true }, remediation),
      );
    }
    if (/from ["']@langchain\//.test(text)) {
      violations.push(
        makeViolation(ruleId, ADVISORY, rel, { importsModelPackage: true }, remediation),
      );
    }
  }
  const status = violations.length === 0 ? PASS : FAIL;
  return {
    check: makeCheck(
      ruleId,
      ADVISORY,
      status,
      status === PASS
        ? "no architecture boundary hotspots detected"
        : `${violations.length} boundary hotspot(s)`,
    ),
    violations,
  };
}

/** Rule (advisory): source files over the documented advisory line threshold. */
function ruleSourceFileSizeHotspots(ctx) {
  const ruleId = "source_file_size_hotspots";
  const remediation = `consider splitting files over ${ctx.lineThreshold} lines into focused modules (advisory)`;
  const violations = [];
  for (const rel of ctx.appSources) {
    const text = readFileIfExists(path.join(ctx.repoRoot, rel));
    if (text === null) continue;
    const lines = text.split(/\r?\n/).length;
    if (lines > ctx.lineThreshold) {
      violations.push(
        makeViolation(ruleId, ADVISORY, rel, { lines, threshold: ctx.lineThreshold }, remediation),
      );
    }
  }
  violations.sort((a, b) => b.evidence.lines - a.evidence.lines || a.path.localeCompare(b.path, "en"));
  const status = violations.length === 0 ? PASS : FAIL;
  return {
    check: makeCheck(
      ruleId,
      ADVISORY,
      status,
      status === PASS
        ? `no source file exceeds ${ctx.lineThreshold} lines`
        : `${violations.length} file(s) over ${ctx.lineThreshold} lines`,
    ),
    violations,
  };
}

/** Rule (advisory): TODO/FIXME/HACK markers, excluding generated/vendor trees. */
function ruleTodoMarkers(ctx) {
  const ruleId = "todo_markers";
  const remediation = "resolve the marker or convert it into a tracked backlog issue (advisory)";
  const violations = [];
  for (const rel of ctx.markerSources) {
    const text = readFileIfExists(path.join(ctx.repoRoot, rel));
    if (text === null) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (TODO_MARKER_RE.test(lines[i])) {
        const marker = lines[i].match(TODO_MARKER_RE)[0];
        violations.push(
          makeViolation(ruleId, ADVISORY, rel, { line: i + 1, marker }, remediation),
        );
      }
    }
  }
  const status = violations.length === 0 ? PASS : FAIL;
  return {
    check: makeCheck(
      ruleId,
      ADVISORY,
      status,
      status === PASS
        ? "no TODO/FIXME/HACK markers in tracked source"
        : `${violations.length} TODO/FIXME/HACK marker(s)`,
    ),
    violations,
  };
}

/**
 * Rule: no prohibited live executor exists in v2. Mirrors the accepted
 * architecture invariant: no `live`-executor source file and no
 * `src/tools/safe-trade.ts` mutating tool.
 */
function ruleNoProhibitedLiveExecutor(ctx) {
  const ruleId = "no_prohibited_live_executor";
  const remediation =
    "remove the live-execution path; a live executor requires a separate accepted RFC, release plan, and human enablement";
  const violations = [];
  const liveRe =
    /(?:^|[/.-])live[/.-].*execut|execut.*[/.-]live(?:[/.-]|$)/i;
  for (const rel of ctx.allSources) {
    if (liveRe.test(rel)) {
      violations.push(makeViolation(ruleId, ZERO_TOLERANCE, rel, { liveExecutor: true }, remediation));
    }
  }
  if (fs.existsSync(path.join(ctx.repoRoot, "src/tools/safe-trade.ts"))) {
    violations.push(
      makeViolation(
        ruleId,
        ZERO_TOLERANCE,
        "src/tools/safe-trade.ts",
        { mutatingTradeTool: true },
        remediation,
      ),
    );
  }
  const status = violations.length === 0 ? PASS : FAIL;
  return {
    check: makeCheck(
      ruleId,
      ZERO_TOLERANCE,
      status,
      status === PASS ? "no prohibited live executor present" : "prohibited live executor detected",
    ),
    violations,
  };
}

/** Rule: the generated workflow-inventory doc markers are present exactly once. */
function ruleGeneratedDocMarkersPresent(ctx) {
  const ruleId = "generated_doc_markers_present";
  const rel = "docs/agentic-workflows-map.md";
  const remediation = "restore the generated markers, then run `npm run agentic:docs`";
  const text = readFileIfExists(path.join(ctx.repoRoot, rel));
  const starts = text === null ? 0 : text.split(INVENTORY_START_MARKER).length - 1;
  const ends = text === null ? 0 : text.split(INVENTORY_END_MARKER).length - 1;
  if (starts === 1 && ends === 1) {
    return {
      check: makeCheck(ruleId, ZERO_TOLERANCE, PASS, "generated inventory markers present"),
      violations: [],
    };
  }
  return {
    check: makeCheck(ruleId, ZERO_TOLERANCE, FAIL, "generated inventory markers missing or duplicated"),
    violations: [
      makeViolation(ruleId, ZERO_TOLERANCE, rel, { startMarkers: starts, endMarkers: ends }, remediation),
    ],
  };
}

// ---------------------------------------------------------------------------
// Dimensions — evidence per behavior boundary, never one opaque score
// ---------------------------------------------------------------------------

/** Ordered dimension definitions mapping to their owning rule ids. */
const DIMENSIONS = [
  { id: "policy_consistency", title: "Policy consistency", ruleIds: ["policy_valid", "duplicated_policy_literals"] },
  { id: "source_lock_consistency", title: "Source and lock consistency", ruleIds: ["workflow_sources_compiled", "workflow_imports_exist"] },
  { id: "instruction_reference_integrity", title: "Instruction and reference integrity", ruleIds: ["doc_references_resolve", "generated_doc_markers_present"] },
  { id: "architecture_integrity", title: "Architecture integrity", ruleIds: ["architecture_boundary_hotspots", "no_prohibited_live_executor"] },
  { id: "observability_coverage", title: "Observability coverage", ruleIds: ["workflow_telemetry_coverage"] },
  { id: "backlog_hygiene", title: "Backlog hygiene", ruleIds: ["opportunity_wip_over_cap"] },
  { id: "maintainability_hotspots", title: "Maintainability hotspots", ruleIds: ["source_file_size_hotspots", "todo_markers"] },
];

/** Roll a dimension up from its member checks/violations without a vanity score. */
function buildDimensions(checks, violations) {
  const checkById = new Map(checks.map((c) => [c.ruleId, c]));
  const violByRule = new Map();
  for (const v of violations) {
    violByRule.set(v.ruleId, (violByRule.get(v.ruleId) || 0) + 1);
  }
  return DIMENSIONS.map((dim) => {
    const memberChecks = dim.ruleIds
      .map((id) => checkById.get(id))
      .filter((c) => c !== undefined);
    let status = PASS;
    if (memberChecks.some((c) => c.status === FAIL)) status = FAIL;
    else if (memberChecks.length > 0 && memberChecks.every((c) => c.status === UNKNOWN)) status = UNKNOWN;
    else if (memberChecks.some((c) => c.status === UNKNOWN)) status = "partial";
    const evidence = dim.ruleIds.map((ruleId) => ({
      ruleId,
      status: checkById.get(ruleId) ? checkById.get(ruleId).status : UNKNOWN,
      violations: violByRule.get(ruleId) || 0,
    }));
    return { id: dim.id, title: dim.title, status, evidence };
  });
}

// ---------------------------------------------------------------------------
// Manifest assembly (pure) + material hash / baseline delta
// ---------------------------------------------------------------------------

/** The registry of rules in deterministic order. */
const RULES = [
  rulePolicyValid,
  ruleWorkflowSourcesCompiled,
  ruleDocReferencesResolve,
  ruleWorkflowImportsExist,
  ruleDuplicatedPolicyLiterals,
  ruleOpportunityWipOverCap,
  ruleWorkflowTelemetryCoverage,
  ruleArchitectureBoundaryHotspots,
  ruleSourceFileSizeHotspots,
  ruleTodoMarkers,
  ruleNoProhibitedLiveExecutor,
  ruleGeneratedDocMarkersPresent,
];

/**
 * Build the deterministic "material view" — the subset whose change should
 * trigger a new report. Volatile provenance (collectedAt, commit) is excluded so
 * an unchanged entropy picture produces an identical hash and thus a noop.
 */
function buildMaterialView(manifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    checks: manifest.checks
      .map((c) => ({ ruleId: c.ruleId, status: c.status, severity: c.severity }))
      .sort((a, b) => a.ruleId.localeCompare(b.ruleId, "en")),
    violations: manifest.violations
      .map((v) => ({
        ruleId: v.ruleId,
        path: v.path,
        severity: v.severity,
        evidence: v.evidence,
      }))
      .sort((a, b) => stableStringify(a).localeCompare(stableStringify(b), "en")),
    dimensions: manifest.dimensions
      .map((d) => ({ id: d.id, status: d.status }))
      .sort((a, b) => a.id.localeCompare(b.id, "en")),
  };
}

function computeMaterialHash(manifest) {
  return sha256(stableStringify(buildMaterialView(manifest)));
}

/** Read the newest published entropy-state hash from report issue bodies. */
function readPublishedHash(reportIssues) {
  const list = Array.isArray(reportIssues) ? reportIssues : [];
  const withHash = list
    .map((issue) => {
      if (!issue || typeof issue.body !== "string") return null;
      const m = issue.body.match(STATE_HASH_MARKER_RE);
      if (!m) return null;
      return { number: issue.number || 0, createdAt: issue.createdAt || "", hash: m[1].toLowerCase() };
    })
    .filter(Boolean);
  if (withHash.length === 0) return null;
  withHash.sort((a, b) => {
    const t = String(b.createdAt).localeCompare(String(a.createdAt), "en");
    return t !== 0 ? t : b.number - a.number;
  });
  return withHash[0].hash;
}

/**
 * Decide whether the current entropy picture materially differs from the last
 * published report. The published-issue hash is authoritative over cache; a
 * cache miss therefore can never suppress a report.
 */
function decideChange(input) {
  const { currentHash, publishedHash, cachedManifest, currentManifest } = input;
  const cacheHit = Boolean(
    cachedManifest &&
      publishedHash &&
      cachedManifest.materialHash &&
      cachedManifest.materialHash === publishedHash,
  );
  const changed = publishedHash === null || publishedHash === undefined
    ? true
    : publishedHash !== currentHash;
  let delta = null;
  if (cacheHit && changed) {
    delta = computeDelta(cachedManifest, currentManifest);
  }
  return { changed, cacheHit, publishedHash: publishedHash || null, delta };
}

/** Compute added/removed violation identities between a cached and current run. */
function computeDelta(cachedManifest, currentManifest) {
  const key = (v) => `${v.ruleId}::${v.path}`;
  const prev = new Set((cachedManifest.violations || []).map(key));
  const cur = new Set((currentManifest.violations || []).map(key));
  const added = [...cur].filter((k) => !prev.has(k)).sort((a, b) => a.localeCompare(b, "en"));
  const removed = [...prev].filter((k) => !cur.has(k)).sort((a, b) => a.localeCompare(b, "en"));
  return { added, removed };
}

/**
 * Assemble the full manifest from already-gathered context. Pure and
 * deterministic apart from `collectedAt`/`commit`, which are excluded from the
 * material hash. This is the seam unit tests drive directly with fixtures.
 */
function buildManifest(ctx) {
  const results = RULES.map((rule) => rule(ctx));
  const checks = results.map((r) => r.check);
  const violations = results
    .flatMap((r) => r.violations)
    .sort((a, b) => stableStringify(a).localeCompare(stableStringify(b), "en"));
  const dimensions = buildDimensions(checks, violations);

  const zeroToleranceFailures = checks.filter(
    (c) => c.severity === ZERO_TOLERANCE && c.status === FAIL,
  ).length;
  const actionable = violations.length > 0;

  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    collectedAt: ctx.collectedAt,
    commit: ctx.commit,
    sourceHashes: ctx.sourceHashes,
    monitorOps: ctx.monitorOps,
    checks,
    violations,
    dimensions,
    summary: {
      totalChecks: checks.length,
      zeroToleranceFailures,
      advisoryFindings: violations.filter((v) => v.severity === ADVISORY).length,
      actionable,
    },
    materialHash: null,
    baselineDelta: null,
  };
  manifest.materialHash = computeMaterialHash(manifest);
  return manifest;
}

// ---------------------------------------------------------------------------
// Context gathering (IO) — reads files, snapshot, and (optionally) gh
// ---------------------------------------------------------------------------

/** Instruction/doc surfaces whose local references must resolve (zero-tolerance). */
function discoverDocSurfaces(repoRoot) {
  const surfaces = new Set();
  const add = (rel) => {
    if (fs.existsSync(path.join(repoRoot, rel))) surfaces.add(rel);
  };
  for (const rel of [
    "AGENTS.md",
    ".github/copilot-instructions.md",
    "src/agent/AGENTS.md",
    "src/trading/AGENTS.md",
    "src/db/AGENTS.md",
    ".github/workflows/AGENTS.md",
    "README.md",
    "DESIGN.md",
  ]) {
    add(rel);
  }
  for (const rel of listFiles(repoRoot, ".github/agents", (r) => r.endsWith(".md"))) {
    surfaces.add(rel);
  }
  for (const tree of [
    ".github/skills",
    ".github/workflows",
    "docs",
    "specs",
  ]) {
    for (const rel of listFiles(repoRoot, tree, (r) => r.endsWith(".md"))) {
      surfaces.add(rel);
    }
  }
  return [...surfaces].sort((a, b) => a.localeCompare(b, "en"));
}

/** Prose surfaces scanned for duplicated policy literals (excludes canonical JSON). */
function discoverProseSurfaces(repoRoot) {
  const surfaces = new Set(discoverDocSurfaces(repoRoot));
  for (const rel of listFiles(repoRoot, "docs", (r) => r.endsWith(".md"))) {
    surfaces.add(rel);
  }
  for (const rel of listFiles(repoRoot, ".github/skills", (r) => r.endsWith(".md"))) {
    surfaces.add(rel);
  }
  return [...surfaces].sort((a, b) => a.localeCompare(b, "en"));
}

/**
 * Distinctive canonical policy *clauses* (regex sources, >= 12 chars) worth
 * de-duplicating. Ordinary file paths (`exactPaths`) are intentionally excluded:
 * they legitimately appear throughout prose and are not policy logic. Only the
 * routing/low-risk regex clauses encode policy that must not be copied verbatim.
 */
function collectPolicyLiterals(policy) {
  const literals = new Set();
  const security = policy.specialistRouting && policy.specialistRouting.security;
  const trading = policy.specialistRouting && policy.specialistRouting.tradingSafety;
  for (const group of [security, trading]) {
    if (!group) continue;
    for (const p of group.patterns || []) literals.add(p);
  }
  if (policy.lowRiskDocs) {
    literals.add(policy.lowRiskDocs.pathPattern);
    literals.add(policy.lowRiskDocs.sensitiveTokenPattern);
  }
  return [...literals].filter((l) => typeof l === "string" && l.length >= 12);
}

/** Resolve the commit sha from an explicit value, env, or a read-only git call. */
function resolveCommit(opts) {
  if (typeof opts.commit === "string" && opts.commit.trim() !== "") {
    return opts.commit.trim();
  }
  if (typeof process.env.GITHUB_SHA === "string" && process.env.GITHUB_SHA.trim() !== "") {
    return process.env.GITHUB_SHA.trim();
  }
  const gitRunner = typeof opts.gitRunner === "function" ? opts.gitRunner : defaultGitRunner(opts.repoRoot);
  const result = gitRunner(["rev-parse", "HEAD"]);
  if (result && result.status === 0 && typeof result.stdout === "string") {
    const sha = result.stdout.trim();
    if (/^[0-9a-f]{7,40}$/i.test(sha)) return sha;
  }
  // Commit is optional provenance metadata; an unavailable repo yields null.
  return null;
}

/** Default read-only git runner: `git <args>` with `shell: false`. */
function defaultGitRunner(cwd) {
  return function run(args) {
    const result = spawnSync("git", args, {
      cwd: cwd || process.cwd(),
      encoding: "utf8",
      shell: false,
    });
    if (result.error) return { status: 1, stdout: "", stderr: String(result.error.message) };
    return {
      status: typeof result.status === "number" ? result.status : 1,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
    };
  };
}

/** Read the supplied MonitorOps snapshot, or null when absent/unreadable. */
function loadSnapshot(snapshotPath) {
  if (!snapshotPath) return null;
  const text = readFileIfExists(snapshotPath);
  if (text === null) {
    throw new Error(`MonitorOps snapshot not found: ${snapshotPath}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`MonitorOps snapshot is not valid JSON (${snapshotPath}): ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`MonitorOps snapshot must be a JSON object: ${snapshotPath}`);
  }
  return parsed;
}

/** Build the pure-rule context (all IO resolved) from collect options. */
function buildContext(options) {
  const opts = options || {};
  const repoRoot = opts.repoRoot || factory.resolveRepoRoot();
  const workflowsDir = path.join(repoRoot, ".github", "workflows");
  const loaderPath = path.join(repoRoot, ".github", "scripts", "agentic-policy.cjs");
  const loadAgenticPolicy = fs.existsSync(loaderPath)
    ? require(loaderPath).loadAgenticPolicy
    : () => {
        throw new Error("policy loader is missing");
      };

  const inventory = fs.existsSync(workflowsDir)
    ? factory.buildWorkflowInventory(workflowsDir)
    : [];

  // Policy literals for the duplication rule (best-effort; a broken policy is
  // caught by rulePolicyValid, so this stays empty rather than throwing).
  let policyLiterals = [];
  const policyPath = path.join(repoRoot, ".github", "agentic-policy.json");
  const policyText = readFileIfExists(policyPath);
  if (policyText !== null) {
    const parsedPolicy = factory.parseJsonSafe(policyText, null);
    if (parsedPolicy) policyLiterals = collectPolicyLiterals(parsedPolicy);
  }

  const snapshot = opts.snapshot !== undefined ? opts.snapshot : loadSnapshot(opts.snapshotPath);

  const tsFilter = (rel) => /\.(ts|tsx)$/.test(rel);
  const skipDirs = new Set(["node_modules", ".next", "dist", "build", "coverage"]);
  const appSources = listFiles(repoRoot, "src", tsFilter, skipDirs);
  const tradingSources = listFiles(repoRoot, "src/trading", tsFilter, skipDirs);
  // This collector defines the marker vocabulary it scans for, so it is excluded
  // from the marker scan to avoid a self-referential false positive.
  const selfRel = path.relative(repoRoot, __filename).split(path.sep).join("/");
  const markerSources = listFiles(
    repoRoot,
    "src",
    (rel) => /\.(ts|tsx|cjs|mjs|js)$/.test(rel),
    skipDirs,
  )
    .concat(
      listFiles(
        repoRoot,
        "scripts",
        (rel) => /\.(ts|tsx|cjs|mjs|js)$/.test(rel) && !rel.endsWith(".lock.yml"),
        skipDirs,
      ),
    )
    .filter((rel) => rel !== selfRel);

  return {
    repoRoot,
    collectedAt: (opts.now instanceof Date ? opts.now : new Date(opts.now || Date.now())).toISOString(),
    commit: resolveCommit({ ...opts, repoRoot }),
    loadAgenticPolicy,
    inventory,
    requiredSupportFiles: (opts.requiredSupportFiles || [
      ".github/workflows/agentic_commands.yml",
      ".github/workflows/agentics-maintenance.yml",
    ]).slice(),
    docSurfaces: discoverDocSurfaces(repoRoot),
    proseSurfaces: discoverProseSurfaces(repoRoot),
    policyLiterals,
    snapshot: snapshot || null,
    tradingSources,
    appSources,
    allSources: appSources,
    markerSources,
    lineThreshold: Number.isFinite(opts.lineThreshold) ? opts.lineThreshold : SOURCE_FILE_LINE_THRESHOLD,
    sourceHashes: null,
    monitorOps: null,
  };
}

/** Compute provenance source hashes without persisting file contents. */
function computeSourceHashes(ctx) {
  const workflowSourcesHash = sha256(
    ctx.inventory.map((w) => `${w.id}:${w.sourceHash}`).join("\n"),
  );
  const workflowLocksHash = sha256(
    ctx.inventory.map((w) => `${w.id}:${w.lockHash || "none"}`).join("\n"),
  );
  const policyHash = (() => {
    const text = readFileIfExists(path.join(ctx.repoRoot, ".github", "agentic-policy.json"));
    return text === null ? null : sha256(text);
  })();
  const instructionParts = [];
  for (const rel of ctx.docSurfaces) {
    const text = readFileIfExists(path.join(ctx.repoRoot, rel));
    if (text !== null) instructionParts.push(`${rel}:${sha256(text)}`);
  }
  return {
    policy: policyHash,
    workflowSources: workflowSourcesHash,
    workflowLocks: workflowLocksHash,
    instructions: sha256(instructionParts.join("\n")),
  };
}

function summarizeMonitorOps(snapshot) {
  if (!snapshot) {
    return { available: false, generatedAt: null, materialHash: null };
  }
  const materialState = snapshot.materialState || {};
  return {
    available: true,
    generatedAt: typeof snapshot.generatedAt === "string" ? snapshot.generatedAt : null,
    mode: typeof snapshot.mode === "string" ? snapshot.mode : null,
    materialHash: typeof materialState.hash === "string" ? materialState.hash : null,
  };
}

// ---------------------------------------------------------------------------
// gh report-issue reading (read-only; own report series only)
// ---------------------------------------------------------------------------

function ghReportIssues(runner, titlePrefix) {
  return factory.runJson(
    runner,
    [
      "issue",
      "list",
      "--state",
      "all",
      "--search",
      `${titlePrefix} in:title`,
      "--limit",
      "20",
      "--json",
      "number,body,createdAt",
    ],
    "gh issue list for published entropy state",
  );
}

// ---------------------------------------------------------------------------
// Top-level collection orchestrator
// ---------------------------------------------------------------------------

/**
 * Collect the full entropy manifest. Accepts injected seams (`snapshot`,
 * `runner`, `gitRunner`, `now`, `repoRoot`) so integration paths and unit tests
 * share one code path. Returns `{ manifest, decision, cacheRecord }`.
 */
function collect(options) {
  const opts = options || {};
  const ctx = buildContext(opts);
  ctx.sourceHashes = computeSourceHashes(ctx);
  ctx.monitorOps = summarizeMonitorOps(ctx.snapshot);

  const manifest = buildManifest(ctx);

  // Published-hash reading is only performed when a report prefix is supplied
  // (workflow mode). Local `--check` never contacts GitHub.
  let publishedHash = null;
  if (opts.reportTitlePrefix) {
    const runner = opts.runner || factory.createRunner({ cwd: ctx.repoRoot });
    publishedHash = readPublishedHash(ghReportIssues(runner, opts.reportTitlePrefix));
  } else if (typeof opts.publishedHash === "string") {
    publishedHash = opts.publishedHash;
  }

  const cache = loadCache(opts.cachePath, opts.cache);
  const cacheRepresentsPublished = Boolean(
    cache && publishedHash && cache.materialHash && cache.materialHash === publishedHash,
  );

  const decision = decideChange({
    currentHash: manifest.materialHash,
    publishedHash,
    cachedManifest: cacheRepresentsPublished ? cache : null,
    currentManifest: manifest,
  });

  manifest.baselineDelta = {
    publishedHash: decision.publishedHash,
    cacheHash: cache && cache.materialHash ? cache.materialHash : null,
    changed: decision.changed,
    cacheHit: decision.cacheHit,
    delta: decision.delta,
  };
  manifest.summary.shouldReport = decision.changed && manifest.summary.actionable;

  const cacheRecord = buildCacheRecord(manifest);
  return { manifest, decision, cacheRecord };
}

function loadCache(cachePath, inlineCache) {
  if (inlineCache !== undefined) return inlineCache;
  if (!cachePath || !fs.existsSync(cachePath)) return null;
  return factory.parseJsonSafe(fs.readFileSync(cachePath, "utf8"), null);
}

function buildCacheRecord(manifest) {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    savedAt: manifest.collectedAt,
    materialHash: manifest.materialHash,
    violations: manifest.violations.map((v) => ({ ruleId: v.ruleId, path: v.path })),
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { workflowMode: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--out") args.out = argv[++i];
    else if (a === "--snapshot") args.snapshot = argv[++i];
    else if (a === "--cache") args.cache = argv[++i];
    else if (a === "--report-prefix") args.reportPrefix = argv[++i];
    else if (a === "--workflow-mode") args.workflowMode = true;
    else if (a === "--workflow-root") args.workflowRoot = argv[++i];
    else if (a === "--check") args.check = true;
    else if (a === "--now") args.now = argv[++i];
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

const HELP = `Agentic entropy collector (report-only)

Usage:
  node scripts/agentic/collect-agentic-entropy.cjs [options]

Options:
  --out <path>            Write the JSON manifest to this path (else stdout).
  --snapshot <path>       MonitorOps factory-health snapshot to reuse (optional).
  --cache <path>          Read prior + write updated cache record here.
  --report-prefix <s>     Report title prefix used to read the published hash (gh).
  --workflow-mode         Enforce that --out/--cache resolve under /tmp/gh-aw/.
  --workflow-root <dir>   Override the workflow-mode root (default /tmp/gh-aw).
  --check                 Exit non-zero if any zero-tolerance rule fails (no gh).
  --now <iso>             Override the collection instant (testing only).
  -h, --help              Show this help.

The collector is read-only toward the repo and GitHub and only writes the paths
it is given. Advisory findings never fail --check.`;

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

  const pathOpts = { workflowMode: args.workflowMode, workflowRoot: args.workflowRoot };
  let outPath;
  let cachePath;
  try {
    outPath = args.out ? factory.validateOutputPath(args.out, pathOpts) : null;
    cachePath = args.cache ? factory.validateOutputPath(args.cache, pathOpts) : null;
  } catch (error) {
    process.stderr.write(`error: ${(error && error.message) || error}\n`);
    return 2;
  }

  let manifest;
  try {
    ({ manifest } = collect({
      now: args.now ? new Date(args.now) : d.now || new Date(),
      repoRoot: d.repoRoot,
      snapshot: d.snapshot,
      snapshotPath: args.snapshot,
      cachePath,
      cache: d.cache,
      reportTitlePrefix: args.reportPrefix,
      runner: d.runner,
      gitRunner: d.gitRunner,
      publishedHash: d.publishedHash,
      requiredSupportFiles: d.requiredSupportFiles,
      lineThreshold: d.lineThreshold,
    }));
  } catch (error) {
    process.stderr.write(
      `error: entropy collection failed: ${(error && error.message) || error}\n`,
    );
    return 1;
  }

  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, json);
    process.stdout.write(
      `entropy manifest written: ${outPath} (zeroToleranceFailures=${manifest.summary.zeroToleranceFailures}, actionable=${manifest.summary.actionable})\n`,
    );
  } else if (!args.check) {
    // Default (non-check) run streams the manifest; a check run stays concise.
    process.stdout.write(json);
  }
  if (cachePath) {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, `${JSON.stringify(buildCacheRecord(manifest), null, 2)}\n`);
  }

  if (args.check) {
    if (manifest.summary.zeroToleranceFailures > 0) {
      process.stderr.write("\n✗ Zero-tolerance entropy assertions failed:\n");
      for (const v of manifest.violations) {
        if (v.severity !== ZERO_TOLERANCE) continue;
        process.stderr.write(`  ✗ ${v.ruleId}: ${v.path}\n      Fix: ${v.remediation}\n`);
      }
      process.stderr.write(
        "\n  Owning gate: scripts/agentic/collect-agentic-entropy.cjs (npm run entropy:check)\n",
      );
      return 1;
    }
    process.stdout.write(
      `✓ Entropy zero-tolerance checks passed (${manifest.summary.advisoryFindings} advisory finding(s) reported, not blocking)\n`,
    );
  }
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = {
  MANIFEST_SCHEMA_VERSION,
  STATE_HASH_MARKER_PREFIX,
  SOURCE_FILE_LINE_THRESHOLD,
  ZERO_TOLERANCE,
  ADVISORY,
  PASS,
  FAIL,
  UNKNOWN,
  DIMENSIONS,
  RULES,
  // Pure rules (for targeted tests)
  rulePolicyValid,
  ruleWorkflowSourcesCompiled,
  ruleDocReferencesResolve,
  ruleWorkflowImportsExist,
  ruleDuplicatedPolicyLiterals,
  ruleOpportunityWipOverCap,
  ruleWorkflowTelemetryCoverage,
  ruleArchitectureBoundaryHotspots,
  ruleSourceFileSizeHotspots,
  ruleTodoMarkers,
  ruleNoProhibitedLiveExecutor,
  ruleGeneratedDocMarkersPresent,
  // Helpers
  parseImports,
  extractLocalMarkdownTargets,
  collectPolicyLiterals,
  buildDimensions,
  resolveCommit,
  defaultGitRunner,
  buildMaterialView,
  computeMaterialHash,
  readPublishedHash,
  decideChange,
  computeDelta,
  buildManifest,
  buildContext,
  computeSourceHashes,
  summarizeMonitorOps,
  loadSnapshot,
  loadCache,
  buildCacheRecord,
  collect,
  parseArgs,
  main,
};
