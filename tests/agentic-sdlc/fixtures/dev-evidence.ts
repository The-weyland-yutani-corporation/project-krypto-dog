import { createHash } from "node:crypto";

export const DEV_SHA = "a".repeat(40);
export const DEV_DIGEST = `sha256:${"1".repeat(64)}`;
export const OPS_DIGEST = `sha256:${"2".repeat(64)}`;

export function digest(content: string | Buffer) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export interface ProofFixture {
  schemaVersion: number;
  environmentName: string;
  releaseSha: string;
  imageDigest: string;
  opsImageDigest: string;
  workflowRunId: number;
  workflowRunAttempt: number;
  requiresVerifiedBackup: boolean;
  rollout: {
    releaseSha: string;
    webImageDigest: string;
    opsImageDigest: string;
    rolloutMode: string;
    hourlyTrigger: string;
    dailyTrigger: string;
    hourlyCron: string;
    dailyCron: string;
    scheduledExecutionName: string;
    scheduledExecutionStatus: string;
    scheduledExecutionStartedAt: string;
    scheduleEnabledAtUnixSeconds: number;
    manualShadowIdempotencyKey: string;
    manualShadowStartedAfter: string;
  };
  reports: { operation: string; path: string; sha256: string; content: string }[];
}

export function proofFixture(): ProofFixture {
  const reports: Record<string, Record<string, unknown>> = {
    "migrate-init": {
      operation: "migrate-init", environmentName: "dev", releaseSha: DEV_SHA,
      success: true, migrated: true, runtimeLoginBootstrapped: true, initialized: true,
    },
    preflight: {
      operation: "preflight", environmentName: "dev", releaseSha: DEV_SHA,
      preflight: { databasePreflightPassed: true, checks: [{ id: "database", status: "pass" }], blockers: [] },
    },
    "target-smoke": {
      schemaVersion: "1.4.0", releaseSha: DEV_SHA, imageDigest: DEV_DIGEST,
      passed: true, rolloutMode: "disabled", checks: [{ id: "target", status: "pass" }],
      binding: {
        releaseSha: DEV_SHA, imageDigest: DEV_DIGEST, rolloutMode: "disabled",
        approvalId: "approval", bindingId: "binding", targetOrigin: "https://dev.example.test",
        cronSecretBinding: "3".repeat(64), approvalSignature: "4".repeat(64),
      },
    },
    "activation-check": {
      schemaVersion: "1.0.0", releaseSha: DEV_SHA, imageDigest: DEV_DIGEST,
      approved: true, checks: [{ id: "shadow", status: "pass" }], blockers: [],
      shadowRun: {
        id: "manual-run", idempotencyKey: "manual-shadow:run731-a1-manual-hourly",
        outcome: "SHADOW", startedAt: "2026-08-20T21:01:05Z",
        completedAt: "2026-08-20T21:01:10Z", tradeCount: 0,
      },
    },
  };
  return {
    schemaVersion: 1, environmentName: "dev", releaseSha: DEV_SHA,
    imageDigest: DEV_DIGEST, opsImageDigest: OPS_DIGEST,
    workflowRunId: 731, workflowRunAttempt: 1, requiresVerifiedBackup: false,
    rollout: {
      releaseSha: DEV_SHA, webImageDigest: DEV_DIGEST, opsImageDigest: OPS_DIGEST,
      rolloutMode: "shadow", hourlyTrigger: "Schedule", dailyTrigger: "Schedule",
      hourlyCron: "0 * * * *", dailyCron: "5 0 * * *",
      scheduledExecutionName: "hourly-current", scheduledExecutionStatus: "Succeeded",
      scheduledExecutionStartedAt: "2026-08-20T22:00:00Z",
      scheduleEnabledAtUnixSeconds: Date.parse("2026-08-20T21:02:00Z") / 1000,
      manualShadowIdempotencyKey: "manual-shadow:run731-a1-manual-hourly",
      manualShadowStartedAfter: "2026-08-20T21:01:00Z",
    },
    reports: Object.entries(reports).map(([operation, report]) => {
      const content = `${JSON.stringify(report)}\n`;
      return {
        operation, content, sha256: digest(content),
        path: `dev/${DEV_SHA}/${operation}/run731-a1-${operation}/report.json`,
      };
    }),
  };
}

