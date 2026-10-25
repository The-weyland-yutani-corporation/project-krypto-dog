type Job = { result: string; outputs: Record<string, string> };
type Receipt = Record<string, unknown>;

const {
  RELEASE_JOBS, createReleaseReceipt, receiptName, validateReceipt, validateWorkflowRun,
  productionVerificationOverrides,
} = jest.requireActual<{
  RELEASE_JOBS: string[];
  createReleaseReceipt: (env: Record<string, string | undefined>, needs: Record<string, Job>) => Receipt;
  receiptName: (stage: string, sha: string, id: number, attempt: number) => string;
  validateReceipt: (receipt: unknown, run: unknown, expected: Record<string, string>) => Receipt;
  validateWorkflowRun: (run: unknown, expected: Record<string, string>) => unknown;
  productionVerificationOverrides: (config: unknown) => Array<{ name: string; value: string }>;
}>("../../../.github/scripts/azure/production-evidence.cjs");

const SHA = "a".repeat(40);
const env = {
  GITHUB_REPOSITORY: "owner/project",
  GITHUB_REPOSITORY_ID: "456",
  GITHUB_RUN_ID: "1001",
  GITHUB_RUN_ATTEMPT: "2",
  GITHUB_REF: "refs/heads/main",
  GITHUB_SHA: SHA,
  RESOLVED_SHA: SHA,
};
const expected = { repository: env.GITHUB_REPOSITORY, stage: "release", releaseSha: SHA };
const run = {
  id: 1001, run_attempt: 2, repository: { id: 456, full_name: env.GITHUB_REPOSITORY },
  head_repository: { id: 456 }, head_branch: "main", head_sha: SHA,
  path: ".github/workflows/azure-deploy-prod.yml", event: "workflow_dispatch",
  status: "completed", conclusion: "success",
  run_started_at: "2026-10-22T00:00:00Z", updated_at: "2026-10-22T01:00:00Z",
};

function jobs(existing = false): Record<string, Job> {
  const result: Record<string, Job> = Object.fromEntries(
    RELEASE_JOBS.map((name) => [name, { result: "success", outputs: {} }]),
  );
  result.gate.outputs = { sha: SHA, deployment_stage: "full" };
  result["force-disable-rollout"].outputs = {
    existing_release: String(existing), admission_status: existing ? "admitted" : "",
  };
  result["release-cutover-fence"].outputs.status = existing ? "released" : "fresh";
  result["deploy-environment"].outputs = {
    acr_login_server: "acrkryptoprod.azurecr.io",
    evidence_container_url: "https://kryptoprod.blob.core.windows.net/evidence",
  };
  result["build-images"].outputs = { web_digest_hex: "b".repeat(64), ops_digest_hex: "c".repeat(64) };
  result["verify-final-state"].outputs.target_origin = "https://production.example.com";
  result["migrate-backup"].outputs.job_execution_id = "run1001-a1-baseline";
  result["target-smoke"].outputs.job_execution_id = "run1001-a2-smoke";
  return result;
}

