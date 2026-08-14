import { randomUUID } from "node:crypto";
import {
  and,
  desc,
  eq,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { db } from "@/db";
import {
  agentJournal,
  agentRun,
  agentState,
  tradeExecution,
  type AgentRun,
  type AgentState,
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
} from "@/lib/analytics";
import { executePaperTrade } from "@/trading/paper-executor";
import {
  AgentUpstreamError,
  RequiredRolloutModeError,
  TradeConflictError,
  TradingConfigurationError,
  TradingDomainError,
} from "@/trading/errors";
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

const ACCOUNT_ID = "singleton";
const LEASE_DURATION_MS = 90_000;

export interface ExecuteAgentRunOptions {
  triggerSource: AgentTriggerSource;
  idempotencyKey?: string;
  requiredMode?: TradingMode;
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
    }
  | { kind: "existing"; run: AgentRun }
  | { kind: "conflict"; runId: string; message: string };

export function configuredModelVersion(
  env: Record<string, string | undefined> = process.env,
): string | null {
  return env.AZURE_OPENAI_DEPLOYMENT_NAME ?? null;
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
    throw new Error(`${field} is not initialized`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${field} is not finite`);
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
    if (existing && !idempotencyReplayMatchesMode(existing.tradingMode, mode)) {
      return {
        kind: "conflict",
        runId: existing.id,
        message:
          "Idempotency key belongs to an AgentRun from a different rollout mode.",
      };
    }
    if (
      existing &&
      existing.outcome !== "RUNNING" &&
      existing.outcome !== "CONFLICT"
    ) {
      return { kind: "existing", run: existing };
    }

    const runId = existing?.id ?? newRunId;
    const leaseOwner = runId;
    if (!existing) {
      await tx.insert(agentRun).values({
        id: runId,
        idempotencyKey,
        triggerSource: options.triggerSource,
        tradingMode: databaseMode(mode),
        strategyVersion: DEFAULT_STRATEGY_CONFIG.version,
        modelVersion: configuredModelVersion(),
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
            lt(agentState.leaseExpiresAt, now),
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
          startedAt: now,
          completedAt: null,
        })
        .where(eq(agentRun.id, runId));
    }

    return { kind: "acquired", runId, leaseOwner, mode };
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
  }> = {},
): Promise<void> {
  await db
    .update(agentRun)
    .set({
      outcome,
      completedAt: now,
      ...values,
    })
    .where(eq(agentRun.id, runId));
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
    status,
    action: trade
      ? "trade"
      : status === "error"
        ? "error"
        : run.outcome.toLowerCase(),
    reasoning: run.errorMessage ?? undefined,
    error: status === "error" ? run.errorMessage ?? undefined : undefined,
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
  };

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
      return 504;
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

async function loadTradingContext() {
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
  const [spotPriceUSD, closes] = await Promise.all([
    provider.getEthSpotPrice(),
    provider.getEthClosingPrices(100),
  ]);
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
    recentJournalEntries: recentJournals.map((entry) => entry.entryText),
  };
}

async function markAccountToMarket(
  context: Awaited<ReturnType<typeof loadTradingContext>>,
  leaseOwner: string,
): Promise<void> {
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

  const [updated] = await db
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

  context.account.peakPortfolioValueUSD = peakPortfolioValueUSD;
  context.account.isLocked = shouldLock;
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
  tradeId?: string,
): Promise<void> {
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

  await db.insert(agentJournal).values({
    agentRunId: runId,
    tradeExecutionId: tradeId,
    entryText: lines.join("\n"),
    marketConditions: marketRecord(market),
  });
}

function finalizeAnalytics(
  result: AgentRunResult,
  triggerSource: AgentTriggerSource,
): void {
  trackAgentRunCompleted(result, triggerSource);
  if (result.tokenUsage) {
    trackLLMTokenUsage(result.tokenUsage);
  }
  if (
    result.trade?.success &&
    result.trade.direction &&
    result.trade.asset &&
    result.trade.amountUSD !== undefined &&
    result.trade.executionPrice !== undefined &&
    result.trade.feesUSD !== undefined
  ) {
    trackTradeExecuted({
      direction: result.trade.direction,
      asset: result.trade.asset,
      amountUSD: result.trade.amountUSD,
      executionPrice: result.trade.executionPrice,
      feesUSD: result.trade.feesUSD,
      pnlUSD: result.trade.pnlUSD ?? undefined,
    });
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

export async function executeAgentRun(
  options: ExecuteAgentRunOptions,
): Promise<ExecuteAgentRunOutcome> {
  const startedAt = new Date();
  const startedMs = startedAt.getTime();
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
  const acquisition = await acquireInvocation(
    options,
    mode,
    startedAt,
  );

  if (acquisition.kind === "existing") {
    return reconstructExistingRun(acquisition.run);
  }
  trackAgentRunStarted(options.triggerSource);
  if (acquisition.kind === "conflict") {
    const result: AgentRunResult = {
      runId: acquisition.runId,
      status: "skipped",
      action: "conflict",
      error: acquisition.message,
      durationMs: Date.now() - startedMs,
    };
    trackGuardrailTriggered(
      "run-lease",
      { reason: acquisition.message },
      options.triggerSource,
    );
    finalizeAnalytics(result, options.triggerSource);
    return {
      kind: "mutex",
      message: acquisition.message,
      result,
    };
  }

  const { runId, leaseOwner } = acquisition;
  let committedResult: AgentRunResult | null = null;

  try {
    if (modeError) throw modeError;
    if (mode === "disabled") {
      const completedAt = new Date();
      const result: AgentRunResult = {
        runId,
        status: "skipped",
        action: "disabled",
        reasoning: "Rollout mode is disabled",
        durationMs: completedAt.getTime() - startedMs,
      };
      await completeRun(runId, "DISABLED", completedAt, {
        latencyMs: result.durationMs,
      });
      finalizeAnalytics(result, options.triggerSource);
      return { kind: "ok", result };
    }

    const context = await loadTradingContext();
    await markAccountToMarket(context, leaseOwner);
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
      await persistJournal(runId, context.market, null, null);
      result.journalWritten = true;
      finalizeAnalytics(result, options.triggerSource);
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
      });
      decision = generated.decision;
      tokenUsage = generated.tokenUsage;
    } else {
      const completedAt = new Date();
      const locked =
        context.state.isLocked ||
        policy.drawdownPct >=
          DEFAULT_STRATEGY_CONFIG.maximumDrawdownPct;
      const result: AgentRunResult = {
        runId,
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
      await persistJournal(runId, context.market, null, null);
      result.journalWritten = true;
      trackGuardrailTriggered(
        "deterministic-policy",
        { reason: policy.holdReason },
        options.triggerSource,
      );
      finalizeAnalytics(result, options.triggerSource);
      return { kind: "ok", result };
    }

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
      await persistJournal(
        runId,
        context.market,
        decision,
        authorization,
      );
      result.journalWritten = true;
      finalizeAnalytics(result, options.triggerSource);
      return { kind: "ok", result };
    }

    const execution = await executePaperTrade({
      agentRunId: runId,
      leaseOwner,
      decision,
      market: context.market,
      strategy: DEFAULT_STRATEGY_CONFIG,
      now: new Date(),
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
    await persistJournal(
      runId,
      context.market,
      decision,
      authorization,
      execution.tradeId,
    );
    result.journalWritten = true;
    finalizeAnalytics(result, options.triggerSource);
    return { kind: "ok", result };
  } catch (error) {
    const completedAt = new Date();
    const message =
      error instanceof Error ? error.message : String(error);
    const httpStatus = errorHttpStatus(error);
    if (committedResult) {
      committedResult.error = message;
      committedResult.journalWritten = false;
      committedResult.durationMs = completedAt.getTime() - startedMs;
      await completeRun(runId, "EXECUTED", completedAt, {
        latencyMs: committedResult.durationMs,
        errorType: "post-commit-persistence",
        errorMessage: message,
      });
      finalizeAnalytics(committedResult, options.triggerSource);
      return {
        kind: "upstream_error",
        result: committedResult,
        httpStatus: 500,
      };
    }
    const result: AgentRunResult = {
      runId,
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
    };
    await completeRun(
      runId,
      error instanceof MarketDataError ||
        error instanceof AgentUpstreamError
        ? "UPSTREAM_ERROR"
        : "INTERNAL_ERROR",
      completedAt,
      {
        latencyMs: result.durationMs,
        tokenUsage: result.tokenUsage,
        errorType:
          error instanceof AgentUpstreamError
            ? error.errorType
            : error instanceof TradingDomainError
            ? error.code
            : error instanceof MarketDataError
              ? `market-data-${error.code}`
              : "unexpected-error",
        errorMessage: message,
      },
    );
    finalizeAnalytics(result, options.triggerSource);
    return { kind: "upstream_error", result, httpStatus };
  } finally {
    try {
      const released = await releaseLease(leaseOwner, new Date());
      if (!released) {
        console.error(
          `[agent] Lease ${leaseOwner} was not released because ownership changed`,
        );
        trackGuardrailTriggered(
          "lease-release",
          { reason: "lease ownership changed", leaseOwner },
          options.triggerSource,
        );
      }
    } catch (releaseError) {
      console.error("[agent] Failed to release run lease:", releaseError);
      trackGuardrailTriggered(
        "lease-release",
        {
          reason:
            releaseError instanceof Error
              ? releaseError.message
              : String(releaseError),
          leaseOwner,
        },
        options.triggerSource,
      );
    }
  }
}
