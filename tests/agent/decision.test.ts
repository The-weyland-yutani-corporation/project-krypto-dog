import { AIMessage } from "@langchain/core/messages";
import { RunnableLambda } from "@langchain/core/runnables";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { generateTradeDecision } from "@/agent/decision";
import { DEFAULT_STRATEGY_CONFIG } from "@/trading/strategy-config";
import { AgentUpstreamError } from "@/trading/errors";
import { createExecutionDeadline } from "@/lib/execution-envelope";

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

  it("uses the Foundry agent boundary by default when an invoker is supplied", async () => {
    const agentInvoker = jest.fn(async () => ({
      decision: {
        action: "HOLD" as const,
        notionalUSD: null,
        reasoning: "Read-only agent proposal.",
      },
      tokenUsage: {
        inputTokens: 12,
        outputTokens: 4,
        totalTokens: 16,
      },
    }));

    const result = await generateTradeDecision(input, { agentInvoker });

    expect(result.decision.action).toBe("HOLD");
    expect(result.tokenUsage).toMatchObject({
      promptTokens: 12,
      completionTokens: 4,
      totalTokens: 16,
      attemptCount: 1,
    });
    expect(agentInvoker).toHaveBeenCalledWith(
      expect.stringContaining('"eligibleActions"'),
      expect.any(AbortSignal),
    );
  });

  it("rejects conflicting direct-model and Foundry-agent overrides", async () => {
    const agentInvoker = jest.fn();

    await expect(
      generateTradeDecision(input, { model, agentInvoker }),
    ).rejects.toThrow(/either a model or a Foundry agent invoker/);
    expect(agentInvoker).not.toHaveBeenCalled();
  });

  it("rejects a direct model without structured output support", async () => {
    const unstructuredModel = {} as BaseChatModel;

    await expect(
      generateTradeDecision(input, { model: unstructuredModel }),
    ).rejects.toThrow(/does not support structured output/);
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

  it("retries a Foundry timeout and then succeeds", async () => {
    let calls = 0;
    const agentInvoker = jest.fn(async () => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error("Foundry request timed out"), {
          name: "TimeoutError",
        });
      }
      return {
        decision: {
          action: "HOLD" as const,
          notionalUSD: null,
          reasoning: "Wait",
        },
        tokenUsage: {
          inputTokens: 8,
          outputTokens: 2,
          totalTokens: 10,
        },
      };
    });

    const result = await generateTradeDecision(input, {
      agentInvoker,
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

  it("honors provider Retry-After while remaining inside the absolute deadline", async () => {
    const delays: number[] = [];
    let calls = 0;
    const agentInvoker = jest.fn(async () => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error("rate limited"), {
          status: 429,
          headers: new Headers({ "Retry-After": "2" }),
        });
      }
      return {
        decision: {
          action: "HOLD" as const,
          notionalUSD: null,
          reasoning: "Wait",
        },
        tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    });
    const result = await generateTradeDecision(input, {
      agentInvoker,
      delayImpl: async (ms) => {
        delays.push(ms);
      },
    });
    expect(result.decision.action).toBe("HOLD");
    expect(delays).toEqual([2_000]);
  });

  it("fails closed when Retry-After exceeds the Foundry budget", async () => {
    const agentInvoker = jest.fn(async () => {
      throw Object.assign(new Error("rate limited"), {
        status: 429,
        headers: new Headers({ "Retry-After": "90" }),
      });
    });
    await expect(
      generateTradeDecision(input, { agentInvoker }),
    ).rejects.toMatchObject({
      code: "provider-budget-exhausted",
      provider: "foundry",
      kind: "time",
    });
    expect(agentInvoker).toHaveBeenCalledTimes(1);
  });

  it("does not invoke Foundry after cancellation", async () => {
    const controller = new AbortController();
    const deadline = createExecutionDeadline({ signal: controller.signal });
    controller.abort();
    const agentInvoker = jest.fn();
    await expect(
      generateTradeDecision(input, {
        agentInvoker,
        deadline,
        budgetStore: { consume: async () => 1 },
      }),
    ).rejects.toMatchObject({ code: "execution-deadline-exhausted" });
    expect(agentInvoker).not.toHaveBeenCalled();
    deadline.dispose();
  });

  it("propagates cancellation while waiting to retry Foundry", async () => {
    const controller = new AbortController();
    const agentInvoker = jest.fn(async () => {
      throw Object.assign(new Error("temporarily unavailable"), {
        status: 429,
      });
    });
    const pending = generateTradeDecision(input, {
      agentInvoker,
      signal: controller.signal,
      retryDelayMs: 1_000,
    });
    setTimeout(() => controller.abort(new Error("cancel retry")), 1);
    await expect(pending).rejects.toThrow("cancel retry");
    expect(agentInvoker).toHaveBeenCalledTimes(1);
  });

  it("uses the absolute deadline for a budgeted Foundry retry", async () => {
    let calls = 0;
    const deadline = createExecutionDeadline();
    const agentInvoker = jest.fn(async () => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error("temporarily unavailable"), {
          status: 429,
        });
      }
      return {
        decision: {
          action: "HOLD" as const,
          notionalUSD: null,
          reasoning: "Wait",
        },
        tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    });
    await expect(
      generateTradeDecision(input, {
        agentInvoker,
        deadline,
        retryDelayMs: 1,
        budgetStore: { consume: async () => calls + 1 },
      }),
    ).resolves.toMatchObject({ decision: { action: "HOLD" } });
    expect(agentInvoker).toHaveBeenCalledTimes(2);
    deadline.dispose();
  });

  it("rejects an already exhausted Foundry provider window", async () => {
    const deadline = createExecutionDeadline();
    const agentInvoker = jest.fn();
    await expect(
      generateTradeDecision(input, {
        agentInvoker,
        deadline,
        providerDeadlineAt: new Date(deadline.now().getTime() - 1),
        budgetStore: { consume: async () => 1 },
      }),
    ).rejects.toMatchObject({
      code: "provider-budget-exhausted",
      provider: "foundry",
      kind: "time",
    });
    expect(agentInvoker).not.toHaveBeenCalled();
    deadline.dispose();
  });
});
