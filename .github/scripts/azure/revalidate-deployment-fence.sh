#!/usr/bin/env bash
# Re-read the owned fence at a mutation boundary; never acquire or extend it.
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${script_dir}/lib/common.sh"
job_release="${1:-}"
stage="${2:-}"
if [ "${job_release}" != "source" ] && [ "${job_release}" != "candidate" ]; then
  echo "Fence verification requires a source or candidate job." >&2
  exit 1
fi
binding="${CUTOVER_BINDING_JSON:?CUTOVER_BINDING_JSON is required}"
existing="$(printf '%s' "${binding}" | jq -er '
  .existing_release | select(type == "string" and (. == "true" or . == "false"))
')"
if [ "${existing}" = "false" ]; then
  case "${job_release}:${stage}" in
    source:check-env)
      original_kind="$(printf '%s' "${binding}" | jq -er '.foundation_kind')"
      inventory="$(bash "${script_dir}/read-production-inventory.sh")"
      current_kind="$(printf '%s' "${inventory}" | jq -er '.kind')"
      if [ "${current_kind}" != "${original_kind}" ]; then
        echo "The foundation inventory changed before mutation; no fresh admission is possible." >&2
        exit 1
      fi
      if [ "${current_kind}" = new ]; then
        node "${script_dir}/database-bootstrap.cjs" initial-credentials
      elif [ "${current_kind}" = inspect ]; then
        bash "${script_dir}/run-database-inspection.sh" temporary "${stage}"
      else
        echo "Fresh foundation mutation requires an absent or inspected database." >&2
        exit 1
      fi
      ;;
    source:check-images)
      echo "Fresh-path image building is a bootstrap exception, not database or release admission."
      ;;
    source:check-release)
      bash "${script_dir}/run-database-inspection.sh" temporary "${stage}"
      ;;
    candidate:check-migrate)
      bash "${script_dir}/run-database-inspection.sh" candidate "${stage}"
      ;;
    *)
      echo "No fresh-database admission is defined for this mutation boundary." >&2
      exit 1
      ;;
  esac
  exit 0
fi
if [ "${existing}" != "true" ] ||
   [ "$(printf '%s' "${binding}" | jq -er '.admission_status')" != "admitted" ]; then
  echo "An existing release requires successful owned admission before mutation." >&2
  exit 1
fi
owner="$(printf '%s' "${binding}" | jq -er '.fence_owner')"
source_sha="$(printf '%s' "${binding}" | jq -er '.current_sha')"
candidate_sha="$(printf '%s' "${binding}" | jq -er '.candidate_sha')"
digest="$(printf '%s' "${binding}" | jq -er '.current_digest')"
origin="$(printf '%s' "${binding}" | jq -er '.target_origin')"
container_url="$(printf '%s' "${binding}" | jq -er '.evidence_container_url')"
job_sha="${source_sha}"
if [ "${job_release}" = "candidate" ]; then job_sha="${candidate_sha}"; fi
execution_id="$(azure_new_job_execution_id deployment-admission "${stage}")"
bash "${script_dir}/run-deployment-admission.sh" \
  --action verify --owner "${owner}" \
  --source-release-sha "${source_sha}" \
  --candidate-release-sha "${candidate_sha}" \
  --source-image-digest "sha256:${digest}" \
  --job-release-sha "${job_sha}" \
  --target-origin "${origin}" \
  --job-name "${ACTIVATION_CHECK_JOB_NAME:?}" \
  --resource-group "${PROD_RESOURCE_GROUP_NAME:?}" \
  --container-url "${container_url}" \
  --job-execution-id "${execution_id}" \
  --destination evidence-cutover \
  --timeout-seconds 600
