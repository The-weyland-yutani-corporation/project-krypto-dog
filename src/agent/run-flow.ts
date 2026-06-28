import { db } from "@/db";
import { agentState, agentJournal } from "@/db/schema";
import { eq, and, desc } from "drizzle-orm";
import {
  JOURNAL_CONTEXT_COUNT,
  validateEnv,
  RSI_PERIOD,
  EMA_SHORT_PERIOD,
  EMA_LONG_PERIOD,
} from "@/lib/config";
import { fetchCandles, calculateRSI, calculateEMA } from "@/lib/indicators";
import { getMarketDataProvider } from "@/lib/market-data-provider";
import { runPreFlightChecks } from "@/guardrails";
import { runAgent } from "@/agent";
import type {
  AgentRunResult,
  PortfolioState,
  MarketData,
  JournalEntry,
} from "@/lib/types";
import { MutexError } from "@/lib/types";
import { safeTrade } from "@/tools/safe-trade";
import {
  getEthPriceTool,
  getRsiTool,
  getEmaTool,
} from "@/tools/market-data";
import { getPortfolioStateTool } from "@/tools/portfolio";
import { writeJournalEntryTool } from "@/tools/journal";
import {
  trackAgentRunStarted,
  trackTradeExecuted,
  trackGuardrailTriggered,
  trackAgentRunCompleted,
  trackLLMTokenUsage,
  type AgentTriggerSource,
} from "@/lib/analytics";

const MAX_RETRIES = 3;

export interface ExecuteAgentRunOptions {
  triggerSource: AgentTriggerSource;
}

export type ExecuteAgentRunOutcome =
  | { kind: "ok"; result: AgentRunResult }
  | { kind: "mutex"; message: string }
  | { kind: "upstream_error"; result: AgentRunResult; httpStatus: number };

async function acquireMutex(): Promise<void> {
  const updated = await db
    .update(agentState)
    .set({ isRunning: true })
    .where(
      and(eq(agentState.id, "singleton"), eq(agentState.isRunning, false)),
    )
    .returning();

  if (updated.length === 0) {
    throw new MutexError();
  }
}

async function releaseMutex(): Promise<void> {
  await db
    .update(agentState)
    .set({ isRunning: false, lastRunAt: new Date() })
    .where(eq(agentState.id, "singleton"));
}

async function fetchEthPrice(): Promise<number> {
  return getMarketDataProvider().getEthSpotPrice();
}

function serializeMarketData(data: MarketData): Record<string, unknown> {
  return {
    ethPrice: data.ethPrice,
    rsi: data.rsi,
    emaShort: data.emaShort,
    emaLong: data.emaLong,
    emaCrossover: data.emaCrossover,
    timestamp: data.timestamp.toISOString(),
  };
}

async function ensureJournalEntry(
  result: AgentRunResult,
  marketData: MarketData,
): Promise<void> {
  if (result.status === "error" || result.journalWritten) {
    return;
  }

  const entryText = [
    "Fallback journal entry: the model did not successfully call write_journal_entry during this run.",
    `Decision: ${result.action ?? result.status}.`,
    result.reasoning ? `Reasoning: ${result.reasoning}` : "Reasoning unavailable.",
  ].join("\n");

  try {
    await db.insert(agentJournal).values({
      entryText,
      marketConditions: serializeMarketData(marketData),
      ...(result.trade?.tradeId ? { tradeExecutionId: result.trade.tradeId } : {}),
    });

    result.journalWritten = true;
    result.journalFallbackWritten = true;
  } catch (error) {
    console.error("[run-flow] Failed to write fallback journal entry:", error);
  }
}

function isAzure429Error(err: unknown): boolean {
  if (err instanceof Error) {
    return err.message.includes("429") || err.message.includes("Rate limit");
  }
  return false;
}

