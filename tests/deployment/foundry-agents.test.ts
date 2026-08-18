import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");

describe("Foundry Agent infrastructure", () => {
  const bootstrap = fs.readFileSync(
    path.join(root, "infra/bootstrap.bicep"),
    "utf8",
  );
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

  it("declares the exact custom invocation role in subscription bootstrap", () => {
    expect(bootstrap).toContain(
      "foundryAgentInvokerRoleId = '44dfdabf-22ec-45f5-923b-b42e44bdad76'",
    );
    expect(bootstrap).toContain(
      "roleName: 'Project Krypto Foundry Agent Invoker'",
    );

    const expectedDataActions = [
      "Microsoft.CognitiveServices/accounts/AIServices/agents/read",
      "Microsoft.CognitiveServices/accounts/AIServices/agents/write",
      "Microsoft.CognitiveServices/accounts/AIServices/responses/read",
      "Microsoft.CognitiveServices/accounts/AIServices/responses/write",
      "Microsoft.CognitiveServices/accounts/AIServices/endpoints/interact/action",
    ];
    const roleBlock = bootstrap.match(
      /resource foundryAgentInvokerRole[\s\S]*?\n}\n\n\/\/ RG-scoped/,
    )?.[0];
    expect(roleBlock).toBeDefined();
    expect(roleBlock).toContain(
      "description: 'Invoke a versioned Project Krypto Foundry prompt agent without agent deletion, state mutation, key access, or infrastructure permissions.'",
    );
    expect(roleBlock).toContain("type: 'CustomRole'");
    expect(roleBlock).toMatch(/\n\s+actions: \[\]/);
    expect(roleBlock).toMatch(/\n\s+notActions: \[\]/);
    expect(roleBlock).toMatch(/\n\s+notDataActions: \[\]/);
    expect(roleBlock).toMatch(/assignableScopes:[\s\S]*?subscription\(\)\.id/);
    for (const dataAction of expectedDataActions) {
      expect(roleBlock).toContain(`'${dataAction}'`);
    }
    expect(
      roleBlock?.match(/'Microsoft\.CognitiveServices\/[^']+'/g),
    ).toHaveLength(expectedDataActions.length);
  });

  it("assigns only the custom invoker role to matching workloads", () => {
    expect(template).toContain(
      "foundryAgentInvokerRoleId = '44dfdabf-22ec-45f5-923b-b42e44bdad76'",
    );

    for (const [principal, project] of [
      ["devRuntime", "devProject"],
      ["devOps", "devProject"],
      ["prodRuntime", "prodProject"],
      ["prodOps", "prodProject"],
    ]) {
      expect(template).toMatch(
        new RegExp(
          `resource ${principal}AgentInvoker[\\s\\S]*?scope: ${project}[\\s\\S]*?roleDefinitionId: subscriptionResourceId\\('Microsoft.Authorization/roleDefinitions', foundryAgentInvokerRoleId\\)`,
        ),
      );
    }

    expect(
      template.match(/resource (?:dev|prod)(?:Runtime|Ops)AgentInvoker /g),
    ).toHaveLength(4);
    expect(
      template.match(
        /roleDefinitionId: subscriptionResourceId\('Microsoft\.Authorization\/roleDefinitions', foundryUserRoleId\)/g,
      ),
    ).toHaveLength(4);
    expect(template).not.toContain("foundryAgentConsumerRoleId");
    expect(template).not.toContain("foundryProjectRuntimeUserRoleId");
    expect(template).not.toContain("cognitiveServicesDataReaderRoleId");
    for (const supersededRoleId of [
      "eed3b665-ab3a-47b6-8f48-c9382fb1dad6",
      "142bfaed-a13f-4c2d-bed2-6db62c4a1009",
      "b59867f0-fa02-499b-be73-45a86b5b3e1c",
    ]) {
      expect(template).not.toContain(supersededRoleId);
    }
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

  it("pins reviewed production evaluation lineage without storage credentials", () => {
    const foundryRoot = path.join(
      root,
      "foundry/agents/krypto-decision/.foundry",
    );
    const manifest = JSON.parse(
      fs.readFileSync(path.join(foundryRoot, "datasets/manifest.json"), "utf8"),
    ) as {
      datasets: Array<{
        environment: string;
        stage: string;
        version: string;
        generationJobId?: string;
        derivedFrom?: { generationJobId: string };
        evaluator?: { generationJobId: string };
      }>;
    };
    const generated = manifest.datasets.find(
      (dataset) =>
        dataset.environment === "prod" && dataset.stage === "generated",
    );
    const curated = manifest.datasets.find(
      (dataset) =>
        dataset.environment === "prod" && dataset.stage === "curated",
    );

    expect(generated).toMatchObject({
      version: "1.0",
      generationJobId: "datagen-7a9f9445e8b24bc1b10197ca4773797f",
    });
    expect(curated).toMatchObject({
      version: "2.0",
      derivedFrom: {
        generationJobId: "datagen-7a9f9445e8b24bc1b10197ca4773797f",
      },
      evaluator: {
        generationJobId:
          "evaluatorgen-krypto-prod-decision-safety-v1-400e898a",
      },
    });

    const dataset = fs
      .readFileSync(
        path.join(
          foundryRoot,
          "datasets/krypto-prod-decision-safety-v2.0/krypto-prod-decision-safety.jsonl",
        ),
        "utf8",
      )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { candidate_response: string });
    expect(dataset).toHaveLength(15);
    for (const row of dataset) {
      const response = JSON.parse(row.candidate_response) as {
        action: string;
        notionalUSD: number | null;
        reasoning: string;
      };
      expect(Object.keys(response)).toEqual([
        "action",
        "notionalUSD",
        "reasoning",
      ]);
      expect(["HOLD", "BUY", "SELL"]).toContain(response.action);
      expect(response.reasoning).not.toHaveLength(0);
      if (response.action === "HOLD") {
        expect(response.notionalUSD).toBeNull();
      } else {
        expect(response.notionalUSD).toBeGreaterThan(0);
      }
    }

    const refs = fs
      .readdirSync(path.join(foundryRoot, "datasets"))
      .filter((filename) => filename.endsWith(".ref.json"))
      .map((filename) =>
        fs.readFileSync(path.join(foundryRoot, "datasets", filename), "utf8"),
      )
      .join("\n");
    expect(refs).not.toMatch(/[?&]sig=|sktid=|skoid=|ske=|sks=/);
  });
});
