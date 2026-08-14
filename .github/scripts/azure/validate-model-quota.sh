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
#     --deployment-name <name> --capacity <int> \
#     [--deployment-name <name> --capacity <int> ...]
#
# Deployment/capacity pairs are repeatable. The script computes projected
# incremental demand by subtracting only exact existing target deployments
# already consuming the same model/version/SKU quota dimension. This keeps
# first deploys and idempotent reruns safe.
#
# Exits nonzero (fails closed) if:
#   - exactly one account/model/version/format/SKU match is not present in
#     the account's *live* `az cognitiveservices account list-models`
#     catalog, or
#   - that exact SKU match has no nonempty `usageName`, or
#   - exactly one quota entry with name.value equal to that usageName is not
#     present, or its usage/limit data cannot be read, or
#   - (limit - currentValue) for the matching quota dimension is less than
#     the aggregate requested capacity.
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
capacities=()
deployment_names=()

while [ $# -gt 0 ]; do
  case "$1" in
    --account-name) account_name="${2:?--account-name requires a value}"; shift 2 ;;
    --resource-group) resource_group="${2:?--resource-group requires a value}"; shift 2 ;;
    --location) location="${2:?--location requires a value}"; shift 2 ;;
    --model-format) model_format="${2:?--model-format requires a value}"; shift 2 ;;
    --model-name) model_name="${2:?--model-name requires a value}"; shift 2 ;;
    --model-version) model_version="${2:?--model-version requires a value}"; shift 2 ;;
    --sku-name) sku_name="${2:?--sku-name requires a value}"; shift 2 ;;
    --deployment-name) deployment_names+=("${2:?--deployment-name requires a value}"); shift 2 ;;
    --capacity) capacities+=("${2:?--capacity requires a value}"); shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

for name in account_name resource_group location model_format model_name model_version sku_name; do
  if [ -z "${!name}" ]; then
    echo "--${name//_/-} is required." >&2
    exit 1
  fi
done

if [ "${#capacities[@]}" -eq 0 ] ||
   [ "${#deployment_names[@]}" -ne "${#capacities[@]}" ]; then
  echo "At least one paired --deployment-name/--capacity is required." >&2
  exit 1
fi

account_name="$(azure_validate_safe_token "account-name" "${account_name}")"
resource_group="$(azure_validate_resource_group "${resource_group}")"
location="$(azure_validate_location "${location}")"
model_format="$(azure_validate_safe_token "model-format" "${model_format}")"
model_name="$(azure_validate_safe_token "model-name" "${model_name}")"
model_version="$(azure_validate_safe_token "model-version" "${model_version}")"
sku_name="$(azure_validate_safe_token "sku-name" "${sku_name}")"

aggregate_capacity=0
validated_deployment_names=()
for index in "${!capacities[@]}"; do
  requested_capacity="${capacities[$index]}"
  requested_capacity="$(azure_validate_capacity "${requested_capacity}")"
  capacities[$index]="${requested_capacity}"
  deployment_name="$(azure_validate_safe_token "deployment-name" "${deployment_names[$index]}")"
  if printf '%s\n' "${validated_deployment_names[@]}" | grep -Fxq "${deployment_name}"; then
    echo "Duplicate --deployment-name '${deployment_name}' is not allowed." >&2
    exit 1
  fi
  validated_deployment_names+=("${deployment_name}")
  aggregate_capacity=$((aggregate_capacity + requested_capacity))
done
deployment_names=("${validated_deployment_names[@]}")

echo "Fetching live model catalog for account '${account_name}' in resource group '${resource_group}'."
models_json="$(az cognitiveservices account list-models \
  --name "${account_name}" \
  --resource-group "${resource_group}" \
  --output json)"

catalog_sku_matches="$(printf '%s' "${models_json}" | jq -c \
  --arg format "${model_format}" \
  --arg name "${model_name}" \
  --arg version "${model_version}" \
  --arg sku "${sku_name}" \
  '[
     .[]
     | select(.format == $format and .name == $name and .version == $version)
     | (.skus // [])[]
     | select(.name == $sku)
   ]')"

catalog_match_count="$(printf '%s' "${catalog_sku_matches}" | jq 'length')"
if [ "${catalog_match_count}" -ne 1 ]; then
  echo "Expected exactly one exact catalog SKU match for format='${model_format}' name='${model_name}' version='${model_version}' sku='${sku_name}', but found ${catalog_match_count}. Refusing an absent or ambiguous model/SKU mapping." >&2
  exit 1
fi

usage_name="$(printf '%s' "${catalog_sku_matches}" | jq -r \
  '.[0].usageName
   | if type == "string" and length > 0 then . else empty end')"

if [ -z "${usage_name}" ]; then
  echo "The one exact catalog SKU match for '${model_format}/${model_name}/${model_version}/${sku_name}' has no nonempty usageName. Refusing to guess a quota dimension." >&2
  exit 1
fi

sku_capacity_limit_json="$(printf '%s' "${catalog_sku_matches}" | jq -c \
  '.[0].capacity.maximum // null')"

