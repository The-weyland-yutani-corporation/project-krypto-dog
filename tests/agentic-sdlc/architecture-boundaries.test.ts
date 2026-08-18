import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function sourceFiles(directory: string): string[] {
  const absolute = path.join(root, directory);
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(relative);
    return entry.isFile() && /\.(ts|tsx)$/.test(entry.name) ? [relative] : [];
  });
}

describe("agent-legible architecture boundaries", () => {
  it("keeps model and decision modules read-only", () => {
    for (const file of ["src/agent/decision.ts", "src/agent/llm.ts"]) {
      const source = read(file);
      expect(source).not.toMatch(/from ["'].*paper-execut(?:or|ion)/);
    }
  });

  it("keeps deterministic trading code independent of agent/model modules", () => {
    for (const file of sourceFiles("src/trading")) {
      const source = read(file);
      expect(source).not.toMatch(/from ["']@\/agent\//);
      expect(source).not.toMatch(/from ["']@langchain\//);
    }
  });

  it("retains run-flow as the explicit composition root", () => {
    const source = read("src/agent/run-flow.ts");
    expect(source).toContain('from "@/agent/decision-provider"');
    expect(source).toContain('from "@/trading/paper-executor"');
    expect(source).toContain('from "@/db"');
  });

  it("has no live executor in v2", () => {
    const unsafe = sourceFiles("src").filter((file) =>
      /(?:^|[/.-])live[/.-].*execut|execut.*[/.-]live(?:[/.-]|$)/i.test(
        file,
      ),
    );
    expect(unsafe).toEqual([]);
    expect(fs.existsSync(path.join(root, "src/tools/safe-trade.ts"))).toBe(false);
  });

  it("keeps remediation text in every lint boundary", () => {
    const config = read("eslint.config.mjs");
    expect(config).toContain("Decision/model modules are read-only");
    expect(config).toContain("Deterministic trading policy and execution");
    expect(config).toContain("Shared/client UI components");
  });
});
