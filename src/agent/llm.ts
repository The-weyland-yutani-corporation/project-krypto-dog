import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

let llmInstance: BaseChatModel | null = null;

const DEFAULT_AZURE_API_VERSION = "2024-10-21";

/**
 * Build the LLM client.
 *
 * Project Krypto runs against an Azure AI Foundry resource (the endpoint is on
 * the `*.openai.azure.com` domain, but that domain now also hosts non-OpenAI
 * partner models such as Anthropic Claude under `/anthropic/v1/messages`).
 *
 * Because Azure exposes the partner-model surface using Anthropic's native
 * Messages API — *not* the OpenAI Chat Completions API — we authenticate with
 * the Anthropic SDK pointed at the Azure base URL. The Azure subscription key
 * is sent as `x-api-key` (which is what the Anthropic SDK does by default when
 * given `anthropicApiKey`).
 *
 * If you ever switch back to a real OpenAI deployment on this resource, wire
 * `AzureChatOpenAI` here instead and key off the deployment name prefix.
 */
export function getLLM(): BaseChatModel {
  if (!llmInstance) {
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const apiKey = process.env.AZURE_OPENAI_API_KEY;
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT_NAME;

    if (!endpoint || !apiKey || !deployment) {
      throw new Error(
        "AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, and AZURE_OPENAI_DEPLOYMENT_NAME are all required",
      );
    }

    const apiVersion =
      process.env.AZURE_OPENAI_API_VERSION ?? DEFAULT_AZURE_API_VERSION;
    const baseURL = `${endpoint.replace(/\/$/, "")}/anthropic`;

    llmInstance = new ChatAnthropic({
      model: deployment,
      anthropicApiKey: apiKey,
      anthropicApiUrl: baseURL,
      clientOptions: {
        defaultQuery: { "api-version": apiVersion },
      },
    });
  }
  return llmInstance;
}
