export class TradingDomainError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "TradingDomainError";
  }
}

export class TradeAuthorizationError extends TradingDomainError {
  constructor(message: string) {
    super(message, "authorization-rejected");
    this.name = "TradeAuthorizationError";
  }
}

export class TradeConflictError extends TradingDomainError {
  constructor(message: string) {
    super(message, "trade-conflict");
    this.name = "TradeConflictError";
  }
}

export class AccountingError extends TradingDomainError {
  constructor(message: string) {
    super(message, "accounting-error");
    this.name = "AccountingError";
  }
}

export class TradingConfigurationError extends TradingDomainError {
  constructor(message: string) {
    super(message, "configuration-error");
    this.name = "TradingConfigurationError";
  }
}

export class RequiredRolloutModeError extends TradingConfigurationError {
  constructor(
    readonly expectedMode: string,
    readonly actualMode: string,
  ) {
    super(
      `Required rollout mode ${expectedMode} does not match ${actualMode}`,
    );
    this.name = "RequiredRolloutModeError";
  }
}

export type AgentErrorType =
  | "CONFIGURATION"
  | "MARKET_DATA"
  | "LLM_AUTH"
  | "LLM_RATE_LIMIT"
  | "LLM_TIMEOUT"
  | "LLM_MODEL"
  | "LLM_BINDING"
  | "AUTHORIZATION"
  | "CONFLICT"
  | "PERSISTENCE"
  | "DEADLINE"
  | "PROVIDER_BUDGET"
  | "UNKNOWN";

export class AgentUpstreamError extends Error {
  attemptCount?: number;
  latencyMs?: number;
  retryAfterMs?: number;

  constructor(
    readonly errorType: AgentErrorType,
    message: string,
    readonly httpStatus: number,
    readonly retryable: boolean,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AgentUpstreamError";
  }
}

export class AgentBindingMismatchError extends AgentUpstreamError {
  constructor(
    readonly expectedBinding: string,
    readonly actualBinding: string,
  ) {
    super(
      "LLM_BINDING",
      `Foundry agent binding mismatch: expected ${expectedBinding}, received ${actualBinding}.`,
      502,
      false,
    );
    this.name = "AgentBindingMismatchError";
  }
}

function readErrorField(
  error: unknown,
  field: "status" | "code" | "name" | "headers" | "retryAfter",
): unknown {
  return typeof error === "object" && error !== null && field in error
    ? (error as Record<string, unknown>)[field]
    : undefined;
}

export function classifyLlmError(error: unknown): AgentUpstreamError {
  if (error instanceof AgentUpstreamError) return error;

  const message =
    error instanceof Error ? error.message : "Unknown LLM provider error";
  const status = readErrorField(error, "status");
  const code = readErrorField(error, "code");
  const name = readErrorField(error, "name");

  if (status === 401 || status === 403) {
    return new AgentUpstreamError("LLM_AUTH", message, 502, false, error);
  }
  if (status === 429) {
    const classified = new AgentUpstreamError(
      "LLM_RATE_LIMIT",
      message,
      503,
      true,
      error,
    );
    const direct = readErrorField(error, "retryAfter");
    if (typeof direct === "number" && Number.isFinite(direct) && direct >= 0) {
      classified.retryAfterMs = Math.ceil(direct * 1_000);
    } else {
      const headers = readErrorField(error, "headers");
      if (
        typeof headers === "object" &&
        headers !== null &&
        "get" in headers &&
        typeof (headers as { get?: unknown }).get === "function"
      ) {
        const value = (headers as { get(name: string): string | null }).get(
          "retry-after",
        );
        if (value) {
          const seconds = Number(value);
          const date = Date.parse(value);
          classified.retryAfterMs = Number.isFinite(seconds)
            ? Math.max(0, Math.ceil(seconds * 1_000))
            : Number.isFinite(date)
              ? Math.max(0, date - Date.now())
              : undefined;
        }
      }
    }
    return classified;
  }
  if (
    status === 408 ||
    status === 504 ||
    code === "ETIMEDOUT" ||
    name === "AbortError" ||
    name === "TimeoutError" ||
    /\b(timeout|timed out)\b/i.test(message)
  ) {
    return new AgentUpstreamError("LLM_TIMEOUT", message, 504, true, error);
  }

  return new AgentUpstreamError("LLM_MODEL", message, 502, false, error);
}
