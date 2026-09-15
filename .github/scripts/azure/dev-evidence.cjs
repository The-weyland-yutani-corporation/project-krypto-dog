"use strict";

const { createHash } = require("node:crypto");
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");
const { isMigrationFile } = require("../agentic-factory-policy.cjs");
const {
  EvidenceValidationError,
  IMAGE_DIGEST_PATTERN,
  RELEASE_SHA_PATTERN,
  isObject,
  requireEvidence,
  validateOperationReport,
} = require("./report-validation.cjs");

const DEV_EVIDENCE_STATUS_CONTEXT = "Dev deployment evidence";
const DEV_EVIDENCE_TASK = "dev-evidence";
const PROOF_FILE = "dev-deployment-proof.json";
const REQUIRED_OPERATIONS = Object.freeze(["migrate-init", "preflight", "target-smoke", "activation-check"]);
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024;
const MAX_PROOF_BYTES = 1024 * 1024;

function sha256(content) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function latestById(values) {
  return (Array.isArray(values) ? values : []).reduce(
    (latest, value) => Number.isSafeInteger(value?.id) && value.id > (latest?.id || 0) ? value : latest,
    undefined,
  );
}

function statusOutcome(status) {
  if (status?.state === "success") return "success";
  if (["failure", "error"].includes(status?.state)) return "failure";
  return "pending";
}

function evaluateCommitStatusOutcome(statuses, context) {
  return statusOutcome(latestById((Array.isArray(statuses) ? statuses : []).filter((entry) => entry?.context === context)));
}

function evaluateDeploymentOutcome(deployments, deploymentStatusesByDeployment) {
  const deployment = latestById(deployments);
  return statusOutcome(latestById(deploymentStatusesByDeployment?.[deployment?.id]));
}

function evaluateDevEvidence({ statuses, deployments, deploymentStatusesByDeployment }) {
  const outcomes = [
    evaluateCommitStatusOutcome(statuses, DEV_EVIDENCE_STATUS_CONTEXT),
    evaluateDeploymentOutcome(deployments, deploymentStatusesByDeployment),
  ];
  if (outcomes.includes("failure")) return "failure";
  return outcomes.every((outcome) => outcome === "success") ? "success" : "pending";
}

function requiresVerifiedBackup(files) {
  requireEvidence(Array.isArray(files) && files.length > 0, "Changed-file evidence is missing.");
  requireEvidence(files.every((file) => typeof file?.filename === "string"), "Changed-file evidence is malformed.");
  return files.some((file) => isMigrationFile(file.filename) || isMigrationFile(file.previous_filename));
}

function proofArtifactName(sha, attempt) {
  return `azure-deploy-dev-proof-${sha}-a${attempt}`;
}

