/**
 * One authoritative synchronous execution envelope.
 *
 * The 180-second application window is partitioned rather than treated as a
 * single provider timeout. Provider work is bounded to 125 seconds in
 * aggregate, database policy/execution receives 20 seconds, terminal
 * persistence and owned-lease cleanup receive 15 seconds, cancellation and
 * response handling receive 10 seconds, and the final 10 seconds are slack.
 * Normal work must stop at operationalDeadlineAt. Terminal database work may
 * use terminalDeadlineAt, but never the response or slack reserves.
 */
export const COINBASE_PROVIDER_BUDGET_MS = 20_000;
export const FOUNDRY_PROVIDER_BUDGET_MS = 80_000;
export const ACS_PROVIDER_BUDGET_MS = 20_000;
export const POSTHOG_PROVIDER_BUDGET_MS = 5_000;
export const PROVIDER_AGGREGATE_BUDGET_MS = 125_000;
export const DB_POLICY_EXECUTION_RESERVE_MS = 20_000;
export const TERMINAL_PERSISTENCE_RESERVE_MS = 15_000;
export const CANCELLATION_RESPONSE_RESERVE_MS = 10_000;
export const DEADLINE_SLACK_MS = 10_000;
export const APP_ABSOLUTE_DEADLINE_MS = 180_000;
/** @deprecated Use TERMINAL_PERSISTENCE_RESERVE_MS. */
export const TERMINAL_CLEANUP_RESERVE_MS =
  TERMINAL_PERSISTENCE_RESERVE_MS;
export const SCHEDULER_HTTP_TIMEOUT_MS = 210_000;
export const CONTAINER_APPS_INGRESS_TIMEOUT_MS = 240_000;
export const SCHEDULER_JOB_TIMEOUT_MS = 270_000;
export const RUN_LEASE_DURATION_MS = 300_000;

export type ProviderName = "coinbase" | "foundry" | "posthog" | "acs";

export const PROVIDER_TIME_BUDGET_MS: Readonly<Record<ProviderName, number>> =
  Object.freeze({
    coinbase: COINBASE_PROVIDER_BUDGET_MS,
    foundry: FOUNDRY_PROVIDER_BUDGET_MS,
    posthog: POSTHOG_PROVIDER_BUDGET_MS,
    acs: ACS_PROVIDER_BUDGET_MS,
  });

export class ExecutionDeadlineError extends Error {
  readonly code = "execution-deadline-exhausted";
  providerAttemptId?: string;

  constructor(
    readonly deadlineAt: Date,
    readonly phase: string,
    message = `Execution deadline exhausted before ${phase}`,
  ) {
    super(message);
    this.name = "ExecutionDeadlineError";
  }
}

export class ProviderBudgetError extends Error {
  readonly code = "provider-budget-exhausted";
  providerAttemptId?: string;

  constructor(
    readonly provider: ProviderName,
    readonly kind: "time" | "daily-requests",
    message = `${provider} ${kind} budget exhausted`,
  ) {
    super(message);
    this.name = "ProviderBudgetError";
  }
}

export class AdmissionCapacityError extends Error {
  readonly code = "admission-capacity-exhausted";

  constructor(message = "Process run admission capacity is exhausted") {
    super(message);
    this.name = "AdmissionCapacityError";
  }
}

export interface ExecutionClock {
  now(): number;
  delay(ms: number, signal: AbortSignal): Promise<void>;
}

export const systemExecutionClock: ExecutionClock = {
  now: Date.now,
  async delay(ms, signal) {
    if (signal.aborted) throw signal.reason;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  },
};

export interface ExecutionDeadline {
  readonly startedAt: Date;
  readonly deadlineAt: Date;
  readonly operationalDeadlineAt: Date;
  readonly terminalDeadlineAt: Date;
  readonly responseDeadlineAt: Date;
  readonly signal: AbortSignal;
  now(): Date;
  remainingMs(includeCleanupReserve?: boolean): number;
  assertActive(phase: string, includeCleanupReserve?: boolean): void;
  signalFor(
    phase: string,
    maximumMs?: number,
    includeCleanupReserve?: boolean,
  ): AbortSignal;
  delay(ms: number, phase: string): Promise<void>;
  dispose(): void;
}

export interface CreateExecutionDeadlineOptions {
  startedAt?: Date;
  deadlineAt?: Date;
  signal?: AbortSignal;
  clock?: ExecutionClock;
}

