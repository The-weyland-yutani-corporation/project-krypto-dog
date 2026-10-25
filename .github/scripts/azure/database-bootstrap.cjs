"use strict";

const { readFileSync } = require("node:fs");
const { timingSafeEqual } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_PATTERN = new RegExp(`^${UUID}$`, "i");
const IDENTITY_PATTERN = new RegExp(
  `^/subscriptions/${UUID}/resourceGroups/[A-Za-z0-9._()-]+/providers/Microsoft\\.ManagedIdentity/userAssignedIdentities/[A-Za-z0-9_-]+$`,
  "i",
);
const ENVIRONMENT_PATTERN = new RegExp(
  `^/subscriptions/${UUID}/resourceGroups/[A-Za-z0-9._()-]+/providers/Microsoft\\.App/managedEnvironments/[A-Za-z0-9_-]+$`,
  "i",
);

function record(value, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value;
}

function inventory(value) {
  if (!Array.isArray(value) || value.length > 1000) throw new Error("Incomplete Azure inventory.");
  const names = new Set();
  const ids = new Set();
  for (const entry of value) {
    record(entry, "Malformed Azure resource.");
    if (typeof entry.name !== "string" || !entry.name ||
        typeof entry.type !== "string" || !entry.type ||
        typeof entry.id !== "string" || !entry.id ||
        names.has(`${entry.type}/${entry.name}`.toLowerCase()) || ids.has(entry.id.toLowerCase())) {
      throw new Error("Malformed or duplicate Azure resource inventory.");
    }
    names.add(`${entry.type}/${entry.name}`.toLowerCase());
    ids.add(entry.id.toLowerCase());
  }
  return value;
}

function classifyInventory(input) {
  record(input, "Missing inventory.");
  const names = record(input.names, "Missing expected resource names.");
  if (!Array.isArray(names.jobs) || names.jobs.length !== 7 ||
      new Set(names.jobs).size !== 7 ||
      ![names.app, names.postgres, names.keyVault, ...names.jobs]
        .every((name) => typeof name === "string" && /^[a-z][a-z0-9-]{1,62}$/.test(name)) ||
      !Array.isArray(names.bootstrapIdentities) || names.bootstrapIdentities.length !== 2 ||
      !names.bootstrapIdentities.every((name) => typeof name === "string" && /^[A-Za-z0-9_-]+$/.test(name))) {
    throw new Error("Incomplete expected Azure resource names.");
  }
  const jobs = inventory(input.jobs);
  const apps = inventory(input.apps);
  const servers = inventory(input.servers);
  const vaults = inventory(input.vaults);
  const resources = inventory(input.resources);
  for (const [entries, type] of [
    [jobs, "microsoft.app/jobs"], [apps, "microsoft.app/containerapps"],
    [servers, "microsoft.dbforpostgresql/flexibleservers"], [vaults, "microsoft.keyvault/vaults"],
  ]) {
    const expectedIds = resources.filter((resource) => resource.type.toLowerCase() === type)
      .map((resource) => resource.id.toLowerCase()).sort();
    if (entries.some((entry) => entry.type.toLowerCase() !== type) ||
        JSON.stringify(entries.map((entry) => entry.id.toLowerCase()).sort()) !== JSON.stringify(expectedIds)) {
      throw new Error("Azure resource inventories changed or are incomplete.");
    }
  }
  const present = names.jobs.filter((name) => jobs.some((job) => job.name === name)).length +
    Number(apps.some((app) => app.name === names.app));
  const postgresExists = servers.some((server) => server.name === names.postgres);
  if (present === 8 && jobs.length === 7 && apps.length === 1 &&
      postgresExists && servers.length === 1 &&
      vaults.length === 1 && vaults[0].name === names.keyVault) {
    return { existingRelease: true, postgresExists: true, kind: "existing" };
  }
  if (present !== 0 || jobs.length !== 0 || apps.length !== 0) {
    throw new Error("Partial or unknown workloads require owned recovery, not fresh initialization.");
  }
  if (postgresExists && servers.length === 1 &&
      vaults.length === 1 && vaults[0].name === names.keyVault) {
    return { existingRelease: false, postgresExists: true, kind: "inspect" };
  }
  const bootstrapOnly = resources.every((resource) =>
    (resource.type?.toLowerCase() === "microsoft.managedidentity/userassignedidentities" &&
      names.bootstrapIdentities.includes(resource.name)) ||
    ["microsoft.resources/deployments", "microsoft.authorization/roleassignments"]
      .includes(resource.type?.toLowerCase()),
  );
  if (servers.length === 0 && vaults.length === 0 && bootstrapOnly) {
    return { existingRelease: false, postgresExists: false, kind: "new" };
  }
  throw new Error("Surviving or partial foundation resources do not establish a fresh database.");
}

