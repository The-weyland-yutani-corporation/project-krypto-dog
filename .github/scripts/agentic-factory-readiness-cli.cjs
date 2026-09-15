"use strict";

const { readFileSync, writeFileSync } = require("node:fs");
const { createGhReadOnlyClient } = require("./agentic-readiness-reader.cjs");
const { collectReadinessSnapshot, buildFactoryReadinessReport, renderReadinessMarkdown } = require("./agentic-factory-readiness.cjs");

async function main(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!["--repo", "--fixture", "--json", "--markdown", "--capability-evidence"].includes(args[index]) || !args[index + 1]) {
      throw new Error("Usage: node .github/scripts/agentic-factory-readiness-cli.cjs --repo owner/repo [--fixture snapshot.json] [--json report.json] [--markdown report.md] [--capability-evidence observations.json]");
    }
    values[args[index]] = args[index + 1];
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(values["--repo"] || "")) throw new Error("An explicit --repo owner/repo is required");
  const [owner, repo] = values["--repo"].split("/");
  const snapshot = values["--fixture"] ? JSON.parse(readFileSync(values["--fixture"], "utf8")) :
    await collectReadinessSnapshot({
      github: createGhReadOnlyClient(), context: { repo: { owner, repo } },
      config: { modelAvailability: values["--capability-evidence"] ? JSON.parse(readFileSync(values["--capability-evidence"], "utf8")) : [] },
    });
  const report = buildFactoryReadinessReport(snapshot);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (values["--json"]) writeFileSync(values["--json"], json);
  else process.stdout.write(json);
  if (values["--markdown"]) writeFileSync(values["--markdown"], `${renderReadinessMarkdown(report)}\n`);
  // A complete but paused report is a successful observation, not a healthy factory.
  if (!report.completeness.complete) process.exitCode = 2;
}

if (require.main === module) main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`Readiness failed: ${error.message}\n`);
  process.exitCode = 1;
});
module.exports = { main };
