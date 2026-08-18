import {
  generateTradeDecision,
  type DecisionInput,
  type GenerateDecisionOptions,
} from "@/agent/decision";
import {
  tradeDecisionSchema,
  type DecisionResult,
  type TradeDecision,
} from "@/trading/types";

export type AgentHarnessMode = "mock" | "smoke";

export interface DecisionProvider {
  generate(
    input: DecisionInput,
    options?: GenerateDecisionOptions,
  ): Promise<DecisionResult>;
}

function assertInferenceAllowed(input: DecisionInput): void {
  if (!input.policy.shouldInvokeModel || input.policy.mandatoryTrade) {
    throw new Error(
      "Decision provider requested when deterministic policy does not permit inference",
    );
  }
}

export function createModelDecisionProvider(
  options: GenerateDecisionOptions = {},
): DecisionProvider {
  return {
    generate(input, runOptions) {
      return generateTradeDecision(input, {
        ...options,
        ...runOptions,
      });
    },
  };
}

export function createFixtureDecisionProvider(
  decision: TradeDecision = {
    action: "HOLD",
    notionalUSD: null,
    reasoning: "Deterministic harness fixture",
  },
): DecisionProvider {
  const fixture = tradeDecisionSchema.parse(decision);
  return {
    async generate(input) {
      assertInferenceAllowed(input);
      return {
        decision: fixture,
        tokenUsage: {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          attemptCount: 1,
          latencyMs: 0,
        },
      };
    },
  };
}

export function resolveDecisionProvider(
  env: Record<string, string | undefined> = process.env,
): DecisionProvider {
  const mode = env.AGENT_HARNESS_MODE as AgentHarnessMode | undefined;
  if (!mode || mode === "smoke") {
    return createModelDecisionProvider();
  }
  if (env.NODE_ENV === "production") {
    throw new Error("AGENT_HARNESS_MODE is forbidden in production");
  }

  const action = env.AGENT_HARNESS_DECISION ?? "HOLD";
  const notionalUSD = action === "HOLD" ? null : 25;
  return createFixtureDecisionProvider(
    tradeDecisionSchema.parse({
      action,
      notionalUSD,
      reasoning: `Deterministic ${action} harness fixture`,
    }),
  );
}
