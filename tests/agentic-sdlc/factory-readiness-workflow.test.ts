import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

describe("agentic factory readiness workflow contract", () => {
  const workflow = read(
    ".github/workflows/agentic-factory-readiness.yml",
  );
  const script = read(
    ".github/scripts/agentic-factory-readiness.cjs",
  );

  it("uses only a newly created control-issue comment, never branch dispatch or PR code", () => {
    const triggerBlock = workflow.slice(
      workflow.indexOf("on:"),
      workflow.indexOf("concurrency:"),
    );
    expect(triggerBlock).toContain("issue_comment:");
    expect(triggerBlock).toContain("types: [created]");
    expect(triggerBlock).not.toMatch(
      /^\s+(workflow_dispatch|pull_request|pull_request_target|push|schedule|workflow_run):/m,
    );
    expect(workflow).toContain("Validate readiness command target");
    expect(workflow).toContain('labels: "factory-control"');
    expect(workflow).toContain("trustedAssociations");
    expect(workflow).toContain("needs.route.outputs.allowed == 'true'");
    expect(workflow).toContain("controls[0].number === issue?.number");
    expect(workflow).toContain("!issue?.pull_request");
    expect(workflow).not.toContain("pull_request_target");
  });

  it("uses only least-privilege read permissions", () => {
    const permissions = workflow.slice(
      workflow.indexOf("permissions:"),
      workflow.indexOf("jobs:"),
    );
    for (const permission of [
      "actions: read",
      "contents: read",
      "deployments: read",
      "issues: read",
      "pull-requests: read",
      "statuses: read",
    ]) {
      expect(permissions).toContain(permission);
    }
    expect(permissions).not.toMatch(/:\s*write\s*$/m);
  });

  it("binds protected approval, event SHA, checkout SHA, and rerun rejection", () => {
    expect(workflow).toContain("environment: factory-control");
    expect(workflow).toContain(
      "READINESS_APPROVAL_ENVIRONMENT: factory-control",
    );
    expect(workflow).toContain("ref: ${{ github.sha }}");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("sparse-checkout: .github/scripts");
    expect(workflow).toContain('["rev-parse", "HEAD"]');
    expect(workflow).toContain(
      "runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT)",
    );
    expect(workflow).toContain("runId: Number(process.env.GITHUB_RUN_ID)");
    expect(script).toContain("INVOCATION_RERUN_REJECTED");
    expect(script).toContain("DEFAULT_BRANCH_MOVED_DURING_PREFLIGHT");
    expect(script).toContain("commentBodyUnchanged");
    expect(script).not.toContain("getCollaboratorPermissionLevel");
  });

  it("documents strict commands and human environment prerequisites", () => {
    expect(workflow).toContain(
      "/factory-readiness mode=baseline gh-aw-token-attested=true actions-pr-attested=true",
    );
    expect(workflow).toContain(
      "mode=canary goal=700 canary=701 goal-digest=<64-hex>",
    );
    expect(workflow).toContain("active-event=<latest-label-event-id>");
    expect(workflow).toContain("prevent self-review");
    expect(workflow).toContain("protected");
    expect(workflow).toContain("development");
    expect(script).toContain("Human setup prerequisites");
  });

  it("pins every external action to an immutable commit", () => {
    expect(workflow).toContain(
      "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
    );
    expect(workflow).toContain(
      "actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3",
    );
    const actionRefs = Array.from(
      workflow.matchAll(/^\s*uses:\s+[^@\s]+@([^\s#]+)/gm),
      (match) => match[1],
    );
    expect(actionRefs).toHaveLength(3);
    for (const actionRef of actionRefs) {
      expect(actionRef).toMatch(/^[a-f0-9]{40}$/);
    }
  });

  it("has no mutation API surface", () => {
    for (const forbidden of [
      "issues.create(",
      "issues.update(",
      "issues.addLabels(",
      "issues.removeLabel(",
      "issues.createComment(",
      "actions.createWorkflowDispatch(",
      "actions.reRunWorkflow(",
      "repos.createCommitStatus(",
      "repos.createDeployment(",
      "repos.createDeploymentStatus(",
      "pulls.merge(",
      "enablePullRequestAutoMerge",
      "github.graphql(",
    ]) {
      expect(script).not.toContain(forbidden);
      expect(workflow).not.toContain(forbidden);
    }
    expect(script).not.toContain('require("node:fs")');
    expect(script).toContain("core.summary.addRaw");
  });

  it("reuses canonical policy and queue helpers while adding strict provenance", () => {
    expect(script).toContain(
      'require("./agentic-factory-policy.cjs")',
    );
    expect(script).toContain(
      'require("./agentic-queue-controller.cjs")',
    );
    expect(script).toContain(
      'require("./agentic-queue-runtime.cjs")',
    );
    expect(script).toContain(
      'require("./agentic-lifecycle-reconciler.cjs")',
    );
    expect(script).toContain("queue.evaluateEligibility");
    expect(script).toContain("queue.selectNextIssue");
    expect(script).toContain("validateCanonicalGoalBoundaries");
    expect(script).toContain("resolveLatestLabelApplicationEvent");
    expect(script).toContain("DEV_EVIDENCE_STATUS_CONTEXT");
    expect(script).toContain("deploymentStatusesByDeployment");
  });
});
