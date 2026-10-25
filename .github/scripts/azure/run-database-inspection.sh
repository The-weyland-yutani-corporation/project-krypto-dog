#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${script_dir}/lib/common.sh"
mode="${1:-}"
stage="${2:-}"
if { [ "${mode}" != "temporary" ] && [ "${mode}" != "candidate" ]; } ||
   ! [[ "${stage}" =~ ^check-(env|release|migrate)$ ]]; then
  echo "Database inspection requires a fixed temporary/candidate mutation boundary." >&2
  exit 1
fi
resource_group="$(azure_validate_resource_group "${PROD_RESOURCE_GROUP_NAME:?}")"
release_sha="$(azure_validate_release_sha "${RESOLVED_SHA:?}")"
digest="$(azure_validate_image_digest "${FRESH_INSPECTION_OPS_DIGEST:?}")"
image_repository="${FRESH_INSPECTION_IMAGE_REPOSITORY:-krypto-ops}"
owner="$(azure_deployment_fence_owner)"
execution_id="$(azure_new_job_execution_id database-inspection "${stage}")"
definition_file="$(mktemp)"
created_definition_file="$(mktemp)"
config_file="$(mktemp)"
execution_file="$(mktemp)"
terminal_file="$(mktemp)"
executions_file="$(mktemp)"
rm -f "${execution_file}"
created=false
job_id=""
config=""
run_status=1
report_saved=false
report_args=()

