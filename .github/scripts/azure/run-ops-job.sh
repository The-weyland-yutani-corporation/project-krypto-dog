#!/usr/bin/env bash
# Starts a single Container Apps Job execution and polls it to a terminal
# state (Succeeded/Failed) with a hard timeout. Fails closed: any missing
# argument, any non-Succeeded terminal state, or a timeout without a
# terminal state is a nonzero exit -- this script never reports success by
# omission.
#
# Usage:
#   run-ops-job.sh \
#     --job-name <container-apps-job-name> \
#     --resource-group <resource-group> \
#     --job-execution-id <validated-job-execution-id> \
#     [--execution-name-output <new-private-file>] \
#     --timeout-seconds <n> \
#     [--scheduled-idempotency-key <manual-shadow:key>] \
#     [--expected-shadow-idempotency-key <manual-shadow:key>] \
#     [--expected-shadow-started-after <UTC timestamp>] \
#     [--production-verification-config <phase-specific-nonsecret-json>] \
#     [--workflow-observation-proof <private-proof-file>] \
#     [--database-inspection-config <nonsecret-json>] \
#     [--fresh-migration-config <nonsecret-json>] \
#     [--poll-interval-seconds <n>]
#
# Azure replaces the execution template when any start override is supplied.
# Therefore this script fetches the complete live properties.template, merges
# only the validated per-run entries into its single ops container, and starts
# with --yaml. Azure's JobExecutionTemplate cannot represent volumes, so this
# script explicitly rejects any future volume/volumeMount configuration rather
# than silently dropping it.
#
# `az` is always invoked with a fixed, explicit argv array -- never a
# constructed shell string, never `eval`. No secret value is ever an
# argument to this script or is echoed by it.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${script_dir}/lib/common.sh"

job_name=""
resource_group=""
job_execution_id=""
execution_name_output=""
timeout_seconds=""
poll_interval_seconds=15
scheduled_idempotency_key=""
expected_shadow_idempotency_key=""
expected_shadow_started_after=""
deployment_fence_action=""
deployment_fence_owner=""
deployment_source_release_sha=""
deployment_candidate_release_sha=""
deployment_source_image_digest=""
production_config=""
production_overrides="[]"
production_phase=""
workflow_observation_proof=""
database_config=""
database_mode=""
database_overrides="[]"

while [ $# -gt 0 ]; do
  case "$1" in
    --job-name)
      job_name="${2:?--job-name requires a value}"
      shift 2
      ;;
    --resource-group)
      resource_group="${2:?--resource-group requires a value}"
      shift 2
      ;;
    --job-execution-id)
      job_execution_id="${2:?--job-execution-id requires a value}"
      shift 2
      ;;
    --execution-name-output)
      execution_name_output="${2:?--execution-name-output requires a value}"
      shift 2
      ;;
    --timeout-seconds)
      timeout_seconds="${2:?--timeout-seconds requires a value}"
      shift 2
      ;;
    --poll-interval-seconds)
      poll_interval_seconds="${2:?--poll-interval-seconds requires a value}"
      shift 2
      ;;
    --scheduled-idempotency-key)
      scheduled_idempotency_key="${2:?--scheduled-idempotency-key requires a value}"
      shift 2
      ;;
    --expected-shadow-idempotency-key)
      expected_shadow_idempotency_key="${2:?--expected-shadow-idempotency-key requires a value}"
      shift 2
      ;;
    --expected-shadow-started-after)
      expected_shadow_started_after="${2:?--expected-shadow-started-after requires a value}"
      shift 2
      ;;
    --deployment-fence-action)
      deployment_fence_action="${2:?--deployment-fence-action requires a value}"
      shift 2
      ;;
    --deployment-fence-owner)
      deployment_fence_owner="${2:?--deployment-fence-owner requires a value}"
      shift 2
      ;;
    --deployment-source-release-sha)
      deployment_source_release_sha="${2:?--deployment-source-release-sha requires a value}"
      shift 2
      ;;
    --deployment-candidate-release-sha)
      deployment_candidate_release_sha="${2:?--deployment-candidate-release-sha requires a value}"
      shift 2
      ;;
    --deployment-source-image-digest)
      deployment_source_image_digest="${2:?--deployment-source-image-digest requires a value}"
      shift 2
      ;;
    --production-verification-config)
      production_config="${2:?--production-verification-config requires a value}"
      shift 2
      ;;
    --workflow-observation-proof)
      workflow_observation_proof="${2:?--workflow-observation-proof requires a private file}"
      shift 2
      ;;
    --database-inspection-config|--fresh-migration-config)
      if [ -n "${database_config}" ]; then
        echo "Database operation modes cannot be combined or repeated." >&2
        exit 1
      fi
      database_mode=inspect
      if [ "$1" = "--fresh-migration-config" ]; then database_mode=migration; fi
      database_config="${2:?Database operation requires a configuration}"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

