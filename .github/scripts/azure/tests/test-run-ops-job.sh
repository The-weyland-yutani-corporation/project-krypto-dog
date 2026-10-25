#!/usr/bin/env bash
# Verifies run-ops-job.sh preserves the complete live execution template and
# injects constrained per-execution inputs through --yaml. The fake az command rejects
# env-only overrides and performs no network call.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script_path="${script_dir}/../run-ops-job.sh"
tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/krypto-run-ops-test.XXXXXX")"

cleanup() {
  if [ -d "${tmpdir}/wrapper" ]; then
    local evidence="${tmpdir}/wrapper/evidence"
    local report_parent="${evidence}/prod/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/deployment-admission/run-1"
    rm -f "${report_parent}/report.json" "${tmpdir}/wrapper/report.json" \
      "${tmpdir}/wrapper/run-deployment-admission.sh" \
      "${tmpdir}/wrapper/run-ops-job.sh" \
      "${tmpdir}/wrapper/download-evidence.sh" \
      "${tmpdir}/wrapper/validate-report.mjs" "${tmpdir}/wrapper/lib/common.sh" \
      "${tmpdir}/wrapper/lib/deployment-owner.cjs" \
      "${tmpdir}/wrapper/lib/production-report.cjs"
    for directory in "${report_parent}" "${report_parent%/*}" \
      "${evidence}/prod/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" "${evidence}/prod" \
      "${evidence}" "${tmpdir}/wrapper/lib" "${tmpdir}/wrapper"; do
      if [ -d "${directory}" ]; then rmdir "${directory}"; fi
    done
  fi
  rm -f "${tmpdir}/az" "${tmpdir}/started" "${tmpdir}/launch.log" "${tmpdir}/production-config.json" \
    "${tmpdir}/observation-proof.json" "${tmpdir}/invalid-proof.json" "${tmpdir}/proof-link.json" \
    "${tmpdir}/scheduled-proof.json"
  if [ -d "${tmpdir}/private" ]; then rmdir "${tmpdir}/private"; fi
  rmdir "${tmpdir}"
}
trap cleanup EXIT

cat > "${tmpdir}/az" <<'FAKE_AZ'
#!/usr/bin/env bash
set -euo pipefail

for value in "$@"; do
  if [[ "${value}" == *"fixture.header.signature"* ]]; then
    echo "A bearer proof reached Azure argv." >&2
    exit 93
  fi
