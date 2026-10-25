import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const template = JSON.parse(readFileSync(
  process.argv[2] ?? new URL("../../../../infra/environment.json", import.meta.url),
  "utf8",
));
assert.deepEqual(template.parameters.postgresCredentialMode.allowedValues, ["initialize", "preserve"]);
assert.equal(template.parameters.postgresCredentialMode.defaultValue, "initialize");
assert.equal(template.parameters.postgresAdministratorLoginPassword.type.toLowerCase(), "securestring");
assert.equal(template.parameters.postgresAdministratorLoginPassword.defaultValue, undefined);

const postgresModule = template.resources.find((resource) => resource.name === "postgres");
assert(postgresModule, "The complete environment must still deploy PostgreSQL infrastructure.");
assert.equal(
  postgresModule.properties.parameters.preserveAdministratorPassword.value,
  "[equals(parameters('postgresCredentialMode'), 'preserve')]",
);
const server = postgresModule.properties.template.resources.find(
  (resource) => resource.type === "Microsoft.DBforPostgreSQL/flexibleServers",
);
assert(server, "The PostgreSQL server must remain managed by the environment template.");
assert.equal(server.apiVersion, "2024-08-01");
assert.equal(postgresModule.properties.template.parameters.preserveAdministratorPassword.defaultValue, false);
assert.equal(typeof server.properties, "string");
assert(server.properties.startsWith(
  "[union(createObject('createMode', if(parameters('preserveAdministratorPassword'), 'Update', 'Default'), ",
));
assert(server.properties.endsWith(
  ", if(parameters('preserveAdministratorPassword'), createObject(), createObject('administratorLoginPassword', parameters('administratorLoginPassword'))))]",
), "Preserve mode must omit the password property, not submit null or a different credential.");
assert.equal(
  server.properties.match(/administratorLoginPassword/g)?.length,
  2,
  "The password property and parameter may occur only in the initialize branch.",
);
console.log("Compiled PostgreSQL credential contract passed: initialize is explicit; existing-release updates omit the password.");

assert.deepEqual(template.parameters.bootstrapDatabaseAccessMode.allowedValues, ["none", "initialize"]);
assert.equal(template.parameters.bootstrapDatabaseAccessMode.defaultValue, "none");
assert.equal(template.parameters.bootstrapDirectUrl.type.toLowerCase(), "securestring");
const bootstrap = template.resources.find((resource) => resource.name === "bootstrap-database-access");
assert(bootstrap, "Only new foundations stage the existing direct-url binding before inspection.");
assert.equal(bootstrap.condition, "[equals(parameters('bootstrapDatabaseAccessMode'), 'initialize')]");
assert.equal(bootstrap.properties.parameters.writeSecret.value, true);
assert.equal(bootstrap.properties.parameters.directUrl.value, "[parameters('bootstrapDirectUrl')]");
assert(bootstrap.dependsOn.some((dependency) => dependency.includes("'postgres'")));

const release = JSON.parse(readFileSync(
  process.argv[3] ?? new URL("../../../../infra/release.json", import.meta.url), "utf8",
));
assert.deepEqual(release.parameters.directUrlBindingMode.allowedValues, ["update", "preserve"]);
assert.equal(release.parameters.directUrlBindingMode.defaultValue, "update");
const releaseAccess = release.resources.find((resource) => resource.name === "ops-database-access");
assert(releaseAccess);
assert.equal(
  releaseAccess.properties.parameters.writeSecret.value,
  "[equals(parameters('directUrlBindingMode'), 'update')]",
);
for (const accessModule of [bootstrap, releaseAccess]) {
  const nested = accessModule.properties.template;
  assert.equal(nested.parameters.directUrl.type.toLowerCase(), "securestring");
  assert.deepEqual(nested.resources.map((resource) => resource.type), [
    "Microsoft.KeyVault/vaults/secrets", "Microsoft.Authorization/roleAssignments",
  ], "Bootstrap access must not introduce database writes, broad grants, or additional resources.");
  const [secret, grant] = nested.resources;
  assert.equal(secret.condition, "[parameters('writeSecret')]");
  assert.equal(secret.name, "[format('{0}/{1}', parameters('keyVaultName'), 'direct-url')]");
  assert.equal(secret.properties.value, "[parameters('directUrl')]");
  assert.equal(grant.scope, "[resourceId('Microsoft.KeyVault/vaults/secrets', parameters('keyVaultName'), 'direct-url')]");
  assert.equal(grant.name, "[guid(resourceId('Microsoft.KeyVault/vaults', parameters('keyVaultName')), 'direct-url', parameters('opsIdentityPrincipalId'), 'ops')]");
  assert.equal(grant.properties.principalId, "[parameters('opsIdentityPrincipalId')]");
  assert.equal(grant.properties.principalType, "ServicePrincipal");
  assert.equal(grant.properties.roleDefinitionId,
    "[subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')]");
}
assert(!release.resources.some((resource) => resource.type === "Microsoft.KeyVault/vaults/secrets"
  && resource.name.includes("'direct-url'")), "The release must not also write an unconditional direct-url secret.");