cleanup() {
  status=$?
  trap - EXIT
  if [ "${created}" = true ]; then
    cleanup_allowed=false
    if [ "${report_saved}" = true ] && [ -s "${execution_file}" ] &&
       az containerapp job show --name "${MIGRATE_INIT_JOB_NAME}" \
         --resource-group "${resource_group}" --output json > "${definition_file}" &&
       node "${script_dir}/database-bootstrap.cjs" job "${config}" \
         "${definition_file}" bootstrap "${owner}" >/dev/null &&
       node "${script_dir}/database-bootstrap.cjs" unchanged \
         "${created_definition_file}" "${definition_file}"; then
      execution_name="$(cat "${execution_file}")"
      if az rest --method get \
          --url "https://management.azure.com${job_id}/executions/${execution_name}?api-version=2025-01-01" \
          --output json > "${terminal_file}" &&
         jq -e --arg name "${execution_name}" \
          '.name == $name and (.properties.status == "Succeeded" or .properties.status == "Failed")' \
          "${terminal_file}" >/dev/null &&
         az containerapp job execution list --name "${MIGRATE_INIT_JOB_NAME}" \
           --resource-group "${resource_group}" --output json > "${executions_file}" &&
         jq -e --arg name "${execution_name}" \
           'type == "array" and length == 1 and .[0].name == $name
             and ((.[0].properties.status // .[0].status) == "Succeeded"
               or (.[0].properties.status // .[0].status) == "Failed")' \
           "${executions_file}" >/dev/null; then
        cleanup_allowed=true
        if [ "${status}" -eq 0 ] &&
           [ "$(jq -r '.properties.status' "${terminal_file}")" != "Succeeded" ]; then
          echo "Inspection execution no longer corroborates success." >&2
          status=1
        fi
      fi
    fi
    if [ "${cleanup_allowed}" = true ]; then
      if ! az containerapp job delete --name "${MIGRATE_INIT_JOB_NAME}" \
          --resource-group "${resource_group}" --yes --output none; then
        echo "The owned inspection job could not be removed; release remains blocked." >&2
        status=1
      fi
    else
      echo "Inspection evidence, unchanged ownership, or terminal inventory is incomplete; retaining the job and blocking release." >&2
      status=1
    fi
  fi
  if [ "${status}" -eq 0 ] &&
     ! node "${script_dir}/validate-report.mjs" "${report_args[@]}"; then
    echo "Database inspection expired during cleanup; the following mutation is blocked." >&2
    status=1
  fi
  rm -f "${definition_file}" "${created_definition_file}" "${config_file}" \
    "${execution_file}" "${terminal_file}" "${executions_file}"
  exit "${status}"
}
trap cleanup EXIT

identity="$(az identity show --name "${OPS_IDENTITY_NAME:?}" \
  --resource-group "${resource_group}" --output json)"
identity_id="$(printf '%s' "${identity}" | jq -er '.id')"
identity_client="$(printf '%s' "${identity}" | jq -er '.clientId')"
identity_principal="$(printf '%s' "${identity}" | jq -er '.principalId')"
vault_id="$(az keyvault show --name "${KEY_VAULT_NAME:?}" \
  --resource-group "${resource_group}" --query id --output tsv)"
secret_id="${vault_id}/secrets/direct-url"
if ! secret_uri="$(az resource show --ids "${secret_id}" --api-version 2024-11-01 \
    --query properties.secretUri --output tsv)"; then
  echo "The existing foundation lacks the required direct-url bootstrap binding. No credential was written." >&2
  exit 1
fi
roles="$(az role assignment list --scope "${secret_id}" --output json)"
printf '%s' "${roles}" | jq -e --arg principal "${identity_principal}" --arg scope "${secret_id}" '
  any(.[]; (.principalId | ascii_downcase) == ($principal | ascii_downcase)
    and (.scope | ascii_downcase) == ($scope | ascii_downcase)
    and (.roleDefinitionId | ascii_downcase | endswith("/4633458b-17de-408a-b874-0445c86b69e6")))
' >/dev/null || {
  echo "The existing ops identity lacks its original per-secret direct-url access. No grant was added." >&2
  exit 1
}
database_host="$(az postgres flexible-server show --name "${POSTGRES_SERVER_NAME:?}" \
  --resource-group "${resource_group}" --query fullyQualifiedDomainName --output tsv)"
registry="$(az acr show --name "${ACR_NAME:?}" --resource-group "${resource_group}" \
  --query loginServer --output tsv)"
blob_endpoint="$(az storage account show --name "${EVIDENCE_STORAGE_ACCOUNT_NAME:?}" \
  --resource-group "${resource_group}" --query primaryEndpoints.blob --output tsv)"
container_url="$(azure_validate_container_url "${blob_endpoint%/}/evidence")"
environment="$(az containerapp env show --name "${CONTAINER_APPS_ENVIRONMENT_NAME:?}" \
  --resource-group "${resource_group}" --output json)"
environment_id="$(printf '%s' "${environment}" | jq -er '.id')"
location="$(printf '%s' "${environment}" | jq -er '.location')"
config="$(jq -cn \
  --arg sha "${release_sha}" --arg digest "${digest}" --arg repository "${image_repository}" \
  --arg registry "${registry}" --arg host "${database_host}" \
  --arg identity "${identity_id}" --arg client "${identity_client}" \
  --arg secret "${secret_uri}" --arg evidence "${container_url}" \
  --arg environment "${environment_id}" \
  --arg database "${POSTGRES_DATABASE_NAME:?}" --arg role "${RUNTIME_DATABASE_LOGIN_ROLE:?}" \
  '{releaseSha:$sha,imageDigest:$digest,imageRepository:$repository,registryLoginServer:$registry,
    databaseHost:$host,databaseName:$database,runtimeLoginRole:$role,opsIdentityId:$identity,
    opsIdentityClientId:$client,directUrlSecretUri:$secret,evidenceContainerUrl:$evidence,
    containerAppsEnvironmentId:$environment}')"
node "${script_dir}/database-bootstrap.cjs" config "${config}" > "${config_file}"

if [ "${mode}" = temporary ]; then
  inventory="$(bash "${script_dir}/read-production-inventory.sh")"
  if [ "$(printf '%s' "${inventory}" | jq -r '.kind')" != inspect ]; then
    echo "A temporary read-only probe requires an existing foundation with no workloads." >&2
    exit 1
  fi
  # Mark the create as potentially applied before submitting it. An uncertain
  # provider response must not grant permission to overwrite or delete a job.
  created=true
  az deployment group create --resource-group "${resource_group}" \
    --name "db-inspect-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${stage}" \
    --template-file infra/database-inspection.bicep \
    --parameters location="${location}" containerAppsEnvironmentId="${environment_id}" \
      registryLoginServer="${registry}" imageRepository="${image_repository}" \
      opsImageDigest="${digest}" opsIdentityId="${identity_id}" \
      opsIdentityClientId="${identity_client}" keyVaultName="${KEY_VAULT_NAME}" \
      evidenceContainerUrl="${container_url}" releaseSha="${release_sha}" \
      databaseHost="${database_host}" databaseName="${POSTGRES_DATABASE_NAME}" \
      runtimeLoginRole="${RUNTIME_DATABASE_LOGIN_ROLE}" owner="${owner}" \
    --output none
fi
az containerapp job show --name "${MIGRATE_INIT_JOB_NAME:?}" \
  --resource-group "${resource_group}" --output json > "${definition_file}"
validation_mode=inspect
validation_args=()
if [ "${mode}" = temporary ]; then
  validation_mode=bootstrap
  validation_args=("${owner}")
fi
node "${script_dir}/database-bootstrap.cjs" job "${config}" "${definition_file}" \
  "${validation_mode}" "${validation_args[@]}" >/dev/null
cp "${definition_file}" "${created_definition_file}"
job_id="$(jq -er '.id' "${definition_file}")"
run_status=0
bash "${script_dir}/run-ops-job.sh" \
  --job-name "${MIGRATE_INIT_JOB_NAME}" --resource-group "${resource_group}" \
  --job-execution-id "${execution_id}" --execution-name-output "${execution_file}" \
  --database-inspection-config "${config}" --timeout-seconds 180 || run_status=$?
if [ ! -s "${execution_file}" ]; then
  echo "Inspection execution identity was not established; no admission is possible." >&2
  exit 1
fi
execution_name="$(cat "${execution_file}")"
bash "${script_dir}/download-evidence.sh" \
  --container-url "${container_url}" --environment-name prod --release-sha "${release_sha}" \
  --operation database-inspection --job-execution-id "${execution_id}" \
  --destination evidence-bootstrap
report_path="evidence-bootstrap/prod/${release_sha}/database-inspection/${execution_id}/report.json"
if [ ! -s "${report_path}" ] || [ -L "${report_path}" ]; then
  echo "The exact inspection report was not downloaded; retaining the job and blocking release." >&2
  exit 1
fi
report_saved=true
report_args=(
  --report "${report_path}" \
  --operation database-inspection --release-sha "${release_sha}" --image-digest "${digest}" \
  --job-execution-id "${execution_id}" --azure-execution-name "${execution_name}" \
  --database-host "${database_host}" --database-name "${POSTGRES_DATABASE_NAME}" \
  --runtime-login-role "${RUNTIME_DATABASE_LOGIN_ROLE}"
)
node "${script_dir}/validate-report.mjs" "${report_args[@]}"
if [ "${run_status}" -ne 0 ]; then exit "${run_status}"; fi
if [ "${stage}" = check-release ]; then
  node "${script_dir}/database-bootstrap.cjs" runtime-credentials "${config}"
fi
if [ -n "${FRESH_DATABASE_CONFIG_OUTPUT:-}" ]; then
  (umask 077; set -o noclobber; cat "${config_file}" > "${FRESH_DATABASE_CONFIG_OUTPUT}")
fi
