import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  getBearerTokenProvider,
} from "@azure/identity";
import { ChatOpenAI } from "@langchain/openai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { resolveAzureOpenAIConfig } from "@/lib/config";
import { TradingConfigurationError } from "@/trading/errors";

let llmInstance: BaseChatModel | null = null;

export const AZURE_OPENAI_TOKEN_SCOPE = "https://ai.azure.com/.default";

/**
 * Build the GPT-5.6 Luna client against Azure OpenAI's v1 API.
 *
 * Production uses the explicitly selected user-assigned managed identity.
 * Local attended smoke tests use DefaultAzureCredential so a developer's
 * authenticated Azure CLI session can supply the same Entra bearer token.
 * No provider API key is accepted.
 */
export function getLLM(): BaseChatModel {
  if (!llmInstance) {
    llmInstance = buildLLM();
  }
  return llmInstance;
}

/** Exported for testing; creates a fresh instance without the singleton cache. */
export function buildLLM(): BaseChatModel {
  const config = resolveAzureOpenAIConfig(
    process.env as Record<string, string | undefined>,
  );

  if (!config) {
    throw new TradingConfigurationError(
      "Azure OpenAI configuration missing or incomplete. Provide " +
        "AZURE_OPENAI_BASE_URL + AZURE_OPENAI_DEPLOYMENT_NAME.",
    );
  }

  if (process.env.NODE_ENV === "production" && !config.clientId) {
    throw new TradingConfigurationError(
      "AZURE_CLIENT_ID is required in production to select the user-assigned managed identity.",
    );
  }

  const credential =
    process.env.NODE_ENV === "production"
      ? new ManagedIdentityCredential(config.clientId!)
      : config.clientId
        ? new DefaultAzureCredential({
            managedIdentityClientId: config.clientId,
          })
        : new DefaultAzureCredential();
  const tokenProvider = getBearerTokenProvider(
    credential,
    AZURE_OPENAI_TOKEN_SCOPE,
  );

  return new ChatOpenAI({
    model: config.deployment,
    // Azure's request model is the deployment name, so LangChain cannot infer
    // that it is a GPT-5 reasoning model. Pass the Responses API parameter
    // explicitly rather than setting a temperature unsupported by Luna.
    modelKwargs: {
      reasoning: { effort: "low" },
    },
    useResponsesApi: true,
    maxRetries: 0,
    configuration: {
      baseURL: config.baseURL,
      apiKey: tokenProvider,
      maxRetries: 0,
    },
  });
}
