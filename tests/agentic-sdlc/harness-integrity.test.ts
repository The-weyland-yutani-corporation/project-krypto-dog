import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  buildWorkflowInventory,
  inventoryForWorkflow,
  listSourceWorkflowIds,
  splitFrontmatter,
} from "../../scripts/agentic/frontmatter";
import {
  applyInventorySection,
  renderInventorySection,
} from "../../scripts/generate-agentic-docs";

const root = path.resolve(__dirname, "../..");

function read(rel: string): string {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

const DOC = "docs/agentic-workflows-map.md";
const START = "<!-- generated:workflow-inventory:start -->";
const END = "<!-- generated:workflow-inventory:end -->";

describe("workflow frontmatter inventory", () => {
  it("enumerates every GH-AW source and excludes non-sources", () => {
    const ids = listSourceWorkflowIds();
    expect(ids).toContain("implement-ticket");
    expect(ids).toContain("pr-self-heal");
    // Non-source markdown and traditional YAML workflows are excluded.
    expect(ids).not.toContain("AGENTS");
    expect(ids).not.toContain("agentic-pr-reconciler");
    expect(ids).not.toContain("agentic_commands");
    // Every id has a matching source markdown file.
    for (const id of ids) {
      expect(fs.existsSync(path.join(root, ".github/workflows", `${id}.md`))).toBe(
        true,
      );
    }
  });

  it("summarizes imports, triggers, safe outputs, and credit caps deterministically", () => {
    const opportunity = inventoryForWorkflow("opportunity-discovery");
    expect(opportunity.imports).toEqual(["trading-growth-pm.md"]);
    expect(opportunity.triggers).toContain("manual");
    expect(opportunity.triggers).toContain("schedule: weekly");
    expect(opportunity.triggers).toContain("/discover");
    expect(opportunity.safeOutputs).toEqual([
      "add-comment",
      "create-issue",
      "noop",
    ]);
    expect(opportunity.creditCaps).toEqual({ perRun: 1000, perDay: 2000 });
  });

  it("resolves every declared workflow import", () => {
    for (const workflow of buildWorkflowInventory()) {
      expect(workflow.imports.length).toBeGreaterThan(0);
    }
  });

  it("labels built-in-prompt workflows that declare no imports", () => {
    expect(inventoryForWorkflow("code-review").imports).toEqual([
      "Built-in prompt",
    ]);
  });

  it("excludes safe-output config knobs from the output list", () => {
    // pr-self-heal declares max-patch-files / max-patch-size, which are config.
    const selfHeal = inventoryForWorkflow("pr-self-heal");
    expect(selfHeal.safeOutputs).not.toContain("max-patch-files");
    expect(selfHeal.safeOutputs).not.toContain("max-patch-size");
    expect(selfHeal.safeOutputs).toContain("push-to-pull-request-branch");
  });

  it("fails loud on markdown with no frontmatter fence", () => {
    expect(() => splitFrontmatter("# no frontmatter\n", "test.md")).toThrow(
      /missing opening/,
    );
  });
});

describe("generated workflow-inventory documentation", () => {
  it("keeps the committed doc section current (idempotent generation)", () => {
    const current = read(DOC);
    expect(applyInventorySection(current)).toBe(current);
  });

  it("renders a row for every source workflow with its import basename", () => {
    const section = renderInventorySection();
    for (const inv of buildWorkflowInventory()) {
      expect(section).toContain(`\`${inv.id}\``);
      for (const imp of inv.imports) {
        expect(section).toContain(imp);
      }
    }
  });

  it("preserves hand-authored rationale outside the generated markers", () => {
    const doc = read(DOC);
    expect(doc).toContain("## Safety and governance model");
    expect(doc).toContain("## SDLC lifecycle");
    expect(doc).toContain("## Typical paths");
    // The generated markers exist exactly once each.
    expect(doc.split(START).length - 1).toBe(1);
    expect(doc.split(END).length - 1).toBe(1);
  });

  it("throws a remediation-bearing error when the markers are missing", () => {
    expect(() => applyInventorySection("# doc with no markers")).toThrow(
      /npm run agentic:docs/,
    );
  });

  it("detects staleness when the generated section is tampered with", () => {
    const current = read(DOC);
    // Blank out everything between the markers; regeneration must restore it.
    const stripped = current.replace(
      new RegExp(`(${START})[\\s\\S]*?(${END})`),
      "$1\n$2",
    );
    expect(stripped).not.toBe(current);
    expect(applyInventorySection(stripped)).toBe(current);
  });
});

describe("harness integrity CI wiring", () => {
  const ci = read(".github/workflows/ci.yml");
  const pkg = JSON.parse(read("package.json")) as {
    scripts: Record<string, string>;
    devDependencies: Record<string, string>;
  };

  it("exposes the documented package scripts", () => {
    expect(pkg.scripts["agentic:docs"]).toBe(
      "npx tsx scripts/generate-agentic-docs.ts",
    );
    expect(pkg.scripts["harness:check"]).toBe(
      "npx tsx scripts/check-harness-integrity.ts",
    );
    expect(pkg.scripts["agentic:compile"]).toBe("gh aw compile --strict");
  });

  it("tracks cache-memory maintenance as a generated compile artifact", () => {
    const harness = read("scripts/check-harness-integrity.ts");
    expect(harness).toContain("agentics-maintenance.yml");
  });

  it("runs the staged CorrectionOps fixture contract", () => {
    const harness = read("scripts/check-harness-integrity.ts");
    expect(harness).toContain("collect-agentic-corrections.cjs");
    expect(harness).toContain("--check");
  });

  it("pins yaml as a direct dev dependency for frontmatter parsing", () => {
    expect(pkg.devDependencies.yaml).toBeDefined();
  });

  it("adds a read-only Harness integrity job pinned to gh-aw v0.81.6", () => {
    expect(ci).toContain("harness-integrity:");
    expect(ci).toContain("name: Harness integrity");
    expect(ci).toContain("github/gh-aw-actions/setup-cli@v0.81.6");
    expect(ci).toContain("version: v0.81.6");
    expect(ci).toContain("run: npm run harness:check");

    // The job is read-only and carries no secrets — assert on parsed YAML.
    const parsed = parseYaml(ci) as {
      jobs: Record<string, Record<string, unknown>>;
    };
    const job = parsed.jobs["harness-integrity"];
    expect(job).toBeDefined();
    expect(job.permissions).toEqual({ contents: "read" });
    expect(job.secrets).toBeUndefined();
    // No step passes secrets or requests write scope.
    expect(JSON.stringify(job)).not.toMatch(/write/);
    expect(JSON.stringify(job)).not.toMatch(/secrets\./);
  });

  it("matches the gh-aw version used by copilot-setup-steps", () => {
    const setup = read(".github/workflows/copilot-setup-steps.yml");
    expect(setup).toContain("v0.81.6");
  });
});
