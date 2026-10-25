import { archive } from "../../agentic-sdlc/receipt-archive-fixture";
import { productionPromotionFixture } from "./production-promotion-fixture";

const api = jest.requireActual<{
  createPromotionReceipt(env: unknown, needs: unknown, run: unknown): unknown;
  validatePromotionReceipt(receipt: unknown, run: unknown, expected: unknown): unknown;
  loadVerifiedPromotionReceipt(options: unknown): Promise<unknown>;
  loadDeployedProductionReceipt(options: unknown): Promise<unknown>;
  inspectProductionDelivery(options: unknown): Promise<{ state: string; reason: string; receipt?: unknown }>;
  assertPromotionActor(options: unknown): Promise<unknown>;
  productionAuthorization(options: unknown): string;
}>("../../../.github/scripts/azure/production-evidence.cjs");

function changed(value: unknown, location: string[], replacement: unknown): unknown {
  if (!location.length) return replacement;
  if (!value || typeof value !== "object") throw new Error("Fixture mutation requires an object.");
  const [key, ...rest] = location;
  const next = changed(Reflect.get(value, key), rest, replacement);
  if (Array.isArray(value)) return value.map((entry, index) => String(index) === key ? next : entry);
  return { ...value, [key]: next };
}

describe("native paper-production evidence", () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(new Date("2026-10-22T01:03:00.000Z")));
  afterEach(() => jest.useRealTimers());

  it("produces and validates the same exact-attempt native paper receipt", () => {
    const fixture = productionPromotionFixture();
    expect(api.createPromotionReceipt(fixture.env, fixture.needs, fixture.run)).toEqual(fixture.receipt);
    expect(api.validatePromotionReceipt(fixture.receipt, fixture.run, fixture.expected)).toBe(fixture.receipt);
  });

  it("verifies the immutable archive, actual job windows, development and stable native metadata", async () => {
    const fixture = productionPromotionFixture();
    await expect(api.loadVerifiedPromotionReceipt(fixture.options)).resolves.toEqual(fixture.receipt);
    expect(fixture.github.rest.actions.downloadArtifact).toHaveBeenCalledWith({
      owner: "owner", repo: "project", artifact_id: 501, archive_format: "zip",
    });
    expect(fixture.github.rest.actions.downloadArtifact).toHaveBeenCalledWith({
      owner: "owner", repo: "project", artifact_id: 502, archive_format: "zip",
    });
    expect(fixture.github.paginate).toHaveBeenCalledWith(
      fixture.github.rest.actions.listJobsForWorkflowRunAttempt,
      { owner: "owner", repo: "project", run_id: 1001, attempt_number: 2, per_page: 100 },
    );
  });

  it.each([
    ["schemaVersion", 3], ["stage", "release"], ["status", "promoted"],
    ["repositoryId", 999], ["repositoryOwnerId", 999], ["runId", 1000],
    ["runAttempt", 1], ["workflowId", 999], ["actorId", 999], ["triggeringActorId", 999],
    ["releaseSha", "b".repeat(40)], ["generatedAt", "2026-10-21T00:00:00.000Z"],
    ["evidence.authorizationId", "a".repeat(64)], ["evidence.scheduleGeneration", 1],
    ["evidence.privateProof", "private-token-must-never-be-published"],
    ["authority.mode", "automatic"], ["authority.actorId", 999],
    ["authority.previous", { runId: 1001 }], ["release.status", "paper"],
    ["results.promote-paper", "skipped"], ["evidence.approvalCreatedAfter", "2026-10-21T00:00:00.000Z"],
    ["evidence.manualShadow.idempotencyKey", "manual-shadow:run1001-a1-prod-shadow"],
    ["evidence.manualShadow.executionName", "scheduled-hour"],
    ["evidence.ready.approvalId", "older-smoke"], ["evidence.ready.approved", false],
    ["evidence.ready.shadowRun.tradeCount", 1], ["evidence.ready.shadowRun.outcome", "LOCKED"],
    ["evidence.ready.shadowRun.errorType", "UNKNOWN_ERROR"],
    ["evidence.ready.jobExecutionId", "run1001-a1-prod-ready"],
    ["evidence.ready.token", "private-token"], ["evidence.ready.checks", []],
    ["evidence.scheduled.workflowObservation.runId", "1000"],
    ["evidence.scheduled.workflowObservation.runAttempt", 1],
    ["evidence.scheduled.workflowObservation.repositoryOwnerId", "999"],
    ["evidence.scheduled.workflowObservation.workflowSha", "b".repeat(40)],
    ["evidence.scheduled.workflowObservation.expiresAt", "2026-10-22T01:00:00.000Z"],
    ["evidence.scheduled.scheduledRun.journalCount", 0],
    ["evidence.scheduled.scheduledRun.tradeCount", 1],
    ["evidence.scheduled.scheduledRun.completedAt", "2026-10-22T01:01:00.000Z"],
    ["evidence.scheduled.scheduledExecution.originAssurance", "origin-proven"],
    ["evidence.scheduled.scheduledExecution.scheduleEnabledAt", "2026-10-22T01:00:00.000Z"],
    ["evidence.scheduled.posthog.keyBinding", "a".repeat(64)],
  ])("rejects inconsistent or untrusted paper evidence %s", (location, value) => {
    const fixture = productionPromotionFixture();
    expect(() => api.validatePromotionReceipt(
      changed(fixture.receipt, String(location).split("."), value), fixture.run, fixture.expected,
    )).toThrow();
  });

  it.each(["queued", "in_progress"])("never treats an unfinished %s workflow as evidence", async (status) => {
    const fixture = productionPromotionFixture();
    fixture.run.status = status;
    await expect(api.loadVerifiedPromotionReceipt(fixture.options)).rejects.toThrow("not terminal");
    expect(fixture.github.rest.actions.downloadArtifact).not.toHaveBeenCalled();
  });

  it.each(["failure", "cancelled", "timed_out", "neutral"])("rejects native conclusion %s", async (conclusion) => {
    const fixture = productionPromotionFixture();
    fixture.run.conclusion = conclusion;
    await expect(api.loadVerifiedPromotionReceipt(fixture.options)).rejects.toThrow("failed native workflow");
  });

  it.each(["prepare-paper", "promote-paper", "publish-promotion-receipt", "publish-production-delivery", "recover-paper", "release-recovered-fence"])
    ("requires the actual native result for %s", async (id) => {
      const fixture = productionPromotionFixture();
      const names = jest.requireActual<{ PRODUCTION_JOB_NAMES: Record<string, string> }>(
        "../../../.github/scripts/azure/production-evidence.cjs",
      ).PRODUCTION_JOB_NAMES;
      const job = fixture.nativeJobs.find((value) => value.name === names[id]);
      if (!job) throw new Error("Missing fixture job.");
      job.conclusion = job.conclusion === "success" ? "skipped" : "success";
      await expect(api.loadVerifiedPromotionReceipt(fixture.options)).rejects.toThrow("actual production attempt");
    });

  it("keeps historical schema-1 jobs exact without allowing a schema downgrade to omit current recovery", async () => {
    const historical = productionPromotionFixture();
    historical.receipt.schemaVersion = 1;
    historical.nativeJobs.splice(historical.nativeJobs.findIndex((job) => job.name.includes("recovered source or candidate")), 1);
    await expect(api.loadVerifiedPromotionReceipt(historical.options)).resolves.toEqual(historical.receipt);

    const downgrade = productionPromotionFixture();
    downgrade.receipt.schemaVersion = 1;
    await expect(api.loadVerifiedPromotionReceipt(downgrade.options)).rejects.toThrow("Unexpected native production jobs");
    const missing = productionPromotionFixture();
    missing.nativeJobs.splice(missing.nativeJobs.findIndex((job) => job.name.includes("recovered source or candidate")), 1);
    await expect(api.loadVerifiedPromotionReceipt(missing.options)).rejects.toThrow("Unexpected native production jobs");
  });

  it("rejects extra jobs and historical reports outside the actual native producer window", async () => {
    const extra = productionPromotionFixture();
    extra.nativeJobs.push({ ...extra.nativeJobs[0], name: "Unexpected cloud mutation" });
    await expect(api.loadVerifiedPromotionReceipt(extra.options)).rejects.toThrow("Unexpected native production jobs");
    const stale = productionPromotionFixture();
    const producer = stale.nativeJobs.find((job) => job.name.includes("Activate paper"));
    if (!producer) throw new Error("Missing fixture producer.");
    producer.started_at = stale.time(60);
    await expect(api.loadVerifiedPromotionReceipt(stale.options)).rejects.toThrow("actual producer job");
  });

  it.each(["missing", "expired", "duplicate"])("rejects %s native promotion archives", async (kind) => {
    const fixture = productionPromotionFixture();
    if (kind === "missing") fixture.artifacts.length = 0;
    if (kind === "expired") fixture.artifacts[0].expired = true;
    if (kind === "duplicate") fixture.artifacts.push({ ...fixture.artifacts[0], id: 503 });
    await expect(api.loadVerifiedPromotionReceipt(fixture.options)).rejects.toThrow("unique trusted-run");
  });

  it("rejects development reruns and failed development jobs after promotion", async () => {
    const rerun = productionPromotionFixture();
    rerun.developmentRun.run_attempt = 2;
    await expect(api.loadVerifiedPromotionReceipt(rerun.options)).rejects.toThrow("development attempt was superseded");
    const failed = productionPromotionFixture();
    failed.developmentJobs[0].conclusion = "failure";
    await expect(api.loadVerifiedPromotionReceipt(failed.options)).rejects.toThrow("actual development attempt");
  });

  it("rejects a superseded production attempt or changed metadata during verification", async () => {
    const rerun = productionPromotionFixture();
    rerun.run.run_attempt = 3;
    await expect(api.loadVerifiedPromotionReceipt(rerun.options)).rejects.toThrow("attempt was superseded");
    const drift = productionPromotionFixture();
    const native = drift.github.rest.actions.getWorkflowRun.getMockImplementation();
    if (!native) throw new Error("Missing native fixture reader.");
    let productionReads = 0;
    drift.github.rest.actions.getWorkflowRun.mockImplementation(async (args) => {
      if (args.run_id === 1001 && ++productionReads > 1) {
        return { data: { ...drift.run, updated_at: drift.time(66) } };
      }
      return native(args);
    });
    await expect(api.loadVerifiedPromotionReceipt(drift.options)).rejects.toThrow("changed during");
  });

  it("preserves honest failed and disabled outcomes instead of manufacturing paper evidence", () => {
    const fixture = productionPromotionFixture();
    fixture.needs["promote-paper"].result = "failure";
    expect(api.createPromotionReceipt(fixture.env, fixture.needs, fixture.run))
      .toMatchObject({ status: "failed", evidence: null });
    fixture.needs["prepare-paper"].result = "skipped";
    fixture.needs["promote-paper"].result = "skipped";
    fixture.needs["force-disable-rollout"].outputs.promotion_authority = JSON.stringify({ ...fixture.authority, mode: "disabled" });
    expect(api.createPromotionReceipt(fixture.env, fixture.needs, fixture.run))
      .toMatchObject({ status: "disabled", evidence: null });
    fixture.needs["publish-release-receipt"].result = "failure";
    expect(api.createPromotionReceipt(fixture.env, fixture.needs, fixture.run))
      .toMatchObject({ status: "failed", evidence: null });
  });

  it("requires the exact deployed binding and generation, not just a successful Deployment status", async () => {
    const fixture = productionPromotionFixture();
    const options = { ...fixture.options, binding: fixture.binding, scheduleGeneration: fixture.evidence.scheduleGeneration };
    await expect(api.loadDeployedProductionReceipt(options)).resolves.toEqual(fixture.receipt);
    await expect(api.loadDeployedProductionReceipt({ ...options, scheduleGeneration: 1 })).rejects.toThrow("generation changed");
    await expect(api.loadDeployedProductionReceipt({
      ...options, binding: { ...fixture.binding, opsImageDigest: `sha256:${"a".repeat(64)}` },
    })).rejects.toThrow("actual deployed release");
    fixture.github.rest.repos.listDeploymentStatuses.mockResolvedValue({
      data: [{ id: 401, state: "success" }, { id: 402, state: "failure" }],
    });
    await expect(api.loadDeployedProductionReceipt(options)).rejects.toThrow("latest production deployment");
  });

  it("surfaces API failure without retrying or substituting a cached receipt", async () => {
    const fixture = productionPromotionFixture();
    fixture.github.rest.actions.getWorkflowRun.mockRejectedValue(new Error("GitHub read denied"));
    await expect(api.loadVerifiedPromotionReceipt(fixture.options)).rejects.toThrow("GitHub read denied");
    expect(fixture.github.rest.actions.getWorkflowRun).toHaveBeenCalledTimes(1);
  });

  it("does not confuse pending, failed or disabled production with end-to-end delivery", async () => {
    const fixture = productionPromotionFixture();
    const options = { ...fixture.options, releaseSha: fixture.sha };
    fixture.run.status = "in_progress";
    await expect(api.inspectProductionDelivery(options)).resolves.toMatchObject({ state: "pending" });
    fixture.run.status = "completed";
    fixture.run.conclusion = "failure";
    await expect(api.inspectProductionDelivery(options)).resolves.toMatchObject({ state: "failure" });
    fixture.run.conclusion = "success";
    const disabled = {
      ...fixture.receipt, status: "disabled", evidence: null,
      results: { ...fixture.receipt.results, "prepare-paper": "skipped", "promote-paper": "skipped" },
    };
    fixture.github.rest.actions.downloadArtifact.mockResolvedValue({ data: archive(disabled) });
    await expect(api.inspectProductionDelivery(options)).resolves.toMatchObject({ state: "pending", reason: "production-disabled" });
  });

  it("accepts completion only after matching native paper and GitHub delivery evidence", async () => {
    const fixture = productionPromotionFixture();
    await expect(api.inspectProductionDelivery({ ...fixture.options, releaseSha: fixture.sha }))
      .resolves.toMatchObject({ state: "success", receipt: fixture.receipt });
  });

  it("requires authenticated write-authorized operators for first activation, including reruns", async () => {
    const fixture = productionPromotionFixture();
    fixture.run.status = "in_progress";
    const options = { ...fixture.options, env: fixture.env, mode: "operator" };
    await expect(api.assertPromotionActor(options)).resolves.toBe(fixture.run);
    expect(fixture.github.rest.repos.getCollaboratorPermissionLevel).toHaveBeenCalledTimes(2);
    fixture.run.triggering_actor.type = "Bot";
    await expect(api.assertPromotionActor(options)).rejects.toThrow("bot cannot authorize");
    fixture.run.triggering_actor.type = "User";
    fixture.github.rest.repos.getCollaboratorPermissionLevel.mockResolvedValue({ data: { permission: "read" } });
    await expect(api.assertPromotionActor(options)).rejects.toThrow("write permission");
  });
});
