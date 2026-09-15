import { readFileSync } from "node:fs";
import {
  archiveProof, changeReport, createDevEvidenceFixture, DEV_SHA, digest, proofFixture,
} from "./fixtures/dev-evidence";

interface EvidenceResult {
  outcome: "success" | "failure" | "pending";
  reason: string;
  receipt?: { schemaVersion: number; releaseSha: string; reports: { operation: string }[] };
}

const evidence = jest.requireActual<{
  readDevEvidence(input: unknown): Promise<EvidenceResult>;
  evaluateDevEvidence(input: unknown): "success" | "failure" | "pending";
  validateProof(proof: unknown, expected: unknown): unknown;
  extractProofArchive(archive: Buffer): unknown;
  publicationState(input: unknown): { state: string; description: string };
}>("../../.github/scripts/azure/dev-evidence.cjs");

describe("immutable development evidence", () => {
  it("runs the real reader against a complete ZIP and returns only a bound v1 receipt", async () => {
    const fixture = createDevEvidenceFixture();
    const result = await evidence.readDevEvidence(fixture.input);
    expect(result).toEqual({
      outcome: "success",
      reason: "immutable-development-evidence-verified",
      receipt: {
        schemaVersion: 1, environmentName: "dev", releaseSha: DEV_SHA,
        imageDigest: fixture.proof.imageDigest, opsImageDigest: fixture.proof.opsImageDigest,
        workflowRunId: 731, workflowRunAttempt: 1, deploymentId: 501,
        commitStatusId: 10, deploymentStatusId: 20, artifact: fixture.artifactRef,
        reports: fixture.proof.reports.map(({ operation, path, sha256 }) => ({ operation, path, sha256 })),
      },
    });
    expect(fixture.github.rest.actions.downloadArtifact).toHaveBeenCalledWith({
      owner: "example", repo: "krypto", artifact_id: 601, archive_format: "zip",
    });
  });

  it.each(["failure", "error", "pending"])("does not let an old commit success override newer %s", async (state) => {
    const fixture = createDevEvidenceFixture();
    fixture.statuses.unshift({ ...fixture.statuses[0], id: 30, state });
    expect((await evidence.readDevEvidence(fixture.input)).outcome).toBe(state === "pending" ? "pending" : "failure");
    expect(fixture.github.rest.actions.downloadArtifact).not.toHaveBeenCalled();
  });

  it.each(["failure", "error", "in_progress", "inactive"])("does not let an old deployment success override newer %s", async (state) => {
    const fixture = createDevEvidenceFixture();
    fixture.deploymentStatuses.unshift({ ...fixture.deploymentStatuses[0], id: 30, state });
    expect((await evidence.readDevEvidence(fixture.input)).outcome).toBe(["failure", "error"].includes(state) ? "failure" : "pending");
  });

  it("uses the newest Deployment, not the newest status of an older Deployment", () => {
    const input = {
      statuses: [{ id: 10, context: "Dev deployment evidence", state: "success" }],
      deployments: [{ id: 2 }, { id: 1 }],
      deploymentStatusesByDeployment: {
        1: [{ id: 100, state: "success" }],
        2: [{ id: 20, state: "failure" }],
      },
    };
    expect(evidence.evaluateDevEvidence(input)).toBe("failure");
    input.deploymentStatusesByDeployment[2] = [];
    expect(evidence.evaluateDevEvidence(input)).toBe("pending");
  });

  it("ignores successful environment-wrapper Deployments", async () => {
    const fixture = createDevEvidenceFixture();
    fixture.deployments[0].task = "deploy";
    expect(await evidence.readDevEvidence(fixture.input)).toMatchObject({ outcome: "pending" });
    expect(fixture.github.rest.actions.downloadArtifact).not.toHaveBeenCalled();
  });

  it.each(["sha", "environment", "production_environment"] as const)("rejects mismatched Deployment %s", async (field) => {
    const fixture = createDevEvidenceFixture();
    if (field === "production_environment") fixture.deployments[0][field] = true;
    else fixture.deployments[0][field] = "wrong";
    expect(await evidence.readDevEvidence(fixture.input)).toMatchObject({ outcome: "failure", reason: expect.stringContaining("SHA/environment") });
  });

  it.each(["", "b".repeat(40)])("rejects a missing or different payload SHA", async (sha) => {
    const fixture = createDevEvidenceFixture();
    fixture.deployments[0].payload.releaseSha = sha;
    expect(await evidence.readDevEvidence(fixture.input)).toMatchObject({ outcome: "failure", reason: expect.stringContaining("receipt") });
  });

  it.each(["releaseSha", "imageDigest", "opsImageDigest", "environmentName"] as const)("rejects missing or wrong proof %s with otherwise valid archive digests", async (field) => {
    const fixture = createDevEvidenceFixture();
    fixture.proof[field] = "";
    fixture.updateArchive();
    expect((await evidence.readDevEvidence(fixture.input)).outcome).toBe("failure");
    expect(fixture.github.rest.actions.downloadArtifact).toHaveBeenCalled();
  });

  it.each(["migrate-init", "preflight", "target-smoke", "activation-check"])("requires exact report SHA for %s", async (operation) => {
    const fixture = createDevEvidenceFixture();
    changeReport(fixture.proof, operation, (report) => { report.releaseSha = "b".repeat(40); });
    fixture.updateArchive();
    expect(await evidence.readDevEvidence(fixture.input)).toMatchObject({ outcome: "failure", reason: expect.stringContaining("releaseSha") });
  });

  it.each(["target-smoke", "activation-check"])("requires the report digest for %s", async (operation) => {
    const fixture = createDevEvidenceFixture();
    changeReport(fixture.proof, operation, (report) => { delete report.imageDigest; });
    fixture.updateArchive();
    expect(await evidence.readDevEvidence(fixture.input)).toMatchObject({ outcome: "failure", reason: expect.stringContaining("imageDigest") });
  });

  it.each(["prod", ""])("rejects wrong or missing operation environment", async (environmentName) => {
    const fixture = createDevEvidenceFixture();
    changeReport(fixture.proof, "migrate-init", (report) => { report.environmentName = environmentName; });
    fixture.updateArchive();
    expect(await evidence.readDevEvidence(fixture.input)).toMatchObject({ outcome: "failure", reason: expect.stringContaining("environmentName") });
  });

  it.each(["migrate-init", "preflight", "target-smoke", "activation-check"])("rejects incomplete report sets missing %s", async (operation) => {
    const fixture = createDevEvidenceFixture();
    fixture.proof.reports = fixture.proof.reports.filter((report) => report.operation !== operation);
    fixture.updateArchive();
    expect(await evidence.readDevEvidence(fixture.input)).toMatchObject({ outcome: "failure", reason: expect.stringContaining("incomplete") });
  });

  it("rejects duplicated operations and environment/execution path substitution", async () => {
    const fixture = createDevEvidenceFixture();
    fixture.proof.reports[1] = { ...fixture.proof.reports[0] };
    fixture.updateArchive();
    expect(await evidence.readDevEvidence(fixture.input)).toMatchObject({ outcome: "failure", reason: expect.stringContaining("duplicated") });
    const fresh = createDevEvidenceFixture();
    fresh.proof.reports[0].path = fresh.proof.reports[0].path.replace("dev/", "prod/");
    fresh.updateArchive();
    expect(await evidence.readDevEvidence(fresh.input)).toMatchObject({ outcome: "failure", reason: expect.stringContaining("path/environment") });
  });

  it("requires a restore-verified backup for migration changes", async () => {
    const fixture = createDevEvidenceFixture();
    fixture.files[0].filename = "drizzle/0009_example.sql";
    expect(await evidence.readDevEvidence(fixture.input)).toMatchObject({ outcome: "failure", reason: expect.stringContaining("backup requirement") });
    fixture.proof.requiresVerifiedBackup = true;
    const content = JSON.stringify({
      operation: "verified-backup", releaseSha: DEV_SHA, environmentName: "dev",
      manifest: { restoreVerification: { matched: true } },
    });
    fixture.proof.reports.push({
      operation: "verified-backup", path: `dev/${DEV_SHA}/verified-backup/run731-a1-verified-backup/report.json`,
      content, sha256: digest(content),
    });
    fixture.updateArchive();
    expect((await evidence.readDevEvidence(fixture.input)).outcome).toBe("success");
    changeReport(fixture.proof, "verified-backup", (report) => {
      report.manifest = { restoreVerification: { matched: false } };
    });
    fixture.updateArchive();
    expect((await evidence.readDevEvidence(fixture.input)).outcome).toBe("failure");
  });

  it("rejects a failed target-smoke even when all wrapper statuses are green", async () => {
    const fixture = createDevEvidenceFixture();
    changeReport(fixture.proof, "target-smoke", (report) => { report.passed = false; });
    fixture.updateArchive();
    expect(await evidence.readDevEvidence(fixture.input)).toMatchObject({ outcome: "failure", reason: expect.stringContaining("passed") });
  });

  it.each(["Failed", "Running"])("rejects an interrupted or failed scheduled proof (%s)", async (status) => {
    const fixture = createDevEvidenceFixture();
    fixture.proof.rollout.scheduledExecutionStatus = status;
    fixture.updateArchive();
    expect((await evidence.readDevEvidence(fixture.input)).outcome).toBe("failure");
  });

  it("rejects a stale scheduled window or manual shadow attempt", async () => {
    const fixture = createDevEvidenceFixture();
    fixture.proof.rollout.scheduleEnabledAtUnixSeconds += 86400;
    fixture.updateArchive();
    expect(await evidence.readDevEvidence(fixture.input)).toMatchObject({ outcome: "failure", reason: expect.stringContaining("activation boundary") });
    const fresh = createDevEvidenceFixture();
    changeReport(fresh.proof, "activation-check", (report) => {
      report.shadowRun = { idempotencyKey: "manual-shadow:old", tradeCount: 0 };
    });
    fresh.updateArchive();
    expect((await evidence.readDevEvidence(fresh.input)).outcome).toBe("failure");
  });

  it("rejects altered ZIP bytes and altered report contents independently", async () => {
    const fixture = createDevEvidenceFixture();
    fixture.github.rest.actions.downloadArtifact.mockResolvedValue({ data: Buffer.from("not-the-artifact") });
    expect(await evidence.readDevEvidence(fixture.input)).toMatchObject({ outcome: "failure", reason: expect.stringContaining("ZIP digest") });
    const fresh = createDevEvidenceFixture();
    fresh.proof.reports[0].content += " ";
    fresh.updateArchive();
    expect(await evidence.readDevEvidence(fresh.input)).toMatchObject({ outcome: "failure", reason: expect.stringContaining("report digest") });
  });

  it("rejects expired artifacts and evidence from another run", async () => {
    const fixture = createDevEvidenceFixture();
    fixture.artifact.expired = true;
    expect((await evidence.readDevEvidence(fixture.input)).outcome).toBe("failure");
    fixture.artifact.expired = false;
    fixture.artifact.workflow_run.id += 1;
    expect((await evidence.readDevEvidence(fixture.input)).outcome).toBe("failure");
  });

  it("requires the trusted completed workflow, not an arbitrary green workflow or newer retry", async () => {
    const fixture = createDevEvidenceFixture();
    fixture.run.path = ".github/workflows/ci.yml";
    expect((await evidence.readDevEvidence(fixture.input)).outcome).toBe("failure");
    fixture.run.path = ".github/workflows/azure-deploy-dev.yml";
    fixture.run.status = "in_progress";
    expect((await evidence.readDevEvidence(fixture.input)).outcome).toBe("pending");
    fixture.run.status = "completed";
    fixture.run.conclusion = "cancelled";
    expect((await evidence.readDevEvidence(fixture.input)).outcome).toBe("failure");
    fixture.run.conclusion = "success";
    fixture.run.run_attempt += 1;
    expect((await evidence.readDevEvidence(fixture.input)).outcome).toBe("failure");
  });

  it("propagates read failures rather than claiming unavailable evidence is successful", async () => {
    const fixture = createDevEvidenceFixture();
    fixture.github.rest.actions.getArtifact.mockRejectedValue(new Error("artifact access denied"));
    await expect(evidence.readDevEvidence(fixture.input)).rejects.toThrow("artifact access denied");
  });

  it("rereads the current statuses after downloading proof", async () => {
    const fixture = createDevEvidenceFixture();
    fixture.github.rest.actions.downloadArtifact.mockImplementation(async () => {
      fixture.statuses.push({ ...fixture.statuses[0], id: 40, state: "failure" });
      return { data: fixture.archive };
    });
    expect(await evidence.readDevEvidence(fixture.input)).toMatchObject({ outcome: "failure", reason: "latest-development-status-failed" });
  });

  it("rejects a retry that begins while the artifact is being read, even before new statuses are published", async () => {
    const fixture = createDevEvidenceFixture();
    fixture.github.rest.actions.downloadArtifact.mockImplementation(async () => {
      fixture.run.run_attempt = 2;
      return { data: fixture.archive };
    });
    expect(await evidence.readDevEvidence(fixture.input)).toMatchObject({ outcome: "pending", reason: "development-workflow-changed-during-read" });
  });

  it("rejects arbitrary archive members and malformed archives without extracting paths", () => {
    expect(() => evidence.extractProofArchive(archiveProof(proofFixture(), "../dev-deployment-proof.json"))).toThrow("archive");
    expect(() => evidence.extractProofArchive(Buffer.from("invalid ZIP"))).toThrow("archive");
  });

  it.each(["failure", "cancelled", "skipped"])("does not convert %s into success after a verified rollback", (verifyResult) => {
    expect(evidence.publicationState({
      verifyResult, rollbackResult: "success", artifactId: 601, artifactDigest: `sha256:${"a".repeat(64)}`,
    })).toMatchObject({ state: "failure", description: expect.stringContaining("rollback verified") });
  });

  it("requires the immutable artifact and skipped rollback for publication success", () => {
    const input = { verifyResult: "success", rollbackResult: "skipped", artifactId: 601, artifactDigest: `sha256:${"a".repeat(64)}` };
    expect(evidence.publicationState(input).state).toBe("success");
    expect(evidence.publicationState({ ...input, artifactDigest: "" }).state).toBe("failure");
    expect(evidence.publicationState({ ...input, rollbackResult: "success" }).state).toBe("failure");
  });

  it("wires both lifecycle and existing full-e2e to this same real reader", () => {
    for (const path of [".github/scripts/agentic-lifecycle-reconciler.cjs", ".github/workflows/agentic-factory-full-e2e.yml"]) {
      const source = readFileSync(path, "utf8");
      expect(source).toContain("await readDevEvidence(");
      expect(source).not.toContain("deploymentStatuses.some(");
    }
  });
});
