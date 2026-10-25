#!/usr/bin/env bash
# Exercises the real bootstrap/operations scripts against a closed fake Azure
# executable. No command in this fixture can fall through to the real Azure CLI.
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
azure_dir="$(cd "${script_dir}/.." && pwd)"
tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/krypto-database-bootstrap-test.XXXXXX")"
cleanup() {
  node "${tmpdir}/fixture.cjs" "${tmpdir}" cleanup
}
trap cleanup EXIT
export MSYS2_ARG_CONV_EXCL="${MSYS2_ARG_CONV_EXCL:+${MSYS2_ARG_CONV_EXCL};}/subscriptions/"

cat > "${tmpdir}/fixture.cjs" <<'NODE'
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const [directory, command, ...args] = process.argv.slice(2);
if (command === "cleanup") {
  assert(path.basename(directory).startsWith("krypto-database-bootstrap-test."));
  fs.rmSync(directory, { recursive: true });
  process.exit(0);
}
const stateFile = path.join(directory, "state.json");
const scope = "/subscriptions/11111111-2222-3333-4444-555555555555/resourceGroups/rg-krypto-prod";
const identity = `${scope}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-krypto-prod02-ops`;
const clientId = "22222222-3333-4444-5555-666666666666";
const principalId = "33333333-4444-5555-6666-777777777777";
const vaultId = `${scope}/providers/Microsoft.KeyVault/vaults/kv-krypto-prod02`;
const config = {
  releaseSha: "a".repeat(40), imageDigest: "sha256:" + "b".repeat(64),
  imageRepository: "krypto-ops", registryLoginServer: "acrkryptoprod02.azurecr.io",
  databaseHost: "psql-krypto-prod02.postgres.database.azure.com", databaseName: "postgres",
  runtimeLoginRole: "krypto_app", opsIdentityId: identity, opsIdentityClientId: clientId,
  containerAppsEnvironmentId: `${scope}/providers/Microsoft.App/managedEnvironments/cae-krypto-prod02`,
  directUrlSecretUri: "https://kv-krypto-prod02.vault.azure.net/secrets/direct-url",
  evidenceContainerUrl: "https://stkryptoprod02evid.blob.core.windows.net/evidence",
};
if (command === "setup") {
  fs.writeFileSync(stateFile, JSON.stringify({
    mode: args[0], scenario: args[1], created: false, started: 0, deleted: 0, calls: [],
  }));
  fs.writeFileSync(path.join(directory, "config.json"), JSON.stringify(config));
  process.exit(0);
}
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
const values = [command, ...args];
const argument = (name) => values[values.indexOf(name) + 1];
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
const output = (value) => console.log(typeof value === "string" ? value : JSON.stringify(value));
const matches = (prefix) => values.slice(0, prefix.split(" ").length).join(" ") === prefix;
const resource = (type, name) => ({ type, name, id: `${scope}/providers/${type}/${name}` });
const server = resource("Microsoft.DBforPostgreSQL/flexibleServers", "psql-krypto-prod02");
const vault = resource("Microsoft.KeyVault/vaults", "kv-krypto-prod02");
function definition() {
  const temporary = state.mode === "temporary";
  const env = Object.entries({
    ENVIRONMENT_NAME: "prod", RELEASE_SHA: config.releaseSha,
    OPERATION: temporary ? "database-inspection" : "migrate-init",
    AZURE_RUNTIME_LOGIN_ROLE: config.runtimeLoginRole,
    AZCOPY_MSI_CLIENT_ID: clientId, AZURE_CLIENT_ID: clientId,
    EVIDENCE_CONTAINER_URL: config.evidenceContainerUrl,
    ...(temporary ? {
      DATABASE_INSPECTION_HOST: config.databaseHost, DATABASE_INSPECTION_NAME: "postgres",
      OPS_IMAGE_DIGEST: config.imageDigest,
    } : {}),
  }).map(([name, value]) => ({ name, value }));
  const secrets = [{ name: "direct-url", keyVaultUrl: config.directUrlSecretUri, identity }];
  env.push({ name: "DIRECT_URL", secretRef: "direct-url" });
  if (!temporary) {
    env.push(
      { name: "DATABASE_URL", secretRef: "database-url" },
      { name: "AZURE_RUNTIME_LOGIN_PASSWORD", secretRef: "azure-runtime-login-password" },
    );
    secrets.push(
      { name: "database-url", keyVaultUrl: config.directUrlSecretUri.replace(/direct-url$/, "database-url"), identity },
      { name: "azure-runtime-login-password", keyVaultUrl: config.directUrlSecretUri.replace(/direct-url$/, "runtime-database-password"), identity },
    );
  }
  if (state.scenario === "ambient") env.push({ name: "NODE_OPTIONS", value: "--require unexpected.js" });
  const definition = {
    ...resource("Microsoft.App/jobs", "caj-prod-migrate-init"),
    location: "westus3", identity: { type: "UserAssigned", userAssignedIdentities: { [identity]: {} } },
    tags: { "krypto-bootstrap-owner": state.owner ?? "unused" },
    properties: {
      environmentId: config.containerAppsEnvironmentId,
      workloadProfileName: "Consumption",
      configuration: {
        triggerType: "Manual", replicaRetryLimit: 0, replicaTimeout: temporary ? 120 : 900,
        manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 },
        registries: [{ server: config.registryLoginServer, identity }], secrets,
      },
      template: { containers: [{
        name: "caj-prod-migrate-init",
        image: `${config.registryLoginServer}/${config.imageRepository}@${config.imageDigest}`,
        command: ["npm"], args: ["run", "azure:ops-job"], env,
        resources: { cpu: 0.5, memory: "1Gi" },
      }] },
    },
  };
  if (state.scenario === "wrong-image") definition.properties.template.containers[0].image += "-foreign";
  if (state.scenario === "wrong-environment") env.find((entry) => entry.name === "ENVIRONMENT_NAME").value = "dev";
  if (state.scenario === "wrong-managed-environment") definition.properties.environmentId += "-foreign";
  if (state.scenario === "wrong-secret") secrets[0].keyVaultUrl += "/uninspected-version";
  return definition;
}
const failed = ["retained", "failed-report"].includes(state.scenario);
const status = failed ? "Failed" : "Succeeded";

