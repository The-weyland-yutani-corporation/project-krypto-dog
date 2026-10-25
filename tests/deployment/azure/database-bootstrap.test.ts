const bootstrap = jest.requireActual<{
  classifyInventory: (value: unknown) => {
    existingRelease: boolean; postgresExists: boolean; kind: string;
  };
  inspectionConfig: (value: unknown) => unknown;
  validateInspectionJob: (
    definition: unknown, config: unknown, mode?: string, owner?: string,
  ) => Array<{ name: string; value: string }>;
  validateInitialCredentials: (env: Record<string, string>) => void;
  validateRuntimeCredentials: (env: Record<string, string>, config: unknown) => void;
  assertInspectionJobUnchanged: (before: unknown, after: unknown) => void;
}>("../../../.github/scripts/azure/database-bootstrap.cjs");

const scope = "/subscriptions/11111111-2222-3333-4444-555555555555/resourceGroups/rg-krypto-prod";
const identity = `${scope}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-krypto-prod02-ops`;
const owner = "11111111-2222-5333-8444-555555555555";
const config = {
  releaseSha: "a".repeat(40),
  imageDigest: `sha256:${"b".repeat(64)}`,
  imageRepository: "krypto-ops",
  registryLoginServer: "acrkryptoprod02.azurecr.io",
  databaseHost: "psql-krypto-prod02.postgres.database.azure.com",
  databaseName: "postgres",
  runtimeLoginRole: "krypto_app",
  opsIdentityId: identity,
  opsIdentityClientId: "22222222-3333-4444-5555-666666666666",
  containerAppsEnvironmentId: `${scope}/providers/Microsoft.App/managedEnvironments/cae-krypto-prod02`,
  directUrlSecretUri: "https://kv-krypto-prod02.vault.azure.net/secrets/direct-url",
  evidenceContainerUrl: "https://stkryptoprod02evid.blob.core.windows.net/evidence",
};
const names = {
  app: "ca-prod-web", postgres: "psql-krypto-prod02", keyVault: "kv-krypto-prod02",
  jobs: [
    "caj-prod-agent-run", "caj-prod-daily-summary", "caj-prod-migrate-init",
    "caj-prod-preflight", "caj-prod-verified-backup", "caj-prod-target-smoke", "caj-prod-activation-check",
  ],
  bootstrapIdentities: ["id-prod-deploy", "id-prod-promotion"],
};
const resource = (type: string, name: string) => ({ type, name, id: `${scope}/providers/${type}/${name}` });

function inventory(kind = "new") {
  const jobs = kind === "existing" ? names.jobs.map((name) => resource("Microsoft.App/jobs", name)) : [];
  const apps = kind === "existing" ? [resource("Microsoft.App/containerApps", names.app)] : [];
  const servers = kind !== "new" ? [resource("Microsoft.DBforPostgreSQL/flexibleServers", names.postgres)] : [];
  const vaults = kind !== "new" ? [resource("Microsoft.KeyVault/vaults", names.keyVault)] : [];
  return {
    names, jobs, apps, servers, vaults,
    resources: [
      ...jobs, ...apps, ...servers, ...vaults,
      ...names.bootstrapIdentities.map((name) => resource("Microsoft.ManagedIdentity/userAssignedIdentities", name)),
    ],
  };
}