job_name="$(azure_validate_job_name "${job_name}")"
resource_group="$(azure_validate_resource_group "${resource_group}")"
job_execution_id="$(azure_validate_job_execution_id "${job_execution_id}")"

if ! [[ "${timeout_seconds}" =~ ^[0-9]+$ ]] || [ "${timeout_seconds}" -le 0 ]; then
  echo "--timeout-seconds must be a positive integer." >&2
  exit 1
fi
if ! [[ "${poll_interval_seconds}" =~ ^[0-9]+$ ]] || [ "${poll_interval_seconds}" -le 0 ]; then
  echo "--poll-interval-seconds must be a positive integer." >&2
  exit 1
fi
for shadow_key in "${scheduled_idempotency_key}" "${expected_shadow_idempotency_key}"; do
  if [ -n "${shadow_key}" ] && ! [[ "${shadow_key}" =~ ^manual-shadow:[A-Za-z0-9._-]{1,64}$ ]]; then
    echo "Shadow idempotency keys must use manual-shadow:<1-64 safe characters>." >&2
    exit 1
  fi
done
if [ -n "${expected_shadow_started_after}" ] \
  && ! [[ "${expected_shadow_started_after}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]; then
  echo "--expected-shadow-started-after must be a second-precision UTC timestamp." >&2
  exit 1
fi

if [ -n "${deployment_fence_action}${deployment_fence_owner}${deployment_source_release_sha}${deployment_candidate_release_sha}${deployment_source_image_digest}" ]; then
  if [ "${deployment_fence_action}" != "acquire" ] && \
     [ "${deployment_fence_action}" != "verify" ] && \
     [ "${deployment_fence_action}" != "release" ]; then
    echo "Deployment fence action must be acquire, verify, or release." >&2
    exit 1
  fi

  deployment_fence_owner="$(azure_validate_fence_owner "${deployment_fence_owner}")"
  deployment_source_release_sha="$(azure_validate_release_sha "${deployment_source_release_sha}")"
  deployment_candidate_release_sha="$(azure_validate_release_sha "${deployment_candidate_release_sha}")"
  deployment_source_image_digest="$(azure_validate_image_digest "${deployment_source_image_digest}")"
  if [ -n "${scheduled_idempotency_key}${expected_shadow_idempotency_key}${expected_shadow_started_after}" ]; then
    echo "Deployment admission cannot be combined with shadow-run overrides." >&2
    exit 1
  fi
fi

if [ -n "${database_config}" ]; then
  if [ -n "${production_config}${deployment_fence_action}${scheduled_idempotency_key}${expected_shadow_idempotency_key}${expected_shadow_started_after}${workflow_observation_proof}" ]; then
    echo "Database inspection/initialization cannot be combined with another operation override." >&2
    exit 1
  fi
  node "${script_dir}/database-bootstrap.cjs" config "${database_config}" >/dev/null
fi

if [ -n "${production_config}" ]; then
  if [ -n "${deployment_fence_action}${scheduled_idempotency_key}${expected_shadow_idempotency_key}${expected_shadow_started_after}" ]; then
    echo "Production verification cannot be combined with admission or separate shadow overrides." >&2
    exit 1
  fi
  production_overrides="$(node "${script_dir}/production-evidence.cjs" verification-overrides "${production_config}")"
  production_phase="$(printf '%s' "${production_overrides}" | jq -er '
    .[] | select(.name == "PRODUCTION_VERIFICATION_PHASE") | .value')"
fi

proof_args=(--arg workflow_observation "")
proof_purpose=""
if [ "${deployment_fence_action}" = "release" ]; then
  proof_purpose="cutover-release"
elif [ "${production_phase}" = "scheduled" ]; then
  proof_purpose="scheduled-execution"
fi
if [ -n "${proof_purpose}" ]; then
  if [ ! -f "${workflow_observation_proof}" ] || [ -L "${workflow_observation_proof}" ] ||
     [ "$(wc -c < "${workflow_observation_proof}")" -gt 16384 ]; then
    echo "This operation requires a bounded, private workflow-observation proof file." >&2
    exit 1
  fi
  jq -e --arg invocation "${job_execution_id}" --arg purpose "${proof_purpose}" '
    (keys | sort) == ["observation", "token"]
    and (.token | type == "string" and length <= 12000
      and test("^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$"))
    and .observation.purpose == $purpose
    and .observation.operationExecutionId == $invocation
  ' "${workflow_observation_proof}" >/dev/null || {
    echo "The workflow proof does not match this constrained operation invocation." >&2
    exit 1
  }
  proof_args=(--rawfile workflow_observation "${workflow_observation_proof}")
elif [ -n "${workflow_observation_proof}" ]; then
  echo "Workflow-observation proofs are accepted only by attested release or scheduled verification." >&2
  exit 1
fi

echo "Starting Container Apps Job '${job_name}' in resource group '${resource_group}' (JOB_EXECUTION_ID=${job_execution_id})."

job_definition_file="$(mktemp "${TMPDIR:-/tmp}/krypto-job-definition.XXXXXX")"
execution_template_file="$(mktemp "${TMPDIR:-/tmp}/krypto-job-execution.XXXXXX")"
cleanup() {
  rm -f "${job_definition_file}" "${execution_template_file}"
}
trap cleanup EXIT
chmod 600 "${job_definition_file}" "${execution_template_file}"

az containerapp job show \
  --name "${job_name}" \
  --resource-group "${resource_group}" \
  --output json > "${job_definition_file}"

if [ -n "${database_config}" ]; then
  database_overrides="$(node "${script_dir}/database-bootstrap.cjs" job \
    "${database_config}" "${job_definition_file}" "${database_mode}")"
fi

if [ -n "${deployment_fence_action}" ]; then
  jq -e '
    (.properties.configuration.triggerType == "Manual")
    and (.properties.configuration.replicaRetryLimit == 0)
    and (.properties.configuration.manualTriggerConfig.parallelism == 1)
    and (.properties.configuration.manualTriggerConfig.replicaCompletionCount == 1)
    and ([.properties.template.containers[0].env[]?
          | select(.name == "CONTAINER_APP_JOB_EXECUTION_NAME")] | length == 0)
    and ([.properties.template.containers[0].env[]? | select(.name == "OPERATION")]
          | length == 1 and .[0].value == "activation-check")
    and ([.properties.template.containers[0].env[]? | select(.name == "ENVIRONMENT_NAME")]
          | length == 1 and .[0].value == "prod")
  ' "${job_definition_file}" >/dev/null || {
    echo "Deployment admission requires one manual production activation-check replica with no automatic retry." >&2
    exit 1
  }
