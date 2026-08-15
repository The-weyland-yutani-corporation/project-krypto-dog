import { z } from "zod/v4";
import { normalizeAppOrigin } from "@/lib/app-origin";

// ---------------------------------------------------------------------------
// Optional direct Azure OpenAI v1 diagnostic endpoint validation
// ---------------------------------------------------------------------------
//
// AZURE_OPENAI_BASE_URL is the complete v1 data-plane base URL, for example:
//   https://your-resource.openai.azure.com/openai/v1
//   https://your-resource.services.ai.azure.com/openai/v1
//
// The application decision path uses the versioned Foundry Agent configuration
// below. These Azure OpenAI values are retained only for attended platform
// diagnostics. Authentication is always Microsoft Entra ID; API keys and dated
// API versions are intentionally unsupported.

function normalizeBaseURL(value: string): string {
  return value.replace(/\/+$/, "");
}

function isAzureOpenAIBaseURL(value: string): boolean {
  try {
    const url = new URL(value);
    const isAzureHost =
      url.hostname.endsWith(".openai.azure.com") ||
      url.hostname.endsWith(".services.ai.azure.com");
    return (
      url.protocol === "https:" &&
      isAzureHost &&
      normalizeBaseURL(url.pathname) === "/openai/v1" &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function normalizeFoundryProjectEndpoint(value: string): string {
  return value.replace(/\/+$/, "");
}

function isAzureFoundryProjectEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    const path = normalizeFoundryProjectEndpoint(url.pathname);
    return (
      url.protocol === "https:" &&
      url.hostname.endsWith(".services.ai.azure.com") &&
      /^\/api\/projects\/[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$/.test(path) &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export interface AzureOpenAIConfig {
  baseURL: string;
  deployment: string;
  clientId?: string;
}

export interface AzureFoundryAgentConfig {
  projectEndpoint: string;
  agentName: string;
  agentVersion: string;
  clientId?: string;
}

export function resolveAzureOpenAIConfig(
  env: Record<string, string | undefined>,
): AzureOpenAIConfig | undefined {
  if (
    !env.AZURE_OPENAI_BASE_URL ||
    !env.AZURE_OPENAI_DEPLOYMENT_NAME ||
    !isAzureOpenAIBaseURL(env.AZURE_OPENAI_BASE_URL)
  ) {
    return undefined;
  }

  return {
    baseURL: normalizeBaseURL(env.AZURE_OPENAI_BASE_URL),
    deployment: env.AZURE_OPENAI_DEPLOYMENT_NAME,
    clientId: env.AZURE_CLIENT_ID,
  };
}

export function resolveAzureFoundryAgentConfig(
  env: Record<string, string | undefined>,
): AzureFoundryAgentConfig | undefined {
  if (
    !env.AZURE_FOUNDRY_PROJECT_ENDPOINT ||
    !env.AZURE_FOUNDRY_AGENT_NAME ||
    !env.AZURE_FOUNDRY_AGENT_VERSION ||
    !isAzureFoundryProjectEndpoint(env.AZURE_FOUNDRY_PROJECT_ENDPOINT) ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{1,127}$/.test(
      env.AZURE_FOUNDRY_AGENT_NAME,
    ) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(
      env.AZURE_FOUNDRY_AGENT_VERSION,
    )
  ) {
    return undefined;
  }

  return {
    projectEndpoint: normalizeFoundryProjectEndpoint(
      env.AZURE_FOUNDRY_PROJECT_ENDPOINT,
    ),
    agentName: env.AZURE_FOUNDRY_AGENT_NAME,
    agentVersion: env.AZURE_FOUNDRY_AGENT_VERSION,
    clientId: env.AZURE_CLIENT_ID,
  };
}

const envSchema = z
  .object({
    // Azure OpenAI v1 with Microsoft Entra authentication
    AZURE_OPENAI_BASE_URL: z.string().url().optional(),
    AZURE_OPENAI_DEPLOYMENT_NAME: z.string().min(1).optional(),
    AZURE_FOUNDRY_PROJECT_ENDPOINT: z.string().url().optional(),
    AZURE_FOUNDRY_AGENT_NAME: z.string().min(1).optional(),
    AZURE_FOUNDRY_AGENT_VERSION: z.string().min(1).optional(),
    AZURE_CLIENT_ID: z.string().uuid().optional(),
    // Other runtime config
    DATABASE_URL: z.string().url(),
    POSTHOG_API_KEY: z.string().min(1),
    POSTHOG_HOST: z.string().url().optional(),
    POSTHOG_ENVIRONMENT: z.enum(["dev", "prod"]).optional(),
    CRON_SECRET: z.string().min(1),
    APP_ORIGIN: z.string().optional(),
    ROLLOUT_MODE: z.enum(["disabled", "shadow", "paper"]).optional(),
    AZURE_COMMUNICATION_CONNECTION_STRING: z.string().min(1).optional(),
    AZURE_COMMUNICATION_EMAIL_SENDER: z.email().optional(),
    ALERT_EMAIL_TO: z.email().optional(),
    ADMIN_PASSWORD: z.string().min(1),
    ADMIN_SESSION_SECRET: z.string().min(1).optional(),
    NODE_ENV: z.enum(["development", "test", "production"]).optional(),
  })
  .check((ctx) => {
    const env = ctx.value;
    if (
      (env.AZURE_OPENAI_BASE_URL || env.AZURE_OPENAI_DEPLOYMENT_NAME) &&
      !resolveAzureOpenAIConfig(
        env as Record<string, string | undefined>,
      )
    ) {
      ctx.issues.push({
        code: "custom",
        message:
          "Optional direct Azure OpenAI diagnostics require both " +
          "AZURE_OPENAI_BASE_URL ending in /openai/v1 and " +
          "AZURE_OPENAI_DEPLOYMENT_NAME.",
        input: ctx.value,
      });
    }

    if (
      !resolveAzureFoundryAgentConfig(
        env as Record<string, string | undefined>,
      )
    ) {
      ctx.issues.push({
        code: "custom",
        message:
          "AZURE_FOUNDRY_PROJECT_ENDPOINT, AZURE_FOUNDRY_AGENT_NAME, and " +
          "AZURE_FOUNDRY_AGENT_VERSION must identify one immutable Foundry Agent.",
        input: ctx.value,
      });
    }

    if (env.NODE_ENV === "production") {
      if (!env.AZURE_CLIENT_ID) {
        ctx.issues.push({
          code: "custom",
          message:
            "AZURE_CLIENT_ID is required in production to select the user-assigned managed identity.",
          input: ctx.value,
        });
      }
      if (!env.ADMIN_SESSION_SECRET) {
        ctx.issues.push({
          code: "custom",
          message: "ADMIN_SESSION_SECRET is required in production.",
          input: ctx.value,
        });
      }
      if (!env.POSTHOG_ENVIRONMENT) {
        ctx.issues.push({
          code: "custom",
          message: "POSTHOG_ENVIRONMENT is required in production.",
          input: ctx.value,
        });
      }
      const appOrigin = env.APP_ORIGIN
        ? normalizeAppOrigin(env.APP_ORIGIN)
        : undefined;
      if (!appOrigin || !appOrigin.startsWith("https://")) {
        ctx.issues.push({
          code: "custom",
          message:
            "APP_ORIGIN must be an HTTPS origin with no path, query, credentials, or fragment in production.",
          input: ctx.value,
        });
      }
      const missingEmailConfig = [
        !env.AZURE_COMMUNICATION_CONNECTION_STRING &&
          "AZURE_COMMUNICATION_CONNECTION_STRING",
        !env.AZURE_COMMUNICATION_EMAIL_SENDER &&
          "AZURE_COMMUNICATION_EMAIL_SENDER",
        !env.ALERT_EMAIL_TO && "ALERT_EMAIL_TO",
      ].filter(Boolean);
      if (missingEmailConfig.length > 0) {
        ctx.issues.push({
          code: "custom",
          message: `Production ACS email configuration is incomplete: ${missingEmailConfig.join(", ")}.`,
          input: ctx.value,
        });
      }
    }
  });

export function validateEnv() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error("❌ Invalid environment variables:", result.error.format());
    throw new Error("Invalid environment variables");
  }
  return result.data;
}

// Trading strategy constants
export const MAX_TRADE_SIZE_USD = 50;
export const MIN_PORTFOLIO_VALUE_USD = 150;
export const COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours
export const BUY_TRIGGER_PCT = 0.03; // -3%
export const SELL_TRIGGER_PCT = 0.03; // +3%
export const STOP_LOSS_PCT = 0.15; // -15% per trade
export const MAX_DCA_COUNT = 3;
export const SLIPPAGE_TOLERANCE_PCT = 0.01; // 1%
export const ALLOWED_ASSETS = ["ETH", "USDC"] as const;
export const INITIAL_CAPITAL_USD = 200;

// EMA periods
export const EMA_SHORT_PERIOD = 12;
export const EMA_LONG_PERIOD = 26;
export const RSI_PERIOD = 14;
export const CANDLE_TIMEFRAME = "FOUR_HOUR" as const;

// Journal context
export const JOURNAL_CONTEXT_COUNT = 3;
