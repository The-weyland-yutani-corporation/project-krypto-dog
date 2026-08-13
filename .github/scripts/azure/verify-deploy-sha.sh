#!/usr/bin/env bash
# Strict verification for a MANUALLY (workflow_dispatch) supplied deploy
# commit SHA: rejects the SHA unless it is BOTH (a) an ancestor of the
# exact `origin/<branch>` ref (the real, current tip of that branch on
# the remote -- never a locally-cached/stale one, since this script
# always fetches the branch fresh) and (b) has at least one *successful*
# run of the given CI workflow file for that *exact* commit SHA with
# `event == "push"` (never a `pull_request`-triggered run, which could
# have run against unreviewed/unmerged code, and never a
# `workflow_dispatch`-triggered CI run, which proves nothing about the
# commit having gone through the real push-triggered pipeline).
#
# This is deliberately NOT a format-only check -- a syntactically valid
# 40-hex string that is not actually on the target branch's history, or
# that never had CI run and pass against it via a real push, is rejected
# just as hard as a malformed string.
#
# Usage:
#   verify-deploy-sha.sh \
#     --sha <candidate 40-hex SHA> \
#     --branch <develop|main, exact branch name, no wildcards> \
#     --repo <owner/repo> \
#     --ci-workflow <workflow file name, e.g. ci.yml>
#
# Requires:
#   - `git` (run from inside a checked-out clone of --repo)
#   - `gh` CLI, authenticated via the GH_TOKEN/GITHUB_TOKEN environment
#     variable (never accepts a token as a CLI argument, and never
#     echoes it)
#   - network access to GitHub (this queries the live Actions API -- it
#     cannot be satisfied by any local/cached state, by design)
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${script_dir}/lib/common.sh"

sha=""
branch=""
repo=""
ci_workflow=""

while [ $# -gt 0 ]; do
  case "$1" in
    --sha)
      sha="${2:?--sha requires a value}"
      shift 2
      ;;
    --branch)
      branch="${2:?--branch requires a value}"
      shift 2
      ;;
    --repo)
      repo="${2:?--repo requires a value}"
      shift 2
      ;;
    --ci-workflow)
      ci_workflow="${2:?--ci-workflow requires a value}"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

sha="$(azure_validate_release_sha "${sha}")"
branch="$(azure_validate_safe_token "branch" "${branch}")"
ci_workflow="$(azure_validate_safe_token "ci-workflow" "${ci_workflow}")"

if ! [[ "${repo}" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]]; then
  echo "Invalid --repo '${repo}': must be exactly 'owner/repo' (letters, digits, '.', '_', '-' per segment)." >&2
  exit 1
fi

if [ -z "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ]; then
  echo "GH_TOKEN (or GITHUB_TOKEN) must be set in the environment for the gh CLI to authenticate." >&2
  exit 1
fi

echo "Verifying commit ${sha} is an ancestor of origin/${branch} in ${repo}..."

# Make sure we have full history to walk, then the target branch's real
# current tip, then the candidate commit itself (in case it isn't
# already reachable from whatever ref was checked out by default).
if [ "$(git rev-parse --is-shallow-repository 2>/dev/null || echo false)" = "true" ]; then
  git fetch --quiet --unshallow origin || git fetch --quiet --depth=1000000000 origin
fi
git fetch --quiet origin "${branch}"
if ! git cat-file -e "${sha}^{commit}" 2>/dev/null; then
  git fetch --quiet origin "${sha}" || true
fi
if ! git cat-file -e "${sha}^{commit}" 2>/dev/null; then
  echo "Commit ${sha} does not exist in this repository's history -- refusing to deploy an unresolvable SHA." >&2
  exit 1
fi

if ! git merge-base --is-ancestor "${sha}" "origin/${branch}"; then
  echo "Commit ${sha} is NOT an ancestor of origin/${branch} -- refusing to deploy a commit that is not on that branch's history." >&2
  exit 1
fi
echo "Confirmed: ${sha} is an ancestor of origin/${branch}."

echo "Verifying a successful '${ci_workflow}' run exists for exact commit ${sha} (event=push)..."
# NOTE: `gh api` silently switches its default HTTP method from GET to
# POST whenever any `-f`/`-F` field is supplied, which would 404 against
# this read-only endpoint -- `-X GET` must be explicit here.
success_count="$(gh api \
  -X GET \
  "repos/${repo}/actions/workflows/${ci_workflow}/runs" \
  -f "head_sha=${sha}" \
  -f "event=push" \
  -f "status=completed" \
  --jq '[.workflow_runs[] | select(.conclusion == "success")] | length')"

if ! [[ "${success_count}" =~ ^[0-9]+$ ]]; then
  echo "Unexpected response while querying the GitHub Actions API for ${ci_workflow} runs against ${sha}." >&2
  exit 1
fi
if [ "${success_count}" -lt 1 ]; then
  echo "No successful, push-triggered '${ci_workflow}' run was found for exact commit ${sha} -- refusing to deploy a commit that CI never validated on a push event." >&2
  exit 1
fi

echo "Confirmed: ${success_count} successful push-triggered '${ci_workflow}' run(s) found for commit ${sha}."
echo "SHA verification passed for ${sha} against origin/${branch}."
