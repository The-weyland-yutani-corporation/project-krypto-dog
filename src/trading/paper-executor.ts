import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
  agentRun,
  agentState,
  deploymentFence,
  tradeExecution,
  type AgentState,
  type TradeExecution,
} from "@/db/schema";
import {
  ETH_SCALE,
  USD_SCALE,
  formatDecimal,
  notionalForQuantity,
  parseDecimal,
} from "./accounting";
import {
  AccountingError,
  TradeAuthorizationError,
  TradeConflictError,
} from "./errors";
import { authorizeTradeIntent, evaluateTradePolicy } from "./policy";
import { calculatePaperExecution } from "./paper-execution";
import type { StrategyConfig } from "./strategy-config";
import type {
  TradeDecision,
  TradingAccountSnapshot,
  TradingMarketSnapshot,
} from "./types";

const ACCOUNT_ID = "singleton";

export interface PaperExecutorHooks {
  afterTradeInsert?: () => void | Promise<void>;
}

export interface ExecutePaperTradeRequest {
  agentRunId: string;
  leaseOwner: string;
  decision: TradeDecision;
  market: TradingMarketSnapshot;
  strategy: StrategyConfig;
  now?: Date;
  hooks?: PaperExecutorHooks;
}

export interface PaperExecutionResult {
  status: "executed" | "idempotent";
  tradeId: string;
  direction: "BUY" | "SELL";
  requestedNotionalUSD: string;
  grossNotionalUSD: string;
  quantityETH: string;
  observedMarketPriceUSD: string;
  executionPriceUSD: string;
  feeUSD: string;
  slippageUSD: string;
  realizedPnlUSD: string | null;
  accountAfter: {
    ethBalance: string;
    usdcBalance: string;
    weightedCostBasisUSD: string | null;
    portfolioValueUSD: string;
    peakPortfolioValueUSD: string;
    drawdownPct: string;
    dcaCount: number;
  };
}

function requiredDecimal(value: string | null, field: string): string {
  if (value === null) {
    throw new AccountingError(`${field} is not initialized`);
  }
  return value;
}

function decimalToNumber(value: string | null, field: string): number {
  const parsed = Number(requiredDecimal(value, field));
  if (!Number.isFinite(parsed)) {
    throw new AccountingError(`${field} is not a finite number`);
  }
  return parsed;
}

function stateToPolicyAccount(
  state: AgentState,
  lastExecutionAt: Date | null,
): TradingAccountSnapshot {
  return {
    initialCapitalUSD: decimalToNumber(
      state.initialCapitalUSD,
      "initialCapitalUSD",
    ),
    ethBalance: decimalToNumber(
      state.currentPositionETHDecimal,
      "currentPositionETHDecimal",
    ),
    usdcBalance: decimalToNumber(
      state.currentPositionUSDCDecimal,
      "currentPositionUSDCDecimal",
    ),
    weightedCostBasisUSD:
      state.weightedCostBasisUSD === null
        ? null
        : decimalToNumber(
            state.weightedCostBasisUSD,
            "weightedCostBasisUSD",
          ),
    referencePriceUSD:
      state.referencePriceUSD === null
        ? null
        : decimalToNumber(state.referencePriceUSD, "referencePriceUSD"),
    lastBuyPriceUSD:
      state.lastBuyPriceUSD === null
        ? null
        : decimalToNumber(state.lastBuyPriceUSD, "lastBuyPriceUSD"),
    dcaCount: state.dcaCount,
    peakPortfolioValueUSD: decimalToNumber(
      state.peakPortfolioValueUSD,
      "peakPortfolioValueUSD",
    ),
    lastExecutionAt,
    isLocked: state.isLocked,
    isOperatorPaused: state.isOperatorPaused,
    accountingStatus: state.accountingStatus,
  };
}

function snapshotState(state: AgentState): Record<string, unknown> {
  return {
    ethBalance: state.currentPositionETHDecimal,
    usdcBalance: state.currentPositionUSDCDecimal,
    weightedCostBasisUSD: state.weightedCostBasisUSD,
    referencePriceUSD: state.referencePriceUSD,
    lastBuyPriceUSD: state.lastBuyPriceUSD,
    dcaCount: state.dcaCount,
    portfolioValueUSD: state.portfolioValueUSDDecimal,
    peakPortfolioValueUSD: state.peakPortfolioValueUSD,
    drawdownPct: state.drawdownPct,
    accountingStatus: state.accountingStatus,
  };
}

