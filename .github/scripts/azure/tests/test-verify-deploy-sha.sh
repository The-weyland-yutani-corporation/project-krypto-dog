#!/usr/bin/env bash
# Executable fixture tests for verify-deploy-sha.sh's fail-closed
# argument validation and exact CI provenance. Full-path fixtures replace
# git/gh with deterministic functions; no test contacts a remote service.
#
# Usage: bash tests/test-verify-deploy-sha.sh
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script_path="${script_dir}/../verify-deploy-sha.sh"

failures=0
total=0

# assert_rejects_before_network <description> <args...>
# Runs the script with GH_TOKEN unset/empty and no network access
# expectation -- every case here must be rejected purely by argument
# validation (exit 1, without ever reaching a git fetch or gh api call).
assert_rejects_before_network() {
  local description="$1"
  shift
  total=$((total + 1))
  local output
  if output="$(env -u GH_TOKEN -u GITHUB_TOKEN bash "${script_path}" "$@" 2>&1)"; then
    failures=$((failures + 1))
    echo "FAIL  ${description}: expected rejection but script exited 0. Output: ${output}"
    return 0
  fi
  echo "PASS  ${description}: rejected as expected (${output})"
}

assert_rejects_before_network \
  "malformed SHA (not 40 hex chars)" \
  --sha "not-a-sha" --branch main --repo owner/repo --ci-workflow ci.yml

assert_rejects_before_network \
  "malformed SHA (uppercase hex)" \
  --sha "$(printf 'A%.0s' $(seq 1 40))" --branch main --repo owner/repo --ci-workflow ci.yml

assert_rejects_before_network \
  "shell-metacharacter-laden branch" \
  --sha "$(printf 'a%.0s' $(seq 1 40))" --branch 'main; rm -rf /' --repo owner/repo --ci-workflow ci.yml

assert_rejects_before_network \
  "shell-metacharacter-laden branch (command substitution)" \
  --sha "$(printf 'a%.0s' $(seq 1 40))" --branch 'main$(whoami)' --repo owner/repo --ci-workflow ci.yml

assert_rejects_before_network \
  "malformed repo (missing owner/repo slash)" \
  --sha "$(printf 'a%.0s' $(seq 1 40))" --branch main --repo not_a_repo --ci-workflow ci.yml

assert_rejects_before_network \
  "malformed repo (shell metacharacters)" \
  --sha "$(printf 'a%.0s' $(seq 1 40))" --branch main --repo 'owner/repo; rm -rf /' --ci-workflow ci.yml

assert_rejects_before_network \
  "malformed ci-workflow (path traversal)" \
  --sha "$(printf 'a%.0s' $(seq 1 40))" --branch main --repo owner/repo --ci-workflow '../../etc/passwd'

# This one has fully valid arguments, so it must get PAST argument
# validation and only then fail because GH_TOKEN/GITHUB_TOKEN is unset
# -- proving the auth check itself is real and fail-closed too (not
# merely a warning).
total=$((total + 1))
output="$(env -u GH_TOKEN -u GITHUB_TOKEN bash "${script_path}" \
  --sha "$(printf 'a%.0s' $(seq 1 40))" --branch main --repo owner/repo --ci-workflow ci.yml 2>&1)" && rc=0 || rc=$?
if [ "${rc:-0}" -ne 0 ] && printf '%s' "${output}" | grep -q "GH_TOKEN"; then
  echo "PASS  valid-format args but no GH_TOKEN: rejected with an auth-specific message"
else
  failures=$((failures + 1))
  echo "FAIL  valid-format args but no GH_TOKEN: expected a GH_TOKEN-specific rejection, got (rc=${rc:-0}): ${output}"
fi

total=$((total + 1))
output="$(env -u GH_TOKEN -u GITHUB_TOKEN bash "${script_path}" \
  --sha "$(printf 'a%.0s' $(seq 1 40))" --branch develop/azure --repo owner/repo --ci-workflow ci.yml 2>&1)" && rc=0 || rc=$?
if [ "${rc:-0}" -ne 0 ] && printf '%s' "${output}" | grep -q "GH_TOKEN"; then
  echo "PASS  slash-qualified branch passed ref validation before auth rejection"
else
  failures=$((failures + 1))
  echo "FAIL  slash-qualified branch should reach the GH_TOKEN check, got (rc=${rc:-0}): ${output}"
fi

