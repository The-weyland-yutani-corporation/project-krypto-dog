"use strict";

const { AGENTIC_POLICY } = require("./agentic-policy.cjs");
const { loadRunReceipt } = require("./agentic-receipt.cjs");
const REVIEW_WORKFLOWS = Object.freeze({
  "Quality and evidence gates": "ci.yml",
  "PostgreSQL migrations and execution": "ci.yml",
  [AGENTIC_POLICY.reviewCheckName]: "code-review.lock.yml",
  "QA verification": "qa-test-plan.lock.yml",
  [AGENTIC_POLICY.securityCheckName]: "security-review.lock.yml",
  [AGENTIC_POLICY.tradingSafetyCheckName]: "trading-safety-review.lock.yml",
});

async function verifyTrustedReviewEvidence({
  github, owner, repo, defaultBranch, serverUrl, pullNumber, headSha, checkRuns, requiredChecks,
}) {
  const receipts = new Map();
  for (const name of requiredChecks) {
    const workflow = REVIEW_WORKFLOWS[name];
    if (!workflow) return { valid: false, reason: `unknown-review:${name}` };
    const check = checkRuns.filter((item) => item.name === name).sort((a, b) => b.id - a.id)[0];
    if (!check || check.head_sha !== headSha || check.app?.slug !== "github-actions" ||
        check.status !== "completed" || check.conclusion !== "success") {
      return { valid: false, reason: `unverified-review:${name}` };
    }
    const prefix = `${serverUrl}/${owner}/${repo}/actions/runs/`;
    if (typeof check.details_url !== "string" || !check.details_url.startsWith(prefix)) {
      return { valid: false, reason: `missing-review-run:${name}` };
    }
    const runId = check.details_url.slice(prefix.length).match(/^([1-9]\d*)(?:\/jobs\/\d+)?\/?$/)?.[1];
    if (!runId || !Number.isSafeInteger(Number(runId))) {
      return { valid: false, reason: `invalid-review-run:${name}` };
    }
    const { data: run } = await github.rest.actions.getWorkflowRun({ owner, repo, run_id: Number(runId) });
    if (run.event !== "workflow_dispatch" || run.head_branch !== defaultBranch ||
        run.repository?.full_name?.toLowerCase() !== `${owner}/${repo}`.toLowerCase() ||
        run.path !== `.github/workflows/${workflow}` ||
        run.status !== "completed" || run.conclusion !== "success" ||
        run.display_title !== `agentic-pr:${pullNumber}:${headSha}:${workflow}`) {
      return { valid: false, reason: `untrusted-review-origin:${name}` };
    }
    if (!receipts.has(run.id)) {
      receipts.set(run.id, await loadRunReceipt({ github, owner, repo, run, headSha }));
    }
    const receipt = receipts.get(run.id);
    const verdicts = receipt.checks.filter((verdict) => verdict.name === name);
    if (verdicts.length !== 1 || verdicts[0].id !== check.id || verdicts[0].conclusion !== "success" ||
        (workflow !== "ci.yml" && receipt.pullNumber !== pullNumber)) {
      return { valid: false, reason: `check-not-in-trusted-receipt:${name}` };
    }
  }
  return { valid: true };
}

module.exports = { REVIEW_WORKFLOWS, verifyTrustedReviewEvidence };