function validateProof(proof, expected) {
  requireEvidence(isObject(proof) && proof.schemaVersion === 1, "Unsupported development proof schema.");
  requireEvidence(RELEASE_SHA_PATTERN.test(expected.releaseSha || ""), "Expected merged SHA is invalid.");
  for (const field of ["releaseSha", "imageDigest", "opsImageDigest", "workflowRunId", "workflowRunAttempt"]) {
    requireEvidence(proof[field] === expected[field], `Development proof '${field}' is missing or mismatched.`);
  }
  requireEvidence(proof.environmentName === "dev", "Development proof environment must be dev.");
  requireEvidence(IMAGE_DIGEST_PATTERN.test(proof.imageDigest || "") && IMAGE_DIGEST_PATTERN.test(proof.opsImageDigest || ""), "Development proof image digests are missing or malformed.");
  requireEvidence(Number.isSafeInteger(proof.workflowRunId) && proof.workflowRunId > 0 && Number.isSafeInteger(proof.workflowRunAttempt) && proof.workflowRunAttempt > 0, "Development proof run/attempt is invalid.");
  requireEvidence(typeof proof.requiresVerifiedBackup === "boolean" && (!expected.requiresVerifiedBackup || proof.requiresVerifiedBackup), "Migration backup requirement is missing or mismatched.");

  const operations = [...REQUIRED_OPERATIONS, ...(proof.requiresVerifiedBackup ? ["verified-backup"] : [])];
  requireEvidence(Array.isArray(proof.reports) && proof.reports.length === operations.length, "Development operation report set is incomplete or ambiguous.");
  requireEvidence(new Set(proof.reports.map((entry) => entry?.operation)).size === operations.length, "Development operation reports are duplicated.");
  const parsedReports = new Map();
  const reports = proof.reports.map((entry) => {
    requireEvidence(isObject(entry) && operations.includes(entry.operation), "Unexpected development evidence operation.");
    const path = `dev/${proof.releaseSha}/${entry.operation}/run${proof.workflowRunId}-a${proof.workflowRunAttempt}-${entry.operation}/report.json`;
    requireEvidence(entry.path === path, "Immutable report path/environment/SHA/execution binding is invalid.");
    requireEvidence(typeof entry.content === "string" && Buffer.byteLength(entry.content) <= MAX_PROOF_BYTES, "Immutable report content is missing or too large.");
    requireEvidence(entry.sha256 === sha256(entry.content), "Immutable report digest mismatch.");
    let report;
    try {
      report = JSON.parse(entry.content);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new EvidenceValidationError("Immutable report is not valid JSON.");
    }
    validateOperationReport(report, {
      operation: entry.operation,
      releaseSha: proof.releaseSha,
      imageDigest: proof.imageDigest,
      environmentName: "dev",
      strict: true,
    });
    parsedReports.set(entry.operation, report);
    return { operation: entry.operation, path, sha256: entry.sha256 };
  });

  const rollout = proof.rollout;
  requireEvidence(isObject(rollout) && rollout.rolloutMode === "shadow" && rollout.hourlyTrigger === "Schedule" && rollout.dailyTrigger === "Schedule", "Development rollout is not verified shadow/Schedule.");
  requireEvidence(rollout.hourlyCron === "0 * * * *" && rollout.dailyCron === "5 0 * * *", "Development schedule evidence is mismatched.");
  requireEvidence(rollout.webImageDigest === proof.imageDigest && rollout.opsImageDigest === proof.opsImageDigest && rollout.releaseSha === proof.releaseSha, "Live rollout SHA/digests do not match the reports.");
  requireEvidence(rollout.scheduledExecutionStatus === "Succeeded" && typeof rollout.scheduledExecutionName === "string" && rollout.scheduledExecutionName.length > 0, "Scheduled execution evidence is missing or failed.");
  requireEvidence(Number.isSafeInteger(rollout.scheduleEnabledAtUnixSeconds) && rollout.scheduleEnabledAtUnixSeconds > 0 && Date.parse(rollout.scheduledExecutionStartedAt) >= rollout.scheduleEnabledAtUnixSeconds * 1000, "Scheduled execution predates the activation boundary.");
  const shadow = parsedReports.get("activation-check").shadowRun;
  const manualKey = `manual-shadow:run${proof.workflowRunId}-a${proof.workflowRunAttempt}-manual-hourly`;
  requireEvidence(rollout.manualShadowIdempotencyKey === manualKey && shadow.idempotencyKey === manualKey, "Activation is not bound to this attempt's manual shadow run.");
  requireEvidence(Number.isFinite(Date.parse(rollout.manualShadowStartedAfter)) && Date.parse(shadow.startedAt) >= Date.parse(rollout.manualShadowStartedAfter) && Date.parse(shadow.completedAt) >= Date.parse(shadow.startedAt), "Manual shadow execution is missing, stale, or incomplete.");
  requireEvidence(["SHADOW", "HOLD", "REJECTED", "LOCKED"].includes(shadow.outcome) && shadow.tradeCount === 0, "Manual shadow execution lacks a safe zero-trade terminal outcome.");
  return reports;
}

