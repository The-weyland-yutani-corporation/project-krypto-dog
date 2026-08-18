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
#     --timeout-seconds <n> \
#     [--scheduled-idempotency-key <manual-shadow:key>] \
#     [--expected-shadow-idempotency-key <manual-shadow:key>] \
#     [--expected-shadow-started-after <UTC timestamp>] \
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
timeout_seconds=""
poll_interval_seconds=15
scheduled_idempotency_key=""
expected_shadow_idempotency_key=""
expected_shadow_started_after=""

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
  --arg expected_shadow_started_after "${expected_shadow_started_after}" '
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
       else empty end)
    ]) as $overrides
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

execution_name="$(printf '%s' "${start_output}" | jq -r '.name // empty')"
if [ -z "${execution_name}" ]; then
  echo "az containerapp job start did not return an execution name." >&2
  exit 1
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
    exit 1
  else
    echo "Job execution '${execution_name}' status='${status}'; waiting."
  fi

  sleep "${poll_interval_seconds}"
done
