// Coinbase Exchange candle tuple: [time, low, high, open, close, volume].
export type CandleRaw = [number, number, number, number, number, number];

/** A single OHLC bar used by volatility indicators (e.g. ATR). */
export interface Candle {
  high: number;
  low: number;
  close: number;
}

export interface MarketDataProvider {
  getEthSpotPrice(): Promise<number>;
  getEthClosingPrices(count?: number): Promise<number[]>;
  getEthCandles(count?: number): Promise<Candle[]>;
}

const ONE_HOUR_SECONDS = 3600;

/**
 * Aggregate oldest-first 1-hour Coinbase candles into 4-hour OHLC bars.
 * High is the max of the group's highs, low the min of the group's lows,
 * and close the last candle's close.
 */
function aggregateFourHourCandles(oneHourOldestFirst: CandleRaw[]): Candle[] {
  const bars: Candle[] = [];
  for (let i = 0; i + 4 <= oneHourOldestFirst.length; i += 4) {
    const group = oneHourOldestFirst.slice(i, i + 4);
    let high = group[0][2];
    let low = group[0][1];
    for (const candle of group) {
      if (candle[2] > high) high = candle[2];
      if (candle[1] < low) low = candle[1];
    }
    bars.push({ high, low, close: group[group.length - 1][4] });
  }
  return bars;
}

async function fetchFourHourCandles(count: number): Promise<Candle[]> {
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

  const oldestFirst = body.slice().reverse();
  const recent = oldestFirst.slice(-oneHourCount);
  return aggregateFourHourCandles(recent);
}

export const coinbaseMarketDataProvider: MarketDataProvider = {
  async getEthSpotPrice(): Promise<number> {
    const res = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot");
    if (!res.ok) {
      throw new Error(`Coinbase API error: ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as { data: { amount: string } };
    return parseFloat(json.data.amount);
  },

  async getEthClosingPrices(count: number = 100): Promise<number[]> {
    const candles = await fetchFourHourCandles(count);
    return candles.map((c) => c.close);
  },

  async getEthCandles(count: number = 100): Promise<Candle[]> {
    return fetchFourHourCandles(count);
  },
};

let activeProvider: MarketDataProvider = coinbaseMarketDataProvider;

export function getMarketDataProvider(): MarketDataProvider {
  return activeProvider;
}

export function setMarketDataProvider(provider: MarketDataProvider): () => void {
  const previous = activeProvider;
  activeProvider = provider;
  return () => {
    activeProvider = previous;
  };
}

export function createFixtureMarketDataProvider(
  prices: number[],
): MarketDataProvider {
  if (prices.length === 0) {
    throw new Error("Fixture market data requires at least one price");
  }

  return {
    async getEthSpotPrice(): Promise<number> {
      return prices[prices.length - 1];
    },
    async getEthClosingPrices(count?: number): Promise<number[]> {
      return count === undefined ? prices : prices.slice(-count);
    },
    async getEthCandles(count?: number): Promise<Candle[]> {
      // Synthesize flat OHLC bars from closes: high = low = close. Fixtures
      // that need real intrabar range should use createFixtureCandleProvider.
      const source = count === undefined ? prices : prices.slice(-count);
      return source.map((close) => ({ high: close, low: close, close }));
    },
  };
}

export function createFixtureCandleProvider(
  candles: Candle[],
): MarketDataProvider {
  if (candles.length === 0) {
    throw new Error("Fixture candle data requires at least one candle");
  }

  return {
    async getEthSpotPrice(): Promise<number> {
      return candles[candles.length - 1].close;
    },
    async getEthClosingPrices(count?: number): Promise<number[]> {
      const source = count === undefined ? candles : candles.slice(-count);
      return source.map((c) => c.close);
    },
    async getEthCandles(count?: number): Promise<Candle[]> {
      return count === undefined ? candles : candles.slice(-count);
    },
  };
}
