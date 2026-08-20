#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 --subscription <subscription-name-or-id>" >&2
}

subscription=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --subscription)
      [ "$#" -ge 2 ] || {
        usage
        exit 2
      }
      subscription="$2"
      shift 2
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

[ -n "${subscription}" ] || {
  usage
  exit 2
}

if [ "$(az account show --subscription "${subscription}" --query user.type --output tsv)" != "user" ]; then
  echo "Transitive group verification requires an interactive human Azure CLI identity." >&2
  exit 1
fi

verify_no_groups() {
  local label="$1"
  local resource_group="$2"
  local identity_name="$3"
  local principal_id
  local request_url
  local page
  local page_count=0
  local group_count=0

  principal_id="$(az identity show \
    --subscription "${subscription}" \
    --resource-group "${resource_group}" \
    --name "${identity_name}" \
    --query principalId \
    --output tsv)"
  if ! [[ "${principal_id}" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
    echo "${label} did not resolve to a UUID principal ID." >&2
    exit 1
  fi

  request_url="https://graph.microsoft.com/v1.0/servicePrincipals/${principal_id}/transitiveMemberOf/microsoft.graph.group?%24select=id"
  while [ -n "${request_url}" ]; do
    page_count=$((page_count + 1))
    if [ "${page_count}" -gt 100 ]; then
      echo "${label} transitive-group pagination exceeded the fail-closed page limit." >&2
      exit 1
    fi
    case "${request_url}" in
      https://graph.microsoft.com/v1.0/*)
        ;;
      *)
        echo "${label} transitive-group nextLink left Microsoft Graph v1.0." >&2
        exit 1
        ;;
    esac
    page="$(az rest \
      --method get \
      --url "${request_url}" \
      --resource "https://graph.microsoft.com/" \
      --only-show-errors \
      --output json)"
    if ! jq -e \
      '((.value | type) == "array") and (((."@odata.nextLink" // "") | type) == "string")' \
      <<<"${page}" >/dev/null; then
      echo "${label} transitive-group response had an unexpected shape." >&2
      exit 1
    fi
    group_count=$((group_count + $(jq '.value | length' <<<"${page}")))
    request_url="$(jq -r '."@odata.nextLink" // empty' <<<"${page}")"
  done

  if [ "${group_count}" -ne 0 ]; then
    echo "${label} belongs to one or more transitive Entra groups; Foundry access is not provably direct-only." >&2
    exit 1
  fi
  echo "${label}: zero transitive Entra group memberships verified."
}

verify_no_groups "dev runtime" rg-krypto-dev id-krypto-dev-runtime
verify_no_groups "dev ops" rg-krypto-dev id-krypto-dev-ops
verify_no_groups "dev scheduler" rg-krypto-dev id-krypto-dev-scheduler
verify_no_groups "prod runtime" rg-krypto-prod id-krypto-prod-runtime
verify_no_groups "prod ops" rg-krypto-prod id-krypto-prod-ops
verify_no_groups "prod scheduler" rg-krypto-prod id-krypto-prod-scheduler

echo "All six fixed UAMIs have zero transitive Entra group memberships."