const inspection = JSON.parse(readFileSync(
  process.argv[4] ?? new URL("../../../../infra/database-inspection.json", import.meta.url), "utf8",
));
assert.equal(inspection.resources.length, 1, "The temporary probe must create only its owned operations job.");
const inspectionJob = inspection.resources[0];
assert.equal(inspectionJob.name, "database-inspection-job");
const parameters = inspectionJob.properties.parameters;
assert.equal(parameters.jobName.value, "caj-prod-migrate-init");
assert.equal(parameters.triggerType.value, "Manual");
assert.equal(parameters.replicaRetryLimit.value, 0);
assert.equal(parameters.replicaTimeoutSeconds.value, 120);
assert.deepEqual(parameters.command.value, ["npm"]);
assert.deepEqual(parameters.args.value, ["run", "azure:ops-job"]);
assert.equal(parameters.jobIdentityId.value, "[parameters('opsIdentityId')]");
assert.equal(parameters.imageDigestRef.value,
  "[format('{0}/{1}@{2}', parameters('registryLoginServer'), parameters('imageRepository'), parameters('opsImageDigest'))]");
assert.equal(parameters.tags.value["krypto-bootstrap-owner"], "[parameters('owner')]");
assert.deepEqual(parameters.keyVaultSecretEnv.value, [{
  name: "DIRECT_URL",
  keyVaultUrl: "[reference(resourceId('Microsoft.KeyVault/vaults/secrets', parameters('keyVaultName'), 'direct-url'), '2024-11-01').secretUri]",
}]);
assert.deepEqual(Object.fromEntries(parameters.nonSecretEnv.value.map(({ name, value }) => [name, value])), {
  ENVIRONMENT_NAME: "prod", RELEASE_SHA: "[parameters('releaseSha')]",
  OPERATION: "database-inspection", OPS_IMAGE_DIGEST: "[parameters('opsImageDigest')]",
  EVIDENCE_CONTAINER_URL: "[parameters('evidenceContainerUrl')]",
  AZCOPY_MSI_CLIENT_ID: "[parameters('opsIdentityClientId')]",
  AZURE_CLIENT_ID: "[parameters('opsIdentityClientId')]",
  DATABASE_INSPECTION_HOST: "[parameters('databaseHost')]",
  DATABASE_INSPECTION_NAME: "[parameters('databaseName')]",
  AZURE_RUNTIME_LOGIN_ROLE: "[parameters('runtimeLoginRole')]",
});
const jobTemplate = inspectionJob.properties.template;
assert.deepEqual(jobTemplate.variables.manualTriggerConfig, { parallelism: 1, replicaCompletionCount: 1 });
assert.equal(jobTemplate.resources.length, 1);
assert.equal(jobTemplate.resources[0].type, "Microsoft.App/jobs");
assert.equal(jobTemplate.resources[0].properties.template.containers.length, 1);
assert.equal(jobTemplate.resources[0].properties.template.initContainers, undefined);
assert.equal(jobTemplate.resources[0].properties.template.volumes, undefined);
console.log("Compiled bootstrap contract passed: preserved credentials, exact per-secret grant, and one bounded read-only job.");
