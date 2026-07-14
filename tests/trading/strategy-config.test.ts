import { resolveTradingMode } from "@/trading/strategy-config";
import { TradingConfigurationError } from "@/trading/errors";

describe("resolveTradingMode", () => {
  it("defaults production-shaped environments to disabled", () => {
    expect(resolveTradingMode({ NODE_ENV: "production" })).toBe("disabled");
  });

  it("permits paper mode by default only in development", () => {
    expect(resolveTradingMode({ NODE_ENV: "development" })).toBe("paper");
  });

  it("rejects an invalid explicit rollout mode", () => {
    expect(() =>
      resolveTradingMode({
        NODE_ENV: "production",
        ROLLOUT_MODE: "live",
      }),
    ).toThrow(TradingConfigurationError);
  });
});
