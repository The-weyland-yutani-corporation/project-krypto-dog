import {
  consumeProviderRequestBudget,
  resolveDailyProviderBudgets,
  type ProviderBudgetStore,
} from "@/lib/provider-budgets";
import {
  ProviderBudgetError,
  createExecutionDeadline,
} from "@/lib/execution-envelope";

describe("daily provider budgets", () => {
  it("fails closed in production when any budget is absent", () => {
    expect(() =>
      resolveDailyProviderBudgets({ NODE_ENV: "production" }),
    ).toThrow(/COINBASE_DAILY_REQUEST_BUDGET/);
  });

  it("allows lowering but rejects exceeding provider-specific maxima", () => {
    const production = {
      NODE_ENV: "production",
      COINBASE_DAILY_REQUEST_BUDGET: "999",
      FOUNDRY_DAILY_REQUEST_BUDGET: "199",
      POSTHOG_DAILY_REQUEST_BUDGET: "1999",
      ACS_DAILY_REQUEST_BUDGET: "99",
    };
    expect(resolveDailyProviderBudgets(production)).toMatchObject({
      coinbase: 999,
      foundry: 199,
      posthog: 1999,
      acs: 99,
    });
    expect(() =>
      resolveDailyProviderBudgets({
        ...production,
        FOUNDRY_DAILY_REQUEST_BUDGET: "201",
      }),
    ).toThrow(/no greater than 200/);
  });

  it("surfaces exhaustion as a typed non-success condition", async () => {
    const deadline = createExecutionDeadline();
    const store: ProviderBudgetStore = {
      consume: jest.fn().mockResolvedValue(null),
    };
    await expect(
      consumeProviderRequestBudget("foundry", {
        deadline,
        store,
        budgets: {
          coinbase: 1,
          foundry: 1,
          posthog: 1,
          acs: 1,
        },
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ProviderBudgetError>>({
        code: "provider-budget-exhausted",
        provider: "foundry",
        kind: "daily-requests",
      }),
    );
    deadline.dispose();
  });
});
