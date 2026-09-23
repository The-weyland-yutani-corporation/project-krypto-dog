/**
 * MonitorOps deterministic factory-health collector.
 *
 * This module is intentionally CommonJS and dependency-free so a GH-AW workflow
 * can run it as `node scripts/agentic/collect-factory-health.cjs` inside a
 * trusted default-branch checkout without `npm ci`, `npx`, or any runtime
 * package. It is the deterministic layer that normalizes every active GH-AW
 * workflow, its usage, factory throughput, and configured-threshold state into a
 * single versioned JSON snapshot *before* any agent summarizes it.
 *
 * Design invariants:
 *
 *   - Pure functions do the normalization and take already-parsed data, so unit
 *     tests never touch GitHub. All GitHub access flows through one injected
 *     command runner (`createRunner`), and the real runner uses `spawnSync` with
 *     `shell: false` — never a shell string — so nothing this collector receives
 *     is interpolated into a shell.
 *   - Missing telemetry is `null`, never `0`. A workflow that simply has not run
 *     yet is represented with `runs: 0` and `null` cost/token fields; safe-output
 *     and correction metrics are `null` until an authoritative source exists.
 *   - The published state hash embedded in prior GitHub report issues
 *     (`<!-- factory-state-hash: ... -->`) is the authoritative source of the
 *     last published material state. `cache-memory` only stores snapshots and
 *     watermarks. A cache miss (or a failed prior output) therefore can never
 *     falsely suppress the next report.
 *   - When invoked by a workflow, every output/cache path must resolve under
 *     `/tmp/gh-aw/`. The collector is read-only toward GitHub and only writes the
 *     JSON/cache paths it was explicitly asked to write.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const reads = require("./factory-read.cjs");
const reports = require("./factory-report.cjs");
const { enrichUsageRows } = require("./factory-usage.cjs");

const SNAPSHOT_SCHEMA_VERSION = 1;

/** Marker embedded in report issue bodies; authoritative published-hash source. */
const STATE_HASH_MARKER_PREFIX = "<!-- factory-state-hash:";
const STATE_HASH_MARKER_RE = /<!--\s*factory-state-hash:\s*([a-f0-9]{64})\s*-->/i;

/** Files under `.github/workflows` that are not GH-AW compiled sources. */
const NON_SOURCE_MARKDOWN = new Set(["AGENTS.md"]);

/** Only these commands may be spawned by the real runner. */
const ALLOWED_COMMANDS = new Set(["gh"]);

/** Conclusions treated as a workflow-run failure. Kept in sync with policy. */
const DEFAULT_FAILING_CONCLUSIONS = [
  "cancelled",
  "failure",
  "startup_failure",
  "timed_out",
];

/**
 * Non-GH-AW Actions workflows MonitorOps still observes for the eval/harness
 * failure threshold. These are `.yml` sources (not `*.md` GH-AW), so they never
 * appear in the GH-AW inventory but their conclusions are authoritative
 * evidence of an eval or harness-integrity regression.
 */
const DEFAULT_AUXILIARY_WORKFLOWS = ["agentic-evals.yml", "ci.yml"];

// ---------------------------------------------------------------------------
// Repo location + safe path handling
// ---------------------------------------------------------------------------

