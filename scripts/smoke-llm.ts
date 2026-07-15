/**
 * scripts/smoke-llm.ts
 *
 * Minimal no-trade LLM smoke test for Azure AI Foundry-hosted Anthropic.
 *
 * Usage:
 *   npm run smoke:llm
 *
 * Performs a single model invocation with a short timeout, prints endpoint
 * metadata without credentials, verifies a non-empty response, and exits
 * nonzero with a classified error message on failure.
 */

import "dotenv/config";
import { smokeFoundry } from "@/deployment/provider-smoke";
import { resolveFoundryBaseURL } from "@/lib/config";

function redactURL(url: string): string {
  // Replace everything between the scheme and the host with [...]
  return url.replace(/^(https?:\/\/)[^/]+/, "$1[redacted]");
}

function classifyError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  if (lower.includes("api_key") || lower.includes("authentication") || lower.includes("401") || lower.includes("403")) {
    return `AUTH_ERROR: ${message}`;
  }
  if (lower.includes("404") || lower.includes("not found") || lower.includes("deployment")) {
    return `MODEL_NOT_FOUND: ${message}`;
  }
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("econnreset") || lower.includes("enotfound")) {
    return `NETWORK_ERROR: ${message}`;
  }
  if (lower.includes("quota") || lower.includes("429") || lower.includes("rate")) {
    return `RATE_LIMIT: ${message}`;
  }
  return `UNKNOWN_ERROR: ${message}`;
}

async function main() {
  const baseURL = resolveFoundryBaseURL(process.env as Record<string, string | undefined>);
  const deployment =
    process.env.ANTHROPIC_FOUNDRY_DEPLOYMENT ?? process.env.AZURE_OPENAI_DEPLOYMENT_NAME;
  const apiVersion =
    process.env.ANTHROPIC_FOUNDRY_API_VERSION ??
    process.env.AZURE_OPENAI_API_VERSION ??
    "2024-10-21";

  console.log("🔍 smoke:llm — Azure AI Foundry Anthropic connectivity check");
  console.log(`   endpoint  : ${baseURL ? redactURL(baseURL) : "(not set)"}`);
  console.log(`   deployment: ${deployment ?? "(not set)"}`);
  console.log(`   api-version: ${apiVersion}`);
  console.log("   timeout   : 30000ms");
  console.log();

  let result;
  try {
    result = await smokeFoundry();
  } catch (err) {
    console.error(`❌ LLM invocation failed — ${classifyError(err)}`);
    process.exit(1);
  }

  console.log(
    `   tokens    : in=${result.inputTokens ?? "?"} out=${result.outputTokens ?? "?"} total=${result.totalTokens ?? "?"}`,
  );
  console.log(
    `✅ LLM responded (${result.responseLength} chars, ${result.latencyMs}ms)`,
  );
}

main().catch((err) => {
  console.error(`❌ Unexpected error — ${classifyError(err)}`);
  process.exit(1);
});
