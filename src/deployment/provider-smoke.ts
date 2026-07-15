import { HumanMessage } from "@langchain/core/messages";

import { buildLLM } from "@/agent/llm";
import { getMarketDataProvider } from "@/lib/market-data-provider";
import {
  flushPostHog,
  getPostHogClient,
  shutdownPostHog,
} from "@/lib/posthog";

export type ProviderSmokeResult = {
  foundry: {
    latencyMs: number;
    responseLength: number;
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
  };
  coinbase: {
    latencyMs: number;
    spotPriceFinite: boolean;
    completeCandleCount: number;
  };
  postHog: {
    latencyMs: number;
    flushed: boolean;
    smokeId: string;
  };
};

export async function smokeFoundry(
  timeoutMs = 30_000,
): Promise<ProviderSmokeResult["foundry"]> {
  const startedAt = Date.now();
  const response = await buildLLM().invoke(
    [
      new HumanMessage("Reply with exactly the single word OK."),
    ],
    {
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  const content =
    typeof response.content === "string"
      ? response.content
      : JSON.stringify(response.content);
  if (!content.trim()) {
    throw new Error("Foundry returned an empty response.");
  }
  const usage = response.usage_metadata;
  return {
    latencyMs: Date.now() - startedAt,
    responseLength: content.length,
    inputTokens: usage?.input_tokens ?? null,
    outputTokens: usage?.output_tokens ?? null,
    totalTokens: usage?.total_tokens ?? null,
  };
}

export async function smokeCoinbase(): Promise<
  ProviderSmokeResult["coinbase"]
> {
  const startedAt = Date.now();
  const provider = getMarketDataProvider();
  const [spotPrice, candles] = await Promise.all([
    provider.getEthSpotPrice(),
    provider.getEthFourHourCandles(2),
  ]);
  if (!Number.isFinite(spotPrice) || spotPrice <= 0) {
    throw new Error("Coinbase returned an invalid ETH spot price.");
  }
  if (candles.length !== 2) {
    throw new Error("Coinbase did not return two complete four-hour candles.");
  }
  return {
    latencyMs: Date.now() - startedAt,
    spotPriceFinite: true,
    completeCandleCount: candles.length,
  };
}

export async function smokePostHog(): Promise<
  ProviderSmokeResult["postHog"]
> {
  if (!process.env.POSTHOG_API_KEY) {
    throw new Error("POSTHOG_API_KEY is required for the target smoke.");
  }
  const startedAt = Date.now();
  const smokeId = crypto.randomUUID();
  try {
    getPostHogClient().capture({
      distinctId: "krypto-deployment-smoke",
      event: "deployment_smoke",
      properties: {
        smokeId,
        mode: "disabled",
        timestamp: new Date().toISOString(),
      },
    });
    await flushPostHog();
    return {
      latencyMs: Date.now() - startedAt,
      flushed: true,
      smokeId,
    };
  } finally {
    await shutdownPostHog();
  }
}

export async function runProviderSmoke(): Promise<ProviderSmokeResult> {
  const [foundry, coinbase, postHog] = await Promise.all([
    smokeFoundry(),
    smokeCoinbase(),
    smokePostHog(),
  ]);
  return { foundry, coinbase, postHog };
}
