/**
 * scripts/smoke-llm.ts
 *
 * No-trade smoke test for GPT-5.6 Luna on Azure OpenAI v1.
 *
 * Usage:
 *   npm run smoke:llm
 *
 * Performs plain and strict structured-output invocations with short timeouts,
 * prints endpoint metadata without credentials, verifies a no-trade HOLD, and
 * exits nonzero with a classified error message on failure.
 */

import "dotenv/config";
import {
  smokeFoundry,
  smokeLunaStructuredOutput,
} from "@/deployment/provider-smoke";
import { resolveAzureOpenAIConfig } from "@/lib/config";

function redactURL(url: string): string {
  // Replace everything between the scheme and the host with [...]
  return url.replace(/^(https?:\/\/)[^/]+/, "$1[redacted]");
}

function classifyError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  if (
    lower.includes("credential") ||
    lower.includes("authentication") ||
    lower.includes("apikey") ||
    lower.includes("api_key") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("401") ||
    lower.includes("403")
  ) {
    return `AUTH_ERROR: ${message}`;
  }
  if (
    lower.includes("404") ||
    lower.includes("not found") ||
    lower.includes("deployment")
  ) {
    return `MODEL_NOT_FOUND: ${message}`;
  }
  if (
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("econnreset") ||
    lower.includes("enotfound")
  ) {
    return `NETWORK_ERROR: ${message}`;
  }
  if (lower.includes("quota") || lower.includes("429") || lower.includes("rate")) {
    return `RATE_LIMIT: ${message}`;
  }
  return `UNKNOWN_ERROR: ${message}`;
}

async function main() {
  const config = resolveAzureOpenAIConfig(
    process.env as Record<string, string | undefined>,
  );

  console.log("🔍 smoke:llm — Azure OpenAI GPT-5.6 Luna validation");
  console.log(
    `   endpoint  : ${config ? redactURL(config.baseURL) : "(not set)"}`,
  );
  console.log(`   deployment: ${config?.deployment ?? "(not set)"}`);
  console.log(
    `   identity  : ${process.env.NODE_ENV === "production" ? "user-assigned managed identity" : "DefaultAzureCredential (attended local smoke)"}`,
  );
  console.log("   timeout   : 30000ms");
  console.log();

  let result;
  let structured;
  try {
    [result, structured] = await Promise.all([
      smokeFoundry(),
      smokeLunaStructuredOutput(),
    ]);
  } catch (err) {
    console.error(`❌ LLM invocation failed — ${classifyError(err)}`);
    process.exit(1);
  }

  console.log(
    `   tokens    : in=${result.inputTokens ?? "?"} out=${result.outputTokens ?? "?"} total=${result.totalTokens ?? "?"}`,
  );
  console.log(
    `   structured: ${structured.action} (notional=${String(structured.notionalUSD)}, ${structured.latencyMs}ms)`,
  );
  console.log(
    `✅ LLM responded (${result.responseLength} chars, ${result.latencyMs}ms)`,
  );
}

main().catch((err) => {
  console.error(`❌ Unexpected error — ${classifyError(err)}`);
  process.exit(1);
});
