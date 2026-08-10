import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

describe("agentic SDLC workflow contracts", () => {
  const reconciler = read(
    ".github/workflows/agentic-pr-reconciler.yml",
  );
  const e2e = read(".github/workflows/agentic-sdlc-e2e.yml");
  const codeReview = read(".github/workflows/code-review.md");
  const securityReview = read(".github/workflows/security-review.md");
  const selfHeal = read(".github/workflows/pr-self-heal.md");
  const tradingSafetyReview = read(
    ".github/workflows/trading-safety-review.md",
  );

  it("loads the tested reconciler implementation only from the trusted base", () => {
    expect(reconciler).toContain(
      "ref: ${{ github.event.repository.default_branch }}",
    );
    expect(reconciler).toContain("persist-credentials: false");
    expect(reconciler).toContain("sparse-checkout: .github/scripts");
    expect(reconciler).toContain(
      '".github/scripts/agentic-pr-reconciler.cjs"',
    );
    expect(reconciler).toContain(
      "await reconcileAgenticPullRequests({ github, context, core });",
    );
  });

  it("keeps the traditional E2E workflow manual-only", () => {
    const triggerBlock = e2e.slice(
      e2e.indexOf("on:"),
      e2e.indexOf("concurrency:"),
    );

    expect(triggerBlock).toContain("workflow_dispatch:");
    expect(triggerBlock).not.toMatch(
      /^\s+(pull_request|pull_request_target|push|schedule|workflow_run):/m,
    );
    expect(triggerBlock).toContain("- happy-path");
    expect(triggerBlock).toContain("- self-heal");
  });

  it("constrains the canary to the enrolled same-repository docs path", () => {
    expect(e2e).toContain(
      "if: github.repository == 'VeVarunSharma/project-krypto-dog'",
    );
    expect(e2e).toContain(
      "CANARY_PATH: docs/e2e/factory-heartbeat.md",
    );
    expect(e2e).toContain(
      "title: `[docs-sync] Agentic SDLC E2E ${mode} canary`",
    );
    expect(e2e).toContain('"agentic-factory"');
    expect(e2e).toContain('"docs-sync"');
    expect(e2e).toContain('"agentic-automerge"');
    expect(e2e).toContain("enablePullRequestAutoMerge");
    expect(e2e).toContain('workflow_id: "agentic-pr-reconciler.yml"');
  });

  it.each([
    "Quality and evidence gates",
    "PostgreSQL migrations and execution",
    "Agentic code review",
    "Agentic merge policy",
  ])("asserts the required %s context", (contextName) => {
    expect(e2e).toContain(`"${contextName}"`);
  });

  it("asserts merge and always cleans up the branch and failed PR", () => {
    expect(e2e).toContain("pull.merged_at");
    expect(e2e).toContain("readyForAutoMerge");
    expect(e2e).toContain("headIsStable");
    expect(e2e).toContain("autoMergeEnabledAt");
    expect(e2e).toContain(
      "merged before required contexts were verified",
    );
    expect(e2e.indexOf("readyForAutoMerge")).toBeLessThan(
      e2e.indexOf("enablePullRequestAutoMerge"),
    );
    expect(e2e.indexOf('state: "pending"')).toBeLessThan(
      e2e.indexOf("enablePullRequestAutoMerge"),
    );
    expect(e2e).toContain("statuses: write");
    expect(e2e).toContain("if: always()");
    expect(e2e).toContain(
      "CANARY_BRANCH: agentic-e2e/${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(e2e).toContain('state: "closed"');
    expect(e2e).toContain("github.rest.git.deleteRef");
  });

  it("wires the deterministic self-heal marker through review and repair", () => {
    const marker = "<!-- agentic-e2e:self-heal -->";

    expect(codeReview).toContain(marker);
    expect(codeReview).toContain("failing `Agentic code review` check");
    expect(selfHeal).toContain(marker);
    expect(selfHeal).toContain("remove only that marker");
    expect(e2e).toContain(marker);
    expect(e2e).toContain('message.includes("[self-heal]")');
    expect(e2e).toContain("selfHealCommits.length <= 2");
  });

  it("allows only trusted factory bots to activate manual code review", () => {
    expect(codeReview).toContain(
      'bots: ["github-actions[bot]", "copilot-swe-agent[bot]"]',
    );
  });

  it("requires trusted-bot specialist checks for high-risk PRs", () => {
    for (const workflow of [securityReview, tradingSafetyReview]) {
      expect(workflow).toContain(
        'bots: ["github-actions[bot]", "copilot-swe-agent[bot]"]',
      );
      expect(workflow).toContain("create-check-run:");
      expect(workflow).toContain("For every pull request");
    }
    expect(securityReview).toContain("name: Security review");
    expect(tradingSafetyReview).toContain(
      "name: Trading safety review",
    );
    expect(reconciler).toContain("Security Review");
    expect(reconciler).toContain("Trading Safety Review");
  });
});
