#!/usr/bin/env bash
# Executable regression/fixture tests for
# .github/scripts/azure/lib/common.sh's shell-native validators. No test
# framework or new dependencies -- pure bash `[[ ... ]]` assertions,
# sourcing the real library (never reimplementing its patterns).
#
# Usage: bash tests/test-common-sh.sh
# Exits 0 if every case matches expectations, 1 otherwise (printing a
# PASS/FAIL line per case plus a summary).
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
source "${script_dir}/../lib/common.sh"

failures=0
total=0

# assert_accept <function-name> <value> [expected-output]
assert_accept() {
  local fn="$1" value="$2" expected_output="${3:-$2}"
  total=$((total + 1))
  local got
  if got="$("${fn}" "${value}" 2>/tmp/test-common-sh-stderr)"; then
    if [ "${got}" = "${expected_output}" ]; then
      echo "PASS  ${fn}('${value}') accepted, got '${got}'"
      return 0
    fi
    failures=$((failures + 1))
    echo "FAIL  ${fn}('${value}') accepted but output '${got}' != expected '${expected_output}'"
    return 0
  fi
  failures=$((failures + 1))
  echo "FAIL  ${fn}('${value}') expected ACCEPT but was REJECTED: $(cat /tmp/test-common-sh-stderr)"
}

# assert_reject <function-name> <value>
assert_reject() {
  local fn="$1" value="$2"
  total=$((total + 1))
  if "${fn}" "${value}" >/tmp/test-common-sh-stdout 2>/tmp/test-common-sh-stderr; then
    failures=$((failures + 1))
    echo "FAIL  ${fn}('${value}') expected REJECT but was ACCEPTED: $(cat /tmp/test-common-sh-stdout)"
    return 0
  fi
  echo "PASS  ${fn}('${value}') rejected: $(cat /tmp/test-common-sh-stderr)"
}

echo "== azure_validate_container_url =="

# Regression: this is the exact fixed shape produced by
# azure-rotate-secrets.yml's "Resolve live resource IDs and evidence
# container URL" step (blob_endpoint trimmed of its trailing slash, then
# joined to '/evidence' -- the fixed '/' join, not the historical bug).
assert_accept azure_validate_container_url \
  "https://stkryptoprodevid.blob.core.windows.net/evidence"

# Regression: this is the exact MALFORMED shape the historical bug
# produced -- `${blob_endpoint%/}evidence` (missing the '/' before
# "evidence"), which mangles the host label itself
# ("...windows.netevidence") rather than adding a path segment. Proves
# the historical bug would have been caught had this validator existed
# at the time, and stays red if the bug is ever reintroduced.
assert_reject azure_validate_container_url \
  "https://stkryptoprodevid.blob.core.windows.netevidence"

# Other malformed shapes that must also be rejected.
assert_reject azure_validate_container_url \
  "http://stkryptoprodevid.blob.core.windows.net/evidence" # not https
assert_reject azure_validate_container_url \
  "https://stkryptoprodevid.blob.core.windows.net/evidence/" # trailing slash
assert_reject azure_validate_container_url \
  "https://stkryptoprodevid.blob.core.windows.net/evidence/extra" # extra path segment
assert_reject azure_validate_container_url \
  "https://stkryptoprodevid.blob.core.windows.net/" # missing container name
assert_reject azure_validate_container_url \
  "https://stkryptoprodevid.blob.core.windows.net" # missing path entirely
assert_reject azure_validate_container_url \
  "https://user:pass@stkryptoprodevid.blob.core.windows.net/evidence" # credentials
assert_reject azure_validate_container_url \
  "https://stkryptoprodevid.blob.core.windows.net/evidence?sig=abc" # query string
assert_reject azure_validate_container_url \
  "https://stkryptoprodevid.blob.core.windows.net/evidence#frag" # fragment
assert_reject azure_validate_container_url \
  "https://evil.example.com/evidence" # wrong host entirely
assert_reject azure_validate_container_url \
  "" # empty

echo
echo "== azure_validate_release_sha =="
assert_accept azure_validate_release_sha "$(printf 'a%.0s' $(seq 1 40))"
assert_reject azure_validate_release_sha "not-a-sha"
assert_reject azure_validate_release_sha "$(printf 'A%.0s' $(seq 1 40))" # must be lowercase

