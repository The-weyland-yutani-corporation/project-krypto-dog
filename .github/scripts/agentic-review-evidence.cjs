"use strict";

const { AGENTIC_POLICY } = require("./agentic-policy.cjs");
const { loadRunReceipt } = require("./agentic-receipt.cjs");
const { verifyControllerDispatch } = require("./agentic-dispatch.cjs");
const REVIEW_WORKFLOWS = Object.freeze({
  "Quality and evidence gates": "ci.yml",
  "PostgreSQL migrations and execution": "ci.yml",
  [AGENTIC_POLICY.reviewCheckName]: "code-review.lock.yml",
  "QA verification": "qa-test-plan.lock.yml",
  [AGENTIC_POLICY.securityCheckName]: "security-review.lock.yml",
  [AGENTIC_POLICY.tradingSafetyCheckName]: "trading-safety-review.lock.yml",
});

async function selectTrustedCheckRuns({
  github, owner, repo, defaultBranch, serverUrl, pullNumber, headSha, checkRuns,
  names = Object.keys(REVIEW_WORKFLOWS),
}) {
  const receipts = new Map();
  const runs = new Map();
  const selected = [];
  for (const name of names) {
    const workflow = REVIEW_WORKFLOWS[name];
    if (!workflow) continue;
    for (const check of checkRuns.filter((item) => item.name === name).sort((a, b) => b.id - a.id)) {
      if (check.head_sha !== headSha || check.app?.slug !== "github-actions" ||
          check.status !== "completed") continue;
      const prefix = `${serverUrl}/${owner}/${repo}/actions/runs/`;
      if (typeof check.details_url !== "string" || !check.details_url.startsWith(prefix)) continue;
      const runId = Number(check.details_url.slice(prefix.length).match(/^([1-9]\d*)(?:\/jobs\/\d+)?\/?$/)?.[1]);
      if (!Number.isSafeInteger(runId)) continue;
      if (!runs.has(runId)) {
        runs.set(runId, (await github.rest.actions.getWorkflowRun({ owner, repo, run_id: runId })).data);
      }
      const run = runs.get(runId);
      if (run.event !== "workflow_dispatch" || run.head_branch !== defaultBranch ||
          run.repository?.full_name?.toLowerCase() !== `${owner}/${repo}`.toLowerCase() ||
          run.path !== `.github/workflows/${workflow}` ||
          run.status !== "completed" ||
          !await verifyControllerDispatch({ github, owner, repo, run, defaultBranch, pullNumber, headSha, workflow })) continue;
      if (!receipts.has(run.id)) {
        receipts.set(run.id, await loadRunReceipt({ github, owner, repo, run, headSha }));
      }
      const receipt = receipts.get(run.id);
      const verdicts = receipt.checks.filter((verdict) => verdict.name === name);
      if (verdicts.length !== 1 || verdicts[0].id !== check.id ||
          verdicts[0].conclusion !== check.conclusion ||
          (workflow !== "ci.yml" && receipt.pullNumber !== pullNumber)) continue;
      // Select the newest authenticated verdict, including failure. Never
      // search past a trusted failure for an older passing result.
      selected.push({ ...check, factoryRunConclusion: run.conclusion });
      break;
    }
  }
  return selected;
}

async function verifyTrustedReviewEvidence(input) {
  const unknown = input.requiredChecks.find((name) => !REVIEW_WORKFLOWS[name]);
  if (unknown) return { valid: false, reason: `unknown-review:${unknown}` };
  const checks = await selectTrustedCheckRuns({ ...input, names: input.requiredChecks });
  for (const name of input.requiredChecks) {
    const check = checks.find((item) => item.name === name);
    if (check?.conclusion !== "success" || check.factoryRunConclusion !== "success") {
      return { valid: false, reason: `unverified-review:${name}` };
    }
  }
  return { valid: true };
}

module.exports = { REVIEW_WORKFLOWS, selectTrustedCheckRuns, verifyTrustedReviewEvidence };