if (command === "verify") {
  assert.equal(state.deleted, Number(args[0]));
  assert.equal(state.started, Number(args[1]));
  if (args[2] === "no-calls") assert.deepEqual(state.calls, []);
  process.exit(0);
}
if (values.some((value) => value.startsWith("postgres://"))) {
  throw new Error("A database credential reached Azure argv.");
}
state.calls.push(values.slice(0, 3).join(" "));
save();
if (matches("identity show")) output({ id: identity, clientId, principalId });
else if (matches("keyvault show")) output(vaultId);
else if (matches("resource show")) {
  if (state.scenario === "missing-binding") throw new Error("The direct-url binding is absent.");
  output(config.directUrlSecretUri);
}
else if (matches("role assignment list")) output(state.scenario === "missing-access" ? [] : [{
  principalId, scope: `${vaultId}/secrets/direct-url`,
  roleDefinitionId: "/providers/Microsoft.Authorization/roleDefinitions/4633458b-17de-408a-b874-0445c86b69e6",
}]);
else if (matches("postgres flexible-server show")) output(config.databaseHost);
else if (matches("acr show")) output(config.registryLoginServer);
else if (matches("storage account show")) output(config.evidenceContainerUrl.replace(/evidence$/, ""));
else if (matches("containerapp env show")) output({
  id: config.containerAppsEnvironmentId, location: "westus3",
});
else if (matches("containerapp job list") || matches("containerapp list")) output([]);
else if (matches("postgres flexible-server list")) {
  if (state.scenario === "inventory-error") throw new Error("Inventory unavailable.");
  output(state.mode === "new" && state.scenario !== "changed-inventory" ? [] : [server]);
}
else if (matches("keyvault list")) output(state.mode === "new" && state.scenario !== "changed-inventory" ? [] : [vault]);
else if (matches("resource list")) output(state.scenario === "inventory-race" ? [server]
  : state.mode === "new" && state.scenario !== "changed-inventory" ? [] : [server, vault]);
