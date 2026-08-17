/**
 * Azure OpenAI v1, managed-identity, and Luna structured-smoke coverage.
 * All provider calls are mocked; this suite never requests an Azure token.
 */

import { jest } from "@jest/globals";
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  getBearerTokenProvider,
} from "@azure/identity";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatOpenAI } from "@langchain/openai";
import OpenAI from "openai";

jest.mock("@azure/identity", () => ({
  DefaultAzureCredential: jest.fn(),
  ManagedIdentityCredential: jest.fn(),
  getBearerTokenProvider: jest.fn(),
}));

import {
  AZURE_OPENAI_TOKEN_SCOPE,
  buildLLM,
} from "@/agent/llm";
import { configuredModelVersion } from "@/agent/run-flow";
import { smokeLunaStructuredOutput } from "@/deployment/provider-smoke";
import {
  resolveAzureFoundryAgentConfig,
  resolveAzureOpenAIConfig,
  validateEnv,
} from "@/lib/config";
import { tradeDecisionSchema } from "@/trading/types";

const TEST_CLIENT_ID = "11111111-1111-4111-8111-111111111111";
const ALL_ENV_KEYS = [
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_DEPLOYMENT",
  "ANTHROPIC_FOUNDRY_API_VERSION",
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_API_VERSION",
  "OPENAI_API_KEY",
  "AZURE_OPENAI_BASE_URL",
  "AZURE_OPENAI_DEPLOYMENT_NAME",
  "AZURE_FOUNDRY_PROJECT_ENDPOINT",
  "AZURE_FOUNDRY_AGENT_NAME",
  "AZURE_FOUNDRY_AGENT_VERSION",
  "AZURE_CLIENT_ID",
  "DATABASE_URL",
  "DATABASE_POOL_MAX",
  "AGENT_RUN_ADMISSION_CAPACITY",
  "COINBASE_DAILY_REQUEST_BUDGET",
  "FOUNDRY_DAILY_REQUEST_BUDGET",
  "POSTHOG_DAILY_REQUEST_BUDGET",
  "ACS_DAILY_REQUEST_BUDGET",
  "RELEASE_SHA",
  "IMAGE_DIGEST",
  "EXECUTION_CONTRACT_VERSION",
  "POSTHOG_API_KEY",
  "POSTHOG_ENVIRONMENT",
  "CRON_SECRET",
  "APP_ORIGIN",
  "ADMIN_PASSWORD",
  "ADMIN_SESSION_SECRET",
  "AZURE_COMMUNICATION_CONNECTION_STRING",
  "AZURE_COMMUNICATION_EMAIL_SENDER",
  "ALERT_EMAIL_TO",
  "NODE_ENV",
] as const;

