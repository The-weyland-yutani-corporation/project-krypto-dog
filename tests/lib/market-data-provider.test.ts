import {
  createCoinbaseMarketDataProvider,
  createFixtureMarketDataProvider,
  getMarketDataProvider,
} from "@/lib/market-data-provider";

const NOW = new Date("2026-07-14T12:34:00.000Z");
const ONE_HOUR_SECONDS = 60 * 60;

function inputUrl(input: Parameters<typeof fetch>[0]): URL {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return input;
  return new URL(input.url);
}

function hourlyRow(timestamp: number): [
  number,
  number,
  number,
  number,
  number,
  number,
] {
  const close = 1_000 + timestamp / ONE_HOUR_SECONDS;
  return [
    timestamp,
    close - 2,
    close + 2,
    close - 1,
    close,
    1,
  ];
}

function candleResponseForUrl(url: URL, skipTimestamp?: number): Response {
  const start = Math.floor(
    new Date(url.searchParams.get("start") ?? "").getTime() / 1000,
  );
  const end = Math.floor(
    new Date(url.searchParams.get("end") ?? "").getTime() / 1000,
  );
  const rows = [];
  for (let timestamp = start; timestamp <= end; timestamp += ONE_HOUR_SECONDS) {
    if (timestamp !== skipTimestamp) rows.push(hourlyRow(timestamp));
  }
  return Response.json(rows.reverse());
}

