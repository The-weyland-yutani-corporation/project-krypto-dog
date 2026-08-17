import { capturePostHog } from "./posthog";
import type { AgentRunResult } from "./types";

const DISTINCT_ID = "krypto-agent";

export type AgentTriggerSource = "cron" | "admin";

export interface TelemetryCaptureResult {
  accepted: boolean;
  event: string;
  failureCode?: "posthog-capture-failed";
}

function captureAnalyticsEvent(
  event: string,
  properties: Record<string, unknown>,
): TelemetryCaptureResult {
  try {
    capturePostHog({
      distinctId: DISTINCT_ID,
      event,
      properties: {
        ...properties,
        timestamp: new Date().toISOString(),
      },
    });
    return { accepted: true, event };
  } catch {
    // The durable incident path records the failure. Do not serialize the
    // provider exception because it may contain request/configuration data.
    console.error(
      JSON.stringify({
        eventType: "telemetry_capture_failed",
        event,
        failureCode: "posthog-capture-failed",
      }),
    );
    return {
      accepted: false,
      event,
      failureCode: "posthog-capture-failed",
    };
  }
}

export function trackAgentRunStarted(
  triggerSource: AgentTriggerSource = "cron",
  correlation: Record<string, unknown> = {},
): TelemetryCaptureResult {
  return captureAnalyticsEvent("agent_run_started", {
    triggerSource,
    ...correlation,
  });
}

export function trackAgentRunCompleted(
  result: AgentRunResult,
  triggerSource: AgentTriggerSource = "cron",
): TelemetryCaptureResult {
  return captureAnalyticsEvent("agent_run_completed", {
    triggerSource,
    status: result.status,
    action: result.action ?? null,
    durationMs: result.durationMs,
    promptTokens: result.tokenUsage?.promptTokens ?? null,
    completionTokens: result.tokenUsage?.completionTokens ?? null,
    totalTokens: result.tokenUsage?.totalTokens ?? null,
    llmAttemptCount: result.tokenUsage?.attemptCount ?? null,
    llmLatencyMs: result.tokenUsage?.latencyMs ?? null,
    journalWritten: result.journalWritten ?? null,
    journalFallbackWritten: result.journalFallbackWritten ?? false,
    requestId: result.requestId ?? null,
    runId: result.runId ?? null,
    releaseId: result.releaseId ?? null,
    deploymentId: result.deploymentId ?? null,
    providerAttemptId: result.providerAttemptId ?? null,
    transactionId: result.transactionId ?? null,
    incidentId: result.incidentId ?? null,
  });
}

export function trackGuardrailTriggered(
  guardrailName: string,
  details: Record<string, unknown>,
  triggerSource: AgentTriggerSource = "cron",
): TelemetryCaptureResult {
  return captureAnalyticsEvent("guardrail_triggered", {
    triggerSource,
    guardrailName,
    ...details,
  });
}

export function trackTradeExecuted(trade: {
  direction: string;
  asset: string;
  amountUSD: number;
  executionPrice: number;
  feesUSD: number;
  pnlUSD?: number;
  requestId?: string;
  runId?: string;
  releaseId?: string;
  deploymentId?: string;
  providerAttemptId?: string | null;
  transactionId?: string;
  incidentId?: string;
}): TelemetryCaptureResult {
  return captureAnalyticsEvent("trade_executed", {
    direction: trade.direction,
    asset: trade.asset,
    amountUSD: trade.amountUSD,
    executionPrice: trade.executionPrice,
    feesUSD: trade.feesUSD,
    pnlUSD: trade.pnlUSD ?? null,
    requestId: trade.requestId ?? null,
    runId: trade.runId ?? null,
    releaseId: trade.releaseId ?? null,
    deploymentId: trade.deploymentId ?? null,
    providerAttemptId: trade.providerAttemptId ?? null,
    transactionId: trade.transactionId ?? null,
    incidentId: trade.incidentId ?? null,
  });
}

export function trackLLMTokenUsage(usage: {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  attemptCount: number;
  latencyMs: number;
  requestId?: string;
  runId?: string;
  providerAttemptId?: string | null;
}): TelemetryCaptureResult {
  return captureAnalyticsEvent("llm_token_usage", {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    attemptCount: usage.attemptCount,
    latencyMs: usage.latencyMs,
    requestId: usage.requestId ?? null,
    runId: usage.runId ?? null,
    providerAttemptId: usage.providerAttemptId ?? null,
  });
}
