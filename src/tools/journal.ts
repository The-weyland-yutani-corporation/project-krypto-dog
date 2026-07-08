import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod/v3";
import { db } from "@/db";
import { agentJournal } from "@/db/schema";
import {
  fetchCandles,
  fetchCandleBars,
  calculateRSI,
  calculateEMA,
  calculateATR,
} from "@/lib/indicators";
import {
  RSI_PERIOD,
  EMA_SHORT_PERIOD,
  EMA_LONG_PERIOD,
  ATR_PERIOD,
} from "@/lib/config";
import { getMarketDataProvider } from "@/lib/market-data-provider";

async function fetchMarketSnapshot() {
  const ethPrice = await getMarketDataProvider().getEthSpotPrice();

  let rsi: number | null = null;
  let emaShort: number | null = null;
  let emaLong: number | null = null;
  let emaCrossover: "bullish" | "bearish" | "neutral" = "neutral";
  let atr: number | null = null;

  try {
    const closes = await fetchCandles();
    rsi = Math.round(calculateRSI(closes, RSI_PERIOD) * 100) / 100;
    emaShort = calculateEMA(closes, EMA_SHORT_PERIOD);
    emaLong = calculateEMA(closes, EMA_LONG_PERIOD);

    if (emaShort > emaLong) emaCrossover = "bullish";
    else if (emaShort < emaLong) emaCrossover = "bearish";

    const bars = await fetchCandleBars();
    atr =
      Math.round(
        calculateATR(
          bars.map((b) => b.high),
          bars.map((b) => b.low),
          bars.map((b) => b.close),
          ATR_PERIOD,
        ) * 100,
      ) / 100;
  } catch (err) {
    console.warn("[journal] Failed to fetch indicators:", err);
  }

  return {
    ethPrice,
    rsi,
    emaShort,
    emaLong,
    emaCrossover,
    atr,
    timestamp: new Date().toISOString(),
  };
}

export const writeJournalEntryTool = new DynamicStructuredTool({
  name: "write_journal_entry",
  description:
    "Write a journal entry recording the agent's reasoning, observations, and market conditions.",
  schema: z.object({
    entryText: z
      .string()
      .describe("The agent's reasoning and observations to record"),
    tradeExecutionId: z
      .string()
      .optional()
      .describe("Optional trade execution ID to link this entry to"),
  }),
  func: async ({ entryText, tradeExecutionId }) => {
    try {
      const market = await fetchMarketSnapshot();

      const [entry] = await db
        .insert(agentJournal)
        .values({
          entryText,
          marketConditions: market,
          ...(tradeExecutionId ? { tradeExecutionId } : {}),
        })
        .returning();

      return `Journal entry recorded (ID: ${entry.id}). ETH price at time of entry: $${market.ethPrice.toFixed(2)}.`;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return `Error writing journal entry: ${msg}`;
    }
  },
});