done

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
  cat <<'JSON' | jq \
    --arg environment "${FAKE_JOB_ENVIRONMENT:-dev}" \
    --arg operation "${FAKE_JOB_OPERATION:-preflight}" \
    --argjson retries "${FAKE_JOB_RETRIES:-0}" \
    --argjson parallelism "${FAKE_JOB_PARALLELISM:-1}" '
      .properties.configuration.replicaRetryLimit = $retries
      | .properties.configuration.manualTriggerConfig.parallelism = $parallelism
      | .properties.template.containers[0].env |=
        (map(if .name == "ENVIRONMENT_NAME" then .value = $environment else . end)
         + [{name:"OPERATION", value:$operation}])'
{
  "properties": {
    "configuration": {
      "triggerType": "Manual",
      "replicaRetryLimit": 0,
      "manualTriggerConfig": {"parallelism": 1, "replicaCompletionCount": 1}
    },
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
            {"name": "DEPLOYMENT_APPROVAL_SECRET", "secretRef": "deployment-approval-secret"},
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
  jq -e --arg environment "${FAKE_JOB_ENVIRONMENT:-dev}" '
    (.containers | length) == 1
    and .containers[0].name == "ops"
    and .containers[0].command == ["npm"]
    and .containers[0].args == ["run", "azure:ops-job"]
    and ([.containers[0].env[] | select(.name == "ENVIRONMENT_NAME" and .value == $environment)] | length) == 1
    and ([.containers[0].env[] | select(.name == "DIRECT_URL" and .secretRef == "direct-url")] | length) == 1
    and ([.containers[0].env[] | select(.name == "DEPLOYMENT_APPROVAL_SECRET" and .secretRef == "deployment-approval-secret")] | length) == 1
    and ([.containers[0].env[] | select(.name == "JOB_EXECUTION_ID" and .value == "run-1")] | length) == 1
    and (.initContainers | length) == 1
  ' "${yaml_path}" >/dev/null
  if [ "${FAKE_ADMISSION:-0}" = "1" ]; then
    jq -e --arg action "${FAKE_ADMISSION_ACTION:-acquire}" '
      .containers[0].env as $env
      | [
          ["OPERATION", "deployment-admission"],
          ["DEPLOYMENT_FENCE_ACTION", (if $action == "release" then "release-attested-v1" else $action end)],
          ["DEPLOYMENT_FENCE_OWNER", "11111111-1111-4111-8111-111111111111"],
          ["DEPLOYMENT_SOURCE_RELEASE_SHA", ("a" * 40)],
          ["DEPLOYMENT_CANDIDATE_RELEASE_SHA", ("b" * 40)],
          ["DEPLOYMENT_SOURCE_IMAGE_DIGEST", ("sha256:" + ("c" * 64))]
        ]
      | all(.[]; . as $pair |
          [$env[] | select(.name == $pair[0] and .value == $pair[1])] | length == 1)
    ' "${yaml_path}" >/dev/null
    if [ "${FAKE_ADMISSION_ACTION:-}" = "release" ]; then
      jq -e --rawfile expected "${FAKE_EXPECTED_PROOF}" '
        [.containers[0].env[] | select(.name == "DEPLOYMENT_WORKFLOW_OBSERVATION")] as $entries
        | ($entries | length) == 1 and $entries[0].value == $expected
      ' "${yaml_path}" >/dev/null
    fi
  elif [ "${FAKE_PRODUCTION_PHASE:-}" != "" ]; then
    jq -e --arg phase "${FAKE_PRODUCTION_PHASE}" '
      .containers[0].env as $env
      | [
          ["OPERATION", "production-verification"],
          ["PRODUCTION_VERIFICATION_PHASE", $phase],
          ["PRODUCTION_AUTHORIZATION_ID", ("d" * 64)],
          ["SCHEDULE_GENERATION_UNIX_SECONDS", "1700000000"],
          (if $phase == "ready" then
            ["EXPECTED_APPROVAL_ID", "approval-1"],
            ["EXPECTED_SHADOW_IDEMPOTENCY_KEY", "manual-shadow:run-1"],
            ["EXPECTED_SHADOW_STARTED_AFTER", "2026-08-13T12:00:00Z"],
            ["EXPECTED_APPROVAL_CREATED_AFTER", "2026-08-13T11:55:00Z"]
           else empty end)
        ]
      | all(.[]; . as $pair |
          [$env[] | select(.name == $pair[0] and .value == $pair[1])] | length == 1)
    ' "${yaml_path}" >/dev/null
    if [ "${FAKE_PRODUCTION_PHASE}" = "scheduled" ]; then
      jq -e --rawfile expected "${FAKE_EXPECTED_PROOF}" '
        [.containers[0].env[] | select(.name == "DEPLOYMENT_WORKFLOW_OBSERVATION")] as $entries
        | ($entries | length) == 1 and $entries[0].value == $expected
          and ([.containers[0].env[] | select(
            .name == "SCHEDULE_ENABLED_AT_UNIX_SECONDS" or .name == "SCHEDULED_EXECUTION_STARTED_AT"
          )] | length) == 0
      ' "${yaml_path}" >/dev/null
    fi
  else
    jq -e '
      ([.containers[0].env[] | select(.name == "SCHEDULED_IDEMPOTENCY_KEY" and .value == "manual-shadow:run-1")] | length) == 1
      and ([.containers[0].env[] | select(.name == "EXPECTED_SHADOW_IDEMPOTENCY_KEY" and .value == "manual-shadow:run-1")] | length) == 1
      and ([.containers[0].env[] | select(.name == "EXPECTED_SHADOW_STARTED_AFTER" and .value == "2026-08-13T12:00:00Z")] | length) == 1
    ' "${yaml_path}" >/dev/null
  fi
  : > "${FAKE_AZ_CAPTURE_DIR}/started"
  printf '%s\n' '{"name":"execution-1"}'
  exit 0
fi

if [ "$1 $2 $3 $4" = "containerapp job execution list" ]; then
  if [ "${FAKE_ADMISSION_ACTION:-}" = "release" ] || [ "${FAKE_PRODUCTION_PHASE:-}" = "scheduled" ]; then
    test -z "$(find "${TMPDIR}" -mindepth 1 -maxdepth 1 -type f -print)"
  fi
  jq -n --arg status "${FAKE_JOB_STATUS:-Succeeded}" \
    '[{name:"execution-1",properties:{status:$status}}]'
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

admission_args=(
  --job-name caj-prod-activation-check
  --resource-group rg-krypto-prod
  --job-execution-id run-1
  --deployment-fence-action acquire
  --deployment-fence-owner 11111111-1111-4111-8111-111111111111
  --deployment-source-release-sha aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  --deployment-candidate-release-sha bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
  --deployment-source-image-digest sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
  --timeout-seconds 2
  --poll-interval-seconds 1
)
admission_case() {
  local expected="$1"
  shift
  local status=0
  env PATH="${tmpdir}:${PATH}" FAKE_AZ_CAPTURE_DIR="${tmpdir}" FAKE_ADMISSION=1 \
    FAKE_JOB_ENVIRONMENT=prod FAKE_JOB_OPERATION=activation-check \
    "$@" "${script_path}" "${admission_args[@]}" >"${tmpdir}/launch.log" 2>&1 || status=$?
  if [ "${status}" -ne "${expected}" ]; then
    echo "FAIL  admission launch expected exit ${expected}, got ${status} ($*)" >&2
    cat "${tmpdir}/launch.log" >&2
    exit 1
  fi
}
admission_case 0 FAKE_JOB_STATUS=Succeeded
admission_case 2 FAKE_JOB_STATUS=Failed
admission_case 1 FAKE_JOB_STATUS=Running
admission_case 1 FAKE_JOB_ENVIRONMENT=dev
admission_case 1 FAKE_JOB_OPERATION=preflight
admission_case 1 FAKE_JOB_RETRIES=1
admission_case 1 FAKE_JOB_PARALLELISM=2
echo "PASS  admission preserves the source template and distinguishes terminal failure from timeout"

if env PATH="${tmpdir}:${PATH}" FAKE_AZ_CAPTURE_DIR="${tmpdir}" FAKE_ADMISSION=1 \
  FAKE_JOB_ENVIRONMENT=prod FAKE_JOB_OPERATION=activation-check \
  "${script_path}" "${admission_args[@]}" \
  --expected-shadow-idempotency-key manual-shadow:run-1 >/dev/null 2>&1; then
  echo "FAIL  admission accepted a mixed shadow override" >&2
  exit 1
fi
echo "PASS  admission rejects mixed shadow overrides"

mkdir "${tmpdir}/private"
jq -n '{
  observation:{purpose:"cutover-release",operationExecutionId:"run-1"},
  token:"fixture.header.signature"
}' > "${tmpdir}/observation-proof.json"
chmod 600 "${tmpdir}/observation-proof.json"
release_case() {
  local expected="$1" proof="$2"
  shift 2
  local status=0
  rm -f "${tmpdir}/started"
  env PATH="${tmpdir}:${PATH}" TMPDIR="${tmpdir}/private" FAKE_AZ_CAPTURE_DIR="${tmpdir}" \
    FAKE_ADMISSION=1 FAKE_ADMISSION_ACTION=release FAKE_EXPECTED_PROOF="${proof}" \
    FAKE_JOB_ENVIRONMENT=prod FAKE_JOB_OPERATION=activation-check \
    "${script_path}" "${admission_args[@]}" --deployment-fence-action release \
    --workflow-observation-proof "${proof}" "$@" > "${tmpdir}/launch.log" 2>&1 || status=$?
  if [ "${status}" -ne "${expected}" ]; then
    echo "FAIL  attested release: expected exit ${expected}, got ${status}" >&2
    cat "${tmpdir}/launch.log" >&2
    exit 1
  fi
  if [ "${expected}" -eq 1 ]; then test ! -f "${tmpdir}/started"; fi
  if grep -q 'fixture.header.signature' "${tmpdir}/launch.log"; then
    echo "FAIL  release leaked its bearer proof" >&2
    exit 1
  fi
  test -z "$(find "${tmpdir}/private" -mindepth 1 -maxdepth 1 -type f -print)"
}
release_case 0 "${tmpdir}/observation-proof.json"
release_case 1 ""
release_case 1 "${tmpdir}/observation-proof.json" --deployment-fence-action acquire
release_case 1 "${tmpdir}/observation-proof.json" --deployment-fence-action release-attested-v1
for change in \
  '.observation.operationExecutionId = "another-invocation"' \
  '.observation.purpose = "scheduled-execution"' \
  '.token = "not-a-jwt"' \
  '.unexpected = true'; do
  jq "${change}" "${tmpdir}/observation-proof.json" > "${tmpdir}/invalid-proof.json"
  release_case 1 "${tmpdir}/invalid-proof.json"
done
printf 'not-json' > "${tmpdir}/invalid-proof.json"
release_case 1 "${tmpdir}/invalid-proof.json"
node -e 'process.stdout.write(" ".repeat(16385))' > "${tmpdir}/invalid-proof.json"
release_case 1 "${tmpdir}/invalid-proof.json"
ln -s "${tmpdir}/observation-proof.json" "${tmpdir}/proof-link.json"
if [ -L "${tmpdir}/proof-link.json" ]; then
  release_case 1 "${tmpdir}/proof-link.json"
else
  echo "SKIP  symbolic-link proof case: local filesystem did not create a symlink"
fi
echo "PASS  attested release keeps proof out of argv/logs, uses the new wire action, and rejects invalid evidence before start"

jq '.observation.purpose = "scheduled-execution"' "${tmpdir}/observation-proof.json" > "${tmpdir}/scheduled-proof.json"
chmod 600 "${tmpdir}/scheduled-proof.json"
production_case() {
  local phase="$1" expected="$2"
  shift 2
  jq -n --arg phase "${phase}" '
    {
      phase:$phase, authorizationId:("d"*64), scheduleGeneration:1700000000
    } + (if $phase == "ready" then {
      approvalId:"approval-1", approvalCreatedAfter:"2026-08-13T11:55:00Z",
      shadowIdempotencyKey:"manual-shadow:run-1", shadowStartedAfter:"2026-08-13T12:00:00Z"
    } else {} end)' > "${tmpdir}/production-config.json"
  local status=0
  local proof="${PRODUCTION_TEST_PROOF-${tmpdir}/scheduled-proof.json}"
  local proof_args=()
  if [ -n "${proof}" ] && { [ "${phase}" = "scheduled" ] || [ -n "${PRODUCTION_TEST_PROOF:-}" ]; }; then
    proof_args=(--workflow-observation-proof "${proof}")
  fi
  rm -f "${tmpdir}/started"
  env PATH="${tmpdir}:${PATH}" TMPDIR="${tmpdir}/private" FAKE_AZ_CAPTURE_DIR="${tmpdir}" \
    FAKE_JOB_ENVIRONMENT=prod FAKE_JOB_OPERATION=target-smoke FAKE_PRODUCTION_PHASE="${phase}" \
    FAKE_EXPECTED_PROOF="${proof}" \
    "$@" "${script_path}" \
      --job-name caj-prod-target-smoke --resource-group rg-krypto-prod \
      --job-execution-id run-1 --production-verification-config "${tmpdir}/production-config.json" \
      "${proof_args[@]}" \
      --timeout-seconds 2 --poll-interval-seconds 1 > "${tmpdir}/launch.log" 2>&1 || status=$?
  if [ "${status}" -ne "${expected}" ]; then
    echo "FAIL production ${phase}: expected ${expected}, got ${status}" >&2
    cat "${tmpdir}/launch.log" >&2
    exit 1
  fi
  if [ "${expected}" -eq 1 ]; then test ! -f "${tmpdir}/started"; fi
  if grep -q 'fixture.header.signature' "${tmpdir}/launch.log"; then
    echo "FAIL production ${phase} leaked its bearer proof" >&2
    exit 1
  fi
  test -z "$(find "${tmpdir}/private" -mindepth 1 -maxdepth 1 -type f -print)"
}
production_case ready 0
production_case scheduled 0
production_case ready 2 FAKE_JOB_STATUS=Failed
production_case ready 1 FAKE_JOB_ENVIRONMENT=dev
production_case ready 1 FAKE_JOB_OPERATION=activation-check
production_case ready 1 FAKE_JOB_RETRIES=1
production_case ready 1 FAKE_JOB_PARALLELISM=2
PRODUCTION_TEST_PROOF="" production_case scheduled 1
PRODUCTION_TEST_PROOF="${tmpdir}/observation-proof.json" production_case scheduled 1
PRODUCTION_TEST_PROOF="${tmpdir}/scheduled-proof.json" production_case ready 1
PRODUCTION_TEST_PROOF="${tmpdir}/proof-link.json" production_case scheduled 1
PRODUCTION_TEST_PROOF="${tmpdir}/invalid-proof.json" production_case scheduled 1
echo "PASS  production verification preserves credentials and only overrides the exact no-retry production smoke job"

if env PATH="${tmpdir}:${PATH}" FAKE_AZ_CAPTURE_DIR="${tmpdir}" FAKE_ADMISSION=1 \
  FAKE_JOB_ENVIRONMENT=prod FAKE_JOB_OPERATION=activation-check \
  "${script_path}" "${admission_args[@]}" \
  --production-verification-config "${tmpdir}/production-config.json" >/dev/null 2>&1; then
  echo "FAIL production verification accepted a mixed admission override" >&2
  exit 1
fi
echo "PASS  production verification rejects mixed admission overrides"

mkdir "${tmpdir}/wrapper" "${tmpdir}/wrapper/lib"
cp "${script_dir}/../run-deployment-admission.sh" "${tmpdir}/wrapper/run-deployment-admission.sh"
cp "${script_dir}/../validate-report.mjs" "${tmpdir}/wrapper/validate-report.mjs"
cp "${script_dir}/../lib/common.sh" "${tmpdir}/wrapper/lib/common.sh"
cp "${script_dir}/../lib/deployment-owner.cjs" "${tmpdir}/wrapper/lib/deployment-owner.cjs"
cp "${script_dir}/../lib/production-report.cjs" "${tmpdir}/wrapper/lib/production-report.cjs"
cat > "${tmpdir}/wrapper/run-ops-job.sh" <<'FAKE_EXECUTE'
#!/usr/bin/env bash
set -euo pipefail
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--execution-name-output" ]; then
    if [ "${FAKE_EXECUTION_STATUS}" != "127" ]; then printf 'execution-1\n' > "$2"; fi
    break
  fi
  shift
done
exit "${FAKE_EXECUTION_STATUS}"
FAKE_EXECUTE
cat > "${tmpdir}/wrapper/download-evidence.sh" <<'FAKE_DOWNLOAD'
#!/usr/bin/env bash
set -euo pipefail
destination=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--destination" ]; then destination="$2"; break; fi
  shift
done
test -n "${destination}"
target="${destination}/prod/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/deployment-admission/run-1"
mkdir -p "${target}"
cp "${FAKE_REPORT}" "${target}/report.json"
FAKE_DOWNLOAD

wrapper_case() {
  local expected="$1" execution_status="$2" report_status="$3" native_name="${4:-execution-1}"
  local action="${5:-acquire}" schema="${6:-1.0.0}"
  jq -n \
    --arg status "${report_status}" \
    --arg native_name "${native_name}" \
    --arg action "${action}" --arg schema "${schema}" \
    --arg generated "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg token_expiry "$(node -e 'console.log(new Date(Date.now()+120000).toISOString())')" \
    --arg expiry "$(node -e 'console.log(new Date(Date.now()+3600000).toISOString())')" '
    {
      schemaVersion:$schema, operation:"deployment-admission", action:$action,
      owner:"11111111-1111-4111-8111-111111111111",
      sourceReleaseSha:("a"*40), candidateReleaseSha:("b"*40), releaseSha:("a"*40),
      imageDigest:("sha256:"+("c"*64)), targetOrigin:"https://krypto.example.com",
      environmentName:"prod", jobExecutionId:"run-1", azureExecutionName:$native_name,
      generatedAt:$generated, status:$status,
      reason:(if $status == "deferred" then "open-position" else "fence-acquired" end),
      expiresAt:(if $status == "deferred" then null else $expiry end),
      workflowObservation:(if $action == "release" then {
        issuer:"https://token.actions.githubusercontent.com", purpose:"cutover-release",
        observationDigest:("d"*64), repositoryId:"456", repositoryOwnerId:"789",
        workflowRef:"owner/project/.github/workflows/azure-deploy-prod.yml@refs/heads/main",
        workflowSha:("b"*40), runId:"123", runAttempt:1, observedAt:$generated, expiresAt:$token_expiry
      } else null end)
    }' > "${tmpdir}/wrapper/report.json"
  local status=0
  local proof_args=()
  if [ "${action}" = "release" ]; then
    proof_args=(--workflow-observation-proof "${tmpdir}/observation-proof.json"
      --workflow-observation-digest dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd)
  fi
  FAKE_EXECUTION_STATUS="${execution_status}" FAKE_REPORT="${tmpdir}/wrapper/report.json" \
    bash "${tmpdir}/wrapper/run-deployment-admission.sh" \
      --action "${action}" --owner 11111111-1111-4111-8111-111111111111 \
      --source-release-sha aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
      --candidate-release-sha bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
      --source-image-digest sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc \
      --job-release-sha aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
      --target-origin https://krypto.example.com \
      --job-name caj-prod-activation-check --resource-group rg-krypto-prod \
      --container-url https://evidencefixture.blob.core.windows.net/evidence \
      --job-execution-id run-1 --destination "${tmpdir}/wrapper/evidence" \
      "${proof_args[@]}" \
      --timeout-seconds 2 > "${tmpdir}/launch.log" 2>&1 || status=$?
  if [ "${status}" -ne "${expected}" ]; then
    echo "FAIL  wrapper ${execution_status}/${report_status}/${native_name}: expected ${expected}, got ${status}" >&2
    cat "${tmpdir}/launch.log" >&2
    exit 1
  fi
}
wrapper_case 0 0 admitted
wrapper_case 75 2 deferred
wrapper_case 1 0 deferred
wrapper_case 1 1 deferred
wrapper_case 1 2 admitted
wrapper_case 1 2 blocked
wrapper_case 1 2 deferred different-execution
wrapper_case 1 127 deferred
wrapper_case 0 0 released execution-1 release 1.1.0
wrapper_case 1 0 released execution-1 release 1.0.0
wrapper_case 1 0 released different-execution release 1.1.0
wrapper_case 1 2 released execution-1 release 1.1.0
echo "PASS  admission accepts deferral only for its exact, terminal-failed Azure execution"
echo "PASS  release wrapper requires both a successful execution and the exact attested receipt"
