import {
  ACS_PROVIDER_BUDGET_MS,
  APP_ABSOLUTE_DEADLINE_MS,
  COINBASE_PROVIDER_BUDGET_MS,
  CONTAINER_APPS_INGRESS_TIMEOUT_MS,
  CANCELLATION_RESPONSE_RESERVE_MS,
  DB_POLICY_EXECUTION_RESERVE_MS,
  DEADLINE_SLACK_MS,
  ExecutionDeadlineError,
  FOUNDRY_PROVIDER_BUDGET_MS,
  POSTHOG_PROVIDER_BUDGET_MS,
  PROVIDER_AGGREGATE_BUDGET_MS,
  RUN_LEASE_DURATION_MS,
  SCHEDULER_HTTP_TIMEOUT_MS,
  SCHEDULER_JOB_TIMEOUT_MS,
  TERMINAL_CLEANUP_RESERVE_MS,
  TERMINAL_PERSISTENCE_RESERVE_MS,
  createExecutionDeadline,
  parseRetryAfterMs,
  type ExecutionClock,
} from "@/lib/execution-envelope";

describe("bounded execution envelope", () => {
  it("pins the ordered numeric contract", () => {
    expect({
      coinbase: COINBASE_PROVIDER_BUDGET_MS,
      foundry: FOUNDRY_PROVIDER_BUDGET_MS,
      acs: ACS_PROVIDER_BUDGET_MS,
      posthog: POSTHOG_PROVIDER_BUDGET_MS,
      aggregate: PROVIDER_AGGREGATE_BUDGET_MS,
      app: APP_ABSOLUTE_DEADLINE_MS,
      schedulerHttp: SCHEDULER_HTTP_TIMEOUT_MS,
      ingress: CONTAINER_APPS_INGRESS_TIMEOUT_MS,
      schedulerJob: SCHEDULER_JOB_TIMEOUT_MS,
      lease: RUN_LEASE_DURATION_MS,
      db: DB_POLICY_EXECUTION_RESERVE_MS,
      terminal: TERMINAL_PERSISTENCE_RESERVE_MS,
      response: CANCELLATION_RESPONSE_RESERVE_MS,
      slack: DEADLINE_SLACK_MS,
    }).toEqual({
      coinbase: 20_000,
      foundry: 80_000,
      acs: 20_000,
      posthog: 5_000,
      aggregate: 125_000,
      app: 180_000,
      schedulerHttp: 210_000,
      ingress: 240_000,
      schedulerJob: 270_000,
      lease: 300_000,
      db: 20_000,
      terminal: 15_000,
      response: 10_000,
      slack: 10_000,
    });
    expect(
      PROVIDER_AGGREGATE_BUDGET_MS +
        DB_POLICY_EXECUTION_RESERVE_MS +
        TERMINAL_PERSISTENCE_RESERVE_MS +
        CANCELLATION_RESPONSE_RESERVE_MS +
        DEADLINE_SLACK_MS,
    ).toBe(APP_ABSOLUTE_DEADLINE_MS);
    expect(APP_ABSOLUTE_DEADLINE_MS).toBeLessThan(
      SCHEDULER_HTTP_TIMEOUT_MS,
    );
    expect(SCHEDULER_HTTP_TIMEOUT_MS).toBeLessThan(
      CONTAINER_APPS_INGRESS_TIMEOUT_MS,
    );
    expect(CONTAINER_APPS_INGRESS_TIMEOUT_MS).toBeLessThan(
      SCHEDULER_JOB_TIMEOUT_MS,
    );
    expect(SCHEDULER_JOB_TIMEOUT_MS).toBeLessThan(
      RUN_LEASE_DURATION_MS,
    );
  });

  it("reserves terminal cleanup and cancels operational work deterministically", () => {
    let now = 1_000;
    const clock: ExecutionClock = {
      now: () => now,
      delay: async () => undefined,
    };
    const deadline = createExecutionDeadline({
      startedAt: new Date(now),
      clock,
    });
    expect(deadline.operationalDeadlineAt.getTime()).toBe(
      now +
        PROVIDER_AGGREGATE_BUDGET_MS +
        DB_POLICY_EXECUTION_RESERVE_MS,
    );
    expect(deadline.terminalDeadlineAt.getTime()).toBe(
      deadline.operationalDeadlineAt.getTime() +
        TERMINAL_CLEANUP_RESERVE_MS,
    );
    now = deadline.operationalDeadlineAt.getTime();
    expect(() => deadline.assertActive("trade")).toThrow(
      ExecutionDeadlineError,
    );
    expect(() =>
      deadline.assertActive("terminal persistence", true),
    ).not.toThrow();
    deadline.dispose();
  });

  it("parses Retry-After seconds and dates", () => {
    expect(parseRetryAfterMs("2", 0)).toBe(2_000);
    expect(
      parseRetryAfterMs("Thu, 01 Jan 1970 00:00:03 GMT", 1_000),
    ).toBe(2_000);
    expect(parseRetryAfterMs("invalid", 0)).toBeUndefined();
  });
});