echo
echo "== azure_validate_image_digest =="
assert_accept azure_validate_image_digest "sha256:$(printf 'b%.0s' $(seq 1 64))"
assert_reject azure_validate_image_digest "sha256:short"
assert_reject azure_validate_image_digest "$(printf 'b%.0s' $(seq 1 64))" # missing sha256: prefix

echo
echo "== azure_validate_job_execution_id =="
assert_accept azure_validate_job_execution_id "run123-a1-target-smoke"
assert_reject azure_validate_job_execution_id "../../etc/passwd"
assert_reject azure_validate_job_execution_id "has a space"

echo
echo "== stable deployment fence ownership =="
expected_owner="34aa399d-f243-5b32-832f-e399e1f22b74"
owner_for_repository() { GITHUB_REPOSITORY_ID="$1" GITHUB_RUN_ID=123 azure_deployment_fence_owner; }
owner_for_run() { GITHUB_REPOSITORY_ID=456 GITHUB_RUN_ID="$1" azure_deployment_fence_owner; }
assert_accept owner_for_repository 456 "${expected_owner}"
assert_accept owner_for_run 123 "${expected_owner}"
GITHUB_RUN_ATTEMPT=99 assert_accept owner_for_run 123 "${expected_owner}"
assert_accept azure_validate_fence_owner "${expected_owner}"
assert_accept azure_validate_fence_owner "11111111-1111-4111-8111-111111111111"
assert_reject azure_validate_fence_owner "11111111-1111-1111-8111-111111111111"
assert_reject azure_validate_fence_owner "11111111-1111-5111-1111-111111111111"
assert_reject azure_validate_fence_owner "${expected_owner^^}"
for invalid in "" 0 -1 01 1.5 '$(whoami)' $'123\n456'; do
  assert_reject owner_for_repository "${invalid}"
  assert_reject owner_for_run "${invalid}"
done
for alternate_owner in "$(owner_for_repository 457)" "$(owner_for_run 124)"; do
  total=$((total + 1))
  if [ "${alternate_owner}" != "${expected_owner}" ]; then
    echo "PASS  another repository/run has a distinct cutover owner"
  else
    failures=$((failures + 1))
    echo "FAIL  independent repository/run reused a cutover owner"
  fi
done

echo
echo "== azure_validate_safe_token =="
# azure_validate_safe_token takes (label, value); wrap it so it fits the
# single-value assert_accept/assert_reject helpers above.
safe_token_wrapper() { azure_validate_safe_token "test-label" "$1"; }
assert_accept safe_token_wrapper "gpt-4o-mini"
assert_accept safe_token_wrapper "prod-deployment_01"
assert_reject safe_token_wrapper "has a space"
assert_reject safe_token_wrapper '$(whoami)'
assert_reject safe_token_wrapper 'name;rm -rf /'
assert_reject safe_token_wrapper 'name`id`'
assert_reject safe_token_wrapper "$(printf 'x%.0s' $(seq 1 129))" # too long

echo
echo "== azure_new_job_execution_id =="
GITHUB_RUN_ID=123 GITHUB_RUN_ATTEMPT=2
export GITHUB_RUN_ID GITHUB_RUN_ATTEMPT
generated_execution_id="$(azure_new_job_execution_id verified-backup current)"
assert_accept azure_validate_job_execution_id \
  "${generated_execution_id}" \
  "run123-a2-verified-backup-current"
total=$((total + 1))
if azure_new_job_execution_id verified-backup 'INVALID!' >/tmp/test-common-sh-stdout 2>/tmp/test-common-sh-stderr; then
  failures=$((failures + 1))
  echo "FAIL  azure_new_job_execution_id accepted an unsafe discriminator"
else
  echo "PASS  azure_new_job_execution_id rejected an unsafe discriminator"
fi

echo
echo "== azure_validate_location =="
assert_accept azure_validate_location "eastus2"
assert_reject azure_validate_location "East US 2"
assert_reject azure_validate_location "eastus2;rm -rf /"
assert_reject azure_validate_location "E"

echo
echo "== azure_validate_capacity =="
assert_accept azure_validate_capacity "10"
assert_accept azure_validate_capacity "1"
assert_reject azure_validate_capacity "0"
assert_reject azure_validate_capacity "01"
assert_reject azure_validate_capacity "10;rm -rf /"
assert_reject azure_validate_capacity "-5"
assert_reject azure_validate_capacity "10.5"

echo
echo "${total} assertions run, $((total - failures)) passed, ${failures} failed."
if [ "${failures}" -gt 0 ]; then
  exit 1
fi
