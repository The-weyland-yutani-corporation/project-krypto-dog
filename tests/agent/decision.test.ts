import { AIMessage } from "@langchain/core/messages";
import { RunnableLambda } from "@langchain/core/runnables";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { generateTradeDecision } from "@/agent/decision";
import { DEFAULT_STRATEGY_CONFIG } from "@/trading/strategy-config";
import { AgentUpstreamError } from "@/trading/errors";

const model = {
  withStructuredOutput: jest.fn(() =>
    RunnableLambda.from(async () => ({
      parsed: {
        action: "BUY",
        notionalUSD: 25,
        reasoning: "Eligible dip",
      },
      raw: new AIMessage({
        content: "",
        usage_metadata: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
        },
      }),
    })),
  ),
} as unknown as BaseChatModel;

const input = {
  account: {
    initialCapitalUSD: 200,
    ethBalance: 0,
    usdcBalance: 200,
    weightedCostBasisUSD: null,
    referencePriceUSD: 2000,
    lastBuyPriceUSD: null,
    dcaCount: 0,
    peakPortfolioValueUSD: 200,
    lastExecutionAt: null,
    isLocked: false,
    isOperatorPaused: false,
    accountingStatus: "RECONCILED" as const,
  },
  market: {
    spotPriceUSD: 1900,
    observedAt: new Date("2026-07-14T12:00:00Z"),
    rsi: 30,
    emaShort: 1950,
    emaLong: 2000,
  },
  policy: {
    portfolioValueUSD: 200,
    peakPortfolioValueUSD: 200,
    drawdownPct: 0,
    shouldInvokeModel: true,
    buy: {
      action: "BUY" as const,
      minimumNotionalUSD: 10,
      maximumNotionalUSD: 50,
      reason: "eligible",
    },
  },
  strategy: DEFAULT_STRATEGY_CONFIG,
  recentJournalEntries: ["Held while waiting for a dip."],
};

describe("generateTradeDecision", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns exactly one structured decision and token usage", async () => {
    const result = await generateTradeDecision(input, { model });

    expect(result).toEqual({
      decision: {
        action: "BUY",
        notionalUSD: 25,
        reasoning: "Eligible dip",
      },
      tokenUsage: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        attemptCount: 1,
        latencyMs: expect.any(Number),
      },
    });
    expect(model.withStructuredOutput).toHaveBeenCalledTimes(1);
  });

  it("applies full domain constraints locally after Azure-compatible parsing", async () => {
    const invalidModel = {
      withStructuredOutput: jest.fn(() =>
        RunnableLambda.from(async () => ({
          parsed: {
            action: "BUY",
            notionalUSD: -1,
            reasoning: "Invalid negative amount",
          },
          raw: new AIMessage({ content: "" }),
        })),
      ),
    } as unknown as BaseChatModel;

    await expect(
      generateTradeDecision(input, { model: invalidModel }),
    ).rejects.toThrow();
  });

  it("refuses inference when deterministic policy blocks it", async () => {
    await expect(
      generateTradeDecision(
        {
          ...input,
          policy: {
            ...input.policy,
            shouldInvokeModel: false,
            holdReason: "cooldown",
          },
        },
        { model },
      ),
    ).rejects.toThrow(/does not permit inference/);
  });

  it("retries one rate-limited model call and then succeeds", async () => {
    let calls = 0;
    const retryingModel = {
      withStructuredOutput: jest.fn(() =>
        RunnableLambda.from(async () => {
          calls += 1;
          if (calls === 1) {
            throw Object.assign(new Error("rate limited"), { status: 429 });
          }
          return {
            parsed: {
              action: "HOLD",
              notionalUSD: null,
              reasoning: "Wait",
            },
            raw: new AIMessage({ content: "" }),
          };
        }),
      ),
    } as unknown as BaseChatModel;

    const result = await generateTradeDecision(input, {
      model: retryingModel,
      retryDelayMs: 1,
    });

    expect(result.decision.action).toBe("HOLD");
    expect(result.tokenUsage?.attemptCount).toBe(2);
    expect(calls).toBe(2);
  });

  it("does not retry authentication failures", async () => {
    let calls = 0;
    const failingModel = {
      withStructuredOutput: jest.fn(() =>
        RunnableLambda.from(async () => {
          calls += 1;
          throw Object.assign(new Error("invalid API key"), { status: 401 });
        }),
      ),
    } as unknown as BaseChatModel;

    await expect(
      generateTradeDecision(input, {
        model: failingModel,
        maxAttempts: 3,
        retryDelayMs: 1,
      }),
    ).rejects.toMatchObject<Partial<AgentUpstreamError>>({
      errorType: "LLM_AUTH",
      httpStatus: 502,
      retryable: false,
      attemptCount: 1,
    });
    expect(calls).toBe(1);
  });

  it("classifies provider timeouts as retryable typed failures", async () => {
    const timeoutModel = {
      withStructuredOutput: jest.fn(() =>
        RunnableLambda.from(async () => {
          throw Object.assign(new Error("request timed out"), {
            name: "TimeoutError",
          });
        }),
      ),
    } as unknown as BaseChatModel;

    await expect(
      generateTradeDecision(input, {
        model: timeoutModel,
        maxAttempts: 1,
      }),
    ).rejects.toMatchObject<Partial<AgentUpstreamError>>({
      errorType: "LLM_TIMEOUT",
      httpStatus: 504,
      retryable: true,
      attemptCount: 1,
    });
  });
});
