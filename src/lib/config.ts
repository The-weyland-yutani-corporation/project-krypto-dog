import { z } from "zod/v4";

const envSchema = z.object({
  AZURE_OPENAI_ENDPOINT: z.string().url(),
  AZURE_OPENAI_API_KEY: z.string().min(1),
  AZURE_OPENAI_DEPLOYMENT_NAME: z.string().min(1),
  CDP_API_KEY_NAME: z.string().min(1),
  CDP_API_KEY_PRIVATE_KEY: z.string().min(1),
  DATABASE_URL: z.string().url(),
  POSTHOG_API_KEY: z.string().min(1),
  POSTHOG_HOST: z.string().url().optional(),
  CRON_SECRET: z.string().min(1),
  RESEND_API_KEY: z.string().min(1).optional(),
  ALERT_EMAIL_TO: z.email().optional(),
  ALERT_EMAIL_FROM: z.email().optional(),
  ADMIN_PASSWORD: z.string().min(1),
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
