// Coinbase Exchange candles: each entry is [timestamp, low, high, open, close, volume]
export type CandleRaw = [number, number, number, number, number, number];

const ONE_HOUR_SECONDS = 3600;

/**
 * Fetch ETH/USD 4-hour close prices.
 *
 * Coinbase Exchange's `/products/.../candles` only supports a fixed set of
 * granularities (60, 300, 900, 3600, 21600, 86400) — 4-hour (14400) is *not*
 * one of them. We therefore fetch 1-hour candles and aggregate every 4
 * consecutive bars into a single 4-hour bar. The "close" of each 4-hour bar
 * equals the close of its last 1-hour bar.
 *
 * @param count number of 4-hour bars to return (default 100)
 */
export async function fetchCandles(count: number = 100): Promise<number[]> {
  const oneHourCount = count * 4;
  const res = await fetch(
    `https://api.exchange.coinbase.com/products/ETH-USD/candles?granularity=${ONE_HOUR_SECONDS}`,
  );
  if (!res.ok) {
    throw new Error(`Coinbase candles API error: ${res.status} ${res.statusText}`);
  }

  const body = (await res.json()) as CandleRaw[] | { message?: string };
  if (!Array.isArray(body)) {
    const message =
      body && typeof body === "object" && "message" in body
        ? body.message
        : JSON.stringify(body);
    throw new Error(`Coinbase candles API returned non-array response: ${message}`);
  }

  // Coinbase returns newest-first. Reverse so index 0 = oldest, then take the
  // newest `oneHourCount` bars to aggregate.
  const oldestFirst = body.slice().reverse();
  const recent = oldestFirst.slice(-oneHourCount);

  // Aggregate every 4 consecutive 1h bars into a 4h close (close = last bar's
  // close in the group). Drop any incomplete trailing group.
  const fourHourCloses: number[] = [];
  for (let i = 0; i + 4 <= recent.length; i += 4) {
    const group = recent.slice(i, i + 4);
    fourHourCloses.push(group[group.length - 1][4]);
  }
  return fourHourCloses;
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
