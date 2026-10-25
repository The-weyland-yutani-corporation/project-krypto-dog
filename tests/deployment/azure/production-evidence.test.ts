import { archive } from "../../agentic-sdlc/receipt-archive-fixture";

type Job = { result: string; outputs: Record<string, string> };
type Receipt = Record<string, unknown>;
type Expected = Record<string, string | number>;
type DevelopmentOptions = {
  github: unknown; owner: string; repo: string; repositoryId: number; releaseSha: string;
  expectedRunId?: number; expectedRunAttempt?: number;
};

const {
  RELEASE_JOBS, createReleaseReceipt, receiptName, validateReceipt, validateWorkflowRun,
  productionVerificationOverrides, DEVELOPMENT_JOBS, DEVELOPMENT_WORKFLOW, DEVELOPMENT_PUBLISHER,
  DEVELOPMENT_RECEIPT_PUBLISHER, DEVELOPMENT_ROLLBACK, createDevelopmentReceipt, loadLatestDevelopmentReceipt,
  resolveProductionInvocation, assertProductionFactoryMode,
} = jest.requireActual<{
  RELEASE_JOBS: string[];
  createReleaseReceipt: (env: Record<string, string | undefined>, needs: Record<string, Job>) => Receipt;
  receiptName: (stage: string, sha: string, id: number, attempt: number) => string;
  validateReceipt: (receipt: unknown, run: unknown, expected: Expected) => Receipt;
  validateWorkflowRun: (run: unknown, expected: Expected) => unknown;
  productionVerificationOverrides: (config: unknown) => Array<{ name: string; value: string }>;
  DEVELOPMENT_JOBS: Record<string, string>;
  DEVELOPMENT_WORKFLOW: string;
  DEVELOPMENT_PUBLISHER: string;
  DEVELOPMENT_RECEIPT_PUBLISHER: string;
  DEVELOPMENT_ROLLBACK: string;
  createDevelopmentReceipt: (env: Record<string, string | undefined>, needs: Record<string, Job>, run: unknown) => Receipt;
  loadLatestDevelopmentReceipt: (options: DevelopmentOptions) => Promise<Receipt>;
  resolveProductionInvocation: (env: Record<string, string | undefined>, event: unknown) => Record<string, string | number>;
  assertProductionFactoryMode: (options: {
    github: unknown; core: unknown; owner: string; repo: string; eventName: string;
    promotionMode?: string;
  }) => Promise<void>;
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
  result.gate.outputs = {
    sha: SHA, deployment_stage: "full",
    development_run_id: "900", development_run_attempt: "2", development_workflow_id: "71",
  };
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

describe("production trigger admission", () => {
  const manualEnv = {
    ...env, GITHUB_WORKFLOW_SHA: SHA, GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_WORKFLOW_REF: "owner/project/.github/workflows/azure-deploy-prod.yml@refs/heads/main",
    INPUT_COMMIT_SHA: SHA, INPUT_DEPLOYMENT_STAGE: "full",
  };
  const automaticEnv = {
    ...manualEnv, GITHUB_EVENT_NAME: "workflow_run", INPUT_COMMIT_SHA: "", INPUT_DEPLOYMENT_STAGE: "",
  };
  const event = {
    action: "completed",
    workflow_run: {
      id: 900, run_attempt: 2, head_sha: SHA, head_branch: "main",
      status: "completed", conclusion: "success",
    },
  };

  it.each(["foundation", "full"])("keeps exact-source manual %s commissioning separate", (stage) => {
    expect(resolveProductionInvocation({ ...manualEnv, INPUT_DEPLOYMENT_STAGE: stage }, {}))
      .toEqual({ sha: SHA, deployment_stage: stage, promotion_mode: "disabled" });
  });

  it("pins automatic full release to the triggering development run and attempt", () => {
    expect(resolveProductionInvocation(automaticEnv, event)).toEqual({
      sha: SHA, deployment_stage: "full", promotion_mode: "continuous",
      development_run_id: 900, development_run_attempt: 2,
    });
    expect(resolveProductionInvocation({
      ...automaticEnv, INPUT_COMMIT_SHA: "b".repeat(40), INPUT_DEPLOYMENT_STAGE: "foundation",
    }, event).deployment_stage).toBe("full");
  });

  it.each([
    { GITHUB_REF: "refs/heads/feature" }, { GITHUB_REF: "refs/tags/main" },
    { GITHUB_SHA: "b".repeat(40) }, { GITHUB_WORKFLOW_SHA: "b".repeat(40) },
    { GITHUB_SHA: "" }, { GITHUB_WORKFLOW_SHA: "" },
    { GITHUB_WORKFLOW_REF: "owner/project/.github/workflows/another.yml@refs/heads/main" },
    { GITHUB_WORKFLOW_REF: "owner/project/.github/workflows/azure-deploy-prod.yml@refs/heads/feature" },
    { GITHUB_EVENT_NAME: "pull_request" }, { GITHUB_REPOSITORY: "" },
  ])("rejects unrelated or incomplete automatic source identity %j", (overrides) => {
    expect(() => resolveProductionInvocation({ ...automaticEnv, ...overrides }, event)).toThrow();
  });

  it.each([
    { INPUT_COMMIT_SHA: "" }, { INPUT_COMMIT_SHA: "main" },
    { INPUT_COMMIT_SHA: "b".repeat(40) }, { INPUT_COMMIT_SHA: SHA.toUpperCase() },
    { INPUT_DEPLOYMENT_STAGE: "" }, { INPUT_DEPLOYMENT_STAGE: "paper" },
  ])("rejects invalid manual source or stage %j", (overrides) => {
    expect(() => resolveProductionInvocation({ ...manualEnv, ...overrides }, {})).toThrow();
  });

  it.each([
    { id: 0 }, { id: "900" }, { id: Number.MAX_SAFE_INTEGER + 1 },
    { run_attempt: 0 }, { run_attempt: "2" }, { run_attempt: 1.5 },
    { status: "in_progress" }, { conclusion: "failure" }, { conclusion: null },
    { head_branch: "feature" }, { head_sha: "b".repeat(40) }, { head_sha: "" },
  ])("rejects invalid development completion %j", (overrides) => {
    expect(() => resolveProductionInvocation(automaticEnv, {
      ...event, workflow_run: { ...event.workflow_run, ...overrides },
    })).toThrow();
  });

  it.each([null, {}, { ...event, action: "requested" }, { ...event, workflow_run: null }])
    ("rejects missing or non-completion payloads %j", (payload) => {
      expect(() => resolveProductionInvocation(automaticEnv, payload)).toThrow();
    });

  function factory(mode = "active", actorType = "User") {
    const controls = [{
      number: 233, labels: [{ name: "factory-control" }, { name: `factory-mode:${mode}` }],
    }];
    const timeline = [{
      event: "labeled", label: { name: "factory-mode:active" },
      actor: { type: actorType }, created_at: "2026-10-22T00:00:00Z",
    }];
    const methods = { listForRepo: jest.fn(), listEventsForTimeline: jest.fn() };
    const github = {
      rest: { issues: methods },
      paginate: jest.fn(async (method: unknown) => {
        if (method === methods.listForRepo) return controls;
        if (method === methods.listEventsForTimeline) return timeline;
        throw new Error("Unexpected factory mutation or read.");
      }),
    };
    const core = { warning: jest.fn() };
    return {
      controls, timeline, github, core,
      options: { github, core, owner: "owner", repo: "project", eventName: "workflow_run" },
    };
  }

  it("admits automatic work only after the existing human-activation readback", async () => {
    const fixture = factory();
    await expect(assertProductionFactoryMode(fixture.options)).resolves.toBeUndefined();
    expect(fixture.github.paginate).toHaveBeenCalledTimes(2);
    expect(fixture.github.paginate).toHaveBeenLastCalledWith(
      fixture.github.rest.issues.listEventsForTimeline,
      { owner: "owner", repo: "project", issue_number: 233, per_page: 100 },
    );
  });

  it.each([["paused", "User"], ["shadow", "User"], ["active", "Bot"], ["unknown", "User"]])
    ("blocks automatic admission for factory %s applied by %s", async (mode, actorType) => {
      const fixture = factory(mode, actorType);
      await expect(assertProductionFactoryMode(fixture.options)).rejects.toThrow("human-activated factory");
    });

  it("blocks missing, ambiguous, unattested or unreadable factory control", async () => {
    const missing = factory();
    missing.controls.length = 0;
    const ambiguous = factory();
    ambiguous.controls.push({ ...ambiguous.controls[0], number: 234 });
    const unattested = factory();
    unattested.timeline.length = 0;
    const unreadable = factory();
    unreadable.github.paginate.mockRejectedValue(new Error("GitHub read denied"));
    for (const fixture of [missing, ambiguous, unattested, unreadable]) {
      await expect(assertProductionFactoryMode(fixture.options)).rejects.toThrow("human-activated factory");
      expect(fixture.core.warning).toHaveBeenCalled();
    }
  });

  it("does not grant activation or require an active factory for manual disabled commissioning", async () => {
    const fixture = factory("paused");
    await expect(assertProductionFactoryMode({
      ...fixture.options, eventName: "workflow_dispatch",
    })).resolves.toBeUndefined();
    expect(fixture.github.paginate).not.toHaveBeenCalled();
    await expect(assertProductionFactoryMode({
      ...fixture.options, eventName: "push",
    })).rejects.toThrow("Unsupported production trigger");
  });

  it("does not let a manual continuous dispatch bypass active-factory attestation", async () => {
    const fixture = factory("paused");
    await expect(assertProductionFactoryMode({
      ...fixture.options, eventName: "workflow_dispatch", promotionMode: "continuous",
    })).rejects.toThrow("human-activated factory");
  });

  it.each(["operator", "continuous"])("requires full release for explicit %s promotion", (mode) => {
    expect(resolveProductionInvocation({ ...manualEnv, INPUT_PROMOTION_MODE: mode }, {}))
      .toMatchObject({ promotion_mode: mode, deployment_stage: "full" });
    expect(() => resolveProductionInvocation({
      ...manualEnv, INPUT_PROMOTION_MODE: mode, INPUT_DEPLOYMENT_STAGE: "foundation",
    }, {})).toThrow("Foundation");
  });
});

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
      schemaVersion: 2, status: "disabled", stage: "release", runId: 1001, runAttempt: 2,
      development: { runId: 900, runAttempt: 2, workflowId: 71 },
      rolloutMode: "disabled", hourlyTriggerType: "Manual", dailyTriggerType: "Manual",
      backupExecutionId: "run1001-a1-baseline", smokeExecutionId: "run1001-a2-smoke",
    });
    expect(validateReceipt(receipt, run, expected)).toBe(receipt);
    expect(receiptName("release", SHA, 1001, 2)).toBe(`production-release-${SHA}-1001-2`);
    expect(receiptName("release", SHA, 1001, 1)).not.toBe(receiptName("release", SHA, 1001, 2));
  });

  it("accepts automatic workflow provenance only as the same disabled-release receipt", () => {
    const receipt = createReleaseReceipt(env, jobs());
    expect(validateReceipt(receipt, { ...run, event: "workflow_run" }, expected)).toBe(receipt);
    expect(() => validateReceipt({ ...receipt, rolloutMode: "paper" },
      { ...run, event: "workflow_run" }, expected)).toThrow();
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
    ["gate", "development_run_id", ""],
    ["gate", "development_run_id", "1001"],
    ["gate", "development_run_attempt", "02"],
    ["gate", "development_workflow_id", "0"],
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
    { schemaVersion: 1 }, { development: null }, { development: { runId: 1001, runAttempt: 2, workflowId: 71 } },
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

  it("does not relabel disabled-release evidence as paper-promotion proof", () => {
    expect(receiptName("promotion", SHA, 1001, 2)).toBe(`production-promotion-${SHA}-1001-2`);
    expect(() => validateReceipt(
      { ...createReleaseReceipt(env, jobs()), status: "promoted", rolloutMode: "paper" },
      run, { ...expected, stage: "promotion" },
    )).toThrow();
  });
});

