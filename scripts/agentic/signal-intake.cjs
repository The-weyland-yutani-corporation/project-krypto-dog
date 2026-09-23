"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const runtime = require("../../.github/scripts/agentic-queue-runtime.cjs");
const contract = require("./signal-contract.cjs");
const { readFactoryState } = require("./factory-observation.cjs");
const { DEFAULT_FAILING_CONCLUSIONS } = require("./collect-factory-health.cjs");
const reads = require("./factory-read.cjs");

const TRIAGE_WORKFLOW = "pm-triage.lock.yml";
const MAX_PAYLOAD_BYTES = 24000;

async function verifySource({ github, owner, repo, signal, proposal, repoRoot }) {
  if (signal.source.kind === "workflow-run" || signal.source.kind === "repository-test") {
    const match = signal.source.ref.match(/\/actions\/runs\/(\d+)$/);
    if (!match) return ["source-run-ref-required"];
    const run = (await github.request("GET /repos/{owner}/{repo}/actions/runs/{run_id}",
      { owner, repo, run_id: Number(match[1]) })).data;
    const workflowPath = reads.normalizeWorkflowPath(run.path);
    const when = Date.parse(run.created_at);
    if (typeof workflowPath !== "string" || run.repository?.full_name !== `${owner}/${repo}` ||
        run.head_sha !== signal.source.sha || run.status !== "completed" ||
        !DEFAULT_FAILING_CONCLUSIONS.includes(run.conclusion) ||
        signal.source.key !== `${workflowPath}:${run.conclusion}` ||
        !Number.isFinite(when) || when < Date.parse(signal.source.windowStart) ||
        when >= Date.parse(signal.source.windowEnd)) return ["source-run-not-corroborated"];
    const latestRuns = await reads.readApiPages(github, "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs", {
      owner, repo, workflow_id: workflowPath.split("/").pop(), head_sha: run.head_sha, branch: run.head_branch,
      created: `>=${signal.source.windowStart}`,
    }, { key: "workflow_runs" });
    const latest = reads.requireComplete(latestRuns, "source-run-freshness")
      .filter((item) => item.head_sha === run.head_sha && item.head_branch === run.head_branch)
      .sort((a, b) => b.id - a.id)[0];
    if (!latest || latest.id !== run.id || latest.conclusion !== run.conclusion) return ["source-run-superseded"];
    if (proposal.baseline.metric !== "failing-workflow-runs" || proposal.baseline.value !== 1 ||
        proposal.baseline.unit !== "runs" || proposal.oracle.value !== 0) return ["baseline-not-corroborated"];
    return [];
  }
  if (signal.source.kind === "entropy-rule") {
    const entropy = require("./collect-agentic-entropy.cjs");
    const { manifest } = entropy.collect({ repoRoot });
    const finding = manifest.violations.find((item) => `${item.ruleId}:${item.path}` === signal.source.key);
    const count = manifest.violations.filter((item) => `${item.ruleId}:${item.path}` === signal.source.key).length;
    if (proposal.baseline.metric !== "rule-violations" || proposal.baseline.value !== count ||
        proposal.baseline.unit !== "findings" || proposal.oracle.value !== 0) return ["baseline-not-corroborated"];
    return finding && signal.source.ref === `https://github.com/${owner}/${repo}/blob/${signal.source.sha}/${finding.path}`
      ? [] : ["entropy-finding-not-corroborated"];
  }
  return ["source-adapter-unavailable"];
}