function job(operation = "migrate-init") {
  const env: Array<{ name: string; value?: string; secretRef?: string }> = [
    { name: "ENVIRONMENT_NAME", value: "prod" },
    { name: "RELEASE_SHA", value: config.releaseSha },
    { name: "OPERATION", value: operation },
    { name: "AZURE_RUNTIME_LOGIN_ROLE", value: config.runtimeLoginRole },
    { name: "AZCOPY_MSI_CLIENT_ID", value: config.opsIdentityClientId },
    { name: "AZURE_CLIENT_ID", value: config.opsIdentityClientId },
    { name: "EVIDENCE_CONTAINER_URL", value: config.evidenceContainerUrl },
    { name: "DIRECT_URL", secretRef: "direct-url" },
  ];
  const secrets = [{ name: "direct-url", keyVaultUrl: config.directUrlSecretUri, identity }];
  if (operation === "migrate-init") {
    env.push(
      { name: "DATABASE_URL", secretRef: "database-url" },
      { name: "AZURE_RUNTIME_LOGIN_PASSWORD", secretRef: "azure-runtime-login-password" },
    );
    secrets.push(
      { name: "database-url", keyVaultUrl: config.directUrlSecretUri.replace(/direct-url$/, "database-url"), identity },
      {
        name: "azure-runtime-login-password",
        keyVaultUrl: config.directUrlSecretUri.replace(/direct-url$/, "runtime-database-password"), identity,
      },
    );
  } else {
    env.push(
      { name: "DATABASE_INSPECTION_HOST", value: config.databaseHost },
      { name: "DATABASE_INSPECTION_NAME", value: config.databaseName },
      { name: "OPS_IMAGE_DIGEST", value: config.imageDigest },
    );
  }
  return {
    id: `${scope}/providers/Microsoft.App/jobs/caj-prod-migrate-init`,
    name: "caj-prod-migrate-init",
    tags: { "krypto-bootstrap-owner": owner },
    identity: { type: "UserAssigned", userAssignedIdentities: { [identity]: {} } },
    properties: {
      environmentId: config.containerAppsEnvironmentId,
      configuration: {
        triggerType: "Manual", replicaRetryLimit: 0,
        replicaTimeout: operation === "migrate-init" ? 900 : 120,
        manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 },
        registries: [{ server: config.registryLoginServer, identity }],
        secrets,
      },
      template: {
        containers: [{
          name: "caj-prod-migrate-init",
          image: `${config.registryLoginServer}/${config.imageRepository}@${config.imageDigest}`,
          command: ["npm"], args: ["run", "azure:ops-job"], env,
        }],
      },
    },
  };
}

describe("database bootstrap inventory", () => {
  it.each(["new", "inspect", "existing"])("classifies only complete %s inventory", (kind) => {
    expect(bootstrap.classifyInventory(inventory(kind))).toEqual({
      existingRelease: kind === "existing", postgresExists: kind !== "new", kind,
    });
  });

  it("never calls missing workloads a new database when the database survives", () => {
    expect(bootstrap.classifyInventory(inventory("inspect")).kind).toBe("inspect");
  });

  it.each(["jobs", "apps", "servers", "vaults", "resources"])("rejects an unavailable %s inventory", (field) => {
    expect(() => bootstrap.classifyInventory({ ...inventory(), [field]: null })).toThrow();
  });

  it("rejects deletion/recreation races between the specialized and generic inventories", () => {
    expect(() => bootstrap.classifyInventory({ ...inventory("inspect"), servers: [] })).toThrow(/changed|incomplete/);
  });

  it("rejects a partial release and an otherwise complete release with an unknown job", () => {
    for (const kind of ["new", "existing"]) {
      const value = inventory(kind);
      const unknown = resource("Microsoft.App/jobs", "unexpected-job");
      value.jobs.push(unknown);
      value.resources.push(unknown);
      expect(() => bootstrap.classifyInventory(value)).toThrow(/Partial|unknown/);
    }
  });

  it("rejects a surviving vault or partial foundation instead of overwriting credentials", () => {
    const value = inventory();
    const vault = resource("Microsoft.KeyVault/vaults", names.keyVault);
    value.vaults.push(vault);
    value.resources.push(vault);
    expect(() => bootstrap.classifyInventory(value)).toThrow(/Surviving|partial/);
    expect(() => bootstrap.classifyInventory({
      ...inventory(), resources: [resource("Microsoft.Storage/storageAccounts", "retainedstate")],
    })).toThrow(/Surviving|partial/);
  });

  it("rejects duplicates but permits the same resource name in distinct Azure types", () => {
    const value = inventory();
    value.resources.push(resource("Microsoft.Resources/deployments", names.bootstrapIdentities[0]));
    expect(bootstrap.classifyInventory(value).kind).toBe("new");
    value.resources.push(value.resources[0]);
    expect(() => bootstrap.classifyInventory(value)).toThrow(/duplicate/);
  });
});