function resultFromRows(
  status: PaperExecutionResult["status"],
  trade: TradeExecution,
  state: AgentState,
): PaperExecutionResult {
  return {
    status,
    tradeId: trade.id,
    direction: trade.direction,
    requestedNotionalUSD: requiredDecimal(
      trade.requestedNotionalUSD,
      "requestedNotionalUSD",
    ),
    grossNotionalUSD: requiredDecimal(
      trade.modeledExecutionPriceUSD && trade.quantityAssetDecimal
        ? formatDecimal(
            notionalForQuantity(
              parseDecimal(trade.quantityAssetDecimal, ETH_SCALE),
              parseDecimal(trade.modeledExecutionPriceUSD, USD_SCALE),
            ),
            USD_SCALE,
          )
        : null,
      "grossNotionalUSD",
    ),
    quantityETH: requiredDecimal(
      trade.quantityAssetDecimal,
      "quantityAssetDecimal",
    ),
    observedMarketPriceUSD: requiredDecimal(
      trade.observedMarketPriceUSD,
      "observedMarketPriceUSD",
    ),
    executionPriceUSD: requiredDecimal(
      trade.modeledExecutionPriceUSD,
      "modeledExecutionPriceUSD",
    ),
    feeUSD: requiredDecimal(trade.feesUSDDecimal, "feesUSDDecimal"),
    slippageUSD: requiredDecimal(trade.slippageUSD, "slippageUSD"),
    realizedPnlUSD: trade.realizedPnlUSDDecimal,
    accountAfter: {
      ethBalance: requiredDecimal(
        state.currentPositionETHDecimal,
        "currentPositionETHDecimal",
      ),
      usdcBalance: requiredDecimal(
        state.currentPositionUSDCDecimal,
        "currentPositionUSDCDecimal",
      ),
      weightedCostBasisUSD: state.weightedCostBasisUSD,
      portfolioValueUSD: requiredDecimal(
        state.portfolioValueUSDDecimal,
        "portfolioValueUSDDecimal",
      ),
      peakPortfolioValueUSD: requiredDecimal(
        state.peakPortfolioValueUSD,
        "peakPortfolioValueUSD",
      ),
      drawdownPct: requiredDecimal(state.drawdownPct, "drawdownPct"),
      dcaCount: state.dcaCount,
    },
  };
}

