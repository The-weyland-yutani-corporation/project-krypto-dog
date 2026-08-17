import { PostHog } from "posthog-node";
import {
  POSTHOG_PROVIDER_BUDGET_MS,
  ProviderBudgetError,
  type ExecutionDeadline,
} from "@/lib/execution-envelope";
import {
  consumeProviderRequestBudget,
  type ProviderBudgetStore,
} from "@/lib/provider-budgets";

let client: PostHog | null = null;
const reservedDeadlines = new WeakSet<ExecutionDeadline>();

export function getPostHogClient(): PostHog {
  if (client) return client;

  const apiKey = process.env.POSTHOG_API_KEY;
  const host = process.env.POSTHOG_HOST || "https://us.i.posthog.com";

  if (!apiKey) {
    console.warn(
      "⚠️ POSTHOG_API_KEY not set — using no-op PostHog client (console logging)"
    );
    const noOp = new Proxy({} as PostHog, {
      get(_target, prop) {
        if (prop === "capture") {
          return (event: Record<string, unknown>) =>
            console.log("[PostHog no-op] capture:", JSON.stringify(event));
        }
        if (
          prop === "flush" ||
          prop === "shutdown" ||
          prop === "shutdownAsync"
        ) {
          return () => Promise.resolve();
        }
        return () => {};
      },
    });
    client = noOp;
    return client;
  }

  client = new PostHog(apiKey, {
    host,
    // Provider admission/budgeting happens at the explicit bounded flush.
    flushAt: 1_000,
    flushInterval: 0,
    requestTimeout: POSTHOG_PROVIDER_BUDGET_MS,
  });
  return client;
}

export function capturePostHog(
  message: Parameters<PostHog["capture"]>[0],
): void {
  const deploymentEnvironment = process.env.POSTHOG_ENVIRONMENT;
  if (
    process.env.NODE_ENV === "production" &&
    deploymentEnvironment !== "dev" &&
    deploymentEnvironment !== "prod"
  ) {
    throw new Error("POSTHOG_ENVIRONMENT must be dev or prod in production.");
  }
  getPostHogClient().capture({
    ...message,
    properties: {
      ...(message.properties ?? {}),
      deployment_environment: deploymentEnvironment ?? "local",
    },
  });
}

export async function reservePostHogBudget(options: {
  deadline: ExecutionDeadline;
  budgetStore?: ProviderBudgetStore;
}): Promise<boolean> {
  if (!process.env.POSTHOG_API_KEY || reservedDeadlines.has(options.deadline)) {
    return false;
  }
  options.deadline.assertActive("PostHog budget reservation");
  await consumeProviderRequestBudget("posthog", {
    deadline: options.deadline,
    store: options.budgetStore,
  });
  reservedDeadlines.add(options.deadline);
  return true;
}

export async function flushPostHog(options: {
  deadline?: ExecutionDeadline;
  budgetStore?: ProviderBudgetStore;
} = {}): Promise<void> {
  if (client) {
    options.deadline?.assertActive("PostHog flush");
    if (
      options.deadline &&
      !reservedDeadlines.has(options.deadline)
    ) {
      await reservePostHogBudget(options as {
        deadline: ExecutionDeadline;
        budgetStore?: ProviderBudgetStore;
      });
    }
    const flush = client.flush();
    if (!options.deadline) {
      await flush;
      return;
    }
    const signal = options.deadline.signalFor(
      "PostHog flush",
      POSTHOG_PROVIDER_BUDGET_MS,
    );
    try {
      await Promise.race([
        flush,
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () =>
              reject(
                signal.reason ??
                  new ProviderBudgetError("posthog", "time"),
              ),
            { once: true },
          );
        }),
      ]);
      options.deadline.assertActive("PostHog flush completion");
    } finally {
      reservedDeadlines.delete(options.deadline);
    }
  }
}

export async function shutdownPostHog(): Promise<void> {
  if (client) {
    await client.shutdown();
    client = null;
  }
}
