import "dotenv/config";

import { resolveAzureOpenAIConfig } from "@/lib/config";
import { runReadOnlyProviderSmoke } from "@/deployment/provider-smoke";

import {
  assertSmokeAllowed,
  isProductionLikeDbUrl,
  parseSmokeOptions,
} from "./agent-harness";

/**
 * Read-only provider smoke: exercises Foundry-hosted Azure OpenAI and Coinbase
 * only. It emits no PostHog or email events, never touches the database, and
 * cannot execute a trade. It is gated behind --allow-network-smoke, valid
 * Azure OpenAI v1 configuration, an attended Entra identity, and non-production
 * checks, and it forces the app's own harness mode to `smoke` + `shadow` for
 * the duration of the call.
 */
async function main(): Promise<void> {
  const options = parseSmokeOptions(process.argv.slice(2));
  assertSmokeAllowed(options, process.env, resolveAzureOpenAIConfig);
  if (isProductionLikeDbUrl(process.env.DATABASE_URL ?? "")) {
    throw new Error("Refusing to run against a production-looking DATABASE_URL.");
  }

  // Force the shadow, read-only posture for provider selection.
  process.env.AGENT_HARNESS_MODE = "smoke";
  process.env.ROLLOUT_MODE = "shadow";

  const result = await runReadOnlyProviderSmoke();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Provider smoke failed: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exit(1);
});
