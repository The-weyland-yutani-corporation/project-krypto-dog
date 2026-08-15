import "dotenv/config";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { AIProjectClient } from "@azure/ai-projects";
import type { AgentVersion, PromptAgentDefinition } from "@azure/ai-projects";
import { DefaultAzureCredential } from "@azure/identity";
import { z } from "zod/v4";
import {
  createFoundryDecisionInvoker,
  createOpenAIResponseTransport,
} from "@/agent/foundry-agent";
import { resolveAzureFoundryAgentConfig } from "@/lib/config";
import { tradeDecisionWireSchema } from "@/trading/types";
import {
  KRYPT0_DECISION_AGENT_DESCRIPTION,
  KRYPT0_DECISION_AGENT_ENVIRONMENTS,
  type KryptoAgentEnvironment,
} from "../foundry/agents/krypto-decision/config";

type Command = "deploy" | "show" | "smoke";

interface Arguments {
  command: Command;
  environment: KryptoAgentEnvironment;
  projectEndpoint: string;
  version?: string;
}

const instructionsPath = fileURLToPath(
  new URL(
    "../foundry/agents/krypto-decision/instructions.md",
    import.meta.url,
  ),
);

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseArguments(argv: string[]): Arguments {
  const command = argv[0] as Command | undefined;
  if (!command || !["deploy", "show", "smoke"].includes(command)) {
    throw new Error(
      "Usage: npm run foundry:agent -- <deploy|show|smoke> " +
        "--environment <dev|prod> [--project-endpoint <url>] [--version <version>]",
    );
  }
  const environment = optionValue(argv, "--environment");
  if (environment !== "dev" && environment !== "prod") {
    throw new Error("--environment must be dev or prod");
  }

  const target = KRYPT0_DECISION_AGENT_ENVIRONMENTS[environment];
  const version = optionValue(argv, "--version");
  if (command === "deploy" && version) {
    throw new Error("--version cannot be used with deploy");
  }
  const projectEndpoint =
    optionValue(argv, "--project-endpoint") ??
    process.env.AZURE_FOUNDRY_PROJECT_ENDPOINT ??
    (process.env.FOUNDRY_ACCOUNT_NAME
      ? `https://${process.env.FOUNDRY_ACCOUNT_NAME}.services.ai.azure.com/api/projects/${target.projectName}`
      : undefined);
  if (!projectEndpoint) {
    throw new Error(
      "Provide --project-endpoint, AZURE_FOUNDRY_PROJECT_ENDPOINT, or FOUNDRY_ACCOUNT_NAME.",
    );
  }

  const resolved = resolveAzureFoundryAgentConfig({
    AZURE_FOUNDRY_PROJECT_ENDPOINT: projectEndpoint,
    AZURE_FOUNDRY_AGENT_NAME: target.agentName,
    AZURE_FOUNDRY_AGENT_VERSION: version ?? "pending",
  });
  if (!resolved) {
    throw new Error("The Foundry project endpoint or agent binding is invalid.");
  }
  const endpointProject = new URL(resolved.projectEndpoint).pathname
    .split("/")
    .at(-1);
  if (endpointProject !== target.projectName) {
    throw new Error(
      `Endpoint project ${endpointProject ?? "(missing)"} does not match ${target.projectName}.`,
    );
  }

  return {
    command,
    environment,
    projectEndpoint: resolved.projectEndpoint,
    version,
  };
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as Record<string, unknown>;
  return record.statusCode === 404 || record.status === 404;
}

async function getAgentVersion(
  client: AIProjectClient,
  agentName: string,
): Promise<AgentVersion | undefined> {
  try {
    return (await client.agents.get(agentName)).versions.latest;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

function sourceHash(
  definition: PromptAgentDefinition,
  description: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize({ definition, description })))
    .digest("hex");
}

function asPromptDefinition(
  definition: AgentVersion["definition"],
): PromptAgentDefinition | undefined {
  return definition.kind === "prompt" &&
    "model" in definition &&
    "instructions" in definition
    ? (definition as PromptAgentDefinition)
    : undefined;
}

function definitionsMatch(
  actual: PromptAgentDefinition | undefined,
  expected: PromptAgentDefinition,
): boolean {
  return (
    actual !== undefined &&
    JSON.stringify(canonicalize(actual)) ===
      JSON.stringify(canonicalize(expected))
  );
}

function assertAgentVersion(
  version: AgentVersion,
  definition: PromptAgentDefinition,
  sourceSha256: string,
): void {
  if (
    version.description !== KRYPT0_DECISION_AGENT_DESCRIPTION ||
    version.metadata?.source_sha256 !== sourceSha256 ||
    !definitionsMatch(asPromptDefinition(version.definition), definition)
  ) {
    throw new Error(
      `Agent ${version.name}@${version.version} does not exactly match the reviewed source definition.`,
    );
  }
}

