"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { readSingleFileArchive } = require("./agentic-receipt.cjs");

const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_RUNS = 1000;
const MAX_CACHE_SIZE = 524288;
const CACHE_ARTIFACT = "aic-usage-cache";
const CACHE_FILE = "agentic-workflow-usage-cache.jsonl";
const OUTSTANDING = ["queued", "in_progress", "waiting", "pending", "requested"];

function readWorkflowCreditLimits(workflow) {
  if (typeof workflow !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*\.lock\.yml$/.test(workflow)) {
    throw new Error("Credit admission requires an exact agentic workflow filename.");
  }
  const source = path.join(__dirname, "..", "workflows", workflow.replace(/\.lock\.yml$/, ".md"));
  if (fs.statSync(source).size > 262144) throw new Error("Workflow credit policy is oversized.");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(fs.readFileSync(source, "utf8"))?.[1];
  if (!frontmatter) throw new Error("Workflow credit policy frontmatter is missing.");
  const limit = (key) => {
    const lines = frontmatter.split(/\r?\n/).filter((line) => line.startsWith(`${key}:`));
    const value = lines.length === 1 && new RegExp(`^${key}:\\s+([1-9][0-9]*)\\s*$`).exec(lines[0])?.[1];
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`Invalid ${key} for ${workflow}.`);
    return number;
  };
  return { perRun: limit("max-ai-credits"), perDay: limit("max-daily-ai-credits") };
}

function runTime(value) {
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) throw new Error("Credit admission requires valid native run timestamps.");
  return time;
}

function validateRun(run, workflow, repository) {
  if (!run || !Number.isSafeInteger(run.id) || run.id <= 0 ||
      !Number.isSafeInteger(run.workflow_id) || run.workflow_id <= 0 ||
      !Number.isSafeInteger(run.run_attempt) || run.run_attempt <= 0 ||
      run.path !== `.github/workflows/${workflow}` ||
      run.repository?.full_name?.toLowerCase() !== repository.toLowerCase() ||
      typeof run.status !== "string" ||
      !["completed", ...OUTSTANDING].includes(run.status) ||
      runTime(run.updated_at) < runTime(run.created_at)) {
    throw new Error("Credit history contains an invalid or foreign workflow run.");
  }
}

function responseRuns(response, pageSize) {
  const data = response?.data;
  if (!data || !Number.isSafeInteger(data.total_count) || data.total_count < 0 ||
      !Array.isArray(data.workflow_runs) || data.workflow_runs.length > pageSize ||
      data.workflow_runs.length > data.total_count ||
      (data.total_count === 0) !== (data.workflow_runs.length === 0)) {
    throw new Error("Native credit history response is incomplete.");
  }
  return data;
}

async function recentRuns({ github, owner, repo, workflow, now }) {
  const runs = [];
  const ids = new Set();
  let total;
  let previousTime = Infinity;
  let workflowId;
  for (let page = 1; page <= MAX_RUNS / 100; page += 1) {
    const data = responseRuns(await github.rest.actions.listWorkflowRuns({
      owner, repo, workflow_id: workflow, per_page: 100, page,
      created: `>=${new Date(now - WINDOW_MS).toISOString()}`,
    }), 100);
    if (data.total_count > MAX_RUNS || (total !== undefined && total !== data.total_count)) {
      throw new Error("Native credit history exceeded its bound or changed during pagination.");
    }
    total = data.total_count;
    for (const run of data.workflow_runs) {
      validateRun(run, workflow, `${owner}/${repo}`);
      if (workflowId !== undefined && workflowId !== run.workflow_id) {
        throw new Error("Native credit history mixes workflow identities.");
      }
      workflowId = run.workflow_id;
      const created = runTime(run.created_at);
      if (ids.has(run.id) || created > previousTime) throw new Error("Native credit history ordering is ambiguous.");
      ids.add(run.id);
      previousTime = created;
      if (created >= now - WINDOW_MS) runs.push(run);
    }
    if (ids.size === total) return runs;
    if (data.workflow_runs.length < 100) throw new Error("Native credit history pagination is incomplete.");
  }
  throw new Error("Native credit history exceeded its pagination bound.");
}

function readCreditCache(text, runs) {
  const rows = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (rows.length > 5000) throw new Error("Native credit cache exceeds its row bound.");
  const entries = new Map();
  for (const row of rows) {
    const entry = JSON.parse(row);
    if (!entry || Array.isArray(entry) ||
        Object.keys(entry).sort().join(",") !== "aic,run_id,timestamp" ||
        !Number.isSafeInteger(entry.run_id) || entry.run_id <= 0 ||
        typeof entry.aic !== "number" || !Number.isFinite(entry.aic) ||
        entry.aic < 0 || entry.aic > Number.MAX_SAFE_INTEGER || entries.has(entry.run_id)) {
      throw new Error("Native credit cache has an invalid or duplicate entry.");
    }
    runTime(entry.timestamp);
    entries.set(entry.run_id, entry);
  }
  return runs.map((run) => {
    const entry = entries.get(run.id);
    if (run.run_attempt !== 1 || !entry ||
        runTime(entry.timestamp) < runTime(run.created_at) ||
        runTime(entry.timestamp) > runTime(run.updated_at)) {
      throw new Error("Native credit cache cannot prove complete current-attempt usage.");
    }
    return { id: run.id, createdAt: run.created_at, credits: entry.aic };
  });
}

