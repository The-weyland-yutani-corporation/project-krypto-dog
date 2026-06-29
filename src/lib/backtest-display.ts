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

  const equity = result.equitySnapshots.map((snapshot, index) => {
    return {
      label: `T${index}`,
      agent: snapshot.agentEquityUSD,
      cash: snapshot.cashEquityUSD,
      buyHold: snapshot.buyHoldEquityUSD,
    };
  });

  const scenarios = scenarioSet.map((scenario) => {
    const scenarioResult = runBacktest(scenario);
    return {
      name: scenario.name
        .split("-")
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase())
        .join(""),
      value: scenarioResult.finalEquityUSD - scenarioResult.initialCapitalUSD,
    };
  });

  return { equity, scenarios };
}
