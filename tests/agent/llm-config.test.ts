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
  "AZURE_CLIENT_ID",
  "DATABASE_URL",
  "POSTHOG_API_KEY",
  "CRON_SECRET",
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
    DATABASE_URL: "postgres://localhost:5432/test",
    POSTHOG_API_KEY: "phc_test",
    CRON_SECRET: "test-secret",
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
      }),
    ).toBe("krypto-prod-luna");
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
