import { getMarketDataProvider, type Candle } from "./market-data-provider";

/**
 * Fetch ETH/USD 4-hour close prices.
 *
 * Production data comes from the active market-data provider. The default
 * provider fetches Coinbase 1-hour candles and aggregates them into 4-hour
 * closes; tests/backtests can swap in fixture data.
 *
 * @param count number of 4-hour bars to return (default 100)
 */
export async function fetchCandles(count: number = 100): Promise<number[]> {
  return getMarketDataProvider().getEthClosingPrices(count);
}

/**
 * Fetch ETH/USD 4-hour OHLC bars (high/low/close) for volatility indicators
 * such as ATR. Mirrors {@link fetchCandles} but preserves per-bar range.
 *
 * @param count number of 4-hour bars to return (default 100)
 */
export async function fetchCandleBars(count: number = 100): Promise<Candle[]> {
  return getMarketDataProvider().getEthCandles(count);
}

export function calculateRSI(closes: number[], period: number): number {
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

export function calculateEMA(closes: number[], period: number): number {
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

/**
 * Average True Range (Wilder 1978) — a per-bar volatility measure.
 *
 * True Range for bar i (i >= 1) is
 *   max(high - low, |high - prevClose|, |low - prevClose|).
 * ATR is the Wilder-smoothed mean of TR over `period`: seeded with the simple
 * average of the first `period` true ranges, then smoothed as
 *   ATR_i = (ATR_{i-1} * (period - 1) + TR_i) / period.
 *
 * Requires `period + 1` bars (period true ranges). With insufficient data,
 * returns 0 as a neutral fallback, mirroring the other indicators' behaviour.
 * Arrays are expected to be aligned and equal length; if they are not, the
 * shortest length is used.
 */
export function calculateATR(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number,
): number {
  const length = Math.min(highs.length, lows.length, closes.length);
  if (length < period + 1 || period <= 0) {
    return 0; // not enough data, return neutral
  }

  const trueRanges: number[] = [];
  for (let i = 1; i < length; i++) {
    const prevClose = closes[i - 1];
    const highLow = highs[i] - lows[i];
    const highPrevClose = Math.abs(highs[i] - prevClose);
    const lowPrevClose = Math.abs(lows[i] - prevClose);
    trueRanges.push(Math.max(highLow, highPrevClose, lowPrevClose));
  }

  // Seed ATR with the simple average of the first `period` true ranges.
  let atr =
    trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;

  // Wilder smoothing for the remaining true ranges.
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }

  return atr;
}
