import { scryptSync } from "node:crypto";

import {
  runActivationCheck,
  type ActivationCheckOptions,
  type ActivationCheckReport,
  type ActivationCheckResult,
} from "@/deployment/activation-check";
import { buildIdempotencyKey } from "@/deployment/scheduled-trigger";
import { readOnly, validateApprovalSecret, validateImageDigest, validateReleaseSha, validateTargetBaseUrl } from "@/deployment/target-smoke";
import { ETH_SCALE, USD_SCALE, parseDecimal } from "@/trading/accounting";
import { AccountingError } from "@/trading/errors";
import {
  assertFreshWorkflowObservation,
  type ScheduledExecutionObservation,
  type VerifiedWorkflowObservation,
  type WorkflowObservationReceipt,
} from "@/deployment/workflow-observation";

type ProductionVerificationBinding = Pick<
  ActivationCheckOptions, "databaseUrl" | "releaseSha" | "imageDigest" | "targetOrigin" | "approvalSecret"
> & {
  authorizationId: string;
  scheduleGeneration: number;
  posthogApiKey: string;
  posthogHost: string;
  posthogEnvironment: string;
};

export type ProductionVerificationOptions = ProductionVerificationBinding & (
  | (Omit<ActivationCheckOptions, "approvalProof"> & {
    phase: "ready";
    expectedApprovalId: string;
    approvalCreatedAfter: string;
  })
  | {
    phase: "scheduled";
    opsImageDigest: string;
    observation: VerifiedWorkflowObservation;
  }
);

type StateRow = {
  accountingStatus: string;
  ethBalance: string | null;
  usdcBalance: string | null;
  isOperatorPaused: boolean;
  isLocked: boolean;
  isRunning: boolean;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  fenced: boolean;
};

type RunRow = {
  id: string;
  idempotencyKey: string;
  triggerSource: string;
  tradingMode: string;
  outcome: string;
  startedAt: Date;
  completedAt: Date | null;
  tradeCount: number;
  journalCount: number;
  tradeJournalCount: number;
  errorType: string | null;
};

export type ProductionVerificationReport = {
  schemaVersion: "1.3.0";
  operation: "production-verification";
  intendedMode: "paper";
  phase: "ready" | "scheduled";
  generatedAt: string;
  releaseSha: string;
  imageDigest: string;
  targetOrigin: string;
  authorizationId: string;
  scheduleGeneration: number;
  approved: boolean;
  checks: ActivationCheckResult[];
  blockers: string[];
  approvalId: string | null;
  shadowRun: ActivationCheckReport["shadowRun"] | null;
  posthog: { host: string; environment: "prod"; keyBinding: string };
  workflowObservation: WorkflowObservationReceipt | null;
  scheduledExecution: (ScheduledExecutionObservation["execution"] & {
    scheduleEnabledAt: string;
    originAssurance: ScheduledExecutionObservation["originAssurance"];
  }) | null;
  scheduledRun: {
    id: string; idempotencyKey: string; outcome: string;
    startedAt: string; completedAt: string | null;
    tradeCount: number; journalCount: number; tradeJournalCount: number;
  } | null;
};

function timestamp(value: string, name: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || !value.endsWith("Z") ||
      parsed.toISOString().replace(".000Z", "Z") !== value.replace(".000Z", "Z")) {
    throw new Error(`${name} must be an exact UTC timestamp.`);
  }
  return parsed;
}

function nonnegativeDecimal(value: string | null | undefined, scale: number): boolean {
  if (typeof value !== "string") return false;
  try {
    return parseDecimal(value, scale) >= 0n;
  } catch (error) {
    if (!(error instanceof AccountingError)) throw error;
    return false;
  }
}

