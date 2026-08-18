import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import postgres from "postgres";
import {
  buildArtifacts,
  deriveHarnessDir,
  deriveWorktreeId,
  parseManifest,
} from "../../scripts/agent-harness";

/**
 * Operator-console safety-state validation against an already-running mock
 * harness. This asserts the EXISTING design surfaces the paper/shadow/disabled
 * rollout mode and the locked/paused/destructive controls; it never changes the
 * UI and never triggers a run or a destructive action. Fixture credentials only.
 */

const ADMIN_PASSWORD =
  process.env.HARNESS_ADMIN_PASSWORD ?? "harness-admin-password";
const worktreePath = fs.realpathSync(process.cwd());
const harnessId = deriveWorktreeId(worktreePath);
const artifacts = buildArtifacts(deriveHarnessDir(worktreePath, harnessId));
const manifest = parseManifest(fs.readFileSync(artifacts.manifest, "utf8"));
const database = postgres(
  `postgresql://krypto:krypto_local@127.0.0.1:${manifest.ports.db}/${manifest.databaseName}`,
  { max: 1 },
);

// First-hit dev compilation of the admin route can be slow; give it room.
test.setTimeout(150_000);

/**
 * Log in through the real UI. In dev, the very first interaction can fire before
 * the login page hydrates, which submits the form natively and lands back on
 * /admin/login. Retry until the dashboard renders (hydration completes on the
 * reloaded page), still exercising the genuine login form.
 */
async function login(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.goto("/admin/login");
    await page.waitForLoadState("networkidle");
    await page.getByPlaceholder("Enter admin password").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    try {
      await expect(
        page.getByRole("heading", { name: /agent dashboard/i }),
      ).toBeVisible({ timeout: 30_000 });
      return;
    } catch {
      // Not hydrated yet (native submit) — retry on the reloaded page.
    }
  }
  throw new Error("Login did not reach the operator dashboard.");
}

test.describe("operator console safety states", () => {
  test.beforeEach(async () => {
    await database`
      UPDATE krypto."AgentState"
      SET
        "isLocked" = true,
        "isOperatorPaused" = true,
        "lockReason" = 'Harness browser safety-state fixture',
        "lockedAt" = NOW()
      WHERE "id" = 'singleton'
    `;
  });

  test.afterEach(async () => {
    await database`
      UPDATE krypto."AgentState"
      SET
        "isLocked" = false,
        "isOperatorPaused" = false,
        "lockReason" = NULL,
        "lockedAt" = NULL
      WHERE "id" = 'singleton'
    `;
  });

  test.afterAll(async () => {
    await database.end();
  });

  test("exposes rollout mode and locked/paused/destructive controls", async ({
    page,
  }, testInfo) => {
    // 1. Log in with fixture credentials and land on the operator console.
    await login(page);
    await expect(page.getByText(/operator console/i)).toBeVisible();

    // 2. The Rollout Mode card must show a known safe (never live) mode.
    await expect(page.getByText("Rollout Mode", { exact: true })).toBeVisible();
    await expect(
      page.getByText(/^(disabled|shadow)$/i).first(),
    ).toBeVisible();
    await expect(page.getByText("live", { exact: true })).toHaveCount(0);

    // 3. The Operations panel must expose the run + pause + destructive
    //    recovery controls the design defines.
    await expect(
      page.getByRole("heading", { name: /^operations$/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /run agent now/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /resume agent/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /recover expired lease/i }),
    ).toBeVisible();

    // 4. The System Status badge must render a safety state.
    await expect(page.getByText("System Status", { exact: true })).toBeVisible();
    await expect(page.getByText("Locked", { exact: true })).toBeVisible();
    await expect(
      page.getByText(/drawdown safety lock engaged/i),
    ).toBeVisible();
    await expect(page.getByText(/agent paused by operator/i)).toBeVisible();
    await expect(
      page.getByRole("button", { name: /clear safety lock/i }),
    ).toBeVisible();

    // 5. Capture evidence under the harness artifact directory.
    await page.screenshot({
      path: testInfo.outputPath("operator-console.png"),
      fullPage: true,
    });
    await testInfo.attach("operator-console", {
      path: testInfo.outputPath("operator-console.png"),
      contentType: "image/png",
    });
  });
});
