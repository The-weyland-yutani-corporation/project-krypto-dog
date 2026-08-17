import { sql } from "drizzle-orm";
import { db } from "@/db";
import {
  ProviderBudgetError,
  type ExecutionDeadline,
  type ProviderName,
} from "@/lib/execution-envelope";

const ENV_KEYS: Readonly<Record<ProviderName, string>> = Object.freeze({
  coinbase: "COINBASE_DAILY_REQUEST_BUDGET",
  foundry: "FOUNDRY_DAILY_REQUEST_BUDGET",
  posthog: "POSTHOG_DAILY_REQUEST_BUDGET",
  acs: "ACS_DAILY_REQUEST_BUDGET",
});

// Development/test defaults keep local workflows usable. Production has no
// defaults and fails closed when any budget is absent or malformed.
const NON_PRODUCTION_DEFAULTS: Readonly<Record<ProviderName, number>> =
  Object.freeze({
    coinbase: 1_000,
    foundry: 200,
    posthog: 2_000,
    acs: 100,
  });

export const MAX_DAILY_PROVIDER_BUDGETS: DailyProviderBudgets =
  Object.freeze({
    coinbase: 1_000,
    foundry: 200,
    posthog: 2_000,
    acs: 100,
  });

export type DailyProviderBudgets = Readonly<Record<ProviderName, number>>;

export function resolveDailyProviderBudgets(
  env: Record<string, string | undefined> = process.env,
): DailyProviderBudgets {
  const production = env.NODE_ENV === "production";
  const values = {} as Record<ProviderName, number>;
  for (const provider of Object.keys(ENV_KEYS) as ProviderName[]) {
    const raw = env[ENV_KEYS[provider]];
    if (raw === undefined && !production) {
      values[provider] = NON_PRODUCTION_DEFAULTS[provider];
      continue;
    }
    const parsed = Number(raw);
    if (
      !Number.isSafeInteger(parsed) ||
      parsed <= 0 ||
      parsed > MAX_DAILY_PROVIDER_BUDGETS[provider]
    ) {
      throw new Error(
        `${ENV_KEYS[provider]} must be a positive integer no greater than ${MAX_DAILY_PROVIDER_BUDGETS[provider]}`,
      );
    }
    values[provider] = parsed;
  }
  return Object.freeze(values);
}

export interface ProviderBudgetStore {
  consume(
    provider: ProviderName,
    usageDate: string,
    limit: number,
  ): Promise<number | null>;
}

export const postgresProviderBudgetStore: ProviderBudgetStore = {
  async consume(provider, usageDate, limit) {
    const result = await db.execute<{ requestCount: number }>(sql`
      INSERT INTO "krypto"."ProviderDailyUsage"
        ("usageDate", "provider", "requestCount", "updatedAt")
      VALUES (${usageDate}::date, ${provider}, 1, clock_timestamp())
      ON CONFLICT ("usageDate", "provider") DO UPDATE
      SET
        "requestCount" = "krypto"."ProviderDailyUsage"."requestCount" + 1,
        "updatedAt" = clock_timestamp()
      WHERE "krypto"."ProviderDailyUsage"."requestCount" < ${limit}
      RETURNING "requestCount"
    `);
    const row = result[0];
    return row ? Number(row.requestCount) : null;
  },
};

export interface ConsumeProviderBudgetOptions {
  deadline: ExecutionDeadline;
  store?: ProviderBudgetStore;
  budgets?: DailyProviderBudgets;
}

export async function consumeProviderRequestBudget(
  provider: ProviderName,
  options: ConsumeProviderBudgetOptions,
): Promise<number> {
  options.deadline.assertActive(`${provider} budget acquisition`);
  const budgets = options.budgets ?? resolveDailyProviderBudgets();
  const usageDate = options.deadline.now().toISOString().slice(0, 10);
  const count = await (options.store ?? postgresProviderBudgetStore).consume(
    provider,
    usageDate,
    budgets[provider],
  );
  options.deadline.assertActive(`${provider} provider request`);
  if (count === null) {
    throw new ProviderBudgetError(provider, "daily-requests");
  }
  return count;
}