function withEnv(
  overrides: Record<string, string | undefined>,
  callback: () => void,
): void {
  const saved = Object.fromEntries(
    ALL_ENV_KEYS.map((key) => [key, process.env[key]]),
  );

  for (const key of ALL_ENV_KEYS) {
    delete process.env[key];
  }
  Object.assign(process.env, {
    NODE_ENV: "test",
    AZURE_OPENAI_BASE_URL:
      "https://test-resource.openai.azure.com/openai/v1",
    AZURE_OPENAI_DEPLOYMENT_NAME: "krypto-test-luna",
    AZURE_FOUNDRY_PROJECT_ENDPOINT:
      "https://test-resource.services.ai.azure.com/api/projects/krypto-test-agents",
    AZURE_FOUNDRY_AGENT_NAME: "krypto-test-decision",
    AZURE_FOUNDRY_AGENT_VERSION: "1",
    DATABASE_URL: "postgres://localhost:5432/test",
    DATABASE_POOL_MAX: "1",
    AGENT_RUN_ADMISSION_CAPACITY: "1",
    COINBASE_DAILY_REQUEST_BUDGET: "1000",
    FOUNDRY_DAILY_REQUEST_BUDGET: "200",
    POSTHOG_DAILY_REQUEST_BUDGET: "2000",
    ACS_DAILY_REQUEST_BUDGET: "100",
    RELEASE_SHA: "a".repeat(40),
    IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
    EXECUTION_CONTRACT_VERSION: "bounded-sync-v1",
    POSTHOG_API_KEY: "phc_test",
    POSTHOG_ENVIRONMENT: "dev",
    CRON_SECRET: "test-secret",
    APP_ORIGIN: "https://krypto.example.com",
    ADMIN_PASSWORD: "test-password",
    ADMIN_SESSION_SECRET: "test-admin-session-secret",
    AZURE_COMMUNICATION_CONNECTION_STRING:
      "endpoint=https://test.communication.azure.com/;accesskey=test-key",
    AZURE_COMMUNICATION_EMAIL_SENDER: "DoNotReply@test.azurecomm.net",
    ALERT_EMAIL_TO: "operator@example.com",
  });

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    callback();
  } finally {
    for (const key of ALL_ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("resolveAzureFoundryAgentConfig", () => {
  it("resolves an immutable environment-specific agent binding", () => {
    expect(
      resolveAzureFoundryAgentConfig({
        AZURE_FOUNDRY_PROJECT_ENDPOINT:
          "https://resource.services.ai.azure.com/api/projects/krypto-dev-agents/",
        AZURE_FOUNDRY_AGENT_NAME: "krypto-dev-decision",
        AZURE_FOUNDRY_AGENT_VERSION: "1",
        AZURE_CLIENT_ID: TEST_CLIENT_ID,
      }),
    ).toEqual({
      projectEndpoint:
        "https://resource.services.ai.azure.com/api/projects/krypto-dev-agents",
      agentName: "krypto-dev-decision",
      agentVersion: "1",
      clientId: TEST_CLIENT_ID,
    });
  });

  it.each([
    {
      AZURE_FOUNDRY_PROJECT_ENDPOINT:
        "https://resource.openai.azure.com/openai/v1",
      AZURE_FOUNDRY_AGENT_NAME: "krypto-dev-decision",
      AZURE_FOUNDRY_AGENT_VERSION: "1",
    },
    {
      AZURE_FOUNDRY_PROJECT_ENDPOINT:
        "https://resource.services.ai.azure.com/api/projects/krypto-dev-agents",
      AZURE_FOUNDRY_AGENT_NAME: "krypto-dev-decision",
    },
  ])("rejects an incomplete or non-project binding", (env) => {
    expect(resolveAzureFoundryAgentConfig(env)).toBeUndefined();
  });
});

describe("resolveAzureOpenAIConfig", () => {
  it("resolves and normalizes the explicit Azure OpenAI v1 configuration", () => {
    expect(
      resolveAzureOpenAIConfig({
        AZURE_OPENAI_BASE_URL:
          "https://resource.openai.azure.com/openai/v1/",
        AZURE_OPENAI_DEPLOYMENT_NAME: "krypto-dev-luna",
        AZURE_CLIENT_ID: TEST_CLIENT_ID,
      }),
    ).toEqual({
      baseURL: "https://resource.openai.azure.com/openai/v1",
      deployment: "krypto-dev-luna",
      clientId: TEST_CLIENT_ID,
    });
  });

  it("accepts the Foundry services host with Azure OpenAI v1 semantics", () => {
    expect(
      resolveAzureOpenAIConfig({
        AZURE_OPENAI_BASE_URL:
          "https://resource.services.ai.azure.com/openai/v1",
        AZURE_OPENAI_DEPLOYMENT_NAME: "krypto-prod-luna",
      }),
    ).toEqual({
      baseURL: "https://resource.services.ai.azure.com/openai/v1",
      deployment: "krypto-prod-luna",
      clientId: undefined,
    });
  });

  it.each([
    [
      "a malformed URL",
      {
        AZURE_OPENAI_BASE_URL: "not-a-url",
        AZURE_OPENAI_DEPLOYMENT_NAME: "krypto-dev-luna",
      },
    ],
    [
      "a missing deployment",
      {
        AZURE_OPENAI_BASE_URL:
          "https://resource.openai.azure.com/openai/v1",
      },
    ],
    [
      "a raw resource endpoint",
      {
        AZURE_OPENAI_BASE_URL: "https://resource.openai.azure.com",
        AZURE_OPENAI_DEPLOYMENT_NAME: "krypto-dev-luna",
      },
    ],
    [
      "the public OpenAI API",
      {
        AZURE_OPENAI_BASE_URL: "https://api.openai.com/v1",
        AZURE_OPENAI_DEPLOYMENT_NAME: "krypto-dev-luna",
      },
    ],
    [
      "deprecated Anthropic configuration",
      {
        ANTHROPIC_FOUNDRY_BASE_URL:
          "https://resource.services.ai.azure.com/anthropic",
        ANTHROPIC_FOUNDRY_API_KEY: "deprecated-key",
        ANTHROPIC_FOUNDRY_DEPLOYMENT: "deprecated-claude",
      },
    ],
    [
      "an old Azure endpoint and API key",
      {
        AZURE_OPENAI_ENDPOINT: "https://resource.openai.azure.com",
        AZURE_OPENAI_API_KEY: "deprecated-key",
        AZURE_OPENAI_DEPLOYMENT_NAME: "krypto-dev-luna",
      },
    ],
  ])("does not resolve %s", (_label, env) => {
    expect(resolveAzureOpenAIConfig(env)).toBeUndefined();
  });
});

describe("configuredModelVersion", () => {
  it("records the configured environment-specific Luna deployment", () => {
    expect(
      configuredModelVersion({
        AZURE_OPENAI_DEPLOYMENT_NAME: "krypto-prod-luna",
        AZURE_FOUNDRY_AGENT_NAME: "krypto-prod-decision",
        AZURE_FOUNDRY_AGENT_VERSION: "1",
      }),
    ).toBe("krypto-prod-decision@1");
  });

  it("does not record a deprecated Anthropic deployment", () => {
    expect(
      configuredModelVersion({
        ANTHROPIC_FOUNDRY_DEPLOYMENT: "deprecated-claude",
      }),
    ).toBeNull();
  });
});

describe("validateEnv", () => {
  let consoleError: jest.SpiedFunction<typeof console.error>;

  beforeEach(() => {
    consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it("accepts local attended authentication without a managed identity ID", () => {
    withEnv({}, () => {
      expect(() => validateEnv()).not.toThrow();
    });
  });

  it("does not require direct-model diagnostics for application startup", () => {
    withEnv(
      {
        AZURE_OPENAI_BASE_URL: undefined,
        AZURE_OPENAI_DEPLOYMENT_NAME: undefined,
      },
      () => {
        expect(() => validateEnv()).not.toThrow();
      },
    );
  });

  it("rejects a malformed Foundry project URL", () => {
    expect(
      resolveAzureFoundryAgentConfig({
        AZURE_FOUNDRY_PROJECT_ENDPOINT: "not-a-url",
        AZURE_FOUNDRY_AGENT_NAME: "krypto-dev-decision",
        AZURE_FOUNDRY_AGENT_VERSION: "1",
      }),
    ).toBeUndefined();
  });

  it("requires a complete immutable Foundry agent binding", () => {
    withEnv(
      {
        AZURE_FOUNDRY_AGENT_VERSION: undefined,
      },
      () => {
        expect(() => validateEnv()).toThrow("Invalid environment variables");
      },
    );
  });

  it("accepts production with a selected user-assigned managed identity", () => {
    withEnv(
      {
        NODE_ENV: "production",
        AZURE_CLIENT_ID: TEST_CLIENT_ID,
        AZURE_OPENAI_DEPLOYMENT_NAME: "krypto-prod-luna",
      },
      () => {
        expect(() => validateEnv()).not.toThrow();
      },
    );
  });

  it.each([
    ["database pool", { DATABASE_POOL_MAX: "2" }],
    ["run admission", { AGENT_RUN_ADMISSION_CAPACITY: "2" }],
    ["bounded contract", { EXECUTION_CONTRACT_VERSION: undefined }],
  ])("rejects unsafe production %s configuration", (_name, overrides) => {
    withEnv(
      {
        NODE_ENV: "production",
        AZURE_CLIENT_ID: TEST_CLIENT_ID,
        ...overrides,
      },
      () => {
        expect(() => validateEnv()).toThrow("Invalid environment variables");
      },
    );
  });

  it.each([
    [
      "the deployment is missing",
      { AZURE_OPENAI_DEPLOYMENT_NAME: undefined },
    ],
    [
      "the base URL omits /openai/v1",
      {
        AZURE_OPENAI_BASE_URL:
          "https://resource.openai.azure.com/openai",
      },
    ],
    [
      "the endpoint is not HTTPS",
      {
        AZURE_OPENAI_BASE_URL:
          "http://resource.openai.azure.com/openai/v1",
      },
    ],
    [
      "the endpoint contains a dated API-version query",
      {
        AZURE_OPENAI_BASE_URL:
          "https://resource.openai.azure.com/openai/v1?api-version=2026-07-09",
      },
    ],
  ])("rejects configuration when %s", (_label, overrides) => {
    withEnv(overrides, () => {
      expect(() => validateEnv()).toThrow("Invalid environment variables");
    });
  });

  it("requires AZURE_CLIENT_ID in production", () => {
    withEnv(
      {
        NODE_ENV: "production",
        AZURE_CLIENT_ID: undefined,
      },
      () => {
        expect(() => validateEnv()).toThrow("Invalid environment variables");
      },
    );
  });

  it("does not let an API key replace managed identity configuration", () => {
    withEnv(
      {
        NODE_ENV: "production",
        AZURE_CLIENT_ID: undefined,
        AZURE_OPENAI_API_KEY: "must-not-be-used",
      },
      () => {
        expect(() => validateEnv()).toThrow("Invalid environment variables");
      },
    );
  });

  it.each([
    "AZURE_COMMUNICATION_CONNECTION_STRING",
    "AZURE_COMMUNICATION_EMAIL_SENDER",
    "ALERT_EMAIL_TO",
    "ADMIN_SESSION_SECRET",
    "POSTHOG_ENVIRONMENT",
    "APP_ORIGIN",
  ])("requires %s in production", (name) => {
    withEnv(
      {
        NODE_ENV: "production",
        AZURE_CLIENT_ID: TEST_CLIENT_ID,
        [name]: undefined,
      },
      () => {
        expect(() => validateEnv()).toThrow("Invalid environment variables");
      },
    );
  });

  it.each([
    "http://krypto.example.com",
    "https://krypto.example.com/admin",
    "https://user:password@krypto.example.com",
  ])("rejects unsafe production APP_ORIGIN %s", (appOrigin) => {
    withEnv(
      {
        NODE_ENV: "production",
        AZURE_CLIENT_ID: TEST_CLIENT_ID,
        APP_ORIGIN: appOrigin,
      },
      () => {
        expect(() => validateEnv()).toThrow("Invalid environment variables");
      },
    );
  });
});

type InspectableChatOpenAI = BaseChatModel & {
  model: string;
  modelKwargs?: Record<string, unknown>;
  temperature?: number;
  useResponsesApi: boolean;
  caller: { maxRetries: number };
  invocationParams(options?: Record<string, unknown>): {
    model: string;
    reasoning?: { effort?: string };
    temperature?: number;
  };
  clientConfig: {
    apiKey?: unknown;
    baseURL?: string;
    maxRetries?: number;
  };
};

describe("buildLLM", () => {
  const tokenProvider = jest.fn(async () => "test-entra-token");
  const mockedDefaultCredential = jest.mocked(DefaultAzureCredential);
  const mockedManagedIdentityCredential = jest.mocked(
    ManagedIdentityCredential,
  );
  const mockedGetBearerTokenProvider = jest.mocked(getBearerTokenProvider);

  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetBearerTokenProvider.mockReturnValue(tokenProvider);
  });

  it("openai v1 awaits the async token setter before building Authorization", async () => {
    const fetchImpl = jest.fn(async (_input: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer test-entra-token");
      return Response.json({ object: "list", data: [], has_more: false });
    });
    const client = new OpenAI({
      apiKey: tokenProvider,
      baseURL: "https://test-resource.openai.azure.com/openai/v1",
      fetch: fetchImpl as typeof fetch,
    });

    await client.models.list();

    expect(tokenProvider).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("builds a BaseChatModel-compatible GPT-5.6 Luna client for Azure OpenAI v1", () => {
    withEnv(
      {
        AZURE_OPENAI_DEPLOYMENT_NAME: "krypto-dev-luna",
        AZURE_OPENAI_API_KEY: "must-not-be-used",
        OPENAI_API_KEY: "also-must-not-be-used",
      },
      () => {
        const model = buildLLM() as InspectableChatOpenAI;

        expect(model).toBeInstanceOf(ChatOpenAI);
        expect(typeof model.invoke).toBe("function");
        expect(typeof model.withStructuredOutput).toBe("function");
        expect(model.model).toBe("krypto-dev-luna");
        expect(model.clientConfig.baseURL).toBe(
          "https://test-resource.openai.azure.com/openai/v1",
        );
        expect(model.clientConfig.apiKey).toBe(tokenProvider);
        expect(model.clientConfig.apiKey).not.toBe("must-not-be-used");
        expect(model.useResponsesApi).toBe(true);
        expect(model.modelKwargs).toEqual({
          reasoning: { effort: "low" },
        });
        expect(model.temperature).toBeUndefined();
        expect(model.invocationParams({})).toMatchObject({
          model: "krypto-dev-luna",
          reasoning: { effort: "low" },
          temperature: undefined,
        });
        expect(() =>
          model.withStructuredOutput(tradeDecisionSchema, {
            name: "trade_decision",
            includeRaw: true,
          }),
        ).not.toThrow();
        expect(model.caller.maxRetries).toBe(0);
        expect(model.clientConfig.maxRetries).toBe(0);
      },
    );

    expect(mockedDefaultCredential).toHaveBeenCalledWith();
    expect(mockedManagedIdentityCredential).not.toHaveBeenCalled();
    expect(mockedGetBearerTokenProvider).toHaveBeenCalledWith(
      expect.anything(),
      AZURE_OPENAI_TOKEN_SCOPE,
    );
    expect(tokenProvider).not.toHaveBeenCalled();
  });

  it("uses the selected user-assigned managed identity in production", () => {
    withEnv(
      {
        NODE_ENV: "production",
        AZURE_CLIENT_ID: TEST_CLIENT_ID,
        AZURE_OPENAI_DEPLOYMENT_NAME: "krypto-prod-luna",
      },
      () => {
        const model = buildLLM() as InspectableChatOpenAI;
        expect(model.model).toBe("krypto-prod-luna");
      },
    );

    expect(mockedManagedIdentityCredential).toHaveBeenCalledWith(
      TEST_CLIENT_ID,
    );
    expect(mockedDefaultCredential).not.toHaveBeenCalled();
  });

  it("passes AZURE_CLIENT_ID through DefaultAzureCredential for local smoke", () => {
    withEnv({ AZURE_CLIENT_ID: TEST_CLIENT_ID }, () => {
      buildLLM();
    });

    expect(mockedDefaultCredential).toHaveBeenCalledWith({
      managedIdentityClientId: TEST_CLIENT_ID,
    });
    expect(mockedManagedIdentityCredential).not.toHaveBeenCalled();
  });

  it("rejects incomplete or non-v1 provider configuration", () => {
    withEnv({ AZURE_OPENAI_BASE_URL: undefined }, () => {
      expect(() => buildLLM()).toThrow(
        /Azure OpenAI configuration missing or incomplete/,
      );
    });
  });

  it("rejects production without the user-assigned identity selector", () => {
    withEnv(
      {
        NODE_ENV: "production",
        AZURE_CLIENT_ID: undefined,
      },
      () => {
        expect(() => buildLLM()).toThrow(/AZURE_CLIENT_ID is required/);
      },
    );
  });
});

describe("smokeLunaStructuredOutput", () => {
  it("proves production-like no-trade JSON-schema parsing without Azure calls", async () => {
    const invoke = jest.fn(
      async (
        _messages: Array<{ content: unknown }>,
        _options: { signal: AbortSignal },
      ) => ({
        action: "HOLD" as const,
        notionalUSD: null,
        reasoning: "Provider validation only.",
      }),
    );
    const withStructuredOutput = jest.fn(() => ({ invoke }));
    const model = { withStructuredOutput } as unknown as BaseChatModel;

    const result = await smokeLunaStructuredOutput(1234, model);

    expect(result).toEqual({
      latencyMs: expect.any(Number),
      action: "HOLD",
      notionalUSD: null,
    });
    expect(withStructuredOutput).toHaveBeenCalledWith(
      expect.anything(),
      {
        name: "no_trade_smoke",
        method: "jsonSchema",
        strict: true,
      },
    );
    const [messages, options] = invoke.mock.calls[0]!;
    expect(String(messages[0].content)).toMatch(/read-only provider validation/i);
    expect(String(messages[0].content)).toMatch(/do not propose or execute/i);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects any parsed smoke response that is not HOLD", async () => {
    const model = {
      withStructuredOutput: jest.fn(() => ({
        invoke: jest.fn(async () => ({
          action: "BUY",
          notionalUSD: 10,
          reasoning: "Invalid smoke response.",
        })),
      })),
    } as unknown as BaseChatModel;

    await expect(
      smokeLunaStructuredOutput(1234, model),
    ).rejects.toThrow();
  });
});
