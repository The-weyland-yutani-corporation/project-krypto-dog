import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

describe("agentic SDLC workflow contracts", () => {
  const reconciler = read(
    ".github/workflows/agentic-pr-reconciler.yml",
  );
  const reconcilerScript = read(
    ".github/scripts/agentic-pr-reconciler.cjs",
  );
  const ci = read(".github/workflows/ci.yml");
  const e2e = read(".github/workflows/agentic-sdlc-e2e.yml");
  const codeReview = read(".github/workflows/code-review.md");
  const docsSync = read(".github/workflows/docs-sync.md");
  const implementTicket = read(".github/workflows/implement-ticket.md");
  const qaReview = read(".github/workflows/qa-test-plan.md");
  const securityReview = read(".github/workflows/security-review.md");
  const selfHeal = read(".github/workflows/pr-self-heal.md");
  const tradingSafetyReview = read(
    ".github/workflows/trading-safety-review.md",
  );
  const devDeploy = read(".github/workflows/azure-deploy-dev.yml");
  const prodDeploy = read(".github/workflows/azure-deploy-prod.yml");
  const queueWorkflow = read(
    ".github/workflows/factory-queue-controller.yml",
  );
  const lifecycleWorkflow = read(
    ".github/workflows/agentic-lifecycle-reconciler.yml",
  );
  const autoMergeSweeper = read(
    ".github/workflows/agentic-automerge-sweeper.yml",
  );
  const autoMergeSweeperScript = read(
    ".github/scripts/agentic-automerge-sweeper.cjs",
  );
  const fullE2e = read(
    ".github/workflows/agentic-factory-full-e2e.yml",
  );
  const copilotSetup = read(
    ".github/workflows/copilot-setup-steps.yml",
  );

  it("loads the tested reconciler implementation only from the trusted base", () => {
    expect(reconciler).toContain(
      "ref: ${{ github.event.repository.default_branch }}",
    );
    expect(reconciler).toContain("persist-credentials: false");
    expect(reconciler).toContain("sparse-checkout: |");
    expect(reconciler).toContain(".github/scripts");
    expect(reconciler).toContain(".github/agentic-policy.json");
    expect(reconciler).toContain(
      '".github/scripts/agentic-pr-reconciler.cjs"',
    );
    expect(reconciler).toContain(
      "await reconcileAgenticPullRequests({",
    );
    expect(reconciler).toContain("checks: write");
    expect(reconciler).toContain("pull-requests: write");
    expect(reconciler).toContain("backfill_deprecated_checks");
    expect(reconciler).toContain("default: false");
    expect(reconcilerScript).toContain("run.display_title === correlationId");
    expect(reconcilerScript).not.toContain("checks.create");
    expect(reconcilerScript).toContain("DEPRECATED_POLICY_CHECKS");
    expect(reconcilerScript).toContain(
      "dispatch(workflowId, defaultBranch",
    );
    expect(reconcilerScript).not.toContain("approveWorkflowRun");
    expect(reconciler).not.toContain("statuses: write");
  });

  it.each([
    ["queue controller", queueWorkflow, "agentic-queue-runtime.cjs"],
    [
      "lifecycle reconciler",
      lifecycleWorkflow,
      "agentic-lifecycle-reconciler.cjs",
    ],
  ])("loads the %s only from the trusted default branch", (_name, workflow, script) => {
    expect(workflow).toContain(
      "ref: ${{ github.event.repository.default_branch }}",
    );
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain(".github/scripts");
    expect(workflow).toContain(script);
    expect(workflow).not.toContain("ref: ${{ github.event.pull_request.head");
  });

  it("loads the auto-merge sweeper only from the trusted default branch", () => {
    expect(autoMergeSweeper).toContain(
      "ref: ${{ github.event.repository.default_branch }}",
    );
    expect(autoMergeSweeper).toContain("persist-credentials: false");
    expect(autoMergeSweeper).toContain("sparse-checkout: |");
    expect(autoMergeSweeper).toContain(".github/scripts");
    expect(autoMergeSweeper).toContain(".github/agentic-policy.json");
    expect(autoMergeSweeper).toContain(
      '".github/scripts/agentic-automerge-sweeper.cjs"',
    );
    expect(autoMergeSweeper).toContain(
      "await sweepAutoMergeReadyPullRequests({ github, context, core });",
    );
    expect(autoMergeSweeper).not.toContain(
      "ref: ${{ github.event.pull_request.head",
    );
  });

  it("keeps the auto-merge sweeper unable to merge or forge evidence", () => {
    // The sweeper only queues a merge that branch protection still gates. It
    // must never hold a scope that lets it push, publish evidence, or bypass a
    // required context.
    expect(autoMergeSweeper).toContain("pull-requests: write");
    expect(autoMergeSweeper).toContain("contents: read");
    expect(autoMergeSweeper).not.toContain("contents: write");
    expect(autoMergeSweeper).not.toContain("checks: write");
    expect(autoMergeSweeper).not.toContain("statuses: write");
    // Never checks out an untrusted head.
    expect(autoMergeSweeper).not.toContain("pull_request_target:");
    expect(autoMergeSweeper).toContain("group: agentic-automerge-sweeper");
    expect(autoMergeSweeper).toContain("cancel-in-progress: false");

    for (const forbidden of [
      "pulls.merge",
      "pulls.updateBranch",
      "checks.create",
      "createCommitStatus",
      "addLabels",
    ]) {
      expect(autoMergeSweeperScript).not.toContain(forbidden);
    }
    expect(autoMergeSweeperScript).toContain("enablePullRequestAutoMerge");
    expect(autoMergeSweeperScript).toContain("mergeMethod: SQUASH");
  });

  it("serializes deterministic queue and lifecycle mutation", () => {
    expect(queueWorkflow).toContain("group: factory-queue-controller");
    expect(queueWorkflow).toContain("cancel-in-progress: false");
    expect(lifecycleWorkflow).toContain(
      "group: agentic-lifecycle-reconciler",
    );
    expect(lifecycleWorkflow).toContain("cancel-in-progress: false");
    expect(lifecycleWorkflow).not.toMatch(/^\s+status:/m);
  });

  it("binds lifecycle assignment provenance to the human-governed stable actor ID", () => {
    expect(lifecycleWorkflow).toContain(".github/agentic-policy.json");
    expect(lifecycleWorkflow).toContain(
      "FACTORY_ASSIGNMENT_ACTOR_NODE_ID: ${{ vars.FACTORY_ASSIGNMENT_ACTOR_NODE_ID }}",
    );
    expect(lifecycleWorkflow).toContain(
      "assignmentActorNodeId:",
    );
    expect(reconciler).toContain(
      "FACTORY_ASSIGNMENT_ACTOR_NODE_ID: ${{ vars.FACTORY_ASSIGNMENT_ACTOR_NODE_ID }}",
    );
  });

  it("keeps the traditional E2E workflow manual-only", () => {
    const triggerBlock = e2e.slice(
      e2e.indexOf("on:"),
      e2e.indexOf("concurrency:"),
    );

    expect(triggerBlock).toContain("workflow_dispatch:");
    expect(triggerBlock).not.toMatch(
      /^\s+(pull_request|pull_request_target|push|schedule|workflow_run):/m,
    );
    expect(triggerBlock).toContain("- happy-path");
    expect(triggerBlock).toContain("- self-heal");
    expect(e2e).toContain("Require human-activated factory mode");
    expect(e2e).toContain('labels: "factory-control"');
    expect(e2e).toContain('actor?.type !== "User"');
  });

  it("assigns claimed issues to the coding agent instead of editing directly", () => {
    const triggerBlock = implementTicket.slice(
      implementTicket.indexOf("on:"),
      implementTicket.indexOf("permissions:"),
    );

    expect(triggerBlock).toContain("workflow_dispatch:");
    expect(triggerBlock).toContain("claim_nonce:");
    expect(triggerBlock).not.toContain("issues:");
    expect(implementTicket).toContain("assign-to-agent:");
    expect(implementTicket).toContain("custom-agent: project-krypto-dev");
    expect(implementTicket).toContain(
      "target: ${{ github.event.inputs.issue }}",
    );
    expect(implementTicket).not.toContain("create-pull-request:");
  });

  it("prepares the coding-agent workspace with pinned project dependencies", () => {
    expect(copilotSetup).toContain("node-version-file: .nvmrc");
    expect(copilotSetup).toContain("run: npm ci");
    expect(copilotSetup).toContain("github/gh-aw-actions/setup-cli@v0.81.6");
  });

  it("emits machine-readable reviews and retains head-refresh requirements", () => {
    expect(qaReview).toContain("CHECK_NAME: QA verification");
    expect(qaReview).toContain("create-pr-check:");
    expect(qaReview).not.toContain("remove-labels:");
    expect(securityReview).not.toContain("remove-labels:");
    expect(tradingSafetyReview).not.toContain("remove-labels:");
    expect(qaReview).toContain("reruns");
    expect(securityReview).toContain("reruns");
    expect(tradingSafetyReview).toContain("reruns");
    expect(reconciler).toContain("QA Test Plan");
  });

  it("keeps docs-sync spec repairs reviewable and outside auto-merge", () => {
    expect(docsSync).toContain('      - "specs/**"');
    expect(docsSync).toContain("auto-merge: false");
    expect(docsSync).toContain("protected-files: fallback-to-issue");
    expect(docsSync).not.toContain("agentic-automerge");
  });

  it("runs trading-safety review for every canonical or attempted proposal spec", () => {
    expect(tradingSafetyReview).toContain('- "specs/**"');
  });

  it("correlates trusted workflow dispatches to an exact pull-request head", () => {
    expect(ci).toContain("correlation_id:");
    expect(ci).toContain("head_sha:");
    expect(ci).toContain("Verify dispatched head");
    expect(ci).toContain(
      "github.event_name == 'workflow_dispatch' && inputs.head_sha != ''",
    );
    for (const workflow of [
      codeReview,
      qaReview,
      securityReview,
      tradingSafetyReview,
    ]) {
      expect(workflow).toContain("correlation_id:");
      expect(workflow).toContain("head_sha:");
      expect(workflow).toContain("pre-agent-steps:");
      expect(workflow).toContain("Restore trusted agent instructions");
      expect(workflow).toContain("Verify dispatched PR head");
      expect(workflow).toContain("create-pr-check:");
      expect(workflow).toContain("checks: write");
      expect(workflow).toContain("pull-requests: read");
      expect(workflow).toContain("EXPECTED_PR_NUMBER:");
      expect(workflow).toContain("EXPECTED_HEAD_SHA:");
      expect(workflow).toContain("Agent pull request number does not match trusted context");
      expect(workflow).toContain(
        "needs.detection.outputs.detection_success == 'true'",
      );
      expect(workflow).toContain("continue-on-error: false");
    }
    expect(selfHeal).toContain("correlation_id:");
    expect(selfHeal).toContain("head_sha:");
    expect(selfHeal).toContain("pre-agent-steps:");
    expect(selfHeal).toContain("Restore trusted agent instructions");
    expect(selfHeal).toContain("Verify dispatched PR head");
  });

  // gh-aw skips its PR checkout on workflow_dispatch ("No pull request context
  // available"), so the agent workspace stays on the default branch. A guard that
  // compared the local HEAD to inputs.head_sha could therefore never pass and killed
  // every dispatched review run before it did any work. The guard must resolve the
  // head through the API instead.
  it("verifies a dispatched review head through the API, never the local checkout", () => {
    for (const workflow of [
      codeReview,
      qaReview,
      securityReview,
      tradingSafetyReview,
    ]) {
      expect(workflow).toContain("Verify dispatched PR head");
      expect(workflow).toContain(
        'gh api "repos/${GH_AW_REPOSITORY}/pulls/${EXPECTED_PR_NUMBER}" --jq \'.head.sha\'',
      );
      // Fail closed on a non-numeric target and on any API failure.
      expect(workflow).toContain("set -euo pipefail");
      expect(workflow).toContain("''|*[!0-9]*)");
      // The broken local-tree assertion must not come back.
      expect(workflow).not.toContain(
        'test "$(git rev-parse HEAD)" = "${EXPECTED_HEAD_SHA}"',
      );
    }
  });

  it("automates only exact-SHA dev delivery from main", () => {
    expect(devDeploy).toContain(
      "github.event.workflow_run.head_branch == 'main'",
    );
    expect(devDeploy).toContain('context: "Dev deployment evidence"');
    expect(devDeploy).toContain('environment: "development"');
    expect(devDeploy).toContain("production_environment: false");
  });

  it("keeps production deployment structurally manual-only", () => {
    const triggerBlock = prodDeploy.slice(
      prodDeploy.indexOf("on:"),
      prodDeploy.indexOf("concurrency:"),
    );

    expect(triggerBlock).toContain("workflow_dispatch:");
    expect(triggerBlock).not.toContain("workflow_run:");
    expect(prodDeploy).toContain("environment: production-promotion");
    expect(prodDeploy).toContain("environment: production-deploy");
  });

  it("keeps the full-cycle canary goal-authorized and dev-only", () => {
    expect(fullE2e).toContain("Require a configured full-cycle canary");
    expect(fullE2e).toContain(
      "Configure FACTORY_CANARY_GOAL for scheduled runs.",
    );
    expect(fullE2e).toContain("needs: readiness");
    expect(fullE2e).not.toContain(
      "github.event_name == 'workflow_dispatch' ||",
    );
    expect(fullE2e).toContain("factory:goal-approved");
    expect(fullE2e).toContain("factory-mode:active");
    expect(fullE2e).toContain("latestHumanLabelEvent");
    expect(fullE2e).toContain("factory-queue-controller.yml");
    expect(fullE2e).toContain("factory:done");
    expect(fullE2e).toContain("Dev deployment evidence");
    expect(fullE2e).toContain('environment: "development"');
    expect(fullE2e).toContain("factory-full-heartbeat.md");
    expect(fullE2e).toContain("REQUESTED_AT");
    expect(fullE2e).not.toContain("azure-deploy-prod");
    expect(fullE2e).not.toContain("addLabels");
  });

  it("constrains the canary to the enrolled same-repository docs path", () => {
    expect(e2e).not.toContain("if: github.repository ==");
    expect(e2e).toContain(
      "CANARY_PATH: docs/e2e/factory-heartbeat.md",
    );
    expect(e2e).toContain(
      "title: `[docs-sync] Agentic SDLC E2E ${mode} canary`",
    );
    expect(e2e).toContain('"agentic-factory"');
    expect(e2e).toContain('"docs-sync"');
    expect(e2e).toContain('"agentic-automerge"');
    expect(e2e).toContain("enablePullRequestAutoMerge");
    expect(e2e).toContain('workflow_id: "agentic-pr-reconciler.yml"');
  });

  it.each([
    "Quality and evidence gates",
    "PostgreSQL migrations and execution",
    "Agentic code review",
  ])("asserts the required %s context", (contextName) => {
    expect(e2e).toContain(`"${contextName}"`);
  });

  it("asserts merge and always cleans up the branch and failed PR", () => {
    expect(e2e).toContain("pull.merged_at");
    expect(e2e).toContain("readyForAutoMerge");
    expect(e2e).toContain("headIsStable");
    expect(e2e).toContain("autoMergeEnabledAt");
    expect(e2e).toContain(
      "merged before required contexts were verified",
    );
    expect(e2e.indexOf("readyForAutoMerge")).toBeLessThan(
      e2e.indexOf("enablePullRequestAutoMerge"),
    );
    expect(e2e.indexOf('status: "in_progress"')).toBeLessThan(
      e2e.indexOf("enablePullRequestAutoMerge"),
    );
    expect(e2e).not.toContain("github.rest.checks.create");
    expect(e2e).not.toContain("createCommitStatus");
    expect(e2e).toContain("checks: read");
    expect(e2e).toContain("if: always()");
    expect(e2e).toContain(
      "CANARY_BRANCH: agentic-e2e/${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(e2e).toContain('state: "closed"');
    expect(e2e).toContain("github.rest.git.deleteRef");
  });

  it("wires the deterministic self-heal marker through review and repair", () => {
    const marker = "<!-- agentic-e2e:self-heal -->";

    expect(codeReview).toContain(marker);
    expect(codeReview).toContain("failing `Agentic code review` check");
    expect(selfHeal).toContain(marker);
    expect(selfHeal).toContain("remove only that marker");
    expect(e2e).toContain(marker);
    expect(e2e).toContain('message.includes("[self-heal]")');
    expect(e2e).toContain("selfHealCommits.length <= 2");
    expect(e2e).toContain("agentic-identity.cjs");
    expect(e2e).toContain("isResolvedCopilotActor");
  });

  it("allows only trusted factory bots to activate manual code review", () => {
    expect(codeReview).toContain(
      'bots: ["github-actions[bot]"]',
    );
  });

  it("keeps specialist escalation independent from the code-review result", () => {
    expect(codeReview).toContain(
      "Adding a specialist label does not fail this check",
    );
    expect(codeReview).toContain(
      "the deterministic merge policy independently requires the corresponding specialist check",
    );
    expect(codeReview).not.toContain(
      "Set the check to `failure` for any required fix, unresolved correctness concern, or specialist escalation.",
    );
  });

  it("requires trusted-bot specialist checks for high-risk PRs", () => {
    for (const workflow of [securityReview, tradingSafetyReview]) {
      expect(workflow).toContain(
        'bots: ["github-actions[bot]"]',
      );
      expect(workflow).toContain("create-pr-check:");
      expect(workflow).toContain("For every pull request");
    }
    expect(securityReview).toContain("CHECK_NAME: Security review");
    expect(tradingSafetyReview).toContain(
      "CHECK_NAME: Trading safety review",
    );
    expect(reconciler).toContain("Security Review");
    expect(reconciler).toContain("Trading Safety Review");
  });
});
