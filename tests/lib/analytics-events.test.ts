/**
 * Contract tests for src/lib/analytics.ts
 * Mocks capturePostHog so no real PostHog or network calls are made.
 *
 * Note: placed in tests/lib/ because tests/analytics/ directory creation was
 * unavailable in this environment; Jest discovers all tests under tests/.
 */

const mockCapturePostHog = jest.fn();

jest.mock("@/lib/posthog", () => ({
  capturePostHog: (...args: unknown[]) => mockCapturePostHog(...args),
}));

import {
  trackAgentRunStarted,
  trackAgentRunCompleted,
  trackGuardrailTriggered,
  trackTradeExecuted,
  trackLLMTokenUsage,
} from "@/lib/analytics";
import type { AgentRunResult } from "@/lib/types";

beforeEach(() => {
  mockCapturePostHog.mockClear();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getCallProps(): Record<string, unknown> {
  expect(mockCapturePostHog).toHaveBeenCalledTimes(1);
  const call = mockCapturePostHog.mock.calls[0][0] as {
    distinctId: string;
    event: string;
    properties: Record<string, unknown>;
  };
  return { distinctId: call.distinctId, event: call.event, ...call.properties };
}

// ---------------------------------------------------------------------------
// trackAgentRunStarted
// ---------------------------------------------------------------------------

describe("trackAgentRunStarted", () => {
  it("emits agent_run_started with default triggerSource=cron", () => {
    trackAgentRunStarted();
    const props = getCallProps();
    expect(props.event).toBe("agent_run_started");
    expect(props.triggerSource).toBe("cron");
    expect(typeof props.timestamp).toBe("string");
    expect(() => new Date(props.timestamp as string)).not.toThrow();
  });

  it("propagates explicit triggerSource", () => {
    trackAgentRunStarted("admin");
    const props = getCallProps();
    expect(props.triggerSource).toBe("admin");
  });

  it("does not rethrow when capturePostHog throws", () => {
    mockCapturePostHog.mockImplementationOnce(() => {
      throw new Error("posthog down");
    });
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    expect(() => trackAgentRunStarted()).not.toThrow();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// trackAgentRunCompleted
// ---------------------------------------------------------------------------

describe("trackAgentRunCompleted", () => {
  const baseResult: AgentRunResult = {
    status: "executed",
    durationMs: 1200,
  };

  it("emits agent_run_completed with required fields", () => {
    trackAgentRunCompleted(baseResult);
    const props = getCallProps();
    expect(props.event).toBe("agent_run_completed");
    expect(props.triggerSource).toBe("cron");
    expect(props.status).toBe("executed");
    expect(typeof props.timestamp).toBe("string");
  });

  it("resolves optional fields to null when absent", () => {
    trackAgentRunCompleted(baseResult);
    const props = getCallProps();
    expect(props.action).toBeNull();
    expect(props.promptTokens).toBeNull();
    expect(props.completionTokens).toBeNull();
    expect(props.totalTokens).toBeNull();
    expect(props.llmAttemptCount).toBeNull();
    expect(props.llmLatencyMs).toBeNull();
    expect(props.journalWritten).toBeNull();
    expect(props.journalFallbackWritten).toBe(false);
  });

  it("includes provided action and token usage", () => {
    const result: AgentRunResult = {
      ...baseResult,
      action: "BUY",
      tokenUsage: {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        attemptCount: 1,
        latencyMs: 800,
      },
      journalWritten: true,
    };
    trackAgentRunCompleted(result, "admin");
    const props = getCallProps();
    expect(props.action).toBe("BUY");
    expect(props.promptTokens).toBe(100);
    expect(props.completionTokens).toBe(50);
    expect(props.totalTokens).toBe(150);
    expect(props.llmAttemptCount).toBe(1);
    expect(props.llmLatencyMs).toBe(800);
    expect(props.journalWritten).toBe(true);
    expect(props.triggerSource).toBe("admin");
  });

  it("does not rethrow when capturePostHog throws", () => {
    mockCapturePostHog.mockImplementationOnce(() => {
      throw new Error("posthog down");
    });
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    expect(() => trackAgentRunCompleted(baseResult)).not.toThrow();
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// trackGuardrailTriggered
// ---------------------------------------------------------------------------

describe("trackGuardrailTriggered", () => {
  it("emits guardrail_triggered with required fields", () => {
    trackGuardrailTriggered("drawdown_limit", { threshold: 0.05 });
    const props = getCallProps();
    expect(props.event).toBe("guardrail_triggered");
    expect(props.guardrailName).toBe("drawdown_limit");
    expect(props.threshold).toBe(0.05);
    expect(props.triggerSource).toBe("cron");
    expect(typeof props.timestamp).toBe("string");
  });

  it("propagates explicit triggerSource", () => {
    trackGuardrailTriggered("cooldown", {}, "admin");
    const props = getCallProps();
    expect(props.triggerSource).toBe("admin");
  });

  it("does not rethrow when capturePostHog throws", () => {
    mockCapturePostHog.mockImplementationOnce(() => {
      throw new Error("posthog down");
    });
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    expect(() => trackGuardrailTriggered("test", {})).not.toThrow();
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// trackTradeExecuted
// ---------------------------------------------------------------------------

describe("trackTradeExecuted", () => {
  const baseTrade = {
    direction: "BUY",
    asset: "ETH",
    amountUSD: 500,
    executionPrice: 2000,
    feesUSD: 1.5,
  };

  it("emits trade_executed with required fields", () => {
    trackTradeExecuted(baseTrade);
    const props = getCallProps();
    expect(props.event).toBe("trade_executed");
    expect(props.direction).toBe("BUY");
    expect(props.asset).toBe("ETH");
    expect(props.amountUSD).toBe(500);
    expect(props.executionPrice).toBe(2000);
    expect(props.feesUSD).toBe(1.5);
    expect(typeof props.timestamp).toBe("string");
  });

  it("resolves pnlUSD to null when absent", () => {
    trackTradeExecuted(baseTrade);
    const props = getCallProps();
    expect(props.pnlUSD).toBeNull();
  });

  it("includes pnlUSD when provided", () => {
    trackTradeExecuted({ ...baseTrade, pnlUSD: 42.5 });
    const props = getCallProps();
    expect(props.pnlUSD).toBe(42.5);
  });

  it("does not rethrow when capturePostHog throws", () => {
    mockCapturePostHog.mockImplementationOnce(() => {
      throw new Error("posthog down");
    });
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    expect(() => trackTradeExecuted(baseTrade)).not.toThrow();
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// trackLLMTokenUsage
// ---------------------------------------------------------------------------

describe("trackLLMTokenUsage", () => {
  const baseUsage = {
    promptTokens: 200,
    completionTokens: 80,
    totalTokens: 280,
    attemptCount: 2,
    latencyMs: 1100,
  };

  it("emits llm_token_usage with all fields", () => {
    trackLLMTokenUsage(baseUsage);
    const props = getCallProps();
    expect(props.event).toBe("llm_token_usage");
    expect(props.promptTokens).toBe(200);
    expect(props.completionTokens).toBe(80);
    expect(props.totalTokens).toBe(280);
    expect(props.attemptCount).toBe(2);
    expect(props.latencyMs).toBe(1100);
    expect(typeof props.timestamp).toBe("string");
  });

  it("does not rethrow when capturePostHog throws", () => {
    mockCapturePostHog.mockImplementationOnce(() => {
      throw new Error("posthog down");
    });
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    expect(() => trackLLMTokenUsage(baseUsage)).not.toThrow();
    spy.mockRestore();
  });
});
