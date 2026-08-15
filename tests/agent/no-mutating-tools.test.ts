import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");

describe("structured LLM boundary", () => {
  it("does not expose the retired mutating trade tool", () => {
    expect(
      fs.existsSync(path.join(root, "src/tools/safe-trade.ts")),
    ).toBe(false);

    const runFlow = fs.readFileSync(
      path.join(root, "src/agent/run-flow.ts"),
      "utf8",
    );
    expect(runFlow).not.toContain("safe_trade");
    expect(runFlow).not.toContain("createReactAgent");
  });

  it("does not carry the ReAct agent dependency", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };

    expect(packageJson.dependencies).not.toHaveProperty("langchain");
    expect(packageJson.dependencies).not.toHaveProperty(
      "@langchain/langgraph",
    );
  });

  it("deploys the Foundry prompt agent without tools or execution authority", () => {
    const deployScript = fs.readFileSync(
      path.join(root, "scripts/foundry-agent.ts"),
      "utf8",
    );
    const instructions = fs.readFileSync(
      path.join(
        root,
        "foundry/agents/krypto-decision/instructions.md",
      ),
      "utf8",
    );

    expect(deployScript).toContain("tools: []");
    expect(instructions).toMatch(/You have no\s+tools/i);
    expect(instructions).toMatch(/cannot execute/i);
  });
});
