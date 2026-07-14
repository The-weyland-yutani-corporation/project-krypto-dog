import { TradingConfigurationError } from "./errors";

export interface StrategyConfig {
  version: string;
  pair: "ETH/USDC";
  initialCapitalUSD: number;
  minimumTradeUSD: number;
  maximumTradeFractionOfInitialCapital: number;
  maximumEthExposureFraction: number;
  buyTriggerFraction: number;
  takeProfitFraction: number;
  stopLossFraction: number;
  maximumDcaEntries: number;
  cooldownMs: number;
  maximumDrawdownPct: number;
  feeBps: number;
  paperSlippageBps: number;
  slippageCeilingBps: number;
  marketDataMaxAgeMs: number;
}

export const DEFAULT_STRATEGY_CONFIG: Readonly<StrategyConfig> = Object.freeze({
  version: "v2.1-default",
  pair: "ETH/USDC",
  initialCapitalUSD: 200,
  minimumTradeUSD: 10,
  maximumTradeFractionOfInitialCapital: 0.25,
  maximumEthExposureFraction: 0.75,
  buyTriggerFraction: 0.03,
  takeProfitFraction: 0.03,
  stopLossFraction: 0.15,
  maximumDcaEntries: 3,
  cooldownMs: 2 * 60 * 60 * 1000,
  maximumDrawdownPct: 25,
  feeBps: 30,
  paperSlippageBps: 15,
  slippageCeilingBps: 100,
  marketDataMaxAgeMs: 10 * 60 * 1000,
});

export type TradingMode = "disabled" | "shadow" | "paper";

export function resolveTradingMode(
  env: Record<string, string | undefined> = process.env,
): TradingMode {
  const rawMode = env.ROLLOUT_MODE;
  const configured = rawMode?.toLowerCase();
  if (
    configured === "disabled" ||
    configured === "shadow" ||
    configured === "paper"
  ) {
    return configured;
  }

  if (rawMode !== undefined) {
    throw new TradingConfigurationError(
      `Invalid ROLLOUT_MODE "${rawMode}"; expected disabled, shadow, or paper`,
    );
  }

  return env.NODE_ENV === "development" ? "paper" : "disabled";
}
