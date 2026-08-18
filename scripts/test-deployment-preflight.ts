import assert from "node:assert/strict";
import { runDeploymentPreflight } from "../src/deployment/preflight";

const directUrl = process.env.DIRECT_URL;
const runtimeUrl = process.env.DATABASE_URL;
if (!directUrl || !runtimeUrl) {
  throw new Error("DIRECT_URL and DATABASE_URL are required");
}

const report = await runDeploymentPreflight({
  directUrl,
  runtimeUrl,
  now: new Date("2026-07-14T22:30:00.000Z"),
});

assert.equal(report.schemaVersion, "1.5.0");
assert.equal(
  report.databasePreflightPassed,
  true,
  `Unexpected preflight blockers: ${JSON.stringify(report.blockers)}`,
);
assert.equal(
  report.blockers.length,
  0,
  `Unexpected preflight blockers: ${JSON.stringify(report.blockers)}`,
);
assert.equal(report.inventory.agentState?.schema, "krypto");
assert.equal(report.inventory.agentState?.present, true);
assert.equal(report.inventory.openPaperPosition, false);
assert.equal(report.inventory.rowCounts["krypto.AgentState"], 1);
assert.equal(
  report.checks.find((check) => check.id === "runtime-connectivity")?.status,
  "pass",
);
assert.equal(
  report.checks.find((check) => check.id === "cron-state")?.status,
  "pass",
);
assert.equal(
  report.checks.find((check) => check.id === "database-target-match")
    ?.status,
  "pass",
);
assert.equal(
  report.checks.find(
    (check) => check.id === "fixed-cron-function-integrity",
  )?.status,
  "pass",
);
assert.equal(
  report.checks.find(
    (check) => check.id === "restricted-role-privileges",
  )?.status,
  "pass",
);

console.log(
  "Deployment preflight tests passed for target identity, exact schema inventory, singleton state, positions, leases, migrations, cron integrity, and privileges.",
);
