import { PostHog } from "posthog-node";

let client: PostHog | null = null;

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
    flushAt: 1,
    flushInterval: 0,
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

export async function flushPostHog(): Promise<void> {
  if (client) {
    await client.flush();
  }
}

export async function shutdownPostHog(): Promise<void> {
  if (client) {
    await client.shutdown();
    client = null;
  }
}
