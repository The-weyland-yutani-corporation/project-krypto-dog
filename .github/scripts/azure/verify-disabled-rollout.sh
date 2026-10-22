#!/usr/bin/env bash
# Read-only quiescence barrier before releasing an owned cutover fence.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${script_dir}/lib/common.sh"
resource_group=""
web_app=""
hourly_job=""
daily_job=""
image=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --resource-group) resource_group="${2:?}"; shift 2 ;;
    --web-app) web_app="${2:?}"; shift 2 ;;
    --hourly-job) hourly_job="${2:?}"; shift 2 ;;
    --daily-job) daily_job="${2:?}"; shift 2 ;;
    --image) image="${2:?}"; shift 2 ;;
    *) echo "Unknown disabled rollout argument: $1" >&2; exit 1 ;;
  esac
done
resource_group="$(azure_validate_resource_group "${resource_group}")"
web_app="$(azure_validate_job_name "${web_app}")"
hourly_job="$(azure_validate_job_name "${hourly_job}")"
daily_job="$(azure_validate_job_name "${daily_job}")"
if ! [[ "${image}" =~ ^[a-z0-9.-]+/krypto-web@sha256:[0-9a-f]{64}$ ]]; then
  echo "An exact web image reference is required." >&2
  exit 1
fi

scratch="$(mktemp -d "${TMPDIR:-/tmp}/krypto-disabled-readback.XXXXXX")"
cleanup() {
  rm -f "${scratch}/web.json" "${scratch}/revisions.json" \
    "${scratch}/hourly.json" "${scratch}/daily.json" \
    "${scratch}/hourly-executions.json" "${scratch}/daily-executions.json" \
    "${scratch}/snapshot.json"
  rmdir "${scratch}"
}
trap cleanup EXIT

deadline=$(( $(date +%s) + 900 ))
while true; do
  az containerapp show --name "${web_app}" --resource-group "${resource_group}" \
    --output json > "${scratch}/web.json"
  az containerapp revision list --name "${web_app}" --resource-group "${resource_group}" \
    --all --output json > "${scratch}/revisions.json"
  az containerapp job show --name "${hourly_job}" --resource-group "${resource_group}" \
    --output json > "${scratch}/hourly.json"
  az containerapp job show --name "${daily_job}" --resource-group "${resource_group}" \
    --output json > "${scratch}/daily.json"
  az containerapp job execution list --name "${hourly_job}" --resource-group "${resource_group}" \
    --output json > "${scratch}/hourly-executions.json"
  az containerapp job execution list --name "${daily_job}" --resource-group "${resource_group}" \
    --output json > "${scratch}/daily-executions.json"
  jq -n \
    --slurpfile web "${scratch}/web.json" \
    --slurpfile revisions "${scratch}/revisions.json" \
    --slurpfile hourly "${scratch}/hourly.json" \
    --slurpfile daily "${scratch}/daily.json" \
    --slurpfile hourlyExecutions "${scratch}/hourly-executions.json" \
    --slurpfile dailyExecutions "${scratch}/daily-executions.json" \
    '{web:$web[0],revisions:$revisions[0],hourly:$hourly[0],daily:$daily[0],
      hourlyExecutions:$hourlyExecutions[0],dailyExecutions:$dailyExecutions[0]}' \
    > "${scratch}/snapshot.json"
  if node "${script_dir}/validate-disabled-rollout.mjs" "${scratch}/snapshot.json" "${image}"; then
    exit 0
  fi
  if [ "$(date +%s)" -ge "${deadline}" ]; then
    echo "Disabled rollout did not become quiescent within 15 minutes; the fence must remain held." >&2
    exit 1
  fi
  sleep 15
done
