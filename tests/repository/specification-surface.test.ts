import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const specsRoot = path.join(root, "specs");
const canonicalSpecs = [
  "evaluation.md",
  "factory.md",
  "governance.md",
  "operations.md",
  "product.md",
];
describe("canonical specification surface", () => {
  it("contains exactly the five flat canonical files", () => {
    const entries = fs
      .readdirSync(specsRoot, { withFileTypes: true })
      .map((entry) => ({
        name: entry.name,
        isFile: entry.isFile(),
      }));

    expect(entries.every((entry) => entry.isFile)).toBe(true);
    expect(entries.map((entry) => entry.name).sort()).toEqual(canonicalSpecs);
  });

  it("documents the non-negotiable safety boundaries", () => {
    const combined = canonicalSpecs
      .map((filename) =>
        fs.readFileSync(path.join(specsRoot, filename), "utf8"),
      )
      .join("\n")
      .toLowerCase();

    for (const term of [
      "paper-trading",
      "model",
      "deterministic",
      "guardrail",
      "reconciliation",
      "human-only",
      "live trading",
    ]) {
      expect(combined).toContain(term);
    }
  });

  it("preserves immutable migration provenance through Git history", () => {
    const governance = fs.readFileSync(
      path.join(specsRoot, "governance.md"),
      "utf8",
    );
    const migration = fs.readFileSync(
      path.join(
        root,
        "drizzle/0007_azure_retire_supabase_http_functions.sql",
      ),
      "utf8",
    );

    expect(migration).toContain(
      "specs/decisions/0008-azure-native-deployment-architecture.md",
    );
    expect(governance).toMatch(
      /retired spec paths embedded in applied migration comments.*Git history/i,
    );
    expect(governance).toMatch(/never rewrite migration bytes/i);
  });

});
