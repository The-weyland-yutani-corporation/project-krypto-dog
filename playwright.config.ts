import fs from "node:fs";

import { defineConfig, devices } from "@playwright/test";

import {
  buildArtifacts,
  deriveHarnessDir,
  deriveWorktreeId,
  parseManifest,
  type HarnessManifest,
} from "./scripts/agent-harness";

// Browser validation runs against an ALREADY-RUNNING harness. It never starts
// the app itself: bring the mock harness up first with `npm run harness:up`.
// The base URL and artifact directory are resolved from that harness's manifest
// (or overridden with HARNESS_BASE_URL for a custom target).

function resolveManifest(): HarnessManifest | null {
  try {
    const worktreePath = fs.realpathSync(process.cwd());
    const id = deriveWorktreeId(worktreePath);
    const artifacts = buildArtifacts(deriveHarnessDir(worktreePath, id));
    if (!fs.existsSync(artifacts.manifest)) return null;
    return parseManifest(fs.readFileSync(artifacts.manifest, "utf8"));
  } catch {
    return null;
  }
}

const manifest = resolveManifest();
const baseURL =
  process.env.HARNESS_BASE_URL ??
  (manifest ? `http://127.0.0.1:${manifest.ports.app}` : undefined);

const outputDir =
  manifest?.artifacts.screenshots ?? ".harness/playwright/test-results";

if (!baseURL) {
  throw new Error(
    "No running harness found. Start it with `npm run harness:up` (or set " +
      "HARNESS_BASE_URL) before running `npm run harness:browser`.",
  );
}

export default defineConfig({
  testDir: "./e2e/harness",
  outputDir,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // The harness binds to loopback only; never follow external navigations.
    ignoreHTTPSErrors: false,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
