import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod/v3";
import { RSI_PERIOD, EMA_SHORT_PERIOD, EMA_LONG_PERIOD } from "@/lib/config";

async function fetchEthSpotPrice(): Promise<number> {
  const res = await fetch(
    "https://api.coinbase.com/v2/prices/ETH-USD/spot"
  );
  const json = (await res.json()) as { data: { amount: string } };
  return parseFloat(json.data.amount);
}

// Coinbase Exchange candles: each entry is [timestamp, low, high, open, close, volume]
type CandleRaw = [number, number, number, number, number, number];

async function fetchCandles(count: number = 100): Promise<number[]> {
  const res = await fetch(
    `https://api.exchange.coinbase.com/products/ETH-USD/candles?granularity=14400`
  );
  const candles = (await res.json()) as CandleRaw[];
  // Candles arrive newest-first; reverse so index 0 = oldest
  const sorted = candles.slice(0, count).reverse();
  return sorted.map((c) => c[4]); // close prices
}

function calculateRSI(closes: number[], period: number): number {
  if (closes.length < period + 1) {
    return 50; // not enough data, return neutral
  }

  let gains = 0;
  let losses = 0;

  // Initial average gain/loss over the first `period` changes
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  // Smoothed moving average for remaining data
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calculateEMA(closes: number[], period: number): number {
  if (closes.length === 0) return 0;
  if (closes.length < period) {
    // Not enough data; use SMA of available data
    return closes.reduce((a, b) => a + b, 0) / closes.length;
  }

  const k = 2 / (period + 1);
  // Seed with SMA of first `period` values
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }

  return ema;
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
