"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const factory = require("./collect-factory-health.cjs");
const entropy = require("./collect-agentic-entropy.cjs");
const corrections = require("./collect-agentic-corrections.cjs");
const observation = require("./factory-observation.cjs");
const reports = require("./factory-report.cjs");
const reads = require("./factory-read.cjs");
const signals = require("./signal-contract.cjs");
const policy = require("../../.github/scripts/agentic-factory-policy.cjs");

const MAX_SIGNALS = 10;
const OBSERVER_SOURCES = new Set([
  "daily-repo-status", "agentic-governance", "harness-entropy",
  "agentic-corrections", "opportunity-discovery", "ci-doctor",
].map((name) => `.github/workflows/${name}.lock.yml`));

function digest(value) {
  return crypto.createHash("sha256").update(factory.stableStringify(value)).digest("hex");
}

function resolveWatchdogMode(context) {
  const mode = context.eventName === "workflow_dispatch"
    ? context.payload.inputs?.mode || "daily"
    : context.eventName === "schedule" && context.payload.schedule === "30 7 * * 1" ? "governance" : "daily";
  if (!["daily", "governance"].includes(mode)) throw new Error("invalid-watchdog-mode");
  return mode;
}

async function authorizeWatchdogEvent({ github, context }) {
  const defaultBranch = context.payload.repository.default_branch;
  if (context.ref !== `refs/heads/${defaultBranch}`) return { allowed: false, reason: "not-default-branch" };
  if (["schedule", "workflow_dispatch"].includes(context.eventName)) {
    return { allowed: true, reason: "trusted-native-trigger" };
  }
  if (context.eventName !== "workflow_run") return { allowed: false, reason: "unsupported-trigger" };
  const { owner, repo } = context.repo;
  const runId = context.payload.workflow_run?.id;
  if (!Number.isSafeInteger(runId) || runId <= 0) return { allowed: false, reason: "invalid-source-run" };
  const run = (await github.request("GET /repos/{owner}/{repo}/actions/runs/{run_id}",
    { owner, repo, run_id: runId })).data;
  const workflowPath = reads.normalizeWorkflowPath(run.path);
  if (run.repository?.full_name !== `${owner}/${repo}` || run.head_repository?.full_name !== `${owner}/${repo}` ||
      run.head_branch !== defaultBranch || run.status !== "completed" ||
      !OBSERVER_SOURCES.has(workflowPath)) {
    return { allowed: false, reason: "untrusted-source-workflow" };
  }
  if (run.event === "schedule") return { allowed: true, reason: "trusted-source-schedule" };
  const commandSource = workflowPath === ".github/workflows/opportunity-discovery.lock.yml";
  if (!commandSource && run.actor?.type === "User" && ["workflow_dispatch", "issue_comment", "workflow_run"].includes(run.event)) {
    const permission = (await github.request("GET /repos/{owner}/{repo}/collaborators/{username}/permission",
      { owner, repo, username: run.actor.login })).data.permission;
    return ["admin", "maintain", "write"].includes(permission)
      ? { allowed: true, reason: "trusted-source-human" }
      : { allowed: false, reason: "source-user-not-authorized" };
  }
  if ((!commandSource && run.actor?.login !== "github-actions[bot]") || !Number.isSafeInteger(run.run_attempt)) {
    return { allowed: false, reason: "source-actor-not-authorized" };
  }
  // A command dispatcher can run as Actions or a maintainer's delegated token,
  // not the original commenter. Its actor alone cannot prove membership.
  const jobs = reads.requireComplete(await reads.readApiPages(github,
    "GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs",
    { owner, repo, run_id: runId, attempt_number: run.run_attempt }, { key: "jobs" }), "source-command-authorization");
  const allowed = jobs.some((job) => job.name === "activation" && job.status === "completed" && job.conclusion === "success");
  return { allowed, reason: allowed ? "trusted-command-activation" : "source-command-not-activated" };
}

