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
 * UI or triggers destructive recovery. The separate shadow journey runs only
 * with deterministic providers. Fixture credentials only.
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
test.use({ video: "on", viewport: { width: 1440, height: 1000 } });

test.afterAll(async () => {
  await database.end();
});

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

test("records proposals and journals without creating trades", async ({
  page,
}, testInfo) => {
  test.skip(
    manifest.mode !== "mock" || manifest.rollout !== "shadow",
    "Start the deterministic shadow harness to capture the decision journey.",
  );
  const [before] = await database`
    SELECT count(*)::int AS trades FROM krypto."TradeExecution"
  `;
  await login(page);
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("shadow", { exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("hero.png"),
    fullPage: true,
  });

  const rejected = await page.request.post("/api/admin/run-agent", {
    headers: { origin: "https://untrusted.example.test" },
  });
  expect(rejected.status()).toBe(403);

  // A fresh account first establishes a reference price without inference.
  for (let invocation = 0; invocation < 2; invocation += 1) {
    const [response] = await Promise.all([
      page.waitForResponse(
        (result) =>
          result.url().endsWith("/api/admin/run-agent") &&
          result.request().method() === "POST",
      ),
      page.getByRole("button", { name: /run agent now/i }).click(),
    ]);
    expect(response.status()).toBe(200);
    const result = await response.json();
    expect(result.status).toBe("skipped");
    const [run] = await database`
      SELECT "tradingMode", "proposedDecision", "authorizationResult"
      FROM krypto."AgentRun" WHERE "id" = ${result.runId}
    `;
    expect(run.tradingMode).toBe("SHADOW");
    if (result.action === "hold") {
      expect(invocation).toBe(0);
      expect(result.reasoning).toBe(
        "Cold start establishes a reference price before trading",
      );
      expect(run.proposedDecision).toBeNull();
    } else {
      expect(result.action).toBe("shadow");
      expect(run.proposedDecision).toHaveProperty("action", manifest.decision);
      expect(run.authorizationResult).toHaveProperty("authorized");
    }
    await expect(
      page.getByRole("button", { name: /run agent now/i }),
    ).toBeEnabled();
    await page.waitForLoadState("networkidle");
  }
  await page.screenshot({
    path: testInfo.outputPath("decision.png"),
    fullPage: true,
  });
  await page.goto("/admin/journal");
  await expect(page.getByRole("heading", { name: "Journal" })).toBeVisible();
  await expect(page.getByText(/No journal entries yet/)).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("journal.png"),
    fullPage: true,
  });
  await page.goto("/admin/trades");
  await expect(
    page.getByRole("heading", { name: "Trades", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("trades.png"),
    fullPage: true,
  });
  const [after] = await database`
    SELECT count(*)::int AS trades FROM krypto."TradeExecution"
  `;
  expect(after.trades).toBe(before.trades);
});
