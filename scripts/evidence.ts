import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, resolve } from "node:path";
import {
  importEvidenceCsv,
  importEvidenceJson,
  loadEvidenceDataset,
  serializeEvidenceDataset,
} from "../src/backtest/evidence-dataset";
import {
  loadEvidenceEvaluationPlan,
  renderEvidenceReportHtml,
  runEvidenceEvaluation,
  runEvidenceParameterSweepStub,
  serializeEvidenceReportJson,
} from "../src/backtest/evidence-evaluation";

interface ImportArgs {
  command: "import";
  input: string;
  manifest?: string;
  out: string;
}

interface EvaluateArgs {
  command: "evaluate";
  dataset: string;
  plan: string;
  jsonOut?: string;
  htmlOut?: string;
}

interface TuneArgs {
  command: "tune";
  dataset: string;
}

type CliArgs = ImportArgs | EvaluateArgs | TuneArgs;

function requiredValue(
  argv: string[],
  index: number,
  flag: string,
): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function printHelp(): void {
  console.log(`Usage:
  npm run evidence:import -- --input <dataset.json> --out <materialized.json>
  npm run evidence:import -- --input <observations.csv> --manifest <manifest.json> --out <materialized.json>
  npm run evidence:evaluate -- --dataset <materialized.json> --plan <plan.json> [--json-out <report.json>] [--html-out <report.html>]
  npm run evidence -- tune --dataset <materialized.json>

Import rules:
  JSON input embeds schemaVersion, manifest, observations, gaps, and optional paperExecutions.
  CSV input uses the exact header timestamp,priceUSD and requires a JSON manifest descriptor.

Evaluation plans bind canonical dataset content, exact raw source-file SHA-256,
and the deterministic complete materialized-dataset SHA-256. Generated file
reports are always engineering-only and are never eligible for v2.2 or v3
production release gates. Source metadata and sourceFileSha256 remain
importer/operator-declared because evaluation does not retain raw source bytes
for independent verification.

Tune is an explicit guard-only stub. Holdout datasets are rejected before the
not-implemented error so no future parameter-sweep path can silently consume them.
`);
}

function parseImportArgs(argv: string[]): ImportArgs {
  let input: string | undefined;
  let manifest: string | undefined;
  let out: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--input") {
      input = requiredValue(argv, index, arg);
      index++;
    } else if (arg === "--manifest") {
      manifest = requiredValue(argv, index, arg);
      index++;
    } else if (arg === "--out") {
      out = requiredValue(argv, index, arg);
      index++;
    } else {
      throw new Error(`Unknown import argument: ${arg}`);
    }
  }
  if (!input || !out) {
    throw new Error("import requires --input and --out");
  }
  return { command: "import", input, manifest, out };
}

function parseEvaluateArgs(argv: string[]): EvaluateArgs {
  let dataset: string | undefined;
  let plan: string | undefined;
  let jsonOut: string | undefined;
  let htmlOut: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--dataset") {
      dataset = requiredValue(argv, index, arg);
      index++;
    } else if (arg === "--plan") {
      plan = requiredValue(argv, index, arg);
      index++;
    } else if (arg === "--json-out") {
      jsonOut = requiredValue(argv, index, arg);
      index++;
    } else if (arg === "--html-out") {
      htmlOut = requiredValue(argv, index, arg);
      index++;
    } else {
      throw new Error(`Unknown evaluate argument: ${arg}`);
    }
  }
  if (!dataset || !plan) {
    throw new Error("evaluate requires --dataset and --plan");
  }
  return { command: "evaluate", dataset, plan, jsonOut, htmlOut };
}

function parseTuneArgs(argv: string[]): TuneArgs {
  let dataset: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--dataset") {
      dataset = requiredValue(argv, index, arg);
      index++;
    } else {
      throw new Error(`Unknown tune argument: ${arg}`);
    }
  }
  if (!dataset) {
    throw new Error("tune requires --dataset");
  }
  return { command: "tune", dataset };
}

function parseArgs(argv: string[]): CliArgs {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h") {
    printHelp();
    process.exit(0);
  }
  if (command === "import") return parseImportArgs(rest);
  if (command === "evaluate") return parseEvaluateArgs(rest);
  if (command === "tune") return parseTuneArgs(rest);
  throw new Error("Expected evidence subcommand import, evaluate, or tune");
}

function writeOutput(path: string, content: string): void {
  const outputPath = resolve(path);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, content, "utf8");
  if (process.stdout.isTTY) {
    console.error(`Wrote ${outputPath}`);
  }
}

function importDataset(args: ImportArgs): void {
  const inputPath = resolve(args.input);
  const rawInput = readFileSync(inputPath);
  const extension = extname(inputPath).toLowerCase();
  if (extension === ".json") {
    if (args.manifest) {
      throw new Error(
        "--manifest is only valid for CSV input; JSON input embeds its manifest",
      );
    }
    writeOutput(
      args.out,
      serializeEvidenceDataset(importEvidenceJson(rawInput)),
    );
    return;
  }
  if (extension === ".csv") {
    if (!args.manifest) {
      throw new Error("CSV import requires --manifest");
    }
    const descriptor = JSON.parse(
      readFileSync(resolve(args.manifest), "utf8"),
    ) as unknown;
    writeOutput(
      args.out,
      serializeEvidenceDataset(
        importEvidenceCsv(rawInput, descriptor),
      ),
    );
    return;
  }
  throw new Error("Evidence input extension must be .json or .csv");
}

function evaluateDataset(args: EvaluateArgs): void {
  const dataset = loadEvidenceDataset(
    readFileSync(resolve(args.dataset), "utf8"),
  );
  const plan = loadEvidenceEvaluationPlan(
    readFileSync(resolve(args.plan), "utf8"),
  );
  const report = runEvidenceEvaluation(dataset, plan);
  const json = serializeEvidenceReportJson(report);
  if (args.jsonOut) writeOutput(args.jsonOut, json);
  if (args.htmlOut) {
    writeOutput(args.htmlOut, renderEvidenceReportHtml(report));
  }
  if (!args.jsonOut && !args.htmlOut) {
    process.stdout.write(json);
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "import") {
    importDataset(args);
  } else if (args.command === "evaluate") {
    evaluateDataset(args);
  } else {
    const dataset = loadEvidenceDataset(
      readFileSync(resolve(args.dataset), "utf8"),
    );
    runEvidenceParameterSweepStub(dataset);
  }
}

main();
