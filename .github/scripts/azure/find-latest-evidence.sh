#!/usr/bin/env bash
# Finds the most recently written evidence report.json under a given
# ENVIRONMENT_NAME/RELEASE_SHA/OPERATION prefix in the evidence Blob
# container, and prints its JOB_EXECUTION_ID -- the one piece of the
# immutable evidence path that a caller holding only a release SHA and
# image digest (e.g. azure-promote-prod.yml's workflow_dispatch inputs)
# has no other way to know, since JOB_EXECUTION_ID is generated fresh by
# whichever earlier workflow run actually executed the operation.
#
# This performs a read-only `az storage blob list` (never a write, never
# a download) authenticated the same way as download-evidence.sh
# (`--auth-mode login`, relying on the caller's own OIDC identity and its
# Storage Blob Data Reader role) -- it never accepts or uses a storage
# account key or SAS token.
#
# Usage:
#   find-latest-evidence.sh \
#     --container-url <bare-https-evidence-container-url> \
#     --environment-name <name> \
#     --release-sha <40-hex> \
#     --operation <one-of-the-five-allowlisted-operations>
#
# Prints exactly one line on success:
#   job_execution_id=<validated-id>
#
# Fails closed: rejects a container URL carrying a credential/query
# string/fragment (mirrors download-evidence.sh), and fails if zero
# report.json blobs are found under the prefix -- it never falls back to
# a guessed or default JOB_EXECUTION_ID.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${script_dir}/lib/common.sh"

container_url=""
environment_name=""
release_sha=""
operation=""

while [ $# -gt 0 ]; do
  case "$1" in
    --container-url)
      container_url="${2:?--container-url requires a value}"
      shift 2
      ;;
    --environment-name)
      environment_name="${2:?--environment-name requires a value}"
      shift 2
      ;;
    --release-sha)
      release_sha="${2:?--release-sha requires a value}"
      shift 2
      ;;
    --operation)
      operation="${2:?--operation requires a value}"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

environment_name="$(azure_validate_environment_name "${environment_name}")"
release_sha="$(azure_validate_release_sha "${release_sha}")"
operation="$(azure_validate_operation "${operation}")"

if [ -z "${container_url}" ]; then
  echo "--container-url is required." >&2
  exit 1
fi

node --input-type=module -e '
const url = new URL(process.argv[1]);
if (url.protocol !== "https:") {
  console.error("EVIDENCE_CONTAINER_URL must use HTTPS.");
  process.exit(1);
}
if (url.username || url.password || url.search || url.hash) {
  console.error("EVIDENCE_CONTAINER_URL must be a bare container URL with no credentials, query string, or fragment.");
  process.exit(1);
}
' "${container_url}"

account_name="$(node --input-type=module -e '
const url = new URL(process.argv[1]);
const host = url.host;
const suffix = ".blob.core.windows.net";
if (!host.endsWith(suffix)) {
  console.error(`Unexpected evidence container host: ${host}`);
  process.exit(1);
}
process.stdout.write(host.slice(0, -suffix.length));
' "${container_url}")"

container_name="$(node --input-type=module -e '
const url = new URL(process.argv[1]);
const segments = url.pathname.split("/").filter(Boolean);
if (segments.length !== 1) {
  console.error(`Expected exactly one path segment (the container name) in ${url.pathname}`);
  process.exit(1);
}
process.stdout.write(segments[0]);
' "${container_url}")"

prefix="${environment_name}/${release_sha}/${operation}/"
case "${prefix}" in
  *..*)
    echo "Derived evidence prefix contains a path traversal segment: ${prefix}" >&2
    exit 1
    ;;
esac

echo "Listing evidence blobs under prefix '${prefix}' in container '${container_name}' (account '${account_name}')." >&2

blobs_json="$(az storage blob list \
  --account-name "${account_name}" \
  --auth-mode login \
  --container-name "${container_name}" \
  --prefix "${prefix}" \
  --output json)"

latest_name="$(printf '%s' "${blobs_json}" | jq -r '
  [.[] | select(.name | endswith("/report.json"))]
  | sort_by(.properties.lastModified)
  | last
  | .name // empty
')"

if [ -z "${latest_name}" ]; then
  echo "No report.json found under prefix '${prefix}' -- refusing to guess a JOB_EXECUTION_ID." >&2
  exit 1
fi

# latest_name looks like: "<env>/<sha>/<operation>/<job_execution_id>/report.json"
without_prefix="${latest_name#"${prefix}"}"
job_execution_id="${without_prefix%/report.json}"

if [ -z "${job_execution_id}" ] || [ "${job_execution_id}" = "${without_prefix}" ]; then
  echo "Could not extract a JOB_EXECUTION_ID from blob name '${latest_name}'." >&2
  exit 1
fi

job_execution_id="$(azure_validate_job_execution_id "${job_execution_id}")"

echo "Most recent evidence for prefix '${prefix}' is JOB_EXECUTION_ID '${job_execution_id}'." >&2
echo "job_execution_id=${job_execution_id}"
