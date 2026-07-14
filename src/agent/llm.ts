import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { resolveFoundryConfig } from "@/lib/config";
import { TradingConfigurationError } from "@/trading/errors";

let llmInstance: BaseChatModel | null = null;

const DEFAULT_FOUNDRY_API_VERSION = "2024-10-21";

/**
 * Build the LLM client for Azure AI Foundry-hosted Anthropic.
 *
 * Azure AI Foundry exposes Claude models via Anthropic's native Messages API
 * at a `services.ai.azure.com/anthropic` endpoint (preferred) or the older
 * `*.openai.azure.com/anthropic` path.  The Anthropic SDK authenticates with
 * the subscription key sent as `x-api-key`.
 *
 * Preferred env vars (set these for new deployments):
 *   ANTHROPIC_FOUNDRY_BASE_URL    – e.g. https://your-resource.services.ai.azure.com/anthropic
 *   ANTHROPIC_FOUNDRY_API_KEY     – Azure subscription key
 *   ANTHROPIC_FOUNDRY_DEPLOYMENT  – Claude model deployment name
 *   ANTHROPIC_FOUNDRY_API_VERSION – optional, defaults to 2024-10-21
 *
 * Legacy fallbacks (still accepted for already-deployed environments):
 *   AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_API_KEY + AZURE_OPENAI_DEPLOYMENT_NAME
 *   (AZURE_OPENAI_ENDPOINT has /anthropic appended automatically)
 */
export function getLLM(): BaseChatModel {
  if (!llmInstance) {
    llmInstance = buildLLM();
  }
  return llmInstance;
}

/** Exported for testing; creates a fresh instance without the singleton cache. */
export function buildLLM(): BaseChatModel {
  const config = resolveFoundryConfig(
    process.env as Record<string, string | undefined>,
  );

  if (!config) {
    throw new TradingConfigurationError(
      "LLM credentials missing or incomplete. Provide " +
        "ANTHROPIC_FOUNDRY_BASE_URL + ANTHROPIC_FOUNDRY_API_KEY + " +
        "ANTHROPIC_FOUNDRY_DEPLOYMENT, or the legacy " +
        "AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_API_KEY + AZURE_OPENAI_DEPLOYMENT_NAME.",
    );
  }

  return new ChatAnthropic({
    model: config.deployment,
    anthropicApiKey: config.apiKey,
    anthropicApiUrl: config.baseURL,
    temperature: 0,
    maxRetries: 0,
    clientOptions: {
      defaultQuery: {
        "api-version": config.apiVersion ?? DEFAULT_FOUNDRY_API_VERSION,
      },
      maxRetries: 0,
    },
  });
}
