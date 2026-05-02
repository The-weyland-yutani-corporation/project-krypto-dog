import { AzureChatOpenAI } from "@langchain/openai";

let llmInstance: AzureChatOpenAI | null = null;

export function getLLM(): AzureChatOpenAI {
  if (!llmInstance) {
    llmInstance = new AzureChatOpenAI({
      azureOpenAIApiKey: process.env.AZURE_OPENAI_API_KEY,
      azureOpenAIEndpoint: process.env.AZURE_OPENAI_ENDPOINT,
      azureOpenAIApiDeploymentName: process.env.AZURE_OPENAI_DEPLOYMENT_NAME,
      temperature: 0.2,
    });
  }
  return llmInstance;
}
