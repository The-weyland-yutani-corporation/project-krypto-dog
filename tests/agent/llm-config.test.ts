/**
 * Tests for Foundry Anthropic config validation and LLM construction.
 */

// Do NOT import setup.ts here — we manage env ourselves per test.

import { jest } from "@jest/globals";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  const ALL_KEYS = [
    "ANTHROPIC_FOUNDRY_BASE_URL",
    "ANTHROPIC_FOUNDRY_API_KEY",
    "ANTHROPIC_FOUNDRY_DEPLOYMENT",
    "ANTHROPIC_FOUNDRY_API_VERSION",
    "AZURE_OPENAI_ENDPOINT",
    "AZURE_OPENAI_API_KEY",
    "AZURE_OPENAI_DEPLOYMENT_NAME",
    "AZURE_OPENAI_API_VERSION",
    "CDP_API_KEY_NAME",
    "CDP_API_KEY_PRIVATE_KEY",
    "DATABASE_URL",
    "POSTHOG_API_KEY",
    "CRON_SECRET",
    "ADMIN_PASSWORD",
    "ADMIN_SESSION_SECRET",
    "NODE_ENV",
  ];

  for (const key of ALL_KEYS) saved[key] = process.env[key];
  // Set a sensible baseline for non-LLM required vars
  process.env.DATABASE_URL = "postgres://localhost:5432/test";
  process.env.POSTHOG_API_KEY = "phc_test";
  process.env.CRON_SECRET = "test-secret";
  process.env.ADMIN_PASSWORD = "test-password";
  process.env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  // Clear CDP (should not be required)
  delete process.env.CDP_API_KEY_NAME;
  delete process.env.CDP_API_KEY_PRIVATE_KEY;
  // Clear all LLM vars
  for (const k of ALL_KEYS.filter(k => k.includes("FOUNDRY") || k.includes("AZURE_OPENAI"))) {
    delete process.env[k];
  }
  // Apply requested vars
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ---------------------------------------------------------------------------
// resolveFoundryBaseURL
// ---------------------------------------------------------------------------