git() {
  case "${1:-}" in
    check-ref-format) command git "$@" ;;
    rev-parse) printf 'false\n' ;;
    fetch)
      [[ "$*" == "fetch --quiet origin +refs/heads/main:refs/remotes/origin/main" ]]
      ;;
    cat-file) return 0 ;;
    merge-base) [[ "${FAKE_ANCESTOR:-true}" == "true" ]] ;;
    *) echo "Unexpected fixture git command." >&2; return 99 ;;
  esac
}
gh() {
  local args=" $* "
  if [[ "${args}" != *" -X GET "* ]] ||
     [[ "${args}" != *" branch=main "* ]] ||
     [[ "${args}" != *" head_sha=${FIXTURE_SHA} "* ]] ||
     [[ "${args}" != *" event=push "* ]] ||
     [[ "${args}" != *" status=completed "* ]] ||
     [[ "${args}" != *" repos/owner/repo/actions/workflows/ci.yml/runs "* ]]; then
    echo "Unexpected or incompletely bound CI query." >&2
    return 99
  fi
  printf '%s' "${FAKE_RUNS_JSON}"
  return "${FAKE_GH_STATUS:-0}"
}
export -f git gh
FIXTURE_SHA="$(printf 'a%.0s' $(seq 1 40))"
export FIXTURE_SHA

assert_ci_response() {
  local description="$1" expected="$2"
  total=$((total + 1))
  FAKE_RUNS_JSON="$3"
  export FAKE_RUNS_JSON
  local code=0 output
  output="$(GH_TOKEN=fixture-token GITHUB_TOKEN= bash "${script_path}" \
    --sha "${FIXTURE_SHA}" --branch main --repo owner/repo --ci-workflow ci.yml 2>&1)" || code=$?
  if [ "${code}" -eq "${expected}" ] ||
     { [ "${expected}" -eq 1 ] && [ "${code}" -gt 0 ] && [ "${code}" -ne 99 ]; }; then
    echo "PASS  ${description}"
  else
    failures=$((failures + 1))
    echo "FAIL  ${description}: expected exit ${expected}, got ${code}: ${output}"
  fi
}

assert_provenance() {
  local description="$1" expected="$2" branch="$3" event="$4" status="$5" conclusion="$6" sha="$7"
  local response
  response="$(jq -n \
    --arg branch "${branch}" --arg event "${event}" --arg status "${status}" \
    --arg conclusion "${conclusion}" --arg sha "${sha}" --arg requested "${FIXTURE_SHA}" \
    '{workflow_runs: [
      {head_sha:$requested,head_branch:"main",event:"push",status:"completed",conclusion:"failure"},
      {head_sha:$sha,head_branch:$branch,event:$event,status:$status,conclusion:$conclusion}
    ]}')"
  assert_ci_response "${description}" "${expected}" "${response}"
}

assert_provenance "accept exact main push success" 0 main push completed success "${FIXTURE_SHA}"
assert_provenance "reject develop success when main failed" 1 develop push completed success "${FIXTURE_SHA}"
assert_provenance "reject another SHA's success" 1 main push completed success "$(printf 'b%.0s' $(seq 1 40))"
assert_provenance "reject pull-request success" 1 main pull_request completed success "${FIXTURE_SHA}"
assert_provenance "reject manually dispatched CI" 1 main workflow_dispatch completed success "${FIXTURE_SHA}"
assert_provenance "reject nonterminal success-shaped response" 1 main push in_progress success "${FIXTURE_SHA}"
assert_provenance "reject failed main CI" 1 main push completed failure "${FIXTURE_SHA}"
assert_provenance "reject cancelled main CI" 1 main push completed cancelled "${FIXTURE_SHA}"
assert_provenance "reject missing branch provenance" 1 "" push completed success "${FIXTURE_SHA}"
assert_ci_response "reject absent CI inventory" 1 '{}'
assert_ci_response "reject null CI inventory" 1 '{"workflow_runs":null}'
assert_ci_response "reject non-array CI inventory" 1 '{"workflow_runs":{}}'
assert_ci_response "reject empty CI inventory" 1 '{"workflow_runs":[]}'
assert_ci_response "reject malformed run record" 1 '{"workflow_runs":[42]}'
assert_ci_response "reject malformed JSON" 1 'not-json'
assert_ci_response "reject empty API body" 1 ''
FAKE_GH_STATUS=7
export FAKE_GH_STATUS
assert_provenance "reject API failure with success-shaped partial output" 1 main push completed success "${FIXTURE_SHA}"
unset FAKE_GH_STATUS
FAKE_ANCESTOR=false
export FAKE_ANCESTOR
assert_provenance "reject a non-ancestor despite correct CI" 1 main push completed success "${FIXTURE_SHA}"

echo
echo "${total} assertions run, $((total - failures)) passed, ${failures} failed."
if [ "${failures}" -gt 0 ]; then
  exit 1
fi