const developmentRun = {
  ...run, id: 900, workflow_id: 71, path: `.github/workflows/${DEVELOPMENT_WORKFLOW}`,
  event: "workflow_run", updated_at: "2026-10-22T02:00:00Z",
  actor: { id: 41898282, login: "github-actions[bot]" },
  triggering_actor: { id: 41898282, login: "github-actions[bot]" },
};
const developmentEnv = {
  ...env, GITHUB_RUN_ID: "900", GITHUB_WORKFLOW_SHA: SHA,
  GITHUB_WORKFLOW_REF: `${env.GITHUB_REPOSITORY}/.github/workflows/${DEVELOPMENT_WORKFLOW}@refs/heads/main`,
  GITHUB_EVENT_NAME: "workflow_run", GITHUB_ACTOR_ID: "41898282",
  GITHUB_TRIGGERING_ACTOR: "github-actions[bot]",
};
const developmentExpected = { ...expected, repositoryId: 456, stage: "development" };

function developmentJobs(): Record<string, Job> {
  const result: Record<string, Job> = Object.fromEntries(
    Object.keys(DEVELOPMENT_JOBS).map((name) => [name, { result: "success", outputs: {} }]),
  );
  result.gate.outputs = { sha: SHA, deployment_stage: "full" };
  result["deploy-environment"].outputs = {
    acr_login_server: "acrkryptodev.azurecr.io",
    evidence_container_url: "https://kryptodev.blob.core.windows.net/evidence",
  };
  result["build-images"].outputs = { web_digest_hex: "b".repeat(64), ops_digest_hex: "c".repeat(64) };
  result["validate-shadow"].outputs = {
    manual_hourly_execution_name: "manual-execution",
    manual_shadow_idempotency_key: "manual-shadow:run900-a2-manual-hourly",
    manual_shadow_started_after: "2026-10-22T00:10:00Z",
  };
  result["promote-schedule"].outputs.schedule_deployed_at =
    String(Date.parse("2026-10-22T00:20:00Z") / 1000);
  result["observe-scheduled-execution"].outputs.scheduled_execution_name = "observed-execution";
  result["verify-final-state"].outputs = {
    target_origin: "https://development.example.com",
    scheduled_execution_name: "observed-execution",
    scheduled_execution_start_time: "2026-10-22T01:00:05.1000000+00:00",
    scheduled_execution_completed_time: "2026-10-22T01:01:10Z",
  };
  return result;
}