fi

if [ -n "${production_config}" ]; then
  jq -e '
    (.properties.configuration.triggerType == "Manual")
    and (.properties.configuration.replicaRetryLimit == 0)
    and (.properties.configuration.manualTriggerConfig.parallelism == 1)
    and (.properties.configuration.manualTriggerConfig.replicaCompletionCount == 1)
    and ([.properties.template.containers[0].env[]?
          | select(.name == "CONTAINER_APP_JOB_EXECUTION_NAME")] | length == 0)
    and ([.properties.template.containers[0].env[]? | select(.name == "OPERATION")]
          | length == 1 and .[0].value == "target-smoke")
    and ([.properties.template.containers[0].env[]? | select(.name == "ENVIRONMENT_NAME")]
          | length == 1 and .[0].value == "prod")
  ' "${job_definition_file}" >/dev/null || {
    echo "Production verification requires the single, no-retry manual production target-smoke job." >&2
    exit 1
  }
fi

if ! jq -e '
  ((.properties.template.volumes // []) | length) == 0
  and all(.properties.template.containers[]?; ((.volumeMounts // []) | length) == 0)
  and all(.properties.template.initContainers[]?; ((.volumeMounts // []) | length) == 0)
' "${job_definition_file}" >/dev/null; then
  echo "The live job uses volumes or volumeMounts, which Azure job execution overrides cannot preserve. Refusing to start with --yaml." >&2
  exit 1
fi

jq \
  --arg job_execution_id "${job_execution_id}" \
  --arg scheduled_idempotency_key "${scheduled_idempotency_key}" \
  --arg expected_shadow_idempotency_key "${expected_shadow_idempotency_key}" \
  --arg expected_shadow_started_after "${expected_shadow_started_after}" \
  --arg deployment_fence_action "${deployment_fence_action}" \
  --arg deployment_fence_owner "${deployment_fence_owner}" \
  --arg deployment_source_release_sha "${deployment_source_release_sha}" \
  --arg deployment_candidate_release_sha "${deployment_candidate_release_sha}" \
  --arg deployment_source_image_digest "${deployment_source_image_digest}" \
  "${proof_args[@]}" \
  --argjson database_overrides "${database_overrides}" \
  --argjson production_overrides "${production_overrides}" '
  .properties.template
  | if ((.containers // []) | type) != "array"
      or ((.containers // []) | length) != 1
    then error("expected exactly one live ops container")
    else .
    end
  | ([
      {name: "JOB_EXECUTION_ID", value: $job_execution_id},
      (if $scheduled_idempotency_key != "" then
         {name: "SCHEDULED_IDEMPOTENCY_KEY", value: $scheduled_idempotency_key}
       else empty end),
      (if $expected_shadow_idempotency_key != "" then
         {name: "EXPECTED_SHADOW_IDEMPOTENCY_KEY", value: $expected_shadow_idempotency_key}
       else empty end),
      (if $expected_shadow_started_after != "" then
         {name: "EXPECTED_SHADOW_STARTED_AFTER", value: $expected_shadow_started_after}
       else empty end),
      (if $deployment_fence_action != "" then
         {name: "OPERATION", value: "deployment-admission"},
         {name: "DEPLOYMENT_FENCE_ACTION", value:
           (if $deployment_fence_action == "release" then "release-attested-v1" else $deployment_fence_action end)},
         {name: "DEPLOYMENT_FENCE_OWNER", value: $deployment_fence_owner},
         {name: "DEPLOYMENT_SOURCE_RELEASE_SHA", value: $deployment_source_release_sha},
         {name: "DEPLOYMENT_CANDIDATE_RELEASE_SHA", value: $deployment_candidate_release_sha},
         {name: "DEPLOYMENT_SOURCE_IMAGE_DIGEST", value: $deployment_source_image_digest}
       else empty end),
      (if $workflow_observation != "" then
         {name: "DEPLOYMENT_WORKFLOW_OBSERVATION", value: $workflow_observation}
       else empty end)
    ] + $production_overrides + $database_overrides) as $overrides
  | ($overrides | map(.name)) as $override_names
  | .containers[0].env = (
      ((.containers[0].env // [])
       | map(select(.name as $name | ($override_names | index($name)) == null)))
      + $overrides
    )
' "${job_definition_file}" > "${execution_template_file}"

jq -e \
  --arg job_execution_id "${job_execution_id}" \
  '(.containers | length) == 1
   and ([.containers[0].env[] | select(.name == "JOB_EXECUTION_ID" and .value == $job_execution_id)] | length) == 1' \
  "${execution_template_file}" >/dev/null

start_output="$(az containerapp job start \
  --name "${job_name}" \
  --resource-group "${resource_group}" \
  --yaml "${execution_template_file}" \
  --output json)"
rm -f "${job_definition_file}" "${execution_template_file}"

execution_name="$(printf '%s' "${start_output}" | jq -r '.name // empty')"
if [ -z "${execution_name}" ]; then
  echo "az containerapp job start did not return an execution name." >&2
  exit 1
fi
execution_name="$(azure_validate_job_execution_id "${execution_name}")"
if [ -n "${execution_name_output}" ]; then
  (set -o noclobber; printf '%s\n' "${execution_name}" > "${execution_name_output}")
fi

echo "Job execution '${execution_name}' started. Polling for a terminal status (timeout ${timeout_seconds}s)."

deadline=$(( $(date +%s) + timeout_seconds ))
status=""
while true; do
  now="$(date +%s)"
  if [ "${now}" -ge "${deadline}" ]; then
    echo "Timed out after ${timeout_seconds}s waiting for job execution '${execution_name}' to reach a terminal state (last status: '${status:-unknown}')." >&2
    exit 1
  fi

  executions_output="$(az containerapp job execution list \
    --name "${job_name}" \
    --resource-group "${resource_group}" \
    --output json)"

  status="$(printf '%s' "${executions_output}" \
    | jq -r --arg name "${execution_name}" \
      '.[] | select(.name == $name) | (.properties.status // .status // empty)')"

  if [ -z "${status}" ]; then
    echo "Execution '${execution_name}' not yet visible in the executions list; retrying."
  elif [ "${status}" = "Succeeded" ]; then
    echo "Job execution '${execution_name}' succeeded."
    exit 0
  elif [ "${status}" = "Failed" ]; then
    echo "Job execution '${execution_name}' failed (status=Failed)." >&2
    exit 2
  else
    echo "Job execution '${execution_name}' status='${status}'; waiting."
  fi

  sleep "${poll_interval_seconds}"
done
