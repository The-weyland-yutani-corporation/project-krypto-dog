import {
  getBearerTokenProvider,
} from "@azure/identity";
import { ChatOpenAI } from "@langchain/openai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AZURE_OPENAI_TOKEN_SCOPE,
  createAzureCredential,
} from "@/agent/azure-credential";
import { resolveAzureOpenAIConfig } from "@/lib/config";
import { TradingConfigurationError } from "@/trading/errors";

let llmInstance: BaseChatModel | null = null;

export { AZURE_OPENAI_TOKEN_SCOPE } from "@/agent/azure-credential";

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

  const credential = createAzureCredential(config.clientId);
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
      // openai@6 ClientOptions.apiKey accepts an async ApiKeySetter and awaits
      // it before every request. This is the v1-client token path; the legacy
      // azureADTokenProvider option belongs to AzureOpenAI/AzureChatOpenAI's
      // dated deployment endpoint client.
      apiKey: tokenProvider,
      maxRetries: 0,
    },
  });
}
