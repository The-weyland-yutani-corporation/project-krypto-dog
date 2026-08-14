#!/usr/bin/env bash
# Verifies run-ops-job.sh preserves the complete live execution template and
# injects only JOB_EXECUTION_ID through --yaml. The fake az command rejects
# env-only overrides and performs no network call.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script_path="${script_dir}/../run-ops-job.sh"
tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/krypto-run-ops-test.XXXXXX")"

cleanup() {
  rm -f "${tmpdir}/az" "${tmpdir}/started"
  rmdir "${tmpdir}"
}
trap cleanup EXIT

cat > "${tmpdir}/az" <<'FAKE_AZ'
#!/usr/bin/env bash
set -euo pipefail

if [ "$1 $2 $3" = "containerapp job show" ]; then
  if [ "${FAKE_UNSUPPORTED_VOLUMES:-0}" = "1" ]; then
    cat <<'JSON'
{
  "properties": {
    "template": {
      "containers": [
        {
          "name": "ops",
          "image": "registry.example/krypto-ops@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "env": [],
          "volumeMounts": [{"volumeName": "scratch", "mountPath": "/tmp/scratch"}]
        }
      ],
      "volumes": [{"name": "scratch", "storageType": "EmptyDir"}]
    }
  }
}
JSON
    exit 0
  fi
  cat <<'JSON'
{
  "properties": {
    "template": {
      "containers": [
        {
          "name": "ops",
          "image": "registry.example/krypto-ops@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "command": ["npm"],
          "args": ["run", "azure:ops-job"],
          "env": [
            {"name": "ENVIRONMENT_NAME", "value": "dev"},
            {"name": "DIRECT_URL", "secretRef": "direct-url"},
            {"name": "JOB_EXECUTION_ID", "value": "stale-value"}
          ],
          "resources": {"cpu": 0.5, "memory": "1Gi"}
        }
      ],
      "initContainers": [
        {"name": "init", "image": "registry.example/init@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}
      ]
    }
  }
}
JSON
  exit 0
fi

if [ "$1 $2 $3" = "containerapp job start" ]; then
  yaml_path=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --env-vars)
        echo "env-only override is forbidden" >&2
        exit 91
        ;;
      --yaml)
        yaml_path="${2:?--yaml requires a value}"
        shift 2
        ;;
      *)
        shift
        ;;
    esac
  done
  test -n "${yaml_path}"
  jq -e '
    (.containers | length) == 1
    and .containers[0].name == "ops"
    and .containers[0].command == ["npm"]
    and .containers[0].args == ["run", "azure:ops-job"]
    and ([.containers[0].env[] | select(.name == "ENVIRONMENT_NAME" and .value == "dev")] | length) == 1
    and ([.containers[0].env[] | select(.name == "DIRECT_URL" and .secretRef == "direct-url")] | length) == 1
    and ([.containers[0].env[] | select(.name == "JOB_EXECUTION_ID" and .value == "run-1")] | length) == 1
    and ([.containers[0].env[] | select(.name == "SCHEDULED_IDEMPOTENCY_KEY" and .value == "manual-shadow:run-1")] | length) == 1
    and ([.containers[0].env[] | select(.name == "EXPECTED_SHADOW_IDEMPOTENCY_KEY" and .value == "manual-shadow:run-1")] | length) == 1
    and ([.containers[0].env[] | select(.name == "EXPECTED_SHADOW_STARTED_AFTER" and .value == "2026-08-13T12:00:00Z")] | length) == 1
    and (.initContainers | length) == 1
  ' "${yaml_path}" >/dev/null
  : > "${FAKE_AZ_CAPTURE_DIR}/started"
  printf '%s\n' '{"name":"execution-1"}'
  exit 0
fi

if [ "$1 $2 $3 $4" = "containerapp job execution list" ]; then
  printf '%s\n' '[{"name":"execution-1","properties":{"status":"Succeeded"}}]'
  exit 0
fi

echo "Unexpected fake az invocation: $*" >&2
exit 92
FAKE_AZ
chmod +x "${tmpdir}/az"

PATH="${tmpdir}:${PATH}" FAKE_AZ_CAPTURE_DIR="${tmpdir}" \
  "${script_path}" \
    --job-name caj-dev-preflight \
    --resource-group rg-krypto-dev \
    --job-execution-id run-1 \
    --scheduled-idempotency-key manual-shadow:run-1 \
    --expected-shadow-idempotency-key manual-shadow:run-1 \
    --expected-shadow-started-after 2026-08-13T12:00:00Z \
    --timeout-seconds 10 \
    --poll-interval-seconds 1

test -f "${tmpdir}/started"
echo "PASS  run-ops-job preserves the full template and uses --yaml"

if PATH="${tmpdir}:${PATH}" \
   FAKE_AZ_CAPTURE_DIR="${tmpdir}" \
   FAKE_UNSUPPORTED_VOLUMES=1 \
   "${script_path}" \
     --job-name caj-dev-preflight \
     --resource-group rg-krypto-dev \
     --job-execution-id run-2 \
     --timeout-seconds 10 \
     --poll-interval-seconds 1 >/dev/null 2>&1; then
  echo "FAIL  run-ops-job accepted unsupported volume configuration" >&2
  exit 1
fi
echo "PASS  run-ops-job rejects unsupported volume configuration"