function inspectionConfig(value) {
  const config = record(typeof value === "string" ? JSON.parse(value) : value, "Missing inspection configuration.");
  const fields = [
    "releaseSha", "imageDigest", "imageRepository", "registryLoginServer",
    "databaseHost", "databaseName", "runtimeLoginRole", "opsIdentityId",
    "opsIdentityClientId", "directUrlSecretUri", "evidenceContainerUrl", "containerAppsEnvironmentId",
  ];
  if (Object.keys(config).sort().join(",") !== fields.sort().join(",") ||
      !fields.every((field) => typeof config[field] === "string") ||
      !/^[0-9a-f]{40}$/.test(config.releaseSha) ||
      !/^sha256:[0-9a-f]{64}$/.test(config.imageDigest) ||
      !["krypto-ops", "krypto-bootstrap-ops"].includes(config.imageRepository) ||
      !/^[a-z0-9]{5,50}\.azurecr\.io$/.test(config.registryLoginServer) ||
      !/^[a-z0-9-]{3,63}\.postgres\.database\.azure\.com$/.test(config.databaseHost) ||
      !/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(config.databaseName) ||
      !/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(config.runtimeLoginRole) ||
      config.runtimeLoginRole === "krypto_runtime" ||
      !IDENTITY_PATTERN.test(config.opsIdentityId) ||
      !ENVIRONMENT_PATTERN.test(config.containerAppsEnvironmentId) ||
      !UUID_PATTERN.test(config.opsIdentityClientId) ||
      !/^https:\/\/[a-z0-9-]{3,24}\.vault\.azure\.net\/secrets\/direct-url$/.test(config.directUrlSecretUri) ||
      !/^https:\/\/[a-z0-9]{3,24}\.blob\.core\.windows\.net\/evidence$/.test(config.evidenceContainerUrl)) {
    throw new Error("Invalid or unbound database inspection configuration.");
  }
  return config;
}