function save(directory, name, value) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, name), `${JSON.stringify(value, null, 2)}\n`);
}

function signalCandidates(snapshot, manifest, repository) {
  if (snapshot.collection.completeness !== "complete") return [];
  const candidates = [];
  const add = (source, summary) => candidates.push({
    schemaVersion: 1, fingerprint: signals.fingerprintFor(source), source,
    observedAt: snapshot.generatedAt, severity: "warning",
    evidenceRefs: [source.ref], completeness: "complete", summary: summary.slice(0, 2000),
  });
  for (const workflow of snapshot.workflows) {
    for (const run of workflow.usage?.evidence || []) {
      if (!factory.DEFAULT_FAILING_CONCLUSIONS.includes(run.conclusion) || !/^[a-f0-9]{40}$/.test(run.sha || "")) continue;
      add({
        kind: "workflow-run", key: `${reads.normalizeWorkflowPath(run.path)}:${run.conclusion}`,
        ref: `https://github.com/${repository}/actions/runs/${run.runId}`, sha: run.sha,
        windowStart: snapshot.window.start, windowEnd: snapshot.window.end,
      }, `Observed ${workflow.id} ${run.conclusion}; independent diagnosis and validation required.`);
    }
  }
  for (const finding of manifest?.violations || []) {
    if (!/^[a-f0-9]{40}$/.test(snapshot.factory?.sha || "")) continue;
    add({
      kind: "entropy-rule", key: `${finding.ruleId}:${finding.path}`,
      ref: `https://github.com/${repository}/blob/${snapshot.factory.sha}/${finding.path}`,
      sha: snapshot.factory.sha, windowStart: snapshot.window.start, windowEnd: snapshot.window.end,
    }, `${finding.ruleId}: ${finding.path}. This finding is not goal authorization.`);
  }
  const byFingerprint = new Map(candidates.map((signal) => [signal.fingerprint, signal]));
  return [...byFingerprint.values()].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint)).slice(0, MAX_SIGNALS);
}

function canDiscover(snapshot, candidates) {
  const state = snapshot.factory;
  const goal = state?.goals.active;
  if (!goal || state.mode.mode !== "active" || state.goals.resolution !== "ok" ||
      state.capacity.completeness !== "complete" || state.capacity.inFlight !== 0 ||
      state.capacity.queued !== 0 || state.capacity.budgetUsed >= goal.dailyBudgetLimit ||
      !state.evalCapacity.available || state.blockReasons.includes("blocked-work") ||
      state.blockReasons.includes("claim-recovery-required")) return false;
  return candidates.some((signal) => {
    if (signal.source.sha !== state.sha) return false;
    const file = signal.source.kind === "entropy-rule" ? signal.source.key.slice(signal.source.key.indexOf(":") + 1) : null;
    // Workflow/control-plane failures remain visible but cannot seed novel
    // maintenance under a safety goal that excludes those paths.
    return file && policy.isPathAllowed(file, goal.goalAllowedPaths) &&
      policy.compareRiskTiers(policy.classifyPathTier(file), goal.maxGoalRiskTier) <= 0;
  });
}

function receiptFor(series, report, now, runUrl) {
  const completeness = report.collection?.completeness || report.completeness || "complete";
  const attention = report.factory?.blockReasons.length || report.thresholds?.breaches.length ||
    report.summary?.actionable || report.diffSummary?.mismatch || report.monitoredRun?.conclusion === "failure";
  const upstreamFailed = factory.DEFAULT_FAILING_CONCLUSIONS.includes(report.monitoredRun?.conclusion);
  const status = completeness !== "complete" || upstreamFailed ? "failed" : attention ? "attention" : "ok";
  return {
    schemaVersion: 1, series, observedAt: now, status, completeness, runUrl,
    reason: completeness !== "complete" ? "incomplete-collection" : upstreamFailed ? "monitored-workflow-failed" : report.factory?.workState || "collected",
    materialHash: report.materialState?.hash || report.materialHash || digest(report), report,
  };
}

