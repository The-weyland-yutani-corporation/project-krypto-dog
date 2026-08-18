import {
  createModelDecisionProvider,
  createFixtureDecisionProvider,
  resolveDecisionProvider,
} from "@/agent/decision-provider";
import { AIMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { RunnableLambda } from "@langchain/core/runnables";
import { DEFAULT_STRATEGY_CONFIG } from "@/trading/strategy-config";

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
    observedAt: new Date("2026-08-09T00:00:00Z"),
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
  recentJournalEntries: [],
};

describe("harness decision provider", () => {
  it("delegates the real provider to structured model generation", async () => {
    const model = {
      withStructuredOutput: jest.fn(() =>
        RunnableLambda.from(async () => ({
          parsed: {
            action: "HOLD",
            notionalUSD: null,
            reasoning: "Model hold",
          },
          raw: new AIMessage({ content: "" }),
        })),
      ),
    } as unknown as BaseChatModel;
    const provider = createModelDecisionProvider({ model });

    await expect(provider.generate(input)).resolves.toMatchObject({
      decision: {
        action: "HOLD",
        notionalUSD: null,
        reasoning: "Model hold",
      },
    });
  });

  it("forwards per-run generation options through the provider boundary", async () => {
    const configuredModel = {
      withStructuredOutput: jest.fn(() => {
        throw new Error("configured model must be overridden");
      }),
    } as unknown as BaseChatModel;
    const runModel = {
      withStructuredOutput: jest.fn(() =>
        RunnableLambda.from(async () => ({
          parsed: {
            action: "HOLD",
            notionalUSD: null,
            reasoning: "Run-scoped model hold",
          },
          raw: new AIMessage({ content: "" }),
        })),
      ),
    } as unknown as BaseChatModel;
    const provider = createModelDecisionProvider({ model: configuredModel });

    await expect(provider.generate(input, { model: runModel })).resolves.toMatchObject({
      decision: {
        reasoning: "Run-scoped model hold",
      },
    });
    expect(configuredModel.withStructuredOutput).not.toHaveBeenCalled();
    expect(runModel.withStructuredOutput).toHaveBeenCalledTimes(1);
  });

  it("returns a deterministic read-only fixture decision", async () => {
    const provider = createFixtureDecisionProvider({
      action: "BUY",
      notionalUSD: 25,
      reasoning: "Fixture buy",
    });

    await expect(provider.generate(input)).resolves.toEqual({
      decision: {
        action: "BUY",
        notionalUSD: 25,
        reasoning: "Fixture buy",
      },
      tokenUsage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        attemptCount: 1,
        latencyMs: 0,
      },
    });
  });

  it("still respects the deterministic inference boundary", async () => {
    const provider = createFixtureDecisionProvider();
    await expect(
      provider.generate({
        ...input,
        policy: {
          ...input.policy,
          shouldInvokeModel: false,
        },
      }),
    ).rejects.toThrow(/does not permit inference/);
  });

  it("rejects inference when deterministic policy owns a mandatory trade", async () => {
    const provider = createFixtureDecisionProvider();
    await expect(
      provider.generate({
        ...input,
        policy: {
          ...input.policy,
          mandatoryTrade: {
            action: "SELL",
            notionalUSD: 50,
            reasoning: "Mandatory exit",
            mandatory: true,
            fullExit: true,
          },
        },
      }),
    ).rejects.toThrow(/does not permit inference/);
  });

  it("resolves a deterministic fixture from mock harness configuration", async () => {
    const provider = resolveDecisionProvider({
      NODE_ENV: "development",
      AGENT_HARNESS_MODE: "mock",
      AGENT_HARNESS_DECISION: "SELL",
    });

    const result = await provider.generate(input);
    expect(result.decision).toEqual({
      action: "SELL",
      notionalUSD: 25,
      reasoning: "Deterministic SELL harness fixture",
    });
  });

  it("rejects mock provider selection in production", () => {
    expect(() =>
      resolveDecisionProvider({
        NODE_ENV: "production",
        AGENT_HARNESS_MODE: "mock",
      }),
    ).toThrow(/forbidden in production/);
  });

  it.each([undefined, "smoke"])(
    "uses the real provider when harness mode is %s",
    (mode) => {
      const provider = resolveDecisionProvider({
        NODE_ENV: "development",
        AGENT_HARNESS_MODE: mode,
      });
      expect(typeof provider.generate).toBe("function");
    },
  );
});
