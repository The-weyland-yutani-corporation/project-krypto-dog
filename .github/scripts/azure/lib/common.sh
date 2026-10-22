#!/usr/bin/env bash
# Shared, strict validation/helper functions for the Azure deployment
# workflow scripts under .github/scripts/azure/. Sourced by other scripts
# -- never executed directly, and never invoked with any operator/PR
# supplied string as a shell command (every validated value is only ever
# passed to `az`/`node`/`jq` as a literal argv entry, never interpolated
# into a command string and never `eval`'d).
#
# Every validation function either prints the validated value on stdout
# and returns 0, or prints an error to stderr and returns 1 -- callers
# must always check the exit status (scripts sourcing this file run with
# `set -euo pipefail`, so an unchecked call aborts the script).
#
# Patterns mirror the existing, reviewed TypeScript validators so a value
# that would be rejected by scripts/azure/lib/report-path.ts or
# src/deployment/target-smoke.ts is rejected here too, before it ever
# reaches an `az` invocation:
#   - ENVIRONMENT_NAME:  scripts/azure/lib/report-path.ts
#   - RELEASE_SHA:       src/deployment/target-smoke.ts validateReleaseSha
#   - IMAGE_DIGEST:      src/deployment/target-smoke.ts validateImageDigest
#   - JOB_EXECUTION_ID:  scripts/azure/lib/report-path.ts

if [ -n "${AZURE_COMMON_SH_SOURCED:-}" ]; then
  return 0 2>/dev/null || exit 0
fi
AZURE_COMMON_SH_SOURCED=1

azure_common_environment_name_pattern='^[a-z][a-z0-9-]{1,31}$'
azure_common_release_sha_pattern='^[0-9a-f]{40}$'
azure_common_image_digest_pattern='^sha256:[0-9a-f]{64}$'
azure_common_job_execution_id_pattern='^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'
azure_common_job_name_pattern='^[a-z][a-z0-9-]{0,30}[a-z0-9]$'
azure_common_resource_group_pattern='^[A-Za-z0-9._()-]{1,90}$'
azure_common_operations='migrate-init preflight verified-backup target-smoke activation-check deployment-admission'
# Bare HTTPS blob *container* URL only: exact `<account>.blob.core.windows.net`
# host, and exactly one path segment (the container name) with no
# trailing slash, credentials, query string, or fragment. This is
# intentionally strict enough to catch a malformed concatenation such as
# joining a blob service *endpoint* (which already ends in "/") to a
# container name without an intervening "/" -- e.g. the historical
# `${blob_endpoint%/}evidence` bug, which produced a single mangled host
# label (".../windows.netevidence") that this pattern rejects outright.
azure_common_container_url_pattern='^https://[a-z0-9]{3,24}\.blob\.core\.windows\.net/[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])?$'
# Generic safe-token pattern for free-form Azure resource/model
# identifiers that have no single universal ARM pattern (Foundry account
# name, model deployment name, model format/name/version, SKU name)
# but must never be allowed to carry shell metacharacters, path
# separators, or whitespace -- letters, digits, dot, dash, underscore
# only, 1-128 characters.
azure_common_safe_token_pattern='^[A-Za-z0-9._-]{1,128}$'
# Azure region/location short name (e.g. "eastus2"): lowercase letters
# and digits only.
azure_common_location_pattern='^[a-z][a-z0-9]{1,31}$'
# A positive integer capacity/quota value with no sign, decimal point, or
# leading zero padding tricks -- 1 to 6 digits (Foundry SKU capacities
# are always small integers; this comfortably covers any real value
# while rejecting anything that isn't a bare number).
azure_common_capacity_pattern='^[1-9][0-9]{0,5}$'

azure_validate_safe_token() {
  local label="$1" value="${2:-}"
  if ! [[ "${value}" =~ ${azure_common_safe_token_pattern} ]]; then
    echo "Invalid ${label} '${value}': must be 1-128 letters, digits, '.', '_', or '-' characters only." >&2
    return 1
  fi
  printf '%s' "${value}"
}

azure_validate_location() {
  local value="${1:-}"
  if ! [[ "${value}" =~ ${azure_common_location_pattern} ]]; then
    echo "Invalid Azure location '${value}': must be 2-32 lowercase letters/digits (e.g. 'eastus2')." >&2
    return 1
  fi
  printf '%s' "${value}"
}

azure_validate_capacity() {
  local value="${1:-}"
  if ! [[ "${value}" =~ ${azure_common_capacity_pattern} ]]; then
    echo "Invalid capacity '${value}': must be a positive integer with no leading zero (1-999999)." >&2
    return 1
  fi
  printf '%s' "${value}"
}

azure_require_env() {
  local name="$1"
  local value="${!name:-}"
  if [ -z "${value}" ]; then
    echo "Required environment variable ${name} is not set." >&2
    return 1
  fi
  printf '%s' "${value}"
}

