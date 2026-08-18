#!/usr/bin/env bash
# Deterministic fixture tests for validate-model-quota.sh. A strict fake `az`
# serves committed JSON and rejects every unrecognized command, so these
# tests cannot authenticate, mutate Azure, or make a live network call.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script_path="${script_dir}/../validate-model-quota.sh"
fixture_dir="${script_dir}/fixtures/model-quota"
fake_bin="${fixture_dir}/bin"

failures=0
total=0

base_args=(
  --account-name ai-krypto-westus3
  --resource-group rg-krypto-platform
  --location westus3
  --model-format OpenAI
  --model-name gpt-5.6-luna
  --model-version 2026-07-09
  --sku-name GlobalStandard
)

run_validator() {
  local catalog_fixture="$1"
  local quota_fixture="$2"
  local deployments_fixture="$3"
  shift 3
  env \
    PATH="${fake_bin}:${PATH}" \
    MODEL_CATALOG_FIXTURE="${fixture_dir}/${catalog_fixture}" \
    QUOTA_USAGE_FIXTURE="${fixture_dir}/${quota_fixture}" \
    DEPLOYMENTS_FIXTURE="${fixture_dir}/${deployments_fixture}" \
    bash "${script_path}" "${base_args[@]}" "$@"
}

assert_success() {
  local description="$1"
  local catalog_fixture="$2"
  local quota_fixture="$3"
  local deployments_fixture="$4"
  local expected_text="$5"
  shift 5
  total=$((total + 1))

  local output
  if ! output="$(run_validator "${catalog_fixture}" "${quota_fixture}" "${deployments_fixture}" "$@" 2>&1)"; then
    failures=$((failures + 1))
    echo "FAIL  ${description}: expected success, got: ${output}"
    return 0
  fi
  if [[ "${output}" != *"${expected_text}"* ]]; then
    failures=$((failures + 1))
    echo "FAIL  ${description}: output did not contain '${expected_text}': ${output}"
    return 0
  fi
  echo "PASS  ${description}"
}

assert_failure() {
  local description="$1"
  local catalog_fixture="$2"
  local quota_fixture="$3"
  local deployments_fixture="$4"
  local expected_text="$5"
  shift 5
  total=$((total + 1))

  local output
  if output="$(run_validator "${catalog_fixture}" "${quota_fixture}" "${deployments_fixture}" "$@" 2>&1)"; then
    failures=$((failures + 1))
    echo "FAIL  ${description}: expected failure, got success: ${output}"
    return 0
  fi
  if [[ "${output}" != *"${expected_text}"* ]]; then
    failures=$((failures + 1))
    echo "FAIL  ${description}: output did not contain '${expected_text}': ${output}"
    return 0
  fi
  echo "PASS  ${description}"
}

assert_success \
  "aggregates both deployment capacities on one exact dimension" \
  catalog-exact.json quota-exact-20-available.json deployments-empty.json \
  "incremental required 20 <= available 20" \
  --deployment-name krypto-dev-luna --capacity 10 \
  --deployment-name krypto-prod-luna --capacity 10

assert_success \
  "accepts an unchanged rerun without double-counting existing capacity" \
  catalog-exact.json quota-rerun-no-available.json deployments-existing-exact.json \
  "exact replaceable existing 20, incremental required 0 <= available 0" \
  --deployment-name krypto-dev-luna --capacity 10 \
  --deployment-name krypto-prod-luna --capacity 10

assert_failure \
  "rejects an ambiguous exact catalog SKU" \
  catalog-ambiguous-sku.json quota-exact-20-available.json deployments-empty.json \
  "but found 2" \
  --deployment-name krypto-dev-luna --capacity 10 \
  --deployment-name krypto-prod-luna --capacity 10

assert_failure \
  "rejects a missing exact quota dimension" \
  catalog-exact.json quota-missing.json deployments-empty.json \
  "No quota entry" \
  --deployment-name krypto-dev-luna --capacity 10 \
  --deployment-name krypto-prod-luna --capacity 10

assert_failure \
  "rejects duplicate exact quota dimensions" \
  catalog-exact.json quota-duplicate.json deployments-empty.json \
  "but found 2" \
  --deployment-name krypto-dev-luna --capacity 10 \
  --deployment-name krypto-prod-luna --capacity 10

assert_failure \
  "rejects insufficient aggregate capacity" \
  catalog-exact.json quota-insufficient.json deployments-empty.json \
  "incremental required 20, available 19" \
  --deployment-name krypto-dev-luna --capacity 10 \
  --deployment-name krypto-prod-luna --capacity 10

echo
echo "${total} assertions run, $((total - failures)) passed, ${failures} failed."
if [ "${failures}" -gt 0 ]; then
  exit 1
fi
