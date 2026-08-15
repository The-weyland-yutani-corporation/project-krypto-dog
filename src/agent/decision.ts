import {
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  getFoundryDecisionInvoker,
  type FoundryDecisionInvoker,
} from "./foundry-agent";
import {
  tradeDecisionSchema,
  tradeDecisionWireSchema,
  type DecisionResult,
  type PolicyEvaluation,
  type TradingAccountSnapshot,
  type TradingMarketSnapshot,
} from "@/trading/types";
import type { StrategyConfig } from "@/trading/strategy-config";
import { classifyLlmError } from "@/trading/errors";

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 250;

export interface DecisionInput {
  account: TradingAccountSnapshot;
  market: TradingMarketSnapshot;
  policy: PolicyEvaluation;
  strategy: StrategyConfig;
  recentJournalEntries: string[];
}

export interface GenerateDecisionOptions {
  model?: BaseChatModel;
  agentInvoker?: FoundryDecisionInvoker;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
}

type MessageWithUsage = BaseMessage & {
  usage_metadata?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
};

type ProviderTokenUsage = Pick<
  NonNullable<DecisionResult["tokenUsage"]>,
  "promptTokens" | "completionTokens" | "totalTokens"
>;

interface ProviderDecisionResponse {
  parsed: unknown;
  usage?: ProviderTokenUsage;
}

function extractTokenUsage(
  message: BaseMessage,
): ProviderTokenUsage | undefined {
  const usage = (message as MessageWithUsage).usage_metadata;
  if (!usage) return undefined;
  return {
    promptTokens: usage.input_tokens ?? 0,
    completionTokens: usage.output_tokens ?? 0,
    totalTokens: usage.total_tokens ?? 0,
  };
}

function buildDecisionPrompt(input: DecisionInput): string {
  return JSON.stringify(
    {
      instruction:
        "Return exactly one HOLD, BUY, or SELL decision. Choose only from the eligible actions. You cannot execute a trade.",
      strategyVersion: input.strategy.version,
      market: {
        spotPriceUSD: input.market.spotPriceUSD,
        observedAt: input.market.observedAt.toISOString(),
        rsi: input.market.rsi,
        emaShort: input.market.emaShort,
        emaLong: input.market.emaLong,
      },
      account: input.account,
      eligibleActions: {
        hold: true,
        buy: input.policy.buy ?? null,
        sell: input.policy.sell ?? null,
      },
      recentJournalEntries: input.recentJournalEntries,
    },
    null,
    2,
  );
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (
    value === undefined ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > maximum
  ) {
    return fallback;
  }
  return value;
}

function attemptSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return callerSignal
    ? AbortSignal.any([callerSignal, timeoutSignal])
    : timeoutSignal;
}

async function waitForRetry(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function generateTradeDecision(
  input: DecisionInput,
  options: GenerateDecisionOptions = {},
): Promise<DecisionResult> {
  const startedAt = Date.now();
  if (!input.policy.shouldInvokeModel || input.policy.mandatoryTrade) {
    throw new Error(
      "LLM decision requested when deterministic policy does not permit inference",
    );
  }

  if (options.model && options.agentInvoker) {
    throw new Error("Configure either a model or a Foundry agent invoker, not both");
  }

  const timeoutMs = boundedPositiveInteger(
    options.timeoutMs,
    DEFAULT_TIMEOUT_MS,
    60_000,
  );
  const maxAttempts = boundedPositiveInteger(
    options.maxAttempts,
    DEFAULT_MAX_ATTEMPTS,
    3,
  );
  const retryDelayMs = boundedPositiveInteger(
    options.retryDelayMs,
    DEFAULT_RETRY_DELAY_MS,
    5_000,
  );
  const prompt = buildDecisionPrompt(input);
  let invokeAttempt: (signal: AbortSignal) => Promise<ProviderDecisionResponse>;
  if (options.model) {
    if (!options.model.withStructuredOutput) {
      throw new Error("Configured model does not support structured output");
    }
    const structuredModel = options.model.withStructuredOutput(
      tradeDecisionWireSchema,
      {
        name: "trade_decision",
        includeRaw: true,
      },
    );
    const messages = [
      new SystemMessage(
        "You are a read-only ETH/USDC paper-trading decision model. Deterministic code enforces every rule and may reject your proposal.",
      ),
      new HumanMessage(prompt),
    ];
    invokeAttempt = async (signal) => {
      const response = await structuredModel.invoke(messages, { signal });
      return {
        parsed: response.parsed,
        usage: extractTokenUsage(response.raw),
      };
    };
  } else {
    const agentInvoker = options.agentInvoker ?? getFoundryDecisionInvoker();
    invokeAttempt = async (signal) => {
      const response = await agentInvoker(prompt, signal);
      return {
        parsed: response.decision,
        usage: {
          promptTokens: response.tokenUsage.inputTokens,
          completionTokens: response.tokenUsage.outputTokens,
          totalTokens: response.tokenUsage.totalTokens,
        },
      };
    };
  }

  let response: ProviderDecisionResponse | undefined;
  let finalError: unknown;
  let attemptCount = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attemptCount = attempt;
    try {
      response = await invokeAttempt(attemptSignal(options.signal, timeoutMs));
      break;
    } catch (error) {
      const classified = classifyLlmError(error);
      classified.attemptCount = attempt;
      classified.latencyMs = Date.now() - startedAt;
      finalError = classified;
      if (!classified.retryable || attempt === maxAttempts) {
        throw classified;
      }
      await waitForRetry(retryDelayMs * attempt);
    }
  }

  if (!response) {
    throw classifyLlmError(finalError);
  }

  const usage = response.usage;
  return {
    decision: tradeDecisionSchema.parse(response.parsed),
    tokenUsage: {
      promptTokens: usage?.promptTokens ?? 0,
      completionTokens: usage?.completionTokens ?? 0,
      totalTokens: usage?.totalTokens ?? 0,
      attemptCount,
      latencyMs: Date.now() - startedAt,
    },
  };
}