azure_validate_environment_name() {
  local value="${1:-}"
  if ! [[ "${value}" =~ ${azure_common_environment_name_pattern} ]]; then
    echo "Invalid ENVIRONMENT_NAME '${value}': must be 2-32 lowercase alphanumeric/hyphen characters, starting with a letter." >&2
    return 1
  fi
  printf '%s' "${value}"
}

azure_validate_release_sha() {
  local value="${1:-}"
  if ! [[ "${value}" =~ ${azure_common_release_sha_pattern} ]]; then
    echo "Invalid RELEASE_SHA '${value}': must be exactly 40 lowercase hexadecimal characters." >&2
    return 1
  fi
  printf '%s' "${value}"
}

azure_validate_image_digest() {
  local value="${1:-}"
  if ! [[ "${value}" =~ ${azure_common_image_digest_pattern} ]]; then
    echo "Invalid IMAGE_DIGEST '${value}': must be an exact sha256:<64 lowercase hex> digest." >&2
    return 1
  fi
  printf '%s' "${value}"
}

azure_validate_job_execution_id() {
  local value="${1:-}"
  if ! [[ "${value}" =~ ${azure_common_job_execution_id_pattern} ]]; then
    echo "Invalid JOB_EXECUTION_ID '${value}': must be 1-64 alphanumeric/dot/dash/underscore characters." >&2
    return 1
  fi
  printf '%s' "${value}"
}

azure_validate_fence_owner() {
  local value="${1:-}"
  if ! [[ "${value}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]]; then
    echo "Deployment fence owner must be a lowercase UUID v4 or v5." >&2
    return 1
  fi
  printf '%s' "${value}"
}

# UUID v5 is stable across attempts of one trusted repository/workflow run.
# The owner is an idempotency key, not an authorization credential.
azure_deployment_fence_owner() {
  local repository_id="${GITHUB_REPOSITORY_ID:-}" run_id="${GITHUB_RUN_ID:-}"
  if ! [[ "${repository_id}" =~ ^[1-9][0-9]*$ ]] ||
     ! [[ "${run_id}" =~ ^[1-9][0-9]*$ ]]; then
    echo "Fence ownership requires positive GITHUB_REPOSITORY_ID and GITHUB_RUN_ID." >&2
    return 1
  fi
  node -e '
    const namespace = Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex");
    const name = `project-krypto/production-cutover/${process.argv[1]}/${process.argv[2]}`;
    const bytes = require("node:crypto").createHash("sha1").update(namespace).update(name).digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    process.stdout.write(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`);
  ' "${repository_id}" "${run_id}"
}

azure_validate_job_name() {
  local value="${1:-}"
  if ! [[ "${value}" =~ ${azure_common_job_name_pattern} ]]; then
    echo "Invalid Container Apps Job name '${value}'." >&2
    return 1
  fi
  printf '%s' "${value}"
}

azure_validate_resource_group() {
  local value="${1:-}"
  if ! [[ "${value}" =~ ${azure_common_resource_group_pattern} ]]; then
    echo "Invalid resource group name '${value}'." >&2
    return 1
  fi
  printf '%s' "${value}"
}

azure_validate_container_url() {
  local value="${1:-}"
  if ! [[ "${value}" =~ ${azure_common_container_url_pattern} ]]; then
    echo "Invalid container URL '${value}': must be exactly https://<account>.blob.core.windows.net/<container>, with no trailing slash, credentials, query string, or fragment." >&2
    return 1
  fi
  printf '%s' "${value}"
}

azure_validate_operation() {
  local value="${1:-}"
  local candidate
  for candidate in ${azure_common_operations}; do
    if [ "${candidate}" = "${value}" ]; then
      printf '%s' "${value}"
      return 0
    fi
  done
  echo "Invalid OPERATION '${value}': must be one of: ${azure_common_operations}." >&2
  return 1
}

# Derives a unique, pattern-valid JOB_EXECUTION_ID from CI-controlled,
# non-operator-authored values only (GitHub's own run id/attempt plus the
# fixed operation name) -- never from free-form workflow input, so it can
# never be crafted to collide or to break the immutable evidence path.
azure_new_job_execution_id() {
  local operation="$1"
  local discriminator="${2:-}"
  azure_validate_operation "${operation}" >/dev/null
  if [ -n "${discriminator}" ] &&
     ! [[ "${discriminator}" =~ ^[a-z0-9][a-z0-9-]{0,15}$ ]]; then
    echo "JOB_EXECUTION_ID discriminator must be 1-16 lowercase alphanumeric/hyphen characters." >&2
    return 1
  fi
  local run_id="${GITHUB_RUN_ID:-0}"
  local run_attempt="${GITHUB_RUN_ATTEMPT:-1}"
  if ! [[ "${run_id}" =~ ^[0-9]+$ ]] || ! [[ "${run_attempt}" =~ ^[0-9]+$ ]]; then
    echo "GITHUB_RUN_ID/GITHUB_RUN_ATTEMPT must be numeric." >&2
    return 1
  fi
  local candidate="run${run_id}-a${run_attempt}-${operation}${discriminator:+-${discriminator}}"
  azure_validate_job_execution_id "${candidate}"
}
