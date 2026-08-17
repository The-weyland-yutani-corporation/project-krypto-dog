import { randomUUID } from "node:crypto";
import {
  and,
  desc,
  eq,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { db } from "@/db";
import {
  agentJournal,
  agentRun,
  agentState,
  safetyIncidentOutbox,
  tradeExecution,
  type AgentRun,
  type AgentState,
  type SafetyIncidentOutbox,
} from "@/db/schema";
import { generateTradeDecision } from "@/agent/decision";
import {
  calculateEMA,
  calculateRSI,
} from "@/lib/indicators";
import {
  EMA_LONG_PERIOD,
  EMA_SHORT_PERIOD,
  JOURNAL_CONTEXT_COUNT,
  RSI_PERIOD,
} from "@/lib/config";
import {
  MarketDataError,
  getMarketDataProvider,
} from "@/lib/market-data-provider";
import type {
  AgentRunResult,
  PortfolioState,
  TradeResult,
} from "@/lib/types";
import {
  trackAgentRunCompleted,
  trackAgentRunStarted,
  trackGuardrailTriggered,
  trackLLMTokenUsage,
  trackTradeExecuted,
  type AgentTriggerSource,
  type TelemetryCaptureResult,
} from "@/lib/analytics";
import { executePaperTrade } from "@/trading/paper-executor";
import {
  AgentBindingMismatchError,
  AgentUpstreamError,
  AccountingError,
  RequiredRolloutModeError,
  TradeConflictError,
  TradingConfigurationError,
  TradingDomainError,
} from "@/trading/errors";
import { sendGuardrailAlert } from "@/lib/email";
import {
  DEFAULT_STRATEGY_CONFIG,
  resolveTradingMode,
  type TradingMode,
} from "@/trading/strategy-config";
import {
  authorizeTradeIntent,
  evaluateTradePolicy,
} from "@/trading/policy";
import type {
  AuthorizationResult,
  PolicyEvaluation,
  TradeDecision,
  TradingAccountSnapshot,
  TradingMarketSnapshot,
} from "@/trading/types";
import {
  AdmissionCapacityError,
  ExecutionDeadlineError,
  ProviderBudgetError,
  RUN_LEASE_DURATION_MS,
  createExecutionDeadline,
  type ExecutionDeadline,
} from "@/lib/execution-envelope";
import { flushPostHog, reservePostHogBudget } from "@/lib/posthog";
import {
  deriveProviderAttemptId,
  resolveReleaseDeploymentCorrelation,
  resolveRequestId,
} from "@/lib/correlation";
import {
  emitSafetyIncidentLog,
  insertCreatedSafetyIncident,
  safetyIncidentRepository,
  type CreateSafetyIncidentInput,
  type SafetyIncidentType,
} from "@/lib/safety-incidents";

const ACCOUNT_ID = "singleton";
const LEASE_DURATION_MS = RUN_LEASE_DURATION_MS;

export interface ExecuteAgentRunOptions {
  triggerSource: AgentTriggerSource;
  requestId?: string;
  idempotencyKey?: string;
  requiredMode?: TradingMode;
  signal?: AbortSignal;
  deadline?: ExecutionDeadline;
  hooks?: {
    afterPaperCommitBeforeJournal?: () => void | Promise<void>;
    beforeTelemetryFlush?: () => void | Promise<void>;
  };
}

export type ExecuteAgentRunOutcome =
  | { kind: "ok"; result: AgentRunResult }
  | { kind: "mutex"; message: string; result?: AgentRunResult }
  | { kind: "upstream_error"; result: AgentRunResult; httpStatus: number };

type InvocationAcquisition =
  | {
      kind: "acquired";
      runId: string;
      leaseOwner: string;
      mode: TradingMode;
      startedAt: Date;
      deadlineAt: Date;
      requestId: string;
      releaseId: string;
      deploymentId: string;
      providerAttemptId: string | null;
    }
  | {
      kind: "existing";
      run: AgentRun;
      recoveryIncident?: SafetyIncidentOutbox;
    }
  | {
      kind: "conflict";
      runId: string;
      message: string;
      requestId: string;
      releaseId: string;
      deploymentId: string;
      providerAttemptId: string | null;
    };

export function configuredModelVersion(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const agentName = env.AZURE_FOUNDRY_AGENT_NAME;
  const agentVersion = env.AZURE_FOUNDRY_AGENT_VERSION;
  if (agentName && agentVersion) {
    return `${agentName}@${agentVersion}`;
  }
  return null;
}

function databaseMode(mode: TradingMode): "DISABLED" | "SHADOW" | "PAPER" {
  return mode.toUpperCase() as "DISABLED" | "SHADOW" | "PAPER";
}

export function idempotencyReplayMatchesMode(
  persistedMode: AgentRun["tradingMode"],
  currentMode: TradingMode,
): boolean {
  return persistedMode === databaseMode(currentMode);
}

function defaultIdempotencyKey(
  triggerSource: AgentTriggerSource,
  now: Date,
): string {
  if (triggerSource === "cron") {
    return `cron:${now.toISOString().slice(0, 13)}`;
  }
  return `admin:${randomUUID()}`;
}

function decimalNumber(value: string | null, field: string): number {
  if (value === null) {
    throw new AccountingError(`${field} is not initialized`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new AccountingError(`${field} is not finite`);
  }
  return parsed;
}

function accountSnapshot(
  state: AgentState,
  lastExecutionAt: Date | null,
): TradingAccountSnapshot {
  return {
    initialCapitalUSD: decimalNumber(
      state.initialCapitalUSD,
      "initialCapitalUSD",
    ),
    ethBalance: decimalNumber(
      state.currentPositionETHDecimal,
      "currentPositionETHDecimal",
    ),
    usdcBalance: decimalNumber(
      state.currentPositionUSDCDecimal,
      "currentPositionUSDCDecimal",
    ),
    weightedCostBasisUSD:
      state.weightedCostBasisUSD === null
        ? null
        : decimalNumber(
            state.weightedCostBasisUSD,
            "weightedCostBasisUSD",
          ),
    referencePriceUSD:
      state.referencePriceUSD === null
        ? null
        : decimalNumber(state.referencePriceUSD, "referencePriceUSD"),
    lastBuyPriceUSD:
      state.lastBuyPriceUSD === null
        ? null
        : decimalNumber(state.lastBuyPriceUSD, "lastBuyPriceUSD"),
    dcaCount: state.dcaCount,
    peakPortfolioValueUSD: decimalNumber(
      state.peakPortfolioValueUSD,
      "peakPortfolioValueUSD",
    ),
    lastExecutionAt,
    isLocked: state.isLocked,
    isOperatorPaused: state.isOperatorPaused,
    accountingStatus: state.accountingStatus,
  };
}

async function acquireInvocation(
  options: ExecuteAgentRunOptions,
  mode: TradingMode,
  now: Date,
  deadlineAt: Date,
): Promise<InvocationAcquisition> {
  const idempotencyKey =
    options.idempotencyKey ??
    defaultIdempotencyKey(options.triggerSource, now);
  const newRunId = randomUUID();

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${idempotencyKey}))`,
    );

    const [existing] = await tx
      .select()
      .from(agentRun)
      .where(eq(agentRun.idempotencyKey, idempotencyKey))
      .limit(1);
    const requestId =
      existing?.requestId ?? resolveRequestId(options.requestId);
    const releaseDeployment = existing
      ? {
          releaseId: existing.releaseId,
          deploymentId: existing.deploymentId,
        }
      : resolveReleaseDeploymentCorrelation();
    if (existing && !idempotencyReplayMatchesMode(existing.tradingMode, mode)) {
      return {
        kind: "conflict",
        runId: existing.id,
        message:
          "Idempotency key belongs to an AgentRun from a different rollout mode.",
        requestId,
        releaseId: releaseDeployment.releaseId,
        deploymentId: releaseDeployment.deploymentId,
        providerAttemptId: existing.providerAttemptId,
      };
    }
    if (
      existing &&
      existing.outcome !== "RUNNING" &&
      existing.outcome !== "CONFLICT"
    ) {
      return { kind: "existing", run: existing };
    }
    if (
      existing &&
      existing.outcome === "RUNNING" &&
      existing.deadlineAt.getTime() <= now.getTime()
    ) {
      const [leaseState] = await tx
        .select({
          leaseOwner: agentState.leaseOwner,
          leaseExpiresAt: agentState.leaseExpiresAt,
          isRunning: agentState.isRunning,
        })
        .from(agentState)
        .where(eq(agentState.id, ACCOUNT_ID))
        .for("update")
        .limit(1);
      if (
        leaseState?.leaseOwner === existing.id &&
        leaseState.leaseExpiresAt !== null &&
        leaseState.leaseExpiresAt.getTime() > now.getTime()
      ) {
        return {
          kind: "conflict",
          runId: existing.id,
          message: "The original invocation still owns an unexpired run lease",
          requestId,
          releaseId: releaseDeployment.releaseId,
          deploymentId: releaseDeployment.deploymentId,
          providerAttemptId: existing.providerAttemptId,
        };
      }
      const [terminal] = await tx
        .update(agentRun)
        .set({
          outcome: "UPSTREAM_ERROR",
          errorType: "execution-deadline-exhausted",
          errorMessage:
            "Recovered invocation had already exhausted its persisted deadline; no trade was attempted.",
          latencyMs: Math.max(
            0,
            now.getTime() - existing.startedAt.getTime(),
          ),
          completedAt: now,
        })
        .where(
          and(
            eq(agentRun.id, existing.id),
            eq(agentRun.outcome, "RUNNING"),
          ),
        )
        .returning();
      await tx
        .update(agentState)
        .set({
          leaseOwner: null,
          leaseExpiresAt: null,
          isRunning: false,
          lastRunAt: now,
          lastCompletedRunAt: now,
        })
        .where(
          and(
            eq(agentState.id, ACCOUNT_ID),
            eq(agentState.leaseOwner, existing.id),
            or(
              isNull(agentState.leaseExpiresAt),
              lte(agentState.leaseExpiresAt, now),
            ),
          ),
        );
      if (terminal) {
        const recoveryIncident = await insertCreatedSafetyIncident(
          tx,
          {
            incidentType: "DEADLINE_BUDGET_EXHAUSTION",
            severity: "CRITICAL",
            dedupKey: `expired-run-recovery:${existing.id}`,
            requestId,
            agentRunId: existing.id,
            releaseId: releaseDeployment.releaseId,
            deploymentId: releaseDeployment.deploymentId,
            providerAttemptId: existing.providerAttemptId,
            redactedContext: {
              component: "run-flow",
              operation: "expired-run-recovery",
              failureCode: "execution-deadline-exhausted",
              outcome: "error",
              leaseAgeSeconds: Math.max(
                0,
                Math.floor(
                  (now.getTime() - existing.startedAt.getTime()) / 1_000,
                ),
              ),
            },
            occurredAt: now,
            ownerRole: "PRIMARY_ON_CALL",
            backupRole: "BACKUP_ON_CALL",
            runbook:
              "specs/incident-response.md#scenario-actions",
          },
          { now: () => now },
        );
        return {
          kind: "existing",
          run: terminal,
          recoveryIncident: recoveryIncident.event,
        };
      }
      const [current] = await tx
        .select()
        .from(agentRun)
        .where(eq(agentRun.id, existing.id))
        .limit(1);
      return { kind: "existing", run: current ?? existing };
    }

    const runId = existing?.id ?? newRunId;
    const leaseOwner = runId;
    if (!existing) {
      await tx.insert(agentRun).values({
        id: runId,
        idempotencyKey,
        requestId,
        releaseId: releaseDeployment.releaseId,
        deploymentId: releaseDeployment.deploymentId,
        triggerSource: options.triggerSource,
        tradingMode: databaseMode(mode),
        strategyVersion: DEFAULT_STRATEGY_CONFIG.version,
        modelVersion: configuredModelVersion(),
        startedAt: now,
        deadlineAt,
      });
    }

    const [leasedState] = await tx
      .update(agentState)
      .set({
        leaseOwner,
        leaseExpiresAt: new Date(now.getTime() + LEASE_DURATION_MS),
        isRunning: true,
      })
      .where(
        and(
          eq(agentState.id, ACCOUNT_ID),
          or(
            isNull(agentState.leaseOwner),
            isNull(agentState.leaseExpiresAt),
            lte(agentState.leaseExpiresAt, now),
          ),
        ),
      )
      .returning();

    if (!leasedState) {
      if (!existing) {
        await tx
          .update(agentRun)
          .set({
            outcome: "CONFLICT",
            errorType: "lease-conflict",
            errorMessage: "Another invocation owns the run lease",
            latencyMs: 0,
            completedAt: now,
          })
          .where(eq(agentRun.id, runId));
      }
      return {
        kind: "conflict",
        runId,
        message: "Agent is already running",
        requestId,
        releaseId: releaseDeployment.releaseId,
        deploymentId: releaseDeployment.deploymentId,
        providerAttemptId: existing?.providerAttemptId ?? null,
      };
    }

    if (existing) {
      await tx
        .update(agentRun)
        .set({
          triggerSource: options.triggerSource,
          tradingMode: databaseMode(mode),
          outcome: "RUNNING",
          strategyVersion: DEFAULT_STRATEGY_CONFIG.version,
          modelVersion: configuredModelVersion(),
          marketSnapshot: null,
          accountSnapshotBefore: null,
          accountSnapshotAfter: null,
          proposedDecision: null,
          authorizationResult: null,
          tokenUsage: null,
          latencyMs: null,
          errorType: null,
          errorMessage: null,
          completedAt: null,
        })
        .where(eq(agentRun.id, runId));
    }

    return {
      kind: "acquired",
      runId,
      leaseOwner,
      mode,
      startedAt: existing?.startedAt ?? now,
      deadlineAt: existing?.deadlineAt ?? deadlineAt,
      requestId,
      releaseId: releaseDeployment.releaseId,
      deploymentId: releaseDeployment.deploymentId,
      providerAttemptId: existing?.providerAttemptId ?? null,
    };
  });
}

async function releaseLease(
  leaseOwner: string,
  now: Date,
): Promise<boolean> {
  const released = await db
    .update(agentState)
    .set({
      leaseOwner: null,
      leaseExpiresAt: null,
      isRunning: false,
      lastRunAt: now,
      lastCompletedRunAt: now,
    })
    .where(
      and(
        eq(agentState.id, ACCOUNT_ID),
        eq(agentState.leaseOwner, leaseOwner),
      ),
    )
    .returning({ id: agentState.id });
  return released.length === 1;
}

async function completeRun(
  runId: string,
  outcome: AgentRun["outcome"],
  now: Date,
  values: Partial<{
    marketSnapshot: Record<string, unknown>;
    accountSnapshotBefore: Record<string, unknown>;
    accountSnapshotAfter: Record<string, unknown>;
    proposedDecision: Record<string, unknown>;
    authorizationResult: Record<string, unknown>;
    tokenUsage: Record<string, unknown>;
    latencyMs: number;
    errorType: string;
    errorMessage: string;
    providerAttemptId: string | null;
  }> = {},
): Promise<void> {
  await db
    .update(agentRun)
    .set({
      outcome,
      completedAt: now,
      ...values,
    })
    .where(
      and(
        eq(agentRun.id, runId),
        or(
          eq(agentRun.outcome, "RUNNING"),
          eq(agentRun.outcome, outcome),
        ),
      ),
    );
}

async function completeRunWithIncident(
  runId: string,
  outcome: AgentRun["outcome"],
  now: Date,
  values: Parameters<typeof completeRun>[3],
  incident: CreateSafetyIncidentInput,
) {
  return db.transaction(async (tx) => {
    if (incident.incidentType === "RECONCILIATION_QUARANTINE") {
      const quarantined = await tx
        .update(agentState)
        .set({
          accountingStatus: "QUARANTINED",
          accountingIssue:
            "Typed accounting invariant failure; inspect the linked safety incident.",
        })
        .where(
          and(
            eq(agentState.id, ACCOUNT_ID),
            eq(agentState.leaseOwner, runId),
          ),
        )
        .returning({ id: agentState.id });
      if (quarantined.length !== 1) {
        throw new TradeConflictError(
          "Accounting quarantine requires the owned run lease",
        );
      }
    }
    await tx
      .update(agentRun)
      .set({
        outcome,
        completedAt: now,
        ...values,
      })
      .where(eq(agentRun.id, runId));
    return insertCreatedSafetyIncident(tx, incident);
  });
}

async function reconstructExistingRun(
  run: AgentRun,
): Promise<ExecuteAgentRunOutcome> {
  if (run.outcome === "RUNNING" || run.outcome === "CONFLICT") {
    return { kind: "mutex", message: "Agent is already running" };
  }

  const [trade] = await db
    .select()
    .from(tradeExecution)
    .where(eq(tradeExecution.agentRunId, run.id))
    .limit(1);
  const incidentEvents = trade
    ? await db
        .select()
        .from(safetyIncidentOutbox)
        .where(eq(safetyIncidentOutbox.transactionId, trade.id))
        .orderBy(desc(safetyIncidentOutbox.eventSequence))
    : [];
  const [persistedJournal] = await db
    .select({
      id: agentJournal.id,
      tradeExecutionId: agentJournal.tradeExecutionId,
    })
    .from(agentJournal)
    .where(eq(agentJournal.agentRunId, run.id))
    .orderBy(desc(agentJournal.createdAt))
    .limit(1);
  const journalWritten = Boolean(
    persistedJournal &&
      (!trade || persistedJournal.tradeExecutionId === trade.id),
  );
  const createdIncident = incidentEvents.find(
    (event) => event.eventKind === "CREATED",
  );
  const postCommitDeliveryConfirmed = incidentEvents.some(
    (event) => event.eventKind === "DELIVERY_CONFIRMED",
  );
  const status: AgentRunResult["status"] =
    run.outcome === "EXECUTED"
      ? "executed"
      : run.outcome === "LOCKED"
        ? "locked"
        : run.outcome === "UPSTREAM_ERROR" ||
            run.outcome === "INTERNAL_ERROR"
          ? "error"
          : "skipped";
  const result: AgentRunResult = {
    runId: run.id,
    requestId: run.requestId,
    releaseId: run.releaseId,
    deploymentId: run.deploymentId,
    providerAttemptId: run.providerAttemptId,
    transactionId: trade?.id,
    incidentId: createdIncident?.incidentId,
    status,
    action: trade
      ? "trade"
      : status === "error"
        ? "error"
        : run.outcome.toLowerCase(),
    reasoning: run.errorMessage ?? undefined,
    error:
      status === "error" || run.errorType === "post-commit-persistence"
        ? run.errorMessage ?? undefined
        : undefined,
    trade: trade
      ? {
          success: true,
          tradeId: trade.id,
          direction: trade.direction,
          asset: trade.asset,
          amountUSD: trade.amountUSD,
          executionPrice: trade.executionPrice,
          amountAsset: trade.amountAsset,
          feesUSD: trade.feesUSD,
          pnlUSD: trade.pnlUSD,
        }
      : undefined,
    durationMs: run.latencyMs ?? 0,
    journalWritten,
  };

  if (run.errorType === "post-commit-persistence") {
    return {
      kind: "upstream_error",
      result,
      httpStatus: 500,
    };
  }
  if (trade && (!createdIncident || !postCommitDeliveryConfirmed)) {
    if (createdIncident) emitSafetyIncidentLog(createdIncident);
    const criticalIncident = await safetyIncidentRepository.createOrGet({
      incidentType: "POST_COMMIT_FAILURE",
      severity: "CRITICAL",
      dedupKey: `post-commit-replay:${run.id}`,
      requestId: run.requestId,
      agentRunId: run.id,
      releaseId: run.releaseId,
      deploymentId: run.deploymentId,
      providerAttemptId: run.providerAttemptId,
      transactionId: trade.id,
      redactedContext: {
        component: "run-flow",
        operation: "idempotent-replay",
        failureCode: createdIncident
          ? "post-commit-delivery-unconfirmed"
          : "post-commit-obligation-missing",
        journalWritten,
        outcome: "executed-with-post-commit-failure",
      },
      ownerRole: "PRIMARY_ON_CALL",
      backupRole: "EVIDENCE_CUSTODIAN",
      runbook:
        "specs/incident-response.md#post-commit-journal-or-telemetry-failure",
    });
    result.incidentId = criticalIncident.event.incidentId;
    result.error =
      "Committed paper trade has an unresolved durable post-commit obligation";
    result.journalWritten = journalWritten;
    return {
      kind: "upstream_error",
      result,
      httpStatus: 500,
    };
  }
  if (result.status === "error") {
    return {
      kind: "upstream_error",
      result,
      httpStatus: persistedErrorHttpStatus(run.errorType),
    };
  }
  return { kind: "ok", result };
}

function persistedErrorHttpStatus(errorType: string | null): number {
  switch (errorType) {
    case "configuration-error":
    case "post-commit-persistence":
      return 500;
    case "LLM_RATE_LIMIT":
      return 503;
    case "LLM_TIMEOUT":
    case "market-data-timeout":
    case "execution-deadline-exhausted":
      return 504;
    case "provider-budget-exhausted:coinbase:daily-requests":
    case "provider-budget-exhausted:foundry:daily-requests":
    case "provider-budget-exhausted:posthog:daily-requests":
    case "provider-budget-exhausted:acs:daily-requests":
      return 503;
    case "trade-conflict":
    case "lease-conflict":
      return 409;
    case "authorization-rejected":
    case "accounting-error":
      return 422;
    default:
      return 502;
  }
}

async function loadTradingContext(
  runId: string,
  requestId: string,
  deadline: ExecutionDeadline,
) {
  deadline.assertActive("trading context database read");
  const [state] = await db
    .select()
    .from(agentState)
    .where(eq(agentState.id, ACCOUNT_ID))
    .limit(1);
  if (!state) {
    throw new Error("AgentState singleton not found");
  }

  const [lastTrade] = await db
    .select({ createdAt: tradeExecution.createdAt })
    .from(tradeExecution)
    .orderBy(desc(tradeExecution.createdAt))
    .limit(1);
  const recentJournals = await db
    .select({ entryText: agentJournal.entryText })
    .from(agentJournal)
    .orderBy(desc(agentJournal.createdAt))
    .limit(JOURNAL_CONTEXT_COUNT);

  const provider = getMarketDataProvider();
  const providerAttemptId = deriveProviderAttemptId({
    requestId,
    provider: "coinbase",
    attempt: 1,
  });
  await db
    .update(agentRun)
    .set({ providerAttemptId })
    .where(and(eq(agentRun.id, runId), eq(agentRun.outcome, "RUNNING")));
  deadline.assertActive("Coinbase market data");
  const providerDeadlineAt = new Date(
    deadline.now().getTime() + 20_000,
  );
  const [spotPriceUSD, closes] = await Promise.all([
    provider.getEthSpotPrice({ deadline, providerDeadlineAt }),
    provider.getEthClosingPrices(100, { deadline, providerDeadlineAt }),
  ]);
  deadline.assertActive("indicator calculation");
  const rsi = calculateRSI(closes, RSI_PERIOD);
  const emaShort = calculateEMA(closes, EMA_SHORT_PERIOD);
  const emaLong = calculateEMA(closes, EMA_LONG_PERIOD);
  const market: TradingMarketSnapshot = {
    spotPriceUSD,
    observedAt: new Date(),
    rsi: Math.round(rsi * 100) / 100,
    emaShort,
    emaLong,
  };

  return {
    state,
    account: accountSnapshot(state, lastTrade?.createdAt ?? null),
    market,
    providerAttemptId,
    recentJournalEntries: recentJournals.map((entry) => entry.entryText),
  };
}

async function markAccountToMarket(
  context: Awaited<ReturnType<typeof loadTradingContext>>,
  run: Pick<
    Extract<InvocationAcquisition, { kind: "acquired" }>,
    "runId" | "requestId" | "releaseId" | "deploymentId"
  >,
  leaseOwner: string,
  deadline: ExecutionDeadline,
): Promise<string | null> {
  deadline.assertActive("mark account to market");
  const portfolioValueUSD =
    context.account.usdcBalance +
    context.account.ethBalance * context.market.spotPriceUSD;
  const peakPortfolioValueUSD = Math.max(
    context.account.initialCapitalUSD,
    context.account.peakPortfolioValueUSD,
    portfolioValueUSD,
  );
  const drawdownPct =
    peakPortfolioValueUSD > 0
      ? Math.max(
          0,
          ((peakPortfolioValueUSD - portfolioValueUSD) /
            peakPortfolioValueUSD) *
            100,
        )
      : 0;
  const shouldLock =
    context.account.isLocked ||
    drawdownPct >= DEFAULT_STRATEGY_CONFIG.maximumDrawdownPct;
  const newlyLocked = shouldLock && !context.account.isLocked;
  const lockReason = newlyLocked
    ? `Maximum drawdown reached (${drawdownPct.toFixed(2)}%)`
    : context.state.lockReason;

  const transition = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(agentState)
      .set({
        portfolioValueUSD,
        portfolioValueUSDDecimal: portfolioValueUSD.toFixed(8),
        peakPortfolioValueUSD: peakPortfolioValueUSD.toFixed(8),
        drawdownPct: drawdownPct.toFixed(8),
        isLocked: shouldLock,
        lockReason,
        lockedAt: newlyLocked ? new Date() : context.state.lockedAt,
        strategyVersion: DEFAULT_STRATEGY_CONFIG.version,
        strategySnapshot: DEFAULT_STRATEGY_CONFIG,
      })
      .where(
        and(
          eq(agentState.id, ACCOUNT_ID),
          eq(agentState.leaseOwner, leaseOwner),
        ),
      )
      .returning({ id: agentState.id });

    if (!updated) {
      throw new TradeConflictError(
        "Run lease ownership changed while marking the account to market",
      );
    }

    if (!newlyLocked) return { incident: null };
    const incident = await insertCreatedSafetyIncident(tx, {
      incidentType: "DRAWDOWN_LOCK",
      severity: "CRITICAL",
      dedupKey: `drawdown-lock:${run.runId}`,
      requestId: run.requestId,
      agentRunId: run.runId,
      releaseId: run.releaseId,
      deploymentId: run.deploymentId,
      providerAttemptId: context.providerAttemptId,
      redactedContext: {
        component: "run-flow",
        operation: "drawdown-lock",
        locked: true,
        reasonCode: "maximum-drawdown",
      },
      ownerRole: "PRIMARY_ON_CALL",
      backupRole: "BACKUP_ON_CALL",
      runbook: "specs/incident-response.md#drawdown-lock",
    });
    return { incident: incident.event };
  });

  context.account.peakPortfolioValueUSD = peakPortfolioValueUSD;
  context.account.isLocked = shouldLock;
  if (transition.incident) emitSafetyIncidentLog(transition.incident);
  return transition.incident?.incidentId ?? null;
}

function marketRecord(
  market: TradingMarketSnapshot,
): Record<string, unknown> {
  return {
    ...market,
    observedAt: market.observedAt.toISOString(),
  };
}

function accountRecord(
  account: TradingAccountSnapshot,
): Record<string, unknown> {
  return {
    ...account,
    lastExecutionAt: account.lastExecutionAt?.toISOString() ?? null,
  };
}

async function persistJournal(
  runId: string,
  market: TradingMarketSnapshot,
  decision: TradeDecision | null,
  authorization: AuthorizationResult | null,
  correlation: {
    requestId: string;
    releaseId: string;
    deploymentId: string;
    providerAttemptId: string | null;
    incidentId?: string;
    transactionId?: string;
  },
  tradeId?: string,
): Promise<string> {
  const lines = [
    decision
      ? `Model decision: ${decision.action}${decision.notionalUSD === null ? "" : ` $${decision.notionalUSD.toFixed(2)}`}.`
      : "No model decision was requested.",
    decision?.reasoning
      ? `Model reasoning: ${decision.reasoning}`
      : undefined,
    authorization
      ? `Authorization: ${authorization.authorized ? "authorized" : "rejected"} - ${authorization.reason}`
      : undefined,
  ].filter((line): line is string => Boolean(line));

  const [entry] = await db
    .insert(agentJournal)
    .values({
      agentRunId: runId,
      tradeExecutionId: tradeId,
      entryText: lines.join("\n"),
      marketConditions: {
        ...marketRecord(market),
        requestId: correlation.requestId,
        runId,
        releaseId: correlation.releaseId,
        deploymentId: correlation.deploymentId,
        providerAttemptId: correlation.providerAttemptId,
        transactionId: correlation.transactionId ?? null,
        incidentId: correlation.incidentId ?? null,
      },
    })
    .returning({ id: agentJournal.id });
  if (!entry) throw new Error("Journal insert returned no durable evidence ID");
  return entry.id;
}

async function persistBindingMismatchJournal(
  runId: string,
  market: TradingMarketSnapshot,
  error: AgentBindingMismatchError,
  correlation: {
    requestId: string;
    releaseId: string;
    deploymentId: string;
    providerAttemptId: string | null;
  },
): Promise<void> {
  await db.insert(agentJournal).values({
    agentRunId: runId,
    entryText: [
      "Guardrail triggered: Foundry agent binding mismatch.",
      `Expected binding: ${error.expectedBinding}.`,
      `Actual binding: ${error.actualBinding}.`,
      "No trade was authorized or executed.",
    ].join("\n"),
    marketConditions: {
      ...marketRecord(market),
      guardrail: "foundry-agent-binding",
      expectedBinding: error.expectedBinding,
      actualBinding: error.actualBinding,
      requestId: correlation.requestId,
      runId,
      releaseId: correlation.releaseId,
      deploymentId: correlation.deploymentId,
      providerAttemptId: correlation.providerAttemptId,
    },
  });
}

class TelemetryEvidenceError extends Error {
  readonly failureCode = "posthog-telemetry-failed";

  constructor(readonly failedEvents: string[]) {
    super("PostHog telemetry was not durably delivered");
    this.name = "TelemetryEvidenceError";
  }
}

async function finalizeAnalytics(
  result: AgentRunResult,
  triggerSource: AgentTriggerSource,
  deadline: ExecutionDeadline,
  hooks?: ExecuteAgentRunOptions["hooks"],
): Promise<void> {
  const captures: TelemetryCaptureResult[] = [
    trackAgentRunCompleted(result, triggerSource),
  ];
  if (result.tokenUsage) {
    captures.push(
      trackLLMTokenUsage({
        ...result.tokenUsage,
        requestId: result.requestId,
        runId: result.runId,
        providerAttemptId: result.providerAttemptId,
      }),
    );
  }
  if (
    result.trade?.success &&
    result.trade.direction &&
    result.trade.asset &&
    result.trade.amountUSD !== undefined &&
    result.trade.executionPrice !== undefined &&
    result.trade.feesUSD !== undefined
  ) {
    captures.push(trackTradeExecuted({
      direction: result.trade.direction,
      asset: result.trade.asset,
      amountUSD: result.trade.amountUSD,
      executionPrice: result.trade.executionPrice,
      feesUSD: result.trade.feesUSD,
      pnlUSD: result.trade.pnlUSD ?? undefined,
      requestId: result.requestId,
      runId: result.runId,
      releaseId: result.releaseId,
      deploymentId: result.deploymentId,
      providerAttemptId: result.providerAttemptId,
      transactionId: result.transactionId,
      incidentId: result.incidentId,
    }));
  }
  const failedEvents = captures
    .filter((capture) => !capture.accepted)
    .map((capture) => capture.event);
  if (failedEvents.length > 0) {
    throw new TelemetryEvidenceError(failedEvents);
  }
  try {
    await hooks?.beforeTelemetryFlush?.();
    await flushPostHog({ deadline });
  } catch {
    throw new TelemetryEvidenceError(["posthog_flush"]);
  }
}

function resultFromExecution(
  runId: string,
  execution: Awaited<ReturnType<typeof executePaperTrade>>,
  market: TradingMarketSnapshot,
  reasoning: string,
  tokenUsage: AgentRunResult["tokenUsage"],
  isLocked: boolean,
  durationMs: number,
  correlation: {
    requestId: string;
    releaseId: string;
    deploymentId: string;
    providerAttemptId: string | null;
  },
): AgentRunResult {
  const trade: TradeResult = {
    success: true,
    tradeId: execution.tradeId,
    direction: execution.direction,
    asset: "ETH",
    amountUSD: Number(execution.grossNotionalUSD),
    executionPrice: Number(execution.executionPriceUSD),
    amountAsset: Number(execution.quantityETH),
    feesUSD: Number(execution.feeUSD),
    pnlUSD:
      execution.realizedPnlUSD === null
        ? null
        : Number(execution.realizedPnlUSD),
  };
  const portfolioState: PortfolioState = {
    ethBalance: Number(execution.accountAfter.ethBalance),
    usdcBalance: Number(execution.accountAfter.usdcBalance),
    ethPrice: market.spotPriceUSD,
    portfolioValueUSD: Number(
      execution.accountAfter.portfolioValueUSD,
    ),
    lastTradePrice: Number(execution.executionPriceUSD),
    isLocked,
  };
  return {
    runId,
    ...correlation,
    transactionId: execution.tradeId,
    incidentId: execution.incidentId,
    status: "executed",
    action: "trade",
    reasoning,
    trade,
    portfolioState,
    tokenUsage,
    durationMs,
  };
}

function errorHttpStatus(error: unknown): number {
  if (error instanceof TelemetryEvidenceError) return 500;
  if (error instanceof ExecutionDeadlineError) return 504;
  if (error instanceof ProviderBudgetError) return 503;
  if (error instanceof AdmissionCapacityError) return 503;
  if (error instanceof AgentUpstreamError) {
    return error.httpStatus;
  }

  if (error instanceof MarketDataError) {
    return error.code === "timeout" ? 504 : 502;
  }
  if (error instanceof TradeConflictError) {
    return 409;
  }
  if (error instanceof TradingConfigurationError) {
    return 500;
  }
  if (error instanceof TradingDomainError) {
    return 422;
  }
  return 502;
}

function incidentTypeForRunError(error: unknown): SafetyIncidentType {
  if (error instanceof TelemetryEvidenceError) return "TELEMETRY_FAILURE";
  if (error instanceof AgentBindingMismatchError) {
    return "AUTH_PROVENANCE_MISMATCH";
  }
  if (
    error instanceof ExecutionDeadlineError ||
    error instanceof ProviderBudgetError ||
    error instanceof AdmissionCapacityError
  ) {
    return "DEADLINE_BUDGET_EXHAUSTION";
  }
  if (error instanceof AgentUpstreamError || error instanceof MarketDataError) {
    return "PROVIDER_FAILURE";
  }
  if (
    error instanceof TradingDomainError &&
    error.code === "accounting-error"
  ) {
    return "RECONCILIATION_QUARANTINE";
  }
  return "ROUTE_RUN_FAILURE";
}

function failureCodeForRunError(error: unknown): string {
  if (error instanceof TelemetryEvidenceError) return error.failureCode;
  if (error instanceof ExecutionDeadlineError) return error.code;
  if (error instanceof ProviderBudgetError) {
    return `${error.code}:${error.provider}:${error.kind}`;
  }
  if (error instanceof AgentUpstreamError) return error.errorType;
  if (error instanceof MarketDataError) return `market-data-${error.code}`;
  if (error instanceof TradingDomainError) return error.code;
  return "unexpected-error";
}

export function normalizeAgentRunError(
  error: unknown,
  deadlineAt: Date,
): unknown {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "57014" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string" &&
    (error as { message: string }).message.includes(
      "Paper trade commit rejected at or after AgentRun deadline",
    )
  ) {
    return new ExecutionDeadlineError(
      deadlineAt,
      "paper execution commit",
      (error as { message: string }).message,
    );
  }
  return error;
}

export async function executeAgentRun(
  options: ExecuteAgentRunOptions,
): Promise<ExecuteAgentRunOutcome> {
  let mode: TradingMode = "disabled";
  let modeError: TradingConfigurationError | null = null;
  try {
    mode = resolveTradingMode();
  } catch (error) {
    if (!(error instanceof TradingConfigurationError)) throw error;
    // Persist invalid rollout configuration as the fail-closed DISABLED mode;
    // the terminal run record still carries the typed configuration error.
    modeError = error;
  }
  if (modeError && options.requiredMode) {
    throw modeError;
  }
  if (options.requiredMode && mode !== options.requiredMode) {
    throw new RequiredRolloutModeError(options.requiredMode, mode);
  }
  const ownsRequestDeadline = !options.deadline;
  const requestDeadline =
    options.deadline ??
    createExecutionDeadline({
      signal: options.signal,
    });
  let acquisition: InvocationAcquisition;
  try {
    acquisition = await acquireInvocation(
      options,
      mode,
      requestDeadline.startedAt,
      requestDeadline.deadlineAt,
    );
  } catch (error) {
    if (ownsRequestDeadline) requestDeadline.dispose();
    throw error;
  }

  if (acquisition.kind === "existing") {
    if (acquisition.recoveryIncident) {
      emitSafetyIncidentLog(acquisition.recoveryIncident);
    }
    if (ownsRequestDeadline) requestDeadline.dispose();
    return reconstructExistingRun(acquisition.run);
  }
  if (acquisition.kind === "conflict") {
    const result: AgentRunResult = {
      runId: acquisition.runId,
      requestId: acquisition.requestId,
      releaseId: acquisition.releaseId,
      deploymentId: acquisition.deploymentId,
      providerAttemptId: acquisition.providerAttemptId,
      status: "skipped",
      action: "conflict",
      error: acquisition.message,
      durationMs: Date.now() - requestDeadline.startedAt.getTime(),
    };
    trackGuardrailTriggered(
      "run-lease",
      { reason: acquisition.message },
      options.triggerSource,
    );
    const conflictCapture = trackAgentRunCompleted(
      result,
      options.triggerSource,
    );
    let conflictTelemetryFailed = !conflictCapture.accepted;
    if (!conflictTelemetryFailed) {
      if (requestDeadline.remainingMs() <= 0) {
        conflictTelemetryFailed = true;
      } else {
        try {
          await flushPostHog({ deadline: requestDeadline });
        } catch {
          conflictTelemetryFailed = true;
        }
      }
    }
    if (conflictTelemetryFailed) {
      const incident = await safetyIncidentRepository.createOrGet({
        incidentType: "TELEMETRY_FAILURE",
        severity: "CRITICAL",
        dedupKey: `mutex-telemetry-failure:${acquisition.runId}`,
        requestId: acquisition.requestId,
        agentRunId: acquisition.runId,
        releaseId: acquisition.releaseId,
        deploymentId: acquisition.deploymentId,
        providerAttemptId: acquisition.providerAttemptId,
        redactedContext: {
          component: "run-flow",
          operation: "mutex-terminal-telemetry",
          failureCode: "posthog-telemetry-failed",
          outcome: "conflict",
        },
        ownerRole: "PRIMARY_ON_CALL",
        backupRole: "EVIDENCE_CUSTODIAN",
        runbook:
          "specs/incident-response.md#telemetry-or-alert-provider-failure",
      });
      result.incidentId = incident.event.incidentId;
    }
    if (ownsRequestDeadline) requestDeadline.dispose();
    return {
      kind: "mutex",
      message: acquisition.message,
      result,
    };
  }

  const {
    runId,
    leaseOwner,
    requestId,
    releaseId,
    deploymentId,
  } = acquisition;
  let providerAttemptId = acquisition.providerAttemptId;
  const resultCorrelation = () => ({
    requestId,
    releaseId,
    deploymentId,
    providerAttemptId,
  });
  const startedTelemetry = trackAgentRunStarted(options.triggerSource, {
    requestId,
    runId,
    releaseId,
    deploymentId,
  });
  const persistedDeadlineAt = acquisition.deadlineAt;
  const effectiveDeadlineAt = new Date(
    Math.min(
      persistedDeadlineAt.getTime(),
      requestDeadline.deadlineAt.getTime(),
    ),
  );
  const usesRequestDeadline =
    acquisition.startedAt.getTime() === requestDeadline.startedAt.getTime() &&
    effectiveDeadlineAt.getTime() === requestDeadline.deadlineAt.getTime();
  const deadline = usesRequestDeadline
    ? requestDeadline
    : createExecutionDeadline({
        startedAt: acquisition.startedAt,
        deadlineAt: effectiveDeadlineAt,
        signal: requestDeadline.signal,
      });
  const startedAt = acquisition.startedAt;
  const startedMs = startedAt.getTime();
  let committedResult: AgentRunResult | null = null;
  let tradingContext: Awaited<ReturnType<typeof loadTradingContext>> | null =
    null;

  try {
    if (!startedTelemetry.accepted) {
      throw new TelemetryEvidenceError([startedTelemetry.event]);
    }
    if (modeError) throw modeError;
    if (mode === "disabled") {
      const completedAt = new Date();
      const result: AgentRunResult = {
        runId,
        ...resultCorrelation(),
        status: "skipped",
        action: "disabled",
        reasoning: "Rollout mode is disabled",
        durationMs: completedAt.getTime() - startedMs,
      };
      await completeRun(runId, "DISABLED", completedAt, {
        latencyMs: result.durationMs,
      });
      await finalizeAnalytics(result, options.triggerSource, deadline, options.hooks);
      return { kind: "ok", result };
    }

    deadline.assertActive("run execution");
    await reservePostHogBudget({ deadline });
    const context = (tradingContext = await loadTradingContext(
      runId,
      requestId,
      deadline,
    ));
    providerAttemptId = context.providerAttemptId;
    await markAccountToMarket(
      context,
      { runId, requestId, releaseId, deploymentId },
      leaseOwner,
      deadline,
    );
    deadline.assertActive("deterministic policy evaluation");
    const policy = evaluateTradePolicy(
      context.account,
      context.market,
      DEFAULT_STRATEGY_CONFIG,
      new Date(),
    );

    if (policy.referencePriceToInitialize !== undefined) {
      await db
        .update(agentState)
        .set({
          referencePriceUSD:
            policy.referencePriceToInitialize.toFixed(8),
          strategyVersion: DEFAULT_STRATEGY_CONFIG.version,
          strategySnapshot: DEFAULT_STRATEGY_CONFIG,
        })
        .where(
          and(
            eq(agentState.id, ACCOUNT_ID),
            eq(agentState.leaseOwner, leaseOwner),
          ),
        );
      const completedAt = new Date();
      const result: AgentRunResult = {
        runId,
        ...resultCorrelation(),
        status: "skipped",
        action: "hold",
        reasoning: policy.holdReason,
        durationMs: completedAt.getTime() - startedMs,
      };
      await completeRun(runId, "HOLD", completedAt, {
        marketSnapshot: marketRecord(context.market),
        accountSnapshotBefore: accountRecord(context.account),
        latencyMs: result.durationMs,
      });
      deadline.assertActive("journal persistence");
      await persistJournal(
        runId,
        context.market,
        null,
        null,
        resultCorrelation(),
      );
      result.journalWritten = true;
      await finalizeAnalytics(result, options.triggerSource, deadline, options.hooks);
      return { kind: "ok", result };
    }

    let decision: TradeDecision;
    let tokenUsage: AgentRunResult["tokenUsage"];
    if (policy.mandatoryTrade) {
      decision = {
        action: "HOLD",
        notionalUSD: null,
        reasoning: "Deterministic safety policy controls this run",
      };
    } else if (policy.shouldInvokeModel) {
      const generated = await generateTradeDecision({
        account: context.account,
        market: context.market,
        policy,
        strategy: DEFAULT_STRATEGY_CONFIG,
        recentJournalEntries: context.recentJournalEntries,
      }, {
        deadline,
        signal: deadline.signal,
        requestId,
        providerDeadlineAt: new Date(
          Math.min(
            deadline.operationalDeadlineAt.getTime(),
            deadline.now().getTime() + 80_000,
          ),
        ),
      });
      decision = generated.decision;
      tokenUsage = generated.tokenUsage;
      providerAttemptId =
        generated.providerAttemptId ?? context.providerAttemptId;
      await db
        .update(agentRun)
        .set({ providerAttemptId })
        .where(and(eq(agentRun.id, runId), eq(agentRun.outcome, "RUNNING")));
    } else {
      const completedAt = new Date();
      const locked =
        context.state.isLocked ||
        policy.drawdownPct >=
          DEFAULT_STRATEGY_CONFIG.maximumDrawdownPct;
      const result: AgentRunResult = {
        runId,
        ...resultCorrelation(),
        status: locked ? "locked" : "skipped",
        action: "hold",
        reasoning: policy.holdReason,
        guardrailTriggered: policy.holdReason,
        durationMs: completedAt.getTime() - startedMs,
      };
      await completeRun(
        runId,
        locked ? "LOCKED" : "HOLD",
        completedAt,
        {
          marketSnapshot: marketRecord(context.market),
          accountSnapshotBefore: accountRecord(context.account),
          latencyMs: result.durationMs,
        },
      );
      deadline.assertActive("journal persistence");
      await persistJournal(
        runId,
        context.market,
        null,
        null,
        resultCorrelation(),
      );
      result.journalWritten = true;
      const guardrailTelemetry = trackGuardrailTriggered(
        "deterministic-policy",
        { reason: policy.holdReason },
        options.triggerSource,
      );
      if (!guardrailTelemetry.accepted) {
        throw new TelemetryEvidenceError([guardrailTelemetry.event]);
      }
      await finalizeAnalytics(
        result,
        options.triggerSource,
        deadline,
        options.hooks,
      );
      return { kind: "ok", result };
    }

    deadline.assertActive("deterministic authorization");
    const authorization = authorizeTradeIntent(
      policy,
      decision,
      DEFAULT_STRATEGY_CONFIG,
    );

    if (!authorization.authorized || mode === "shadow") {
      const completedAt = new Date();
      const outcome =
        mode === "shadow" && authorization.authorized
          ? "SHADOW"
          : decision.action === "HOLD"
            ? "HOLD"
            : "REJECTED";
      const result: AgentRunResult = {
        runId,
        ...resultCorrelation(),
        status: "skipped",
        action: mode === "shadow" ? "shadow" : decision.action.toLowerCase(),
        reasoning: decision.reasoning,
        tokenUsage,
        authorization: {
          authorized: authorization.authorized,
          reason: authorization.reason,
          adjusted:
            authorization.authorized ? authorization.adjusted : undefined,
        },
        durationMs: completedAt.getTime() - startedMs,
      };
      await completeRun(runId, outcome, completedAt, {
        marketSnapshot: marketRecord(context.market),
        accountSnapshotBefore: accountRecord(context.account),
        proposedDecision: decision,
        authorizationResult: authorization,
        tokenUsage,
        latencyMs: result.durationMs,
      });
      deadline.assertActive("journal persistence");
      await persistJournal(
        runId,
        context.market,
        decision,
        authorization,
        resultCorrelation(),
      );
      result.journalWritten = true;
      await finalizeAnalytics(result, options.triggerSource, deadline, options.hooks);
      return { kind: "ok", result };
    }

    deadline.assertActive("paper transaction");
    const execution = await executePaperTrade({
      agentRunId: runId,
      leaseOwner,
      decision,
      market: context.market,
      strategy: DEFAULT_STRATEGY_CONFIG,
      now: new Date(),
      deadlineAt: persistedDeadlineAt,
      deadline,
    });
    const completedAt = new Date();
    const result = resultFromExecution(
      runId,
      execution,
      context.market,
      decision.reasoning,
      tokenUsage,
      context.account.isLocked,
      completedAt.getTime() - startedMs,
      resultCorrelation(),
    );
    committedResult = result;
    result.authorization = {
      authorized: true,
      reason: authorization.reason,
      adjusted: authorization.adjusted,
    };
    await completeRun(runId, "EXECUTED", completedAt, {
      marketSnapshot: marketRecord(context.market),
      accountSnapshotBefore: accountRecord(context.account),
      proposedDecision: decision,
      authorizationResult: authorization,
      tokenUsage,
      latencyMs: result.durationMs,
    });
    await options.hooks?.afterPaperCommitBeforeJournal?.();
    deadline.assertActive("journal persistence");
    const journalId = await persistJournal(
      runId,
      context.market,
      decision,
      authorization,
      {
        ...resultCorrelation(),
        incidentId: execution.incidentId,
        transactionId: execution.tradeId,
      },
      execution.tradeId,
    );
    result.journalWritten = true;
    emitSafetyIncidentLog(execution.incidentEvent);
    await finalizeAnalytics(result, options.triggerSource, deadline, options.hooks);
    await safetyIncidentRepository.appendDeliveryLifecycle({
      incidentId: execution.incidentId,
      eventKind: "DELIVERY_CONFIRMED",
      attemptId: `journal-telemetry:${journalId}`,
      evidence: {
        artifactRef: `agent-journal:${journalId}`,
        verification: "journal-and-telemetry-persisted",
        deliveryChannel: "database-and-posthog",
      },
    });
    return { kind: "ok", result };
  } catch (caughtError) {
    const error = normalizeAgentRunError(
      caughtError,
      persistedDeadlineAt,
    );
    const completedAt = deadline.now();
    const message =
      error instanceof Error ? error.message : String(error);
    const httpStatus = errorHttpStatus(error);
    if (error instanceof AgentUpstreamError && error.providerAttemptId) {
      providerAttemptId = error.providerAttemptId;
    } else if (
      (error instanceof ProviderBudgetError ||
        error instanceof ExecutionDeadlineError) &&
      error.providerAttemptId
    ) {
      providerAttemptId = error.providerAttemptId;
    } else if (error instanceof MarketDataError) {
      providerAttemptId = deriveProviderAttemptId({
        requestId,
        provider: "coinbase",
        attempt: 1,
      });
    } else if (error instanceof ProviderBudgetError) {
      providerAttemptId = deriveProviderAttemptId({
        requestId,
        provider: error.provider,
        attempt: 1,
      });
    }
    if (error instanceof ProviderBudgetError) {
      trackGuardrailTriggered(
        "provider-budget",
        { provider: error.provider, kind: error.kind },
        options.triggerSource,
      );
      console.error(
        `[agent] bounded-runtime-failure code=${error.code} provider=${error.provider} kind=${error.kind}`,
      );
    } else if (error instanceof ExecutionDeadlineError) {
      trackGuardrailTriggered(
        "execution-deadline",
        { phase: error.phase },
        options.triggerSource,
      );
      console.error(
        `[agent] bounded-runtime-failure code=${error.code} phase=${error.phase}`,
      );
    }
    if (committedResult) {
      committedResult.error = message;
      committedResult.journalWritten =
        committedResult.journalWritten ?? false;
      committedResult.durationMs = completedAt.getTime() - startedMs;
      if (committedResult.incidentId) {
        await safetyIncidentRepository.appendDeliveryLifecycle({
          incidentId: committedResult.incidentId,
          eventKind: "DELIVERY_FAILED",
          attemptId: `post-commit-failure:${runId}:${failureCodeForRunError(error)}`,
          evidence: {
            deliveryFailureCode: failureCodeForRunError(error),
            deliveryChannel: "database-and-posthog",
            retryOutcome: "not-resolved",
          },
        });
      }
      const postCommitIncident = await completeRunWithIncident(
        runId,
        "EXECUTED",
        completedAt,
        {
          latencyMs: committedResult.durationMs,
          errorType: "post-commit-persistence",
          errorMessage: message,
          providerAttemptId,
        },
        {
          incidentType: "POST_COMMIT_FAILURE",
          severity: "CRITICAL",
          dedupKey: `post-commit-failure:${runId}`,
          requestId,
          agentRunId: runId,
          releaseId,
          deploymentId,
          providerAttemptId,
          transactionId: committedResult.transactionId,
          redactedContext: {
            component: "run-flow",
            operation: "post-commit-evidence",
            failureCode: failureCodeForRunError(error),
            journalWritten: committedResult.journalWritten,
            outcome: "executed-with-post-commit-failure",
          },
          ownerRole: "PRIMARY_ON_CALL",
          backupRole: "BACKUP_ON_CALL",
          runbook:
            "specs/incident-response.md#post-commit-journal-or-telemetry-failure",
        },
      );
      emitSafetyIncidentLog(postCommitIncident.event);
      committedResult.incidentId = postCommitIncident.event.incidentId;
      if (error instanceof TelemetryEvidenceError) {
        const telemetryIncident =
          await safetyIncidentRepository.createOrGet({
            incidentType: "TELEMETRY_FAILURE",
            severity: "CRITICAL",
            dedupKey: `telemetry-failure:${runId}`,
            requestId,
            agentRunId: runId,
            releaseId,
            deploymentId,
            providerAttemptId,
            transactionId: committedResult.transactionId,
            redactedContext: {
              component: "run-flow",
              operation: "telemetry-delivery",
              failureCode: error.failureCode,
              outcome: "executed-with-telemetry-failure",
            },
            ownerRole: "PRIMARY_ON_CALL",
            backupRole: "EVIDENCE_CUSTODIAN",
            runbook:
              "specs/incident-response.md#post-commit-journal-or-telemetry-failure",
          });
        committedResult.incidentId = telemetryIncident.event.incidentId;
      }
      const postCommitCapture = trackAgentRunCompleted(
        committedResult,
        options.triggerSource,
      );
      if (
        !(error instanceof TelemetryEvidenceError) &&
        !postCommitCapture.accepted
      ) {
        await safetyIncidentRepository.createOrGet({
          incidentType: "TELEMETRY_FAILURE",
          severity: "CRITICAL",
          dedupKey: `telemetry-failure:${runId}`,
          requestId,
          agentRunId: runId,
          releaseId,
          deploymentId,
          providerAttemptId,
          transactionId: committedResult.transactionId,
          redactedContext: {
            component: "run-flow",
            operation: "terminal-telemetry",
            failureCode: "posthog-telemetry-failed",
            outcome: "executed-with-telemetry-failure",
          },
          ownerRole: "PRIMARY_ON_CALL",
          backupRole: "EVIDENCE_CUSTODIAN",
          runbook:
            "specs/incident-response.md#post-commit-journal-or-telemetry-failure",
        });
      }
      if (
        !(error instanceof TelemetryEvidenceError) &&
        postCommitCapture.accepted &&
        deadline.remainingMs() <= 0
      ) {
        await safetyIncidentRepository.createOrGet({
          incidentType: "TELEMETRY_FAILURE",
          severity: "CRITICAL",
          dedupKey: `telemetry-failure:${runId}`,
          requestId,
          agentRunId: runId,
          releaseId,
          deploymentId,
          providerAttemptId,
          transactionId: committedResult.transactionId,
          redactedContext: {
            component: "run-flow",
            operation: "terminal-telemetry",
            failureCode: "terminal-budget-exhausted",
            outcome: "executed-with-telemetry-failure",
          },
          ownerRole: "PRIMARY_ON_CALL",
          backupRole: "EVIDENCE_CUSTODIAN",
          runbook:
            "specs/incident-response.md#post-commit-journal-or-telemetry-failure",
        });
      }
      if (
        !(error instanceof TelemetryEvidenceError) &&
        postCommitCapture.accepted &&
        deadline.remainingMs() > 0
      ) {
        try {
          await flushPostHog({ deadline });
        } catch {
          await safetyIncidentRepository.createOrGet({
            incidentType: "TELEMETRY_FAILURE",
            severity: "CRITICAL",
            dedupKey: `telemetry-failure:${runId}`,
            requestId,
            agentRunId: runId,
            releaseId,
            deploymentId,
            providerAttemptId,
            transactionId: committedResult.transactionId,
            redactedContext: {
              component: "run-flow",
              operation: "terminal-telemetry",
              failureCode: "posthog-telemetry-failed",
              outcome: "executed-with-telemetry-failure",
            },
            ownerRole: "PRIMARY_ON_CALL",
            backupRole: "EVIDENCE_CUSTODIAN",
            runbook:
              "specs/incident-response.md#post-commit-journal-or-telemetry-failure",
          });
        }
      }
      return {
        kind: "upstream_error",
        result: committedResult,
        httpStatus: 500,
      };
    }
    let bindingMismatchJournalWritten = false;
    let bindingAlertFailed = false;
    if (
      error instanceof AgentBindingMismatchError &&
      deadline.remainingMs() > 0
    ) {
      const details = {
        expectedBinding: error.expectedBinding,
        actualBinding: error.actualBinding,
        reason: "agent response binding did not match the configured version",
      };
      trackGuardrailTriggered(
        "foundry-agent-binding",
        details,
        options.triggerSource,
      );
      if (tradingContext) {
        try {
          await persistBindingMismatchJournal(
            runId,
            tradingContext.market,
            error,
            resultCorrelation(),
          );
          bindingMismatchJournalWritten = true;
        } catch {
          console.error(
            JSON.stringify({
              eventType: "journal_persistence_failed",
              requestId,
              runId,
              failureCode: "foundry-binding-journal",
            }),
          );
        }
      }
      try {
        await sendGuardrailAlert(
          "Foundry agent binding",
          { error: "Foundry agent binding mismatch" },
          { deadline },
        );
      } catch {
        bindingAlertFailed = true;
        console.error(
          JSON.stringify({
            eventType: "email_delivery_failed",
            requestId,
            runId,
            failureCode: "foundry-binding-alert",
          }),
        );
      }
    }

    const result: AgentRunResult = {
      runId,
      ...resultCorrelation(),
      status: "error",
      action: "error",
      error: message,
      tokenUsage:
        error instanceof AgentUpstreamError &&
        error.attemptCount !== undefined &&
        error.latencyMs !== undefined
          ? {
              promptTokens: 0,
              completionTokens: 0,
              totalTokens: 0,
              attemptCount: error.attemptCount,
              latencyMs: error.latencyMs,
            }
          : undefined,
      durationMs: completedAt.getTime() - startedMs,
      journalWritten: bindingMismatchJournalWritten || undefined,
    };
    const errorType = failureCodeForRunError(error);
    const terminalIncident = await completeRunWithIncident(
      runId,
      error instanceof MarketDataError ||
        error instanceof AgentUpstreamError ||
        error instanceof ExecutionDeadlineError ||
        error instanceof ProviderBudgetError
        ? "UPSTREAM_ERROR"
        : "INTERNAL_ERROR",
      completedAt,
      {
        latencyMs: result.durationMs,
        tokenUsage: result.tokenUsage,
        errorType,
        errorMessage: message,
        providerAttemptId,
      },
      {
        incidentType: incidentTypeForRunError(error),
        severity: "CRITICAL",
        dedupKey: `run-failure:${runId}:${errorType}`,
        requestId,
        agentRunId: runId,
        releaseId,
        deploymentId,
        providerAttemptId,
        redactedContext: {
          component: "run-flow",
          operation: "terminal-failure",
          failureCode: errorType,
          outcome: "error",
          provider:
            error instanceof ProviderBudgetError
              ? error.provider
              : error instanceof AgentUpstreamError
                ? "foundry"
                : error instanceof MarketDataError
                  ? "coinbase"
                  : null,
          journalWritten: bindingMismatchJournalWritten,
        },
        ownerRole: "PRIMARY_ON_CALL",
        backupRole: "BACKUP_ON_CALL",
        runbook: "specs/incident-response.md#response-procedures",
      },
    );
    emitSafetyIncidentLog(terminalIncident.event);
    result.incidentId = terminalIncident.event.incidentId;

    if (bindingAlertFailed) {
      const emailIncident = await safetyIncidentRepository.createOrGet({
        incidentType: "EMAIL_DELIVERY_FAILURE",
        severity: "CRITICAL",
        dedupKey: `email-failure:${runId}:foundry-binding`,
        requestId,
        agentRunId: runId,
        releaseId,
        deploymentId,
        providerAttemptId,
        redactedContext: {
          component: "run-flow",
          operation: "guardrail-alert",
          failureCode: "foundry-binding-alert",
          deliveryChannel: "acs-email",
        },
        ownerRole: "PRIMARY_ON_CALL",
        backupRole: "BACKUP_ON_CALL",
        runbook: "specs/incident-response.md#provider-or-credential-concern",
      });
      result.incidentId = emailIncident.event.incidentId;
    }
    const terminalCapture = trackAgentRunCompleted(
      result,
      options.triggerSource,
    );
    let terminalTelemetryFailed = !terminalCapture.accepted;
    if (!terminalTelemetryFailed) {
      if (deadline.remainingMs() <= 0) {
        terminalTelemetryFailed = true;
      } else {
        try {
          await flushPostHog({ deadline });
        } catch {
          terminalTelemetryFailed = true;
        }
      }
    }
    if (
      terminalTelemetryFailed &&
      !(error instanceof TelemetryEvidenceError)
    ) {
      await safetyIncidentRepository.createOrGet({
        incidentType: "TELEMETRY_FAILURE",
        severity: "CRITICAL",
        dedupKey: `terminal-telemetry-failure:${runId}`,
        requestId,
        agentRunId: runId,
        releaseId,
        deploymentId,
        providerAttemptId,
        redactedContext: {
          component: "run-flow",
          operation: "terminal-telemetry",
          failureCode: "posthog-telemetry-failed",
          outcome: "error",
        },
        ownerRole: "PRIMARY_ON_CALL",
        backupRole: "EVIDENCE_CUSTODIAN",
        runbook:
          "specs/incident-response.md#telemetry-or-alert-provider-failure",
      });
    }
    return { kind: "upstream_error", result, httpStatus };
  } finally {
    try {
      deadline.assertActive("owned lease cleanup", true);
      const released = await releaseLease(leaseOwner, deadline.now());
      if (!released) {
        console.error(
          JSON.stringify({
            eventType: "lease_release_failed",
            requestId,
            runId,
            failureCode: "ownership-changed",
          }),
        );
        trackGuardrailTriggered(
          "lease-release",
          { reason: "lease ownership changed", requestId, runId },
          options.triggerSource,
        );
        await safetyIncidentRepository.createOrGet({
          incidentType: "STALE_OR_OVERLAPPING_LEASE",
          severity: "CRITICAL",
          dedupKey: `lease-release-failure:${runId}`,
          requestId,
          agentRunId: runId,
          releaseId,
          deploymentId,
          providerAttemptId,
          redactedContext: {
            component: "run-flow",
            operation: "lease-release",
            failureCode: "release-not-confirmed",
          },
          ownerRole: "PRIMARY_ON_CALL",
          backupRole: "BACKUP_ON_CALL",
          runbook: "specs/incident-response.md#stale-or-overlapping-lease",
        });
      }
    } catch {
      console.error(
        JSON.stringify({
          eventType: "lease_release_failed",
          requestId,
          runId,
          failureCode: "database-or-deadline",
        }),
      );
      trackGuardrailTriggered(
        "lease-release",
        {
          reason: "database or deadline failure",
          requestId,
          runId,
        },
        options.triggerSource,
      );
      await safetyIncidentRepository.createOrGet({
        incidentType: "STALE_OR_OVERLAPPING_LEASE",
        severity: "CRITICAL",
        dedupKey: `lease-release-failure:${runId}`,
        requestId,
        agentRunId: runId,
        releaseId,
        deploymentId,
        providerAttemptId,
        redactedContext: {
          component: "run-flow",
          operation: "lease-release",
          failureCode: "release-not-confirmed",
        },
        ownerRole: "PRIMARY_ON_CALL",
        backupRole: "BACKUP_ON_CALL",
        runbook: "specs/incident-response.md#stale-or-overlapping-lease",
      });
    }
    if (!usesRequestDeadline) deadline.dispose();
    if (ownsRequestDeadline) requestDeadline.dispose();
  }
}
