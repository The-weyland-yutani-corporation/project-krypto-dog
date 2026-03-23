import { getPostHogClient } from "./posthog";
import type { AgentRunResult } from "./types";

const DISTINCT_ID = "krypto-agent";

export function trackAgentRunStarted(): void {
  try {
    getPostHogClient().capture({
      distinctId: DISTINCT_ID,
      event: "agent_run_started",
      properties: { timestamp: new Date().toISOString() },
    });
  } catch (error) {
    console.error("[analytics] Failed to track agent_run_started:", error);
  }
}

export function trackAgentRunCompleted(result: AgentRunResult): void {
  try {
    getPostHogClient().capture({
      distinctId: DISTINCT_ID,
      event: "agent_run_completed",
      properties: {
        status: result.status,
        action: result.action ?? null,
        durationMs: result.durationMs,
        promptTokens: result.tokenUsage?.promptTokens ?? null,
        completionTokens: result.tokenUsage?.completionTokens ?? null,
        totalTokens: result.tokenUsage?.totalTokens ?? null,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("[analytics] Failed to track agent_run_completed:", error);
  }
}

export function trackGuardrailTriggered(
  guardrailName: string,
  details: Record<string, unknown>
): void {
  try {
    getPostHogClient().capture({
      distinctId: DISTINCT_ID,
      event: "guardrail_triggered",
      properties: {
        guardrailName,
        ...details,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("[analytics] Failed to track guardrail_triggered:", error);
  }
}

export function trackTradeExecuted(trade: {
  direction: string;
  asset: string;
  amountUSD: number;
  executionPrice: number;
  feesUSD: number;
  pnlUSD?: number;
}): void {
  try {
    getPostHogClient().capture({
      distinctId: DISTINCT_ID,
      event: "trade_executed",
      properties: {
        direction: trade.direction,
        asset: trade.asset,
        amountUSD: trade.amountUSD,
        executionPrice: trade.executionPrice,
        feesUSD: trade.feesUSD,
        pnlUSD: trade.pnlUSD ?? null,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("[analytics] Failed to track trade_executed:", error);
  }
}

export function trackLLMTokenUsage(usage: {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}): void {
  try {
    getPostHogClient().capture({
      distinctId: DISTINCT_ID,
      event: "llm_token_usage",
      properties: {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("[analytics] Failed to track llm_token_usage:", error);
  }
}
