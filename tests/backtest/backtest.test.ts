import { readFileSync } from "fs";
import { join } from "path";
import { runBacktest } from "@/backtest/runner";
import type { ScenarioInput } from "@/backtest/types";

function scenario(name: string): ScenarioInput {
  const path = join(process.cwd(), "scenarios", `${name}.json`);
  return JSON.parse(readFileSync(path, "utf8")) as ScenarioInput;
}

const scenarioNames = [
  "dip-recovery",
  "sideways-chop",
  "crash-rebound",
  "steady-uptrend",
  "slow-drawdown",
  "cooldown-edge",
  "fee-slippage-recovery",
  "balance-guard",
  "volatile-regime",
];

describe("deterministic backtest runner", () => {
  it.each(scenarioNames)("passes fixture assertions for %s", (name) => {
    const result = runBacktest(scenario(name));
    expect(result.assertionFailures).toEqual([]);
  });

  it("produces net gains in the dip-recovery scenario after fees", () => {
    const result = runBacktest(scenario("dip-recovery"));
    expect(result.assertionFailures).toEqual([]);
    expect(result.equitySnapshots).toHaveLength(scenario("dip-recovery").prices.length);
    expect(result.equitySnapshots.at(-1)?.agentEquityUSD).toBeCloseTo(
      result.finalEquityUSD,
      8,
    );
    expect(result.beatsCash).toBe(true);
    expect(result.finalEquityUSD).toBeGreaterThan(200);
    expect(result.trades.some((trade) => trade.direction === "BUY")).toBe(true);
    expect(result.trades.some((trade) => trade.direction === "SELL")).toBe(true);
  });

  it("keeps sideways-chop drawdown bounded", () => {
    const result = runBacktest(scenario("sideways-chop"));
    expect(result.assertionFailures).toEqual([]);
    expect(result.maxDrawdownPct).toBeLessThanOrEqual(5);
  });

  it("tracks weighted-average cost basis across DCA sells", () => {
    const result = runBacktest({
      name: "weighted-cost-basis",
      prices: [2100, 2020, 1900, 1980, 2070],
      expected: { minTrades: 3, mustNotLock: true },
    });

    const sellPnls = result.trades
      .filter((trade) => trade.direction === "SELL")
      .map((trade) => trade.pnlUSD ?? 0);
    expect(sellPnls.length).toBeGreaterThan(0);
    expect(result.realisedPnlUSD).toBeCloseTo(
      sellPnls.reduce((sum, pnl) => sum + pnl, 0),
      8,
    );
  });

  it("compares against buy-and-hold separately from cash", () => {
    const result = runBacktest(scenario("dip-recovery"));
    expect(result.cashBaselineUSD).toBe(200);
    expect(result.buyHoldEquityUSD).toBeGreaterThan(200);
    expect(typeof result.beatsBuyHold).toBe("boolean");
  });

  it("supports an always-hold baseline policy", () => {
    const result = runBacktest(scenario("dip-recovery"), {
      policy: "always-hold",
    });
    expect(result.trades).toHaveLength(0);
    expect(result.finalEquityUSD).toBe(200);
    expect(result.beatsCash).toBe(false);
  });
});
