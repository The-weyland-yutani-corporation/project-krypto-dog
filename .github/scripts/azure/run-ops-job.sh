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
#     [--poll-interval-seconds <n>]
#
# JOB_EXECUTION_ID is the only per-invocation env var override this script
# ever passes -- every other input (ENVIRONMENT_NAME, RELEASE_SHA,
# EVIDENCE_CONTAINER_URL, all secrets) is already wired into the job
# resource by release.bicep (see infra/README.md "Five separate manual
# operations jobs"), so it is never re-specified or overridden here.
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

echo "Starting Container Apps Job '${job_name}' in resource group '${resource_group}' (JOB_EXECUTION_ID=${job_execution_id})."

start_output="$(az containerapp job start \
  --name "${job_name}" \
  --resource-group "${resource_group}" \
  --env-vars "JOB_EXECUTION_ID=${job_execution_id}" \
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