else if (matches("deployment group create")) {
  assert.equal(state.mode, "temporary");
  assert.equal(argument("--template-file"), "infra/database-inspection.bicep");
  assert(values.includes("opsImageDigest=" + config.imageDigest));
  assert(values.includes("runtimeLoginRole=krypto_app"));
  state.owner = values.find((value) => value.startsWith("owner=")).slice("owner=".length);
  state.created = true;
  save();
  if (state.scenario === "uncertain-create") throw new Error("Creation response was lost after applying.");
} else if (matches("containerapp job show")) {
  const value = definition();
  if (state.started && state.scenario === "changed-definition") value.tags.changed = "preserve-user-change";
  if (state.started && state.scenario === "changed-resources") value.properties.template.containers[0].resources.cpu = 1;
  output(value);
} else if (matches("containerapp job start")) {
  assert(!values.includes("--env-vars"));
  const template = JSON.parse(fs.readFileSync(argument("--yaml"), "utf8"));
  const expected = definition().properties.template;
  const previousEnv = expected.containers[0].env;
  const actualEnv = template.containers[0].env;
  delete expected.containers[0].env;
  delete template.containers[0].env;
  assert.deepEqual(template, expected);
  const overrides = ["OPERATION", "JOB_EXECUTION_ID", "DATABASE_INSPECTION_HOST",
    "DATABASE_INSPECTION_NAME", "OPS_IMAGE_DIGEST", "MIGRATION_REQUIRE_EMPTY_DATABASE"];
  assert.deepEqual(
    actualEnv.filter((entry) => !overrides.includes(entry.name)),
    previousEnv.filter((entry) => !overrides.includes(entry.name)),
  );
  const env = Object.fromEntries(actualEnv.map((entry) => [entry.name, entry.value]));
  assert.equal(env.OPERATION, state.mode === "migration" ? "migrate-init" : "database-inspection");
  assert.equal(env.MIGRATION_REQUIRE_EMPTY_DATABASE, state.mode === "migration" ? "true" : undefined);
  assert.equal(env.DATABASE_INSPECTION_HOST, config.databaseHost);
  assert.equal(env.DATABASE_INSPECTION_NAME, config.databaseName);
  assert.equal(env.OPS_IMAGE_DIGEST, config.imageDigest);
  state.executionId = env.JOB_EXECUTION_ID;
  state.started += 1;
  save();
  output(state.scenario === "unknown-start" ? {} : { name: "inspection-1" });
} else if (matches("containerapp job execution list")) {
  output([
    { name: "inspection-1", properties: { status } },
    ...(state.scenario === "other-execution" ? [{ name: "unowned", properties: { status: "Running" } }] : []),
  ]);
} else if (matches("rest --method get")) {
  assert(argument("--url").endsWith("/executions/inspection-1?api-version=2025-01-01"));
  output({ name: "inspection-1", properties: { status: state.scenario === "nonterminal" ? "Running" : status } });
} else if (matches("storage blob download-batch")) {
  if (state.scenario === "missing-report") throw new Error("No durable report is available.");
  const prefix = argument("--pattern").replace(/\/\*$/, "");
  const destination = path.join(argument("--destination"), prefix,
    state.scenario === "nested-report" ? "not-the-canonical-report" : "");
  fs.mkdirSync(destination, { recursive: true });
  const empty = state.scenario !== "retained";
  const report = {
    schemaVersion: "2.0.0", operation: "database-inspection", environmentName: "prod",
    releaseSha: config.releaseSha, imageDigest: config.imageDigest, jobExecutionId: state.executionId,
    azureExecutionName: "inspection-1", generatedAt: new Date().toISOString(),
    approved: empty, reason: empty ? "empty-database" : "existing-database-state",
    inspection: {
      catalogProfile: "postgresql-17-bootstrap-v2", serverVersionNum: 170005,
      stateCounts: {
        catalogObjects: empty ? 0 : 1, largeObjects: 0, databaseSettings: 0,
        privilegeChanges: 0, metadata: 0,
      },
      databaseHost: config.databaseHost, databaseName: config.databaseName,
      runtimeLoginRole: config.runtimeLoginRole, observedAt: new Date().toISOString(),
      readOnly: true, objectCount: empty ? 0 : 1,
      runtimeRolePresent: false, runtimeLoginPresent: false, empty,
    },
  };
  state.reportPath = path.resolve(destination, "report.json");
  save();
  fs.writeFileSync(state.reportPath, JSON.stringify(report));
} else if (matches("containerapp job delete")) {
  assert.equal(state.mode, "temporary", "The real migration job must never be deleted.");
  assert.equal(state.started, 1);
  assert.equal(argument("--name"), "caj-prod-migrate-init");
  assert(!["changed-definition", "changed-resources", "unknown-start", "other-execution",
    "missing-report", "nested-report", "nonterminal"].includes(state.scenario));
  if (state.scenario === "delete-failure") throw new Error("Deletion was rejected.");
  state.deleted += 1;
  save();
  if (state.scenario === "stale-after-cleanup") {
    // Age the saved timestamps instead of sleeping for three minutes. The real
    // validator must run again after cleanup, rather than reuse its prior result.
    const report = JSON.parse(fs.readFileSync(state.reportPath, "utf8"));
    report.generatedAt = report.inspection.observedAt = new Date(Date.now() - 240_000).toISOString();
    fs.writeFileSync(state.reportPath, JSON.stringify(report));
  }
} else throw new Error("Unexpected fake Azure command: " + values.join(" "));
NODE