describe("closed native database operation", () => {
  it("accepts only nonsecret bound configuration", () => {
    expect(bootstrap.inspectionConfig(JSON.stringify(config))).toEqual(config);
  });

  it.each([
    { releaseSha: ["a".repeat(40)] }, { imageDigest: "latest" },
    { opsIdentityClientId: "-".repeat(36) },
    { containerAppsEnvironmentId: "unbound-environment" },
    { opsIdentityId: identity.replace("11111111-2222-3333-4444-555555555555", "-".repeat(36)) },
    { directUrlSecretUri: `${config.directUrlSecretUri}/version` },
    { directUrlSecretUri: `${config.directUrlSecretUri}?api-version=1` },
    { evidenceContainerUrl: `${config.evidenceContainerUrl}?sig=secret` },
    { runtimeLoginRole: "krypto_runtime" }, { databaseHost: "foreign.example.com" },
    { imageRepository: "arbitrary-command" }, { DIRECT_URL: "secret" },
  ])("rejects malformed or widened configuration %j", (override) => {
    expect(() => bootstrap.inspectionConfig({ ...config, ...override })).toThrow();
  });

  it("returns only fixed read-only inspection overrides", () => {
    expect(bootstrap.validateInspectionJob(job(), config)).toEqual([
      { name: "OPERATION", value: "database-inspection" },
      { name: "DATABASE_INSPECTION_HOST", value: config.databaseHost },
      { name: "DATABASE_INSPECTION_NAME", value: config.databaseName },
      { name: "OPS_IMAGE_DIGEST", value: config.imageDigest },
    ]);
  });

  it("requires fresh admission again inside the normal migration operation", () => {
    expect(bootstrap.validateInspectionJob(job(), config, "migration")[0]).toEqual({
      name: "MIGRATION_REQUIRE_EMPTY_DATABASE", value: "true",
    });
    expect(() => bootstrap.validateInspectionJob(job("database-inspection"), config, "migration")).toThrow();
  });

  const invalidJobs: Array<[string, (value: ReturnType<typeof job>) => void]> = [
    ["wrong image", (value) => { value.properties.template.containers[0].image = "registry/other:latest"; }],
    ["wrong command", (value) => { value.properties.template.containers[0].command = ["sh"]; }],
    ["wrong args", (value) => { value.properties.template.containers[0].args.push("--eval"); }],
    ["foreign scope", (value) => { value.id = value.id.replace("rg-krypto-prod", "rg-foreign"); }],
    ["foreign managed environment", (value) => { value.properties.environmentId += "-foreign"; }],
    ["retry", (value) => { value.properties.configuration.replicaRetryLimit = 1; }],
    ["parallel replica", (value) => { value.properties.configuration.manualTriggerConfig.parallelism = 2; }],
    ["schedule", (value) => { value.properties.configuration.triggerType = "Schedule"; }],
    ["native execution injection", (value) => {
      value.properties.template.containers[0].env.push({ name: "CONTAINER_APP_JOB_EXECUTION_NAME", value: "forged" });
    }],
    ["logical execution injection", (value) => {
      value.properties.template.containers[0].env.push({ name: "JOB_EXECUTION_ID", value: "forged" });
    }],
    ["Node preload", (value) => {
      value.properties.template.containers[0].env.push({ name: "NODE_OPTIONS", value: "--require malicious.js" });
    }],
    ["extra secret", (value) => {
      value.properties.configuration.secrets.push({ name: "extra", keyVaultUrl: config.directUrlSecretUri, identity });
    }],
    ["inline secret", (value) => {
      Object.assign(value.properties.configuration.secrets[0], { value: "password" });
    }],
    ["duplicate env", (value) => {
      value.properties.template.containers[0].env.push(value.properties.template.containers[0].env[0]);
    }],
    ["secret used as plain value", (value) => {
      Object.assign(value.properties.template.containers[0].env[7], { value: "postgres://password" });
    }],
    ["sidecar", (value) => {
      value.properties.template.containers.push(value.properties.template.containers[0]);
    }],
    ["init container", (value) => { Object.assign(value.properties.template, { initContainers: [{}] }); }],
    ["volume", (value) => { Object.assign(value.properties.template, { volumes: [{}] }); }],
    ["working directory", (value) => {
      Object.assign(value.properties.template.containers[0], { workingDir: "/malicious" });
    }],
    ["foreign registry credentials", (value) => {
      Object.assign(value.properties.configuration.registries[0], { passwordSecretRef: "other" });
    }],
    ["different identity", (value) => {
      Object.assign(value.identity, { userAssignedIdentities: {} });
    }],
    ["disabled URI binding", (value) => { value.properties.configuration.secrets[0].keyVaultUrl += "/stale-version"; }],
  ];
  it.each(invalidJobs)("rejects %s before executing anything", (_name, mutate) => {
    const value = job();
    mutate(value);
    expect(() => bootstrap.validateInspectionJob(value, config)).toThrow();
  });

  it("only recognizes the unchanged, read-only, invocation-owned temporary resource", () => {
    const value = job("database-inspection");
    expect(bootstrap.validateInspectionJob(value, config, "bootstrap", owner)[0].value).toBe("database-inspection");
    expect(() => bootstrap.validateInspectionJob(value, config, "bootstrap", "wrong")).toThrow();
    value.properties.configuration.replicaTimeout = 900;
    expect(() => bootstrap.validateInspectionJob(value, config, "bootstrap", owner)).toThrow();
    expect(() => bootstrap.validateInspectionJob(job(), config, "bootstrap", owner)).toThrow();
  });
});

