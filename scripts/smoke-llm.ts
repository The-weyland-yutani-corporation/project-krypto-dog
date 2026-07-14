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
import { buildLLM } from "../src/agent/llm.js";
import { resolveFoundryBaseURL } from "../src/lib/config.js";
import { HumanMessage } from "@langchain/core/messages";

const TIMEOUT_MS = 30_000;

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
  console.log(`   timeout   : ${TIMEOUT_MS}ms`);
  console.log();

  let llm;
  try {
    llm = buildLLM();
  } catch (err) {
    console.error(`❌ LLM construction failed — ${classifyError(err)}`);
    process.exit(1);
  }

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Request timed out")), TIMEOUT_MS),
  );

  let response;
  try {
    response = await Promise.race([
      llm.invoke([new HumanMessage("Reply with exactly: OK")]),
      timeoutPromise,
    ]);
  } catch (err) {
    console.error(`❌ LLM invocation failed — ${classifyError(err)}`);
    process.exit(1);
  }

  // Extract response text
  const content =
    typeof response.content === "string"
      ? response.content
      : JSON.stringify(response.content);

  if (!content || content.trim().length === 0) {
    console.error("❌ LLM returned an empty response");
    process.exit(1);
  }

  // Surface token usage metadata without printing credentials
  const usage = (response as unknown as { usage_metadata?: { input_tokens?: number; output_tokens?: number; total_tokens?: number } }).usage_metadata;
  if (usage) {
    console.log(`   tokens    : in=${usage.input_tokens ?? "?"} out=${usage.output_tokens ?? "?"} total=${usage.total_tokens ?? "?"}`);
  }

  console.log(`✅ LLM responded (${content.length} chars): ${content.trim().slice(0, 120)}`);
}

main().catch((err) => {
  console.error(`❌ Unexpected error — ${classifyError(err)}`);
  process.exit(1);
});