cat > "${tmpdir}/az" <<'SH'
#!/usr/bin/env bash
exec node "${DATABASE_FIXTURE_SCRIPT}" "${DATABASE_FIXTURE_DIR}" "$@"
SH
chmod +x "${tmpdir}/az"
export PATH="${tmpdir}:${PATH}"
export DATABASE_FIXTURE_SCRIPT="${tmpdir}/fixture.cjs"
export GITHUB_REPOSITORY_ID=456 GITHUB_RUN_ID=123 GITHUB_RUN_ATTEMPT=1
export PROD_RESOURCE_GROUP_NAME=rg-krypto-prod
export RESOLVED_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
export FRESH_INSPECTION_OPS_DIGEST=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
export FRESH_INSPECTION_IMAGE_REPOSITORY=krypto-ops
export WEB_APP_NAME=ca-prod-web POSTGRES_SERVER_NAME=psql-krypto-prod02 KEY_VAULT_NAME=kv-krypto-prod02
export OPS_IDENTITY_NAME=id-krypto-prod02-ops CONTAINER_APPS_ENVIRONMENT_NAME=cae-krypto-prod02
export ACR_NAME=acrkryptoprod02 EVIDENCE_STORAGE_ACCOUNT_NAME=stkryptoprod02evid
export POSTGRES_DATABASE_NAME=postgres RUNTIME_DATABASE_LOGIN_ROLE=krypto_app
export MIGRATE_INIT_JOB_NAME=caj-prod-migrate-init PREFLIGHT_JOB_NAME=caj-prod-preflight
export VERIFIED_BACKUP_JOB_NAME=caj-prod-verified-backup TARGET_SMOKE_JOB_NAME=caj-prod-target-smoke
export ACTIVATION_CHECK_JOB_NAME=caj-prod-activation-check
export PROD_HOURLY_JOB_NAME=caj-prod-agent-run PROD_DAILY_JOB_NAME=caj-prod-daily-summary
export PROD_DEPLOY_IDENTITY_NAME=id-prod-deploy PROD_PROMOTION_IDENTITY_NAME=id-prod-promotion
export DATABASE_URL_PROD='postgres://krypto_app:local-fixture-only@psql-krypto-prod02.postgres.database.azure.com/postgres?sslmode=require'
export RUNTIME_DATABASE_PASSWORD_PROD=local-fixture-only
export DIRECT_URL_PROD='postgres://krypto_owner:local-fixture-only@psql-krypto-prod02.postgres.database.azure.com/postgres?sslmode=require'
export POSTGRES_ADMIN_PASSWORD_PROD=local-fixture-only