describe("fresh credential consistency without credential output", () => {
  const initial = {
    POSTGRES_SERVER_NAME: "psql-krypto-prod02",
    POSTGRES_ADMIN_PASSWORD_PROD: "local-fixture-only",
    DIRECT_URL_PROD: `postgres://krypto_owner:local-fixture-only@${config.databaseHost}/postgres?sslmode=require`,
  };
  const runtime = {
    DATABASE_URL_PROD: `postgres://krypto_app:local-fixture-only@${config.databaseHost}/postgres?sslmode=require`,
    RUNTIME_DATABASE_PASSWORD_PROD: "local-fixture-only",
  };
  it("matches the new foundation and the separate runtime binding", () => {
    expect(() => bootstrap.validateInitialCredentials(initial)).not.toThrow();
    expect(() => bootstrap.validateRuntimeCredentials(runtime, config)).not.toThrow();
  });

  it.each([
    ["host", (url: string) => url.replace(config.databaseHost, "foreign.postgres.database.azure.com")],
    ["database", (url: string) => url.replace("/postgres?", "/other?")],
    ["TLS", (url: string) => url.replace("sslmode=require", "sslmode=disable")],
    ["extra options", (url: string) => `${url}&options=-c%20search_path=public`],
    ["password", (url: string) => url.replace("local-fixture-only", "incorrect")],
    ["port", (url: string) => url.replace("/postgres?", ":6432/postgres?")],
  ])("rejects a mismatched %s before any credential mutation", (_name, change) => {
    expect(() => bootstrap.validateInitialCredentials({
      ...initial, DIRECT_URL_PROD: change(initial.DIRECT_URL_PROD),
    })).toThrow();
    expect(() => bootstrap.validateRuntimeCredentials({
      ...runtime, DATABASE_URL_PROD: change(runtime.DATABASE_URL_PROD),
    }, config)).toThrow();
  });
  it("does not include either password in its failure", () => {
    expect(() => bootstrap.validateInitialCredentials({
      ...initial, POSTGRES_ADMIN_PASSWORD_PROD: "different-password",
    })).toThrow("Initial database bindings do not match the intended new foundation.");
    expect(() => bootstrap.validateRuntimeCredentials({
      ...runtime, RUNTIME_DATABASE_PASSWORD_PROD: "different-password",
    }, config)).toThrow("Runtime credentials do not match the inspected fresh database and login role.");
  });
});

describe("owned inspection cleanup", () => {
  it("ignores provider status but preserves every mutable part of the definition", () => {
    const before = job("database-inspection");
    const after = job("database-inspection");
    Object.assign(after, { systemData: { lastModifiedAt: "2026-01-01T00:00:00Z" } });
    Object.assign(after.properties, { provisioningState: "Succeeded", runningStatus: "Ready" });
    expect(() => bootstrap.assertInspectionJobUnchanged(before, after)).not.toThrow();
  });

  it.each(["location", "tags", "identity"])("refuses to delete changed %s", (key) => {
    const before = job("database-inspection");
    expect(() => bootstrap.assertInspectionJobUnchanged(before, {
      ...before, [key]: "changed",
    })).toThrow(/changed after creation/);
  });

  it.each(["environmentId", "workloadProfileName", "configuration", "template"])(
    "refuses to delete changed properties.%s",
    (key) => {
      const before = job("database-inspection");
      expect(() => bootstrap.assertInspectionJobUnchanged(before, {
        ...before, properties: { ...before.properties, [key]: "changed" },
      })).toThrow(/changed after creation/);
    },
  );

  it.each([null, {}, { properties: null }])("rejects an unavailable definition %j", (value) => {
    expect(() => bootstrap.assertInspectionJobUnchanged(job(), value)).toThrow();
    expect(() => bootstrap.assertInspectionJobUnchanged(value, job())).toThrow();
  });
});