function createProof({ evidenceRoot, rollout, ...expected }) {
  requireEvidence(typeof evidenceRoot === "string" && evidenceRoot.length > 0, "Evidence directory is required.");
  requireEvidence(RELEASE_SHA_PATTERN.test(expected.releaseSha || ""), "Expected merged SHA is invalid.");
  requireEvidence(IMAGE_DIGEST_PATTERN.test(expected.imageDigest || "") && IMAGE_DIGEST_PATTERN.test(expected.opsImageDigest || ""), "Expected image digests are invalid.");
  requireEvidence(Number.isSafeInteger(expected.workflowRunId) && expected.workflowRunId > 0 && Number.isSafeInteger(expected.workflowRunAttempt) && expected.workflowRunAttempt > 0, "Expected workflow run/attempt is invalid.");
  requireEvidence(typeof expected.requiresVerifiedBackup === "boolean", "Expected migration backup requirement is missing.");
  const operations = [...REQUIRED_OPERATIONS, ...(expected.requiresVerifiedBackup ? ["verified-backup"] : [])];
  const proof = {
    schemaVersion: 1,
    environmentName: "dev",
    ...expected,
    rollout,
    reports: operations.map((operation) => {
      const path = `dev/${expected.releaseSha}/${operation}/run${expected.workflowRunId}-a${expected.workflowRunAttempt}-${operation}/report.json`;
      const content = readFileSync(join(evidenceRoot, ...path.split("/")), "utf8");
      return { operation, path, sha256: sha256(content), content };
    }),
  };
  validateProof(proof, expected);
  return proof;
}

function extractProofArchive(archive) {
  requireEvidence(Buffer.isBuffer(archive) && archive.length <= MAX_ARCHIVE_BYTES, "Development proof archive is missing or too large.");
  // Read one bounded JSON member without extracting paths or executing
  // artifact content. Python's standard ZIP reader also verifies its CRC.
  const result = spawnSync(process.platform === "win32" ? "python" : "python3", ["-c", `
import io, sys, zipfile
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:
    members = archive.infolist()
    if len(members) != 1 or members[0].filename != "${PROOF_FILE}" or members[0].file_size > ${MAX_PROOF_BYTES}:
        raise ValueError("Unexpected or oversized development proof archive member")
    sys.stdout.buffer.write(archive.read(members[0]))
`], { input: archive, maxBuffer: MAX_PROOF_BYTES, timeout: 10000, windowsHide: true });
  requireEvidence(!result.error && result.status === 0, "Development proof archive is unreadable or malformed.");
  try {
    return JSON.parse(result.stdout.toString("utf8"));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new EvidenceValidationError("Development proof archive contains invalid JSON.");
  }
}

async function readCurrentState({ github, owner, repo, sha }) {
  const [statuses, deployments] = await Promise.all([
    github.paginate(github.rest.repos.listCommitStatusesForRef, { owner, repo, ref: sha, per_page: 100 }),
    github.paginate(github.rest.repos.listDeployments, { owner, repo, sha, environment: "development", task: DEV_EVIDENCE_TASK, per_page: 100 }),
  ]);
  // Environment wrappers use task=deploy. They cannot attest an ops report.
  const authoritative = deployments.filter((deployment) => deployment.task === DEV_EVIDENCE_TASK);
  const deployment = latestById(authoritative);
  const deploymentStatuses = deployment
    ? await github.paginate(github.rest.repos.listDeploymentStatuses, { owner, repo, deployment_id: deployment.id, per_page: 100 })
    : [];
  const status = latestById(statuses.filter((entry) => entry.context === DEV_EVIDENCE_STATUS_CONTEXT));
  const deploymentStatus = latestById(deploymentStatuses);
  return {
    status,
    deployment,
    deploymentStatus,
    outcome: evaluateDevEvidence({
      statuses,
      deployments: authoritative,
      deploymentStatusesByDeployment: deployment ? { [deployment.id]: deploymentStatuses } : {},
    }),
  };
}

