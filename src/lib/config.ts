import { z } from "zod/v4";

// ---------------------------------------------------------------------------
// Foundry Anthropic endpoint validation
// ---------------------------------------------------------------------------
//
// Preferred names (new): ANTHROPIC_FOUNDRY_BASE_URL, ANTHROPIC_FOUNDRY_API_KEY,
//   ANTHROPIC_FOUNDRY_DEPLOYMENT, ANTHROPIC_FOUNDRY_API_VERSION
//
// Legacy fallbacks (kept for already-deployed environments):
//   AZURE_OPENAI_ENDPOINT  → the raw resource endpoint; /anthropic is appended
//   AZURE_OPENAI_API_KEY, AZURE_OPENAI_DEPLOYMENT_NAME, AZURE_OPENAI_API_VERSION
//
// ANTHROPIC_FOUNDRY_BASE_URL must be a services.ai.azure.com/anthropic endpoint,
// not a direct OpenAI API host (api.openai.com).

function normalizeBaseURL(value: string): string {
  return value.replace(/\/+$/, "");
}

function isFoundryAnthropicBaseURL(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname.endsWith(".services.ai.azure.com") &&
      normalizeBaseURL(url.pathname) === "/anthropic"
    );
  } catch {
    return false;
  }
}

export function resolveFoundryBaseURL(
  env: Record<string, string | undefined>,
): string | undefined {
  const explicit = env.ANTHROPIC_FOUNDRY_BASE_URL;
  if (explicit) return normalizeBaseURL(explicit);
  const legacy = env.AZURE_OPENAI_ENDPOINT;
  if (legacy) {
    const normalized = normalizeBaseURL(legacy);
    return normalized.endsWith("/anthropic")
      ? normalized
      : `${normalized}/anthropic`;
  }
  return undefined;
}

export interface FoundryConfig {
  baseURL: string;
  apiKey: string;
  deployment: string;
  apiVersion?: string;
  source: "preferred" | "legacy";
}

export function resolveFoundryConfig(
  env: Record<string, string | undefined>,
): FoundryConfig | undefined {
  const preferred = {
    baseURL: env.ANTHROPIC_FOUNDRY_BASE_URL,
    apiKey: env.ANTHROPIC_FOUNDRY_API_KEY,
    deployment: env.ANTHROPIC_FOUNDRY_DEPLOYMENT,
    apiVersion: env.ANTHROPIC_FOUNDRY_API_VERSION,
  };
  const hasAnyPreferred = Object.values(preferred).some(Boolean);

  if (hasAnyPreferred) {
    if (!preferred.baseURL || !preferred.apiKey || !preferred.deployment) {
      return undefined;
    }
    return {
      baseURL: normalizeBaseURL(preferred.baseURL),
      apiKey: preferred.apiKey,
      deployment: preferred.deployment,
      apiVersion: preferred.apiVersion,
      source: "preferred",
    };
  }

  const legacyBaseURL = resolveFoundryBaseURL(env);
  if (
    !legacyBaseURL ||
    !env.AZURE_OPENAI_API_KEY ||
    !env.AZURE_OPENAI_DEPLOYMENT_NAME
  ) {
    return undefined;
  }

  return {
    baseURL: legacyBaseURL,
    apiKey: env.AZURE_OPENAI_API_KEY,
    deployment: env.AZURE_OPENAI_DEPLOYMENT_NAME,
    apiVersion: env.AZURE_OPENAI_API_VERSION,
    source: "legacy",
  };
}

const envSchema = z
  .object({
    // Preferred Foundry Anthropic config
    ANTHROPIC_FOUNDRY_BASE_URL: z.string().url().optional(),
    ANTHROPIC_FOUNDRY_API_KEY: z.string().min(1).optional(),
    ANTHROPIC_FOUNDRY_DEPLOYMENT: z.string().min(1).optional(),
    ANTHROPIC_FOUNDRY_API_VERSION: z.string().min(1).optional(),
    // Legacy fallback names (still accepted for backwards-compat)
    AZURE_OPENAI_ENDPOINT: z.string().url().optional(),
    AZURE_OPENAI_API_KEY: z.string().min(1).optional(),
    AZURE_OPENAI_DEPLOYMENT_NAME: z.string().min(1).optional(),
    AZURE_OPENAI_API_VERSION: z.string().min(1).optional(),
    // Other runtime config
    DATABASE_URL: z.string().url(),
    POSTHOG_API_KEY: z.string().min(1),
    POSTHOG_HOST: z.string().url().optional(),
    CRON_SECRET: z.string().min(1),
    ROLLOUT_MODE: z.enum(["disabled", "shadow", "paper"]).optional(),
    RESEND_API_KEY: z.string().min(1).optional(),
    ALERT_EMAIL_TO: z.email().optional(),
    ALERT_EMAIL_FROM: z.email().optional(),
    ADMIN_PASSWORD: z.string().min(1),
    ADMIN_SESSION_SECRET: z.string().min(1).optional(),
    NODE_ENV: z.enum(["development", "test", "production"]).optional(),
  })
  .check((ctx) => {
    const env = ctx.value;
    // Require at least one complete set of LLM credentials
    const newBaseURL = env.ANTHROPIC_FOUNDRY_BASE_URL;
    const newKey = env.ANTHROPIC_FOUNDRY_API_KEY;
    const newDeployment = env.ANTHROPIC_FOUNDRY_DEPLOYMENT;
    const legacyEndpoint = env.AZURE_OPENAI_ENDPOINT;
    const legacyKey = env.AZURE_OPENAI_API_KEY;
    const legacyDeployment = env.AZURE_OPENAI_DEPLOYMENT_NAME;

    const hasAnyNew = !!(newBaseURL || newKey || newDeployment);
    const hasNew = !!(newBaseURL && newKey && newDeployment);
    const hasLegacy = !!(legacyEndpoint && legacyKey && legacyDeployment);
    if ((hasAnyNew && !hasNew) || (!hasAnyNew && !hasLegacy)) {
      ctx.issues.push({
        code: "custom",
        message:
          "LLM credentials required: set ANTHROPIC_FOUNDRY_BASE_URL + " +
          "ANTHROPIC_FOUNDRY_API_KEY + ANTHROPIC_FOUNDRY_DEPLOYMENT, " +
          "or the legacy AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_API_KEY + AZURE_OPENAI_DEPLOYMENT_NAME.",
        input: ctx.value,
      });
    }

    if (newBaseURL && !isFoundryAnthropicBaseURL(newBaseURL)) {
      ctx.issues.push({
        code: "custom",
        message:
          "ANTHROPIC_FOUNDRY_BASE_URL must be an HTTPS Azure AI Foundry " +
          "Anthropic endpoint such as " +
          "https://your-resource.services.ai.azure.com/anthropic.",
        input: ctx.value,
      });
    }

    if (env.NODE_ENV === "production" && !env.ADMIN_SESSION_SECRET) {
      ctx.issues.push({
        code: "custom",
        message: "ADMIN_SESSION_SECRET is required in production.",
        input: ctx.value,
      });
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