describe("immutable production release evidence", () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date("2026-10-22T00:59:00Z"));
  });

  describe("closed production verification override configuration", () => {
    const common = { authorizationId: "c".repeat(64), scheduleGeneration: 1792620000 };
    const ready = {
      ...common, phase: "ready", approvalId: "signed-smoke-id",
      approvalCreatedAfter: "2026-10-22T00:00:00Z",
      shadowIdempotencyKey: "manual-shadow:run1-a1",
      shadowStartedAfter: "2026-10-22T00:05:00Z",
    };

    beforeEach(() => jest.useFakeTimers().setSystemTime(new Date("2026-10-22T00:59:00Z")));
    afterEach(() => jest.useRealTimers());

    it("maps only the exact ready fields without overriding credentials or Azure's builtin identity", () => {
      const overrides = productionVerificationOverrides(ready);
      expect(overrides).toEqual([
        { name: "OPERATION", value: "production-verification" },
        { name: "PRODUCTION_VERIFICATION_PHASE", value: "ready" },
        { name: "PRODUCTION_AUTHORIZATION_ID", value: common.authorizationId },
        { name: "SCHEDULE_GENERATION_UNIX_SECONDS", value: String(common.scheduleGeneration) },
        { name: "EXPECTED_APPROVAL_ID", value: ready.approvalId },
        { name: "EXPECTED_APPROVAL_CREATED_AFTER", value: ready.approvalCreatedAfter },
        { name: "EXPECTED_SHADOW_IDEMPOTENCY_KEY", value: ready.shadowIdempotencyKey },
        { name: "EXPECTED_SHADOW_STARTED_AFTER", value: ready.shadowStartedAfter },
      ]);
    });

    it("accepts only authorization and generation, leaving execution timing to the signed proof", () => {
      expect(productionVerificationOverrides({ ...common, phase: "scheduled" })).toEqual([
        { name: "OPERATION", value: "production-verification" },
        { name: "PRODUCTION_VERIFICATION_PHASE", value: "scheduled" },
        { name: "PRODUCTION_AUTHORIZATION_ID", value: common.authorizationId },
        { name: "SCHEDULE_GENERATION_UNIX_SECONDS", value: String(common.scheduleGeneration) },
      ]);
    });

    it.each([
      { phase: "live" }, { approvalId: "" }, { authorizationId: "not-a-digest" },
      { scheduleGeneration: 0 }, { scheduleGeneration: "1792620000" },
      { scheduleGeneration: 9999999999 }, { shadowIdempotencyKey: "cron:old-run" },
      { shadowStartedAfter: "2026-10-22T00:05:00.123Z" },
      { approvalCreatedAfter: "2026-02-30T00:00:00Z" },
      { approvalCreatedAfter: "2026-10-22T00:00:00+00:00" },
      { DIRECT_URL: "unexpected" }, { CONTAINER_APP_JOB_EXECUTION_NAME: "forged" },
      { scheduleEnabledAt: 1792620001 },
    ])("rejects invalid or additional fields: %j", (overrides) => {
      expect(() => productionVerificationOverrides({ ...ready, ...overrides })).toThrow();
    });

    it("rejects missing required fields and caller-selected execution timing", () => {
      expect(() => productionVerificationOverrides({ ...common, phase: "ready" })).toThrow();
      for (const extra of [
        { scheduleEnabledAt: common.scheduleGeneration + 1 },
        { scheduledExecutionStartedAt: "2026-10-22T00:00:01Z" },
        { DEPLOYMENT_WORKFLOW_OBSERVATION: "{}" }, { azureExecutionName: "caller-selected" },
      ]) expect(() => productionVerificationOverrides({ ...common, phase: "scheduled", ...extra })).toThrow();
    });
  });
  afterEach(() => jest.useRealTimers());

  it.each([false, true])("binds a verified disabled release (existing=%s) to its workflow attempt", (existing) => {
    const receipt = createReleaseReceipt(env, jobs(existing));
    expect(receipt).toMatchObject({
      status: "disabled", stage: "release", runId: 1001, runAttempt: 2,
      rolloutMode: "disabled", hourlyTriggerType: "Manual", dailyTriggerType: "Manual",
      backupExecutionId: "run1001-a1-baseline", smokeExecutionId: "run1001-a2-smoke",
    });
    expect(validateReceipt(receipt, run, expected)).toBe(receipt);
    expect(receiptName("release", SHA, 1001, 2)).toBe(`production-release-${SHA}-1001-2`);
    expect(receiptName("release", SHA, 1001, 1)).not.toBe(receiptName("release", SHA, 1001, 2));
  });

  it("distinguishes a successful no-mutation deferral from a disabled release", () => {
    const results = jobs(true);
    results["force-disable-rollout"].outputs.admission_status = "deferred";
    for (const name of RELEASE_JOBS.slice(2)) results[name] = { result: "skipped", outputs: {} };
    const receipt = createReleaseReceipt(env, results);
    expect(receipt.status).toBe("deferred");
    expect(receipt.binding).toBeNull();
    expect(validateReceipt(receipt, run, expected)).toBe(receipt);
    results["deploy-environment"].result = "success";
    expect(createReleaseReceipt(env, results).status).toBe("failed");
  });

  it.each(RELEASE_JOBS.filter((name) => name !== "gate"))("does not promote partial %s success", (name) => {
    const results = jobs();
    results[name].result = "skipped";
    expect(createReleaseReceipt(env, results)).toMatchObject({ status: "failed", binding: null });
  });

  it("records a genuine failure without inventing a disabled recovery", () => {
    const results = jobs();
    results["force-disable-rollout"].result = "failure";
    const receipt = createReleaseReceipt(env, results);
    expect(receipt.status).toBe("failed");
    expect(receipt.rolloutMode).toBeUndefined();
    expect(validateReceipt(receipt, { ...run, conclusion: "failure" }, expected)).toBe(receipt);
  });

  it.each(["foundation", "", "FULL"])("never emits release evidence for stage %s", (stage) => {
    const results = jobs();
    results.gate.outputs.deployment_stage = stage;
    expect(() => createReleaseReceipt(env, results)).toThrow("foundation");
  });

  it.each([
    ["GITHUB_REF", "refs/heads/feature"],
    ["GITHUB_RUN_ID", "0"],
    ["GITHUB_RUN_ATTEMPT", "02"],
    ["GITHUB_REPOSITORY_ID", "9007199254740992"],
    ["GITHUB_SHA", ""],
    ["RESOLVED_SHA", "b".repeat(40)],
  ])("rejects malformed producer identity %s", (key, value) => {
    expect(() => createReleaseReceipt({ ...env, [key]: value }, jobs())).toThrow();
  });

  it.each([
    ["deploy-environment", "acr_login_server", "attacker.example.com"],
    ["deploy-environment", "evidence_container_url", "https://kryptoprod.blob.core.windows.net/evidence?sig=secret"],
    ["build-images", "web_digest_hex", ""],
    ["verify-final-state", "target_origin", "https://user:password@example.com"],
    ["migrate-backup", "job_execution_id", "../another-report"],
    ["target-smoke", "job_execution_id", ""],
  ])("rejects incomplete or unsafe %s binding %s", (name, key, value) => {
    const results = jobs();
    results[name].outputs[key] = value;
    expect(() => createReleaseReceipt(env, results)).toThrow();
  });

  it.each([
    { path: ".github/workflows/azure-deploy-dev.yml" },
    { head_branch: "feature" },
    { head_repository: { id: 999 } },
    { event: "pull_request" },
    { repository: { id: 456, full_name: "another/project" } },
    { run_attempt: 0 },
  ])("rejects unrelated workflow provenance %j", (overrides) => {
    expect(() => validateWorkflowRun({ ...run, ...overrides }, expected)).toThrow();
  });

  it.each([
    { runAttempt: 1 }, { runId: 999 }, { workflowSha: "b".repeat(40) },
    { releaseSha: "d".repeat(40) }, { repositoryId: 999 }, { stage: "promotion" },
    { generatedAt: "2026-10-21T23:00:00Z" }, { generatedAt: "2026-10-22T01:03:00Z" },
    { hourlyTriggerType: "Schedule" }, { rolloutMode: "paper" },
    { status: "success" }, { results: {} },
  ])("rejects forged or replayed receipt fields %j", (overrides) => {
    const receipt = { ...createReleaseReceipt(env, jobs()), ...overrides };
    expect(() => validateReceipt(receipt, run, expected)).toThrow();
  });

  it.each(["in_progress", "queued"])("does not accept evidence from a %s run", (status) => {
    expect(() => validateReceipt(createReleaseReceipt(env, jobs()), { ...run, status }, expected))
      .toThrow("not terminal");
  });

  it("cannot replace missing required provenance with a green workflow", () => {
    const receipt = createReleaseReceipt(env, jobs());
    delete receipt.backupExecutionId;
    expect(() => validateReceipt(receipt, run, expected)).toThrow("Backup");
    expect(() => validateReceipt(createReleaseReceipt(env, jobs()), { ...run, conclusion: "failure" }, expected))
      .toThrow("failed workflow");
  });

  it("does not ship a provisional paper-promotion authorization contract", () => {
    expect(() => receiptName("promotion", SHA, 1001, 2)).toThrow("Only disabled-release");
    expect(() => validateReceipt(
      { ...createReleaseReceipt(env, jobs()), status: "promoted", rolloutMode: "paper" },
      run, { ...expected, stage: "promotion" },
    )).toThrow("Only disabled-release");
  });
});
