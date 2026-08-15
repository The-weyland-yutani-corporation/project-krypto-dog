#!/usr/bin/env bash
# One-time subscription provider bootstrap. Run locally as an authorized
# subscription operator before bootstrap.bicep. Protected workflows use
# --check-only and never attempt subscription mutation.
set -euo pipefail

check_only=false
if [ "${1:-}" = "--check-only" ]; then
  check_only=true
  shift
fi
if [ "$#" -ne 0 ]; then
  echo "Usage: register-providers.sh [--check-only]" >&2
  exit 1
fi

providers=(
  Microsoft.App
  Microsoft.Authorization
  Microsoft.CognitiveServices
  Microsoft.Communication
  Microsoft.ContainerRegistry
  Microsoft.DBforPostgreSQL
  Microsoft.Insights
  Microsoft.KeyVault
  Microsoft.ManagedIdentity
  Microsoft.Network
  Microsoft.OperationalInsights
  Microsoft.Storage
)

account_state="$(az account show --query state --output tsv)"
if [ "${account_state}" != "Enabled" ]; then
  echo "The selected Azure subscription is not Enabled." >&2
  exit 1
fi

missing=()
for namespace in "${providers[@]}"; do
  state="$(az provider show \
    --namespace "${namespace}" \
    --query registrationState \
    --output tsv)"
  if [ "${state}" = "Registered" ]; then
    echo "${namespace}: Registered"
    continue
  fi
  if [ "${check_only}" = true ]; then
    missing+=("${namespace}")
    continue
  fi
  echo "${namespace}: registering (current state: ${state:-unknown})"
  az provider register --namespace "${namespace}" --wait --output none
  final_state="$(az provider show \
    --namespace "${namespace}" \
    --query registrationState \
    --output tsv)"
  if [ "${final_state}" != "Registered" ]; then
    echo "${namespace} did not reach Registered state." >&2
    exit 1
  fi
done

if [ "${#missing[@]}" -gt 0 ]; then
  printf 'Required Azure providers are not registered: %s\n' "${missing[*]}" >&2
  echo "Run .github/scripts/azure/register-providers.sh as the approved subscription bootstrap operator." >&2
  exit 1
fi
