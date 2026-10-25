#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${script_dir}/lib/common.sh"
resource_group="$(azure_validate_resource_group "${PROD_RESOURCE_GROUP_NAME:?}")"
jobs_file="$(mktemp)"
apps_file="$(mktemp)"
servers_file="$(mktemp)"
vaults_file="$(mktemp)"
resources_file="$(mktemp)"
inventory_file="$(mktemp)"
trap 'rm -f "${jobs_file}" "${apps_file}" "${servers_file}" "${vaults_file}" "${resources_file}" "${inventory_file}"' EXIT
az containerapp job list --resource-group "${resource_group}" --output json > "${jobs_file}"
az containerapp list --resource-group "${resource_group}" --output json > "${apps_file}"
az postgres flexible-server list --resource-group "${resource_group}" --output json > "${servers_file}"
az keyvault list --resource-group "${resource_group}" --output json > "${vaults_file}"
az resource list --resource-group "${resource_group}" --output json > "${resources_file}"
jq -n \
  --slurpfile jobs "${jobs_file}" --slurpfile apps "${apps_file}" \
  --slurpfile servers "${servers_file}" --slurpfile vaults "${vaults_file}" \
  --slurpfile resources "${resources_file}" \
  --arg app "${WEB_APP_NAME:?}" --arg postgres "${POSTGRES_SERVER_NAME:?}" \
  --arg vault "${KEY_VAULT_NAME:?}" \
  --arg hourly "${PROD_HOURLY_JOB_NAME:?}" --arg daily "${PROD_DAILY_JOB_NAME:?}" \
  --arg migrate "${MIGRATE_INIT_JOB_NAME:?}" --arg preflight "${PREFLIGHT_JOB_NAME:?}" \
  --arg backup "${VERIFIED_BACKUP_JOB_NAME:?}" --arg smoke "${TARGET_SMOKE_JOB_NAME:?}" \
  --arg activation "${ACTIVATION_CHECK_JOB_NAME:?}" \
  --arg deployIdentity "${PROD_DEPLOY_IDENTITY_NAME:?}" \
  --arg promotionIdentity "${PROD_PROMOTION_IDENTITY_NAME:?}" \
  '{jobs:$jobs[0],apps:$apps[0],servers:$servers[0],vaults:$vaults[0],resources:$resources[0],
    names:{app:$app,postgres:$postgres,keyVault:$vault,
      jobs:[$hourly,$daily,$migrate,$preflight,$backup,$smoke,$activation],
      bootstrapIdentities:[$deployIdentity,$promotionIdentity]}}' > "${inventory_file}"
node "${script_dir}/database-bootstrap.cjs" classify "${inventory_file}"
