import "dotenv/config";
import { readFileSync, mkdirSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { formatBacktestReport, runBacktest } from "../src/backtest/runner";
import type { BacktestOptions, ScenarioInput } from "../src/backtest/types";

interface CliArgs {
  scenario?: string;
  out?: string;
  policy?: BacktestOptions["policy"];
  slippagePct?: number;
  feeRate?: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--scenario") {
      args.scenario = next;
      i++;
    } else if (arg === "--out") {
      args.out = next;
      i++;
    } else if (arg === "--policy") {
      if (next !== "rules-basic" && next !== "always-hold") {
        throw new Error("--policy must be rules-basic or always-hold");
      }
      args.policy = next;
      i++;
    } else if (arg === "--slippage-pct") {
      args.slippagePct = Number(next);
      i++;
    } else if (arg === "--fee-rate") {
      args.feeRate = Number(next);
      i++;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`Usage:
  npm run backtest -- --scenario scenarios/dip-recovery.json
  npm run backtest -- --scenario scenarios/dip-recovery.json --out backtest-output/dip-recovery.json

Options:
  --scenario <path>      Scenario JSON file (required)
  --policy <name>        Override scenario policy: rules-basic | always-hold
  --slippage-pct <n>     Override slippage as a decimal, e.g. 0.001
  --fee-rate <n>         Override fee rate as a decimal, e.g. 0.003
  --out <path>           Write JSON result artifact
`);
}

function readScenario(path: string): ScenarioInput {
  return JSON.parse(readFileSync(resolve(path), "utf8")) as ScenarioInput;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.scenario) {
    printHelp();
    process.exit(1);
  }

  const scenario = readScenario(args.scenario);
  const result = runBacktest(scenario, {
    policy: args.policy,
    slippagePct: args.slippagePct,
    feeRate: args.feeRate,
  });

  console.log(formatBacktestReport(result));

  if (args.out) {
    const outputPath = resolve(args.out);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`Wrote ${outputPath}`);
  }

  if (result.assertionFailures.length > 0) {
    process.exit(2);
  }
}

main();
