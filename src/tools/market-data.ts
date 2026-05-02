import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod/v3";
import { RSI_PERIOD, EMA_SHORT_PERIOD, EMA_LONG_PERIOD } from "@/lib/config";
import { fetchCandles, calculateRSI, calculateEMA } from "@/lib/indicators";

async function fetchEthSpotPrice(): Promise<number> {
  const res = await fetch(
    "https://api.coinbase.com/v2/prices/ETH-USD/spot"
  );
  const json = (await res.json()) as { data: { amount: string } };
  return parseFloat(json.data.amount);
}

export const getEthPriceTool = new DynamicStructuredTool({
  name: "get_eth_price",
  description: "Fetches the current ETH/USD spot price from Coinbase.",
  schema: z.object({}),
  func: async () => {
    try {
      const price = await fetchEthSpotPrice();
      return `Current ETH price: $${price.toFixed(2)}`;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return `Error fetching ETH price: ${msg}`;
    }
  },
});

export const getRsiTool = new DynamicStructuredTool({
  name: "get_rsi",
  description:
    "Calculates the RSI(14) for ETH/USD using 4-hour candles from Coinbase.",
  schema: z.object({}),
  func: async () => {
    try {
      const closes = await fetchCandles();
      const rsi = calculateRSI(closes, RSI_PERIOD);
      const rounded = Math.round(rsi * 100) / 100;

      let interpretation: string;
      if (rsi > 70) interpretation = "Overbought — consider selling or waiting.";
      else if (rsi < 30)
        interpretation = "Oversold — potential buying opportunity.";
      else interpretation = "Neutral — no strong directional signal.";

      return `RSI(${RSI_PERIOD}): ${rounded}. ${interpretation}`;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return `Error calculating RSI: ${msg}`;
    }
  },
});

export const getEmaTool = new DynamicStructuredTool({
  name: "get_ema",
  description:
    "Calculates EMA(12) and EMA(26) for ETH/USD using 4-hour candles and reports crossover status.",
  schema: z.object({}),
  func: async () => {
    try {
      const closes = await fetchCandles();
      const emaShort = calculateEMA(closes, EMA_SHORT_PERIOD);
      const emaLong = calculateEMA(closes, EMA_LONG_PERIOD);

      let crossover: string;
      if (emaShort > emaLong) crossover = "bullish";
      else if (emaShort < emaLong) crossover = "bearish";
      else crossover = "neutral";

      return `EMA(${EMA_SHORT_PERIOD}): $${emaShort.toFixed(2)}, EMA(${EMA_LONG_PERIOD}): $${emaLong.toFixed(2)}. Crossover: ${crossover}`;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return `Error calculating EMA: ${msg}`;
    }
  },
});