function developmentFixture() {
  const receipt = createDevelopmentReceipt(developmentEnv, developmentJobs(), developmentRun);
  const artifacts = [{
    id: 501, name: receiptName("development", SHA, 900, 2), expired: false,
  }];
  const nativeJobs = [
    ...Object.values(DEVELOPMENT_JOBS), DEVELOPMENT_RECEIPT_PUBLISHER, DEVELOPMENT_PUBLISHER, DEVELOPMENT_ROLLBACK,
  ].map((name) => ({
    name, status: "completed", conclusion: name === DEVELOPMENT_ROLLBACK ? "skipped" : "success",
  }));
  const github = {
    rest: {
      git: { getRef: jest.fn().mockResolvedValue({ data: { object: { sha: SHA } } }) },
      actions: {
        getWorkflow: jest.fn().mockResolvedValue({
          data: { id: 71, path: `.github/workflows/${DEVELOPMENT_WORKFLOW}` },
        }),
        listWorkflowRuns: jest.fn().mockResolvedValue({
          data: { total_count: 1, workflow_runs: [developmentRun] },
        }),
        getWorkflowRun: jest.fn().mockResolvedValue({ data: developmentRun }),
        listWorkflowRunArtifacts: jest.fn(),
        listJobsForWorkflowRunAttempt: jest.fn(),
        downloadArtifact: jest.fn().mockResolvedValue({ data: archive(receipt) }),
      },
    },
    paginate: jest.fn(),
  };
  github.paginate.mockImplementation(async (endpoint: unknown) => {
    if (endpoint === github.rest.actions.listWorkflowRunArtifacts) return artifacts;
    if (endpoint === github.rest.actions.listJobsForWorkflowRunAttempt) return nativeJobs;
    throw new Error("Unexpected development evidence endpoint.");
  });
  return {
    github, receipt, artifacts, nativeJobs,
    options: { github, owner: "owner", repo: "project", repositoryId: 456, releaseSha: SHA },
  };
}

