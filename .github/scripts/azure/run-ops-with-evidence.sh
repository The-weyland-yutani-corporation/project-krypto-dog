#!/usr/bin/env bash
# Retain the exact immutable report even when the operation fails. A
# retention failure must never replace the original operation exit code.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${script_dir}/lib/common.sh"

job_args=()
container_url=""
environment_name=""
release_sha=""
operation=""
job_execution_id=""
destination=""
image_digest=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --container-url) container_url="${2:?}"; shift 2 ;;
    --environment-name) environment_name="${2:?}"; shift 2 ;;
    --release-sha) release_sha="${2:?}"; shift 2 ;;
    --operation) operation="${2:?}"; shift 2 ;;
    --destination) destination="${2:?}"; shift 2 ;;
    --image-digest) image_digest="${2:?}"; shift 2 ;;
    --job-execution-id)
      job_execution_id="${2:?}"
      job_args+=("$1" "$2")
      shift 2
      ;;
    --job-name|--resource-group|--timeout-seconds|--expected-shadow-idempotency-key|--expected-shadow-started-after)
      job_args+=("$1" "${2:?}")
      shift 2
      ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

container_url="$(azure_validate_container_url "${container_url}")"
environment_name="$(azure_validate_environment_name "${environment_name}")"
release_sha="$(azure_validate_release_sha "${release_sha}")"
operation="$(azure_validate_operation "${operation}")"
job_execution_id="$(azure_validate_job_execution_id "${job_execution_id}")"
if [ -z "${destination}" ]; then echo "--destination is required." >&2; exit 1; fi
digest_args=()
if [ "${operation}" = "target-smoke" ] || [ "${operation}" = "activation-check" ]; then
  image_digest="$(azure_validate_image_digest "${image_digest}")"
  digest_args=(--image-digest "${image_digest}")
fi

operation_result=0
bash "${script_dir}/run-ops-job.sh" "${job_args[@]}" || operation_result=$?
retention_result=0
timeout --kill-after=10s 120s bash "${script_dir}/download-evidence.sh" \
  --container-url "${container_url}" \
  --environment-name "${environment_name}" \
  --release-sha "${release_sha}" \
  --operation "${operation}" \
  --job-execution-id "${job_execution_id}" \
  --destination "${destination}" || retention_result=$?

if [ "${retention_result}" -ne 0 ]; then
  echo "::error::${operation} report retention failed (exit ${retention_result}); exact evidence is missing or unreadable." >&2
fi
if [ "${operation_result}" -ne 0 ]; then
  echo "::error::${operation} failed (original exit ${operation_result}); retained reports cannot turn this into success." >&2
  exit "${operation_result}"
fi
if [ "${retention_result}" -ne 0 ]; then exit "${retention_result}"; fi

node "${script_dir}/validate-report.mjs" \
  --report "${destination}/${environment_name}/${release_sha}/${operation}/${job_execution_id}/report.json" \
  --operation "${operation}" \
  --release-sha "${release_sha}" \
  --environment-name "${environment_name}" \
  "${digest_args[@]}"