function validateInspectionJob(definition, input, mode = "inspect", owner) {
  const config = inspectionConfig(input);
  record(definition, "Missing inspection job.");
  const settings = definition.properties?.configuration;
  const template = definition.properties?.template;
  const container = template?.containers?.[0];
  const identities = Object.keys(definition.identity?.userAssignedIdentities ?? {});
  const scope = config.opsIdentityId.slice(0, config.opsIdentityId.toLowerCase().indexOf("/providers/"));
  if (!["inspect", "migration", "bootstrap"].includes(mode) ||
      definition.name !== "caj-prod-migrate-init" ||
      definition.id?.toLowerCase() !== `${scope}/providers/Microsoft.App/jobs/caj-prod-migrate-init`.toLowerCase() ||
      definition.properties?.environmentId?.toLowerCase() !== config.containerAppsEnvironmentId.toLowerCase() ||
      definition.identity?.type !== "UserAssigned" ||
      identities.length !== 1 || identities[0].toLowerCase() !== config.opsIdentityId.toLowerCase() ||
      settings?.triggerType !== "Manual" || settings.scheduleTriggerConfig != null ||
      settings.eventTriggerConfig != null || settings.replicaRetryLimit !== 0 ||
      settings.manualTriggerConfig?.parallelism !== 1 ||
      settings.manualTriggerConfig?.replicaCompletionCount !== 1 ||
      !Number.isInteger(settings.replicaTimeout) || settings.replicaTimeout < 1 || settings.replicaTimeout > 900 ||
      !Array.isArray(template?.containers) || template.containers.length !== 1 || !container ||
      (template.initContainers?.length ?? 0) !== 0 || (template.volumes?.length ?? 0) !== 0 ||
      (container.volumeMounts?.length ?? 0) !== 0 ||
      container.image !== `${config.registryLoginServer}/${config.imageRepository}@${config.imageDigest}` ||
      JSON.stringify(container.command) !== '["npm"]' ||
      JSON.stringify(container.args) !== '["run","azure:ops-job"]' ||
      !Array.isArray(container.env)) {
    throw new Error("Database inspection requires the exact single, no-retry manual operations image.");
  }
  if (Object.keys(template).some((key) => !["containers", "initContainers", "volumes"].includes(key)) ||
      Object.keys(container).some((key) => ![
        "name", "image", "imageType", "command", "args", "env", "resources", "volumeMounts",
      ].includes(key)) ||
      !Array.isArray(settings.registries) || settings.registries.length !== 1 ||
      settings.registries[0]?.server !== config.registryLoginServer ||
      settings.registries[0]?.identity?.toLowerCase() !== config.opsIdentityId.toLowerCase() ||
      settings.registries[0]?.username != null || settings.registries[0]?.passwordSecretRef != null) {
    throw new Error("Inspection cannot inherit additional container or registry capabilities.");
  }
  const env = new Map();
  for (const entry of container.env) {
    if (!entry || typeof entry.name !== "string" || env.has(entry.name) ||
        Object.keys(entry).some((key) => !["name", "value", "secretRef"].includes(key))) {
      throw new Error("Ambiguous inspection environment.");
    }
    env.set(entry.name, entry);
  }
  const operation = env.get("OPERATION")?.value;
  if (!["migrate-init", "database-inspection"].includes(operation) ||
      (mode === "migration" && operation !== "migrate-init") ||
      env.has("CONTAINER_APP_JOB_EXECUTION_NAME") ||
      env.get("ENVIRONMENT_NAME")?.value !== "prod" ||
      env.get("RELEASE_SHA")?.value !== config.releaseSha ||
      env.get("AZURE_RUNTIME_LOGIN_ROLE")?.value !== config.runtimeLoginRole ||
      env.get("AZCOPY_MSI_CLIENT_ID")?.value !== config.opsIdentityClientId ||
      env.get("AZURE_CLIENT_ID")?.value !== config.opsIdentityClientId ||
      env.get("EVIDENCE_CONTAINER_URL")?.value !== config.evidenceContainerUrl ||
      env.get("DIRECT_URL")?.secretRef !== "direct-url" ||
      env.get("DIRECT_URL")?.value != null) {
    throw new Error("The inspection job is not bound to its expected release and database access.");
  }
  const secretBindings = {
    DIRECT_URL: { name: "direct-url", uri: config.directUrlSecretUri },
    ...(operation === "migrate-init" ? {
      DATABASE_URL: {
        name: "database-url", uri: config.directUrlSecretUri.replace(/direct-url$/, "database-url"),
      },
      AZURE_RUNTIME_LOGIN_PASSWORD: {
        name: "azure-runtime-login-password",
        uri: config.directUrlSecretUri.replace(/direct-url$/, "runtime-database-password"),
      },
    } : {}),
  };
  const allowedEnv = [
    "ENVIRONMENT_NAME", "RELEASE_SHA", "OPERATION", "AZURE_RUNTIME_LOGIN_ROLE",
    "AZCOPY_MSI_CLIENT_ID", "AZURE_CLIENT_ID", "EVIDENCE_CONTAINER_URL",
    ...Object.keys(secretBindings),
    ...(operation === "database-inspection"
      ? ["DATABASE_INSPECTION_HOST", "DATABASE_INSPECTION_NAME", "OPS_IMAGE_DIGEST"] : []),
  ];
  if (env.size !== allowedEnv.length || allowedEnv.some((name) => !env.has(name))) {
    throw new Error("Inspection requires the closed operations environment, without ambient overrides.");
  }
  for (const [name, entry] of env) {
    const binding = secretBindings[name];
    if (binding
      ? entry.secretRef !== binding.name || entry.value != null
      : typeof entry.value !== "string" || entry.secretRef != null) {
      throw new Error("Inspection environment values must retain their exact secret/nonsecret bindings.");
    }
  }
  const secrets = settings.secrets;
  if (!Array.isArray(secrets) || secrets.length !== Object.keys(secretBindings).length ||
      !Object.values(secretBindings).every((binding) =>
        secrets.filter((secret) => secret?.name === binding.name &&
          secret.keyVaultUrl === binding.uri &&
          secret.identity?.toLowerCase() === config.opsIdentityId.toLowerCase() &&
          secret.value == null).length === 1)) {
    throw new Error("Inspection must retain the existing managed-identity Key Vault binding.");
  }
  if (operation === "database-inspection" && (
    settings.replicaTimeout !== 120 ||
    env.get("DATABASE_INSPECTION_HOST")?.value !== config.databaseHost ||
    env.get("DATABASE_INSPECTION_NAME")?.value !== config.databaseName ||
    env.get("OPS_IMAGE_DIGEST")?.value !== config.imageDigest
  )) throw new Error("The read-only job does not match its bounded inspection target.");
  if (mode === "bootstrap" && (
    operation !== "database-inspection" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(owner ?? "") ||
    definition.tags?.["krypto-bootstrap-owner"] !== owner
  )) throw new Error("The temporary inspection resource is not owned by this invocation.");
  return [
    ...(mode === "migration"
      ? [{ name: "MIGRATION_REQUIRE_EMPTY_DATABASE", value: "true" }]
      : [{ name: "OPERATION", value: "database-inspection" }]),
    { name: "DATABASE_INSPECTION_HOST", value: config.databaseHost },
    { name: "DATABASE_INSPECTION_NAME", value: config.databaseName },
    { name: "OPS_IMAGE_DIGEST", value: config.imageDigest },
  ];
}

