import { AIProjectClient } from "@azure/ai-projects";
import type OpenAI from "openai";
import { createAzureCredential } from "@/agent/azure-credential";
import {
  resolveAzureFoundryAgentConfig,
  type AzureFoundryAgentConfig,
} from "@/lib/config";
import {
  tradeDecisionSchema,
  type TradeDecision,
} from "@/trading/types";
import {
  AgentBindingMismatchError,
  TradingConfigurationError,
} from "@/trading/errors";

export interface FoundryAgentReference {
  type: "agent_reference";
  name: string;
  version: string;
}

interface FoundryResponseUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface FoundryAgentResponse {
  status: string;
  outputText: string;
  usage?: FoundryResponseUsage;
  agentReference?: FoundryAgentReference;
  errorMessage?: string;
}

export interface FoundryResponseRequest {
  input: string;
  agentReference: FoundryAgentReference;
  signal: AbortSignal;
}

export type FoundryResponseTransport = (
  request: FoundryResponseRequest,
) => Promise<FoundryAgentResponse>;

export interface FoundryDecisionInvocation {
  decision: TradeDecision;
  tokenUsage: FoundryResponseUsage;
}

export type FoundryDecisionInvoker = (
  prompt: string,
  signal: AbortSignal,
) => Promise<FoundryDecisionInvocation>;

let decisionInvoker: FoundryDecisionInvoker | null = null;

function sanitizeBindingPart(value: string, maximumLength: number): string {
  return value
    .replace(/[^\x20-\x7E]/g, "?")
    .replace(/[^A-Za-z0-9._-]/g, "?")
    .slice(0, maximumLength);
}

export function safeBindingLabel(
  reference: Pick<FoundryAgentReference, "name" | "version"> | undefined,
): string {
  if (!reference) return "missing";
  return `${sanitizeBindingPart(reference.name, 128)}@${sanitizeBindingPart(reference.version, 64)}`;
}

function readAgentReference(value: unknown): FoundryAgentReference | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const reference = value as Record<string, unknown>;
  if (
    reference.type !== "agent_reference" ||
    typeof reference.name !== "string" ||
    typeof reference.version !== "string"
  ) {
    return undefined;
  }
  return {
    type: reference.type,
    name: reference.name,
    version: reference.version,
  };
}

function timeoutAbortReason(signal: AbortSignal): Error | undefined {
  if (!signal.aborted) return undefined;
  const reason = signal.reason;
  if (
    typeof reason === "object" &&
    reason !== null &&
    "name" in reason &&
    reason.name === "TimeoutError"
  ) {
    if (reason instanceof Error) return reason;
    const timeout = new Error("Foundry agent invocation timed out.");
    timeout.name = "TimeoutError";
    return timeout;
  }
  return undefined;
}

export function createOpenAIResponseTransport(
  client: OpenAI,
): FoundryResponseTransport {
  return async (request) => {
    const response = await (async () => {
      try {
        return await client.responses.create(
          {
            input: request.input,
            max_output_tokens: 1_024,
            store: false,
          },
          {
            body: {
              agent_reference: request.agentReference,
            },
            maxRetries: 0,
            signal: request.signal,
          },
        );
      } catch (error) {
        const timeout = timeoutAbortReason(request.signal);
        if (timeout) throw timeout;
        throw error;
      }
    })();
    const azureResponse = response as typeof response & {
      agent_reference?: unknown;
    };

    return {
      status: response.status ?? "unknown",
      outputText: response.output_text,
      usage: response.usage
        ? {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            totalTokens: response.usage.total_tokens,
          }
        : undefined,
      agentReference: readAgentReference(azureResponse.agent_reference),
      errorMessage: response.error?.message,
    };
  };
}

export function createFoundryDecisionInvoker(
  transport: FoundryResponseTransport,
  config: AzureFoundryAgentConfig,
): FoundryDecisionInvoker {
  const expectedReference: FoundryAgentReference = {
    type: "agent_reference",
    name: config.agentName,
    version: config.agentVersion,
  };

  return async (prompt, signal) => {
    const response = await transport({
      input: prompt,
      agentReference: expectedReference,
      signal,
    });

    if (response.status !== "completed") {
      throw new Error(
        response.errorMessage
          ? `Foundry agent response ${response.status}: ${response.errorMessage}`
          : `Foundry agent response did not complete: ${response.status}`,
      );
    }
    if (
      response.agentReference?.name !== expectedReference.name ||
      response.agentReference.version !== expectedReference.version
    ) {
      throw new AgentBindingMismatchError(
        safeBindingLabel(expectedReference),
        safeBindingLabel(response.agentReference),
      );
    }

    const parsed = tradeDecisionSchema.parse(JSON.parse(response.outputText));
    return {
      decision: parsed,
      tokenUsage: response.usage ?? {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
    };
  };
}

export function buildFoundryDecisionInvoker(): FoundryDecisionInvoker {
  const config = resolveAzureFoundryAgentConfig(
    process.env as Record<string, string | undefined>,
  );
  if (!config) {
    throw new TradingConfigurationError(
      "Foundry Agent configuration missing or incomplete. Provide " +
        "AZURE_FOUNDRY_PROJECT_ENDPOINT + AZURE_FOUNDRY_AGENT_NAME + " +
        "AZURE_FOUNDRY_AGENT_VERSION.",
    );
  }

  const project = new AIProjectClient(
    config.projectEndpoint,
    createAzureCredential(config.clientId),
  );
  const client = project.getOpenAIClient({ maxRetries: 0 });
  return createFoundryDecisionInvoker(
    createOpenAIResponseTransport(client),
    config,
  );
}

export function getFoundryDecisionInvoker(): FoundryDecisionInvoker {
  if (!decisionInvoker) {
    decisionInvoker = buildFoundryDecisionInvoker();
  }
  return decisionInvoker;
}
