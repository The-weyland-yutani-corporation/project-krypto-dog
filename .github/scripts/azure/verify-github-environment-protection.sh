#!/usr/bin/env bash
set -euo pipefail

repository="The-weyland-yutani-corporation/project-krypto-dog"
repository_id="1189023287"
owner="The-weyland-yutani-corporation"
owner_id="264313301"
reviewer_id="62218708"

environment_name=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --environment)
      environment_name="${2:-}"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

case "$environment_name" in
  platform|production-deploy|production-promotion) ;;
  *)
    echo "--environment must be platform, production-deploy, or production-promotion." >&2
    exit 1
    ;;
esac

if [[ -z "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ]]; then
  echo "GH_TOKEN or GITHUB_TOKEN is required." >&2
  exit 1
fi
if [[ -n "${GITHUB_REPOSITORY:-}" && "${GITHUB_REPOSITORY}" != "${repository}" ]]; then
  echo "GITHUB_REPOSITORY does not match the immutable Project Krypto repository." >&2
  exit 1
fi

repository_json="$(gh api "repos/${repository}")"
jq -e \
  --arg repository "${repository}" \
  --argjson repository_id "${repository_id}" \
  --arg owner "${owner}" \
  --argjson owner_id "${owner_id}" \
  '
    .id == $repository_id and
    .full_name == $repository and
    .owner.id == $owner_id and
    .owner.login == $owner and
    .owner.type == "Organization"
  ' <<<"${repository_json}" >/dev/null || {
    echo "GitHub repository identity does not match the immutable Project Krypto owner/repository IDs." >&2
    exit 1
  }

environment_json="$(gh api "repos/${repository}/environments/${environment_name}")"
jq -e \
  --arg environment "${environment_name}" \
  --argjson reviewer_id "${reviewer_id}" \
  '
    .name == $environment and
    .can_admins_bypass == false and
    .deployment_branch_policy.custom_branch_policies == true and
    .deployment_branch_policy.protected_branches == false and
    ([.protection_rules[] | select(.type == "branch_policy")] | length) == 1 and
    ([.protection_rules[] | select(.type == "required_reviewers")] | length) == 1 and
    (
      [.protection_rules[] | select(.type == "required_reviewers")][0] as $rule |
      $rule.prevent_self_review == true and
      ($rule.reviewers | length) == 1 and
      $rule.reviewers[0].type == "User" and
      $rule.reviewers[0].reviewer.type == "User" and
      $rule.reviewers[0].reviewer.id == $reviewer_id
    )
  ' <<<"${environment_json}" >/dev/null || {
    echo "${environment_name} does not enforce the audited human, no-self-review, no-admin-bypass approval policy." >&2
    exit 1
  }

branch_policies_json="$(gh api "repos/${repository}/environments/${environment_name}/deployment-branch-policies")"
jq -e \
  --arg environment "${environment_name}" \
  '
    [.branch_policies[] | select(.type == "branch") | .name] as $branches |
    (.branch_policies | length) == ($branches | length) and
    ($branches | unique | length) == ($branches | length) and
    if $environment == "development" then
      ($branches | sort) == ["develop/azure"]
    else
      ($branches | sort) == ["develop/azure", "main"]
    end
  ' <<<"${branch_policies_json}" >/dev/null || {
    echo "${environment_name} deployment branch policies do not match the exact audited branch set." >&2
    exit 1
  }

echo "Verified ${environment_name} approval authority for immutable repository ${repository}@${repository_id}."