async function nativeParent(github, owner, repo, issueNumber) {
  try {
    const parent = (await github.request("GET /repos/{owner}/{repo}/issues/{issue_number}/parent",
      { owner, repo, issue_number: issueNumber })).data;
    const repositoryUrl = `${process.env.GITHUB_API_URL || "https://api.github.com"}/repos/${owner}/${repo}`;
    return parent.repository_url?.toLowerCase() === repositoryUrl.toLowerCase() ? parent.number : null;
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function inspectIntake({ github, owner, repo, signal, proposal, now, repoRoot, observe = readFactoryState }) {
  const validation = [...contract.validateSignal(signal, { now, repository: `${owner}/${repo}` }),
    ...contract.validateProposal(proposal)];
  if (validation.length) return { decision: { eligible: false, reasons: validation }, observation: null };
  const observation = await observe({ github, owner, repo, now });
  const parent = await nativeParent(github, owner, repo, proposal.scopeIssueNumber);
  const dependencyStates = [];
  for (const issueNumber of proposal.dependencyNumbers) {
    const issue = (await github.request("GET /repos/{owner}/{repo}/issues/{issue_number}",
      { owner, repo, issue_number: issueNumber })).data;
    dependencyStates.push(issue.state === "closed" ? "closed" : "open");
  }
  const decision = contract.preflight({
    signal, proposal, observation, nativeScopeParent: parent,
    dependencyStates, now, repository: `${owner}/${repo}`,
  });
  const sourceReasons = decision.eligible ? await verifySource({ github, owner, repo, signal, proposal, repoRoot }) : [];
  if (decision.eligible) {
    const prefix = `https://github.com/${owner}/${repo}/blob/${signal.source.sha}/`;
    const oraclePath = proposal.oracle.evidenceRef.slice(prefix.length);
    const oracle = (await github.request("GET /repos/{owner}/{repo}/contents/{path}",
      { owner, repo, path: oraclePath, ref: signal.source.sha })).data;
    if (oracle.type !== "file") sourceReasons.push("independent-oracle-unavailable");
  }
  decision.reasons = [...new Set([...decision.reasons, ...sourceReasons])].sort();
  decision.eligible = decision.reasons.length === 0;
  return { decision, observation };
}

async function revalidateBeforeCreate({ github, owner, repo, signal, proposal, observation, now }) {
  const rows = reads.requireComplete(await reads.readApiPages(github, "GET /repos/{owner}/{repo}/issues",
    { owner, repo, state: "all" }, { now }), "admission-final-read").filter((issue) => !issue.pull_request);
  const open = rows.filter((issue) => issue.state === "open");
  const labels = runtime.normalizeLabels;
  const control = runtime.determineFactoryMode(open.filter((issue) => labels(issue.labels).includes(runtime.CONTROL_LABEL)));
  const goals = open.filter((issue) => labels(issue.labels).includes(runtime.GOAL_LABEL) &&
    labels(issue.labels).includes(runtime.GOAL_APPROVED_LABEL));
  const resolved = runtime.resolveActiveGoal(goals);
  const oldGoal = observation.issues.find((issue) => issue.number === proposal.goalNumber);
  if (control.mode !== "active" || control.controlIssue?.number !== observation.state.mode.controlIssue ||
      !resolved.valid || resolved.goal.number !== proposal.goalNumber || goals[0].body !== oldGoal.body ||
      goals[0].milestone?.number !== oldGoal.milestone?.number ||
      [control.controlIssue, goals[0]].some((issue) => labels(issue.labels).includes(runtime.BLOCKED_LABEL))) return false;
  for (const [number, label] of [[control.controlIssue.number, "factory-mode:active"], [proposal.goalNumber, runtime.GOAL_APPROVED_LABEL]]) {
    const events = reads.requireComplete(await reads.readApiPages(github,
      "GET /repos/{owner}/{repo}/issues/{issue_number}/timeline", { owner, repo, issue_number: number }, { now }),
    "admission-final-human-authority");
    if (!runtime.isHumanActorType(runtime.findLatestLabelApplicationEvent(events, label)?.actor?.type)) return false;
  }
  const source = rows.find((issue) => issue.number === proposal.scopeIssueNumber);
  if (!source || source.state !== "open" || labels(source.labels).includes(runtime.BLOCKED_LABEL) ||
      await nativeParent(github, owner, repo, source.number) !== proposal.goalNumber) return false;
  if (rows.some((issue) => (issue.body || "").includes(`<!-- factory-signal:v1 ${signal.fingerprint} -->`))) return false;
  if (open.some((issue) => labels(issue.labels).some((label) => runtime.IN_FLIGHT_LABELS.includes(label)))) return false;
  if (open.some((issue) => {
    const sections = runtime.extractIssueFormSections(issue.body);
    return runtime.parseIssueReference(runtime.getIssueFormSection(sections, "Approved parent goal")) === proposal.goalNumber &&
      (labels(issue.labels).includes(runtime.READY_LABEL) || /<!-- factory-signal:v1 /.test(issue.body || "") ||
        labels(issue.labels).includes(runtime.BLOCKED_LABEL));
  })) return false;
  const budgetVersion = (issues) => issues.filter((issue) => {
    const sections = runtime.extractIssueFormSections(issue.body);
    return runtime.parseIssueReference(runtime.getIssueFormSection(sections, "Approved parent goal")) === proposal.goalNumber &&
      labels(issue.labels).some((label) => runtime.POST_QUEUE_LIFECYCLE_LABELS.includes(label));
  }).map((issue) => [issue.number, issue.updated_at]).sort((a, b) => a[0] - b[0]);
  if (JSON.stringify(budgetVersion(rows)) !== JSON.stringify(budgetVersion(observation.issues))) return false;
  if (!proposal.dependencyNumbers.every((number) => rows.some((issue) => issue.number === number && issue.state === "closed"))) return false;
  const evaluations = reads.requireComplete(await reads.readApiPages(github,
    "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs",
    { owner, repo, workflow_id: "agentic-evals.yml", branch: observation.state.defaultBranch, head_sha: signal.source.sha,
      created: `>=${new Date(Date.parse(now) - 7 * 86400000).toISOString()}` }, { key: "workflow_runs", now }), "admission-final-evaluation");
  const current = evaluations.filter((run) => run.head_sha === signal.source.sha).sort((a, b) => b.id - a.id);
  const branch = (await github.request("GET /repos/{owner}/{repo}/branches/{branch}",
    { owner, repo, branch: observation.state.defaultBranch })).data;
  if (branch.commit?.sha !== signal.source.sha) return false;
  return current[0]?.id === observation.state.evalCapacity.runId && current[0]?.conclusion === "success" &&
    current.every((run) => run.status === "completed");
}

async function runSignalIntake(options) {
  const { github, owner, repo, signal, proposal, apply = false } = options;
  const now = options.now || new Date().toISOString();
  const inspected = await inspectIntake({ ...options, now });
  const receipt = {
    schemaVersion: 1, observedAt: now, fingerprint: signal?.fingerprint || null,
    action: inspected.decision.eligible ? "preview-eligible" : "rejected",
    reasons: inspected.decision.reasons, issueNumber: inspected.decision.duplicateIssue || null,
    goalNumber: proposal?.goalNumber || null, ready: false, completed: false,
  };
  if (!apply || !inspected.decision.eligible) return receipt;

  // Serialize this adapter with the queue workflow and re-read human control,
  // budget, deduplication and evaluation immediately before the first mutation.
  const fresh = await inspectIntake({ ...options, now: options.now || new Date().toISOString() });
  if (!fresh.decision.eligible) return { ...receipt, action: "rejected", reasons: fresh.decision.reasons };
  if (!await revalidateBeforeCreate({ ...options, observation: fresh.observation, now: options.now || new Date().toISOString() })) {
    return { ...receipt, action: "rejected", reasons: ["authorization-changed-before-creation"] };
  }
  const goal = fresh.observation.issues.find((issue) => issue.number === proposal.goalNumber);
  if (!Number.isInteger(goal?.milestone?.number)) throw new Error("goal-milestone-number-unavailable");
  const body = contract.proposalBody(signal, proposal);
  const created = await github.rest.issues.create({
    owner, repo, title: `[signal] ${proposal.title.replace(/@/g, "")}`, body,
    milestone: goal.milestone.number,
    labels: [runtime.FACTORY_LABEL, "needs-triage", proposal.riskTier],
  });
  receipt.issueNumber = created.data.number;
  receipt.action = "created-unlinked";
  try {
    await github.request("POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues", {
      owner, repo, issue_number: proposal.goalNumber, sub_issue_id: created.data.id,
    });
    if (await nativeParent(github, owner, repo, created.data.number) !== proposal.goalNumber) {
      throw new Error("native-goal-link-not-persisted");
    }
    receipt.action = "created-awaiting-triage";
    const admission = {
      schemaVersion: 1, fingerprint: signal.fingerprint,
      sourceIssueNumber: proposal.scopeIssueNumber, issueNumber: created.data.number,
      goalNumber: proposal.goalNumber,
      bodySha256: crypto.createHash("sha256").update(body, "utf8").digest("hex"),
      phase: "native-linked",
    };
    const audit = await github.rest.issues.createComment({
      owner, repo, issue_number: proposal.scopeIssueNumber,
      body: `<!-- factory-signal-admission:v1 ${JSON.stringify(admission)} -->`,
    });
    receipt.admissionCommentId = audit.data.id;
    receipt.bodySha256 = admission.bodySha256;
    // A durable intent precedes dispatch. Ambiguous dispatch failures are never
    // replayed into a second issue/session; they remain visible for the operator.
    await github.rest.issues.createComment({
      owner, repo, issue_number: created.data.number,
      body: `<!-- factory-signal-intake:v1 ${signal.fingerprint} -->\nNative goal #${proposal.goalNumber} linked. PM triage dispatch requested; this is not readiness or completion.`,
    });
    const controlRead = await reads.readApiPages(github, "GET /repos/{owner}/{repo}/issues",
      { owner, repo, state: "open", labels: runtime.CONTROL_LABEL }, { now });
    const control = runtime.determineFactoryMode(reads.requireComplete(controlRead, "control-reread"));
    if (control.mode !== "active" || control.controlIssue.number !== fresh.observation.state.mode.controlIssue) {
      return { ...receipt, reasons: ["control-changed-before-triage"] };
    }
    await github.rest.actions.createWorkflowDispatch({
      owner, repo, workflow_id: TRIAGE_WORKFLOW, ref: fresh.observation.state.defaultBranch,
      inputs: {
        issue: String(created.data.number),
        aw_context: JSON.stringify({ item_type: "issue", item_number: created.data.number }),
      },
    });
    return { ...receipt, action: "created-triage-dispatched", reasons: [] };
  } catch (error) {
    error.intakeReceipt = { ...receipt, action: "incomplete", reasons: ["native-link-or-triage-dispatch-failed"] };
    throw error;
  }
}

function parsePayload(value) {
  if (typeof value !== "string" || Buffer.byteLength(value) > MAX_PAYLOAD_BYTES) throw new Error("invalid-signal-payload-size");
  const payload = JSON.parse(value);
  if (!payload || Object.keys(payload).sort().join(",") !== "proposal,signal") throw new Error("invalid-signal-payload");
  return payload;
}

async function runSafeOutput({ github, context, core, outputPath, repoRoot }) {
  const defaultBranch = context.payload?.repository?.default_branch;
  if (!defaultBranch || context.ref !== `refs/heads/${defaultBranch}`) throw new Error("untrusted-signal-workflow-ref");
  const output = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  const items = (Array.isArray(output.items) ? output.items : []).filter((item) => item.type === "submit_signal");
  if (items.length !== 1) throw new Error("exactly-one-signal-output-required");
  const { signal, proposal } = parsePayload(items[0].payload);
  const receipt = await runSignalIntake({
    github, ...context.repo, signal, proposal, repoRoot, apply: true,
  });
  core.info(JSON.stringify(receipt));
  await core.summary.addHeading("Signal intake").addCodeBlock(JSON.stringify(receipt, null, 2), "json").write();
  return receipt;
}

async function main() {
  const factory = require("./collect-factory-health.cjs");
  const runner = factory.createRunner();
  const repository = reads.repositoryName(runner);
  const [owner, repo] = repository.split("/");
  const file = process.argv[2];
  if (!file || process.argv.length !== 3) throw new Error("usage: node scripts/agentic/signal-intake.cjs <payload.json> (preview only)");
  const payload = parsePayload(fs.readFileSync(path.resolve(file), "utf8"));
  const receipt = await runSignalIntake({
    ...payload, github: reads.createGhClient(runner), owner, repo,
    repoRoot: factory.resolveRepoRoot(), apply: false,
  });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

if (require.main === module) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
module.exports = { TRIAGE_WORKFLOW, MAX_PAYLOAD_BYTES, verifySource, inspectIntake, revalidateBeforeCreate, runSignalIntake, parsePayload, runSafeOutput };
