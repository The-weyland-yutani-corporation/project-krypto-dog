"use strict";

const { resolveFactoryModeFromLabels } = require("./agentic-factory-policy.cjs");
const { getReviewState } = require("./agentic-pr-reconciler.cjs");

async function readActiveMergeTarget({ github, owner, repo, pullRequest, core }) {
  const controls = (await github.paginate(github.rest.issues.listForRepo, {
    owner, repo, state: "open", labels: "factory-control", per_page: 100,
  })).filter((issue) => !issue.pull_request);
  if (controls.length !== 1 || resolveFactoryModeFromLabels(controls[0].labels) !== "active") {
    core.info("Exact-head merge stopped: factory is no longer active.");
    return null;
  }
  const { data: current } = await github.rest.pulls.get({ owner, repo, pull_number: pullRequest.number });
  const labels = new Set((current.labels || []).map((label) => typeof label === "string" ? label : label.name));
  if (current.state !== "open" || current.draft || current.head.sha !== pullRequest.head.sha ||
      current.head.repo?.full_name?.toLowerCase() !== `${owner}/${repo}`.toLowerCase() ||
      current.base?.ref !== "main" || !labels.has("agentic-automerge") ||
      labels.has("blocked") || labels.has("self-heal-exhausted")) {
    core.info("Exact-head merge stopped: pull request changed after verification.");
    return null;
  }
  return current;
}

async function mergeVerifiedHead({ github, owner, repo, pullRequest, core, assignmentActorNodeId, serverUrl }) {
  let current = await readActiveMergeTarget({ github, owner, repo, pullRequest, core });
  if (!current) return;
  const authorization = await require("./agentic-pr-reconciler.cjs").verifyAutonomousMergeCandidate({
    github, owner, repo, pullRequest: current, core, assignmentActorNodeId, serverUrl,
  });
  if (!authorization.valid) {
    core.warning(`Exact-head merge stopped: ${authorization.reason}.`);
    return;
  }
  // Receipt/provenance reads can take time. Re-read the emergency switch and
  // live enrollment after verification, immediately before the mutation.
  current = await readActiveMergeTarget({ github, owner, repo, pullRequest, core });
  if (!current) return;
  const reviews = await github.paginate(github.rest.pulls.listReviews, {
    owner, repo, pull_number: current.number, per_page: 100,
  });
  if (getReviewState(current, reviews, current.head.sha).hasCurrentHumanChangesRequested) {
    core.info("Exact-head merge stopped: a current review veto is present.");
    return;
  }
  if (current.mergeable_state === "behind") {
    await github.rest.pulls.updateBranch({
      owner, repo, pull_number: current.number, expected_head_sha: pullRequest.head.sha,
    });
    core.info("Updated the behind branch; fresh head verification is required before merge.");
    return;
  }
  if (current.mergeable_state !== "clean") {
    core.info(`Exact-head merge waiting for GitHub protection/mergeability: ${current.mergeable_state}.`);
    return;
  }
  const { data } = await github.rest.pulls.merge({
    owner, repo, pull_number: current.number,
    sha: pullRequest.head.sha, merge_method: "squash",
  });
  if (data.merged !== true) throw new Error(`GitHub declined the exact-head merge: ${data.message}`);
  core.info(`Merged PR #${current.number} at ${data.sha}.`);
}

module.exports = { mergeVerifiedHead };
