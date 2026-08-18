import { HumanMessage } from "@langchain/core/messages";
import { z } from "zod/v4";

import { buildLLM } from "@/agent/llm";
import { getFoundryDecisionInvoker } from "@/agent/foundry-agent";
import { getMarketDataProvider } from "@/lib/market-data-provider";
import {
  flushPostHog,
  capturePostHog,
  shutdownPostHog,
} from "@/lib/posthog";

export type ProviderSmokeResult = {
  foundry: {
    latencyMs: number;
    responseLength: number;
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    structured: LunaStructuredSmokeResult;
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

const noTradeSmokeSchema = z.object({
  action: z.literal("HOLD"),
  notionalUSD: z.null(),
  reasoning: z.string().trim().min(1),
});
const noTradeSmokeWireSchema = z.object({
  action: z.literal("HOLD"),
  notionalUSD: z.null(),
  reasoning: z.string(),
});

export type LunaStructuredSmokeResult = {
  latencyMs: number;
  action: "HOLD";
  notionalUSD: null;
};

type TokenUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
};

function tokenUsage(
  usage:
    | {
        input_tokens?: number;
        output_tokens?: number;
        total_tokens?: number;
      }
    | undefined,
): TokenUsage {
  return {
    inputTokens: usage?.input_tokens ?? null,
    outputTokens: usage?.output_tokens ?? null,
    totalTokens: usage?.total_tokens ?? null,
  };
}

export async function smokeLunaStructuredOutput(
  timeoutMs = 30_000,
  model = buildLLM(),
): Promise<LunaStructuredSmokeResult> {
  const startedAt = Date.now();
  const structuredModel = model.withStructuredOutput(noTradeSmokeWireSchema, {
    name: "no_trade_smoke",
    method: "jsonSchema",
    strict: true,
  });
  const response = noTradeSmokeSchema.parse(
    await structuredModel.invoke(
      [
        new HumanMessage(
          "This is a read-only provider validation. Return HOLD with null notionalUSD and a short reason. Do not propose or execute a trade.",
        ),
      ],
      { signal: AbortSignal.timeout(timeoutMs) },
    ),
  );

  return {
    latencyMs: Date.now() - startedAt,
    action: response.action,
    notionalUSD: response.notionalUSD,
  };
}

export async function smokeFoundry(
  timeoutMs = 30_000,
): Promise<Omit<ProviderSmokeResult["foundry"], "structured">> {
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
  const usage = tokenUsage(response.usage_metadata);
  return {
    latencyMs: Date.now() - startedAt,
    responseLength: content.length,
    ...usage,
  };
}

export async function smokeFoundryAgent(
  timeoutMs = 30_000,
): Promise<ProviderSmokeResult["foundry"]> {
  const startedAt = Date.now();
  const response = await getFoundryDecisionInvoker()(
    JSON.stringify({
      instruction:
        "Read-only deployment validation. Return HOLD and do not propose or execute a trade.",
      eligibleActions: {
        hold: true,
        buy: null,
        sell: null,
      },
    }),
    AbortSignal.timeout(timeoutMs),
  );
  if (
    response.decision.action !== "HOLD" ||
    response.decision.notionalUSD !== null
  ) {
    throw new Error("Foundry Agent no-trade smoke did not return HOLD.");
  }
  const latencyMs = Date.now() - startedAt;

  return {
    latencyMs,
    responseLength: JSON.stringify(response.decision).length,
    inputTokens: response.tokenUsage.inputTokens,
    outputTokens: response.tokenUsage.outputTokens,
    totalTokens: response.tokenUsage.totalTokens,
    structured: {
      latencyMs,
      action: response.decision.action,
      notionalUSD: response.decision.notionalUSD,
    },
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
    capturePostHog({
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

export type ReadOnlyProviderSmokeResult = {
  foundry: Omit<ProviderSmokeResult["foundry"], "structured">;
  coinbase: ProviderSmokeResult["coinbase"];
};

/**
 * Read-only provider smoke for the harness: exercises Foundry-hosted Azure
 * OpenAI and Coinbase only.
 *
 * It deliberately does NOT emit any PostHog or email events, never touches the
 * database, and — because it reuses the existing decision/market-data seams —
 * cannot execute a trade. It is the only real-network path the harness allows,
 * and callers must have already gated it behind an explicit opt-in, shadow mode,
 * and non-production checks.
 */
export async function runReadOnlyProviderSmoke(): Promise<ReadOnlyProviderSmokeResult> {
  const [foundry, coinbase] = await Promise.all([
    smokeFoundry(),
    smokeCoinbase(),
  ]);
  return { foundry, coinbase };
}

export async function runProviderSmoke(): Promise<ProviderSmokeResult> {
  const [foundry, coinbase, postHog] = await Promise.all([
    smokeFoundryAgent(),
    smokeCoinbase(),
    smokePostHog(),
  ]);
  return {
    foundry,
    coinbase,
    postHog,
  };
}