run_case() {
  local mode="$1" scenario="$2" expected="$3" deleted="$4" started="$5" stage="${6:-check-release}"
  export DATABASE_FIXTURE_DIR="${tmpdir}/${mode}-${scenario}"
  mkdir "${DATABASE_FIXTURE_DIR}"
  node "${DATABASE_FIXTURE_SCRIPT}" "${DATABASE_FIXTURE_DIR}" setup "${mode}" "${scenario}"
  local status=0
  (
    cd "${DATABASE_FIXTURE_DIR}"
    if [ "${mode}" = migration ]; then
      bash "${azure_dir}/run-ops-job.sh" --job-name "${MIGRATE_INIT_JOB_NAME}" \
        --resource-group "${PROD_RESOURCE_GROUP_NAME}" --job-execution-id run123-a1-migrate-init \
        --fresh-migration-config "$(cat config.json)" --timeout-seconds 5 --poll-interval-seconds 1
    elif [ "${mode}" = new ]; then
      CUTOVER_BINDING_JSON='{"existing_release":"false","foundation_kind":"new"}' \
        bash "${azure_dir}/revalidate-deployment-fence.sh" source check-env
    else
      local release=source
      if [ "${mode}" = candidate ]; then release=candidate; stage=check-migrate; fi
      CUTOVER_BINDING_JSON='{"existing_release":"false","foundation_kind":"inspect"}' \
      FRESH_DATABASE_CONFIG_OUTPUT="${DATABASE_FIXTURE_DIR}/migration-config.json" \
        bash "${azure_dir}/revalidate-deployment-fence.sh" "${release}" "${stage}"
    fi
  ) > "${DATABASE_FIXTURE_DIR}/output.log" 2>&1 || status=$?
  if { [ "${expected}" = pass ] && [ "${status}" -ne 0 ]; } ||
     { [ "${expected}" = fail ] && [ "${status}" -eq 0 ]; }; then
    cat "${DATABASE_FIXTURE_DIR}/output.log" >&2
    echo "FAIL ${mode}/${scenario}: expected ${expected}, got ${status}" >&2
    exit 1
  fi
  node "${DATABASE_FIXTURE_SCRIPT}" "${DATABASE_FIXTURE_DIR}" verify "${deleted}" "${started}"
  echo "PASS ${mode}/${scenario}: exit=${status}, deleted=${deleted}, starts=${started}"
}
run_case temporary empty pass 1 1
run_case temporary retained fail 1 1
run_case temporary failed-report fail 1 1
run_case temporary changed-definition fail 0 1
run_case temporary changed-resources fail 0 1
run_case temporary other-execution fail 0 1
run_case temporary unknown-start fail 0 1
run_case temporary missing-report fail 0 1
run_case temporary nested-report fail 0 1
run_case temporary missing-access fail 0 0
run_case temporary missing-binding fail 0 0
run_case temporary uncertain-create fail 0 0
run_case temporary delete-failure fail 0 1
run_case temporary stale-after-cleanup fail 1 1
run_case temporary nonterminal fail 0 1
run_case temporary inventory-error fail 0 0
run_case temporary inventory-race fail 0 0
run_case temporary foundation pass 1 1 check-env
run_case new pristine pass 0 0
run_case new changed-inventory fail 0 0
run_case candidate empty pass 0 1
run_case candidate retained fail 0 1
run_case candidate ambient fail 0 0
run_case candidate wrong-image fail 0 0
run_case candidate wrong-environment fail 0 0
run_case candidate wrong-managed-environment fail 0 0
run_case candidate wrong-secret fail 0 0
run_case migration empty pass 0 1
run_case migration ambient fail 0 0

export DATABASE_FIXTURE_DIR="${tmpdir}/conflicting-modes"
mkdir "${DATABASE_FIXTURE_DIR}"
node "${DATABASE_FIXTURE_SCRIPT}" "${DATABASE_FIXTURE_DIR}" setup migration empty
for extra in --database-inspection-config --fresh-migration-config --production-verification-config \
    --workflow-observation-proof --scheduled-idempotency-key --expected-shadow-idempotency-key; do
  value="$(cat "${DATABASE_FIXTURE_DIR}/config.json")"
  case "${extra}" in
    *idempotency-key) value=manual-shadow:fixture ;;
  esac
  if bash "${azure_dir}/run-ops-job.sh" --job-name "${MIGRATE_INIT_JOB_NAME}" \
      --resource-group "${PROD_RESOURCE_GROUP_NAME}" --job-execution-id run123-a1-conflict \
      --fresh-migration-config "$(cat "${DATABASE_FIXTURE_DIR}/config.json")" \
      "${extra}" "${value}" --timeout-seconds 5 >"${DATABASE_FIXTURE_DIR}/output.log" 2>&1; then
    echo "FAIL conflicting operation modes were accepted" >&2
    exit 1
  fi
  grep -q "cannot be combined" "${DATABASE_FIXTURE_DIR}/output.log"
done
node "${DATABASE_FIXTURE_SCRIPT}" "${DATABASE_FIXTURE_DIR}" verify 0 0 no-calls
echo "PASS mutually exclusive database operation modes"
