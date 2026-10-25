import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateDisabledRollout } from "./lib/disabled-rollout.cjs";

export { validateDisabledRollout };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [, , snapshotPath, expectedImage] = process.argv;
    validateDisabledRollout(JSON.parse(readFileSync(snapshotPath, "utf8")), expectedImage);
    process.stdout.write("Verified exact disabled revision, Manual schedulers, and terminal executions.\n");
  } catch (error) {
    process.stderr.write(`Disabled rollout is not verified: ${error.message}\n`);
    process.exitCode = 1;
  }
}