async function collectWatchdog(options) {
  const { github, owner, repo, directory, repoRoot } = options;
  const now = options.now || new Date().toISOString();
  const mode = options.mode || "daily";
  if (!["daily", "governance"].includes(mode)) throw new Error("invalid-watchdog-mode");
  const runner = options.runner || factory.createRunner({ cwd: repoRoot });
  const runUrl = options.runId ? `https://github.com/${owner}/${repo}/actions/runs/${options.runId}` : null;
  const receipts = [];
  const errors = [];
  let snapshot = null;
  let manifest = null;
  let state = null;
  try {
    state = await observation.readFactoryState({ github, owner, repo, now });
    const outcomes = await observation.readSignalOutcomes({
      github, owner, repo, observation: state, window: factory.computeWindow(mode, now),
      repoRoot, evidenceReader: options.evidenceReader,
    });
    const collected = factory.collect({
      mode, now, repoRoot, runner, repository: `${owner}/${repo}`,
      factoryState: state.state, outcomes, includeUsage: options.includeUsage === true,
      logsOutputDir: path.join(directory, "usage"),
      cachePath: path.join(directory, "cache", `${mode}.json`),
    });
    snapshot = collected.snapshot;
    snapshot.sources.controlPlane = reads.source(state.state.capacity.completeness, state.issues.length, now,
      state.state.capacity.completeness === "complete" ? null : "control-plane-read-incomplete");
    snapshot.sources.controlPlane.failures = Object.entries(state.sources)
      .filter(([, value]) => value.completeness !== "complete")
      .map(([name, value]) => ({ name, completeness: value.completeness, records: value.records, reason: value.reason }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (snapshot.sources.controlPlane.completeness !== "complete") snapshot.collection.completeness = "partial";
    if (options.sourceRunId) {
      const run = (await github.request("GET /repos/{owner}/{repo}/actions/runs/{run_id}",
        { owner, repo, run_id: options.sourceRunId })).data;
      if (run.repository?.full_name !== `${owner}/${repo}`) throw new Error("foreign-monitored-run");
      snapshot.monitoredRun = {
        runId: run.id, sha: run.head_sha, workflow: reads.normalizeWorkflowPath(run.path), status: run.status, conclusion: run.conclusion,
      };
    }
    snapshot.materialState.hash = digest({ reportHash: factory.computeMaterialHash(snapshot), monitoredRun: snapshot.monitoredRun || null });
    snapshot.materialState.changed = snapshot.materialState.hash !== snapshot.materialState.publishedHash;
    receipts.push(receiptFor(mode, snapshot, now, runUrl));
    save(directory, "factory-health.json", snapshot);
    save(path.join(directory, "cache"), `${mode}.json`, factory.buildCacheRecord(snapshot));
  } catch (error) {
    errors.push({ collector: mode, reason: error.message });
    receipts.push({ ...reports.failureReceipt(mode, now, "factory-health-collection-failed"), runUrl });
  }
  if (mode === "governance") {
    try {
      const collected = entropy.collect({
        repoRoot, snapshot, now, cachePath: path.join(directory, "cache", "entropy.json"),
        reportTitlePrefix: reports.SERIES.entropy.prefix, reportIssues: state?.issues, runner,
      });
      manifest = collected.manifest;
      receipts.push(receiptFor("entropy", manifest, now, runUrl));
      save(directory, "entropy-manifest.json", manifest);
      save(path.join(directory, "cache"), "entropy.json", collected.cacheRecord);
    } catch (error) {
      errors.push({ collector: "entropy", reason: error.message });
      receipts.push({ ...reports.failureReceipt("entropy", now, "entropy-collection-failed"), runUrl });
    }
    try {
      const collected = corrections.collect({
        repoRoot, now, repository: `${owner}/${repo}`, runner,
        commit: state?.state.sha || null, count: 50,
        logsRoot: path.join(directory, "correction-logs"),
        cachePath: path.join(directory, "cache", "corrections.json"),
        reportTitlePrefix: reports.SERIES.corrections.prefix,
        reportIssues: state?.issues,
      });
      receipts.push(receiptFor("corrections", collected.report, now, runUrl));
      save(directory, "correction-report.json", collected.report);
      save(path.join(directory, "cache"), "corrections.json", collected.cacheRecord);
    } catch (error) {
      errors.push({ collector: "corrections", reason: error.message });
      receipts.push({ ...reports.failureReceipt("corrections", now, "correction-collection-failed"), runUrl });
    }
  }
  const candidates = snapshot ? signalCandidates(snapshot, manifest, `${owner}/${repo}`) : [];
  const result = {
    schemaVersion: 1, observedAt: now, mode, receipts, errors,
    discoveryEligible: mode === "governance" && snapshot !== null && canDiscover(snapshot, candidates),
    signals: candidates,
  };
  save(directory, "receipts.json", result);
  save(directory, "signal-candidates.json", { schemaVersion: 1, observedAt: now, signals: candidates });
  return result;
}

async function publishWatchdog({ github, owner, repo, directory, mode = "daily", apply = false, now = new Date().toISOString() }) {
  if (!["daily", "governance"].includes(mode)) throw new Error("invalid-watchdog-mode");
  const expectedSeries = mode === "governance" ? ["governance", "entropy", "corrections"] : ["daily"];
  const file = path.join(directory, "receipts.json");
  const batch = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {
    receipts: expectedSeries.map((series) => reports.failureReceipt(series, now, "collection-receipt-unavailable")),
  };
  if (!Array.isArray(batch.receipts) || batch.receipts.length > 4) throw new Error("invalid-watchdog-receipts");
  if (new Set(batch.receipts.map((receipt) => receipt.series)).size !== batch.receipts.length) {
    throw new Error("duplicate-watchdog-receipt-series");
  }
  const issueRead = await reads.readApiPages(github, "GET /repos/{owner}/{repo}/issues",
    { owner, repo, state: "open", labels: "report,agentic-factory" }, { now });
  const issues = reads.requireComplete(issueRead, "canonical-report-list");
  const result = [];
  for (const receipt of batch.receipts) {
    if (receipt.schemaVersion !== 1 || !reports.SERIES[receipt.series] ||
        !/^[a-f0-9]{64}$/.test(receipt.materialHash || "")) throw new Error("invalid-watchdog-receipt");
    result.push(await reports.publishReport({ github, owner, repo, receipt, issues, apply }));
  }
  return result;
}

async function inspectReceiptRun({ github, owner, repo, runId, defaultBranch, now = new Date().toISOString() }) {
  if (!/^[1-9]\d*$/.test(String(runId))) throw new Error("invalid-watchdog-receipt-run");
  const run = (await github.request("GET /repos/{owner}/{repo}/actions/runs/{run_id}",
    { owner, repo, run_id: Number(runId) })).data;
  const age = Date.parse(now) - Date.parse(run.updated_at || "");
  if (run.repository?.full_name !== `${owner}/${repo}` || run.head_branch !== defaultBranch ||
      reads.normalizeWorkflowPath(run.path) !== ".github/workflows/factory-watchdog.yml" ||
      !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1 ||
      !Number.isFinite(age) || age < -300000 || age > signals.MAX_AGE_MS) {
    throw new Error("untrusted-or-stale-watchdog-receipt-run");
  }
  const jobs = await reads.readApiPages(github,
    "GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs",
    { owner, repo, run_id: Number(runId), attempt_number: run.run_attempt }, { key: "jobs", now });
  if (!reads.requireComplete(jobs, "watchdog-receipt-jobs").some((job) =>
    job.name === "observe" && job.status === "completed" && job.conclusion === "success")) {
    throw new Error("watchdog-observation-not-successful");
  }
  return { attempt: run.run_attempt, sha: run.head_sha };
}

function mergeDiscoverySignals({ sourcePath, outputPath, repository, now = new Date().toISOString() }) {
  if (fs.statSync(sourcePath).size > 100000) throw new Error("oversized-watchdog-signals");
  const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  const current = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  for (const data of [source, current]) {
    if (data.schemaVersion !== 1 || !Array.isArray(data.signals) || data.signals.length > MAX_SIGNALS ||
        data.signals.some((signal) => signals.validateSignal(signal, { now, repository }).length)) {
      throw new Error("invalid-watchdog-signal-receipt");
    }
  }
  const merged = [...new Map([...current.signals, ...source.signals].map((signal) => [signal.fingerprint, signal])).values()]
    .sort((a, b) => a.fingerprint.localeCompare(b.fingerprint)).slice(0, MAX_SIGNALS);
  fs.writeFileSync(outputPath, `${JSON.stringify({ schemaVersion: 1, observedAt: now, signals: merged }, null, 2)}\n`);
}

async function runCollectionStep({ github, context, core, mode, includeUsage = false }) {
  const repoRoot = process.env.GITHUB_WORKSPACE;
  const runner = factory.createRunner({ cwd: repoRoot });
  const tooling = runner("gh", ["--version"]);
  core.info(`Collector runtime: Node ${process.version}; gh ${tooling.status === 0 ? "available" : "unavailable"}.`);
  const result = await collectWatchdog({
    github, ...context.repo, repoRoot, runner, mode, includeUsage,
    directory: "/tmp/gh-aw/watchdog", runId: context.runId,
    sourceRunId: context.payload.workflow_run?.id || null,
  });
  core.setOutput("discovery_eligible", String(result.discoveryEligible));
  await core.summary.addHeading("Deterministic factory collection")
    .addCodeBlock(JSON.stringify({
      receipts: result.receipts.map(({ series, status, completeness, reason }) => ({ series, status, completeness, reason })),
      errors: result.errors,
    }, null, 2), "json").write();
  if (tooling.status !== 0 || result.errors.length || result.receipts.some((receipt) => receipt.completeness !== "complete")) {
    core.setFailed("Factory collection is incomplete; machine receipts were retained.");
  }
  return result;
}

async function main() {
  const [mode = "daily", directory = "/tmp/gh-aw/watchdog"] = process.argv.slice(2);
  const repoRoot = factory.resolveRepoRoot();
  const runner = factory.createRunner({ cwd: repoRoot });
  const repository = reads.repositoryName(runner);
  const [owner, repo] = repository.split("/");
  const safeDirectory = factory.validateOutputPath(directory, { workflowMode: process.env.GITHUB_ACTIONS === "true" });
  const result = await collectWatchdog({
    github: reads.createGhClient(runner), owner, repo, directory: safeDirectory, repoRoot, runner, mode,
    runId: process.env.GITHUB_RUN_ID, sourceRunId: process.env.WATCHDOG_SOURCE_RUN_ID || null,
    includeUsage: process.env.WATCHDOG_INCLUDE_USAGE === "true",
  });
  process.stdout.write(`${JSON.stringify({ receipts: result.receipts.map(({ series, status }) => ({ series, status })), errors: result.errors })}\n`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `discovery_eligible=${result.discoveryEligible}\n`);
  if (result.errors.length || result.receipts.some((receipt) => receipt.status === "failed")) process.exitCode = 1;
}

if (require.main === module) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
module.exports = { MAX_SIGNALS, signalCandidates, canDiscover, receiptFor, collectWatchdog, publishWatchdog, inspectReceiptRun, mergeDiscoverySignals, runCollectionStep, authorizeWatchdogEvent, resolveWatchdogMode };
