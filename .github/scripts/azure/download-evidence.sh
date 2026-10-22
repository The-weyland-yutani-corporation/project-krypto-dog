#!/usr/bin/env bash
# Downloads exactly one immutable evidence prefix
# (ENVIRONMENT_NAME/RELEASE_SHA/OPERATION/JOB_EXECUTION_ID) from the
# evidence Blob container, authenticating with the workflow's own OIDC
# federated identity (`az login` must already have run in the calling
# job; this script never accepts or uses a storage account key or SAS
# token -- `--auth-mode login` only, relying on the identity's
# `Storage Blob Data Reader` container-scoped role, per
# infra/README.md "Least-privilege identity design").
#
# Usage:
#   download-evidence.sh \
#     --container-url <bare-https-evidence-container-url> \
#     --environment-name <name> \
#     --release-sha <40-hex> \
#     --operation <allowlisted-operation> \
#     --job-execution-id <validated-id> \
#     --destination <local-directory>
#
# Fails closed: rejects a container URL carrying a credential, SAS query
# string, or fragment (mirrors scripts/azure/lib/evidence-upload.ts's
# validateContainerUrl), rejects any path-traversal attempt in the
# derived prefix, and fails if no report.json is found under the
# destination after downloading -- a silent empty download is never
# treated as success.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${script_dir}/lib/common.sh"

container_url=""
environment_name=""
release_sha=""
operation=""
job_execution_id=""
destination=""

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
    --job-execution-id)
      job_execution_id="${2:?--job-execution-id requires a value}"
      shift 2
      ;;
    --destination)
      destination="${2:?--destination requires a value}"
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
job_execution_id="$(azure_validate_job_execution_id "${job_execution_id}")"

if [ -z "${container_url}" ]; then
  echo "--container-url is required." >&2
  exit 1
fi
if [ -z "${destination}" ]; then
  echo "--destination is required." >&2
  exit 1
fi

# Bare HTTPS container URL only -- no credential, query string, or
# fragment. Reject with node (URL parsing is far less error-prone than a
# hand-rolled regex for this).
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

prefix="${environment_name}/${release_sha}/${operation}/${job_execution_id}"
case "${prefix}" in
  *..*)
    echo "Derived evidence prefix contains a path traversal segment: ${prefix}" >&2
    exit 1
    ;;
esac

mkdir -p "${destination}"

echo "Downloading evidence prefix '${prefix}' from container '${container_name}' (account '${account_name}') to '${destination}'."

az storage blob download-batch \
  --account-name "${account_name}" \
  --auth-mode login \
  --source "${container_name}" \
  --destination "${destination}" \
  --pattern "${prefix}/*" \
  --no-progress \
  --overwrite false

report_count="$(find "${destination}/${prefix}" -type f -name 'report.json' 2>/dev/null | wc -l | tr -d ' ')"
if [ "${report_count}" = "0" ]; then
  echo "No report.json found under ${destination}/${prefix} after download -- treating as a failed evidence download." >&2
  exit 1
fi

echo "Downloaded evidence prefix '${prefix}' (${report_count} report.json file(s) found)."
echo "evidence_path=${destination}/${prefix}"
