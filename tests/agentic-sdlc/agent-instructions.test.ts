import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function exists(relativePath: string): boolean {
  return fs.existsSync(path.join(root, relativePath));
}

const ROOT_AGENTS = "AGENTS.md";
const COPILOT_SHIM = ".github/copilot-instructions.md";
const SCOPED_AGENTS = [
  "src/agent/AGENTS.md",
  "src/trading/AGENTS.md",
  "src/db/AGENTS.md",
  ".github/workflows/AGENTS.md",
];
const DISPATCHER = ".github/agents/agentic-workflows.md";
const SKILL = ".github/skills/agentic-workflows/SKILL.md";

const SAFETY_KERNEL_START = "<!-- safety-kernel:start -->";
const SAFETY_KERNEL_END = "<!-- safety-kernel:end -->";
const CODEX_BUDGET_BYTES = 32 * 1024;

/** Extract relative markdown link/target paths from a doc, ignoring URLs and anchors. */
function relativeLinks(markdown: string): string[] {
  const targets = new Set<string>();
  const linkRe = /\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = linkRe.exec(markdown)) !== null) {
    const raw = match[1].trim().split(/\s+/)[0];
    if (!raw || raw.startsWith("http://") || raw.startsWith("https://")) {
      continue;
    }
    if (raw.startsWith("#") || raw.startsWith("mailto:")) {
      continue;
    }
    targets.add(raw.split("#")[0]);
  }
  return [...targets];
}

describe("progressive agent instructions", () => {
  it("has every mapped instruction surface present", () => {
    expect(exists(ROOT_AGENTS)).toBe(true);
    expect(exists(COPILOT_SHIM)).toBe(true);
    expect(exists(DISPATCHER)).toBe(true);
    expect(exists(SKILL)).toBe(true);
    for (const scoped of SCOPED_AGENTS) {
      expect(exists(scoped)).toBe(true);
    }
  });

  it.each([
    ROOT_AGENTS,
    COPILOT_SHIM,
    ...SCOPED_AGENTS,
    DISPATCHER,
  ])("resolves every relative reference in %s", (docPath) => {
    const dir = path.dirname(path.join(root, docPath));
    const missing = relativeLinks(read(docPath)).filter(
      (target) => !fs.existsSync(path.resolve(dir, target)),
    );
    expect(missing).toEqual([]);
  });

  it("keeps the root-to-deepest instruction chain under Codex's 32 KiB budget", () => {
    const rootBytes = Buffer.byteLength(read(ROOT_AGENTS), "utf8");
    for (const scoped of SCOPED_AGENTS) {
      const chainBytes = rootBytes + Buffer.byteLength(read(scoped), "utf8");
      expect(chainBytes).toBeLessThan(CODEX_BUDGET_BYTES);
    }
  });

  it("carries the safety kernel in the root map and the Copilot shim", () => {
    for (const docPath of [ROOT_AGENTS, COPILOT_SHIM]) {
      const doc = read(docPath);
      expect(doc).toContain(SAFETY_KERNEL_START);
      expect(doc).toContain(SAFETY_KERNEL_END);
      expect(doc).toContain("paper");
      expect(doc.toLowerCase()).toContain("read-only");
    }
  });

  it("states the accepted merge and human-only authority policy in the root map", () => {
    const rootDoc = read(ROOT_AGENTS);
    expect(rootDoc).toContain("Agentic code review");
    expect(rootDoc).toContain("QA verification");
    expect(rootDoc).toContain("Security review");
    expect(rootDoc).toContain("Trading safety review");
    expect(rootDoc).toContain("authorized");
    expect(rootDoc).toContain("repository administrator");
    expect(rootDoc).toContain("explicit merge");
    expect(rootDoc).toContain("Agentic merge policy");
    expect(rootDoc.toLowerCase()).toContain("fork");
    expect(rootDoc.toLowerCase()).toContain("human approval");
    expect(rootDoc).toContain("live-trading enablement");
    expect(rootDoc).toContain("production deployment");
  });

  it("allows agent-authored boundary implementations without delegating authority", () => {
    const rootDoc = read(ROOT_AGENTS);
    const agentDoc = read("src/agent/AGENTS.md");
    const workflowDoc = read(".github/workflows/AGENTS.md");
    const dbDoc = read("src/db/AGENTS.md");

    expect(rootDoc).toContain("agents may author `risk:boundary` changes");
    expect(agentDoc).toContain(
      "Agents may author control-plane implementation changes",
    );
    expect(workflowDoc).toContain(
      "Reconciler and merge-policy implementation changes may be agent-authored",
    );
    expect(workflowDoc).not.toContain(
      "Reconciler/merge-policy logic and secrets are human-only",
    );
    expect(dbDoc).toContain(
      "Agents may implement and test database, backup, and inventory automation",
    );
  });

  it("directs agents from the Copilot shim to the root and scoped instructions", () => {
    const shim = read(COPILOT_SHIM);
    expect(shim).toContain("../AGENTS.md");
    for (const scoped of SCOPED_AGENTS) {
      const base = path.basename(path.dirname(scoped));
      expect(shim).toContain(base);
    }
    // The shim must not assume automatic nested discovery.
    expect(shim.toLowerCase()).toContain("does not");
  });

  it("keeps the workflow dispatcher thin and linked to the canonical skill", () => {
    const dispatcher = read(DISPATCHER);
    expect(Buffer.byteLength(dispatcher, "utf8")).toBeLessThan(2048);
    // Valid frontmatter retained.
    expect(dispatcher.startsWith("---\n")).toBe(true);
    expect(dispatcher).toContain("name: Agentic Workflows");
    expect(dispatcher).toContain("disable-model-invocation: true");
    // Points to the single source of truth, not a duplicated catalog.
    expect(dispatcher).toContain("skills/agentic-workflows/SKILL.md");
    expect(dispatcher).not.toContain("## Available Prompts");
  });
});
