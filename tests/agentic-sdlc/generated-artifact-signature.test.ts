import fs from "node:fs";
import path from "node:path";
import { generatedArtifactSignature } from "../../scripts/agentic/generated-artifact-signature";

const root = path.resolve(__dirname, "../..");

describe("generated artifact semantic signatures", () => {
  it("ignores volatile engine and resolved manifest metadata in workflow locks", () => {
    const base = [
      '# gh-aw-metadata: {"schema_version":"v4","frontmatter_hash":"front","body_hash":"body","compiler_version":"v0.81.6","strict":true,"agent_id":"copilot","engine_versions":{"copilot":"1.0.65"}}',
      '# gh-aw-manifest: {"actions":[{"repo":"actions/checkout","sha":"old"}]}',
    ].join("\n");
    const refreshed = base
      .replace("1.0.65", "1.0.99")
      .replace('"agent_id":"copilot"', '"agent_id":"resolved-agent"')
      .replace('"sha":"old"', '"sha":"new"');

    expect(
      generatedArtifactSignature("demo.lock.yml", refreshed),
    ).toBe(generatedArtifactSignature("demo.lock.yml", base));
  });

  it("detects source hash drift in workflow locks", () => {
    const first =
      '# gh-aw-metadata: {"schema_version":"v4","frontmatter_hash":"one","body_hash":"body","compiler_version":"v0.81.6","strict":true,"agent_id":"copilot"}';
    const second = first.replace('"one"', '"two"');

    expect(generatedArtifactSignature("demo.lock.yml", first)).not.toBe(
      generatedArtifactSignature("demo.lock.yml", second),
    );
  });

  it("normalizes volatile action SHAs and container digests in maintenance", () => {
    const first = `
name: Agentics Maintenance
jobs:
  cleanup:
    container: ghcr.io/example/tool:v1@sha256:${"a".repeat(64)}
    steps:
      - uses: actions/checkout@${"b".repeat(40)}
      - run: echo stable
`;
    const second = first
      .replace("a".repeat(64), "c".repeat(64))
      .replace("b".repeat(40), "d".repeat(40));

    expect(
      generatedArtifactSignature("agentics-maintenance.yml", first),
    ).toBe(
      generatedArtifactSignature("agentics-maintenance.yml", second),
    );
  });

  it("tracks the committed command-router payload", () => {
    const commands = fs.readFileSync(
      path.join(root, ".github/workflows/agentic_commands.yml"),
      "utf8",
    );
    expect(
      generatedArtifactSignature("agentic_commands.yml", commands),
    ).not.toBe("");
  });
});
