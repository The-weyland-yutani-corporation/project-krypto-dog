import type { ProductionVerificationReport } from "@/deployment/production-verification";
import { archive } from "../../agentic-sdlc/receipt-archive-fixture";

type NativeReport = ProductionVerificationReport & {
  environmentName: string; jobExecutionId: string; azureExecutionName: string;
};
type Job = { result: string; outputs: Record<string, string> };
type Reference = {
  schemaVersion: number; kind: string; repositoryId: number; releaseSha: string;
  runId: number; runAttempt: number; workflowId: number; scheduleGeneration: number; authorizationId: string;
};
const api = jest.requireActual<{
  RELEASE_JOBS: string[];
  PRODUCTION_JOB_NAMES: Record<string, string>;
  DEVELOPMENT_JOBS: Record<string, string>;
  DEVELOPMENT_PUBLISHER: string;
  DEVELOPMENT_RECEIPT_PUBLISHER: string;
  DEVELOPMENT_ROLLBACK: string;
  productionAuthorization(input: unknown): string;
  promotionReference(receipt: unknown): Reference;
  receiptName(stage: string, sha: string, runId: number, attempt: number): string;
}>("../../../.github/scripts/azure/production-evidence.cjs");

export function productionPromotionFixture(base = "2026-10-22T00:00:00.000Z", repository = "owner/project") {
  const [owner, repo] = repository.split("/");
  const time = (minutes: number, seconds = 0) => new Date(Date.parse(base) + minutes * 60_000 + seconds * 1000).toISOString();
  const sha = "a".repeat(40);
  const env = {
    GITHUB_REPOSITORY: repository, GITHUB_REPOSITORY_ID: "456", GITHUB_REPOSITORY_OWNER_ID: "12",
    GITHUB_RUN_ID: "1001", GITHUB_RUN_ATTEMPT: "2", GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: sha, GITHUB_WORKFLOW_SHA: sha, RESOLVED_SHA: sha,
    GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/azure-deploy-prod.yml@refs/heads/main`,
    GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_ACTOR_ID: "7", GITHUB_TRIGGERING_ACTOR: "operator",
  };
  const run = {
    id: 1001, run_attempt: 2, workflow_id: 81,
    repository: { id: 456, full_name: repository, owner: { id: 12 } }, head_repository: { id: 456 },
    head_sha: sha, head_branch: "main", path: ".github/workflows/azure-deploy-prod.yml",
    event: "workflow_dispatch", actor: { id: 7, type: "User", login: "operator" },
    triggering_actor: { id: 7, type: "User", login: "operator" },
    status: "completed", conclusion: "success", run_started_at: time(0), updated_at: time(65),
  };
  const binding = {
    releaseSha: sha, webImageDigest: `sha256:${"b".repeat(64)}`, opsImageDigest: `sha256:${"c".repeat(64)}`,
    registryLoginServer: "acrkryptoprod.azurecr.io", targetOrigin: "https://production.example.com",
    evidenceContainerUrl: "https://kryptoprod.blob.core.windows.net/evidence",
  };
  const authority: { mode: string; actorId: number; triggeringActorId: number; previous: Reference | null } = {
    mode: "operator", actorId: 7, triggeringActorId: 7, previous: null,
  };
  const generation = Math.floor(Date.parse(time(10)) / 1000);
  const authorizationId = api.productionAuthorization({ env, binding, authority, scheduleGeneration: generation });
  const common: Omit<NativeReport, "phase" | "jobExecutionId" | "azureExecutionName"> = {
    schemaVersion: "1.3.0", operation: "production-verification", intendedMode: "paper",
    environmentName: "prod", generatedAt: time(20), releaseSha: sha, imageDigest: binding.webImageDigest,
    targetOrigin: binding.targetOrigin, authorizationId, scheduleGeneration: generation,
    approved: true, approvalId: null, shadowRun: null, scheduledRun: null, scheduledExecution: null,
    workflowObservation: null, blockers: [],
    checks: [
      "production-accounting-reconciled", "production-balances-valid", "production-stops-inactive",
      "production-lease-released", "production-fence-released",
    ].map((id) => ({ id, status: "pass", summary: id })),
    posthog: { host: "https://us.i.posthog.com", environment: "prod", keyBinding: "e".repeat(64) },
  };
  const ready: NativeReport = {
    ...common, phase: "ready", jobExecutionId: "run1001-a2-prod-ready", azureExecutionName: "ops-ready",
    approvalId: "smoke-approval",
    shadowRun: {
      id: "shadow-run", idempotencyKey: "manual-shadow:run1001-a2-prod-shadow",
      outcome: "SHADOW", startedAt: time(11), completedAt: time(12), tradeCount: 0, errorType: null,
    },
    checks: [...common.checks, ...[
      "production-shadow-approval", "production-shadow-terminal-safe", "exact-approval-id", "fresh-approval",
    ].map((id) => ({ id, status: "pass" as const, summary: id }))],
  };
  const execution = {
    id: "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-prod/providers/Microsoft.App/jobs/caj-prod-agent-run/executions/scheduled-hour",
    name: "scheduled-hour", templateDigest: "f".repeat(64), imageDigest: binding.webImageDigest,
    startedAt: time(60, 5), completedAt: time(60, 55), scheduleEnabledAt: time(21),
    status: "Succeeded" as const, originAssurance: "schedule-observed-not-origin-proven" as const,
  };
  const scheduled: NativeReport = {
    ...common, phase: "scheduled", generatedAt: time(61, 5),
    jobExecutionId: "run1001-a2-prod-scheduled", azureExecutionName: "ops-scheduled",
    workflowObservation: {
      issuer: "https://token.actions.githubusercontent.com", purpose: "scheduled-execution",
      observationDigest: "d".repeat(64), repositoryId: "456", repositoryOwnerId: "12",
      workflowRef: env.GITHUB_WORKFLOW_REF, workflowSha: sha, runId: "1001", runAttempt: 2,
      observedAt: time(61), expiresAt: time(64),
    },
    scheduledExecution: execution,
    scheduledRun: {
      id: "paper-run", idempotencyKey: `cron:${binding.webImageDigest}-${generation}:${time(60).slice(0, 13)}`,
      outcome: "HOLD", startedAt: time(60, 10), completedAt: time(60, 50),
      tradeCount: 0, journalCount: 1, tradeJournalCount: 0,
    },
    checks: [...common.checks, ...[
      "scheduled-execution-observation", "scheduled-run-binding", "scheduled-run-terminal",
      "scheduled-run-journal", "scheduled-run-fills",
    ].map((id) => ({ id, status: "pass" as const, summary: id }))],
  };
  const release = {
    schemaVersion: 2, stage: "release", repository: env.GITHUB_REPOSITORY, repositoryId: 456,
    runId: 1001, runAttempt: 2, workflowSha: sha, releaseSha: sha, generatedAt: time(8),
    development: { runId: 900, runAttempt: 1, workflowId: 71 },
    status: "disabled", results: Object.fromEntries(api.RELEASE_JOBS.map((id) => [id, "success"])),
    binding, backupExecutionId: "run1001-a2-backup", smokeExecutionId: "run1001-a2-smoke",
    rolloutMode: "disabled", hourlyTriggerType: "Manual", dailyTriggerType: "Manual",
  };
  const evidence = {
    authorizationId, scheduleGeneration: generation, approvalId: "smoke-approval", approvalCreatedAfter: time(10),
    manualShadow: {
      executionName: "manual-shadow", idempotencyKey: "manual-shadow:run1001-a2-prod-shadow", startedAfter: time(11).replace(".000Z", "Z"),
    },
    ready, scheduled,
  };
  const receipt = {
    schemaVersion: 1, stage: "promotion", repository: env.GITHUB_REPOSITORY,
    repositoryId: 456, repositoryOwnerId: 12, runId: 1001, runAttempt: 2, workflowId: 81,
    actorId: 7, triggeringActorId: 7, workflowSha: sha, releaseSha: sha, generatedAt: time(63),
    status: "paper", results: {
      ...release.results, "publish-release-receipt": "success", "prepare-paper": "success", "promote-paper": "success",
    },
    existingRelease: false, release, authority, evidence,
  };
  const reference = api.promotionReference(receipt);
  const needs: Record<string, Job> = Object.fromEntries(Object.keys(receipt.results)
    .map((id) => [id, { result: "success", outputs: {} }]));
  needs["publish-release-receipt"].outputs = { receipt: JSON.stringify(release), status: "disabled" };
  needs["force-disable-rollout"].outputs = { existing_release: "false", promotion_authority: JSON.stringify(authority) };
  needs["promote-paper"].outputs.evidence = JSON.stringify(evidence);
  const nativeJobs = Object.entries(api.PRODUCTION_JOB_NAMES).map(([id, name]) => ({
    id: 2000 + Object.keys(api.PRODUCTION_JOB_NAMES).indexOf(id), name,
    status: "completed", conclusion: ["backup-current-release", "recover-paper", "publish-production-failure"].includes(id) ?
      "skipped" : "success",
    started_at: time(id === "prepare-paper" ? 9 : id === "promote-paper" ? 17 : 0),
    completed_at: time(id === "prepare-paper" ? 16 : 65),
  }));
  const developmentRun = {
    ...run, id: 900, run_attempt: 1, workflow_id: 71, path: ".github/workflows/azure-deploy-dev.yml",
    run_started_at: time(-180), updated_at: time(-60),
  };
  const developmentReceipt = {
    schemaVersion: 1, stage: "development", repository: env.GITHUB_REPOSITORY, repositoryId: 456,
    runId: 900, runAttempt: 1, workflowId: 71, workflowSha: sha, releaseSha: sha,
    actorId: 7, triggeringActorId: 7, generatedAt: time(-61), status: "shadow",
    results: Object.fromEntries(Object.keys(api.DEVELOPMENT_JOBS).map((id) => [id, "success"])),
    binding: {
      ...binding, registryLoginServer: "acrkryptodev.azurecr.io", targetOrigin: "https://development.example.com",
      evidenceContainerUrl: "https://kryptodev.blob.core.windows.net/evidence",
    },
    manualShadow: {
      executionName: "dev-manual", idempotencyKey: "manual-shadow:run900-a1-manual-hourly", startedAfter: time(-170),
    },
    scheduledExecution: {
      name: "dev-scheduled", status: "Succeeded", startedAt: time(-120, 5),
      completedAt: time(-119), scheduleEnabledAt: time(-160),
      originAssurance: "schedule-observed-not-origin-proven",
    },
    rolloutMode: "shadow", hourlyTriggerType: "Schedule", dailyTriggerType: "Schedule",
  };
  const developmentJobs = [
    ...Object.values(api.DEVELOPMENT_JOBS), api.DEVELOPMENT_PUBLISHER,
    api.DEVELOPMENT_RECEIPT_PUBLISHER, api.DEVELOPMENT_ROLLBACK,
  ].map((name) => ({
    name, status: "completed", conclusion: name === api.DEVELOPMENT_ROLLBACK ? "skipped" : "success",
  }));
  const artifacts = [{ id: 501, name: api.receiptName("promotion", sha, 1001, 2), expired: false }];
  const developmentArtifacts = [{ id: 502, name: api.receiptName("development", sha, 900, 1), expired: false }];
  const rest = {
    actions: {
      getWorkflow: jest.fn(async (args: Record<string, unknown>): Promise<{ data: unknown }> => ({
        data: args.workflow_id === "azure-deploy-dev.yml" ?
          { id: 71, path: developmentRun.path } : { id: 81, path: run.path },
      })),
      getWorkflowRun: jest.fn(async (args: Record<string, unknown>): Promise<{ data: unknown }> => ({
        data: args.run_id === 900 ? developmentRun : run,
      })),
      listWorkflowRuns: jest.fn(async (args: Record<string, unknown>): Promise<{ data: unknown }> => ({
        data: { total_count: 1, workflow_runs: [args.workflow_id === 71 ? developmentRun : run] },
      })),
      listJobsForWorkflowRunAttempt: jest.fn(), listWorkflowRunArtifacts: jest.fn(),
      downloadArtifact: jest.fn(async (args: Record<string, unknown>): Promise<{ data: unknown }> => ({
        data: archive(args.artifact_id === 502 ? developmentReceipt : receipt),
      })),
    },
    repos: {
      getCollaboratorPermissionLevel: jest.fn(async () => ({ data: { permission: "write" } })),
      listDeployments: jest.fn(async (): Promise<{ data: unknown }> => ({
        data: [{ id: 301, sha, environment: "production", payload: reference }],
      })),
      listDeploymentStatuses: jest.fn(async (): Promise<{ data: unknown }> => ({ data: [{ id: 401, state: "success" }] })),
    },
  };
  const github = {
    rest,
    paginate: jest.fn(async (method: unknown, args: Record<string, unknown>) => {
      if (method === rest.actions.listWorkflowRunArtifacts) return args.run_id === 900 ? developmentArtifacts : artifacts;
      if (method === rest.actions.listJobsForWorkflowRunAttempt) return args.run_id === 900 ? developmentJobs : nativeJobs;
      throw new Error("Unexpected production read or mutation.");
    }),
  };
  return {
    env, sha, run, binding, authority, evidence, receipt, reference, needs, nativeJobs, artifacts, github, time,
    developmentRun, developmentReceipt, developmentJobs, developmentArtifacts,
    options: { github, owner, repo, repositoryId: 456, reference },
    expected: { repository, repositoryId: 456, stage: "promotion", releaseSha: sha },
  };
}

export function productionDeferralFixture(base = "2026-10-22T00:00:00.000Z", repository = "owner/project") {
  const f = productionPromotionFixture(base, repository);
  const deferralRun = { ...f.run, id: 2001, run_attempt: 1, run_started_at: f.time(80), updated_at: f.time(90) };
  const results = Object.fromEntries(api.RELEASE_JOBS.map((id) => [
    id, ["gate", "force-disable-rollout"].includes(id) ? "success" : "skipped",
  ]));
  const release = {
    schemaVersion: 2, stage: "release", repository, repositoryId: 456,
    runId: 2001, runAttempt: 1, workflowSha: f.sha, releaseSha: f.sha, generatedAt: f.time(85),
    development: f.receipt.release.development, status: "deferred", results, binding: null,
  };
  const deferral = {
    ...f.receipt, runId: 2001, runAttempt: 1, generatedAt: f.time(86), status: "deferred",
    existingRelease: true, release, evidence: null,
    authority: { ...f.authority, mode: "continuous", previous: f.reference },
    results: { ...results, "publish-release-receipt": "success", "prepare-paper": "skipped", "promote-paper": "skipped" },
  };
  const deferralJobs = Object.entries(api.PRODUCTION_JOB_NAMES).map(([id, name], index) => ({
    id: 3000 + index, name, status: "completed",
    conclusion: ["gate", "force-disable-rollout", "publish-release-receipt", "publish-promotion-receipt"].includes(id) ?
      "success" : "skipped",
    started_at: f.time(80), completed_at: f.time(90),
  }));
  const deferralArtifacts = [{ id: 503, name: api.receiptName("promotion", f.sha, 2001, 1), expired: false }];
  const originalRead = f.github.rest.actions.getWorkflowRun.getMockImplementation();
  const originalArchive = f.github.rest.actions.downloadArtifact.getMockImplementation();
  const originalPaginate = f.github.paginate.getMockImplementation();
  if (!originalRead || !originalArchive || !originalPaginate) throw new Error("Missing native fixture implementation");
  f.github.rest.actions.getWorkflowRun.mockImplementation(async (args) =>
    args.run_id === deferralRun.id ? { data: deferralRun } : originalRead(args));
  f.github.rest.actions.listWorkflowRuns.mockImplementation(async (args) => ({
    data: { total_count: 1, workflow_runs: [args.workflow_id === 71 ? f.developmentRun : deferralRun] },
  }));
  f.github.rest.actions.downloadArtifact.mockImplementation(async (args) =>
    args.artifact_id === 503 ? { data: archive(deferral) } : originalArchive(args));
  f.github.paginate.mockImplementation(async (method, args) => {
    if (args.run_id === deferralRun.id && method === f.github.rest.actions.listWorkflowRunArtifacts) return deferralArtifacts;
    if (args.run_id === deferralRun.id && method === f.github.rest.actions.listJobsForWorkflowRunAttempt) return deferralJobs;
    return originalPaginate(method, args);
  });
  return { ...f, deferral, deferralRun, deferralJobs, deferralArtifacts };
}
