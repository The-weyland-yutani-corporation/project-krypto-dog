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
const docsRoot = path.join(root, "docs");

function lineCount(file: string): number {
  return fs.readFileSync(file, "utf8").trimEnd().split(/\r?\n/).length;
}

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

  it("keeps specs and docs intentionally compact", () => {
    const specLines = canonicalSpecs.reduce(
      (total, filename) => total + lineCount(path.join(specsRoot, filename)),
      0,
    );
    const docLines = fs
      .readdirSync(docsRoot, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .reduce(
        (total, entry) =>
          total + lineCount(path.join(entry.parentPath, entry.name)),
        0,
      );

    expect(specLines).toBeLessThanOrEqual(40);
    expect(docLines).toBeLessThanOrEqual(94);
  });
});