describe("resolveFoundryBaseURL", () => {
  let resolveFoundryBaseURL: (env: Record<string, string | undefined>) => string | undefined;

  beforeAll(async () => {
    const mod = await import("@/lib/config");
    resolveFoundryBaseURL = mod.resolveFoundryBaseURL;
  });

  it("returns ANTHROPIC_FOUNDRY_BASE_URL when set", () => {
    const url = resolveFoundryBaseURL({
      ANTHROPIC_FOUNDRY_BASE_URL: "https://my-res.services.ai.azure.com/anthropic",
    });
    expect(url).toBe("https://my-res.services.ai.azure.com/anthropic");
  });

  it("derives base URL from AZURE_OPENAI_ENDPOINT by appending /anthropic", () => {
    const url = resolveFoundryBaseURL({
      AZURE_OPENAI_ENDPOINT: "https://my-res.openai.azure.com/",
    });
    expect(url).toBe("https://my-res.openai.azure.com/anthropic");
  });

  it("strips trailing slash from AZURE_OPENAI_ENDPOINT before appending", () => {
    const url = resolveFoundryBaseURL({
      AZURE_OPENAI_ENDPOINT: "https://my-res.openai.azure.com",
    });
    expect(url).toBe("https://my-res.openai.azure.com/anthropic");
  });

  it("does not append /anthropic twice for a legacy endpoint", () => {
    const url = resolveFoundryBaseURL({
      AZURE_OPENAI_ENDPOINT:
        "https://my-res.openai.azure.com/anthropic/",
    });
    expect(url).toBe("https://my-res.openai.azure.com/anthropic");
  });

  it("prefers ANTHROPIC_FOUNDRY_BASE_URL over AZURE_OPENAI_ENDPOINT", () => {
    const url = resolveFoundryBaseURL({
      ANTHROPIC_FOUNDRY_BASE_URL: "https://new.services.ai.azure.com/anthropic",
      AZURE_OPENAI_ENDPOINT: "https://old.openai.azure.com/",
    });
    expect(url).toBe("https://new.services.ai.azure.com/anthropic");
  });

  it("returns undefined when neither variable is set", () => {
    const url = resolveFoundryBaseURL({});
    expect(url).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// validateEnv
// ---------------------------------------------------------------------------

describe("validateEnv", () => {
  let validateEnv: () => ReturnType<typeof import("@/lib/config")["validateEnv"]>;

  beforeAll(async () => {
    const mod = await import("@/lib/config");
    validateEnv = mod.validateEnv;
  });

  it("passes with preferred ANTHROPIC_FOUNDRY_* vars", () => {
    withEnv(
      {
        ANTHROPIC_FOUNDRY_BASE_URL: "https://res.services.ai.azure.com/anthropic",
        ANTHROPIC_FOUNDRY_API_KEY: "key",
        ANTHROPIC_FOUNDRY_DEPLOYMENT: "claude-3-7",
      },
      () => {
        expect(() => validateEnv()).not.toThrow();
      },
    );
  });

  it("passes with legacy AZURE_OPENAI_* vars", () => {
    withEnv(
      {
        AZURE_OPENAI_ENDPOINT: "https://res.openai.azure.com/",
        AZURE_OPENAI_API_KEY: "key",
        AZURE_OPENAI_DEPLOYMENT_NAME: "claude-stub",
      },
      () => {
        expect(() => validateEnv()).not.toThrow();
      },
    );
  });

  it("throws when no LLM credentials are provided", () => {
    withEnv({}, () => {
      expect(() => validateEnv()).toThrow("Invalid environment variables");
    });
  });

  it("throws when the preferred base URL is not a Foundry Anthropic endpoint", () => {
    withEnv(
      {
        ANTHROPIC_FOUNDRY_BASE_URL:
          "https://res.openai.azure.com/anthropic",
        ANTHROPIC_FOUNDRY_API_KEY: "key",
        ANTHROPIC_FOUNDRY_DEPLOYMENT: "claude-stub",
      },
      () => {
        expect(() => validateEnv()).toThrow("Invalid environment variables");
      },
    );
  });

  it("throws when preferred credentials omit the base URL", () => {
    withEnv(
      {
        ANTHROPIC_FOUNDRY_API_KEY: "key",
        ANTHROPIC_FOUNDRY_DEPLOYMENT: "claude-stub",
      },
      () => {
        expect(() => validateEnv()).toThrow("Invalid environment variables");
      },
    );
  });

  it("does not mix partial preferred credentials with legacy credentials", () => {
    withEnv(
      {
        ANTHROPIC_FOUNDRY_API_KEY: "preferred-key",
        AZURE_OPENAI_ENDPOINT: "https://res.openai.azure.com/",
        AZURE_OPENAI_API_KEY: "legacy-key",
        AZURE_OPENAI_DEPLOYMENT_NAME: "legacy-deployment",
      },
      () => {
        expect(() => validateEnv()).toThrow("Invalid environment variables");
      },
    );
  });

  it("does NOT require CDP credentials", () => {
    withEnv(
      {
        ANTHROPIC_FOUNDRY_BASE_URL:
          "https://res.services.ai.azure.com/anthropic",
        ANTHROPIC_FOUNDRY_API_KEY: "key",
        ANTHROPIC_FOUNDRY_DEPLOYMENT: "claude-stub",
        CDP_API_KEY_NAME: undefined,
        CDP_API_KEY_PRIVATE_KEY: undefined,
      },
      () => {
        expect(() => validateEnv()).not.toThrow();
      },
    );
  });

  it("requires a dedicated admin session secret in production", () => {
    withEnv(
      {
        NODE_ENV: "production",
        ADMIN_SESSION_SECRET: undefined,
        ANTHROPIC_FOUNDRY_BASE_URL:
          "https://res.services.ai.azure.com/anthropic",
        ANTHROPIC_FOUNDRY_API_KEY: "key",
        ANTHROPIC_FOUNDRY_DEPLOYMENT: "claude-stub",
      },
      () => {
        expect(() => validateEnv()).toThrow("Invalid environment variables");
      },
    );
  });
});

// ---------------------------------------------------------------------------
// buildLLM
// ---------------------------------------------------------------------------

describe("buildLLM", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("throws when no credentials are set", async () => {
    const savedKeys = [
      "ANTHROPIC_FOUNDRY_BASE_URL", "ANTHROPIC_FOUNDRY_API_KEY", "ANTHROPIC_FOUNDRY_DEPLOYMENT",
      "AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_DEPLOYMENT_NAME",
    ];
    const saved: Record<string, string | undefined> = {};
    for (const k of savedKeys) { saved[k] = process.env[k]; delete process.env[k]; }

    try {
      const { buildLLM } = await import("@/agent/llm");
      expect(() => buildLLM()).toThrow(/LLM credentials missing or incomplete/);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });

  it("constructs a ChatAnthropic instance with preferred env vars", async () => {
    process.env.ANTHROPIC_FOUNDRY_BASE_URL = "https://res.services.ai.azure.com/anthropic";
    process.env.ANTHROPIC_FOUNDRY_API_KEY = "test-key";
    process.env.ANTHROPIC_FOUNDRY_DEPLOYMENT = "claude-stub";

    try {
      const { buildLLM } = await import("@/agent/llm");
      const llm = buildLLM() as BaseChatModel & { model?: string };
      expect(llm).toBeDefined();
      // Should be a ChatAnthropic instance (has model property)
      expect(typeof llm.invoke).toBe("function");
    } finally {
      delete process.env.ANTHROPIC_FOUNDRY_BASE_URL;
      delete process.env.ANTHROPIC_FOUNDRY_API_KEY;
      delete process.env.ANTHROPIC_FOUNDRY_DEPLOYMENT;
    }
  });

  it("falls back to AZURE_OPENAI_* legacy vars", async () => {
    process.env.AZURE_OPENAI_ENDPOINT = "https://res.openai.azure.com/";
    process.env.AZURE_OPENAI_API_KEY = "legacy-key";
    process.env.AZURE_OPENAI_DEPLOYMENT_NAME = "claude-legacy";

    try {
      const { buildLLM } = await import("@/agent/llm");
      const llm = buildLLM();
      expect(llm).toBeDefined();
      expect(typeof llm.invoke).toBe("function");
    } finally {
      delete process.env.AZURE_OPENAI_ENDPOINT;
      delete process.env.AZURE_OPENAI_API_KEY;
      delete process.env.AZURE_OPENAI_DEPLOYMENT_NAME;
    }
  });
});
