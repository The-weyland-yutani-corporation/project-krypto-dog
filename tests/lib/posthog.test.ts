const mockCapture = jest.fn();

jest.mock("posthog-node", () => ({
  PostHog: jest.fn(() => ({
    capture: mockCapture,
    flush: jest.fn(async () => undefined),
    shutdown: jest.fn(async () => undefined),
  })),
}));

import {
  capturePostHog,
  flushPostHog,
  reservePostHogBudget,
  shutdownPostHog,
} from "@/lib/posthog";
import { createExecutionDeadline } from "@/lib/execution-envelope";

describe("PostHog deployment environment", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalPostHogEnvironment = process.env.POSTHOG_ENVIRONMENT;

  beforeEach(() => {
    mockCapture.mockClear();
    process.env.POSTHOG_API_KEY = "phc_test";
    process.env.POSTHOG_ENVIRONMENT = "dev";
  });

  afterEach(async () => {
    await shutdownPostHog();
    process.env.NODE_ENV = originalNodeEnv;
    if (originalPostHogEnvironment === undefined) {
      delete process.env.POSTHOG_ENVIRONMENT;
    } else {
      process.env.POSTHOG_ENVIRONMENT = originalPostHogEnvironment;
    }
  });

  it("adds the deployment environment to every event", () => {
    capturePostHog({
      distinctId: "krypto-agent",
      event: "deployment_smoke",
      properties: { smokeId: "smoke-1" },
    });

    expect(mockCapture).toHaveBeenCalledWith({
      distinctId: "krypto-agent",
      event: "deployment_smoke",
      properties: {
        smokeId: "smoke-1",
        deployment_environment: "dev",
      },
    });
  });

  it("fails closed in production without an explicit environment", () => {
    process.env.NODE_ENV = "production";
    delete process.env.POSTHOG_ENVIRONMENT;

    expect(() =>
      capturePostHog({
        distinctId: "krypto-agent",
        event: "deployment_smoke",
      }),
    ).toThrow("POSTHOG_ENVIRONMENT must be dev or prod");
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it("reserves one request budget before capture and reuses it at flush", async () => {
    const deadline = createExecutionDeadline();
    const store = {
      consume: jest.fn().mockResolvedValue(1),
    };
    await expect(
      reservePostHogBudget({ deadline, budgetStore: store }),
    ).resolves.toBe(true);
    capturePostHog({
      distinctId: "krypto-agent",
      event: "bounded_run",
    });
    await flushPostHog({ deadline, budgetStore: store });
    expect(store.consume).toHaveBeenCalledTimes(1);
    deadline.dispose();
  });
});