async function loadCreditCache({ github, owner, repo, run, runs }) {
  const response = await github.rest.actions.listWorkflowRunArtifacts({
    owner, repo, run_id: run.id, per_page: 100,
  });
  const data = response?.data;
  if (!data || !Array.isArray(data.artifacts) || !Number.isSafeInteger(data.total_count) ||
      data.total_count !== data.artifacts.length || data.total_count > 100) {
    throw new Error("Native credit artifact inventory is incomplete.");
  }
  const matching = data.artifacts.filter((artifact) => artifact.name === CACHE_ARTIFACT);
  if (matching.length !== 1) throw new Error("A unique latest-run native credit cache is required.");
  const artifact = matching[0];
  if (artifact.expired !== false || !Number.isSafeInteger(artifact.id) || artifact.id <= 0 ||
      !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes <= 0 ||
      artifact.size_in_bytes > 262144 || artifact.workflow_run?.id !== run.id) {
    throw new Error("Native credit cache artifact is expired, oversized or bound to another run.");
  }
  let download;
  try {
    download = await github.rest.actions.downloadArtifact({
      owner, repo, artifact_id: artifact.id, archive_format: "zip",
    });
  } catch (error) {
    const status = Number.isInteger(error?.status) ? ` (HTTP ${error.status})` : "";
    // Artifact transport errors may contain a signed download URL.
    throw new Error(`Native credit cache download failed${status}; no dispatch is admitted.`);
  }
  return readCreditCache(readSingleFileArchive(download.data, CACHE_FILE, MAX_CACHE_SIZE), runs);
}

function budgetDecision(usage, limits) {
  const total = usage.reduce((sum, run) => sum + run.credits, 0);
  if (!Number.isFinite(total) || total > Number.MAX_SAFE_INTEGER) throw new Error("Native credit total is invalid.");
  let remaining = total;
  let retryAfter = null;
  if (total > limits.perDay) {
    for (const run of [...usage].sort((left, right) => runTime(left.createdAt) - runTime(right.createdAt))) {
      remaining -= run.credits;
      if (remaining <= limits.perDay) {
        retryAfter = new Date(runTime(run.createdAt) + WINDOW_MS + 1).toISOString();
        break;
      }
    }
  }
  return {
    allowed: total <= limits.perDay,
    reason: total <= limits.perDay ? "within-recorded-budget" : "rolling-credit-limit",
    total, limit: limits.perDay, retryAfter,
  };
}

async function inspectCreditAdmission({ github, owner, repo, workflow, now }) {
  const limits = readWorkflowCreditLimits(workflow);
  const runs = await recentRuns({ github, owner, repo, workflow, now });
  if (runs.some((run) => run.status !== "completed" || runTime(run.created_at) > now)) {
    return { allowed: false, reason: "usage-pending", retryAfter: null };
  }
  const usage = runs.length ? await loadCreditCache({ github, owner, repo, run: runs[0], runs }) : [];
  const decision = budgetDecision(usage, limits);
  if (!decision.allowed) return decision;

  // Old queued runs are not in the creation-time window but can still start.
  for (const status of OUTSTANDING) {
    const data = responseRuns(await github.rest.actions.listWorkflowRuns({
      owner, repo, workflow_id: workflow, status, per_page: 1,
    }), 1);
    if (data.total_count > 0) {
      validateRun(data.workflow_runs[0], workflow, `${owner}/${repo}`);
      return { ...decision, allowed: false, reason: "usage-pending", retryAfter: null };
    }
  }
  const latest = responseRuns(await github.rest.actions.listWorkflowRuns({
    owner, repo, workflow_id: workflow, per_page: 1,
  }), 1).workflow_runs[0];
  if (latest) {
    validateRun(latest, workflow, `${owner}/${repo}`);
    if (latest.status !== "completed") {
      return { ...decision, allowed: false, reason: "usage-pending", retryAfter: null };
    }
    const changed = runs[0]
      ? latest.id !== runs[0].id || latest.workflow_id !== runs[0].workflow_id ||
        latest.run_attempt !== runs[0].run_attempt || latest.created_at !== runs[0].created_at ||
        latest.updated_at !== runs[0].updated_at
      : runTime(latest.created_at) >= now - WINDOW_MS;
    if (changed) {
      return { ...decision, allowed: false, reason: "credit-history-changed", retryAfter: null };
    }
  } else if (runs.length) {
    throw new Error("Native credit history disappeared before dispatch.");
  }
  return decision;
}

function createCreditAdmission({ github, owner, repo, core, now = new Date().toISOString() }) {
  const time = runTime(now);
  const seen = new Map();
  return async (workflow) => {
    let result;
    if (seen.has(workflow)) {
      const previous = seen.get(workflow);
      result = { ...previous, allowed: false, reason: previous.allowed ? "already-admitted-this-pass" : previous.reason };
    } else {
      // Do not repeat an uncertain read or dispatch within the same controller pass.
      seen.set(workflow, { allowed: false, reason: "credit-admission-unresolved", retryAfter: null });
      result = await inspectCreditAdmission({ github, owner, repo, workflow, now: time });
      seen.set(workflow, result);
    }
    if (!result.allowed) {
      core.info(`Deferred ${workflow}: ${result.reason}${result.total === undefined ? "" : ` (${result.total}/${result.limit} recorded credits)`}${result.retryAfter ? `; recheck after ${result.retryAfter}` : ""}. No dispatch was admitted.`);
    }
    return result;
  };
}

module.exports = { WINDOW_MS, readWorkflowCreditLimits, readCreditCache, budgetDecision, createCreditAdmission };
