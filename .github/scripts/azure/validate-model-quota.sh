#!/usr/bin/env bash
# Live model-catalog and subscription/region quota validation for
# infra/platform.bicep. Never hardcodes a model/SKU/capacity option --
# every value it checks comes from the caller's workflow inputs/environment
# variables (the reviewed values), and this script only confirms those
# reviewed values are (a) actually offered by the existing Foundry account
# right now and (b) actually fit in currently available subscription/region
# quota. It never invents a fallback model or a "close enough" match.
#
# Usage:
#   validate-model-quota.sh \
#     --account-name <existing-foundry-account-name> \
#     --resource-group <platform-resource-group> \
#     --location <region> \
#     --model-format <format> \
#     --model-name <model> \
#     --model-version <version> \
#     --sku-name <sku> \
#     --capacity <int>
#
# Exits nonzero (fails closed) if:
#   - the account/model/version/format/SKU combination is not present in
#     the account's *live* `az cognitiveservices account list-models`
#     catalog, or
#   - the SKU's usage/limit data cannot be read, or
#   - (limit - currentValue) for the matching quota dimension is less than
#     the requested capacity.
#
# This script performs read-only `az cognitiveservices` calls; it never
# deploys, creates, or modifies anything.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${script_dir}/lib/common.sh"

account_name=""
resource_group=""
location=""
model_format=""
model_name=""
model_version=""
sku_name=""
capacity=""

while [ $# -gt 0 ]; do
  case "$1" in
    --account-name) account_name="${2:?--account-name requires a value}"; shift 2 ;;
    --resource-group) resource_group="${2:?--resource-group requires a value}"; shift 2 ;;
    --location) location="${2:?--location requires a value}"; shift 2 ;;
    --model-format) model_format="${2:?--model-format requires a value}"; shift 2 ;;
    --model-name) model_name="${2:?--model-name requires a value}"; shift 2 ;;
    --model-version) model_version="${2:?--model-version requires a value}"; shift 2 ;;
    --sku-name) sku_name="${2:?--sku-name requires a value}"; shift 2 ;;
    --capacity) capacity="${2:?--capacity requires a value}"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

for name in account_name resource_group location model_format model_name model_version sku_name capacity; do
  if [ -z "${!name}" ]; then
    echo "--${name//_/-} is required." >&2
    exit 1
  fi
done

resource_group="$(azure_validate_resource_group "${resource_group}")"

if ! [[ "${capacity}" =~ ^[0-9]+$ ]] || [ "${capacity}" -le 0 ]; then
  echo "--capacity must be a positive integer." >&2
  exit 1
fi

echo "Fetching live model catalog for account '${account_name}' in resource group '${resource_group}'."
models_json="$(az cognitiveservices account list-models \
  --name "${account_name}" \
  --resource-group "${resource_group}" \
  --output json)"

match_count="$(printf '%s' "${models_json}" | jq \
  --arg format "${model_format}" \
  --arg name "${model_name}" \
  --arg version "${model_version}" \
  --arg sku "${sku_name}" \
  '[
     .[]
     | select(.model.format == $format and .model.name == $name and .model.version == $version)
     | select((.skus // []) | any(.name == $sku))
   ] | length')"

if [ "${match_count}" -lt 1 ]; then
  echo "Model/SKU not found in the live catalog: format='${model_format}' name='${model_name}' version='${model_version}' sku='${sku_name}'. Refusing to deploy an unverified model/SKU combination." >&2
  exit 1
fi

sku_capacity_limit="$(printf '%s' "${models_json}" | jq -r \
  --arg format "${model_format}" \
  --arg name "${model_name}" \
  --arg version "${model_version}" \
  --arg sku "${sku_name}" \
  '[
     .[]
     | select(.model.format == $format and .model.name == $name and .model.version == $version)
     | (.skus // [])[]
     | select(.name == $sku)
     | (.capacity.maximum // .capacity.default // empty)
   ] | first // empty')"

if [ -n "${sku_capacity_limit}" ] && [[ "${sku_capacity_limit}" =~ ^[0-9]+$ ]]; then
  if [ "${capacity}" -gt "${sku_capacity_limit}" ]; then
    echo "Requested capacity ${capacity} exceeds the SKU's own reported maximum capacity ${sku_capacity_limit} for '${sku_name}'." >&2
    exit 1
  fi
else
  echo "Live catalog did not report a maximum/default capacity for SKU '${sku_name}' -- proceeding to the subscription/region quota check only."
fi

echo "Model/SKU '${model_format}/${model_name}/${model_version}/${sku_name}' confirmed in the live catalog. Checking subscription/region quota in '${location}'."

usage_json="$(az cognitiveservices usage list --location "${location}" --output json)"

# Cognitive Services usage entries are keyed by a metric name; account
# deployment capacity typically reports under a name containing the SKU or
# a generic "AccountDeploymentCapacity"-style dimension. Match defensively
# by SKU name substring but never silently skip the check -- an unmatched
# entry is a hard failure, not an assumed pass.
quota_entry="$(printf '%s' "${usage_json}" | jq -c \
  --arg sku "${sku_name}" \
  '[.[] | select((.name.value // "") | test($sku; "i"))] | first // empty')"

if [ -z "${quota_entry}" ] || [ "${quota_entry}" = "null" ]; then
  echo "No subscription/region quota entry found in '${location}' matching SKU '${sku_name}'. Refusing to deploy without a confirmed quota check." >&2
  exit 1
fi

current_value="$(printf '%s' "${quota_entry}" | jq -r '.currentValue // empty')"
quota_limit="$(printf '%s' "${quota_entry}" | jq -r '.limit // empty')"

if [ -z "${current_value}" ] || [ -z "${quota_limit}" ]; then
  echo "Quota entry for SKU '${sku_name}' is missing currentValue/limit fields: ${quota_entry}" >&2
  exit 1
fi

current_value_int="${current_value%.*}"
quota_limit_int="${quota_limit%.*}"

available=$(( quota_limit_int - current_value_int ))
if [ "${available}" -lt "${capacity}" ]; then
  echo "Insufficient quota in '${location}' for SKU '${sku_name}': requested capacity ${capacity}, available ${available} (limit ${quota_limit_int}, current usage ${current_value_int})." >&2
  exit 1
fi

echo "Quota check passed: requested capacity ${capacity} <= available ${available} (limit ${quota_limit_int}, current usage ${current_value_int}) for SKU '${sku_name}' in '${location}'."