function isCoinbaseError(err: unknown): boolean {
  if (err instanceof Error) {
    return err.message.includes("Coinbase API error");
  }
  return false;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run the trading agent end-to-end (mutex → pre-flight → context → invoke).
 *
 * Returns a discriminated union so callers (cron route or admin route) decide
 * how to map outcomes to HTTP. This keeps `executeAgentRun` free of HTTP
 * concerns and easy to unit test.
 *
 * `triggerSource` is recorded on every analytics event so dashboards can
 * distinguish operator-initiated runs from cron runs.
 */
export async function executeAgentRun(
  opts: ExecuteAgentRunOptions,
): Promise<ExecuteAgentRunOutcome> {
  const { triggerSource } = opts;
  const startTime = Date.now();

  validateEnv();

  try {
    await acquireMutex();
  } catch (err) {
    if (err instanceof MutexError) {
      return { kind: "mutex", message: "Agent is already running" };
    }
    throw err;
  }

  try {
    try {
      trackAgentRunStarted(triggerSource);
    } catch {}

    const preFlightResult = await runPreFlightChecks();
    if (preFlightResult.skip) {
      try {
        trackGuardrailTriggered(
          "pre-flight",
          { reason: preFlightResult.reason },
          triggerSource,
        );
      } catch {}

      const result: AgentRunResult = {
        status: preFlightResult.reason?.includes("locked")
          ? "locked"
          : "skipped",
        guardrailTriggered: preFlightResult.reason,
        durationMs: Date.now() - startTime,
      };

      return { kind: "ok", result };
    }

    const [state] = await db
      .select()
      .from(agentState)
      .where(eq(agentState.id, "singleton"));

    if (!state) {
      throw new Error("AgentState singleton not found");
    }

    const recentJournals = await db
      .select()
      .from(agentJournal)
      .orderBy(desc(agentJournal.createdAt))
      .limit(JOURNAL_CONTEXT_COUNT);

    const ethPrice = await fetchEthPrice();

    const portfolioState: PortfolioState = {
      ethBalance: state.currentPositionETH,
      usdcBalance: state.currentPositionUSDC,
      ethPrice,
      portfolioValueUSD:
        state.currentPositionETH * ethPrice + state.currentPositionUSDC,
      lastTradePrice: state.lastTradePrice,
      isLocked: state.isLocked,
    };

    const tools = [
      safeTrade,
      getEthPriceTool,
      getRsiTool,
      getEmaTool,
      getPortfolioStateTool,
      writeJournalEntryTool,
    ];

    let rsi: number | null = null;
    let emaShort: number | null = null;
    let emaLong: number | null = null;
    let emaCrossover: "bullish" | "bearish" | "neutral" = "neutral";

    try {
      const closes = await fetchCandles();
      rsi = Math.round(calculateRSI(closes, RSI_PERIOD) * 100) / 100;
      emaShort = calculateEMA(closes, EMA_SHORT_PERIOD);
      emaLong = calculateEMA(closes, EMA_LONG_PERIOD);

      if (emaShort > emaLong) emaCrossover = "bullish";
      else if (emaShort < emaLong) emaCrossover = "bearish";
    } catch (err) {
      console.warn("[run-flow] Failed to fetch indicators, using nulls:", err);
    }

    const currentMarketData: MarketData = {
      ethPrice,
      rsi,
      emaShort,
      emaLong,
      emaCrossover,
      timestamp: new Date(),
    };

    const journalEntries: JournalEntry[] = recentJournals.map((j) => ({
      id: j.id,
      entryText: j.entryText,
      marketConditions: j.marketConditions as unknown as MarketData,
      tradeExecutionId: j.tradeExecutionId,
      createdAt: j.createdAt,
    }));

    let agentResult: AgentRunResult | undefined;
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        agentResult = await runAgent(
          tools,
          portfolioState,
          journalEntries,
          currentMarketData,
        );
        break;
      } catch (err) {
        lastError = err;

        if (isCoinbaseError(err)) {
          console.error("[run-flow] Coinbase API error, aborting:", err);
          const errorResult: AgentRunResult = {
            status: "error",
            error: err instanceof Error ? err.message : String(err),
            durationMs: Date.now() - startTime,
          };
          return { kind: "upstream_error", result: errorResult, httpStatus: 502 };
        }

        if (isAzure429Error(err) && attempt < MAX_RETRIES - 1) {
          const backoffMs = Math.pow(2, attempt) * 1000;
          console.warn(
            `[run-flow] LLM 429 error, retrying in ${backoffMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
          );
          await sleep(backoffMs);
          continue;
        }

        break;
      }
    }

    if (!agentResult) {
      console.error("[run-flow] Agent run failed after retries:", lastError);
      const errorResult: AgentRunResult = {
        status: "error",
        error:
          lastError instanceof Error ? lastError.message : String(lastError),
        durationMs: Date.now() - startTime,
      };
      return { kind: "upstream_error", result: errorResult, httpStatus: 500 };
    }

    await ensureJournalEntry(agentResult, currentMarketData);

    const trade = agentResult.trade;
    if (
      trade?.success &&
      trade.direction &&
      trade.asset &&
      trade.amountUSD != null &&
      trade.executionPrice != null &&
      trade.feesUSD != null
    ) {
      try {
        trackTradeExecuted({
          direction: trade.direction,
          asset: trade.asset,
          amountUSD: trade.amountUSD,
          executionPrice: trade.executionPrice,
          feesUSD: trade.feesUSD,
          pnlUSD: trade.pnlUSD ?? undefined,
        });
      } catch {}
    }

    agentResult.durationMs = Date.now() - startTime;
    agentResult.portfolioState = portfolioState;

    try {
      trackAgentRunCompleted(agentResult, triggerSource);
    } catch {}

    if (agentResult.tokenUsage) {
      try {
        trackLLMTokenUsage(agentResult.tokenUsage);
      } catch {}
    }

    return { kind: "ok", result: agentResult };
  } catch (err) {
    console.error("[run-flow] Unexpected error:", err);
    const errorResult: AgentRunResult = {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startTime,
    };
    return { kind: "upstream_error", result: errorResult, httpStatus: 500 };
  } finally {
    try {
      await releaseMutex();
    } catch (releaseErr) {
      console.error("[run-flow] Failed to release mutex:", releaseErr);
    }
  }
}
