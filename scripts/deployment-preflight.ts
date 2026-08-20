import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  runDeploymentPreflight,
  type DeploymentPreflightReport,
} from "../src/deployment/preflight";

interface ParsedArguments {
  outPath: string | null;
}

function parseArguments(argv: string[]): ParsedArguments {
  let path: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--out") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--out requires a file path");
      }
      if (path) {
        throw new Error("--out may be provided only once");
      }
      path = resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return { outPath: path };
}

function writeReport(path: string, report: DeploymentPreflightReport): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, {
    flag: "wx",
  });
}

async function main(): Promise<void> {
  const { outPath } = parseArguments(process.argv.slice(2));
  const report = await runDeploymentPreflight({
    directUrl: process.env.DIRECT_URL,
    runtimeUrl: process.env.DATABASE_URL,
  });
  if (outPath) writeReport(outPath, report);
  console.log(JSON.stringify(report, null, 2));
  if (!report.databasePreflightPassed) process.exitCode = 2;
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      error:
        error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: "unknown", message: String(error) },
    }),
  );
  process.exitCode = 1;
});
