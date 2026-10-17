"use strict";

const { randomBytes } = require("node:crypto");
const { loadRunArchive } = require("./agentic-receipt.cjs");
const { actorNodeId, isGitHubActionsBot } = require("./agentic-identity.cjs");

function createDispatchRecord({ pullNumber, headSha, workflow, runId, runAttempt }) {
  if (!Number.isSafeInteger(pullNumber) || pullNumber <= 0 ||
      !/^[0-9a-f]{40}$/.test(headSha || "") || !/^[a-z-]+(?:\.lock)?\.yml$/.test(workflow || "") ||
      !Number.isSafeInteger(runId) || runId <= 0 || !Number.isSafeInteger(runAttempt) || runAttempt <= 0) {
    throw new Error("A dispatch requires a valid exact-head target and controller run identity.");
  }
  const nonce = randomBytes(16).toString("hex");
  const correlation = `agentic-pr:${pullNumber}:${headSha}:${workflow}:${runId}:${runAttempt}:${nonce}`;
  return { pullNumber, headSha, workflow, runId, runAttempt, nonce, correlation };
}

function parseDispatchCorrelation(value) {
  const match = /^agentic-pr:([1-9]\d*):([0-9a-f]{40}):([a-z-]+(?:\.lock)?\.yml):([1-9]\d*):([1-9]\d*):([0-9a-f]{32})$/.exec(value || "");
  if (!match) return null;
  const [pullNumber, runId, runAttempt] = [match[1], match[4], match[5]].map(Number);
  if (![pullNumber, runId, runAttempt].every(Number.isSafeInteger)) return null;
  return { pullNumber, headSha: match[2], workflow: match[3], runId, runAttempt, nonce: match[6], correlation: value };
}

function isControllerDispatchedRun(run, { pullNumber, headSha, workflow, defaultBranch }) {
  const record = parseDispatchCorrelation(run.display_title);
  return Boolean(record && record.pullNumber === pullNumber && record.headSha === headSha &&
    record.workflow === workflow && run.head_branch === defaultBranch && run.event === "workflow_dispatch" &&
    isGitHubActionsBot(run.actor) && isGitHubActionsBot(run.triggering_actor));
}

async function verifyControllerDispatch({ github, owner, repo, run, defaultBranch, pullNumber, headSha, workflow }) {
  if (!isControllerDispatchedRun(run, { defaultBranch, pullNumber, headSha, workflow })) return false;
  const record = parseDispatchCorrelation(run.display_title);
  const { data: controller } = await github.rest.actions.getWorkflowRun({
    owner, repo, run_id: record.runId,
  });
  if (controller.id !== record.runId || controller.run_attempt !== record.runAttempt ||
      controller.run_attempt !== 1 ||
      !actorNodeId(controller.actor) || actorNodeId(controller.actor) !== actorNodeId(controller.triggering_actor) ||
      controller.repository?.full_name?.toLowerCase() !== `${owner}/${repo}`.toLowerCase() ||
      controller.head_branch !== defaultBranch ||
      controller.path !== ".github/workflows/agentic-pr-reconciler.yml" ||
      !["schedule", "pull_request_target", "workflow_run", "issues"].includes(controller.event) ||
      controller.status !== "completed" || controller.conclusion !== "success") return false;
  const receipt = await loadRunArchive({
    github, owner, repo, run: controller, name: `factory-dispatches-${record.runAttempt}`,
  });
  if (receipt.schemaVersion !== 1 || receipt.runId !== record.runId ||
      receipt.runAttempt !== record.runAttempt || !Array.isArray(receipt.dispatches)) return false;
  const matching = receipt.dispatches.filter((entry) => entry.correlation === record.correlation);
  return matching.length === 1 && Object.entries(record).every(([key, value]) => matching[0][key] === value);
}

module.exports = { createDispatchRecord, parseDispatchCorrelation, isControllerDispatchedRun, verifyControllerDispatch };
