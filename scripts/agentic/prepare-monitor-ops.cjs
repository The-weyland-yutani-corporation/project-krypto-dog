"use strict";

const fs = require("node:fs");
const path = require("node:path");
const health = require("./collect-factory-health.cjs");
const entropy = require("./collect-agentic-entropy.cjs");

const GH_AW_VERSION = "v0.81.6";
const PROFILES = new Set(["daily", "governance", "entropy"]);
const HASH = /^[a-f0-9]{64}$/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPublishedHash(value) {
  return value === null || (typeof value === "string" && HASH.test(value));
}

function validateCachePath(file, directory = false) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
  ) {
    throw new Error(`MonitorOps cache path must not redirect host access: ${file}`);
  }
}

function readJsonObject(file) {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!isRecord(value)) {
    throw new Error(`MonitorOps output must be a JSON object: ${file}`);
  }
  return value;
}

function validateHealth(snapshot, mode) {
  const state = snapshot.materialState;
  if (
    snapshot.schemaVersion !== health.SNAPSHOT_SCHEMA_VERSION ||
    snapshot.mode !== mode ||
    !Number.isFinite(Date.parse(snapshot.generatedAt)) ||
    !isRecord(snapshot.window) ||
    !Array.isArray(snapshot.workflows) ||
    snapshot.workflows.length === 0 ||
    !isRecord(snapshot.issues) ||
    !isRecord(snapshot.pullRequests) ||
    !isRecord(snapshot.telemetry) ||
    !isRecord(snapshot.thresholds) ||
    !Array.isArray(snapshot.thresholds.breaches) ||
    !isRecord(state) ||
    typeof state.hash !== "string" ||
    !HASH.test(state.hash) ||
    !isPublishedHash(state.publishedHash) ||
    typeof state.changed !== "boolean"
  ) {
    throw new Error("Invalid factory-health snapshot");
  }
  if (
    health.computeMaterialHash(snapshot) !== state.hash ||
    state.changed !== (state.publishedHash !== state.hash)
  ) {
    throw new Error("Factory-health material state does not match its snapshot or published baseline");
  }
}

function validateEntropy(manifest) {
  const delta = manifest.baselineDelta;
  const summary = manifest.summary;
  if (
    manifest.schemaVersion !== entropy.MANIFEST_SCHEMA_VERSION ||
    !Number.isFinite(Date.parse(manifest.collectedAt)) ||
    !Array.isArray(manifest.checks) ||
    !Array.isArray(manifest.violations) ||
    !Array.isArray(manifest.dimensions) ||
    !isRecord(summary) ||
    typeof summary.actionable !== "boolean" ||
    typeof summary.shouldReport !== "boolean" ||
    typeof manifest.materialHash !== "string" ||
    !HASH.test(manifest.materialHash) ||
    !isRecord(delta) ||
    !isPublishedHash(delta.publishedHash) ||
    typeof delta.changed !== "boolean"
  ) {
    throw new Error("Invalid entropy manifest");
  }
  if (
    entropy.computeMaterialHash(manifest) !== manifest.materialHash ||
    delta.changed !== (delta.publishedHash !== manifest.materialHash) ||
    summary.actionable !== (manifest.violations.length > 0) ||
    summary.shouldReport !== (delta.changed && summary.actionable)
  ) {
    throw new Error("Entropy material state does not match its manifest or published baseline");
  }
}

function prepare(profile, deps = {}) {
  if (!PROFILES.has(profile)) {
    throw new Error("MonitorOps profile must be daily, governance, or entropy");
  }
  const mode = profile === "daily" ? "daily" : "governance";
  const repoRoot = deps.repoRoot || health.resolveRepoRoot();
  const workflowRoot = path.resolve(deps.workflowRoot || "/tmp/gh-aw");
  const snapshotPath = path.join(workflowRoot, "factory-health.json");
  const manifestPath = path.join(workflowRoot, "entropy-manifest.json");
  const cacheDir = path.join(workflowRoot, "cache-memory");
  const healthCache = path.join(cacheDir, `monitor-ops-${mode}.json`);
  const entropyCache = path.join(cacheDir, "entropy.json");
  const runner = deps.runner || health.createRunner({ cwd: repoRoot });
  const collectorDeps = {
    runner,
    repoRoot,
    now: deps.now,
    gitRunner: deps.gitRunner,
    logsOutputDir: path.join(workflowRoot, "monitor-ops-logs", mode),
  };

  // Restored agent-written cache data must not redirect trusted host reads/writes.
  validateCachePath(workflowRoot, true);
  validateCachePath(cacheDir, true);
  validateCachePath(healthCache);
  if (profile === "entropy") validateCachePath(entropyCache);

  // A prior file must never stand in for a collector that failed to write.
  fs.rmSync(snapshotPath, { force: true });
  if (profile === "entropy") fs.rmSync(manifestPath, { force: true });

  const version = runner("gh", ["aw", "version"]);
  if (version.status !== 0 || version.stdout.trim() !== `gh aw version ${GH_AW_VERSION}`) {
    throw new Error(`MonitorOps requires the installed gh-aw CLI ${GH_AW_VERSION}`);
  }

  const healthMain = deps.healthMain || health.main;
  const healthStatus = healthMain([
    "--mode", mode,
    "--out", snapshotPath,
    "--cache", healthCache,
    "--workflow-mode",
    "--workflow-root", workflowRoot,
    "--title-prefix", mode === "daily" ? "[factory-status] " : "[factory-governance] ",
  ], collectorDeps);
  if (healthStatus !== 0) {
    throw new Error(`Factory-health collector failed with exit code ${healthStatus}`);
  }
  validateHealth(readJsonObject(snapshotPath), mode);

  if (profile === "entropy") {
    const entropyMain = deps.entropyMain || entropy.main;
    const entropyStatus = entropyMain([
      "--snapshot", snapshotPath,
      "--out", manifestPath,
      "--cache", entropyCache,
      "--report-prefix", "[factory-entropy] ",
      "--workflow-mode",
      "--workflow-root", workflowRoot,
    ], collectorDeps);
    if (entropyStatus !== 0) {
      throw new Error(`Entropy collector failed with exit code ${entropyStatus}`);
    }
    validateEntropy(readJsonObject(manifestPath));
  }
}

function main(argv, deps) {
  try {
    if (argv.length !== 1) {
      throw new Error("Usage: node scripts/agentic/prepare-monitor-ops.cjs <daily|governance|entropy>");
    }
    prepare(argv[0], deps);
    return 0;
  } catch (error) {
    process.stderr.write(`error: MonitorOps preparation failed: ${error.message}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { GH_AW_VERSION, main };
