import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod/v3";
import {
  RSI_PERIOD,
  EMA_SHORT_PERIOD,
  EMA_LONG_PERIOD,
  ATR_PERIOD,
} from "@/lib/config";
import {
  fetchCandles,
  fetchCandleBars,
  calculateRSI,
  calculateEMA,
  calculateATR,
} from "@/lib/indicators";
import { getMarketDataProvider } from "@/lib/market-data-provider";

async function fetchEthSpotPrice(): Promise<number> {
  return getMarketDataProvider().getEthSpotPrice();
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

export const getAtrTool = new DynamicStructuredTool({
  name: "get_atr",
  description:
    "Calculates the ATR(14) volatility for ETH/USD using 4-hour candles from Coinbase. Higher ATR means wider per-bar range (trending); lower ATR means a tighter range (choppy).",
  schema: z.object({}),
  func: async () => {
    try {
      const bars = await fetchCandleBars();
      const highs = bars.map((b) => b.high);
      const lows = bars.map((b) => b.low);
      const closes = bars.map((b) => b.close);
      const atr = calculateATR(highs, lows, closes, ATR_PERIOD);
      const rounded = Math.round(atr * 100) / 100;

      const lastClose = closes[closes.length - 1];
      const atrPct = lastClose > 0 ? (atr / lastClose) * 100 : 0;

      let interpretation: string;
      if (atr === 0) {
        interpretation = "Insufficient data — treat as neutral.";
      } else if (atrPct < 2) {
        interpretation =
          "Low volatility (tight range) — apply higher skepticism to trigger signals; fee drag may outweigh gains.";
      } else if (atrPct > 5) {
        interpretation =
          "High volatility (wide range) — swings are more meaningful, but manage risk carefully.";
      } else {
        interpretation = "Moderate volatility — no strong volatility signal.";
      }

      return `ATR(${ATR_PERIOD}): $${rounded} (${atrPct.toFixed(2)}% of price). ${interpretation}`;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return `Error calculating ATR: ${msg}`;
    }
  },
});
