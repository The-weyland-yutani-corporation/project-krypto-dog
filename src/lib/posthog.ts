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
        if (prop === "shutdown" || prop === "shutdownAsync") {
          return () => Promise.resolve();
        }
        return () => {};
      },
    });
    client = noOp;
    return client;
  }

  client = new PostHog(apiKey, { host });
  return client;
}

export async function shutdownPostHog(): Promise<void> {
  if (client) {
    await client.shutdown();
    client = null;
  }
}
