#!/usr/bin/env bash
# Builds one Docker target (web or ops) via `az acr build` (no local
# Docker daemon or docker/build-push-action needed -- the build runs
# inside ACR itself), tags it with the full commit SHA, and resolves the
# resulting immutable manifest digest so the caller can pin every
# downstream deployment to `sha256:<64-hex>` rather than a mutable tag.
#
# Usage:
#   build-and-resolve-digest.sh \
#     --registry <acr-name> \
#     --resource-group <acr-resource-group> \
#     --repository <repo-name, e.g. krypto-web> \
#     --target <web|ops> \
#     --tag <full 40-hex commit sha>
#
# Prints exactly one line on success:
#   digest=sha256:<64-hex>
#
# Fails closed: an unresolvable digest, an unexpected digest shape, or a
# failed `az acr build` is a nonzero exit -- this script never falls back
# to a mutable tag reference.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${script_dir}/lib/common.sh"

registry=""
resource_group=""
repository=""
target=""
tag=""

while [ $# -gt 0 ]; do
  case "$1" in
    --registry) registry="${2:?--registry requires a value}"; shift 2 ;;
    --resource-group) resource_group="${2:?--resource-group requires a value}"; shift 2 ;;
    --repository) repository="${2:?--repository requires a value}"; shift 2 ;;
    --target) target="${2:?--target requires a value}"; shift 2 ;;
    --tag) tag="${2:?--tag requires a value}"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

for name in registry resource_group repository target tag; do
  if [ -z "${!name}" ]; then
    echo "--${name//_/-} is required." >&2
    exit 1
  fi
done

resource_group="$(azure_validate_resource_group "${resource_group}")"
tag="$(azure_validate_release_sha "${tag}")"

case "${target}" in
  web|ops) ;;
  *)
    echo "--target must be exactly 'web' or 'ops' (matches the Dockerfile's two build targets)." >&2
    exit 1
    ;;
esac

if ! [[ "${repository}" =~ ^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$ ]]; then
  echo "Invalid --repository '${repository}'." >&2
  exit 1
fi
if ! [[ "${registry}" =~ ^[a-zA-Z0-9]{5,50}$ ]]; then
  echo "Invalid --registry '${registry}'." >&2
  exit 1
fi

image_ref="${repository}:${tag}"

echo "Building '${image_ref}' (target '${target}') via 'az acr build' on registry '${registry}'."
az acr build \
  --registry "${registry}" \
  --resource-group "${resource_group}" \
  --image "${image_ref}" \
  --file Dockerfile \
  --target "${target}" \
  .

echo "Resolving the immutable digest for '${image_ref}'."
digest="$(az acr repository show \
  --name "${registry}" \
  --image "${image_ref}" \
  --query digest \
  --output tsv)"

if ! [[ "${digest}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "Resolved digest '${digest}' does not match the expected sha256:<64-hex> shape." >&2
  exit 1
fi

echo "digest=${digest}"
