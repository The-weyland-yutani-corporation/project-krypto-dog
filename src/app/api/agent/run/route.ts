import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { agentState, agentJournal } from "@/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { JOURNAL_CONTEXT_COUNT, validateEnv, RSI_PERIOD, EMA_SHORT_PERIOD, EMA_LONG_PERIOD } from "@/lib/config";
import { fetchCandles, calculateRSI, calculateEMA } from "@/lib/indicators";
import { runPreFlightChecks } from "@/guardrails";
import { runAgent } from "@/agent";
import type { AgentRunResult, PortfolioState, MarketData, JournalEntry } from "@/lib/types";
import { MutexError } from "@/lib/types";
import { safeTrade } from "@/tools/safe-trade";
import { getEthPriceTool, getRsiTool, getEmaTool } from "@/tools/market-data";
import { getPortfolioStateTool } from "@/tools/portfolio";
import { writeJournalEntryTool } from "@/tools/journal";
import {
  trackAgentRunStarted,
  trackTradeExecuted,
  trackGuardrailTriggered,
  trackAgentRunCompleted,
  trackLLMTokenUsage,
} from "@/lib/analytics";

const MAX_RETRIES = 3;

async function acquireMutex(): Promise<void> {
  const updated = await db
    .update(agentState)
    .set({ isRunning: true })
    .where(and(eq(agentState.id, "singleton"), eq(agentState.isRunning, false)))
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
  const res = await fetch(
    "https://api.coinbase.com/v2/prices/ETH-USD/spot"
  );
  if (!res.ok) {
    throw new Error(`Coinbase API error: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as { data: { amount: string } };
  return parseFloat(json.data.amount);
}

function isAzure429Error(err: unknown): boolean {
  if (err instanceof Error) {
    return (
      err.message.includes("429") || err.message.includes("Rate limit")
    );
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

export async function POST(request: NextRequest) {
  const startTime = Date.now();

  // 1. Auth
  const cronSecret = request.headers.get("x-cron-secret");
  if (cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Validate environment variables
  validateEnv();

  // 2. Mutex
  try {
    await acquireMutex();
  } catch (err) {
    if (err instanceof MutexError) {
      return NextResponse.json(
        { error: "Agent is already running" },
        { status: 409 }
      );
    }
    throw err;
  }

  try {
    // Analytics — non-blocking
    try {
      trackAgentRunStarted();
    } catch {}

    // 3. Pre-flight checks
    const preFlightResult = await runPreFlightChecks();
    if (preFlightResult.skip) {
      try {
        trackGuardrailTriggered("pre-flight", {
          reason: preFlightResult.reason,
        });
      } catch {}

      const result: AgentRunResult = {
        status: preFlightResult.reason?.includes("locked")
          ? "locked"
          : "skipped",
        guardrailTriggered: preFlightResult.reason,
        durationMs: Date.now() - startTime,
      };

      return NextResponse.json(result, { status: 200 });
    }

    // 4. Prepare context
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

    // Build MarketData with real indicator values
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
      console.warn("[agent/run] Failed to fetch indicators, using nulls:", err);
    }

    const currentMarketData: MarketData = {
      ethPrice,
      rsi,
      emaShort,
      emaLong,
      emaCrossover,
      timestamp: new Date(),
    };

    // Map journal records to JournalEntry type
    const journalEntries: JournalEntry[] = recentJournals.map((j) => ({
      id: j.id,
      entryText: j.entryText,
      marketConditions: j.marketConditions as unknown as MarketData,
      tradeExecutionId: j.tradeExecutionId,
      createdAt: j.createdAt,
    }));

    // 5. Run agent with retry for Azure 429
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
          console.error("[agent/run] Coinbase API error, aborting:", err);
          const errorResult: AgentRunResult = {
            status: "error",
            error: err instanceof Error ? err.message : String(err),
            durationMs: Date.now() - startTime,
          };
          return NextResponse.json(errorResult, { status: 502 });
        }

        if (isAzure429Error(err) && attempt < MAX_RETRIES - 1) {
          const backoffMs = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
          console.warn(
            `[agent/run] Azure 429 error, retrying in ${backoffMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`
          );
          await sleep(backoffMs);
          continue;
        }

        // Non-retryable error
        break;
      }
    }

    if (!agentResult) {
      console.error("[agent/run] Agent run failed after retries:", lastError);
      const errorResult: AgentRunResult = {
        status: "error",
        error:
          lastError instanceof Error ? lastError.message : String(lastError),
        durationMs: Date.now() - startTime,
      };
      return NextResponse.json(errorResult, { status: 500 });
    }

    // Track trade if one happened
    if (agentResult.trade?.success) {
      try {
        trackTradeExecuted(agentResult.trade as unknown as Parameters<typeof trackTradeExecuted>[0]);
      } catch {}
    }

    agentResult.durationMs = Date.now() - startTime;
    agentResult.portfolioState = portfolioState;

    // Track run completion
    try {
      trackAgentRunCompleted(agentResult);
    } catch {}

    // Track LLM token usage if available
    if (agentResult.tokenUsage) {
      try {
        trackLLMTokenUsage(agentResult.tokenUsage);
      } catch {}
    }

    return NextResponse.json(agentResult, { status: 200 });
  } catch (err) {
    console.error("[agent/run] Unexpected error:", err);
    const errorResult: AgentRunResult = {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startTime,
    };
    return NextResponse.json(errorResult, { status: 500 });
  } finally {
    // 7. Always release mutex
    try {
      await releaseMutex();
    } catch (releaseErr) {
      console.error("[agent/run] Failed to release mutex:", releaseErr);
    }
  }
}
