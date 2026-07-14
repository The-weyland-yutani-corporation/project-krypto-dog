import "dotenv/config";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "fs";
import { dirname, join, resolve } from "path";
import {
  createAggregateReport,
  formatBacktestReport,
  runBacktest,
} from "../src/backtest/runner";
import type {
  BacktestOptions,
  BacktestResult,
  ScenarioInput,
} from "../src/backtest/types";

interface CliArgs {
  scenario?: string;
  all: boolean;
  json: boolean;
  out?: string;
  policy?: BacktestOptions["policy"];
  slippagePct?: number;
  feeRate?: number;
  llmCostUSD?: number;
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function numericValue(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${flag} must be a finite number`);
  }
  return parsed;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { all: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--scenario") {
      args.scenario = requiredValue(argv, i, arg);
      i++;
    } else if (arg === "--all") {
      args.all = true;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--out") {
      args.out = requiredValue(argv, i, arg);
      i++;
    } else if (arg === "--policy") {
      const policy = requiredValue(argv, i, arg);
      if (policy !== "rules-basic" && policy !== "always-hold") {
        throw new Error("--policy must be rules-basic or always-hold");
      }
      args.policy = policy;
      i++;
    } else if (arg === "--slippage-pct") {
      args.slippagePct = numericValue(
        requiredValue(argv, i, arg),
        arg,
      );
      i++;
    } else if (arg === "--fee-rate") {
      args.feeRate = numericValue(requiredValue(argv, i, arg), arg);
      i++;
    } else if (arg === "--llm-cost-usd") {
      args.llmCostUSD = numericValue(
        requiredValue(argv, i, arg),
        arg,
      );
      i++;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (args.all === Boolean(args.scenario)) {
    throw new Error("Provide exactly one of --scenario or --all");
  }
  return args;
}

function printHelp(): void {
  console.log(`Usage:
  npm run backtest -- --scenario scenarios/dip-recovery.json
  npm run backtest -- --scenario scenarios/dip-recovery.json --json
  npm run backtest:all

Options:
  --scenario <path>      Run one scenario JSON file
  --all                  Run every scenarios/*.json file
  --json                 Print machine-readable JSON
  --policy <name>        rules-basic | always-hold
  --slippage-pct <n>     Override slippage decimal, e.g. 0.0015
  --fee-rate <n>         Override fee decimal, e.g. 0.003
  --llm-cost-usd <n>     Report optional externally supplied LLM cost
  --out <path>           Write result or aggregate JSON artifact
`);
}

function readScenario(path: string): ScenarioInput {
  return JSON.parse(readFileSync(resolve(path), "utf8")) as ScenarioInput;
}

function scenarioPaths(): string[] {
  const directory = resolve("scenarios");
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => join(directory, name));
}

function runScenario(path: string, args: CliArgs): BacktestResult {
  return runBacktest(readScenario(path), {
    policy: args.policy,
    slippagePct: args.slippagePct,
    feeRate: args.feeRate,
    llmCostUSD: args.llmCostUSD,
  });
}

function writeOutput(path: string, value: unknown): void {
  const outputPath = resolve(path);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(value, null, 2)}\n`);
  if (!process.stdout.isTTY) return;
  console.error(`Wrote ${outputPath}`);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const results = args.all
    ? scenarioPaths().map((path) => runScenario(path, args))
    : [runScenario(args.scenario as string, args)];
  const output = args.all ? createAggregateReport(results) : results[0];

  if (args.json) {
    console.log(JSON.stringify(output, null, 2));
  } else if (args.all) {
    for (const result of results) {
      console.log(`${formatBacktestReport(result)}\n`);
    }
    const aggregate = createAggregateReport(results);
    console.log("Aggregate engineering assertions:");
    console.log(
      `${aggregate.engineeringAssertions.passedScenarios} passed, ${aggregate.engineeringAssertions.failedScenarios} failed`,
    );
    console.log("Aggregate financial evidence summary:");
    console.log(
      `${aggregate.financialEvidenceSummary.beatsCash}/${results.length} beat cash; ${aggregate.financialEvidenceSummary.beatsBuyHold}/${results.length} beat buy-and-hold; fixtures only`,
    );
  } else {
    console.log(formatBacktestReport(results[0]));
  }

  if (args.out) {
    writeOutput(args.out, output);
  }
  if (results.some((result) => result.assertionFailures.length > 0)) {
    process.exitCode = 2;
  }
}

main();