export function createExecutionDeadline(
  options: CreateExecutionDeadlineOptions = {},
): ExecutionDeadline {
  const clock = options.clock ?? systemExecutionClock;
  const startedMs = options.startedAt?.getTime() ?? clock.now();
  const deadlineMs =
    options.deadlineAt?.getTime() ?? startedMs + APP_ABSOLUTE_DEADLINE_MS;
  if (!Number.isFinite(startedMs) || !Number.isFinite(deadlineMs)) {
    throw new Error("Execution deadline dates must be finite");
  }
  if (deadlineMs <= startedMs) {
    throw new ExecutionDeadlineError(
      new Date(deadlineMs),
      "admission",
      "Execution deadline must be after the start time",
    );
  }
  const responseDeadlineMs = deadlineMs - DEADLINE_SLACK_MS;
  const terminalDeadlineMs =
    responseDeadlineMs - CANCELLATION_RESPONSE_RESERVE_MS;
  const operationalDeadlineMs =
    terminalDeadlineMs - TERMINAL_PERSISTENCE_RESERVE_MS;
  if (operationalDeadlineMs <= startedMs) {
    throw new ExecutionDeadlineError(
      new Date(deadlineMs),
      "admission",
      "Execution deadline is too short for required cleanup reserves",
    );
  }
  const controller = new AbortController();
  const deadlineTimer = setTimeout(
    () =>
      controller.abort(
        new ExecutionDeadlineError(new Date(deadlineMs), "absolute deadline"),
      ),
    Math.max(0, deadlineMs - clock.now()),
  );
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  if (options.signal?.aborted) abortFromCaller();

  function remainingMs(includeCleanupReserve = false): number {
    const end = includeCleanupReserve
      ? terminalDeadlineMs
      : operationalDeadlineMs;
    return Math.max(0, end - clock.now());
  }

  function assertActive(
    phase: string,
    includeCleanupReserve = false,
  ): void {
    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      if (reason instanceof ExecutionDeadlineError) throw reason;
      throw new ExecutionDeadlineError(
        new Date(deadlineMs),
        phase,
        `Execution cancelled before ${phase}`,
      );
    }
    if (remainingMs(includeCleanupReserve) <= 0) {
      throw new ExecutionDeadlineError(new Date(deadlineMs), phase);
    }
  }

  function signalFor(
    phase: string,
    maximumMs = Number.POSITIVE_INFINITY,
    includeCleanupReserve = false,
  ): AbortSignal {
    assertActive(phase, includeCleanupReserve);
    const timeoutMs = Math.min(
      maximumMs,
      remainingMs(includeCleanupReserve),
    );
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return controller.signal;
    }
    return AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs))),
    ]);
  }

  return {
    startedAt: new Date(startedMs),
    deadlineAt: new Date(deadlineMs),
    operationalDeadlineAt: new Date(operationalDeadlineMs),
    terminalDeadlineAt: new Date(terminalDeadlineMs),
    responseDeadlineAt: new Date(responseDeadlineMs),
    signal: controller.signal,
    now: () => new Date(clock.now()),
    remainingMs,
    assertActive,
    signalFor,
    async delay(ms, phase) {
      assertActive(phase);
      if (ms < 0 || !Number.isFinite(ms) || ms >= remainingMs()) {
        throw new ExecutionDeadlineError(new Date(deadlineMs), phase);
      }
      await clock.delay(ms, signalFor(phase, ms + 1));
      assertActive(phase);
    },
    dispose() {
      clearTimeout(deadlineTimer);
      options.signal?.removeEventListener("abort", abortFromCaller);
    },
  };
}

export function parseRetryAfterMs(
  value: string | null | undefined,
  nowMs = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }
  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return undefined;
  return Math.max(0, dateMs - nowMs);
}

export function retryAfterFromError(
  error: unknown,
  nowMs = Date.now(),
): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as Record<string, unknown>;
  const direct = record.retryAfter;
  if (typeof direct === "number" && Number.isFinite(direct) && direct >= 0) {
    return Math.ceil(direct * 1_000);
  }
  const headers =
    record.headers &&
    typeof record.headers === "object" &&
    "get" in record.headers &&
    typeof (record.headers as { get?: unknown }).get === "function"
      ? (record.headers as { get(name: string): string | null })
      : undefined;
  return parseRetryAfterMs(headers?.get("retry-after"), nowMs);
}
