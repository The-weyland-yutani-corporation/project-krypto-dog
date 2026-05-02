// Coinbase Exchange candles: each entry is [timestamp, low, high, open, close, volume]
export type CandleRaw = [number, number, number, number, number, number];

export async function fetchCandles(count: number = 100): Promise<number[]> {
  const res = await fetch(
    `https://api.exchange.coinbase.com/products/ETH-USD/candles?granularity=14400`
  );
  const candles = (await res.json()) as CandleRaw[];
  // Candles arrive newest-first; reverse so index 0 = oldest
  const sorted = candles.slice(0, count).reverse();
  return sorted.map((c) => c[4]); // close prices
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