export function changeReport(proof: ProofFixture, operation: string, change: (report: Record<string, unknown>) => void) {
  const entry = proof.reports.find((report) => report.operation === operation);
  if (!entry) throw new Error(`Missing fixture operation: ${operation}`);
  const report: Record<string, unknown> = JSON.parse(entry.content);
  change(report);
  entry.content = `${JSON.stringify(report)}\n`;
  entry.sha256 = digest(entry.content);
}

export function archiveProof(proof: ProofFixture, member = "dev-deployment-proof.json") {
  const content = Buffer.from(JSON.stringify(proof));
  const name = Buffer.from(member);
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  // A deterministic stored ZIP member with a real CRC, consumed by the
  // production archive reader rather than a mocked decompressor.
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + content.length, 16);
  return Buffer.concat([local, name, content, central, name, end]);
}

export function createDevEvidenceFixture({ owner = "example", repo = "krypto" } = {}) {
  const proof = proofFixture();
  const archive = archiveProof(proof);
  const runUrl = `https://github.com/${owner}/${repo}/actions/runs/731`;
  const statuses = [{ id: 10, context: "Dev deployment evidence", state: "success", target_url: runUrl }];
  const artifactRef = { id: 601, name: `azure-deploy-dev-proof-${DEV_SHA}-a1`, digest: digest(archive) };
  const deployments = [{
    id: 501, task: "dev-evidence", sha: DEV_SHA, environment: "development", production_environment: false,
    payload: {
      schemaVersion: 1, environmentName: "dev", releaseSha: DEV_SHA,
      imageDigest: DEV_DIGEST, opsImageDigest: OPS_DIGEST,
      workflowRunId: 731, workflowRunAttempt: 1, artifact: artifactRef,
    },
  }];
  const deploymentStatuses = [{ id: 20, state: "success", log_url: runUrl }];
  const run = {
    id: 731, path: ".github/workflows/azure-deploy-dev.yml",
    repository: { id: 1, full_name: `${owner}/${repo}` },
    head_repository: { id: 1, full_name: `${owner}/${repo}` },
    head_sha: DEV_SHA, head_branch: "main", event: "workflow_run",
    run_attempt: 1, status: "completed", conclusion: "success",
  };
  const artifact = {
    ...artifactRef, expired: false, size_in_bytes: archive.length,
    workflow_run: { id: 731, head_sha: DEV_SHA, repository_id: 1, head_repository_id: 1 },
  };
  const files = [{ filename: "docs/example.md" }];
  const repos = {
    listCommitStatusesForRef: jest.fn(), listDeployments: jest.fn(), listDeploymentStatuses: jest.fn(),
  };
  const pulls = {
    get: jest.fn(async () => ({ data: { merged_at: "2026-08-20T20:00:00Z", merge_commit_sha: DEV_SHA } })),
    listFiles: jest.fn(),
  };
  const github = {
    paginate: jest.fn(async (method: unknown) => {
      if (method === repos.listCommitStatusesForRef) return statuses;
      if (method === repos.listDeployments) return deployments;
      if (method === repos.listDeploymentStatuses) return deploymentStatuses;
      if (method === pulls.listFiles) return files;
      throw new Error("Unexpected evidence fixture API");
    }),
    rest: {
      repos, pulls,
      actions: {
        getWorkflowRun: jest.fn(async () => ({ data: run })),
        getArtifact: jest.fn(async () => ({ data: artifact })),
        downloadArtifact: jest.fn(async () => ({ data: archive })),
      },
    },
  };
  function updateArchive() {
    const next = archiveProof(proof);
    artifactRef.digest = digest(next);
    artifact.digest = artifactRef.digest;
    artifact.size_in_bytes = next.length;
    github.rest.actions.downloadArtifact.mockResolvedValue({ data: next });
  }
  return {
    proof, archive, statuses, deployments, deploymentStatuses, run, artifact, artifactRef, files,
    github, updateArchive,
    input: { github, owner, repo, sha: DEV_SHA, pullNumber: 110 },
  };
}
