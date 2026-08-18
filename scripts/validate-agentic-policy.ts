/**
 * Validate the canonical agentic policy using the dependency-free CJS loader
 * (`.github/scripts/agentic-policy.cjs`). The loader performs strict startup
 * validation and throws on any malformed field, so a clean load is proof the
 * committed `.github/agentic-policy.json` is well-formed and fail-closed.
 *
 * This script deliberately reuses the exact loader the trusted reconciler runs
 * in production rather than re-implementing validation, so the harness gate and
 * the merge gate can never disagree about what a valid policy is.
 *
 * Usage: tsx scripts/validate-agentic-policy.ts
 */
import path from "node:path";
import { createRequire } from "node:module";
import { REPO_ROOT } from "./agentic/frontmatter";

const require = createRequire(path.join(REPO_ROOT, "package.json"));
const POLICY_LOADER = path.join(
  REPO_ROOT,
  ".github",
  "scripts",
  "agentic-policy.cjs",
);
const POLICY_JSON_REL = ".github/agentic-policy.json";
const REMEDIATION =
  "fix .github/agentic-policy.json to satisfy .github/scripts/agentic-policy.cjs, then rerun `npm run agentic:policy`";

function main(): void {
  let loaded: { loadAgenticPolicy: (p?: string) => { policyPath: string } };
  try {
    loaded = require(POLICY_LOADER);
  } catch (error) {
    fail(`cannot load policy loader: ${(error as Error).message}`);
    return;
  }

  try {
    const policy = loaded.loadAgenticPolicy();
    process.stdout.write(
      `✓ ${POLICY_JSON_REL}: valid (loaded via ${path.relative(
        REPO_ROOT,
        POLICY_LOADER,
      )})\n`,
    );
    void policy;
  } catch (error) {
    fail((error as Error).message);
  }
}

function fail(message: string): never {
  process.stderr.write(
    `✗ ${POLICY_JSON_REL}: ${message}\n` +
      `  Owning file: ${POLICY_JSON_REL}\n` +
      `  Fix: ${REMEDIATION}\n`,
  );
  process.exit(1);
}

main();
