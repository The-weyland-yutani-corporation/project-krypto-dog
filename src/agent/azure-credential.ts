import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from "@azure/identity";
import { TradingConfigurationError } from "@/trading/errors";

export const AZURE_OPENAI_TOKEN_SCOPE = "https://ai.azure.com/.default";

export function createAzureCredential(clientId?: string) {
  if (process.env.NODE_ENV === "production") {
    if (!clientId) {
      throw new TradingConfigurationError(
        "AZURE_CLIENT_ID is required in production to select the user-assigned managed identity.",
      );
    }
    return new ManagedIdentityCredential(clientId);
  }

  return clientId
    ? new DefaultAzureCredential({ managedIdentityClientId: clientId })
    : new DefaultAzureCredential();
}
