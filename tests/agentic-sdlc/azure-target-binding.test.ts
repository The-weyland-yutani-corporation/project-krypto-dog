import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function stringParameter(file: string, name: string): string {
  const matches = [
    ...read(file).matchAll(new RegExp(`^param ${name} = '([^']+)'\\r?$`, "gm")),
  ];
  if (matches.length !== 1 || !matches[0]?.[1]) {
    throw new Error(`Expected one nonempty literal ${name} in ${file}`);
  }
  return matches[0][1];
}

function environmentParameter(environment: string, name: string): string {
  return stringParameter(`infra/params/environment.${environment}.bicepparam`, name);
}

describe("Azure deployment target bindings", () => {
  it("federates the current repository and immutable owner identity", () => {
    const bootstrap = "infra/params/bootstrap.bicepparam";
    const owner = stringParameter(bootstrap, "githubOrg");
    const repository = stringParameter(bootstrap, "githubRepo");
    expect(read("package.json")).toContain(`github.com/${owner}/${repository}.git`);
    expect(owner).toBe("The-weyland-yutani-corporation");
    expect(stringParameter(bootstrap, "githubOwnerId")).toBe("264313301");
    expect(stringParameter(bootstrap, "githubRepoId")).toBe("1189023287");
    expect(read("infra/modules/oidc-identity.bicep")).toContain(
      "repo:${githubOrg}@${githubOwnerId}/${githubRepo}@${githubRepoId}:environment:${githubEnvironmentName}",
    );
  });

  it.each(["dev", "prod"])(
    "keeps %s release and rollback on the foundation vault and model host",
    (environment) => {
      const account = stringParameter(
        "infra/params/platform-account.bicepparam",
        "foundryAccountName",
      );
      const expectedEndpoint = `https://${account}.openai.azure.com/openai/v1/`;
      for (const phase of ["release", "rollout"]) {
        const file = `infra/params/${phase}.${environment}.bicepparam`;
        expect(stringParameter(file, "keyVaultName")).toBe(
          environmentParameter(environment, "keyVaultName"),
        );
        expect(stringParameter(file, "azureOpenAIBaseUrl")).toBe(expectedEndpoint);
        expect(stringParameter(file, "azureOpenAIDeploymentName")).toBe(
          stringParameter(
            "infra/params/platform.bicepparam",
            `${environment}DeploymentName`,
          ),
        );
      }
    },
  );

  it("binds account lifecycle, model deployment, and access to one reviewed account", () => {
    const account = stringParameter(
      "infra/params/platform-account.bicepparam",
      "foundryAccountName",
    );
    for (const template of ["platform-account", "platform", "platform-access"]) {
      expect(
        stringParameter(`infra/params/${template}.bicepparam`, "foundryAccountName"),
      ).toBe(account);
      expect(read(`infra/${template}.bicep`)).toContain(`  '${account}'`);
    }
  });

  it.each(["azure-deploy-prod.yml", "azure-rotate-secrets.yml"])(
    "keeps %s deterministic recovery names aligned with the production foundation",
    (workflowName) => {
      const workflow = read(`.github/workflows/${workflowName}`);
      const prefix = environmentParameter("prod", "namePrefix");
      const bindings: Record<string, string> = {
        ACR_NAME: environmentParameter("prod", "acrName"),
        CONTAINER_APPS_ENVIRONMENT_NAME: `cae-${prefix}`,
        RUNTIME_IDENTITY_NAME: `id-${prefix}-runtime`,
        SCHEDULER_IDENTITY_NAME: `id-${prefix}-scheduler`,
        EVIDENCE_STORAGE_ACCOUNT_NAME: environmentParameter(
          "prod",
          "evidenceStorageAccountName",
        ),
      };
      if (workflowName === "azure-rotate-secrets.yml") {
        bindings.OPS_IDENTITY_NAME = `id-${prefix}-ops`;
        bindings.COMMUNICATION_SERVICE_NAME = environmentParameter(
          "prod",
          "communicationServiceName",
        );
      }
      for (const [name, value] of Object.entries(bindings)) {
        expect(workflow.split(/\r?\n/)).toContain(`  ${name}: ${value}`);
      }
    },
  );

  it("keeps globally unique names distinct between environments", () => {
    for (const parameter of [
      "namePrefix",
      "acrName",
      "keyVaultName",
      "evidenceStorageAccountName",
      "communicationServiceName",
      "emailServiceName",
    ]) {
      expect(environmentParameter("dev", parameter)).not.toBe(
        environmentParameter("prod", parameter),
      );
    }
  });

  it.each(["dev", "prod"])(
    "keeps %s schedule monitoring on the foundation namespace",
    (environment) => {
      expect(
        stringParameter(
          `infra/params/schedule-monitoring.${environment}.bicepparam`,
          "namePrefix",
        ),
      ).toBe(environmentParameter(environment, "namePrefix"));
      const monitoring = read("infra/schedule-monitoring.bicep");
      expect(monitoring).toContain("param namePrefix string = 'krypto-${environmentName}'");
      expect(monitoring).toContain("'log-${namePrefix}'");
      expect(monitoring).toContain("'ag-${namePrefix}'");
    },
  );

  it("compiles monitoring parameters to JSON before applying activation overrides", () => {
    const workflow = read(".github/workflows/azure-deploy-dev.yml");
    const activation = workflow.slice(
      workflow.indexOf("- name: Enable and validate missing-success monitoring before Schedule"),
      workflow.indexOf('enabled="$(jq', workflow.indexOf("- name: Enable and validate missing-success monitoring before Schedule")),
    );
    expect(activation).toContain("az bicep build-params");
    expect(activation).toContain("--file infra/params/schedule-monitoring.dev.bicepparam");
    expect(activation).not.toContain("--parameters infra/params/schedule-monitoring.dev.bicepparam");
    expect(
      activation.match(/--parameters @\/tmp\/schedule-monitoring\.dev\.parameters\.json/g),
    ).toHaveLength(2);
    expect(
      activation.match(/--parameters enabled=true scheduleEnabledAtUnixSeconds=/g),
    ).toHaveLength(2);
  });

  it("does not turn a target rebind into production activation", () => {
    const rollout = "infra/params/rollout.prod.bicepparam";
    expect(stringParameter(rollout, "rolloutMode")).toBe("disabled");
    expect(stringParameter(rollout, "hourlyTriggerType")).toBe("Manual");
    expect(stringParameter(rollout, "dailyTriggerType")).toBe("Manual");
    expect(read("infra/platform-account.bicep")).toContain("disableLocalAuth: true");
  });
});
