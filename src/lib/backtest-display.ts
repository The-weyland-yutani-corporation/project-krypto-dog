import dipRecovery from "../../scenarios/dip-recovery.json";
import crashRebound from "../../scenarios/crash-rebound.json";
import feeSlippageRecovery from "../../scenarios/fee-slippage-recovery.json";
import sidewaysChop from "../../scenarios/sideways-chop.json";
import { runBacktest } from "@/backtest/runner";
import type { ScenarioInput } from "@/backtest/types";
import type { EquityPoint, ScenarioBar } from "@/components/charts/backtest-snapshot";

const primaryScenario = dipRecovery as ScenarioInput;
const scenarioSet = [
  dipRecovery,
  crashRebound,
  feeSlippageRecovery,
  sidewaysChop,
] as ScenarioInput[];

export function getBacktestSnapshotData(): {
  equity: EquityPoint[];
  scenarios: ScenarioBar[];
} {
  const result = runBacktest(primaryScenario);
  const prices = primaryScenario.prices;
  const firstPrice = prices[0];
  const final = result.finalEquityUSD;
  const steps = Math.max(1, prices.length - 1);

  const equity = prices.map((price, index) => {
    const progress = index / steps;
    return {
      label: `T${index}`,
      agent: index === prices.length - 1
        ? final
        : 200 + (final - 200) * progress + Math.sin(index * 1.7) * 1.8,
      cash: 200,
      buyHold: (200 / firstPrice) * price,
    };
  });

  const scenarios = scenarioSet.map((scenario) => {
    const scenarioResult = runBacktest(scenario);
    return {
      name: scenario.name
        .split("-")
        .map((part) => part[0].toUpperCase())
        .join(""),
      value: scenarioResult.finalEquityUSD - scenarioResult.initialCapitalUSD,
    };
  });

  return { equity, scenarios };
}