function validateInitialCredentials(env) {
  let url;
  try { url = new URL(env.DIRECT_URL_PROD); }
  catch { throw new Error("A valid initial direct database binding is required."); }
  const supplied = Buffer.from(decodeURIComponent(url.password));
  const administrator = Buffer.from(env.POSTGRES_ADMIN_PASSWORD_PROD ?? "");
  if (!["postgres:", "postgresql:"].includes(url.protocol) ||
      url.hostname !== `${env.POSTGRES_SERVER_NAME}.postgres.database.azure.com` ||
      (url.port !== "" && url.port !== "5432") ||
      url.pathname !== "/postgres" || decodeURIComponent(url.username) !== "krypto_owner" ||
      !["require", "verify-ca", "verify-full"].includes(url.searchParams.get("sslmode")) ||
      [...url.searchParams.keys()].some((name) => name !== "sslmode") ||
      url.searchParams.getAll("sslmode").length !== 1 || url.hash ||
      supplied.length === 0 || supplied.length !== administrator.length ||
      !timingSafeEqual(supplied, administrator)) {
    throw new Error("Initial database bindings do not match the intended new foundation.");
  }
}

function assertInspectionJobUnchanged(before, after) {
  const definition = (value) => {
    record(value, "Missing inspection definition.");
    const properties = record(value.properties, "Missing inspection properties.");
    return {
      location: value.location, tags: value.tags, identity: value.identity,
      environmentId: properties.environmentId, workloadProfileName: properties.workloadProfileName,
      configuration: properties.configuration, template: properties.template,
    };
  };
  if (!isDeepStrictEqual(definition(before), definition(after))) {
    throw new Error("The temporary inspection job changed after creation; it must not be deleted.");
  }
}

function validateRuntimeCredentials(env, input) {
  const config = inspectionConfig(input);
  let url;
  try { url = new URL(env.DATABASE_URL_PROD); }
  catch { throw new Error("A valid runtime database binding is required before a fresh release."); }
  const supplied = Buffer.from(decodeURIComponent(url.password));
  const password = Buffer.from(env.RUNTIME_DATABASE_PASSWORD_PROD ?? "");
  if (!["postgres:", "postgresql:"].includes(url.protocol) ||
      url.hostname !== config.databaseHost || (url.port !== "" && url.port !== "5432") ||
      decodeURIComponent(url.pathname) !== `/${config.databaseName}` ||
      decodeURIComponent(url.username) !== config.runtimeLoginRole ||
      !["require", "verify-ca", "verify-full"].includes(url.searchParams.get("sslmode")) ||
      [...url.searchParams.keys()].some((name) => name !== "sslmode") ||
      url.searchParams.getAll("sslmode").length !== 1 || url.hash ||
      supplied.length === 0 || supplied.length !== password.length ||
      !timingSafeEqual(supplied, password)) {
    throw new Error("Runtime credentials do not match the inspected fresh database and login role.");
  }
}

module.exports = {
  classifyInventory, inspectionConfig, validateInspectionJob, validateInitialCredentials,
  validateRuntimeCredentials, assertInspectionJobUnchanged,
};

if (require.main === module) {
  try {
    const [action, ...args] = process.argv.slice(2);
    if (action === "classify" && args.length === 1) {
      console.log(JSON.stringify(classifyInventory(JSON.parse(readFileSync(args[0], "utf8")))));
    } else if (action === "config" && args.length === 1) {
      console.log(JSON.stringify(inspectionConfig(args[0])));
    } else if (action === "job" && (args.length === 3 || args.length === 4)) {
      console.log(JSON.stringify(validateInspectionJob(
        JSON.parse(readFileSync(args[1], "utf8")), args[0], args[2], args[3],
      )));
    } else if (action === "initial-credentials" && args.length === 0) {
      validateInitialCredentials(process.env);
      console.log("Initial database bindings match the intended new foundation.");
    } else if (action === "runtime-credentials" && args.length === 1) {
      validateRuntimeCredentials(process.env, args[0]);
      console.log("Runtime credentials match the inspected fresh database.");
    } else if (action === "unchanged" && args.length === 2) {
      assertInspectionJobUnchanged(...args.map((file) => JSON.parse(readFileSync(file, "utf8"))));
    } else {
      throw new Error("Unknown database bootstrap action or arguments.");
    }
  } catch (error) {
    console.error(`database-bootstrap: ${error.message}`);
    process.exitCode = 1;
  }
}