if [ "${sku_capacity_limit_json}" != "null" ]; then
  if ! [[ "${sku_capacity_limit_json}" =~ ^[0-9]+$ ]]; then
    echo "Exact catalog SKU '${sku_name}' reported a non-integer maximum capacity: ${sku_capacity_limit_json}." >&2
    exit 1
  fi
  for requested_capacity in "${capacities[@]}"; do
    if [ "${requested_capacity}" -gt "${sku_capacity_limit_json}" ]; then
      echo "Requested per-deployment capacity ${requested_capacity} exceeds the SKU's reported maximum capacity ${sku_capacity_limit_json} for '${sku_name}'." >&2
      exit 1
    fi
  done
else
  echo "Live catalog did not report a maximum capacity for SKU '${sku_name}' -- proceeding to the exact subscription/region quota check."
fi

echo "Exact catalog SKU '${model_format}/${model_name}/${model_version}/${sku_name}' maps to usageName '${usage_name}'. Checking subscription/region quota in '${location}'."

usage_json="$(az cognitiveservices usage list --location "${location}" --output json)"
deployments_json="$(az cognitiveservices account deployment list \
  --name "${account_name}" \
  --resource-group "${resource_group}" \
  --output json)"

# `usageName` is the catalog's authoritative join key. Substring,
# case-insensitive, SKU-only, and first-match selection are all intentionally
# forbidden: each could bind this deployment to a different quota dimension.
quota_matches="$(printf '%s' "${usage_json}" | jq -c \
  --arg usage_name "${usage_name}" \
  '[.[] | select(.name.value == $usage_name)]')"

quota_match_count="$(printf '%s' "${quota_matches}" | jq 'length')"
if [ "${quota_match_count}" -eq 0 ]; then
  echo "No quota entry in '${location}' has name.value exactly equal to catalog usageName '${usage_name}'. Refusing to deploy without an exact quota dimension." >&2
  exit 1
fi
if [ "${quota_match_count}" -ne 1 ]; then
  echo "Expected exactly one quota entry in '${location}' for catalog usageName '${usage_name}', but found ${quota_match_count}. Refusing an ambiguous quota dimension." >&2
  exit 1
fi

quota_values_are_integers="$(printf '%s' "${quota_matches}" | jq -r \
  '.[0]
   | ((.currentValue | type) == "number")
     and ((.currentValue | floor) == .currentValue)
     and (.currentValue >= 0)
     and ((.limit | type) == "number")
     and ((.limit | floor) == .limit)
     and (.limit >= 0)')"

if [ "${quota_values_are_integers}" != "true" ]; then
  echo "Exact quota entry for usageName '${usage_name}' must contain nonnegative integer currentValue and limit fields: ${quota_matches}" >&2
  exit 1
fi

current_value="$(printf '%s' "${quota_matches}" | jq -r '.[0].currentValue | floor')"
quota_limit="$(printf '%s' "${quota_matches}" | jq -r '.[0].limit | floor')"

replaceable_existing_capacity=0
for index in "${!deployment_names[@]}"; do
  deployment_name="${deployment_names[$index]}"
  deployment_matches="$(printf '%s' "${deployments_json}" | jq -c \
    --arg deployment_name "${deployment_name}" \
    '[.[] | select(.name == $deployment_name)]')"
  deployment_match_count="$(printf '%s' "${deployment_matches}" | jq 'length')"
  if [ "${deployment_match_count}" -gt 1 ]; then
    echo "Expected at most one existing deployment named '${deployment_name}', found ${deployment_match_count}." >&2
    exit 1
  fi
  if [ "${deployment_match_count}" -eq 1 ]; then
    exact_dimension="$(printf '%s' "${deployment_matches}" | jq -r \
      --arg format "${model_format}" \
      --arg name "${model_name}" \
      --arg version "${model_version}" \
      --arg sku "${sku_name}" \
      '.[0]
       | (.properties.model.format == $format
          and .properties.model.name == $name
          and .properties.model.version == $version
          and .sku.name == $sku)')"
    if [ "${exact_dimension}" = "true" ]; then
      existing_capacity="$(printf '%s' "${deployment_matches}" | jq -r \
        '.[0].sku.capacity
         | if type == "number" and floor == . and . >= 0 then . else empty end')"
      if [ -z "${existing_capacity}" ]; then
        echo "Existing exact deployment '${deployment_name}' has no nonnegative integer SKU capacity." >&2
        exit 1
      fi
      replaceable_existing_capacity=$((replaceable_existing_capacity + existing_capacity))
    fi
  fi
done

incremental_capacity=$((aggregate_capacity - replaceable_existing_capacity))
if [ "${incremental_capacity}" -lt 0 ]; then
  incremental_capacity=0
fi
available=$((quota_limit - current_value))
if [ "${available}" -lt "${incremental_capacity}" ]; then
  echo "Insufficient quota in '${location}' for usageName '${usage_name}': desired aggregate ${aggregate_capacity}, exact replaceable existing ${replaceable_existing_capacity}, incremental required ${incremental_capacity}, available ${available} (limit ${quota_limit}, current usage ${current_value})." >&2
  exit 1
fi

echo "Quota check passed: desired aggregate ${aggregate_capacity}, exact replaceable existing ${replaceable_existing_capacity}, incremental required ${incremental_capacity} <= available ${available} (limit ${quota_limit}, current usage ${current_value}) for exact usageName '${usage_name}' in '${location}'."
