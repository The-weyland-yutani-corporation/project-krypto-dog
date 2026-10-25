#!/usr/bin/env bash
# Runs one fixed, ops-owned fence action. Exit 75 means proven deferral,
# never successful deployment. All other failures remain hard failures.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${script_dir}/lib/common.sh"

action=""
owner=""
source_sha=""
candidate_sha=""
image_digest=""
job_sha=""
target_origin=""
job_name=""
resource_group=""
container_url=""
execution_id=""
destination=""
timeout_seconds=""
workflow_observation_proof=""
workflow_observation_digest=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --action) action="${2:?}"; shift 2 ;;
    --owner) owner="${2:?}"; shift 2 ;;
    --source-release-sha) source_sha="${2:?}"; shift 2 ;;
    --candidate-release-sha) candidate_sha="${2:?}"; shift 2 ;;
    --source-image-digest) image_digest="${2:?}"; shift 2 ;;
    --job-release-sha) job_sha="${2:?}"; shift 2 ;;
    --target-origin) target_origin="${2:?}"; shift 2 ;;
    --job-name) job_name="${2:?}"; shift 2 ;;
    --resource-group) resource_group="${2:?}"; shift 2 ;;
    --container-url) container_url="${2:?}"; shift 2 ;;
    --job-execution-id) execution_id="${2:?}"; shift 2 ;;
    --destination) destination="${2:?}"; shift 2 ;;
    --timeout-seconds) timeout_seconds="${2:?}"; shift 2 ;;
    --workflow-observation-proof) workflow_observation_proof="${2:?}"; shift 2 ;;
    --workflow-observation-digest) workflow_observation_digest="${2:?}"; shift 2 ;;
    *) echo "Unknown admission argument: $1" >&2; exit 1 ;;
  esac
done

owner="$(azure_validate_fence_owner "${owner}")"
source_sha="$(azure_validate_release_sha "${source_sha}")"
candidate_sha="$(azure_validate_release_sha "${candidate_sha}")"
job_sha="$(azure_validate_release_sha "${job_sha}")"
image_digest="$(azure_validate_image_digest "${image_digest}")"
execution_id="$(azure_validate_job_execution_id "${execution_id}")"
container_url="$(azure_validate_container_url "${container_url}")"
if [ -z "${destination}" ] || [ -z "${target_origin}" ]; then
  echo "Admission evidence destination and expected target origin are required." >&2
  exit 1
fi

proof_args=()
receipt_args=()
if [ "${action}" = "release" ]; then
  if [ -z "${workflow_observation_proof}" ] || ! [[ "${workflow_observation_digest}" =~ ^[0-9a-f]{64}$ ]]; then
    echo "Fence release requires its private proof file and expected nonsecret observation digest." >&2
    exit 1
  fi
  proof_args=(--workflow-observation-proof "${workflow_observation_proof}")
  receipt_args=(--workflow-observation-digest "${workflow_observation_digest}")
elif [ -n "${workflow_observation_proof}${workflow_observation_digest}" ]; then
  echo "Only fence release accepts workflow-observation evidence." >&2
  exit 1
fi

execution_status=0
scratch="$(mktemp -d "${TMPDIR:-/tmp}/krypto-admission-execution.XXXXXX")"
cleanup() {
  rm -f "${scratch}/execution-name"
  rmdir "${scratch}"
}
trap cleanup EXIT
bash "${script_dir}/run-ops-job.sh" \
  --job-name "${job_name}" \
  --resource-group "${resource_group}" \
  --job-execution-id "${execution_id}" \
  --execution-name-output "${scratch}/execution-name" \
  --timeout-seconds "${timeout_seconds}" \
  --deployment-fence-action "${action}" \
  --deployment-fence-owner "${owner}" \
  --deployment-source-release-sha "${source_sha}" \
  --deployment-candidate-release-sha "${candidate_sha}" \
  "${proof_args[@]}" \
  --deployment-source-image-digest "${image_digest}" || execution_status=$?

if [ ! -s "${scratch}/execution-name" ]; then
  echo "Admission has no confirmed Azure execution identity; no outcome can be accepted." >&2
  exit 1
fi
azure_execution_name="$(azure_validate_job_execution_id "$(cat "${scratch}/execution-name")")"

bash "${script_dir}/download-evidence.sh" \
  --container-url "${container_url}" \
  --environment-name prod \
  --release-sha "${job_sha}" \
  --operation deployment-admission \
  --job-execution-id "${execution_id}" \
  --destination "${destination}"

validation_status=0
node "${script_dir}/validate-report.mjs" \
  --report "${destination}/prod/${job_sha}/deployment-admission/${execution_id}/report.json" \
  --operation deployment-admission \
  --release-sha "${job_sha}" \
  --image-digest "${image_digest}" \
  --admission-action "${action}" \
  --fence-owner "${owner}" \
  --source-release-sha "${source_sha}" \
  --candidate-release-sha "${candidate_sha}" \
  --target-origin "${target_origin}" \
  --job-execution-id "${execution_id}" \
  --azure-execution-name "${azure_execution_name}" \
  "${receipt_args[@]}" \
  --allow-deferred true || validation_status=$?

if [ "${validation_status}" -eq 75 ] && [ "${execution_status}" -eq 2 ]; then
  exit 75
fi
if [ "${validation_status}" -ne 0 ] || [ "${execution_status}" -ne 0 ]; then
  echo "Deployment admission did not produce both a successful execution and matching evidence." >&2
  exit 1
fi