export function createPaperExecutor(database: typeof db) {
  return async function execute(
    request: ExecutePaperTradeRequest,
  ): Promise<PaperExecutionResult> {
    const now = request.now ?? new Date();
    if (
      request.strategy.paperSlippageBps >
      request.strategy.slippageCeilingBps
    ) {
      throw new TradeAuthorizationError(
        "Configured paper slippage exceeds the rejection ceiling",
      );
    }

    return database.transaction(async (tx) => {
    const [existingBeforeLock] = await tx
      .select()
      .from(tradeExecution)
      .where(eq(tradeExecution.agentRunId, request.agentRunId))
      .limit(1);
    if (existingBeforeLock) {
      const [currentState] = await tx
        .select()
        .from(agentState)
        .where(eq(agentState.id, ACCOUNT_ID))
        .limit(1);
      if (!currentState) {
        throw new AccountingError("AgentState singleton not found");
      }
      return resultFromRows("idempotent", existingBeforeLock, currentState);
    }

    const [run] = await tx
      .select()
      .from(agentRun)
      .where(eq(agentRun.id, request.agentRunId))
      .limit(1);
    if (!run) {
      throw new TradeConflictError("AgentRun does not exist");
    }
    if (run.tradingMode !== "PAPER") {
      throw new TradeAuthorizationError(
        `AgentRun mode ${run.tradingMode} cannot execute a paper trade`,
      );
    }

    const [state] = await tx
      .select()
      .from(agentState)
      .where(eq(agentState.id, ACCOUNT_ID))
      .for("update");
    if (!state) {
      throw new AccountingError("AgentState singleton not found");
    }

    const [existingAfterLock] = await tx
      .select()
      .from(tradeExecution)
      .where(eq(tradeExecution.agentRunId, request.agentRunId))
      .limit(1);
    if (existingAfterLock) {
      return resultFromRows("idempotent", existingAfterLock, state);
    }

    const [fence] = await tx
      .select({ owner: deploymentFence.owner })
      .from(deploymentFence)
      .where(
        and(
          eq(deploymentFence.id, ACCOUNT_ID),
          isNull(deploymentFence.releasedAt),
        ),
      )
      .limit(1);
    if (fence) {
      throw new TradeConflictError(
        "Paper execution is fenced for deployment",
      );
    }

    if (
      state.leaseOwner !== request.leaseOwner ||
      state.leaseExpiresAt === null ||
      state.leaseExpiresAt.getTime() <= now.getTime()
    ) {
      throw new TradeConflictError(
        "Paper execution requires the owned, unexpired run lease",
      );
    }

    const [lastTrade] = await tx
      .select({ createdAt: tradeExecution.createdAt })
      .from(tradeExecution)
      .orderBy(desc(tradeExecution.createdAt))
      .limit(1);
    const account = stateToPolicyAccount(
      state,
      lastTrade?.createdAt ?? null,
    );
    const evaluation = evaluateTradePolicy(
      account,
      request.market,
      request.strategy,
      now,
    );
    const authorization = authorizeTradeIntent(
      evaluation,
      request.decision,
      request.strategy,
    );
    if (!authorization.authorized) {
      throw new TradeAuthorizationError(authorization.reason);
    }

    const observedPriceUSD = parseDecimal(
      request.market.spotPriceUSD.toFixed(USD_SCALE),
      USD_SCALE,
    );
    const requestedNotionalUSD = parseDecimal(
      authorization.intent.notionalUSD.toFixed(USD_SCALE),
      USD_SCALE,
    );
    const currentEth = parseDecimal(
      requiredDecimal(
        state.currentPositionETHDecimal,
        "currentPositionETHDecimal",
      ),
      ETH_SCALE,
    );
    const currentUsdc = parseDecimal(
      requiredDecimal(
        state.currentPositionUSDCDecimal,
        "currentPositionUSDCDecimal",
      ),
      USD_SCALE,
    );
    const currentCostBasis =
      state.weightedCostBasisUSD === null
        ? null
        : parseDecimal(state.weightedCostBasisUSD, USD_SCALE);

    const existingPeak = parseDecimal(
      requiredDecimal(
        state.peakPortfolioValueUSD,
        "peakPortfolioValueUSD",
      ),
      USD_SCALE,
    );
    const initialCapital = parseDecimal(state.initialCapitalUSD, USD_SCALE);
    const calculation = calculatePaperExecution(
      {
        account: {
          ethBalance: currentEth,
          usdcBalance: currentUsdc,
          weightedCostBasisUSD: currentCostBasis,
          dcaCount: state.dcaCount,
        },
        direction: authorization.intent.action,
        requestedNotionalUSD,
        observedPriceUSD,
        feeBps: request.strategy.feeBps,
        slippageBps: request.strategy.paperSlippageBps,
        fullExit: authorization.intent.fullExit,
        initialCapitalUSD: initialCapital,
        peakPortfolioValueUSD: existingPeak,
      },
      USD_SCALE,
    );
    const {
      executionPriceUSD,
      quantityETH,
      grossNotionalUSD,
      feeUSD,
      slippageUSD,
      transition,
      portfolioValueUSD,
      peakPortfolioValueUSD,
      drawdownPct: drawdown,
    } = calculation;

    const quantityText = formatDecimal(quantityETH, ETH_SCALE);
    const grossText = formatDecimal(grossNotionalUSD, USD_SCALE);
    const feeText = formatDecimal(feeUSD, USD_SCALE);
    const executionPriceText = formatDecimal(
      executionPriceUSD,
      USD_SCALE,
    );
    const observedPriceText = formatDecimal(observedPriceUSD, USD_SCALE);
    const slippageText = formatDecimal(slippageUSD, USD_SCALE);
    const ethAfterText = formatDecimal(
      transition.after.ethBalance,
      ETH_SCALE,
    );
    const usdcAfterText = formatDecimal(
      transition.after.usdcBalance,
      USD_SCALE,
    );
    const weightedCostAfterText =
      transition.after.weightedCostBasisUSD === null
        ? null
        : formatDecimal(
            transition.after.weightedCostBasisUSD,
            USD_SCALE,
          );
    const portfolioText = formatDecimal(portfolioValueUSD, USD_SCALE);
    const peakText = formatDecimal(peakPortfolioValueUSD, USD_SCALE);
    const drawdownText = formatDecimal(drawdown, USD_SCALE);
    const realizedPnlText =
      transition.realizedPnlUSD === null
        ? null
        : formatDecimal(transition.realizedPnlUSD, USD_SCALE);

    const [insertedTrade] = await tx
      .insert(tradeExecution)
      .values({
        agentRunId: request.agentRunId,
        direction: authorization.intent.action,
        asset: "ETH",
        pair: request.strategy.pair,
        amountUSD: Number(grossText),
        amountAsset: Number(quantityText),
        executionPrice: Number(executionPriceText),
        feesUSD: Number(feeText),
        slippage: request.strategy.paperSlippageBps / 10_000,
        pnlUSD:
          realizedPnlText === null ? null : Number(realizedPnlText),
        agentReasoning: authorization.intent.reasoning,
        requestedNotionalUSD: formatDecimal(
          requestedNotionalUSD,
          USD_SCALE,
        ),
        observedMarketPriceUSD: observedPriceText,
        modeledExecutionPriceUSD: executionPriceText,
        quantityAssetDecimal: quantityText,
        feeRateBps: request.strategy.feeBps,
        feesUSDDecimal: feeText,
        slippageBps: request.strategy.paperSlippageBps,
        slippageUSD: slippageText,
        ethBalanceBefore: formatDecimal(currentEth, ETH_SCALE),
        ethBalanceAfter: ethAfterText,
        usdcBalanceBefore: formatDecimal(currentUsdc, USD_SCALE),
        usdcBalanceAfter: usdcAfterText,
        costBasisBeforeUSD:
          transition.costBasisBeforeUSD === null
            ? null
            : formatDecimal(
                transition.costBasisBeforeUSD,
                USD_SCALE,
              ),
        costBasisAfterUSD: weightedCostAfterText,
        realizedPnlUSDDecimal: realizedPnlText,
        strategyVersion: request.strategy.version,
        signalSnapshot: {
          market: {
            ...request.market,
            observedAt: request.market.observedAt.toISOString(),
          },
          policy: evaluation,
          authorization,
        },
      })
      .returning();

    await request.hooks?.afterTradeInsert?.();

    const referencePriceAfter =
      authorization.intent.action === "SELL" &&
      authorization.intent.fullExit
        ? executionPriceText
        : state.referencePriceUSD;
    const lastBuyPriceAfter =
      authorization.intent.action === "BUY"
        ? executionPriceText
        : authorization.intent.fullExit
          ? null
          : state.lastBuyPriceUSD;

    const [updatedState] = await tx
      .update(agentState)
      .set({
        lastTradePrice: Number(executionPriceText),
        currentPositionETH: Number(ethAfterText),
        currentPositionUSDC: Number(usdcAfterText),
        portfolioValueUSD: Number(portfolioText),
        lastTradePriceDecimal: executionPriceText,
        currentPositionETHDecimal: ethAfterText,
        currentPositionUSDCDecimal: usdcAfterText,
        portfolioValueUSDDecimal: portfolioText,
        weightedCostBasisUSD: weightedCostAfterText,
        referencePriceUSD: referencePriceAfter,
        lastBuyPriceUSD: lastBuyPriceAfter,
        dcaCount: transition.after.dcaCount,
        peakPortfolioValueUSD: peakText,
        drawdownPct: drawdownText,
        strategyVersion: request.strategy.version,
        strategySnapshot: request.strategy,
        accountingStatus: "RECONCILED",
        accountingIssue: null,
      })
      .where(
        and(
          eq(agentState.id, ACCOUNT_ID),
          eq(agentState.leaseOwner, request.leaseOwner),
        ),
      )
      .returning();
    if (!updatedState) {
      throw new TradeConflictError(
        "Run lease ownership changed during execution",
      );
    }

    await tx
      .update(agentRun)
      .set({
        outcome: "EXECUTED",
        authorizationResult: authorization,
        accountSnapshotBefore: snapshotState(state),
        accountSnapshotAfter: snapshotState(updatedState),
        completedAt: now,
      })
      .where(eq(agentRun.id, request.agentRunId));

      return resultFromRows("executed", insertedTrade, updatedState);
    });
  };
}

export const executePaperTrade = createPaperExecutor(db);