function replaceReceiptObject(receipt: Receipt, field: string, values: Receipt): Receipt {
  const current = receipt[field];
  if (!current || typeof current !== "object" || Array.isArray(current)) throw new Error(`Missing fixture ${field}.`);
  return { ...receipt, [field]: { ...current, ...values } };
}

describe("authenticated development admission", () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(new Date("2026-10-22T01:59:00Z")));
  afterEach(() => jest.useRealTimers());

  it("binds actual shadow/readback outputs and actor IDs without claiming trigger-origin proof", () => {
    const receipt = createDevelopmentReceipt(developmentEnv, developmentJobs(), developmentRun);
    expect(receipt).toMatchObject({
      schemaVersion: 1, stage: "development", status: "shadow", workflowId: 71,
      actorId: 41898282, triggeringActorId: 41898282, rolloutMode: "shadow",
      scheduledExecution: {
        name: "observed-execution", status: "Succeeded",
        startedAt: "2026-10-22T01:00:05.100Z", completedAt: "2026-10-22T01:01:10.000Z",
        scheduleEnabledAt: "2026-10-22T00:20:00.000Z",
        originAssurance: "schedule-observed-not-origin-proven",
      },
    });
    expect(validateReceipt(receipt, developmentRun, developmentExpected)).toBe(receipt);
    expect(receiptName("development", SHA, 900, 2)).toBe(`development-release-${SHA}-900-2`);
  });

  it.each(Object.keys(DEVELOPMENT_JOBS).filter((name) => name !== "gate"))(
    "never turns skipped %s into a development release", (name) => {
      const results = developmentJobs();
      results[name].result = "skipped";
      expect(createDevelopmentReceipt(developmentEnv, results, developmentRun))
        .toMatchObject({ status: "failed", binding: null, manualShadow: null, scheduledExecution: null });
    },
  );

  it("rejects foundation, incomplete job inventories, and an unsupported result", () => {
    const results = developmentJobs();
    results.gate.outputs.deployment_stage = "foundation";
    expect(() => createDevelopmentReceipt(developmentEnv, results, developmentRun)).toThrow("foundation");
    results.gate.outputs.deployment_stage = "full";
    results["verify-final-state"].result = "neutral";
    expect(() => createDevelopmentReceipt(developmentEnv, results, developmentRun)).toThrow("Unknown result");
    delete results["verify-final-state"];
    expect(() => createDevelopmentReceipt(developmentEnv, results, developmentRun)).toThrow("result");
  });

  it.each([
    { GITHUB_REF: "refs/heads/feature" }, { GITHUB_SHA: "b".repeat(40) },
    { GITHUB_WORKFLOW_SHA: "b".repeat(40) }, { GITHUB_WORKFLOW_REF: "owner/project/another.yml@refs/heads/main" },
    { GITHUB_ACTOR_ID: "1" }, { GITHUB_TRIGGERING_ACTOR: "another-actor" },
    { GITHUB_RUN_ID: "899" }, { GITHUB_RUN_ATTEMPT: "1" },
    { GITHUB_EVENT_NAME: "pull_request" },
  ])("rejects substituted producer provenance %j", (overrides) => {
    expect(() => createDevelopmentReceipt({ ...developmentEnv, ...overrides }, developmentJobs(), developmentRun))
      .toThrow();
  });

  it.each([
    { path: ".github/workflows/azure-deploy-prod.yml" }, { event: "pull_request" },
    { event: "push" }, { head_sha: "b".repeat(40) }, { head_branch: "feature" },
    { head_repository: { id: 999 } }, { repository: { id: 999, full_name: "owner/project" } },
    { workflow_id: 0 }, { actor: { id: 0 } }, { triggering_actor: { id: 0, login: "actor" } },
  ])("rejects unrelated native development provenance %j", (overrides) => {
    expect(() => validateWorkflowRun({ ...developmentRun, ...overrides }, developmentExpected)).toThrow();
  });

  it.each([
    { schemaVersion: 2 }, { stage: "release" }, { workflowId: 72 },
    { actorId: 1 }, { triggeringActorId: 2 }, { runAttempt: 1 },
    { releaseSha: "b".repeat(40) }, { rolloutMode: "paper" }, { dailyTriggerType: "Manual" },
    { results: {} }, { binding: null }, { status: "disabled" },
  ])("rejects forged development fields %j", (overrides) => {
    const receipt = createDevelopmentReceipt(developmentEnv, developmentJobs(), developmentRun);
    expect(() => validateReceipt({ ...receipt, ...overrides }, developmentRun, developmentExpected)).toThrow();
  });

  it.each([
    { name: "manual-execution" }, { originAssurance: "origin-proven" }, { status: "Failed" },
    { startedAt: "2026-10-22T00:59:59.999Z" }, { startedAt: "2026-10-22T01:15:00.001Z" },
    { completedAt: "2026-10-22T01:00:05.099Z" }, { completedAt: "2026-10-22T02:00:00.000Z" },
    { startedAt: "2026-02-30T01:00:05.100Z" }, { completedAt: undefined },
    { scheduleEnabledAt: "2026-10-22T01:00:00.000Z" },
  ])("rejects invalid scheduled-window evidence %j", (overrides) => {
    const receipt = createDevelopmentReceipt(developmentEnv, developmentJobs(), developmentRun);
    expect(() => validateReceipt(
      replaceReceiptObject(receipt, "scheduledExecution", overrides), developmentRun, developmentExpected,
    )).toThrow();
  });

  it.each(["2026-10-22T01:00:00.000Z", "2026-10-22T01:15:00.000Z"])(
    "accepts the exact first-window boundary %s", (startedAt) => {
      const receipt = createDevelopmentReceipt(developmentEnv, developmentJobs(), developmentRun);
      const bounded = replaceReceiptObject(receipt, "scheduledExecution", { startedAt, completedAt: startedAt });
      expect(validateReceipt(bounded, developmentRun, developmentExpected)).toBe(bounded);
    },
  );

  it("rejects mismatched readback, stale manual proof, invalid dates, and future enablement at publication", () => {
    const results = developmentJobs();
    const final = results["verify-final-state"].outputs;
    final.scheduled_execution_name = "different-execution";
    expect(() => createDevelopmentReceipt(developmentEnv, results, developmentRun)).toThrow("another execution");
    final.scheduled_execution_name = "observed-execution";
    final.scheduled_execution_completed_time = "2026-02-30T01:01:10Z";
    expect(() => createDevelopmentReceipt(developmentEnv, results, developmentRun)).toThrow("valid UTC");
    final.scheduled_execution_completed_time = "2026-10-22T01:01:10Z";
    results["promote-schedule"].outputs.schedule_deployed_at = String(Date.parse("2026-10-22T03:00:00Z") / 1000);
    expect(() => createDevelopmentReceipt(developmentEnv, results, developmentRun)).toThrow("schedule window");
    const receipt = createDevelopmentReceipt(developmentEnv, developmentJobs(), developmentRun);
    expect(() => validateReceipt(replaceReceiptObject(receipt, "manualShadow", {
      startedAfter: "2026-10-21T23:59:59.000Z",
    }), developmentRun, developmentExpected)).toThrow("earlier workflow");
    expect(() => validateReceipt(replaceReceiptObject(receipt, "manualShadow", {
      idempotencyKey: "manual-shadow:run900-a1-manual-hourly",
    }), developmentRun, developmentExpected)).toThrow("Wrong manual");
  });

  it("loads the real immutable archive and native job results, then repeats main/run admission", async () => {
    const fixture = developmentFixture();
    await expect(loadLatestDevelopmentReceipt({
      ...fixture.options, expectedRunId: 900, expectedRunAttempt: 2,
    })).resolves.toEqual(fixture.receipt);
    expect(fixture.github.rest.actions.downloadArtifact).toHaveBeenCalledWith({
      owner: "owner", repo: "project", artifact_id: 501, archive_format: "zip",
    });
    expect(fixture.github.paginate).toHaveBeenCalledWith(
      fixture.github.rest.actions.listJobsForWorkflowRunAttempt,
      { owner: "owner", repo: "project", run_id: 900, attempt_number: 2, per_page: 100 },
    );
    expect(fixture.github.rest.git.getRef).toHaveBeenCalledTimes(2);
    expect(fixture.github.rest.actions.listWorkflowRuns).toHaveBeenCalledTimes(2);
    expect(fixture.github.rest.actions.getWorkflowRun).toHaveBeenCalledTimes(2);
  });

  it.each(["queued", "in_progress"])("rejects the latest %s run before downloading evidence", async (status) => {
    const fixture = developmentFixture();
    fixture.github.rest.actions.getWorkflowRun.mockResolvedValue({ data: { ...developmentRun, status } });
    await expect(loadLatestDevelopmentReceipt(fixture.options)).rejects.toThrow("not terminal");
    expect(fixture.github.rest.actions.downloadArtifact).not.toHaveBeenCalled();
  });

  it("rejects a different immutable workflow ID even when its path and display name match", async () => {
    const fixture = developmentFixture();
    fixture.github.rest.actions.getWorkflow.mockResolvedValue({
      data: { id: 72, path: `.github/workflows/${DEVELOPMENT_WORKFLOW}` },
    });
    await expect(loadLatestDevelopmentReceipt(fixture.options)).rejects.toThrow("immutable development workflow");
    expect(fixture.github.rest.actions.downloadArtifact).not.toHaveBeenCalled();
  });

  it("surfaces a denied GitHub read without retrying or substituting cached evidence", async () => {
    const fixture = developmentFixture();
    fixture.github.rest.actions.getWorkflowRun.mockRejectedValue(new Error("GitHub read denied"));
    await expect(loadLatestDevelopmentReceipt(fixture.options)).rejects.toThrow("GitHub read denied");
    expect(fixture.github.rest.actions.getWorkflowRun).toHaveBeenCalledTimes(1);
    expect(fixture.github.rest.actions.downloadArtifact).not.toHaveBeenCalled();
  });

  it("does not fall back to an older success after the newest run fails", async () => {
    const fixture = developmentFixture();
    const latest = { ...developmentRun, id: 901, conclusion: "failure" };
    fixture.github.rest.actions.listWorkflowRuns.mockResolvedValue({
      data: { total_count: 2, workflow_runs: [developmentRun, latest] },
    });
    fixture.github.rest.actions.getWorkflowRun.mockResolvedValue({ data: latest });
    await expect(loadLatestDevelopmentReceipt(fixture.options)).rejects.toThrow("did not succeed");
    expect(fixture.github.rest.actions.downloadArtifact).not.toHaveBeenCalled();
  });

  it.each([
    { total_count: 0, workflow_runs: [] },
    { total_count: 101, workflow_runs: [developmentRun] },
    { total_count: 2, workflow_runs: [developmentRun] },
    { total_count: 2, workflow_runs: [developmentRun, developmentRun] },
  ])("rejects incomplete or ambiguous run inventory %j", async (inventory) => {
    const fixture = developmentFixture();
    fixture.github.rest.actions.listWorkflowRuns.mockResolvedValue({ data: inventory });
    await expect(loadLatestDevelopmentReceipt(fixture.options)).rejects.toThrow();
    expect(fixture.github.rest.actions.downloadArtifact).not.toHaveBeenCalled();
  });

  it.each(["missing", "expired", "duplicate"])("rejects %s immutable artifacts", async (kind) => {
    const fixture = developmentFixture();
    if (kind === "missing") fixture.artifacts.length = 0;
    if (kind === "expired") fixture.artifacts[0].expired = true;
    if (kind === "duplicate") fixture.artifacts.push({ ...fixture.artifacts[0], id: 502 });
    await expect(loadLatestDevelopmentReceipt(fixture.options)).rejects.toThrow("unique trusted-run");
  });

  it("rejects a previous-attempt archive and a green wrapper with failed release evidence", async () => {
    const fixture = developmentFixture();
    fixture.github.rest.actions.downloadArtifact.mockResolvedValue({
      data: archive({ ...fixture.receipt, runAttempt: 1 }),
    });
    await expect(loadLatestDevelopmentReceipt(fixture.options)).rejects.toThrow("runAttempt");
    fixture.github.rest.actions.downloadArtifact.mockResolvedValue({
      data: archive({ ...fixture.receipt, status: "failed", binding: null }),
    });
    await expect(loadLatestDevelopmentReceipt(fixture.options)).rejects.toThrow("green development wrapper");
  });

  it.each([
    ...Object.values(DEVELOPMENT_JOBS), DEVELOPMENT_RECEIPT_PUBLISHER, DEVELOPMENT_PUBLISHER, DEVELOPMENT_ROLLBACK,
  ])("requires the actual native result for %s", async (name) => {
    const fixture = developmentFixture();
    const native = fixture.nativeJobs.find((job) => job.name === name);
    if (!native) throw new Error("Missing native fixture job.");
    native.conclusion = name === DEVELOPMENT_ROLLBACK ? "success" : "skipped";
    await expect(loadLatestDevelopmentReceipt(fixture.options)).rejects.toThrow("actual development attempt");
  });

  it("rejects duplicate or missing native jobs despite receipt assertions", async () => {
    const fixture = developmentFixture();
    fixture.nativeJobs.push({ ...fixture.nativeJobs[0] });
    await expect(loadLatestDevelopmentReceipt(fixture.options)).rejects.toThrow("actual development attempt");
    fixture.nativeJobs.pop();
    fixture.nativeJobs.shift();
    await expect(loadLatestDevelopmentReceipt(fixture.options)).rejects.toThrow("actual development attempt");
  });

  it.each([
    { run_attempt: 3 }, { status: "in_progress" }, { conclusion: "failure" },
    { updated_at: "2026-10-22T02:01:00Z" }, { actor: { id: 1, login: "changed" } },
    { triggering_actor: { id: 2, login: "another-actor" } },
  ])("rejects concurrent native run changes %j", async (change) => {
    const fixture = developmentFixture();
    fixture.github.rest.actions.getWorkflowRun
      .mockResolvedValueOnce({ data: developmentRun })
      .mockResolvedValueOnce({ data: { ...developmentRun, ...change } });
    await expect(loadLatestDevelopmentReceipt(fixture.options)).rejects.toThrow("changed");
  });

  it("rejects a newer run or a main advance during verification", async () => {
    const fixture = developmentFixture();
    fixture.github.rest.actions.listWorkflowRuns
      .mockResolvedValueOnce({ data: { total_count: 1, workflow_runs: [developmentRun] } })
      .mockResolvedValueOnce({
        data: { total_count: 2, workflow_runs: [developmentRun, { ...developmentRun, id: 901 }] },
      });
    await expect(loadLatestDevelopmentReceipt(fixture.options)).rejects.toThrow("newer development run");
    const changedMain = developmentFixture();
    changedMain.github.rest.git.getRef
      .mockResolvedValueOnce({ data: { object: { sha: SHA } } })
      .mockResolvedValueOnce({ data: { object: { sha: "b".repeat(40) } } });
    await expect(loadLatestDevelopmentReceipt(changedMain.options)).rejects.toThrow("superseded on main");
  });

  it.each([
    { expectedRunId: 899, expectedRunAttempt: 2 },
    { expectedRunId: 900, expectedRunAttempt: 1 },
    { expectedRunId: 900 },
  ])("does not silently replace prior production admission %j", async (prior) => {
    const fixture = developmentFixture();
    await expect(loadLatestDevelopmentReceipt({ ...fixture.options, ...prior })).rejects.toThrow();
    expect(fixture.github.rest.actions.downloadArtifact).not.toHaveBeenCalled();
  });
});
