export type CandleRaw = [number, number, number, number, number, number];

export interface MarketDataProvider {
  getEthSpotPrice(): Promise<number>;
  getEthClosingPrices(count?: number): Promise<number[]>;
}

const ONE_HOUR_SECONDS = 3600;

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
    const fourHourCloses: number[] = [];
    for (let i = 0; i + 4 <= recent.length; i += 4) {
      const group = recent.slice(i, i + 4);
      fourHourCloses.push(group[group.length - 1][4]);
    }
    return fourHourCloses;
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
  };
}