/** Walk up from a start dir to the nearest repo root (package.json + .github). */
function resolveRepoRoot(startDir) {
  let dir = startDir || process.cwd();
  for (;;) {
    if (
      fs.existsSync(path.join(dir, "package.json")) &&
      fs.existsSync(path.join(dir, ".github", "workflows"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        "Unable to locate repository root (expected package.json and .github/workflows) from " +
          (startDir || process.cwd()),
      );
    }
    dir = parent;
  }
}

/**
 * Validate that a requested output/cache path is safe to write.
 *
 * When `workflowMode` is true (the collector was invoked inside a GH-AW run),
 * the resolved path must live under `/tmp/gh-aw/`. Outside workflow mode (local
 * developer use) any absolute or repo-relative path is allowed, but the
 * canonical path is still returned so callers never act on an un-normalized
 * string.
 */
function validateOutputPath(target, options) {
  const opts = options || {};
  if (typeof target !== "string" || target.trim() === "") {
    throw new Error("output path must be a non-empty string");
  }
  const resolved = path.resolve(target);
  if (opts.workflowMode) {
    const root = path.resolve(opts.workflowRoot || "/tmp/gh-aw");
    const rel = path.relative(root, resolved);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(
        `refusing to write outside ${root} in workflow mode: ${resolved}`,
      );
    }
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Injected command runner
// ---------------------------------------------------------------------------

/**
 * Build the real, read-only command runner. It only ever spawns an allowlisted
 * binary with an argv array (`shell: false`), so no argument is interpreted by a
 * shell. Returns `{ status, stdout, stderr }`; callers decide how to react to a
 * non-zero status (fail loud) rather than the runner swallowing errors.
 */
function createRunner(options) {
  const opts = options || {};
  return function run(command, args) {
    if (!ALLOWED_COMMANDS.has(command)) {
      throw new Error(`command not allowed: ${command}`);
    }
    if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
      throw new Error(`invalid argv for ${command}: expected string array`);
    }
    const result = spawnSync(command, args, {
      cwd: opts.cwd || process.cwd(),
      encoding: "utf8",
      shell: false,
      maxBuffer: 64 * 1024 * 1024,
      env: opts.env || process.env,
    });
    if (result.error) {
      return { status: 1, stdout: "", stderr: String(result.error.message) };
    }
    return {
      status: typeof result.status === "number" ? result.status : 1,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
    };
  };
}

/** Parse JSON from a runner result, returning `fallback` on any failure. */
function parseJsonSafe(text, fallback) {
  if (typeof text !== "string" || text.trim() === "") return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function runJson(runner, args, label) {
  const result = runner("gh", args);
  if (result.status !== 0) {
    throw new Error(
      `${label} failed (${result.status}): ${result.stderr || "no error output"}`,
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Explicit closed UTC windows
// ---------------------------------------------------------------------------

/**
 * Compute the explicit closed UTC window for a collection mode.
 *
 *   - `daily`      → the last 24 full hours ending at the run start.
 *   - `governance` → the last 7 full days ending at the run start.
 *
 * "Full" means we truncate the run-start instant down to the top of the hour
 * (daily) or the start of the UTC day (governance) so the window is a stable,
 * closed interval that does not depend on sub-hour jitter between runs.
 */
function computeWindow(mode, nowInput) {
  const now = nowInput instanceof Date ? nowInput : new Date(nowInput);
  if (Number.isNaN(now.getTime())) {
    throw new Error("computeWindow: invalid `now`");
  }
  let end;
  let days;
  if (mode === "daily") {
    end = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        now.getUTCHours(),
      ),
    );
    days = 1;
  } else if (mode === "governance") {
    end = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    days = 7;
  } else {
    throw new Error(`computeWindow: unknown mode "${mode}"`);
  }
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  return {
    mode,
    days,
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

/** True when an ISO timestamp falls in `[start, end)`. Unknown → false. */
function isWithinWindow(iso, window) {
  if (typeof iso !== "string") return false;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  return t >= Date.parse(window.start) && t < Date.parse(window.end);
}

// ---------------------------------------------------------------------------
// Workflow source inventory (dependency-free frontmatter reading)
// ---------------------------------------------------------------------------

/** List GH-AW source workflow basenames (excluding AGENTS), sorted. */
function listWorkflowSources(workflowsDir) {
  return fs
    .readdirSync(workflowsDir)
    .filter((name) => name.endsWith(".md") && !NON_SOURCE_MARKDOWN.has(name))
    .map((name) => name.slice(0, -".md".length))
    .sort((a, b) => a.localeCompare(b, "en"));
}

/** Split a workflow markdown file into its raw frontmatter block and body. */
function splitFrontmatter(source) {
  if (!source.startsWith("---\n") && !source.startsWith("---\r\n")) {
    throw new Error("missing opening `---` frontmatter fence");
  }
  const rest = source.slice(source.indexOf("\n") + 1);
  const close = rest.match(/^---[ \t]*(?:\r?\n|$)/m);
  if (!close || close.index === undefined) {
    throw new Error("unterminated frontmatter block");
  }
  return {
    frontmatter: rest.slice(0, close.index),
    body: rest.slice(close.index + close[0].length),
  };
}

/**
 * Extract only the inventory fields MonitorOps needs from a workflow source,
 * without a YAML dependency. This is deliberately narrow and line-oriented:
 *
 *   - `active`          — the source declares at least one `on:` trigger.
 *   - `perRunCreditCap` — `max-ai-credits` (numeric) or null.
 *   - `perDayCreditCap` — `max-daily-ai-credits` (numeric) or null.
 *   - `safeOutputs`     — declared safe-output kinds (sorted).
 *
 * A GH-AW source is "active" whenever it has an `on:` block with any trigger.
 * Every source here is compiled to a lock; `active` describes whether GitHub
 * will ever schedule/trigger it, which is what "account for every active
 * workflow" requires.
 */
function parseWorkflowSource(id, text) {
  const { frontmatter } = splitFrontmatter(text);
  const lines = frontmatter.split(/\r?\n/);

  const perRunCreditCap = readTopLevelNumber(lines, "max-ai-credits");
  const perDayCreditCap = readTopLevelNumber(lines, "max-daily-ai-credits");
  const safeOutputs = readSafeOutputKinds(lines);
  const active = hasTriggers(lines);

  return {
    id,
    active,
    perRunCreditCap,
    perDayCreditCap,
    safeOutputs,
  };
}

/** Indentation width (in spaces) of a frontmatter line. */
function indentOf(line) {
  const m = line.match(/^(\s*)/);
  return m ? m[1].replace(/\t/g, "  ").length : 0;
}

/** Read a top-level `key: <number>` from frontmatter lines; null when absent. */
function readTopLevelNumber(lines, key) {
  for (const line of lines) {
    if (indentOf(line) !== 0) continue;
    const m = line.match(new RegExp(`^${key}:\\s*(-?\\d+(?:\\.\\d+)?)\\s*$`));
    if (m) {
      const n = Number(m[1]);
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

/** Does the frontmatter declare an `on:` block with at least one trigger key? */
function hasTriggers(lines) {
  let inOn = false;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const indent = indentOf(line);
    if (indent === 0) {
      inOn = /^on:\s*(.*)$/.test(line);
      if (inOn) {
        const inline = line.replace(/^on:\s*/, "").trim();
        // `on: push` or `on: workflow_dispatch` inline form.
        if (inline !== "" && !inline.startsWith("#")) return true;
      }
      continue;
    }
    if (inOn && indent > 0) {
      // First nested, non-comment key under `on:` is a trigger.
      if (!line.trim().startsWith("#")) return true;
    }
  }
  return false;
}

/**
 * Collect the safe-output *kind* keys under a top-level `safe-outputs:` block.
 * Configuration knobs (scalars) and known config keys are excluded so a nested
 * `max: 1` is never mistaken for an output kind.
 */
const SAFE_OUTPUT_CONFIG_KEYS = new Set([
  "allowed-domains",
  "allowed-github-references",
  "env",
  "github-token",
  "max-patch-files",
  "max-patch-size",
  "mentions",
  "messages",
  "runs-on",
  "staged",
  "threat-detection",
]);

function readSafeOutputKinds(lines) {
  const kinds = [];
  let inBlock = false;
  let blockIndent = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const indent = indentOf(line);
    if (indent === 0) {
      inBlock = /^safe-outputs:\s*$/.test(line);
      continue;
    }
    if (!inBlock) continue;
    if (blockIndent === null) blockIndent = indent;
    if (indent !== blockIndent) continue; // only direct children are kinds
    const m = line.match(/^\s*([a-z][a-z0-9-]*):/i);
    if (!m) continue;
    const key = m[1];
    if (SAFE_OUTPUT_CONFIG_KEYS.has(key)) continue;
    // A scalar value on the same line (e.g. `staged: true`) is config, not a
    // kind; kinds are either bare (`noop:`) or open a nested mapping.
    const value = line.slice(line.indexOf(":") + 1).trim();
    if (value !== "" && value !== "|" && value !== ">") continue;
    kinds.push(key);
  }
  return Array.from(new Set(kinds)).sort((a, b) => a.localeCompare(b, "en"));
}

/** SHA-256 hex of a UTF-8 string. */
function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/** Build the static per-workflow inventory (no GitHub calls). */
function buildWorkflowInventory(workflowsDir) {
  const ids = listWorkflowSources(workflowsDir);
  return ids.map((id) => {
    const sourcePath = path.join(workflowsDir, `${id}.md`);
    const lockPath = path.join(workflowsDir, `${id}.lock.yml`);
    const text = fs.readFileSync(sourcePath, "utf8");
    const parsed = parseWorkflowSource(id, text);
    const compiled = fs.existsSync(lockPath);
    return {
      id,
      sourcePath: path.posix.join(".github", "workflows", `${id}.md`),
      lockPath: path.posix.join(".github", "workflows", `${id}.lock.yml`),
      compiled,
      active: parsed.active,
      perRunCreditCap: parsed.perRunCreditCap,
      perDayCreditCap: parsed.perDayCreditCap,
      safeOutputs: parsed.safeOutputs,
      sourceHash: sha256(text),
      lockHash: compiled ? sha256(fs.readFileSync(lockPath, "utf8")) : null,
    };
  });
}

// ---------------------------------------------------------------------------
// gh aw status normalization
// ---------------------------------------------------------------------------

/**
 * Normalize `gh aw status --json` into a map keyed by workflow id. Tolerant of
 * either an array payload or `{ workflows: [...] }`. Unknown fields collapse to
 * conservative defaults; nothing is invented.
 */
function normalizeStatus(statusJson) {
  const rows = Array.isArray(statusJson)
    ? statusJson
    : statusJson && Array.isArray(statusJson.workflows)
      ? statusJson.workflows
      : [];
  const byId = {};
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const id = deriveWorkflowId(row);
    if (!id) continue;
    const compiledValue =
      typeof row.compiled === "string" ? row.compiled.toLowerCase() : null;
    const statusValue =
      typeof row.status === "string" ? row.status.toLowerCase() : null;
    const stateValue =
      typeof row.state === "string" ? row.state.toLowerCase() : null;
    byId[id] = {
      compiled:
       typeof row.compiled === "boolean"
         ? row.compiled
         : compiledValue === "yes"
           ? true
           : compiledValue === "no"
            ? false
            : statusValue === "compiled" || statusValue === "up-to-date"
               ? true
               : null,
      enabled:
       typeof row.enabled === "boolean"
         ? row.enabled
         : statusValue === "active" ||
            statusValue === "enabled" ||
            stateValue === "active" ||
            stateValue === "enabled"
           ? true
           : statusValue === "disabled" || (stateValue && stateValue.startsWith("disabled"))
            ? false
            : null,
    };
  }
  return byId;
}

/** Derive a stable workflow id from a heterogeneous status/logs row. */
function deriveWorkflowId(row) {
  const candidate = [
    row.workflowPath, row.workflow_path, row.path, row.workflow,
    row.workflowId, row.workflow_id, row.id, row.workflowName,
    row.workflow_name, row.name, row.file,
  ].find((value) => typeof value === "string" && value.trim() !== "");
  if (typeof candidate !== "string" || candidate.trim() === "") return null;
  let value = reads.normalizeWorkflowPath(candidate.trim());
  const slash = value.lastIndexOf("/");
  if (slash !== -1) value = value.slice(slash + 1);
  value = value.replace(/\.lock\.yml$/, "").replace(/\.(md|yml|yaml)$/, "");
  return value;
}

// ---------------------------------------------------------------------------
// gh aw logs usage normalization (null-not-zero telemetry)
// ---------------------------------------------------------------------------

/**
 * Normalize usage rows from `gh aw logs --json` into per-workflow aggregates
 * over the closed window. Every workflow id in `knownIds` gets an entry, so a
 * zero-run workflow is represented (`runs: 0`) rather than omitted.
 *
 * Cost/token rules:
 *   - `aiCredits` is numeric only when at least one run reported a numeric
 *     credit value; otherwise `null`.
 *   - `tokens` is `null` when missing OR reported only as an unavailable `0`
 *     (an all-zero, no-signal token field is treated as "unavailable", never a
 *     real zero).
 *   - Partial metric coverage exposes observed totals separately; it never
 *     presents a sampled cost as the complete window's cost.
 */
function normalizeUsage(logsJson, knownIds, window, options) {
  const opts = options || {};
  const failing = new Set(opts.failingConclusions || DEFAULT_FAILING_CONCLUSIONS);
  const runs = extractRunRows(logsJson).slice().sort((a, b) =>
    Date.parse(a.createdAt || a.created_at || a.startedAt || a.timestamp || "") -
    Date.parse(b.createdAt || b.created_at || b.startedAt || b.timestamp || ""),
  );
  const seen = new Set();

  const acc = {};
  for (const id of knownIds) acc[id] = freshUsage();

  for (const run of runs) {
    const id = deriveWorkflowId(run);
    if (!id || !(id in acc)) continue;
    const when = run.createdAt || run.created_at || run.startedAt || run.timestamp;
    const entry = acc[id];
    if (window && (!when || Number.isNaN(Date.parse(when)))) {
      entry._invalidTimestamps += 1;
      continue;
    }
    if (window && !isWithinWindow(when, window)) continue;
    const runId = run.databaseId || run.run_id || (typeof run.id === "number" ? run.id : null);
    const runKey = runId ? `${id}:${runId}:${run.run_attempt || 1}` : null;
    if (runKey && seen.has(runKey)) continue;
    if (runKey) seen.add(runKey);
    entry.runs += 1;
    if (runId) entry._evidence.push({
      runId, sha: run.head_sha || null, path: reads.normalizeWorkflowPath(run.path || run.workflow_path || null),
      headBranch: run.head_branch ?? run.headBranch ?? run.branch ?? null,
      conclusion: normalizeConclusion(run), createdAt: when, attempt: run.run_attempt || 1,
    });

    const conclusion = normalizeConclusion(run);
    if (conclusion) {
      entry.conclusions[conclusion] = (entry.conclusions[conclusion] || 0) + 1;
      entry._sequence.push(failing.has(conclusion) ? "fail" : "ok");
    }

    const duration = numericOrNull(
      run.durationSeconds != null
        ? run.durationSeconds
        : run.duration_seconds != null
          ? run.duration_seconds
          : parseDurationSeconds(run.duration),
    );
    if (duration != null) {
      entry._durationSeconds = (entry._durationSeconds || 0) + duration;
      entry._durationRows += 1;
    }

    const credits = numericOrNull(
      run.aiCredits != null
        ? run.aiCredits
        : run.ai_credits != null
          ? run.ai_credits
          : run.aic,
    );
    if (credits != null) {
      entry._aiCredits = (entry._aiCredits || 0) + credits;
      entry._costRows += 1;
      if (entry.maxRunAiCredits == null || credits > entry.maxRunAiCredits) {
        entry.maxRunAiCredits = credits;
      }
    }

    const tokens = numericOrNull(
      run.totalTokens != null ? run.totalTokens : run.total_tokens,
    );
    if (tokens != null && tokens > 0) {
      entry._tokens = (entry._tokens || 0) + tokens;
      entry._tokenRows += 1;
    }
    for (const [field, keys] of [
      ["safeOutputOutcomes", ["succeeded", "failed", "noop"]],
      ["selfHeal", ["repairCommits", "exhausted"]],
    ]) {
      const value = run[field];
      if (value && keys.every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0)) {
        if (!entry[field]) entry[field] = Object.fromEntries(keys.map((key) => [key, 0]));
        for (const key of keys) entry[field][key] += value[key];
        entry._metricRows[field] = (entry._metricRows[field] || 0) + 1;
      }
    }
  }

  // Finalize: convert internal accumulators to null-not-zero public shape.
  const out = {};
  for (const id of knownIds) {
    const e = acc[id];
    out[id] = {
      runs: e._invalidTimestamps ? null : e.runs,
      observedRuns: e.runs,
      invalidTimestampRuns: e._invalidTimestamps,
      conclusions: e.conclusions,
      repeatedFailures: countRepeatedFailures(e._sequence),
      durationSecondsTotal: e._durationRows === e.runs ? e._durationSeconds : null,
      aiCredits: e._costRows === e.runs ? e._aiCredits : null,
      observedAiCredits: e._aiCredits,
      maxRunAiCredits: e.maxRunAiCredits,
      tokens: e._tokenRows === e.runs ? e._tokens : null,
      safeOutputOutcomes: e._metricRows.safeOutputOutcomes === e.runs ? e.safeOutputOutcomes : null,
      corrections: null,
      selfHeal: e._metricRows.selfHeal === e.runs ? e.selfHeal : null,
      metricCoverage: { costRuns: e._costRows, tokenRuns: e._tokenRows, ...e._metricRows },
      evidence: e._evidence,
    };
  }
  return out;
}

function freshUsage() {
  return {
    runs: 0,
    conclusions: {},
    maxRunAiCredits: null,
    _sequence: [],
    _durationSeconds: null,
    _aiCredits: null,
    _tokens: null,
    _invalidTimestamps: 0,
    _durationRows: 0,
    _costRows: 0,
    _tokenRows: 0,
    _metricRows: {},
    safeOutputOutcomes: null,
    selfHeal: null,
    _evidence: [],
  };
}

/** Extract run rows from a heterogeneous `gh aw logs --json` payload. */
function extractRunRows(logsJson) {
  if (Array.isArray(logsJson)) return logsJson;
  if (logsJson && Array.isArray(logsJson.runs)) return logsJson.runs;
  if (logsJson && Array.isArray(logsJson.workflows)) {
    // Some shapes nest runs under each workflow.
    const flat = [];
    for (const wf of logsJson.workflows) {
      const id = deriveWorkflowId(wf);
      const wfRuns = Array.isArray(wf.runs) ? wf.runs : [];
      for (const r of wfRuns) flat.push(Object.assign({ workflow: id }, r));
    }
    return flat;
  }
  return [];
}

function normalizeConclusion(run) {
  const raw = run.conclusion || run.result || run.status;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  return raw.trim().toLowerCase();
}

function numericOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseDurationSeconds(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const compact = value.trim().toLowerCase();
  const match = compact.match(
    /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/,
  );
  if (!match || (!match[1] && !match[2] && !match[3])) return null;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  const total = hours * 3600 + minutes * 60 + seconds;
  return Number.isFinite(total) ? total : null;
}

/** Longest run of consecutive `fail` markers in chronological order. */
function countRepeatedFailures(sequence) {
  let max = 0;
  let cur = 0;
  for (const marker of sequence) {
    if (marker === "fail") {
      cur += 1;
      if (cur > max) max = cur;
    } else {
      cur = 0;
    }
  }
  return max;
}

// ---------------------------------------------------------------------------
// Issue / PR throughput normalization (no raw bodies persisted)
// ---------------------------------------------------------------------------

/**
 * Normalize issue data into throughput + WIP fields without persisting raw
 * bodies. Only structured, non-sensitive fields (number, labels, timestamps,
 * age) are kept.
 */
function normalizeIssues(issues, window, policy, nowInput) {
  const now = nowInput instanceof Date ? nowInput : new Date(nowInput);
  const list = Array.isArray(issues) ? issues : [];
  const wipCap =
    policy && policy.wip && Number.isFinite(policy.wip.maxOpenActionableOpportunities)
      ? policy.wip.maxOpenActionableOpportunities
      : null;
  const blockedLabel =
    policy && policy.labels && policy.labels.blocked ? policy.labels.blocked : "blocked";

  let openedInWindow = 0;
  let closedInWindow = 0;
  let openActionableOpportunities = 0;
  let reportOpenedInWindow = 0;
  let reportClosedInWindow = 0;
  let workOpenedInWindow = 0;
  let workClosedInWindow = 0;
  const staleWip = [];
  const blocked = [];

  for (const issue of list) {
    if (!issue || typeof issue !== "object") continue;
    if (issue.pull_request) continue; // gh issue list can include PRs
    const labels = normalizeLabels(issue.labels);
    const state = typeof issue.state === "string" ? issue.state.toLowerCase() : "";
    const createdAt = issue.createdAt || issue.created_at;
    const closedAt = issue.closedAt || issue.closed_at;
    const updatedAt = issue.updatedAt || issue.updated_at;

    if (createdAt && isWithinWindow(createdAt, window)) openedInWindow += 1;
    if (closedAt && isWithinWindow(closedAt, window)) closedInWindow += 1;
    const isReport = labels.includes("report") || labels.includes("factory-control") ||
      labels.includes("factory:goal");
    if (createdAt && isWithinWindow(createdAt, window)) {
      if (isReport) reportOpenedInWindow += 1;
      else workOpenedInWindow += 1;
    }
    if (closedAt && isWithinWindow(closedAt, window)) {
      if (isReport) reportClosedInWindow += 1;
      else workClosedInWindow += 1;
    }

    if (state === "open") {
      const isOpportunity = labels.includes("opportunity");
      const isBlocked = labels.includes(blockedLabel);
      if (isOpportunity && !isBlocked) openActionableOpportunities += 1;
      if (isBlocked) {
        blocked.push({ number: issue.number, labels });
      }
      const wipLabels = labels.filter(
        (l) => l === "in_progress" || l === "ready-for-ai-dev",
      );
      if (wipLabels.length > 0) {
        const ageDays = ageInDays(createdAt, now);
        if (ageDays != null && ageDays > 5) {
          staleWip.push({ number: issue.number, ageDays, labels: wipLabels });
        }
      }
    }
    void updatedAt;
  }

  staleWip.sort((a, b) => a.number - b.number);
  blocked.sort((a, b) => a.number - b.number);

  return {
    wipCap,
    openActionableOpportunities,
    openedInWindow,
    closedInWindow,
    netOpened: openedInWindow - closedInWindow,
    reportOpenedInWindow,
    reportClosedInWindow,
    workOpenedInWindow,
    workClosedInWindow,
    staleWip,
    blocked,
  };
}

function normalizeLabels(labels) {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((l) => (typeof l === "string" ? l : l && typeof l.name === "string" ? l.name : null))
    .filter((l) => typeof l === "string")
    .sort((a, b) => a.localeCompare(b, "en"));
}

function ageInDays(createdAt, now) {
  if (!createdAt) return null;
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return null;
  return Math.floor((now.getTime() - t) / (24 * 60 * 60 * 1000));
}

/**
 * Normalize PR review/check state. Review decision and CI/check rollup are the
 * only fields persisted; nothing sensitive is stored.
 */
function normalizePullRequests(prs) {
  const list = Array.isArray(prs) ? prs : [];
  const byReviewState = {};
  const byCheckState = {};
  let open = 0;
  for (const pr of list) {
    if (!pr || typeof pr !== "object") continue;
    const state = typeof pr.state === "string" ? pr.state.toLowerCase() : "open";
    if (state !== "open") continue;
    open += 1;
    const review = normalizeReviewDecision(pr);
    byReviewState[review] = (byReviewState[review] || 0) + 1;
    const check = normalizeCheckState(pr);
    byCheckState[check] = (byCheckState[check] || 0) + 1;
  }
  return { open, byReviewState, byCheckState };
}

function normalizeReviewDecision(pr) {
  const raw = pr.reviewDecision || pr.review_decision;
  if (pr.isDraft || pr.draft) return "draft";
  if (typeof raw === "string" && raw.trim() !== "") return raw.trim().toLowerCase();
  return "none";
}

function normalizeCheckState(pr) {
  const rollup = pr.statusCheckRollup || pr.status_check_rollup;
  if (typeof rollup === "string" && rollup.trim() !== "") {
    return rollup.trim().toLowerCase();
  }
  if (Array.isArray(rollup)) {
    if (rollup.length === 0) return "unknown";
    const conclusions = rollup
      .map((c) => (c && typeof c.conclusion === "string" ? c.conclusion.toLowerCase() : null))
      .filter(Boolean);
    if (conclusions.some((c) => DEFAULT_FAILING_CONCLUSIONS.includes(c))) return "failing";
    if (rollup.some((check) => check.status && check.status.toLowerCase() !== "completed")) return "pending";
    return conclusions.length === rollup.length && conclusions.every((conclusion) => conclusion === "success")
      ? "passing" : "pending";
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Material state hash + delta
// ---------------------------------------------------------------------------

/**
 * Build the deterministic "material view" — the subset of snapshot state whose
 * change should trigger a new report. Only collection timestamps are excluded;
 * closed windows, gross churn, exact cost and incomplete sources are material.
 */
function buildMaterialView(snapshot) {
  return {
    schemaVersion: snapshot.schemaVersion,
    mode: snapshot.mode,
    defaultBranch: snapshot.defaultBranch || null,
    window: snapshot.window || null,
    collection: snapshot.collection || null,
    sources: Object.fromEntries(Object.entries(snapshot.sources || {}).map(([key, value]) => [
      key, { ...value, observedAt: null },
    ])),
    factory: snapshot.factory || null,
    outcomes: snapshot.outcomes || null,
    workflows: (snapshot.workflows || [])
      .map((w) => ({
        id: w.id,
        compiled: w.compiled,
        active: w.active,
        sourceHash: w.sourceHash,
        lockHash: w.lockHash,
        runs: w.usage ? w.usage.runs : null,
        conclusions: w.usage ? w.usage.conclusions : null,
        repeatedFailures: w.usage ? w.usage.repeatedFailures : null,
        usage: w.usage || null,
      }))
      .sort((a, b) => a.id.localeCompare(b.id, "en")),
    issues: snapshot.issues || null,
    pullRequests: snapshot.pullRequests || null,
    hashes: snapshot.hashes || null,
    thresholds: (snapshot.thresholds && snapshot.thresholds.breaches
      ? snapshot.thresholds.breaches
      : []
    )
      .slice()
      .sort((a, b) => stableStringify(a).localeCompare(stableStringify(b), "en")),
  };
}

/** Stable JSON: object keys sorted recursively so hashing is deterministic. */
function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value).sort((a, b) => a.localeCompare(b, "en"));
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
    .join(",")}}`;
}

function computeMaterialHash(snapshot) {
  return sha256(stableStringify(buildMaterialView(snapshot)));
}

/** Extract the published state hash from an ordered list of report issues. */
function readPublishedHash(issues) {
  const list = Array.isArray(issues) ? issues : [];
  // Prefer the most recently created issue that carries a valid marker.
  const withMarker = list
    .map((issue) => {
      const body = issue && typeof issue.body === "string" ? issue.body : "";
      const m = body.match(STATE_HASH_MARKER_RE);
      const createdAt = issue && (issue.updatedAt || issue.updated_at || issue.createdAt || issue.created_at);
      return m ? { hash: m[1].toLowerCase(), createdAt } : null;
    })
    .filter(Boolean);
  if (withMarker.length === 0) return null;
  withMarker.sort((a, b) => {
    const ta = Date.parse(a.createdAt || "") || 0;
    const tb = Date.parse(b.createdAt || "") || 0;
    return tb - ta;
  });
  return withMarker[0].hash;
}

/**
 * Decide whether a new report is warranted.
 *
 * The GitHub-issue published hash is authoritative. The cache snapshot is only
 * used to compute a human-readable delta; a cache miss never suppresses a
 * report on its own.
 *
 *   - No published hash yet (first report / prior output failed) → changed.
 *   - Published hash differs from the current hash                → changed.
 *   - Published hash equals current hash                          → noop.
 */
function decideChange(input) {
  const currentHash = input.currentHash;
  const publishedHash = input.publishedHash || null;
  const cachedSnapshot = input.cachedSnapshot || null;

  const changed = publishedHash === null || currentHash !== publishedHash;

  let delta = null;
  if (cachedSnapshot && cachedSnapshot.materialState) {
    delta = computeDelta(cachedSnapshot, input.currentSnapshot);
  }

  return {
    changed,
    currentHash,
    publishedHash,
    cacheHit: Boolean(cachedSnapshot),
    delta,
  };
}

/** Compute a deterministic, coarse delta between two snapshots. */
function computeDelta(previous, current) {
  const prevWf = indexBy(previous.workflows || [], "id");
  const curWf = indexBy(current.workflows || [], "id");
  const added = [];
  const removed = [];
  const changed = [];
  for (const id of Object.keys(curWf)) {
    if (!(id in prevWf)) {
      added.push(id);
    } else if (
      stableStringify(materialWorkflow(curWf[id])) !==
      stableStringify(materialWorkflow(prevWf[id]))
    ) {
      changed.push(id);
    }
  }
  for (const id of Object.keys(prevWf)) {
    if (!(id in curWf)) removed.push(id);
  }
  const prevBreaches = breachIds(previous);
  const curBreaches = breachIds(current);
  return {
    workflows: {
      added: added.sort(),
      removed: removed.sort(),
      changed: changed.sort(),
    },
    thresholds: {
      added: curBreaches.filter((b) => !prevBreaches.includes(b)).sort(),
      cleared: prevBreaches.filter((b) => !curBreaches.includes(b)).sort(),
    },
  };
}

function materialWorkflow(w) {
  return {
    compiled: w.compiled,
    active: w.active,
    sourceHash: w.sourceHash,
    lockHash: w.lockHash,
    runs: w.usage ? w.usage.runs : null,
    conclusions: w.usage ? w.usage.conclusions : null,
  };
}

function breachIds(snapshot) {
  const b = snapshot && snapshot.thresholds && snapshot.thresholds.breaches;
  return Array.isArray(b) ? b.map((x) => x.id).sort() : [];
}

function indexBy(list, key) {
  const out = {};
  for (const item of list) {
    if (item && item[key] != null) out[item[key]] = item;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Threshold evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate configured thresholds against the snapshot. Every breach carries an
 * explicit id and evidence. Unknown (null) correction/safe-output metrics can
 * never breach — the evaluator only compares against present, numeric data.
 *
 * Watermarks (from cache) provide the count of consecutive published periods
 * with missing required telemetry, enabling the "missing for two published
 * periods" threshold without treating a single cache miss as a breach.
 */
function evaluateThresholds(snapshot, policy, watermarks, config) {
  const cfg = config || {};
  const wm = watermarks || {};
  const breaches = [];
  const evaluated = [];

  const evalWorkflowIds = new Set(cfg.evalWorkflowIds || ["agentic-evals", "ci"]);
  const harnessSignals = cfg.harnessFailure === true;
  const failing = new Set(cfg.failingConclusions || DEFAULT_FAILING_CONCLUSIONS);

  // 1. Eval / harness failure.
  evaluated.push("eval_or_harness_failure");
  for (const w of snapshot.workflows || []) {
    if (!evalWorkflowIds.has(w.id) || !w.usage) continue;
    const failures = countFailing(w.usage.conclusions, failing);
    if (failures > 0) {
      breaches.push({
        id: "eval_or_harness_failure",
        workflow: w.id,
        evidence: { failingRuns: failures, conclusions: w.usage.conclusions },
      });
    }
  }
  if (harnessSignals) {
    breaches.push({
      id: "eval_or_harness_failure",
      workflow: "harness",
      evidence: { source: "caller-signaled harness failure" },
    });
  }

  // 2. Repeated workflow failure (>= 2 consecutive failing runs in window).
  evaluated.push("repeated_workflow_failure");
  const repeatThreshold = Number.isFinite(cfg.repeatedFailureThreshold)
    ? cfg.repeatedFailureThreshold
    : 2;
  for (const w of snapshot.workflows || []) {
    if (!w.usage) continue;
    if (w.usage.repeatedFailures >= repeatThreshold) {
      breaches.push({
        id: "repeated_workflow_failure",
        workflow: w.id,
        evidence: {
          consecutiveFailures: w.usage.repeatedFailures,
          threshold: repeatThreshold,
        },
      });
    }
  }

  // 3. WIP >= configured cap.
  evaluated.push("wip_over_cap");
  if (
    snapshot.issues &&
    Number.isFinite(snapshot.issues.wipCap) &&
    Number.isFinite(snapshot.issues.openActionableOpportunities) &&
    snapshot.issues.openActionableOpportunities >= snapshot.issues.wipCap
  ) {
    breaches.push({
      id: "wip_over_cap",
      evidence: {
        openActionableOpportunities: snapshot.issues.openActionableOpportunities,
        cap: snapshot.issues.wipCap,
      },
    });
  }

  // 4. Required telemetry missing for two published periods.
  evaluated.push("telemetry_missing_two_periods");
  const missingStreak = Number.isFinite(wm.missingTelemetryStreak)
    ? wm.missingTelemetryStreak
    : 0;
  const telemetryMissingNow = requiredTelemetryMissing(snapshot);
  const windowKey = snapshot.window ? `${snapshot.window.start}/${snapshot.window.end}` : null;
  const sameWindow = windowKey !== null && wm.lastTelemetryWindow === windowKey;
  const previousEnd = wm.lastTelemetryWindow?.split("/")[1];
  const consecutive = previousEnd && snapshot.window &&
    Date.parse(snapshot.window.end) - Date.parse(previousEnd) === snapshot.window.days * 86400000;
  const projectedStreak = telemetryMissingNow
    ? sameWindow ? missingStreak : (consecutive ? missingStreak : 0) + 1
    : 0;
  if (projectedStreak >= 2) {
    breaches.push({
      id: "telemetry_missing_two_periods",
      evidence: {
        consecutivePublishedPeriodsMissing: projectedStreak,
        missingNow: telemetryMissingNow,
      },
    });
  }

  // 5. AIC over a workflow's configured per-run cap.
  evaluated.push("ai_credits_over_run_cap");
  for (const w of snapshot.workflows || []) {
    if (
      w.usage &&
      Number.isFinite(w.usage.maxRunAiCredits) &&
      Number.isFinite(w.perRunCreditCap) &&
      w.usage.maxRunAiCredits > w.perRunCreditCap
    ) {
      breaches.push({
        id: "ai_credits_over_run_cap",
        workflow: w.id,
        evidence: { maxRunAiCredits: w.usage.maxRunAiCredits, cap: w.perRunCreditCap },
      });
    }
  }

  // 6. Policy / source-lock drift, only when authoritative drift data exists.
  evaluated.push("policy_or_source_lock_drift");
  const drift = snapshot.hashes && snapshot.hashes.sourceLockDrift;
  if (Array.isArray(drift) && drift.length > 0) {
    breaches.push({
      id: "policy_or_source_lock_drift",
      evidence: { drifted: drift.slice().sort() },
    });
  }

  return {
    evaluated: evaluated.sort((a, b) => a.localeCompare(b, "en")),
    breaches: dedupeBreaches(breaches),
    watermarks: { missingTelemetryStreak: projectedStreak, lastTelemetryWindow: windowKey },
  };
}

function countFailing(conclusions, failing) {
  if (!conclusions || typeof conclusions !== "object") return 0;
  let total = 0;
  for (const [k, v] of Object.entries(conclusions)) {
    if (failing.has(k) && Number.isFinite(v)) total += v;
  }
  return total;
}

/**
 * Required telemetry is "missing" when at least one workflow that ran in the
 * window reports null cost data (no credits signal at all). A workflow that did
 * not run is not counted as missing telemetry.
 */
function requiredTelemetryMissing(snapshot) {
  for (const w of snapshot.workflows || []) {
    if (w.kind !== "actions" && w.usage && w.usage.runs > 0 && w.usage.aiCredits === null) {
      return true;
    }
  }
  return false;
}

function dedupeBreaches(breaches) {
  const seen = new Set();
  const out = [];
  for (const b of breaches) {
    const key = stableStringify(b);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(b);
  }
  return out.sort((a, b) => stableStringify(a).localeCompare(stableStringify(b), "en"));
}

// ---------------------------------------------------------------------------
// Telemetry coverage
// ---------------------------------------------------------------------------

/** Summarize how completely the active workflow set is observed. */
function computeTelemetryCoverage(workflows) {
  const active = (workflows || []).filter((w) => w.active);
  const withRuns = active.filter((w) => w.usage && w.usage.runs > 0);
  const withCost = withRuns.filter(
    (w) => w.usage && w.usage.aiCredits !== null,
  );
  return {
    activeWorkflows: active.length,
    workflowsWithRunData: withRuns.length,
    workflowsWithCostData: withCost.length,
    // Zero-run workflows have no expected cost signal and do not reduce coverage.
    costCoverage:
      withRuns.length === 0 ? null : withCost.length / withRuns.length,
  };
}

// ---------------------------------------------------------------------------
// Snapshot assembly
// ---------------------------------------------------------------------------

/**
 * Assemble the full normalized snapshot from already-parsed inputs. Pure and
 * deterministic apart from `generatedAt`, which is excluded from the material
 * hash. This is the seam unit tests drive directly with fixtures.
 */
function buildSnapshot(inputs) {
  const {
    mode,
    now,
    inventory,
    status,
    usage,
    issues,
    pullRequests,
    hashes,
    watermarks,
    thresholdConfig,
    policy,
    auxiliaryWorkflows,
  } = inputs;

  const window = computeWindow(mode, now);
  const statusById = status || {};

  const ghAwWorkflows = inventory.map((inv) => {
    const st = statusById[inv.id] || {};
    return {
      id: inv.id,
      sourcePath: inv.sourcePath,
      lockPath: inv.lockPath,
      kind: "gh-aw",
      compiled: typeof st.compiled === "boolean" ? st.compiled : inv.compiled,
      active: typeof st.enabled === "boolean" ? st.enabled : inv.active,
      perRunCreditCap: inv.perRunCreditCap,
      perDayCreditCap: inv.perDayCreditCap,
      safeOutputs: inv.safeOutputs,
      sourceHash: inv.sourceHash,
      lockHash: inv.lockHash,
      usage: usage[inv.id] || null,
    };
  });

  const workflows = ghAwWorkflows
    .concat(Array.isArray(auxiliaryWorkflows) ? auxiliaryWorkflows : [])
    .sort((a, b) => a.id.localeCompare(b.id, "en"));

  const snapshot = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    mode,
    defaultBranch: inputs.defaultBranch || null,
    generatedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    window,
    workflows,
    issues: issues || null,
    pullRequests: pullRequests || null,
    hashes: hashes || null,
    telemetry: computeTelemetryCoverage(workflows),
    thresholds: null,
    materialState: null,
    collection: inputs.collection || null,
    sources: inputs.sources || {},
    factory: inputs.factoryState || null,
    outcomes: inputs.outcomes || null,
  };

  snapshot.thresholds = evaluateThresholds(
    snapshot,
    policy,
    watermarks,
    thresholdConfig,
  );

  const currentHash = computeMaterialHash(snapshot);
  snapshot.materialState = {
    hash: currentHash,
    publishedHash: null,
    changed: true,
    cacheHit: false,
    delta: null,
  };
  return snapshot;
}

// ---------------------------------------------------------------------------
// GitHub read helpers (via injected runner) — orchestration only
// ---------------------------------------------------------------------------

function ghUsageTelemetry(runner, window, outputDir, now, repository, defaultBranch) {
  fs.mkdirSync(outputDir, { recursive: true });
  try {
    const parsed = runJson(runner, [
      "aw", "logs", "--json", "--verbose", "--repo", repository, "--ref", defaultBranch,
      "--start-date", window.start.slice(0, 10),
      "--end-date", window.end.slice(0, 10), "--count", "200",
      "--artifacts", "all", "--no-staged", "--output", outputDir,
    ], "gh aw logs");
    if (!Array.isArray(parsed) && !Array.isArray(parsed?.runs) && !Array.isArray(parsed?.workflows)) {
      throw new Error("invalid-usage-shape");
    }
    const data = enrichUsageRows(extractRunRows(parsed), outputDir);
    return {
      data,
      source: reads.source(data.length >= 200 ? "partial" : "complete", data.length, now,
        data.length >= 200 ? "usage-run-limit-reached" : null),
    };
  } catch {
    // Optional usage tooling is not allowed to prevent native health collection.
    return { data: [], source: reads.source("unavailable", 0, now, "gh-aw-usage-unavailable") };
  }
}

function withCompleteness(normalized, observation, fields) {
  if (observation.source.completeness === "complete") return normalized;
  const observed = {};
  for (const field of fields) {
    observed[field] = normalized[field];
    normalized[field] = null;
  }
  return { ...normalized, observed };
}

function scopeRunBranch(observation, defaultBranch) {
  const branchOf = (run) => run.head_branch ?? run.headBranch ?? run.branch;
  const missingBranchRecords = observation.data.filter((run) =>
    typeof branchOf(run) !== "string" || branchOf(run).length === 0).length;
  const data = observation.data.filter((run) => defaultBranch && branchOf(run) === defaultBranch);
  const incompleteBranch = missingBranchRecords > 0 && observation.source.completeness === "complete";
  return {
    data,
    source: {
      ...observation.source,
      branch: defaultBranch,
      includedRecords: data.length,
      excludedBranchRecords: observation.data.length - data.length - missingBranchRecords,
      missingBranchRecords,
      completeness: incompleteBranch ? "partial" : observation.source.completeness,
      reason: incompleteBranch ? "run-branch-unavailable" : observation.source.reason,
    },
  };
}

function collectGitHubInputs({ runner, repository, defaultBranch, inventory, window, policy, now, logsOutputDir, includeUsage, auxiliaryFiles }) {
  const base = `repos/${repository}`;
  const observedAt = new Date(now).toISOString();
  const options = { now: observedAt };
  let repositorySource = reads.source("complete", 1, observedAt);
  if (defaultBranch === undefined) {
    try {
      defaultBranch = reads.readJson(runner, ["api", "--method", "GET", base]).default_branch;
    } catch (error) {
      repositorySource = reads.source("unavailable", 0, observedAt, error.message);
    }
  }
  if (typeof defaultBranch !== "string" || defaultBranch.trim() === "") {
    defaultBranch = null;
    if (repositorySource.completeness === "complete") {
      repositorySource = reads.source("unavailable", 0, observedAt, "default-branch-unavailable");
    }
  }
  const status = reads.readPages(runner, `${base}/actions/workflows`, "workflows", options);
  const runs = scopeRunBranch(defaultBranch ? reads.readPages(runner,
    `${base}/actions/runs?branch=${encodeURIComponent(defaultBranch)}&created=${encodeURIComponent(`${window.start}..${window.end}`)}`,
    "workflow_runs", options) : {
      data: [], source: reads.source("unavailable", 0, observedAt, "default-branch-unavailable"),
    }, defaultBranch);
  const issueRows = reads.readPages(runner, `${base}/issues?state=all&sort=updated&direction=desc`, null, options);
  let prRows;
  try {
    const data = runJson(runner, [
      "pr", "list", "--repo", repository, "--state", "open", "--limit", "100",
      "--json", "number,state,isDraft,reviewDecision,statusCheckRollup",
    ], "gh pr list");
    if (!Array.isArray(data)) throw new Error("invalid-pr-list");
    prRows = { data, source: reads.source(data.length >= 100 ? "partial" : "complete", data.length, observedAt,
      data.length >= 100 ? "pull-request-limit-reached" : null) };
  } catch {
    prRows = { data: [], source: reads.source("unavailable", 0, observedAt, "pull-request-read-failed") };
  }
  const telemetry = scopeRunBranch(includeUsage && defaultBranch
    ? ghUsageTelemetry(runner, window, logsOutputDir, observedAt, repository, defaultBranch)
    : { data: [], source: reads.source("unavailable", 0, observedAt,
      includeUsage ? "default-branch-unavailable" : "optional-usage-not-requested") }, defaultBranch);
  const knownIds = inventory.map((workflow) => workflow.id).concat(auxiliaryFiles.map((file) => file.replace(/\.ya?ml$/, "")));
  const usage = normalizeUsage({ runs: runs.data }, knownIds, window);
  const cost = normalizeUsage({ runs: telemetry.data }, knownIds, window);
  for (const id of knownIds) {
    if (telemetry.source.completeness === "complete" && cost[id].runs === usage[id].runs) {
      for (const field of ["aiCredits", "observedAiCredits", "maxRunAiCredits", "tokens", "safeOutputOutcomes", "selfHeal", "metricCoverage"]) {
        usage[id][field] = cost[id][field];
      }
    }
    if (runs.source.completeness !== "complete") {
      usage[id].runs = null;
      usage[id].aiCredits = null;
      usage[id].tokens = null;
      usage[id].durationSecondsTotal = null;
    }
  }
  const issues = withCompleteness(normalizeIssues(issueRows.data, window, policy, now), issueRows, [
    "openedInWindow", "closedInWindow", "netOpened", "openActionableOpportunities",
    "reportOpenedInWindow", "reportClosedInWindow", "workOpenedInWindow", "workClosedInWindow",
  ]);
  const statusById = normalizeStatus(status.data);
  const auxiliaryWorkflows = auxiliaryFiles.map((file) => {
    const id = file.replace(/\.ya?ml$/, "");
    const exists = Boolean(statusById[id]);
    return {
      id, kind: "actions", sourcePath: `.github/workflows/${file}`,
      lockPath: null, compiled: null, active: exists ? statusById[id].enabled : null,
      perRunCreditCap: null, perDayCreditCap: null, safeOutputs: [], sourceHash: null, lockHash: null,
      usage: exists ? usage[id] : null,
      telemetryError: exists ? null : "workflow-not-found-on-default-branch",
    };
  });
  return {
    status: statusById, usage, issues, auxiliaryWorkflows, issueRows, defaultBranch,
    pullRequests: withCompleteness(normalizePullRequests(prRows.data), prRows, ["open", "byReviewState", "byCheckState"]),
    sources: { repository: repositorySource, workflows: status.source, runs: runs.source, issues: issueRows.source, pullRequests: prRows.source, usage: telemetry.source },
  };
}

// ---------------------------------------------------------------------------
// Hashes of the trusted source-of-truth files
// ---------------------------------------------------------------------------

function computeSourceHashes(repoRoot, inventory) {
  const workflowSourcesHash = sha256(
    inventory.map((w) => `${w.id}:${w.sourceHash}`).join("\n"),
  );
  const instructionsHash = hashInstructions(repoRoot);
  const policyHash = hashFileIfExists(
    path.join(repoRoot, ".github", "agentic-policy.json"),
  );
  const sourceLockDrift = inventory
    .filter((w) => w.active && !w.compiled)
    .map((w) => w.id);
  return {
    workflowSourcesHash,
    instructionsHash,
    policyHash,
    sourceLockDrift,
  };
}

function hashInstructions(repoRoot) {
  const candidates = [
    "AGENTS.md",
    path.join("src", "agent", "AGENTS.md"),
    path.join("src", "trading", "AGENTS.md"),
    path.join("src", "db", "AGENTS.md"),
    path.join(".github", "workflows", "AGENTS.md"),
    path.join(".github", "copilot-instructions.md"),
  ];
  const parts = [];
  for (const rel of candidates) {
    const abs = path.join(repoRoot, rel);
    if (fs.existsSync(abs)) {
      parts.push(`${rel}:${sha256(fs.readFileSync(abs, "utf8"))}`);
    }
  }
  return sha256(parts.join("\n"));
}

function hashFileIfExists(abs) {
  return fs.existsSync(abs) ? sha256(fs.readFileSync(abs, "utf8")) : null;
}

// ---------------------------------------------------------------------------
// Cache (snapshots + watermarks only)
// ---------------------------------------------------------------------------

function loadCache(cachePath) {
  if (!cachePath || !fs.existsSync(cachePath)) return null;
  return parseJsonSafe(fs.readFileSync(cachePath, "utf8"), null);
}

function buildCacheRecord(snapshot) {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    savedAt: snapshot.generatedAt,
    mode: snapshot.mode,
    materialState: { hash: snapshot.materialState.hash },
    workflows: snapshot.workflows.map((w) => ({
      id: w.id,
      compiled: w.compiled,
      active: w.active,
      sourceHash: w.sourceHash,
      lockHash: w.lockHash,
      usage: w.usage
        ? { runs: w.usage.runs, conclusions: w.usage.conclusions }
        : null,
    })),
    thresholds: {
      breaches: (snapshot.thresholds.breaches || []).map((b) => ({ id: b.id })),
    },
    watermarks: snapshot.thresholds.watermarks || {},
  };
}

// ---------------------------------------------------------------------------
// Top-level collection orchestrator
// ---------------------------------------------------------------------------

/**
 * Collect a full snapshot. Accepts an injected `runner` (default: the real
 * read-only spawn runner) so integration paths and unit tests share one code
 * path. Returns `{ snapshot, decision, cacheRecord }`.
 */
function collect(options) {
  const opts = options || {};
  const mode = opts.mode || "governance";
  const now = opts.now || new Date();
  const repoRoot = opts.repoRoot || resolveRepoRoot();
  const workflowsDir =
    opts.workflowsDir || path.join(repoRoot, ".github", "workflows");
  const runner = opts.runner || createRunner({ cwd: repoRoot });
  const policy = opts.policy || loadPolicy(repoRoot);
  const titlePrefix = opts.titlePrefix || defaultTitlePrefix(mode);
  const logsOutputDir =
    opts.logsOutputDir ||
    path.join("/tmp", "gh-aw", "monitor-ops-logs", mode);

  const inventory = buildWorkflowInventory(workflowsDir);
  const window = computeWindow(mode, now);

  const repository = reads.repositoryName(runner, opts.repository);
  const gathered = collectGitHubInputs({
    runner, repository, inventory, window, policy, now, logsOutputDir,
    defaultBranch: opts.factoryState?.defaultBranch,
    includeUsage: opts.includeUsage ?? mode === "governance",
    auxiliaryFiles: opts.auxiliaryWorkflowFiles || DEFAULT_AUXILIARY_WORKFLOWS,
  });
  const { status, usage, auxiliaryWorkflows, issues, pullRequests, sources } = gathered;
  const hashes = computeSourceHashes(repoRoot, inventory);

  const canonical = reports.canonicalReport(gathered.issueRows.data, mode);
  const reportIssues = gathered.issueRows.source.completeness === "complete"
    ? gathered.issueRows.data.filter((issue) => issue.number === canonical.number)
    : [];
  const publishedHash = readPublishedHash(reportIssues);
  const cache = loadCache(opts.cachePath);
  const cacheRepresentsPublishedState = Boolean(
    cache &&
      publishedHash &&
      cache.materialState &&
      cache.materialState.hash === publishedHash,
  );
  const watermarks =
    cacheRepresentsPublishedState && cache.watermarks ? cache.watermarks : {};

  const snapshot = buildSnapshot({
    mode,
    defaultBranch: gathered.defaultBranch,
    now,
    inventory,
    status,
    usage,
    auxiliaryWorkflows,
    issues,
    pullRequests,
    hashes,
    watermarks,
    thresholdConfig: opts.thresholdConfig,
    policy,
    sources,
    factoryState: opts.factoryState,
    outcomes: opts.outcomes,
    collection: {
      completeness: Object.entries(sources).some(([name, value]) => name !== "usage" && value.completeness !== "complete") ? "partial" : "complete",
    },
  });
  snapshot.repository = repository;
  snapshot.canonicalReport = canonical;
  snapshot.reportTitlePrefix = titlePrefix;

  const decision = decideChange({
    currentHash: snapshot.materialState.hash,
    publishedHash,
    cachedSnapshot: cacheRepresentsPublishedState ? cache : null,
    currentSnapshot: snapshot,
  });

  snapshot.materialState.publishedHash = publishedHash;
  snapshot.materialState.changed = decision.changed;
  snapshot.materialState.cacheHit = decision.cacheHit;
  snapshot.materialState.delta = decision.delta;

  const cacheRecord = buildCacheRecord(snapshot);
  return { snapshot, decision, cacheRecord };
}

function loadPolicy(repoRoot) {
  const abs = path.join(repoRoot, ".github", "agentic-policy.json");
  const loaderPath = path.join(
    repoRoot,
    ".github",
    "scripts",
    "agentic-policy.cjs",
  );
  if (!fs.existsSync(abs) || !fs.existsSync(loaderPath)) {
    throw new Error("canonical agentic policy or loader is missing");
  }
  const { loadAgenticPolicy } = require(loaderPath);
  loadAgenticPolicy(abs);
  return JSON.parse(fs.readFileSync(abs, "utf8"));
}

function defaultTitlePrefix(mode) {
  return mode === "daily" ? "[factory-status] " : "[factory-governance] ";
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { mode: "governance", workflowMode: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--mode") args.mode = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--cache") args.cache = argv[++i];
    else if (a === "--title-prefix") args.titlePrefix = argv[++i];
    else if (a === "--workflow-mode") args.workflowMode = true;
    else if (a === "--workflow-root") args.workflowRoot = argv[++i];
    else if (a === "--now") args.now = argv[++i];
    else if (a === "--include-usage") args.includeUsage = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

const HELP = `MonitorOps factory-health collector

Usage:
  node scripts/agentic/collect-factory-health.cjs --mode <daily|governance> [options]

Options:
  --mode <daily|governance>   Collection window (default: governance).
  --out <path>                Write the JSON snapshot to this path (else stdout).
  --cache <path>              Read prior + write updated cache record here.
  --title-prefix <prefix>     Report title prefix used to find the published hash.
  --workflow-mode             Enforce that --out/--cache resolve under /tmp/gh-aw/.
  --workflow-root <dir>       Override the workflow-mode root (default /tmp/gh-aw).
  --now <iso>                 Override the run-start instant (testing only).
  -h, --help                  Show this help.

The collector is read-only toward GitHub and only writes the paths it is given.`;

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
  if (args.mode !== "daily" && args.mode !== "governance") {
    process.stderr.write(`error: invalid --mode "${args.mode}"\n`);
    return 2;
  }

  const pathOpts = {
    workflowMode: args.workflowMode,
    workflowRoot: args.workflowRoot,
  };
  let outPath;
  let cachePath;
  try {
    outPath = args.out ? validateOutputPath(args.out, pathOpts) : null;
    cachePath = args.cache ? validateOutputPath(args.cache, pathOpts) : null;
  } catch (error) {
    // Fail loud, but with a clean operator-facing message instead of a stack.
    process.stderr.write(`error: ${(error && error.message) || error}\n`);
    return 2;
  }

  // `deps.runner` is the seam that lets CLI tests exercise the full write path
  // without ever contacting GitHub. Production passes no deps, so `collect`
  // builds the real read-only spawn runner.
  let snapshot;
  let cacheRecord;
  try {
    ({ snapshot, cacheRecord } = collect({
      mode: args.mode,
      now: args.now ? new Date(args.now) : d.now || new Date(),
      cachePath,
      titlePrefix: args.titlePrefix,
      runner: d.runner,
      repoRoot: d.repoRoot,
      policy: d.policy,
      logsOutputDir: d.logsOutputDir,
      repository: d.repository,
      includeUsage: args.includeUsage,
    }));
  } catch (error) {
    process.stderr.write(
      `error: factory-health collection failed: ${(error && error.message) || error}\n`,
    );
    if (outPath) {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, `${JSON.stringify(reports.failureReceipt(args.mode,
        args.now || new Date().toISOString(), "factory-health-collection-failed"), null, 2)}\n`);
    }
    return 1;
  }

  const json = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, json);
    process.stdout.write(
      `snapshot written: ${outPath} (changed=${snapshot.materialState.changed})\n`,
    );
  } else {
    process.stdout.write(json);
  }
  if (cachePath) {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, `${JSON.stringify(cacheRecord, null, 2)}\n`);
  }
  return snapshot.collection.completeness === "complete" ? 0 : 1;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = {
  SNAPSHOT_SCHEMA_VERSION,
  STATE_HASH_MARKER_PREFIX,
  DEFAULT_FAILING_CONCLUSIONS,
  resolveRepoRoot,
  validateOutputPath,
  createRunner,
  parseJsonSafe,
  runJson,
  computeWindow,
  isWithinWindow,
  listWorkflowSources,
  splitFrontmatter,
  parseWorkflowSource,
  buildWorkflowInventory,
  normalizeStatus,
  deriveWorkflowId,
  normalizeUsage,
  parseDurationSeconds,
  countRepeatedFailures,
  normalizeIssues,
  normalizePullRequests,
  buildMaterialView,
  stableStringify,
  computeMaterialHash,
  readPublishedHash,
  decideChange,
  computeDelta,
  evaluateThresholds,
  computeTelemetryCoverage,
  computeSourceHashes,
  buildSnapshot,
  buildCacheRecord,
  loadCache,
  collect,
  parseArgs,
  main,
};