async function desiredDefinition(
  environment: KryptoAgentEnvironment,
): Promise<{
  definition: PromptAgentDefinition;
  sourceSha256: string;
}> {
  const target = KRYPT0_DECISION_AGENT_ENVIRONMENTS[environment];
  const instructions = (await readFile(instructionsPath, "utf8")).trim();
  const definition: PromptAgentDefinition = {
    kind: "prompt",
    model: target.modelDeployment,
    instructions,
    reasoning: { effort: "low" },
    tools: [],
    text: {
      format: {
        type: "json_schema",
        name: "trade_decision",
        schema: z.toJSONSchema(tradeDecisionWireSchema),
        strict: true,
      },
    },
  };
  return {
    definition,
    sourceSha256: sourceHash(
      definition,
      KRYPT0_DECISION_AGENT_DESCRIPTION,
    ),
  };
}

async function deploy(
  client: AIProjectClient,
  environment: KryptoAgentEnvironment,
): Promise<AgentVersion> {
  const target = KRYPT0_DECISION_AGENT_ENVIRONMENTS[environment];
  const desired = await desiredDefinition(environment);
  const current = await getAgentVersion(client, target.agentName);
  const currentDefinition = current
    ? asPromptDefinition(current.definition)
    : undefined;
  if (
    current &&
    current.metadata?.source_sha256 === desired.sourceSha256 &&
    current.description === KRYPT0_DECISION_AGENT_DESCRIPTION &&
    definitionsMatch(currentDefinition, desired.definition)
  ) {
    assertAgentVersion(
      current,
      desired.definition,
      desired.sourceSha256,
    );
    return current;
  }

  const created = await client.agents.createVersion(
    target.agentName,
    desired.definition,
    {
      description: KRYPT0_DECISION_AGENT_DESCRIPTION,
      metadata: {
        environment,
        project: "project-krypto",
        safety_boundary: "read-only-intent",
        source_sha256: desired.sourceSha256,
      },
    },
  );
  const persisted = await client.agents.getVersion(
    target.agentName,
    created.version,
  );
  assertAgentVersion(
    persisted,
    desired.definition,
    desired.sourceSha256,
  );
  return persisted;
}

async function smoke(
  client: AIProjectClient,
  projectEndpoint: string,
  environment: KryptoAgentEnvironment,
  version: string,
) {
  const target = KRYPT0_DECISION_AGENT_ENVIRONMENTS[environment];
  const invoker = createFoundryDecisionInvoker(
    createOpenAIResponseTransport(client.getOpenAIClient({ maxRetries: 0 })),
    {
      projectEndpoint,
      agentName: target.agentName,
      agentVersion: version,
    },
  );
  const result = await invoker(
    JSON.stringify({
      instruction:
        "No-trade deployment smoke. Return HOLD and do not propose or execute a trade.",
      eligibleActions: {
        hold: true,
        buy: null,
        sell: null,
      },
    }),
    AbortSignal.timeout(60_000),
  );
  if (
    result.decision.action !== "HOLD" ||
    result.decision.notionalUSD !== null
  ) {
    throw new Error("No-trade smoke did not return HOLD with null notionalUSD.");
  }
  return result;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const target = KRYPT0_DECISION_AGENT_ENVIRONMENTS[args.environment];
  const client = new AIProjectClient(
    args.projectEndpoint,
    new DefaultAzureCredential(),
  );

  if (args.command === "show") {
    const agent = await client.agents.get(target.agentName);
    const definition = asPromptDefinition(agent.versions.latest.definition);
    if (!definition) {
      throw new Error(`Agent ${target.agentName} is not a prompt agent.`);
    }
    console.log(
      JSON.stringify(
        {
          environment: args.environment,
          project: target.projectName,
          agent: agent.name,
          state: agent.state,
          version: agent.versions.latest.version,
          status: agent.versions.latest.status,
          model: definition.model,
        },
        null,
        2,
      ),
    );
    return;
  }

  const version =
    args.command === "deploy"
      ? await deploy(client, args.environment)
      : await getAgentVersion(client, target.agentName);
  if (!version) {
    throw new Error(`Agent ${target.agentName} does not exist.`);
  }
  const requestedVersion = args.version ?? version.version;
  if (args.version && args.version !== version.version) {
    await client.agents.getVersion(target.agentName, args.version);
  }
  const smokeResult = await smoke(
    client,
    args.projectEndpoint,
    args.environment,
    requestedVersion,
  );
  console.log(
    JSON.stringify(
      {
        environment: args.environment,
        project: target.projectName,
        agent: target.agentName,
        version: requestedVersion,
        model: target.modelDeployment,
        action: smokeResult.decision.action,
        notionalUSD: smokeResult.decision.notionalUSD,
        tokenUsage: smokeResult.tokenUsage,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
