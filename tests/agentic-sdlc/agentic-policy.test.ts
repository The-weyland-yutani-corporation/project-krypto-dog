import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface AgenticPolicy {
  copilotSuggestedActorLogin: string;
  requiredContexts: readonly string[];
  mergeBlockingLabels: Set<string>;
  selfHealBlockingLabels: Set<string>;
  maxRepairCommits: number;
  maxOpenActionableOpportunities: number;
  forksRequireHumanApproval: boolean;
  paperOnly: boolean;
}

interface PolicyModule {
  AGENTIC_POLICY: AgenticPolicy;
  loadAgenticPolicy(policyPath?: string): AgenticPolicy;
}

interface ReconcilerModule {
  requiresSecurityReview(filename: string): boolean;
  requiresTradingSafetyReview(filename: string): boolean;
  isLowRiskPath(filename: string): boolean;
}

const root = path.resolve(__dirname, "../..");
const policyPath = path.join(root, ".github/agentic-policy.json");
const policyModule = jest.requireActual<PolicyModule>(
  "../../.github/scripts/agentic-policy.cjs",
);
const reconciler = jest.requireActual<ReconcilerModule>(
  "../../.github/scripts/agentic-pr-reconciler.cjs",
);

describe("canonical agentic policy", () => {
  it("loads the required contexts and safety caps", () => {
    expect(policyModule.AGENTIC_POLICY).toMatchObject({
      copilotSuggestedActorLogin: "copilot-swe-agent",
      maxRepairCommits: 2,
      maxOpenActionableOpportunities: 20,
      forksRequireHumanApproval: true,
      paperOnly: true,
    });
    expect(policyModule.AGENTIC_POLICY.requiredContexts).toEqual([
      "Quality and evidence gates",
      "PostgreSQL migrations and execution",
      "Agentic code review",
    ]);
    expect(
      policyModule.AGENTIC_POLICY.mergeBlockingLabels,
    ).not.toContain("security-review");
    expect(
      policyModule.AGENTIC_POLICY.mergeBlockingLabels,
    ).not.toContain("trading-safety");
    expect(
      [...policyModule.AGENTIC_POLICY.selfHealBlockingLabels],
    ).not.toEqual(
      expect.arrayContaining(["security-review", "trading-safety"]),
    );
  });

  it.each(["neutral", "skipped"])(
    "does not treat a %s named review check as approval",
    (conclusion) => {
      const reconcilerModule = jest.requireActual<{
        getCheckState(
          checks: Array<{
            id: number;
            name: string;
            status: string;
            conclusion: string;
          }>,
          name: string,
        ): string;
      }>("../../.github/scripts/agentic-pr-reconciler.cjs");
      expect(
        reconcilerModule.getCheckState(
          [
            {
              id: 1,
              name: "Security review",
              status: "completed",
              conclusion,
            },
          ],
          "Security review",
        ),
      ).toBe("failure");
    },
  );

  it.each([
    ".github/workflows/ci.yml",
    "src/app/api/admin/pause/route.ts",
    "src/app/api/auth/login/route.ts",
    "src/deployment/preflight.ts",
    "src/lib/admin-auth.ts",
    "src/lib/csrf.ts",
    "src/lib/secure-compare.ts",
    "src/proxy.ts",
    ".env.example",
    "docker-compose.yml",
    "next.config.ts",
    "package.json",
    "package-lock.json",
    "specs/product.md",
    "specs/operations.md",
    "specs/factory.md",
    "specs/governance.md",
  ])("preserves security routing for %s", (filename) => {
    expect(reconciler.requiresSecurityReview(filename)).toBe(true);
  });

  it.each([
    "src/agent/run-flow.ts",
    "src/backtest/runner.ts",
    "src/db/schema.ts",
    "src/guardrails/drawdown-check.ts",
    "src/tools/market-data.ts",
    "src/trading/policy.ts",
    "src/app/api/agent/run/route.ts",
    "drizzle/0001.sql",
    "supabase/migrations/0001.sql",
    "specs/product.md",
    "specs/operations.md",
    "specs/evaluation.md",
    "specs/factory.md",
    "specs/governance.md",
  ])("preserves trading-safety routing for %s", (filename) => {
    expect(reconciler.requiresTradingSafetyReview(filename)).toBe(true);
  });

  it.each([
    "src/lib/email.ts",
    "src/app/page.tsx",
    "docs/guides/contributing.md",
    "README.md",
  ])("does not invent specialist routing for %s", (filename) => {
    expect(reconciler.requiresSecurityReview(filename)).toBe(false);
    expect(reconciler.requiresTradingSafetyReview(filename)).toBe(false);
  });

  it.each([
    ["docs/guides/contributing.md", true],
    ["docs/e2e/factory-heartbeat.md", true],
    ["docs/agentic-guide.md", false],
    ["docs/trading/guide.md", false],
    ["README.md", false],
    ["docs/diagram.svg", false],
  ])("preserves low-risk classification for %s", (filename, expected) => {
    expect(reconciler.isLowRiskPath(filename)).toBe(expected);
  });

  it("rejects an unanchored specialist path pattern", () => {
    const temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "agentic-policy-"),
    );
    const temporaryPolicy = path.join(temporaryDirectory, "policy.json");
    const policy = JSON.parse(fs.readFileSync(policyPath, "utf8")) as {
      specialistRouting: {
        security: { patterns: string[] };
      };
    };
    policy.specialistRouting.security.patterns[0] = "\\.github/";
    fs.writeFileSync(temporaryPolicy, JSON.stringify(policy));

    try {
      expect(() =>
        policyModule.loadAgenticPolicy(temporaryPolicy),
      ).toThrow("must be anchored at the path root");
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