describe("coinbase market data provider", () => {
  it("fetches and validates the ETH spot price", async () => {
    const fetchMock = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(
        Response.json({ data: { amount: "2345.67" } }),
      );
    const provider = createCoinbaseMarketDataProvider({
      fetchImpl: fetchMock,
      maxAttempts: 1,
    });

    await expect(provider.getEthSpotPrice()).resolves.toBe(2345.67);
  });

  describe("harness market data provider selection", () => {
    it("uses deterministic fixture data in mock mode without calling fetch", async () => {
      const fetchSpy = jest.spyOn(globalThis, "fetch");
      const provider = getMarketDataProvider({
        NODE_ENV: "development",
        AGENT_HARNESS_MODE: "mock",
        AGENT_HARNESS_SCENARIO: "dip",
      });

      await expect(provider.getEthSpotPrice()).resolves.toBe(1900);
      await expect(provider.getEthClosingPrices(100)).resolves.toHaveLength(100);
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it("rejects mock provider selection in production", () => {
      expect(() =>
        getMarketDataProvider({
          NODE_ENV: "production",
          AGENT_HARNESS_MODE: "mock",
        }),
      ).toThrow(/forbidden in production/);
    });
  });

  it("rejects a non-finite spot price", async () => {
    const provider = createCoinbaseMarketDataProvider({
      fetchImpl: jest
        .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
        .mockResolvedValue(Response.json({ data: { amount: "NaN" } })),
      maxAttempts: 1,
    });

    await expect(provider.getEthSpotPrice()).rejects.toMatchObject({
      code: "invalid-response",
    });
  });

  it("paginates 100 four-hour candles into Coinbase-safe requests", async () => {
    const fetchMock = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockImplementation(async (input) => {
        const url = inputUrl(input);
        return candleResponseForUrl(url);
      });
    const provider = createCoinbaseMarketDataProvider({
      fetchImpl: fetchMock,
      now: () => NOW,
      maxAttempts: 1,
    });

    const candles = await provider.getEthFourHourCandles(100);

    expect(candles).toHaveLength(100);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(candles[0].startTime.toISOString()).toBe(
      "2026-06-27T20:00:00.000Z",
    );
    expect(candles.at(-1)?.endTime.toISOString()).toBe(
      "2026-07-14T12:00:00.000Z",
    );
    expect(candles[0].volume).toBe(4);

    for (const call of fetchMock.mock.calls) {
      const url = inputUrl(call[0]);
      const start = new Date(url.searchParams.get("start") ?? "").getTime();
      const end = new Date(url.searchParams.get("end") ?? "").getTime();
      expect((end - start) / (ONE_HOUR_SECONDS * 1000)).toBeLessThanOrEqual(
        300,
      );
    }
  });

  it("returns close prices from complete UTC-aligned buckets", async () => {
    const fetchMock = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockImplementation(async (input) =>
        candleResponseForUrl(inputUrl(input)),
      );
    const provider = createCoinbaseMarketDataProvider({
      fetchImpl: fetchMock,
      now: () => NOW,
      maxAttempts: 1,
    });

    const closes = await provider.getEthClosingPrices(2);

    expect(closes).toHaveLength(2);
    expect(closes[1]).toBeGreaterThan(closes[0]);
  });

  it("rejects stale data when the latest closed hour is missing", async () => {
    const latestClosedEnd = Date.parse("2026-07-14T12:00:00.000Z") / 1000;
    const missingTimestamp = latestClosedEnd - ONE_HOUR_SECONDS;
    const fetchMock = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockImplementation(async (input) =>
        candleResponseForUrl(inputUrl(input), missingTimestamp),
      );
    const provider = createCoinbaseMarketDataProvider({
      fetchImpl: fetchMock,
      now: () => NOW,
      maxAttempts: 1,
    });

    await expect(provider.getEthFourHourCandles(2)).rejects.toMatchObject({
      code: "stale-data",
    });
  });

  it("rejects an internal candle gap instead of aggregating across it", async () => {
    const windowStart = Date.parse("2026-07-14T04:00:00.000Z") / 1000;
    const missingTimestamp = windowStart + ONE_HOUR_SECONDS;
    const fetchMock = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockImplementation(async (input) =>
        candleResponseForUrl(inputUrl(input), missingTimestamp),
      );
    const provider = createCoinbaseMarketDataProvider({
      fetchImpl: fetchMock,
      now: () => NOW,
      maxAttempts: 1,
    });

    await expect(provider.getEthFourHourCandles(2)).rejects.toMatchObject({
      code: "insufficient-data",
    });
  });

  it("rejects malformed candle values", async () => {
    const fetchMock = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(Response.json([[1, 2, 3]]));
    const provider = createCoinbaseMarketDataProvider({
      fetchImpl: fetchMock,
      now: () => NOW,
      maxAttempts: 1,
    });

    await expect(provider.getEthFourHourCandles(1)).rejects.toMatchObject({
      code: "invalid-response",
    });
  });

  it("retries transient Coinbase failures", async () => {
    const fetchMock = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValueOnce(
        new Response("unavailable", {
          status: 503,
          statusText: "Service Unavailable",
        }),
      )
      .mockImplementation(async (input) => candleResponseForUrl(inputUrl(input)));
    const provider = createCoinbaseMarketDataProvider({
      fetchImpl: fetchMock,
      now: () => NOW,
      maxAttempts: 2,
      retryBaseMs: 0,
    });

    await expect(provider.getEthFourHourCandles(1)).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("aborts a request that exceeds its timeout", async () => {
    const fetchMock = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockImplementation(
        async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            });
          }),
      );
    const provider = createCoinbaseMarketDataProvider({
      fetchImpl: fetchMock,
      timeoutMs: 1,
      maxAttempts: 1,
    });

    await expect(provider.getEthSpotPrice()).rejects.toMatchObject({
      code: "timeout",
      retryable: true,
    });
  });
});

describe("fixture market data provider", () => {
  it("provides deterministic spot, candle, and close data", async () => {
    const provider = createFixtureMarketDataProvider([100, 101, 102]);

    await expect(provider.getEthSpotPrice()).resolves.toBe(102);
    await expect(provider.getEthClosingPrices(2)).resolves.toEqual([101, 102]);
    await expect(provider.getEthFourHourCandles(2)).resolves.toHaveLength(2);
  });

  it("rejects empty or invalid fixture prices", () => {
    expect(() => createFixtureMarketDataProvider([])).toThrow();
    expect(() => createFixtureMarketDataProvider([100, Number.NaN])).toThrow();
  });
});
