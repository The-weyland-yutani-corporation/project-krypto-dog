import {
  COINBASE_PROVIDER_BUDGET_MS,
  ProviderBudgetError,
  parseRetryAfterMs,
  type ExecutionDeadline,
} from "@/lib/execution-envelope";
import {
  consumeProviderRequestBudget,
  type ProviderBudgetStore,
} from "@/lib/provider-budgets";

export type CandleRaw = [number, number, number, number, number, number];

export interface FourHourCandle {
  startTime: Date;
  endTime: Date;
  low: number;
  high: number;
  open: number;
  close: number;
  volume: number;
}

export type MarketDataErrorCode =
  | "http"
  | "network"
  | "timeout"
  | "invalid-response"
  | "insufficient-data"
  | "stale-data";

export class MarketDataError extends Error {
  readonly code: MarketDataErrorCode;
  readonly retryable: boolean;

  constructor(
    message: string,
    code: MarketDataErrorCode,
    retryable = false,
    options?: ErrorOptions,
    readonly retryAfterMs?: number,
  ) {
    super(message, options);
    this.name = "MarketDataError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface MarketDataProvider {
  getEthSpotPrice(options?: MarketDataRequestOptions): Promise<number>;
  getEthFourHourCandles(
    count?: number,
    options?: MarketDataRequestOptions,
  ): Promise<FourHourCandle[]>;
  getEthClosingPrices(
    count?: number,
    options?: MarketDataRequestOptions,
  ): Promise<number[]>;
}

export interface MarketDataRequestOptions {
  deadline?: ExecutionDeadline;
  providerDeadlineAt?: Date;
  budgetStore?: ProviderBudgetStore;
}

interface CoinbaseMarketDataProviderOptions {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  delayImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

interface HourlyCandle {
  timestampSeconds: number;
  low: number;
  high: number;
  open: number;
  close: number;
  volume: number;
}

const ONE_HOUR_SECONDS = 60 * 60;
const FOUR_HOUR_SECONDS = 4 * ONE_HOUR_SECONDS;
const MAX_CANDLES_PER_REQUEST = 300;
const MAX_FOUR_HOUR_CANDLES = 500;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 250;

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validateCount(count: number): void {
  if (
    !Number.isInteger(count) ||
    count <= 0 ||
    count > MAX_FOUR_HOUR_CANDLES
  ) {
    throw new MarketDataError(
      `Candle count must be an integer between 1 and ${MAX_FOUR_HOUR_CANDLES}`,
      "invalid-response",
    );
  }
}

function normalizeRequestError(
  error: unknown,
  label: string,
  timedOut: boolean,
): MarketDataError {
  if (error instanceof MarketDataError) return error;

  if (
    timedOut ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    return new MarketDataError(
      `${label} timed out`,
      "timeout",
      true,
      error instanceof Error ? { cause: error } : undefined,
    );
  }

  return new MarketDataError(
    `${label} request failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
    "network",
    true,
    error instanceof Error ? { cause: error } : undefined,
  );
}

function parseHourlyCandle(row: unknown, index: number): HourlyCandle {
  if (!Array.isArray(row) || row.length < 6) {
    throw new MarketDataError(
      `Coinbase candle at index ${index} is not a six-value row`,
      "invalid-response",
    );
  }

  const [timestamp, low, high, open, close, volume] = row.map(Number);
  const priceValues = [low, high, open, close];
  if (
    !Number.isInteger(timestamp) ||
    timestamp <= 0 ||
    timestamp % ONE_HOUR_SECONDS !== 0 ||
    priceValues.some((value) => !Number.isFinite(value) || value <= 0) ||
    !Number.isFinite(volume) ||
    volume < 0 ||
    low > high ||
    open < low ||
    open > high ||
    close < low ||
    close > high
  ) {
    throw new MarketDataError(
      `Coinbase candle at index ${index} contains invalid values`,
      "invalid-response",
    );
  }

  return {
    timestampSeconds: timestamp,
    low,
    high,
    open,
    close,
    volume,
  };
}

function aggregateFourHourCandles(
  hourlyCandles: HourlyCandle[],
): FourHourCandle[] {
  if (hourlyCandles.length % 4 !== 0) {
    throw new MarketDataError(
      "Hourly candle count cannot form complete four-hour buckets",
      "insufficient-data",
    );
  }

  const result: FourHourCandle[] = [];
  for (let index = 0; index < hourlyCandles.length; index += 4) {
    const group = hourlyCandles.slice(index, index + 4);
    const expectedBucketStart =
      Math.floor(group[0].timestampSeconds / FOUR_HOUR_SECONDS) *
      FOUR_HOUR_SECONDS;

    for (let offset = 0; offset < group.length; offset++) {
      const expectedTimestamp =
        expectedBucketStart + offset * ONE_HOUR_SECONDS;
      if (group[offset].timestampSeconds !== expectedTimestamp) {
        throw new MarketDataError(
          `Incomplete four-hour candle beginning at ${new Date(
            expectedBucketStart * 1000,
          ).toISOString()}`,
          "insufficient-data",
        );
      }
    }

    result.push({
      startTime: new Date(expectedBucketStart * 1000),
      endTime: new Date((expectedBucketStart + FOUR_HOUR_SECONDS) * 1000),
      low: Math.min(...group.map((candle) => candle.low)),
      high: Math.max(...group.map((candle) => candle.high)),
      open: group[0].open,
      close: group[group.length - 1].close,
      volume: group.reduce((sum, candle) => sum + candle.volume, 0),
    });
  }

  return result;
}

export function createCoinbaseMarketDataProvider(
  options: CoinbaseMarketDataProviderOptions = {},
): MarketDataProvider {
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;

  if (timeoutMs <= 0 || maxAttempts <= 0 || retryBaseMs < 0) {
    throw new Error("Invalid Coinbase market-data provider options");
  }

  async function requestJson(
    url: string,
    label: string,
    requestOptions: MarketDataRequestOptions,
  ): Promise<unknown> {
    let lastError: MarketDataError | undefined;
    const providerDeadlineAt =
      requestOptions.providerDeadlineAt ??
      new Date((requestOptions.deadline?.now().getTime() ?? Date.now()) +
        COINBASE_PROVIDER_BUDGET_MS);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      requestOptions.deadline?.assertActive("Coinbase request");
      const providerRemainingMs =
        providerDeadlineAt.getTime() -
        (requestOptions.deadline?.now().getTime() ?? Date.now());
      if (providerRemainingMs <= 0) {
        throw new ProviderBudgetError("coinbase", "time");
      }
      if (requestOptions.deadline) {
        await consumeProviderRequestBudget("coinbase", {
          deadline: requestOptions.deadline,
          store: requestOptions.budgetStore,
        });
      }
      const controller = new AbortController();
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, Math.min(timeoutMs, providerRemainingMs));
      const signal = requestOptions.deadline
        ? AbortSignal.any([
            controller.signal,
            requestOptions.deadline.signalFor(
              "Coinbase request",
              providerRemainingMs,
            ),
          ])
        : controller.signal;

      try {
        const fetchImpl = options.fetchImpl ?? globalThis.fetch;
        const response = await fetchImpl(url, { signal });

        if (!response.ok) {
          const retryable = response.status === 429 || response.status >= 500;
          throw new MarketDataError(
            `${label} returned ${response.status} ${response.statusText}`,
            "http",
            retryable,
            undefined,
            parseRetryAfterMs(response.headers.get("retry-after")),
          );
        }

        try {
          return await response.json();
        } catch (error) {
          throw new MarketDataError(
            `${label} returned invalid JSON`,
            "invalid-response",
            false,
            error instanceof Error ? { cause: error } : undefined,
          );
        }
      } catch (error) {
        requestOptions.deadline?.assertActive("Coinbase request");
        const normalized = normalizeRequestError(error, label, timedOut);
        lastError = normalized;
        if (!normalized.retryable || attempt === maxAttempts - 1) {
          throw normalized;
        }
      } finally {
        clearTimeout(timeout);
      }

      const retryMs =
        lastError?.retryAfterMs ?? retryBaseMs * 2 ** attempt;
      const remaining =
        providerDeadlineAt.getTime() -
        (requestOptions.deadline?.now().getTime() ?? Date.now());
      if (retryMs >= remaining) {
        throw new ProviderBudgetError("coinbase", "time");
      }
      if (requestOptions.deadline) {
        await requestOptions.deadline.delay(retryMs, "Coinbase retry");
      } else {
        await (options.delayImpl ?? delay)(retryMs);
      }
    }

    throw (
      lastError ??
      new MarketDataError(`${label} failed`, "network", true)
    );
  }

  async function getEthSpotPrice(
    requestOptions: MarketDataRequestOptions = {},
  ): Promise<number> {
    const payload = (await requestJson(
      "https://api.coinbase.com/v2/prices/ETH-USD/spot",
      "Coinbase spot price",
      requestOptions,
    )) as { data?: { amount?: unknown } };
    const price = Number(payload?.data?.amount);

    if (!Number.isFinite(price) || price <= 0) {
      throw new MarketDataError(
        "Coinbase spot price response did not contain a finite positive amount",
        "invalid-response",
      );
    }

    return price;
  }

  async function getEthFourHourCandles(
    count: number = 100,
    requestOptions: MarketDataRequestOptions = {},
  ): Promise<FourHourCandle[]> {
    validateCount(count);

    const currentTime = now();
    if (!Number.isFinite(currentTime.getTime())) {
      throw new MarketDataError(
        "Current time is invalid",
        "invalid-response",
      );
    }

    const nowSeconds = Math.floor(currentTime.getTime() / 1000);
    const latestClosedEndSeconds =
      Math.floor(nowSeconds / FOUR_HOUR_SECONDS) * FOUR_HOUR_SECONDS;
    const windowStartSeconds =
      latestClosedEndSeconds - count * FOUR_HOUR_SECONDS;
    const rowsByTimestamp = new Map<number, HourlyCandle>();

    for (
      let cursor = windowStartSeconds;
      cursor < latestClosedEndSeconds;

    ) {
      const chunkEnd = Math.min(
        cursor + MAX_CANDLES_PER_REQUEST * ONE_HOUR_SECONDS,
        latestClosedEndSeconds,
      );
      const requestEnd = chunkEnd - ONE_HOUR_SECONDS;
      const url = new URL(
        "https://api.exchange.coinbase.com/products/ETH-USD/candles",
      );
      url.searchParams.set("granularity", String(ONE_HOUR_SECONDS));
      url.searchParams.set("start", new Date(cursor * 1000).toISOString());
      url.searchParams.set("end", new Date(requestEnd * 1000).toISOString());

      const payload = await requestJson(
        url.toString(),
        "Coinbase candles",
        requestOptions,
      );
      if (!Array.isArray(payload)) {
        const message =
          payload &&
          typeof payload === "object" &&
          "message" in payload &&
          typeof payload.message === "string"
            ? `: ${payload.message}`
            : "";
        throw new MarketDataError(
          `Coinbase candles returned a non-array response${message}`,
          "invalid-response",
        );
      }

      payload.forEach((row, index) => {
        const candle = parseHourlyCandle(row, index);
        if (
          candle.timestampSeconds >= cursor &&
          candle.timestampSeconds < chunkEnd
        ) {
          rowsByTimestamp.set(candle.timestampSeconds, candle);
        }
      });

      cursor = chunkEnd;
    }

    const expectedLatestTimestamp =
      latestClosedEndSeconds - ONE_HOUR_SECONDS;
    const latestAvailableTimestamp =
      rowsByTimestamp.size > 0
        ? Math.max(...rowsByTimestamp.keys())
        : Number.NEGATIVE_INFINITY;
    if (latestAvailableTimestamp < expectedLatestTimestamp) {
      const lagMinutes = Number.isFinite(latestAvailableTimestamp)
        ? Math.round(
            (expectedLatestTimestamp - latestAvailableTimestamp) / 60,
          )
        : count * FOUR_HOUR_SECONDS / 60;
      throw new MarketDataError(
        `Latest Coinbase hourly candle is ${lagMinutes} minutes behind the expected close`,
        "stale-data",
      );
    }

    const hourlyCandles: HourlyCandle[] = [];
    for (
      let timestamp = windowStartSeconds;
      timestamp < latestClosedEndSeconds;
      timestamp += ONE_HOUR_SECONDS
    ) {
      const candle = rowsByTimestamp.get(timestamp);
      if (!candle) {
        throw new MarketDataError(
          `Coinbase candles are missing the hour beginning ${new Date(
            timestamp * 1000,
          ).toISOString()}`,
          "insufficient-data",
        );
      }
      hourlyCandles.push(candle);
    }

    const fourHourCandles = aggregateFourHourCandles(hourlyCandles);
    if (fourHourCandles.length !== count) {
      throw new MarketDataError(
        `Expected ${count} complete four-hour candles, received ${fourHourCandles.length}`,
        "insufficient-data",
      );
    }

    return fourHourCandles;
  }

  return {
    getEthSpotPrice,
    getEthFourHourCandles,
    async getEthClosingPrices(
      count?: number,
      requestOptions?: MarketDataRequestOptions,
    ): Promise<number[]> {
      const candles = await getEthFourHourCandles(count, requestOptions);
      return candles.map((candle) => candle.close);
    },
  };
}

export const coinbaseMarketDataProvider =
  createCoinbaseMarketDataProvider();

let activeProvider: MarketDataProvider | null = null;

function harnessPrices(
  scenario: string | undefined,
): number[] {
  const baseline = Array(100).fill(2000) as number[];
  if (scenario === "dip") {
    baseline[baseline.length - 1] = 1900;
  } else if (scenario === "crash") {
    baseline[baseline.length - 1] = 1500;
  }
  return baseline;
}

export function getMarketDataProvider(
  env: Record<string, string | undefined> = process.env,
): MarketDataProvider {
  if (activeProvider) return activeProvider;
  if (env.AGENT_HARNESS_MODE === "mock") {
    if (env.NODE_ENV === "production") {
      throw new Error("AGENT_HARNESS_MODE is forbidden in production");
    }
    return createFixtureMarketDataProvider(
      harnessPrices(env.AGENT_HARNESS_SCENARIO),
    );
  }
  return coinbaseMarketDataProvider;
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
  if (
    prices.length === 0 ||
    prices.some((price) => !Number.isFinite(price) || price <= 0)
  ) {
    throw new Error(
      "Fixture market data requires finite positive prices",
    );
  }

  const fixtureStart = Date.parse("2026-01-01T00:00:00.000Z");
  const candles = prices.map<FourHourCandle>((price, index) => ({
    startTime: new Date(fixtureStart + index * FOUR_HOUR_SECONDS * 1000),
    endTime: new Date(fixtureStart + (index + 1) * FOUR_HOUR_SECONDS * 1000),
    low: price,
    high: price,
    open: price,
    close: price,
    volume: 0,
  }));

  return {
    async getEthSpotPrice(): Promise<number> {
      return prices[prices.length - 1];
    },
    async getEthFourHourCandles(
      count?: number,
    ): Promise<FourHourCandle[]> {
      return count === undefined ? candles : candles.slice(-count);
    },
    async getEthClosingPrices(count?: number): Promise<number[]> {
      return count === undefined ? prices : prices.slice(-count);
    },
  };
}