export async function runProductionVerification(
  options: ProductionVerificationOptions,
): Promise<ProductionVerificationReport> {
  if (options.phase !== "ready" && options.phase !== "scheduled") {
    throw new Error("Production verification phase must be ready or scheduled.");
  }
  const releaseSha = validateReleaseSha(options.releaseSha);
  const imageDigest = validateImageDigest(options.imageDigest);
  const targetOrigin = validateTargetBaseUrl(options.targetOrigin, new URL(options.targetOrigin).hostname).origin;
  if (!targetOrigin.startsWith("https://") || !options.databaseUrl ||
      !/^[0-9a-f]{64}$/.test(options.authorizationId) ||
      !Number.isSafeInteger(options.scheduleGeneration) || options.scheduleGeneration <= 0 ||
      options.scheduleGeneration > Math.floor(Date.now() / 1000)) {
    throw new Error("Production verification requires an exact authorization digest, current generation, HTTPS target and database.");
  }
  if (!options.posthogApiKey || options.posthogEnvironment !== "prod" ||
      !["https://us.i.posthog.com", "https://eu.i.posthog.com"].includes(options.posthogHost)) {
    throw new Error("Production telemetry must use the explicitly bound production PostHog host and key.");
  }
  const approvalSecret = validateApprovalSecret(options.approvalSecret);
  const checks: ActivationCheckResult[] = [];
  const blockers: string[] = [];
  function record(id: string, ok: boolean, summary: string) {
    checks.push({ id, status: ok ? "pass" : "block", summary });
    if (!ok) blockers.push(summary);
  }
  let expectedKey: string | undefined;
  let observedExecutionStart: Date | undefined;
  let observedExecutionEnd: Date | undefined;
  let scheduledObservation: ScheduledExecutionObservation | undefined;
  let shadowRun: ActivationCheckReport["shadowRun"] | null = null;
  if (options.phase === "ready") {
    timestamp(options.approvalCreatedAfter, "Approval boundary");
    const activation = await runActivationCheck({
      ...options,
      approvalProof: {
        approvalId: options.expectedApprovalId,
        createdAfter: options.approvalCreatedAfter,
        maxAgeSeconds: 3600,
      },
    });
    checks.push(...activation.checks);
    blockers.push(...activation.blockers);
    record("production-shadow-approval",
      activation.approved === true && activation.checks.length > 0 &&
      activation.checks.every((check) => check.status === "pass") &&
      activation.blockers.length === 0,
      "The exact, fresh signed smoke approval and manual shadow proof must pass activation verification.");
    shadowRun = activation.shadowRun ?? null;
    const shadowStarted = Date.parse(shadowRun?.startedAt ?? "");
    const shadowCompleted = Date.parse(shadowRun?.completedAt ?? "");
    record("production-shadow-terminal-safe",
      shadowRun !== null && ["SHADOW", "HOLD", "REJECTED"].includes(shadowRun.outcome) &&
      shadowRun.idempotencyKey === options.expectedShadowIdempotencyKey &&
      shadowRun.tradeCount === 0 && shadowRun.errorType === null && Number.isFinite(shadowStarted) &&
      shadowStarted >= Date.parse(options.expectedShadowStartedAfter) &&
      Number.isFinite(shadowCompleted) && shadowCompleted >= shadowStarted &&
      shadowCompleted <= Date.now(),
      "The selected manual shadow run must be complete, error-free and zero-fill, without a lock outcome.");
  } else {
    assertFreshWorkflowObservation(options.observation, new Date());
    const observed = options.observation.observation;
    if (observed.purpose !== "scheduled-execution" ||
        observed.releaseSha !== releaseSha || observed.workflow.sha !== releaseSha ||
        observed.imageDigest !== imageDigest || observed.targetOrigin !== targetOrigin ||
        observed.opsImageDigest !== validateImageDigest(options.opsImageDigest) ||
        observed.authorizationId !== options.authorizationId ||
        observed.scheduleGeneration !== options.scheduleGeneration) {
      throw new Error("The authenticated Azure execution does not match this exact production release, target or authorization.");
    }
    scheduledObservation = observed;
    observedExecutionStart = new Date(observed.execution.startedAt);
    observedExecutionEnd = new Date(observed.execution.completedAt);
    expectedKey = buildIdempotencyKey(
      "/api/agent/run", observedExecutionStart, undefined,
      `${imageDigest}-${options.scheduleGeneration}`,
    );
    record("scheduled-execution-observation", true,
      "Workflow-attested Azure readback binds the completed execution and verified schedule window; Azure does not expose manual-versus-scheduled origin.");
  }

  let state: StateRow | undefined;
  let scheduledRun: RunRow | undefined;
  try {
    await readOnly(options.databaseUrl, async (sql) => {
      [state] = await sql<StateRow[]>`
        SELECT "accountingStatus"::text AS "accountingStatus",
          "currentPositionETHDecimal"::text AS "ethBalance",
          "currentPositionUSDCDecimal"::text AS "usdcBalance",
          "isOperatorPaused", "isLocked", "isRunning", "leaseOwner", "leaseExpiresAt",
          EXISTS(SELECT 1 FROM "krypto"."DeploymentFence"
            WHERE id = 'singleton' AND "releasedAt" IS NULL) AS fenced
        FROM "krypto"."AgentState" WHERE id = 'singleton'
      `;
      if (expectedKey) {
        [scheduledRun] = await sql<RunRow[]>`
          SELECT r.id, r."idempotencyKey", r."triggerSource", r."tradingMode"::text AS "tradingMode",
            r.outcome::text AS outcome, r."startedAt", r."completedAt", r."errorType",
            (SELECT COUNT(*)::int FROM "krypto"."TradeExecution" t WHERE t."agentRunId" = r.id) AS "tradeCount",
            (SELECT COUNT(*)::int FROM "krypto"."AgentJournal" j WHERE j."agentRunId" = r.id) AS "journalCount",
            (SELECT COUNT(*)::int FROM "krypto"."AgentJournal" j
              JOIN "krypto"."TradeExecution" t ON t.id = j."tradeExecutionId"
              WHERE j."agentRunId" = r.id AND t."agentRunId" = r.id) AS "tradeJournalCount"
          FROM "krypto"."AgentRun" r WHERE r."idempotencyKey" = ${expectedKey}
        `;
      }
    });
  } catch (error) {
    record("production-database-read", false,
      `Production evidence could not be read (${error instanceof Error ? error.name : "UnknownError"}).`);
  }
  record("production-accounting-reconciled", state?.accountingStatus === "RECONCILED",
    "Production accounting must be RECONCILED.");
  record("production-balances-valid",
    nonnegativeDecimal(state?.ethBalance, ETH_SCALE) && nonnegativeDecimal(state?.usdcBalance, USD_SCALE),
    "Production balances must be nonnegative, exact canonical decimals.");
  record("production-stops-inactive", state?.isOperatorPaused === false && state?.isLocked === false,
    "Operator pause and drawdown lock must remain explicitly inactive.");
  record("production-lease-released",
    state?.isRunning === false && state.leaseOwner === null && state.leaseExpiresAt === null,
    "The production run lease must be fully released.");
  record("production-fence-released", state?.fenced === false,
    "No unreleased production cutover fence may remain.");

  if (options.phase === "scheduled") {
    assertFreshWorkflowObservation(options.observation, new Date());
    const terminal = scheduledRun !== undefined && scheduledRun.completedAt instanceof Date &&
      Number.isFinite(scheduledRun.completedAt.getTime()) &&
      scheduledRun.completedAt >= scheduledRun.startedAt && scheduledRun.completedAt.getTime() <= Date.now() &&
      observedExecutionEnd !== undefined && scheduledRun.completedAt <= observedExecutionEnd;
    record("scheduled-run-binding",
      scheduledRun?.idempotencyKey === expectedKey && scheduledRun?.triggerSource === "cron" &&
      scheduledRun.tradingMode === "PAPER" && observedExecutionStart !== undefined &&
      scheduledRun.startedAt >= observedExecutionStart,
      "The scheduled AgentRun must match this paper image, generation and actual Azure execution window.");
    record("scheduled-run-terminal", terminal && scheduledRun?.errorType === null &&
      ["HOLD", "REJECTED", "EXECUTED"].includes(scheduledRun?.outcome ?? ""),
    "The scheduled paper AgentRun must finish without a runtime or accounting error.");
    record("scheduled-run-journal", scheduledRun !== undefined && scheduledRun.journalCount > 0,
      "The exact scheduled AgentRun must have a persisted journal.");
    record("scheduled-run-fills", scheduledRun !== undefined &&
      (scheduledRun.outcome === "EXECUTED"
        ? scheduledRun.tradeCount === 1 && scheduledRun.tradeJournalCount > 0
        : scheduledRun.tradeCount === 0),
    "Fills must agree with the terminal outcome and have a correlated execution journal; a fill is never required.");
  }

  return {
    schemaVersion: "1.3.0", operation: "production-verification", intendedMode: "paper",
    phase: options.phase, generatedAt: new Date().toISOString(),
    releaseSha, imageDigest, targetOrigin, authorizationId: options.authorizationId,
    scheduleGeneration: options.scheduleGeneration,
    approved: blockers.length === 0, checks, blockers,
    approvalId: options.phase === "ready" ? options.expectedApprovalId : null,
    shadowRun,
    workflowObservation: options.phase === "scheduled" ? options.observation.receipt : null,
    scheduledExecution: scheduledObservation ? {
      ...scheduledObservation.execution,
      scheduleEnabledAt: scheduledObservation.scheduleEnabledAt,
      originAssurance: scheduledObservation.originAssurance,
    } : null,
    posthog: {
      host: options.posthogHost, environment: "prod",
      keyBinding: scryptSync(
        options.posthogApiKey,
        JSON.stringify(["production-posthog-key-binding", 2, options.posthogHost, approvalSecret]),
        32,
        { cost: 131_072, blockSize: 8, parallelization: 1, maxmem: 256 * 1024 * 1024 },
      ).toString("hex"),
    },
    scheduledRun: scheduledRun ? {
      id: scheduledRun.id, idempotencyKey: scheduledRun.idempotencyKey, outcome: scheduledRun.outcome,
      startedAt: scheduledRun.startedAt.toISOString(), completedAt: scheduledRun.completedAt?.toISOString() ?? null,
      tradeCount: scheduledRun.tradeCount, journalCount: scheduledRun.journalCount,
      tradeJournalCount: scheduledRun.tradeJournalCount,
    } : null,
  };
}
