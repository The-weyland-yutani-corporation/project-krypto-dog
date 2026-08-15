import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");

describe("Foundry Agent infrastructure", () => {
  const template = fs.readFileSync(
    path.join(root, "infra/foundry-agents.bicep"),
    "utf8",
  );

  it("creates separate system-identified dev and prod projects", () => {
    expect(template).toContain("resource devProject");
    expect(template).toContain("resource prodProject");
    expect(template.match(/type: 'SystemAssigned'/g)).toHaveLength(2);
    expect(template).toContain("krypto-dev-agents");
    expect(template).toContain("krypto-prod-agents");
  });

  it("scopes runtime consumers to their matching project", () => {
    expect(template).toContain(
      "foundryAgentConsumerRoleId = 'eed3b665-ab3a-47b6-8f48-c9382fb1dad6'",
    );
    expect(template).toMatch(
      /resource devRuntimeAgentConsumer[\s\S]*?scope: devProject/,
    );
    expect(template).toMatch(
      /resource prodRuntimeAgentConsumer[\s\S]*?scope: prodProject/,
    );
  });

  it("does not create models or grant an agent application permissions", () => {
    expect(template).not.toContain("accounts/deployments");
    expect(template).not.toContain("Microsoft.App/");
    expect(template).not.toContain("Microsoft.DBforPostgreSQL/");
  });

  it("keeps direct-model configuration out of new releases", () => {
    const release = fs.readFileSync(
      path.join(root, "infra/release.bicep"),
      "utf8",
    );

    expect(release).not.toContain("AZURE_OPENAI_BASE_URL");
    expect(release).not.toContain("AZURE_OPENAI_DEPLOYMENT_NAME");
  });

  it("gates legacy direct-model settings to the prod force-disable migration path", () => {
    const rollout = fs.readFileSync(
      path.join(root, "infra/rollout.bicep"),
      "utf8",
    );
    const devParams = fs.readFileSync(
      path.join(root, "infra/params/rollout.dev.bicepparam"),
      "utf8",
    );
    const prodParams = fs.readFileSync(
      path.join(root, "infra/params/rollout.prod.bicepparam"),
      "utf8",
    );

    expect(rollout).toContain(
      "param legacyDirectModelCompatibility bool = false",
    );
    expect(rollout).toContain(
      "var legacyDirectModelEnv = legacyDirectModelCompatibility",
    );
    expect(devParams).toContain(
      "param legacyDirectModelCompatibility = false",
    );
    expect(prodParams).toContain(
      "param legacyDirectModelCompatibility = true",
    );
  });

  it("pins the reviewed immutable agent version in release source", () => {
    for (const filename of [
      "release.dev.bicepparam",
      "release.prod.bicepparam",
      "rollout.dev.bicepparam",
      "rollout.prod.bicepparam",
    ]) {
      const params = fs.readFileSync(
        path.join(root, "infra/params", filename),
        "utf8",
      );
      expect(params).toContain("param azureFoundryAgentVersion = '1'");
      expect(params).not.toContain("FOUNDRY_AGENT_VERSION");
    }
  });
});