async function readDevEvidence(input) {
  const { github, owner, repo, sha, pullNumber } = input;
  try {
    requireEvidence(RELEASE_SHA_PATTERN.test(sha || ""), "Merged SHA is missing or malformed.");
    const current = await readCurrentState(input);
    if (current.outcome !== "success") {
      return { outcome: current.outcome, reason: current.outcome === "failure" ? "latest-development-status-failed" : "development-evidence-pending" };
    }
    const { status, deployment, deploymentStatus } = current;
    requireEvidence(deployment.sha === sha && deployment.environment === "development" && deployment.production_environment === false, "Authoritative deployment SHA/environment is mismatched.");
    const payload = deployment.payload;
    requireEvidence(isObject(payload) && payload.schemaVersion === 1 && payload.environmentName === "dev" && payload.releaseSha === sha, "Authoritative development receipt is missing or mismatched.");
    requireEvidence(Number.isSafeInteger(payload.workflowRunId) && payload.workflowRunId > 0 && Number.isSafeInteger(payload.workflowRunAttempt) && payload.workflowRunAttempt > 0, "Authoritative workflow run/attempt is invalid.");
    const runUrl = `${process.env.GITHUB_SERVER_URL || "https://github.com"}/${owner}/${repo}/actions/runs/${payload.workflowRunId}`;
    requireEvidence(status.target_url === runUrl && deploymentStatus.log_url === runUrl, "Latest commit/deployment status refers to a different workflow run.");
    const { data: run } = await github.rest.actions.getWorkflowRun({ owner, repo, run_id: payload.workflowRunId });
    requireEvidence(run.id === payload.workflowRunId && Number.isSafeInteger(run.repository?.id) && run.repository.id > 0 && Number.isSafeInteger(run.head_repository?.id) && run.head_repository.id > 0 && RELEASE_SHA_PATTERN.test(run.head_sha || ""), "Development workflow identity metadata is missing or mismatched.");
    requireEvidence(run.path === ".github/workflows/azure-deploy-dev.yml" && run.repository?.full_name === `${owner}/${repo}` && run.head_repository?.full_name === `${owner}/${repo}` && run.head_branch === "main" && ["workflow_run", "workflow_dispatch"].includes(run.event), "Development proof has untrusted workflow provenance.");
    requireEvidence(run.run_attempt === payload.workflowRunAttempt, "Development proof belongs to an earlier workflow attempt.");
    if (run.status !== "completed") return { outcome: "pending", reason: "development-workflow-in-progress" };
    requireEvidence(run.conclusion === "success", "Authoritative development workflow did not succeed.");
    requireEvidence(Number.isSafeInteger(pullNumber) && pullNumber > 0, "Merged pull request is required for development proof.");
    const [{ data: pull }, files] = await Promise.all([
      github.rest.pulls.get({ owner, repo, pull_number: pullNumber }),
      github.paginate(github.rest.pulls.listFiles, { owner, repo, pull_number: pullNumber, per_page: 100 }),
    ]);
    requireEvidence(pull.merged_at && pull.merge_commit_sha === sha, "Development proof does not match the merged pull request.");
    const artifactRef = payload.artifact;
    requireEvidence(isObject(artifactRef) && Number.isSafeInteger(artifactRef.id) && artifactRef.id > 0 && IMAGE_DIGEST_PATTERN.test(artifactRef.digest || "") && artifactRef.name === proofArtifactName(sha, payload.workflowRunAttempt), "Immutable development artifact reference is invalid.");
    const { data: artifact } = await github.rest.actions.getArtifact({ owner, repo, artifact_id: artifactRef.id });
    requireEvidence(artifact.id === artifactRef.id && artifact.name === artifactRef.name && artifact.digest === artifactRef.digest && artifact.expired === false && artifact.size_in_bytes > 0 && artifact.size_in_bytes <= MAX_ARCHIVE_BYTES && artifact.workflow_run?.id === run.id && artifact.workflow_run.head_sha === run.head_sha && artifact.workflow_run.repository_id === run.repository.id && artifact.workflow_run.head_repository_id === run.head_repository.id, "Immutable development artifact metadata is missing or mismatched.");
    const { data } = await github.rest.actions.downloadArtifact({ owner, repo, artifact_id: artifactRef.id, archive_format: "zip" });
    const archive = Buffer.from(data);
    requireEvidence(sha256(archive) === artifactRef.digest, "Immutable development artifact ZIP digest mismatch.");
    const proof = extractProofArchive(archive);
    const reports = validateProof(proof, {
      releaseSha: sha,
      imageDigest: payload.imageDigest,
      opsImageDigest: payload.opsImageDigest,
      workflowRunId: payload.workflowRunId,
      workflowRunAttempt: payload.workflowRunAttempt,
      requiresVerifiedBackup: requiresVerifiedBackup(files),
    });
    const [refreshed, { data: refreshedRun }] = await Promise.all([
      readCurrentState(input),
      github.rest.actions.getWorkflowRun({ owner, repo, run_id: payload.workflowRunId }),
    ]);
    if (refreshed.outcome === "failure") return { outcome: "failure", reason: "latest-development-status-failed" };
    if (refreshedRun.run_attempt !== payload.workflowRunAttempt || refreshedRun.status !== "completed") {
      return { outcome: "pending", reason: "development-workflow-changed-during-read" };
    }
    requireEvidence(refreshedRun.id === payload.workflowRunId && refreshedRun.conclusion === "success", "Authoritative development workflow no longer succeeds.");
    if (refreshed.outcome !== "success" || refreshed.status?.id !== status.id || refreshed.deployment?.id !== deployment.id || refreshed.deploymentStatus?.id !== deploymentStatus.id) {
      return { outcome: "pending", reason: "development-evidence-changed-during-read" };
    }
    return {
      outcome: "success",
      reason: "immutable-development-evidence-verified",
      receipt: {
        schemaVersion: 1,
        environmentName: "dev",
        releaseSha: sha,
        imageDigest: proof.imageDigest,
        opsImageDigest: proof.opsImageDigest,
        workflowRunId: run.id,
        workflowRunAttempt: run.run_attempt,
        deploymentId: deployment.id,
        commitStatusId: status.id,
        deploymentStatusId: deploymentStatus.id,
        artifact: artifactRef,
        reports,
      },
    };
  } catch (error) {
    if (!(error instanceof EvidenceValidationError)) throw error;
    return { outcome: "failure", reason: error.message };
  }
}

