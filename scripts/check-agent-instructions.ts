/**
 * Validate the progressive agent-instruction hierarchy: every referenced
 * instruction surface exists, relative references resolve, the Copilot shim
 * redirects to the root and scoped maps, and the root-to-deepest-scoped chain
 * stays under Codex's 32 KiB default budget.
 *
 * These invariants are already codified as Jest contracts in
 * `tests/agentic-sdlc/agent-instructions.test.ts`. Rather than duplicate that
 * logic, the harness gate invokes the existing contract so the two can never
 * drift apart.
 *
 * Usage: tsx scripts/check-agent-instructions.ts
 */
import path from "node:path";
import { spawnSync } from "node:child_process";
import { REPO_ROOT } from "./agentic/frontmatter";

const CONTRACT = "tests/agentic-sdlc/agent-instructions.test.ts";
const REMEDIATION = `npx jest ${CONTRACT}`;

function main(): void {
  const jestBin = path.join(
    REPO_ROOT,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "jest.cmd" : "jest",
  );

  const result = spawnSync(
    jestBin,
    ["--silent", "--runInBand", CONTRACT],
    { cwd: REPO_ROOT, stdio: "inherit", env: process.env },
  );

  if (result.error) {
    process.stderr.write(
      `✗ ${CONTRACT}: failed to run instruction contract: ${result.error.message}\n` +
        `  Owning file: ${CONTRACT}\n` +
        `  Fix: ${REMEDIATION}\n`,
    );
    process.exit(1);
  }

  if (result.status !== 0) {
    process.stderr.write(
      `✗ Agent-instruction contract failed.\n` +
        `  Owning file: ${CONTRACT}\n` +
        `  Fix: address the reported instruction/reference/budget failure, then rerun \`${REMEDIATION}\`\n`,
    );
    process.exit(result.status ?? 1);
  }

  process.stdout.write(
    `✓ Agent-instruction hierarchy contract passed (${CONTRACT})\n`,
  );
}

main();
