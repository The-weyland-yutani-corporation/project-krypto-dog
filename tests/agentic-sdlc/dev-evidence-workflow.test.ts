import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { createDevEvidenceFixture, DEV_SHA } from "./fixtures/dev-evidence";

interface Workflow {
  jobs: Record<string, {
    needs?: string[];
    if?: string;
    permissions?: Record<string, string>;
    steps: { name: string; with?: { script?: string }; run?: string }[];
  }>;
}

const deployment: Workflow = parse(readFileSync(".github/workflows/azure-deploy-dev.yml", "utf8"));
const canary: Workflow = parse(readFileSync(".github/workflows/agentic-factory-full-e2e.yml", "utf8"));
const moduleUnderTest: unknown = jest.requireActual("../../.github/scripts/azure/dev-evidence.cjs");
const AsyncFunction: new (...args: string[]) => (...args: unknown[]) => Promise<void> =
  Object.getPrototypeOf(async () => undefined).constructor;

function script(workflow: Workflow, job: string, step: string) {
  const source = workflow.jobs[job].steps.find((entry) => entry.name === step)?.with?.script;
  if (!source) throw new Error(`Missing workflow script ${job}/${step}`);
  return new AsyncFunction("github", "context", "core", "require", source);
}

describe("executed development workflow evidence integration", () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      GITHUB_WORKSPACE: process.cwd(),
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "example/krypto",
      GITHUB_RUN_ID: "731",
      GITHUB_RUN_ATTEMPT: "1",
      RESOLVED_SHA: DEV_SHA,
      PROOF_ARTIFACT_ID: "601",
      PROOF_ARTIFACT_DIGEST: "a".repeat(64),
      WEB_DIGEST_HEX: "1".repeat(64),
      OPS_DIGEST_HEX: "2".repeat(64),
    };
  });
  afterEach(() => { process.env = originalEnv; });

  function publisherFixture() {
    return {
      rest: {
        repos: {
          createDeployment: jest.fn(async () => ({ data: { id: 501 } })),
          createDeploymentStatus: jest.fn(async () => undefined),
          createCommitStatus: jest.fn(async () => undefined),
        },
      },
    };
  }

  it("publishes a pending authoritative attempt before any full environment mutation", async () => {
    expect(deployment.jobs["deploy-environment"].needs).toContain("begin-deployment-evidence");
    const github = publisherFixture();
    await script(deployment, "begin-deployment-evidence", "Publish pending authoritative development attempt")(
      github, { repo: { owner: "example", repo: "krypto" } }, {}, () => moduleUnderTest,
    );
    expect(github.rest.repos.createDeployment).toHaveBeenCalledWith(expect.objectContaining({
      ref: DEV_SHA, task: "dev-evidence", environment: "development", production_environment: false,
    }));
    expect(github.rest.repos.createDeploymentStatus).toHaveBeenCalledWith(expect.objectContaining({ state: "in_progress" }));
    expect(github.rest.repos.createCommitStatus).toHaveBeenCalledWith(expect.objectContaining({ state: "pending" }));
  });

  it.each([
    ["success", "skipped", "success"],
    ["failure", "success", "failure"],
    ["cancelled", "success", "failure"],
    ["skipped", "skipped", "failure"],
    ["success", "success", "failure"],
  ])("the real publisher maps verification %s / rollback %s to %s", async (verify, rollback, state) => {
    process.env.VERIFY_RESULT = verify;
    process.env.ROLLBACK_RESULT = rollback;
    const github = publisherFixture();
    await script(deployment, "publish-deployment-evidence", "Publish commit status and GitHub Deployment")(
      github, { repo: { owner: "example", repo: "krypto" } }, {}, () => moduleUnderTest,
    );
    expect(github.rest.repos.createCommitStatus).toHaveBeenCalledWith(expect.objectContaining({ state, sha: DEV_SHA }));
    expect(github.rest.repos.createDeploymentStatus).toHaveBeenCalledWith(expect.objectContaining({ state, auto_inactive: false }));
    expect(github.rest.repos.createDeployment).toHaveBeenCalledWith(expect.objectContaining({
      task: "dev-evidence",
      payload: expect.objectContaining({
        artifact: state === "success"
          ? { id: 601, name: `azure-deploy-dev-proof-${DEV_SHA}-a1`, digest: `sha256:${"a".repeat(64)}` }
          : null,
      }),
    }));
  });

  it("fails explicitly if GitHub did not create the authoritative Deployment", async () => {
    process.env.VERIFY_RESULT = "success";
    process.env.ROLLBACK_RESULT = "skipped";
    const github = publisherFixture();
    github.rest.repos.createDeployment.mockResolvedValue({ data: { id: 0 } });
    await expect(script(deployment, "publish-deployment-evidence", "Publish commit status and GitHub Deployment")(
      github, { repo: { owner: "example", repo: "krypto" } }, {}, () => moduleUnderTest,
    )).rejects.toThrow("Deployment was not created");
    expect(github.rest.repos.createCommitStatus).not.toHaveBeenCalled();
  });

  it("places complete proof validation and upload inside the existing rollback boundary", () => {
    const verify = deployment.jobs["verify-final-state"];
    expect(verify.needs).toEqual(expect.arrayContaining(["ops-validate", "validate-shadow", "observe-scheduled-execution"]));
    expect(verify.permissions?.actions).toBe("read");
    expect(verify.steps.map((step) => step.name)).toEqual(expect.arrayContaining([
      "Independently validate the complete immutable development report set",
      "Retain the verified development proof",
    ]));
    const rollback = deployment.jobs["rollback-disabled"];
    expect(rollback.needs).toContain("verify-final-state");
    expect(rollback.if).toContain("needs.verify-final-state.result == 'failure'");
    expect(rollback.if).toContain("needs.verify-final-state.result == 'cancelled'");
    expect(rollback.steps.map((step) => step.name)).toEqual(expect.arrayContaining([
      "Deploy and verify rollback to disabled/Manual",
      "Disable missing-success monitoring after rollback jobs are Manual",
    ]));
  });

  it.each(["success", "new-failure", "wrapper-success"])("runs the actual full-e2e terminal check against %s", async (scenario) => {
    process.env.CANARY_ISSUE = "42";
    process.env.REQUESTED_AT = "2026-08-20T20:00:00Z";
    const fixture = createDevEvidenceFixture();
    if (scenario === "new-failure") {
      fixture.deploymentStatuses.push({ ...fixture.deploymentStatuses[0], id: 99, state: "failure" });
    }
    if (scenario === "wrapper-success") fixture.deployments[0].task = "deploy";
    const github = {
      ...fixture.github,
      rest: {
        ...fixture.github.rest,
        issues: { get: jest.fn(async () => ({ data: { state: "closed", labels: ["factory:done"] } })) },
        search: { issuesAndPullRequests: jest.fn(async () => ({ data: { items: [{ number: 110, body: "Refs #42" }] } })) },
        pulls: {
          ...fixture.github.rest.pulls,
          get: jest.fn(async () => ({ data: { number: 110, merged_at: "2026-08-20T20:00:00Z", merge_commit_sha: DEV_SHA } })),
        },
        repos: {
          ...fixture.github.rest.repos,
          getContent: jest.fn(async () => ({ data: {
            type: "file",
            content: Buffer.from("run 731 2026-08-20T20:00:00Z").toString("base64"),
          } })),
        },
      },
    };
    const core = { info: jest.fn() };
    const result = script(canary, "full-cycle", "Wait for terminal dev-evidence state")(
      github, { repo: { owner: "example", repo: "krypto" } }, core, () => moduleUnderTest,
    );
    if (scenario === "success") {
      await expect(result).resolves.toBeUndefined();
      expect(core.info).toHaveBeenCalledWith(expect.stringContaining("immutable-development-evidence-verified"));
    } else {
      await expect(result).rejects.toThrow("lacks verified immutable development evidence");
      expect(core.info).not.toHaveBeenCalledWith(expect.stringContaining("completed through exact-SHA"));
    }
  });
});