function publicationState({ verifyResult, rollbackResult, artifactId, artifactDigest }) {
  const verified = verifyResult === "success" && rollbackResult === "skipped" && Number.isSafeInteger(artifactId) && artifactId > 0 && IMAGE_DIGEST_PATTERN.test(artifactDigest || "");
  return {
    state: verified ? "success" : "failure",
    description: verified
      ? "Exact-SHA immutable dev reports and shadow/Schedule verified"
      : rollbackResult === "success"
        ? "Dev deployment failed; disabled/manual rollback verified"
        : "Dev deployment failed; rollback was not verified",
  };
}

module.exports = {
  DEV_EVIDENCE_STATUS_CONTEXT,
  DEV_EVIDENCE_TASK,
  PROOF_FILE,
  createProof,
  evaluateCommitStatusOutcome,
  evaluateDeploymentOutcome,
  evaluateDevEvidence,
  extractProofArchive,
  proofArtifactName,
  publicationState,
  readDevEvidence,
  requiresVerifiedBackup,
  sha256,
  validateProof,
};

if (require.main === module) {
  requireEvidence(["true", "false"].includes(process.env.REQUIRES_VERIFIED_BACKUP), "REQUIRES_VERIFIED_BACKUP must be explicitly true or false.");
  const proof = createProof({
    evidenceRoot: process.env.EVIDENCE_ROOT,
    releaseSha: process.env.RESOLVED_SHA,
    imageDigest: `sha256:${process.env.WEB_DIGEST_HEX}`,
    opsImageDigest: `sha256:${process.env.OPS_DIGEST_HEX}`,
    workflowRunId: Number(process.env.GITHUB_RUN_ID),
    workflowRunAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    requiresVerifiedBackup: process.env.REQUIRES_VERIFIED_BACKUP === "true",
    rollout: JSON.parse(readFileSync(process.env.ROLLOUT_REPORT, "utf8")),
  });
  writeFileSync(PROOF_FILE, `${JSON.stringify(proof)}\n`, { flag: "wx" });
}
