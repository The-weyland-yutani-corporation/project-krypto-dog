#!/usr/bin/env bash
# Executable fixture tests for verify-deploy-sha.sh's fail-closed
# argument validation (the part that runs BEFORE any git/gh network
# call, so it is safe to test in the same “no Azure login, no live
# network dependency” validation job as the rest of this suite). The
# live git-ancestor / GitHub Actions API behavior was manually verified
# end-to-end against this repo's real history during implementation
# (see the workflow's own PR/session notes) and is not repeated here to
# avoid making CI depend on a live network call and specific commit
# history that will drift over time.
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

echo
echo "${total} assertions run, $((total - failures)) passed, ${failures} failed."
if [ "${failures}" -gt 0 ]; then
  exit 1
fi
