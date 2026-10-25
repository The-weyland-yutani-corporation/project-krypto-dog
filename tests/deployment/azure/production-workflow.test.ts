import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";
import { z } from "zod";
import { productionPromotionFixture } from "./production-promotion-fixture";

const root = path.resolve(__dirname, "../../..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const strings = z.record(z.string(), z.string());
const stepSchema = z.object({
  name: z.string(),
  id: z.string().optional(),
  if: z.string().optional(),
  run: z.string().optional(),
  env: strings.optional(),
  uses: z.string().optional(),
  with: z.record(z.string(), z.unknown()).optional(),
});
const workflowSchema = z.object({
  on: z.record(z.string(), z.unknown()),
  concurrency: z.object({
    group: z.string(),
    "cancel-in-progress": z.boolean(),
  }),
  jobs: z.record(z.string(), z.object({
    name: z.string(),
    needs: z.union([z.string(), z.array(z.string())]).optional(),
    if: z.string().optional(),
    environment: z.string().optional(),
    env: strings.optional(),
    outputs: strings.optional(),
    permissions: strings.optional(),
    "timeout-minutes": z.number().optional(),
    steps: z.array(stepSchema),
  })),
});
const workflow = workflowSchema.parse(parse(read(".github/workflows/azure-deploy-prod.yml")));
const development = workflowSchema.parse(parse(read(".github/workflows/azure-deploy-dev.yml")));

function job(id: string, source = workflow) {
  const value = source.jobs[id];
  if (!value) throw new Error(`Missing production job: ${id}`);
  return value;
}

function step(jobId: string, name: string, source = workflow) {
  const value = job(jobId, source).steps.find((candidate) => candidate.name === name);
  if (!value) throw new Error(`Missing production step: ${jobId}/${name}`);
  return value;
}

function run(jobId: string, name: string, source = workflow): string {
  const value = step(jobId, name, source).run;
  if (!value) throw new Error(`Missing production script: ${jobId}/${name}`);
  return value.replace(/\r\n/g, "\n");
}

function expectBefore(jobId: string, first: string, second: string, source = workflow) {
  const steps = job(jobId, source).steps;
  expect(steps.indexOf(step(jobId, first, source))).toBeLessThan(
    steps.indexOf(step(jobId, second, source)),
  );
}

describe("development-to-production handoff", () => {
  const evidence = jest.requireActual<{
    DEVELOPMENT_JOBS: Record<string, string>;
    DEVELOPMENT_PUBLISHER: string;
    DEVELOPMENT_RECEIPT_PUBLISHER: string;
    DEVELOPMENT_ROLLBACK: string;
  }>("../../../.github/scripts/azure/production-evidence.cjs");

  it("requires protected exact-source main and native push CI for every development path", () => {
    expect(development.on.workflow_run).toEqual({
      workflows: ["CI"], branches: ["main"], types: ["completed"],
    });
    const resolve = run("gate", "Resolve and format-validate the exact commit SHA to deploy", development);
    expect(resolve).toContain('"${GITHUB_REF}" != "refs/heads/main"');
    expect(resolve).toContain('"${validated}" != "${GITHUB_SHA}"');
    expect(resolve).toContain('"${validated}" != "${GITHUB_WORKFLOW_SHA}"');
    const verify = step("gate", "Verify exact main SHA has successful push CI", development);
    expect(verify.if).toBeUndefined();
    expect(verify.run).toContain("--ci-workflow ci.yml");
    const current = step("gate", "Reject superseded main before development admission", development);
    expect(current.with?.script).toContain("await assertCurrentMain(");
  });

  it("aligns every receipt assertion with an actual named development job and keeps publication read-only", () => {
    for (const [id, name] of Object.entries(evidence.DEVELOPMENT_JOBS)) {
      expect(job(id, development).name).toBe(name);
    }
    const publisher = job("publish-release-receipt", development);
    expect(publisher.name).toBe(evidence.DEVELOPMENT_RECEIPT_PUBLISHER);
    expect(publisher.needs).toEqual(Object.keys(evidence.DEVELOPMENT_JOBS));
    expect(publisher.permissions).toEqual({ contents: "read", actions: "read" });
    expect(publisher.environment).toBeUndefined();
    expect(publisher.if).toContain("always()");
    expect(publisher.if).toContain("needs.gate.outputs.deployment_stage == 'full'");
    expect(publisher.steps[0].with).toMatchObject({
      ref: "${{ github.sha }}", "persist-credentials": false, "sparse-checkout": ".github/scripts",
    });
    expect(publisher.steps.find((entry) => entry.uses === "actions/upload-artifact@v4")?.with).toMatchObject({
      name: "${{ steps.receipt.outputs.name }}", path: "development-receipt/receipt.json",
      "if-no-files-found": "error", "retention-days": 90,
    });
    expect(job("rollback-disabled", development).name).toBe(evidence.DEVELOPMENT_ROLLBACK);
    expect(job("publish-deployment-evidence", development).name).toBe(evidence.DEVELOPMENT_PUBLISHER);
  });

  it("binds publication to the final Azure readback and recovers when receipt publication fails", () => {
    const final = job("verify-final-state", development);
    for (const field of [
      "target_origin", "scheduled_execution_name", "scheduled_execution_start_time", "scheduled_execution_completed_time",
    ]) expect(final.outputs?.[field]).toBe(`\${{ steps.verify.outputs.${field} }}`);
    const script = run("verify-final-state", "Verify live state and immutable image binding", development);
    expect(script).toContain(".properties.latestReadyRevisionName == .properties.latestRevisionName");
    expect(script).toContain('.name == "APP_ORIGIN" and .value == $origin');
    expect(script).toContain('.name == "TARGET_BASE_URL" and .value == $origin');
    expect(script.indexOf('echo "scheduled_execution_completed_time='))
      .toBeGreaterThan(script.indexOf("(.properties.endTime | test("));
    const rollback = job("rollback-disabled", development);
    expect(rollback.needs).toContain("publish-release-receipt");
    expect(rollback.if).toContain("needs.publish-release-receipt.result == 'failure'");
    expect(rollback.if).toContain("needs.publish-release-receipt.result == 'cancelled'");
    expect(job("publish-deployment-evidence", development).needs).toEqual([
      "gate", "verify-final-state", "publish-release-receipt", "rollback-disabled",
    ]);
  });

  it("revalidates the admitted development run/attempt before production Azure access", () => {
    const admission = step("gate", "Admit current main and verified full development evidence");
    expect(admission.env).toMatchObject({
      RESOLVED_SHA: "${{ steps.resolve.outputs.sha }}",
      DEPLOYMENT_STAGE: "${{ steps.resolve.outputs.deployment_stage }}",
    });
    expect(admission.with?.script).toContain('process.env.DEPLOYMENT_STAGE === "full"');
    expect(admission.with?.script).toContain("await loadLatestDevelopmentReceipt({");
    expect(admission.with?.script).toContain("await assertProductionFactoryMode({");
    expect(admission.env).toMatchObject({
      TRIGGERED_DEVELOPMENT_RUN_ID: "${{ steps.resolve.outputs.development_run_id }}",
      TRIGGERED_DEVELOPMENT_RUN_ATTEMPT: "${{ steps.resolve.outputs.development_run_attempt }}",
    });
    expect(admission.with?.script).toContain("expectedRunId: Number(process.env.TRIGGERED_DEVELOPMENT_RUN_ID)");
    expect(admission.with?.script).toContain("expectedRunAttempt: Number(process.env.TRIGGERED_DEVELOPMENT_RUN_ATTEMPT)");
    expect(admission.with?.script).toContain("await assertCurrentMain(options)");
    expect(job("gate").outputs).toMatchObject({
      development_run_id: "${{ steps.development.outputs.run_id }}",
      development_run_attempt: "${{ steps.development.outputs.run_attempt }}",
      development_workflow_id: "${{ steps.development.outputs.workflow_id }}",
    });
    const check = step("force-disable-rollout", "Revalidate development admission before Azure access");
    expect(check.with?.script).toContain("expectedRunId: Number(process.env.DEVELOPMENT_RUN_ID)");
    expect(check.with?.script).toContain("expectedRunAttempt: Number(process.env.DEVELOPMENT_RUN_ATTEMPT)");
    expect(check.with?.script).toContain("await assertProductionFactoryMode({");
    const admissionScript = z.string().parse(check.with?.script);
    expect(admissionScript.indexOf("await assertProductionFactoryMode("))
      .toBeGreaterThan(admissionScript.indexOf("await loadLatestDevelopmentReceipt("));
    expect(job("force-disable-rollout").permissions?.actions).toBe("read");
    expect(job("force-disable-rollout").permissions?.issues).toBe("read");
    expect(job("gate").permissions?.issues).toBe("read");
    expectBefore("force-disable-rollout", check.name, "Azure login (OIDC)");
    expectBefore("force-disable-rollout", check.name, "Acquire the exact source release's owned cutover fence");
  });

  it("executes the actual development publisher without overwriting the same attempt", () => {
    const script = z.string().parse(
      step("publish-release-receipt", "Create the attempt-bound development receipt", development).with?.script,
    );
    const sha = "a".repeat(40);
    const results = Object.fromEntries(Object.keys(evidence.DEVELOPMENT_JOBS).map((id) => [
      id, { result: "success", outputs: {} as Record<string, string> },
    ]));
    results.gate.outputs = { sha, deployment_stage: "full" };
    results["deploy-environment"].outputs = {
      acr_login_server: "acrkryptodev.azurecr.io",
      evidence_container_url: "https://kryptodev.blob.core.windows.net/evidence",
    };
    results["build-images"].outputs = { web_digest_hex: "b".repeat(64), ops_digest_hex: "c".repeat(64) };
    results["validate-shadow"].outputs = {
      manual_hourly_execution_name: "manual-execution",
      manual_shadow_idempotency_key: "manual-shadow:run900-a2-manual-hourly",
      manual_shadow_started_after: "2026-10-22T00:10:00Z",
    };
    results["promote-schedule"].outputs.schedule_deployed_at = String(Date.parse("2026-10-22T00:20:00Z") / 1000);
    results["observe-scheduled-execution"].outputs.scheduled_execution_name = "observed-execution";
    results["verify-final-state"].outputs = {
      target_origin: "https://development.example.com",
      scheduled_execution_name: "observed-execution",
      scheduled_execution_start_time: "2026-10-22T01:00:05Z",
      scheduled_execution_completed_time: "2026-10-22T01:01:10Z",
    };
    const nativeRun = {
      id: 900, run_attempt: 2, workflow_id: 71, head_sha: sha, head_branch: "main",
      repository: { id: 456, full_name: "owner/project" }, head_repository: { id: 456 },
      path: ".github/workflows/azure-deploy-dev.yml", event: "workflow_run",
      actor: { id: 41898282 }, triggering_actor: { id: 41898282, login: "github-actions[bot]" },
    };
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "krypto-development-publisher-"));
    try {
      const execute = () => spawnSync(process.execPath, ["-e", `
        const NativeDate = Date;
        globalThis.Date = class extends NativeDate {
          constructor(value) { super(arguments.length ? value : "2026-10-22T01:59:00Z"); }
          static now() { return NativeDate.parse("2026-10-22T01:59:00Z"); }
        };
        const core = { setOutput: (key, value) => console.log(key + "=" + value), notice: () => {} };
        const context = { repo: { owner: "owner", repo: "project" } };
        const github = { rest: { actions: { getWorkflowRun: async () => ({ data: ${JSON.stringify(nativeRun)} }) } } };
        (async () => { ${script} })().catch(error => { console.error(error.message); process.exitCode = 1; });
      `], {
        cwd: directory, encoding: "utf8",
        env: {
          ...process.env, GITHUB_WORKSPACE: root, GITHUB_REPOSITORY: "owner/project",
          GITHUB_REPOSITORY_ID: "456", GITHUB_RUN_ID: "900", GITHUB_RUN_ATTEMPT: "2",
          GITHUB_SHA: sha, GITHUB_WORKFLOW_SHA: sha, GITHUB_REF: "refs/heads/main", RESOLVED_SHA: sha,
          GITHUB_WORKFLOW_REF: "owner/project/.github/workflows/azure-deploy-dev.yml@refs/heads/main",
          GITHUB_EVENT_NAME: "workflow_run", GITHUB_ACTOR_ID: "41898282",
          GITHUB_TRIGGERING_ACTOR: "github-actions[bot]", DEVELOPMENT_JOB_RESULTS: JSON.stringify(results),
        },
      });
      const first = execute();
      expect(first.stderr).toBe("");
      expect(first.status).toBe(0);
      expect(first.stdout).toContain(`name=development-release-${sha}-900-2`);
      expect(first.stdout).toContain("status=shadow");
      const artifact = path.join(directory, "development-receipt", "receipt.json");
      const original = fs.readFileSync(artifact, "utf8");
      expect(JSON.parse(original)).toMatchObject({
        status: "shadow", runId: 900, runAttempt: 2, workflowId: 71, actorId: 41898282, releaseSha: sha,
      });
      const repeated = execute();
      expect(repeated.status).not.toBe(0);
      expect(repeated.stderr).toContain("EEXIST");
      expect(fs.readFileSync(artifact, "utf8")).toBe(original);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  const statusScript = z.string().parse(
    step("publish-deployment-evidence", "Publish commit status and GitHub Deployment", development).with?.script,
  );
  const sha = "a".repeat(40);
  function publishStatus(overrides: NodeJS.ProcessEnv = {}, response: unknown = {
    id: 7, sha, environment: "development", production_environment: false,
  }) {
    const result = spawnSync(process.execPath, ["-e", `
      const calls = [];
      const context = { repo: { owner: "owner", repo: "project" } };
      const github = { rest: { repos: {
        createDeployment: async input => { calls.push({ method: "deployment", input }); return { data: JSON.parse(process.env.RESPONSE) }; },
        createDeploymentStatus: async input => { calls.push({ method: "deployment-status", input }); return { data: {} }; },
        createCommitStatus: async input => { calls.push({ method: "commit-status", input }); return { data: {} }; },
      } } };
      (async () => { ${statusScript} })()
        .catch(error => { console.error(error.message); process.exitCode = 1; })
        .finally(() => console.log(JSON.stringify(calls)));
    `], {
      cwd: root, encoding: "utf8",
      env: {
        ...process.env, RESOLVED_SHA: sha, VERIFY_RESULT: "success", RECEIPT_RESULT: "success",
        RECEIPT_STATUS: "shadow", ROLLBACK_RESULT: "skipped", GITHUB_SERVER_URL: "https://github.com",
        GITHUB_REPOSITORY: "owner/project", GITHUB_RUN_ID: "900", RESPONSE: JSON.stringify(response),
        ...overrides,
      },
    });
    return {
      ...result,
      calls: z.array(z.object({ method: z.string(), input: z.record(z.string(), z.unknown()) })).parse(JSON.parse(result.stdout)),
    };
  }

  it("creates the exact GitHub Deployment before reporting successful commit status", () => {
    const result = publishStatus();
    expect(result.status).toBe(0);
    expect(result.calls.map((call) => call.method)).toEqual(["deployment", "deployment-status", "commit-status"]);
    expect(result.calls[0].input).toMatchObject({ ref: sha, environment: "development", production_environment: false });
    expect(result.calls[1].input).toMatchObject({ deployment_id: 7, state: "success" });
    expect(result.calls[2].input).toMatchObject({ sha, state: "success", context: "Dev deployment evidence" });
  });

  it.each([
    { VERIFY_RESULT: "failure" }, { RECEIPT_RESULT: "failure" }, { RECEIPT_STATUS: "failed" },
    { ROLLBACK_RESULT: "success" }, { RECEIPT_RESULT: "skipped" },
  ])("publishes failure instead of green partial evidence %j", (overrides) => {
    const result = publishStatus(overrides);
    expect(result.status).toBe(0);
    expect(result.calls[1].input.state).toBe("failure");
    expect(result.calls[2].input.state).toBe("failure");
  });

  it.each([
    null, {}, { id: 0 }, { id: "7" },
    { id: 7, sha: "b".repeat(40), environment: "development", production_environment: false },
    { id: 7, sha, environment: "production", production_environment: false },
    { id: 7, sha, environment: "development", production_environment: true },
  ])("does not publish success for an invalid GitHub Deployment %j", (response) => {
    const result = publishStatus({}, response);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("did not create the exact-SHA");
    expect(result.calls.map((call) => call.method)).toEqual(["deployment"]);
  });
});

describe("production cutover workflow", () => {
  it("publishes attempt-bound release evidence without Azure credentials, including partial failure and deferral", () => {
    const publisher = job("publish-release-receipt");
    expect(publisher.needs).toEqual([
      "gate", "force-disable-rollout", "deploy-environment", "build-images", "deploy-release",
      "migrate-backup", "release-cutover-fence", "target-smoke", "verify-final-state",
    ]);
    expect(publisher.if).toContain("always()");
    expect(publisher.if).toContain("needs.gate.result == 'success'");
    expect(publisher.if).toContain("needs.gate.outputs.deployment_stage == 'full'");
    expect(publisher.permissions).toEqual({ contents: "read" });
    expect(publisher.environment).toBeUndefined();
    expect(publisher.steps[0].with).toMatchObject({
      ref: "${{ github.sha }}", "persist-credentials": false, "sparse-checkout": ".github/scripts",
    });
    const upload = publisher.steps.find((entry) => entry.uses === "actions/upload-artifact@v4");
    expect(upload?.with).toMatchObject({
      name: "${{ steps.receipt.outputs.name }}", path: "production-receipt/receipt.json",
      "if-no-files-found": "error", "retention-days": 90,
    });
    const backup = run("migrate-backup", "Create and restore-verify a fresh baseline backup (new release)");
    expect(backup.indexOf("validate-report.mjs")).toBeLessThan(backup.indexOf('echo "job_execution_id='));
    expect(job("migrate-backup").outputs?.job_execution_id)
      .toBe("${{ steps.baseline_backup.outputs.job_execution_id }}");
    expect(job("verify-final-state").outputs?.target_origin).toBe("${{ steps.verify.outputs.target_origin }}");
  });

  it("executes the real publisher and refuses to overwrite the same attempt's receipt", () => {
    const publisher = job("publish-release-receipt");
    const script = z.string().parse(step("publish-release-receipt", "Create the attempt-bound production receipt").with?.script);
    const sha = "a".repeat(40);
    const jobs = Object.fromEntries(z.array(z.string()).parse(publisher.needs).map((id) => [
      id, { result: "success", outputs: {} as Record<string, string> },
    ]));
    jobs.gate.outputs = {
      sha, deployment_stage: "full",
      development_run_id: "100", development_run_attempt: "1", development_workflow_id: "71",
    };
    jobs["force-disable-rollout"].outputs.existing_release = "false";
    jobs["release-cutover-fence"].outputs.status = "fresh";
    jobs["deploy-environment"].outputs = {
      acr_login_server: "acrkryptoprod.azurecr.io",
      evidence_container_url: "https://kryptoprod.blob.core.windows.net/evidence",
    };
    jobs["build-images"].outputs = { web_digest_hex: "b".repeat(64), ops_digest_hex: "c".repeat(64) };
    jobs["verify-final-state"].outputs.target_origin = "https://production.example.com";
    jobs["migrate-backup"].outputs.job_execution_id = "run123-a1-baseline";
    jobs["target-smoke"].outputs.job_execution_id = "run123-a1-smoke";
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "krypto-release-publisher-"));
    try {
      const execute = () => spawnSync(process.execPath, ["-e", `
        const core = { setOutput: (key, value) => console.log(key + "=" + value), notice: () => {} };
        ${script}
      `], {
        cwd: directory, encoding: "utf8",
        env: {
          ...process.env, GITHUB_WORKSPACE: root, GITHUB_REPOSITORY: "owner/project",
          GITHUB_REPOSITORY_ID: "456", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1",
          GITHUB_SHA: sha, GITHUB_REF: "refs/heads/main", RESOLVED_SHA: sha,
          RELEASE_JOB_RESULTS: JSON.stringify(jobs),
        },
      });
      const first = execute();
      expect(first.status).toBe(0);
      expect(first.stdout).toContain(`name=production-release-${sha}-123-1`);
      const artifact = path.join(directory, "production-receipt", "receipt.json");
      const original = fs.readFileSync(artifact, "utf8");
      expect(JSON.parse(original)).toMatchObject({ status: "disabled", runId: 123, runAttempt: 1, releaseSha: sha });
      const repeated = execute();
      expect(repeated.status).not.toBe(0);
      expect(repeated.stderr).toContain("EEXIST");
      expect(fs.readFileSync(artifact, "utf8")).toBe(original);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps protected main admission and successful push CI for both stages", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_run", "workflow_dispatch"]);
    expect(workflow.on.workflow_run).toEqual({
      workflows: ["Azure deploy dev"], branches: ["main"], types: ["completed"],
    });
    expect(workflow.concurrency).toEqual({
      group: "azure-production-mutation",
      "cancel-in-progress": false,
    });
    const resolve = step("gate", "Resolve and format-validate the exact commit SHA to deploy");
    expect(resolve.with?.script).toContain("resolveProductionInvocation(process.env, context.payload)");
    expect(resolve.with?.script).toContain("core.setOutput(name, value)");
    expect(job("gate").steps[0].with).toMatchObject({
      ref: "${{ github.workflow_sha }}", "persist-credentials": true, "fetch-depth": 0,
    });
    const verify = step("gate", "Verify exact main SHA has successful push CI");
    expect(verify.if).toBeUndefined();
    expect(verify.run).toContain("--branch main");
    expect(verify.run).toContain("--ci-workflow ci.yml");
    expect(verify.env?.RESOLVED_SHA).toBe("${{ steps.resolve.outputs.sha }}");
  });

  it.each(["workflow_dispatch", "workflow_run"])("executes the real %s source resolver", (eventName) => {
    const script = z.string().parse(
      step("gate", "Resolve and format-validate the exact commit SHA to deploy").with?.script,
    );
    const sha = "a".repeat(40);
    const event = {
      action: "completed", workflow_run: {
        id: 900, run_attempt: 2, head_sha: sha, head_branch: "main", status: "completed", conclusion: "success",
      },
    };
    const execute = (workflowSha: string) => spawnSync(process.execPath, ["-e", `
      const context = { payload: JSON.parse(process.env.TEST_EVENT) };
      const outputs = {};
      const core = { setOutput: (name, value) => { outputs[name] = value; } };
      (async () => {
        ${script}
        console.log(JSON.stringify(outputs));
      })().catch(error => { console.error(error.message); process.exitCode = 1; });
    `], {
      cwd: root, encoding: "utf8",
      env: {
        ...process.env, GITHUB_WORKSPACE: root, GITHUB_REPOSITORY: "owner/project",
        GITHUB_REF: "refs/heads/main", GITHUB_SHA: sha, GITHUB_WORKFLOW_SHA: workflowSha,
        GITHUB_WORKFLOW_REF: "owner/project/.github/workflows/azure-deploy-prod.yml@refs/heads/main",
        GITHUB_EVENT_NAME: eventName, INPUT_COMMIT_SHA: sha, INPUT_DEPLOYMENT_STAGE: "foundation",
        TEST_EVENT: JSON.stringify(event),
      },
    });
    const result = execute(sha);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual(eventName === "workflow_run" ? {
      sha, deployment_stage: "full", promotion_mode: "continuous",
      development_run_id: 900, development_run_attempt: 2,
    } : { sha, deployment_stage: "foundation", promotion_mode: "disabled" });
    const wrongSource = execute("b".repeat(40));
    expect(wrongSource.status).not.toBe(0);
    expect(wrongSource.stdout).toBe("");
    expect(wrongSource.stderr).toContain("exact release source");
  });

  it("rejects foundation on an existing release and never treats partial inventory as fresh", () => {
    const detect = run("force-disable-rollout", "Detect a complete existing release or a genuinely fresh environment");
    expect(detect).toContain('inventory="$(bash .github/scripts/azure/read-production-inventory.sh)"');
    expect(detect).toContain('"${existing}" = true ] && [ "${DEPLOYMENT_STAGE}" = foundation');
    expect(detect).toMatch(/Foundation is for a fresh environment only[\s\S]*exit 1/);
    expect(detect).toContain('echo "existing_release=${existing}"');
    expect(detect).toContain("'.postgresExists | tostring'");
    expect(detect).toContain("'.kind'");
    expect(detect).toContain("missing workloads do not authorize database initialization");
    expect(detect).not.toContain('"${present}"');
    expect(run("force-disable-rollout", "Resolve the currently-deployed release SHA and image digest"))
      .toContain('git merge-base --is-ancestor "${current_sha}" "${RESOLVED_SHA}"');
  });

  it("admits the exact source before disabling any healthy execution path", () => {
    const acquire = "Acquire the exact source release's owned cutover fence";
    const disable = "Force rollout.bicep to disabled/Manual before touching infrastructure";
    expectBefore("force-disable-rollout", acquire, disable);
    const admission = run("force-disable-rollout", acquire);
    expect(admission).toContain('owner="$(azure_deployment_fence_owner)"');
    expect(admission).not.toContain("randomUUID");
    expect(admission).toContain('--source-release-sha "${CURRENT_SHA}"');
    expect(admission).toContain('--candidate-release-sha "${RESOLVED_SHA}"');
    expect(admission).toContain('--source-image-digest "sha256:${CURRENT_WEB_DIGEST_HEX}"');
    expect(admission).toContain('--target-origin "${TARGET_ORIGIN}"');
    expect(admission).toContain('--job-release-sha "${CURRENT_SHA}"');
    expect(admission).toContain('"${status}" -eq 75');
    expect(admission).toContain('echo "status=deferred"');
    expect(admission).toContain('elif [ "${status}" -eq 0 ]');
    expect(admission).toContain('echo "status=admitted"');
    for (const name of [
      disable,
      "Disable missing-success monitoring after prod jobs are Manual",
      "Verify old execution paths are quiescent while the fence is held",
    ]) {
      expect(step("force-disable-rollout", name).if)
        .toBe("steps.admission.outputs.status == 'admitted'");
    }
    expect(job("backup-current-release").if)
      .toContain("needs.force-disable-rollout.outputs.admission_status == 'admitted'");
  });

  it("allows skipped backup only for an explicitly fresh environment", () => {
    for (const id of ["deploy-environment", "deploy-release"]) {
      const condition = job(id).if?.replace(/\s+/g, " ");
      expect(condition).toContain("needs.force-disable-rollout.result == 'success'");
      expect(condition).toContain(
        "(needs.force-disable-rollout.outputs.existing_release == 'false' && needs.backup-current-release.result == 'skipped')",
      );
      expect(condition).toContain(
        "(needs.force-disable-rollout.outputs.existing_release == 'true' && needs.backup-current-release.result == 'success')",
      );
    }
  });

  it.each([
    ["Force rollout.bicep to disabled/Manual before touching infrastructure", "check-disable"],
    ["Disable missing-success monitoring after prod jobs are Manual", "check-monitor"],
  ])("revalidates the admitted source immediately before %s", (name, stage) => {
    const mutation = step("force-disable-rollout", name);
    expect(mutation.env?.CUTOVER_BINDING_JSON).toBe("${{ steps.admission.outputs.binding }}");
    const script = run("force-disable-rollout", name);
    const verify = script.indexOf(`revalidate-deployment-fence.sh source ${stage}`);
    expect(verify).toBeGreaterThan(0);
    expect(verify).toBeLessThan(script.indexOf("az deployment group create"));
  });

  it.each([
    ["backup-current-release", "source", "check-backup", "Run preflight on the current release"],
    ["deploy-environment", "source", "check-env", "Deploy infra/environment.bicep"],
    ["build-images", "source", "check-images", "Build web image and resolve digest"],
    ["deploy-release", "source", "check-release", "Deploy infra/release.bicep"],
    ["migrate-backup", "candidate", "check-migrate", "Run migrate-init (new release)"],
  ])("revalidates the actual owned fence before %s mutation", (id, image, stage, mutation) => {
    const current = job(id);
    expect(current.needs).toEqual(expect.arrayContaining(["gate", "force-disable-rollout"]));
    expect(current.env?.CUTOVER_BINDING_JSON)
      .toBe("${{ toJSON(needs.force-disable-rollout.outputs) }}");
    const verification = current.steps.find((candidate) =>
      candidate.run?.includes(`revalidate-deployment-fence.sh ${image} ${stage}`),
    );
    expect(verification).toBeDefined();
    if (!verification) throw new Error(`Missing fence verification: ${id}`);
    expect(verification.if).toBeUndefined();
    expectBefore(id, verification.name, mutation);
  });

  it("keeps the trusted source binding intact across job boundaries", () => {
    expect(job("force-disable-rollout").outputs).toMatchObject({
      candidate_sha: "${{ needs.gate.outputs.sha }}",
      current_sha: "${{ steps.current.outputs.sha }}",
      current_digest: "${{ steps.current.outputs.digest }}",
      target_origin: "${{ steps.live.outputs.target_origin }}",
      fence_owner: "${{ steps.admission.outputs.owner }}",
      admission_status: "${{ steps.admission.outputs.status }}",
    });
    const release = run("release-cutover-fence", "Verify the new disabled release before releasing its cutover fence");
    expect(release.indexOf("verify-disabled-rollout.sh")).toBeLessThan(release.indexOf("--action release"));
    expect(release).toContain('--owner "${FENCE_OWNER}"');
    expect(release).toContain('--job-release-sha "${RESOLVED_SHA}"');
    expect(job("release-cutover-fence").needs).toContain("migrate-backup");
    expect(job("release-cutover-fence").if).toContain("needs.migrate-backup.result == 'success'");
    expect(job("target-smoke").needs).toContain("release-cutover-fence");
    expect(job("target-smoke").if).toContain("needs.release-cutover-fence.result == 'success'");
    expect(job("target-smoke").if).toContain("needs.release-cutover-fence.outputs.status == 'released'");
    expect(job("target-smoke").if).toContain("needs.release-cutover-fence.outputs.status == 'fresh'");
    expect(job("verify-final-state").needs).toContain("target-smoke");
    expect(job("verify-final-state").if).toContain("needs.target-smoke.result == 'success'");
  });

  it("prepares trusted attestation dependencies before Azure login and never publishes the bearer proof", () => {
    const releaseJob = job("release-cutover-fence");
    expect(releaseJob.steps[0].with?.["persist-credentials"]).toBe(false);
    expect(step("release-cutover-fence", "Set up the supported Node runtime for cutover attestation").with?.["node-version-file"])
      .toBe(".nvmrc");
    expect(run("release-cutover-fence", "Install locked attestation dependencies without lifecycle scripts"))
      .toBe("npm ci --ignore-scripts --no-audit --no-fund");
    expectBefore("release-cutover-fence",
      "Install locked attestation dependencies without lifecycle scripts", "Azure login (OIDC)");
    expect(releaseJob.env?.AZURE_SUBSCRIPTION_ID).toBe("${{ vars.AZURE_SUBSCRIPTION_ID }}");
    const script = run("release-cutover-fence", "Verify the new disabled release before releasing its cutover fence");
    expect(script.indexOf("attest-cutover-state.ts")).toBeLessThan(script.indexOf("--action release"));
    expect(script).toContain('--runtime-release-sha "${RESOLVED_SHA}"');
    expect(script).toContain('--workflow-observation-proof "${proof_dir}/proof.json"');
    expect(script).toContain('--workflow-observation-digest "${observation_digest}"');
    expect(script).toContain('mktemp -d "${RUNNER_TEMP}/krypto-cutover-proof.XXXXXX"');
    expect(script).toContain('rm -f "${proof_dir}/proof.json" "${proof_dir}/receipt.json"');
    expect(script).toContain("trap cleanup EXIT");
    const upload = releaseJob.steps.find((entry) => entry.uses === "actions/upload-artifact@v4");
    expect(upload?.with?.path).toBe("evidence/");
  });

  it("retries release and smoke without reacquiring or requiring a consumed owner", () => {
    for (const id of ["release-cutover-fence", "target-smoke"]) {
      const scripts = job(id).steps.map((current) => current.run ?? "").join("\n");
      expect(scripts).not.toMatch(/revalidate-deployment-fence|--action (acquire|verify)|--operation migrate-init/);
    }
    expect(job("target-smoke").env).not.toHaveProperty("CUTOVER_BINDING_JSON");
    expectBefore("target-smoke",
      "Recheck the disabled candidate before every smoke attempt",
      "Run target-smoke (new release)");
  });

  it("cannot turn a foundation-only run into image publication or release work", () => {
    for (const id of ["build-images", "deploy-release", "migrate-backup", "release-cutover-fence", "target-smoke", "verify-final-state"]) {
      expect(job(id).if).toContain("needs.gate.outputs.deployment_stage == 'full'");
    }
    expect(run("verify-final-state", "Verify the live disabled release and immutable image binding"))
      .toContain('.properties.configuration.triggerType == "Manual"');
    expect(read(".github/workflows/azure-deploy-prod.yml"))
      .not.toMatch(/--set-string-param rolloutMode=(paper|shadow)/);
  });
});

function createRecoveryFixture(options: {
  failReleaseOnce?: boolean;
  failSmokeOnce?: boolean;
  failAttestationOnce?: boolean;
  quiescent?: boolean;
  fence?: "held" | "released";
} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "krypto-cutover-retry-"));
  const scripts = path.join(directory, ".github", "scripts", "azure");
  fs.mkdirSync(path.join(scripts, "lib"), { recursive: true });
  fs.copyFileSync(
    path.join(root, ".github", "scripts", "azure", "lib", "common.sh"),
    path.join(scripts, "lib", "common.sh"),
  );
  fs.writeFileSync(path.join(directory, "state.json"), JSON.stringify({
    fence: "held", approved: false, events: [], quiescent: true, ...options,
  }));
  fs.writeFileSync(path.join(scripts, "fixture.cjs"), `
const assert = require("node:assert/strict");
const fs = require("node:fs");
const state = JSON.parse(fs.readFileSync("state.json", "utf8"));
const [command, ...args] = process.argv.slice(2);
const argument = (name) => args[args.indexOf(name) + 1];
let failed = false;
switch (command) {
  case "revalidate-deployment-fence.sh":
    state.events.push("verify");
    fs.writeFileSync("state.json", JSON.stringify(state));
    assert.equal(state.fence, "held");
    break;
  case "verify-disabled-rollout.sh":
    state.events.push("quiescence");
    failed = state.quiescent !== true;
    break;
  case "attest-cutover-state.ts":
    assert.equal(argument("--owner"), process.env.FENCE_OWNER);
    assert.equal(argument("--source-release-sha"), process.env.CURRENT_SHA);
    assert.equal(argument("--candidate-release-sha"), process.env.RESOLVED_SHA);
    assert.equal(argument("--runtime-release-sha"), process.env.RESOLVED_SHA);
    assert.equal(argument("--source-image-digest"), "sha256:" + process.env.CURRENT_WEB_DIGEST_HEX);
    assert.equal(argument("--ops-job"), process.env.ACTIVATION_CHECK_JOB_NAME);
    state.events.push("attest");
    failed = state.failAttestationOnce === true;
    state.failAttestationOnce = false;
    if (!failed) {
      fs.writeFileSync(argument("--proof-output"), JSON.stringify({
        invocation: argument("--job-execution-id"), token: "private-fixture-proof",
      }), { flag: "wx", mode: 0o600 });
      fs.writeFileSync(argument("--receipt-output"), JSON.stringify({ observationDigest: "f".repeat(64) }), { flag: "wx" });
    }
    break;
  case "run-deployment-admission.sh":
    assert.equal(argument("--action"), "release");
    assert.equal(argument("--owner"), process.env.FENCE_OWNER);
    assert.equal(argument("--source-release-sha"), process.env.CURRENT_SHA);
    assert.equal(argument("--candidate-release-sha"), process.env.RESOLVED_SHA);
    assert.equal(argument("--job-release-sha"), process.env.RESOLVED_SHA);
    assert.equal(argument("--source-image-digest"), "sha256:" + process.env.CURRENT_WEB_DIGEST_HEX);
    assert.equal(argument("--target-origin"), process.env.TARGET_ORIGIN);
    assert.equal(argument("--workflow-observation-digest"), "f".repeat(64));
    assert.equal(JSON.parse(fs.readFileSync(argument("--workflow-observation-proof"), "utf8")).invocation,
      argument("--job-execution-id"));
    assert(!args.some((value) => value.includes("private-fixture-proof")));
    state.events.push("release");
    state.fence = "released";
    failed = state.failReleaseOnce === true;
    state.failReleaseOnce = false;
    break;
  case "run-ops-job.sh": {
    const operation = argument("--job-name");
    state.events.push(operation);
    assert.equal(state.fence, operation === "target-smoke" ? "released" : "held");
    failed = operation === "target-smoke" && state.failSmokeOnce === true;
    if (failed) state.failSmokeOnce = false;
    break;
  }
  case "download-evidence.sh":
    break;
  case "validate-report.mjs":
    if (argument("--operation") === "target-smoke") state.approved = true;
    break;
  default:
    throw new Error("Unexpected fixture operation: " + command);
}
fs.writeFileSync("state.json", JSON.stringify(state));
if (failed) {
  console.error("Injected stage failure before completion evidence.");
  process.exitCode = 1;
}
`);
  for (const name of [
    "revalidate-deployment-fence.sh", "verify-disabled-rollout.sh",
    "run-deployment-admission.sh", "run-ops-job.sh", "download-evidence.sh",
  ]) {
    fs.writeFileSync(path.join(scripts, name),
      `#!/usr/bin/env bash\nnode .github/scripts/azure/fixture.cjs ${name} "$@"\n`,
      { mode: 0o755 });
  }
  fs.writeFileSync(path.join(scripts, "validate-report.mjs"),
    'process.argv.splice(2, 0, "validate-report.mjs");\nawait import("./fixture.cjs");\n');
  const environment = {
    ...process.env,
    GITHUB_REPOSITORY_ID: "456",
    GITHUB_RUN_ID: "123",
    GITHUB_OUTPUT: "outputs.txt",
    RUNNER_TEMP: ".",
    EXISTING_RELEASE: "true",
    ADMISSION_STATUS: "admitted",
    FENCE_OWNER: "34aa399d-f243-5b32-832f-e399e1f22b74",
    CURRENT_SHA: "a".repeat(40),
    RESOLVED_SHA: "b".repeat(40),
    CURRENT_WEB_DIGEST_HEX: "c".repeat(64),
    WEB_DIGEST_HEX: "d".repeat(64),
    TARGET_ORIGIN: "https://cutover.example.com",
    PROD_RESOURCE_GROUP_NAME: "rg-cutover-fixture",
    WEB_APP_NAME: "cutover-web",
    PROD_HOURLY_JOB_NAME: "cutover-hourly",
    PROD_DAILY_JOB_NAME: "cutover-daily",
    ACTIVATION_CHECK_JOB_NAME: "cutover-activation",
    MIGRATE_INIT_JOB_NAME: "migrate-init",
    VERIFIED_BACKUP_JOB_NAME_NEW: "verified-backup",
    TARGET_SMOKE_JOB_NAME_NEW: "target-smoke",
    EVIDENCE_CONTAINER_URL: "https://cutoverfixture.blob.core.windows.net/evidence",
    ACR_LOGIN_SERVER: "cutoverfixture.azurecr.io",
    LIVE_ACR_LOGIN_SERVER: "cutoverfixture.azurecr.io",
    OPS_JOB_TIMEOUT_SECONDS: "600",
  };
  return {
    execute(jobId: string, name: string, attempt = 1, overrides: Record<string, string> = {}) {
      return spawnSync("bash", ["-s"], {
        cwd: directory,
        encoding: "utf8",
        env: { ...environment, GITHUB_RUN_ATTEMPT: String(attempt), ...overrides },
        input: `
node() {
  if [ "$1" = "--import" ] && [ "$2" = "tsx" ] && [ "$3" = "scripts/azure/attest-cutover-state.ts" ]; then
    shift 3
    command node .github/scripts/azure/fixture.cjs attest-cutover-state.ts "$@"
  else
    command node "$@"
  fi
}
export -f node
az() {
  if [ "$1" = "containerapp" ] && [ "$2" = "show" ]; then
    printf '%s' "\${LIVE_ACR_LOGIN_SERVER}/krypto-web@sha256:\${CURRENT_WEB_DIGEST_HEX}"
    return 0
  fi
  echo "FORBIDDEN_LIVE_AZURE_MUTATION" >&2
  return 99
}
export -f az
${run(jobId, name)}
`,
      });
    },
    state: () => z.object({
      fence: z.string(), approved: z.boolean(), events: z.array(z.string()),
    }).parse(JSON.parse(fs.readFileSync(path.join(directory, "state.json"), "utf8"))),
    outputs: () => fs.readFileSync(path.join(directory, "outputs.txt"), "utf8"),
    privateDirectories: () => fs.readdirSync(directory).filter((name) => name.startsWith("krypto-cutover-proof.")),
    dispose: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

describe("cutover recovery executes the real workflow scripts", () => {
  const release = "Verify the new disabled release before releasing its cutover fence";
  const quiescence = "Recheck the disabled candidate before every smoke attempt";
  const smoke = "Run target-smoke (new release)";

  it("retries smoke before approval without replaying migration or reacquiring the released fence", () => {
    const fixture = createRecoveryFixture({ failSmokeOnce: true });
    try {
      for (const name of [
        "Revalidate cutover ownership before migration",
        "Run migrate-init (new release)",
        "Create and restore-verify a fresh baseline backup (new release)",
      ]) {
        expect(fixture.execute("migrate-backup", name).status).toBe(0);
      }
      expect(fixture.execute("release-cutover-fence", release).status).toBe(0);
      expect(fixture.execute("target-smoke", quiescence).status).toBe(0);
      expect(fixture.execute("target-smoke", smoke).status).toBe(1);
      expect(fixture.state()).toMatchObject({ fence: "released", approved: false });
      expect(fixture.execute("target-smoke", quiescence, 2).status).toBe(0);
      expect(fixture.execute("target-smoke", smoke, 2).status).toBe(0);
      expect(fixture.state()).toEqual({
        fence: "released",
        approved: true,
        events: ["verify", "migrate-init", "verified-backup", "quiescence",
          "attest", "release", "quiescence", "target-smoke", "quiescence", "target-smoke"],
      });
      expect(fixture.privateDirectories()).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  it("recovers an ambiguous release response using the same completed owner, not held-fence verification", () => {
    const fixture = createRecoveryFixture({ failReleaseOnce: true });
    try {
      expect(fixture.execute("release-cutover-fence", release).status).toBe(1);
      expect(fixture.state()).toMatchObject({ fence: "released", approved: false });
      expect(fixture.execute("release-cutover-fence", release, 2).status).toBe(0);
      expect(fixture.state().events).toEqual(["quiescence", "attest", "release", "quiescence", "attest", "release"]);
      expect(fixture.privateDirectories()).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  it("fails closed when fresh attestation fails and cleans private scratch on both attempts", () => {
    const fixture = createRecoveryFixture({ failAttestationOnce: true });
    try {
      expect(fixture.execute("release-cutover-fence", release).status).toBe(1);
      expect(fixture.state()).toMatchObject({ fence: "held", approved: false, events: ["quiescence", "attest"] });
      expect(fixture.privateDirectories()).toEqual([]);
      expect(fixture.execute("release-cutover-fence", release, 2).status).toBe(0);
      expect(fixture.state().events).toEqual(["quiescence", "attest", "quiescence", "attest", "release"]);
      expect(fixture.privateDirectories()).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  it("does not release or smoke a candidate whose live paths are not quiescent", () => {
    const fixture = createRecoveryFixture({ quiescent: false });
    try {
      expect(fixture.execute("release-cutover-fence", release).status).toBe(1);
      expect(fixture.execute("target-smoke", quiescence).status).toBe(1);
      expect(fixture.state()).toEqual({
        fence: "held", approved: false, events: ["quiescence", "quiescence"],
      });
    } finally {
      fixture.dispose();
    }
  });

  it("records a fresh checkpoint only after quiescence, without inventing an owner", () => {
    const fixture = createRecoveryFixture();
    try {
      expect(fixture.execute("release-cutover-fence", release, 1, {
        EXISTING_RELEASE: "false",
        ADMISSION_STATUS: "",
        FENCE_OWNER: "",
      }).status).toBe(0);
      expect(fixture.outputs()).toBe("status=fresh\n");
      expect(fixture.state().events).toEqual(["quiescence"]);
    } finally {
      fixture.dispose();
    }
  });

  it.each([
    ["", "admitted"],
    ["unknown", "admitted"],
    ["TRUE", "admitted"],
    ["true", "deferred"],
  ])("does not reinterpret inventory %j / admission %j as fresh", (existing, status) => {
    const fixture = createRecoveryFixture();
    try {
      expect(fixture.execute("release-cutover-fence", release, 1, {
        EXISTING_RELEASE: existing, ADMISSION_STATUS: status,
      }).status).toBe(1);
      expect(fixture.state().events).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  it.each([
    "Force rollout.bicep to disabled/Manual before touching infrastructure",
    "Disable missing-success monitoring after prod jobs are Manual",
  ])("blocks %s when ownership verification fails", (name) => {
    const fixture = createRecoveryFixture({ fence: "released" });
    try {
      const result = fixture.execute("force-disable-rollout", name);
      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain("FORBIDDEN_LIVE_AZURE_MUTATION");
      expect(fixture.state().events).toEqual(["verify"]);
    } finally {
      fixture.dispose();
    }
  });
});

describe("credential-preserving production updates", () => {
  const render = run("deploy-environment", "Render environment.prod.bicepparam");
  const invocation = render.indexOf("node .github/scripts/azure/render-bicepparam.mjs");

  it("selects credentials before both preview and deployment, without changing the renderer", () => {
    expect(invocation).toBeGreaterThan(0);
    expect(render).toContain('--set-string-param postgresCredentialMode="${credential_mode}"');
    expect(render).toContain('--set-string-param bootstrapDatabaseAccessMode="${access_mode}"');
    expect(step("deploy-environment", "Render environment.prod.bicepparam").env?.FOUNDATION_KIND)
      .toBe("${{ needs.force-disable-rollout.outputs.foundation_kind }}");
    expectBefore("deploy-environment", "Render environment.prod.bicepparam", "What-if infra/environment.bicep");
    for (const name of ["What-if infra/environment.bicep", "Deploy infra/environment.bicep"]) {
      expect(run("deploy-environment", name)).toContain("--parameters /tmp/environment.prod.resolved.bicepparam");
    }
  });

  it.each([
    ["existing", "preserve/none"],
    ["inspect", "preserve/none"],
    ["new", "initialize/initialize"],
  ])("executes the real credential selector for inventory %s", (kind, expected) => {
    const result = spawnSync("bash", ["-s"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, FOUNDATION_KIND: kind },
      input: `${render.slice(0, invocation)}\nprintf '%s/%s' "\${credential_mode}" "\${access_mode}"\n`,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(expected);
  });

  it.each(["", "unknown", "TRUE", "deferred", "true\nfalse"])(
    "rejects ambiguous inventory %j instead of initializing credentials",
    (kind) => {
      const result = spawnSync("bash", ["-s"], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, FOUNDATION_KIND: kind },
        input: render.slice(0, invocation),
      });
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("require an explicit database/foundation inventory result");
    },
  );

  it.each([["true", "update"], ["false", "preserve"]])(
    "keeps the inspected binding through first-release creation for existing=%s",
    (existing, expected) => {
      const release = run("deploy-release", "Render release.prod.bicepparam");
      const selection = release.slice(0, release.indexOf("node .github/scripts/azure/render-bicepparam.mjs"));
      const result = spawnSync("bash", ["-s"], {
        cwd: root, encoding: "utf8", env: { ...process.env, EXISTING_RELEASE: existing },
        input: `${selection}\nprintf '%s' "\${direct_url_mode}"\n`,
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(expected);
      expect(release).toContain('--set-string-param directUrlBindingMode="${direct_url_mode}"');
    },
  );

  it("wires bounded inspection before every fresh database mutation and preserves its evidence", () => {
    const helper = fs.readFileSync(path.join(root, ".github/scripts/azure/revalidate-deployment-fence.sh"), "utf8");
    expect(helper).toContain('node "${script_dir}/database-bootstrap.cjs" initial-credentials');
    expect(helper.match(/run-database-inspection.sh" temporary/g)).toHaveLength(2);
    expect(helper).toContain('run-database-inspection.sh" candidate "${stage}"');
    expectBefore("deploy-environment", "Build the inspection-only image for an existing empty foundation",
      "Revalidate cutover ownership before foundation mutation");
    expect(step("deploy-environment", "Build the inspection-only image for an existing empty foundation").if)
      .toBe("needs.force-disable-rollout.outputs.foundation_kind == 'inspect'");
    expect(run("migrate-backup", "Run migrate-init (new release)"))
      .toContain('--fresh-migration-config');
    expect(step("migrate-backup", "Revalidate cutover ownership before migration").env?.FRESH_DATABASE_CONFIG_OUTPUT)
      .toBe("/tmp/fresh-migration-config.json");
    for (const [id, name] of [
      ["deploy-environment", "Publish foundation database inspection evidence"],
      ["deploy-release", "Publish pre-release database inspection evidence"],
      ["migrate-backup", "Publish pre-migration database inspection evidence"],
    ]) {
      expect(step(id, name).if).toBe("always()");
      expect(step(id, name).with?.path).toBe("evidence-bootstrap/");
    }
  });

  it.each(["initialize", "preserve"])("renders the real prod parameters with %s mode", (mode) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "krypto-cutover-"));
    try {
      const output = path.join(directory, "environment.prod.bicepparam");
      const result = spawnSync(process.execPath, [
        ".github/scripts/azure/render-bicepparam.mjs",
        "--template", "infra/params/environment.prod.bicepparam",
        "--out", output,
        "--set", "REPLACE_WITH_BOOTSTRAP_PROD_DEPLOY_IDENTITY_PRINCIPAL_ID=11111111-1111-4111-8111-111111111111",
        "--set", "REPLACE_WITH_BOOTSTRAP_PROD_PROMOTION_IDENTITY_PRINCIPAL_ID=22222222-2222-4222-8222-222222222222",
        "--set-string-param", `postgresCredentialMode=${mode}`,
      ], { cwd: root, encoding: "utf8" });
      expect(result.status).toBe(0);
      const rendered = fs.readFileSync(output, "utf8");
      expect(rendered).toContain(`param postgresCredentialMode = '${mode}'`);
      expect(rendered).toContain("readEnvironmentVariable('POSTGRES_ADMIN_PASSWORD_PROD')");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("cutover binding failures", () => {
  it.each([
    ["fresh without a defined database boundary", { existing_release: "false" }, 1],
    ["missing", {}, 1],
    ["malformed", { existing_release: "unknown" }, 1],
    ["boolean false", { existing_release: false }, 1],
    ["boolean true", { existing_release: true }, 1],
    ["deferred", { existing_release: "true", admission_status: "deferred" }, 1],
    ["owner missing", { existing_release: "true", admission_status: "admitted" }, 1],
  ])("handles %s binding without contacting Azure", (_name, binding, expected) => {
    const result = spawnSync("bash", ["-s"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, CUTOVER_BINDING_JSON: JSON.stringify(binding) },
      input: `
az() { echo "FORBIDDEN_LIVE_AZURE_CALL" >&2; return 99; }
export -f az
bash .github/scripts/azure/revalidate-deployment-fence.sh source test-binding
`,
    });
    expect(result.error).toBeUndefined();
    expect(result.status === 0 ? 0 : 1).toBe(expected);
    expect(result.stderr).not.toContain("FORBIDDEN_LIVE_AZURE_CALL");
  });
});

describe("native paper-promotion job contract", () => {
  const evidence = jest.requireActual<{ PRODUCTION_JOB_NAMES: Record<string, string> }>(
    "../../../.github/scripts/azure/production-evidence.cjs",
  );

  it("binds the exact native job inventory and all promotion/compensation dependencies", () => {
    expect(Object.keys(workflow.jobs).sort()).toEqual(Object.keys(evidence.PRODUCTION_JOB_NAMES).sort());
    for (const [id, name] of Object.entries(evidence.PRODUCTION_JOB_NAMES)) expect(job(id).name).toBe(name);
    expect(job("prepare-paper").needs).toEqual(["gate", "force-disable-rollout", "deploy-environment", "publish-release-receipt"]);
    expect(job("prepare-paper").if).toContain("needs.publish-release-receipt.outputs.status == 'disabled'");
    expect(job("prepare-paper").if).toContain("needs.force-disable-rollout.outputs.promotion_mode == 'operator'");
    expect(job("prepare-paper").if).toContain("needs.force-disable-rollout.outputs.promotion_mode == 'continuous'");
    expect(job("promote-paper").needs).toContain("prepare-paper");
    expect(job("promote-paper").if).toContain("needs.prepare-paper.result == 'success'");
    expect(job("publish-production-delivery").if).toContain("needs.publish-promotion-receipt.outputs.status == 'paper'");
    const recovery = job("recover-paper");
    expect(recovery.needs).toEqual(Object.keys(evidence.PRODUCTION_JOB_NAMES)
      .filter((id) => !["recover-paper", "release-recovered-fence", "publish-production-failure"].includes(id)));
    expect(recovery.if).toContain("always()");
    expect(recovery.if).toContain("contains(needs.*.result, 'cancelled')");
    expect(recovery.if).toContain("contains(needs.*.result, 'failure')");
    expect(recovery.if).not.toMatch(/prepare-paper|publish-release-receipt|promotion_mode/);
    expect(job("publish-production-failure").needs).toContain("recover-paper");
    expect(job("publish-production-failure").needs).toContain("backup-current-release");
    expect(job("publish-production-failure").needs).toContain("release-recovered-fence");
    expect(recovery["timeout-minutes"]).toBe(60);
    expect(job("release-recovered-fence")["timeout-minutes"]).toBe(30);
  });

  it.each(Object.keys(evidence.PRODUCTION_JOB_NAMES)
    .filter((id) => !["gate", "recover-paper", "release-recovered-fence", "publish-production-failure"].includes(id))
    .flatMap((id) => ["failure", "cancelled"].map((result) => [id, result])))(
    "the actual recovery condition covers %s %s even when other predecessors were skipped",
    (id, result) => {
      const needs = Object.fromEntries(Object.keys(evidence.PRODUCTION_JOB_NAMES)
        .map((name) => [name, { result: name === "gate" ? "success" : "skipped" }]));
      needs[id].result = result;
      const expression = z.string().parse(job("recover-paper").if)
        .replace("needs.*.result", "Object.values(needs).map(job => job.result)")
        .replace("needs.*.result", "Object.values(needs).map(job => job.result)");
      const evaluate = new Function("needs", "always", "contains", `return (${expression});`);
      const includes = (values: string[], expected: string) => values.includes(expected);
      expect(evaluate(needs, () => true, includes)).toBe(true);
      needs[id].result = "success";
      expect(evaluate(needs, () => true, includes)).toBe(false);
      needs[id].result = result;
      needs.gate.result = "failure";
      expect(evaluate(needs, () => true, includes)).toBe(false);
    },
  );

  it("persists source context before acquisition and retained intent before any recovery mutation", () => {
    expectBefore("force-disable-rollout", "Capture the exact source recovery binding before fence acquisition",
      "Retain the nonsecret source binding before any cutover mutation");
    expectBefore("force-disable-rollout", "Retain the nonsecret source binding before any cutover mutation",
      "Acquire the exact source release's owned cutover fence");
    expectBefore("recover-paper", "Preserve recovery intent before any compensating mutation", "Azure login (OIDC)");
    expect(step("recover-paper", "Retain only bounded nonsecret recovery results").if).toBe("always()");
    const completion = job("release-recovered-fence");
    expect(completion.needs).toEqual(["gate", "recover-paper"]);
    expect(completion.if).toContain("needs.recover-paper.result == 'success'");
    expect(completion.if).toContain("needs.recover-paper.outputs.status == 'disabled'");
    expect(completion.if).toContain("needs.recover-paper.outputs.fence == 'required'");
    expect(completion.environment).toBe("production-deploy");
    expect(completion.permissions).toEqual({ contents: "read", "id-token": "write" });
    const artifact = step("release-recovered-fence", "Retain only the nonsecret fence completion result");
    expect(artifact.if).toBe("always()");
    expect(artifact.with?.path).toBe("production-recovered-fence/receipt.json");
  });

  it("separates Azure promotion from GitHub publication with exact-source checkout and private proofs", () => {
    for (const id of ["prepare-paper", "promote-paper", "recover-paper"]) {
      expect(job(id).environment).toBe("production-promotion");
      expect(job(id).permissions?.["id-token"]).toBe("write");
      expect(job(id).steps[0].with).toMatchObject({ ref: "${{ needs.gate.outputs.sha }}", "persist-credentials": false });
      if (id !== "recover-paper") {
        expect(job(id).steps.some((entry) => entry.uses?.startsWith("actions/upload-artifact"))).toBe(false);
      } else {
        const paths = job(id).steps.filter((entry) => entry.uses?.startsWith("actions/upload-artifact"))
          .map((entry) => entry.with?.path);
        expect(paths).toEqual([
          "production-recovery/intent.json", "production-recovery/intent.json\nproduction-recovery/result.json\n",
        ]);
      }
    }
    expect(job("recover-paper").permissions).toEqual({ contents: "read", "id-token": "write" });
    expect(job("publish-promotion-receipt").permissions).toEqual({ contents: "read", actions: "read" });
    expect(job("publish-production-delivery").permissions).toEqual({ contents: "read", deployments: "write", statuses: "write" });
    for (const id of ["publish-promotion-receipt", "publish-production-delivery", "publish-production-failure"]) {
      expect(job(id).environment).toBeUndefined();
      expect(job(id).steps[0].with).toMatchObject({ ref: "${{ github.workflow_sha }}", "persist-credentials": false });
    }
    expect(step("promote-paper", "Set up the supported observation runtime").with?.["node-version"]).toBe("22.13.0");
    expect(step("publish-promotion-receipt", "Retain only the nonsecret immutable receipt").with).toMatchObject({
      path: "paper-production-receipt/receipt.json", "if-no-files-found": "error", "retention-days": 90,
    });
    const lifecycle = z.object({
      on: z.object({ workflow_run: z.object({ workflows: z.array(z.string()) }) }),
      permissions: strings, concurrency: z.object({ "cancel-in-progress": z.boolean() }),
    }).parse(parse(read(".github/workflows/agentic-lifecycle-reconciler.yml")));
    expect(lifecycle.on.workflow_run.workflows).toEqual(["Azure deploy dev", "Azure deploy prod"]);
    expect(lifecycle.permissions.actions).toBe("write");
    expect(lifecycle.permissions["id-token"]).toBeUndefined();
    expect(lifecycle.concurrency["cancel-in-progress"]).toBe(false);
  });
});

describe("executable paper-production publishers", () => {
  const owned: string[] = [];
  const evidence = jest.requireActual<Record<string, unknown>>("../../../.github/scripts/azure/production-evidence.cjs");
  const recoveryApi = jest.requireActual<{
    createRecoveryIntent(env: unknown, needs: unknown): Record<string, unknown>;
  } & Record<string, unknown>>("../../../.github/scripts/azure/production-promotion.cjs");
  beforeEach(() => jest.useFakeTimers({ now: new Date("2026-10-22T01:03:00Z") }));
  afterEach(() => {
    jest.useRealTimers();
    for (const directory of owned.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });

  function publisher() {
    const f = productionPromotionFixture();
    f.needs.gate.outputs.sha = f.sha;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "krypto-production-publisher-"));
    owned.push(directory);
    const core = { setOutput: jest.fn(), notice: jest.fn(), error: jest.fn(), setFailed: jest.fn(), setSecret: jest.fn() };
    const pause = jest.fn(async () => {});
    const repos = {
      createDeployment: jest.fn(async (args: { ref: string }) => ({ data: {
        id: 301, sha: args.ref, environment: "production", production_environment: true,
      } })),
      createDeploymentStatus: jest.fn(async () => ({})),
      createCommitStatus: jest.fn(async () => ({})),
    };
    const fileSystem = {
      mkdirSync: (name: string) => {
        expect(["paper-production-receipt", "production-recovery-status", "production-recovery",
          "production-recovered-fence", "production-cutover-context"]).toContain(name);
        fs.mkdirSync(path.join(directory, name), { recursive: true });
      },
      writeFileSync: jest.fn((name: string, body: string, options: fs.WriteFileOptions) => {
        expect(["paper-production-receipt/receipt.json", "production-recovery-status/receipt.json",
          "production-recovery/intent.json", "production-recovery/result.json",
          "production-recovered-fence/receipt.json", "production-cutover-context/context.json"]).toContain(name);
        fs.writeFileSync(path.join(directory, name), body, options);
      }),
    };
    const intent = recoveryApi.createRecoveryIntent(f.env, f.needs);
    const recovery: Record<string, unknown> = {
      ...intent, status: "disabled", scope: "candidate", fence: "none", binding: f.binding,
      completedAt: new Date().toISOString(), reason: "disabled-manual-verified",
    };
    const recover = jest.fn(async () => recovery);
    const releaseFence = jest.fn(async () => recovery);
    const capture = jest.fn(async () => ({ binding: f.binding }));
    const modules = (name: string) => {
      if (name === "node:fs") return fileSystem;
      if (name === "node:path") return path;
      if (name === "node:assert/strict") return jest.requireActual("node:assert/strict");
      if (name.endsWith("production-evidence.cjs")) return evidence;
      if (name.endsWith("production-promotion.cjs")) return {
        ...recoveryApi, runProductionRecovery: recover, releaseRecoveredProductionFence: releaseFence,
        captureProductionRecovery: capture,
      };
      if (name.endsWith("agentic-lifecycle-reconciler.cjs")) return { pauseFactoryControl: pause };
      throw new Error(`Unexpected publisher dependency ${name}`);
    };
    const env: Record<string, string> = {
      ...f.env, GITHUB_WORKSPACE: root, GITHUB_SERVER_URL: "https://github.com",
      PRODUCTION_JOB_RESULTS: JSON.stringify(f.needs), PRODUCTION_RECEIPT: JSON.stringify(f.receipt),
      RECOVERY_RESULT: "success", PRODUCTION_DEPLOYMENT_ID: "301",
      RECOVERY_FENCE_RESULT: "skipped", PRODUCTION_RECOVERY_RECEIPT: JSON.stringify(recovery),
      PRODUCTION_RECOVERY_INTENT: JSON.stringify(intent),
    };
    const github = { ...f.github, rest: { ...f.github.rest, repos } };
    const execute = async (id: string, name: string) => {
      const script = z.string().parse(step(id, name).with?.script);
      const runScript = new Function("github", "context", "core", "require", "process", `return (async () => { ${script} })();`);
      await runScript(github, { repo: { owner: "owner", repo: "project" } }, core, modules, { env });
    };
    return { f, directory, core, pause, repos, env, execute, fileSystem, recovery, intent, recover, releaseFence, capture };
  }

  it("creates the real closed nonsecret promotion receipt with exclusive persistence", async () => {
    const h = publisher();
    await h.execute("publish-promotion-receipt", "Create exact-attempt paper-production evidence");
    const receipt: unknown = JSON.parse(fs.readFileSync(path.join(h.directory, "paper-production-receipt", "receipt.json"), "utf8"));
    expect(receipt).toEqual(h.f.receipt);
    expect(h.fileSystem.writeFileSync).toHaveBeenCalledWith("paper-production-receipt/receipt.json", expect.any(String), { flag: "wx" });
    expect(h.core.setOutput).toHaveBeenCalledWith("status", "paper");
    await expect(h.execute("publish-promotion-receipt", "Create exact-attempt paper-production evidence")).rejects.toThrow("EEXIST");
  });

  it("publishes a native exact-SHA Deployment before its status and the commit signal", async () => {
    const h = publisher();
    await h.execute("publish-production-delivery", "Publish receipt-bound production delivery");
    expect(h.repos.createDeployment).toHaveBeenCalledWith(expect.objectContaining({
      ref: h.f.sha, environment: "production", production_environment: true,
      payload: h.f.reference, auto_merge: false, required_contexts: [],
    }));
    expect(h.core.setOutput).toHaveBeenCalledWith("deployment_id", 301);
    expect(h.repos.createDeploymentStatus).toHaveBeenCalledWith(expect.objectContaining({
      deployment_id: 301, state: "success", environment_url: h.f.binding.targetOrigin, auto_inactive: false,
    }));
    expect(h.repos.createCommitStatus).toHaveBeenCalledWith(expect.objectContaining({ sha: h.f.sha, state: "success" }));
    expect(h.repos.createDeploymentStatus.mock.invocationCallOrder[0]).toBeLessThan(h.repos.createCommitStatus.mock.invocationCallOrder[0]);
  });

  it.each(["repository", "repositoryId", "repositoryOwnerId", "workflowSha", "releaseSha", "runId", "runAttempt", "status"])(
    "never publishes another %s as successful delivery",
    async (field) => {
      const h = publisher();
      h.env.PRODUCTION_RECEIPT = JSON.stringify({ ...h.f.receipt, [field]: "different" });
      await expect(h.execute("publish-production-delivery", "Publish receipt-bound production delivery")).rejects.toThrow();
      expect(h.repos.createDeployment).not.toHaveBeenCalled();
      expect(h.repos.createCommitStatus).not.toHaveBeenCalled();
    },
  );

  it("does not publish success when native Deployment creation resolves to another SHA", async () => {
    const h = publisher();
    h.repos.createDeployment.mockResolvedValue({ data: {
      id: 301, sha: "f".repeat(40), environment: "production", production_environment: true,
    } });
    await expect(h.execute("publish-production-delivery", "Publish receipt-bound production delivery")).rejects.toThrow("exact-SHA");
    expect(h.repos.createCommitStatus).not.toHaveBeenCalled();
    expect(h.repos.createDeploymentStatus).not.toHaveBeenCalled();
  });

  it.each(["commit-status", "pause", "deployment-status", "synchronous-error", "recovery-persistence"])(
    "attempts every failure publication even if %s fails, without logging private errors",
    async (failure) => {
      const h = publisher();
      const error = new Error("private-service-error-do-not-publish");
      if (failure === "commit-status") h.repos.createCommitStatus.mockRejectedValue(error);
      if (failure === "pause") h.pause.mockRejectedValue(error);
      if (failure === "deployment-status") h.repos.createDeploymentStatus.mockRejectedValue(error);
      if (failure === "synchronous-error") h.repos.createCommitStatus.mockImplementation(() => { throw error; });
      if (failure === "recovery-persistence") h.fileSystem.writeFileSync.mockImplementation(() => { throw error; });
      await h.execute("publish-production-failure", "Record exact-SHA failure without claiming recovery succeeded");
      expect(h.pause).toHaveBeenCalledTimes(1);
      expect(h.repos.createCommitStatus).toHaveBeenCalledTimes(1);
      expect(h.repos.createDeploymentStatus).toHaveBeenCalledWith(expect.objectContaining({ deployment_id: 301, state: "failure" }));
      expect(h.core.setFailed).toHaveBeenCalledTimes(1);
      expect(h.core.error).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(h.core.error.mock.calls)).not.toContain(error.message);
    },
  );

  it("does not guess a missing Deployment or turn failed recovery into success", async () => {
    const h = publisher();
    h.env.PRODUCTION_DEPLOYMENT_ID = "";
    h.env.RECOVERY_RESULT = "failure";
    await h.execute("publish-production-failure", "Record exact-SHA failure without claiming recovery succeeded");
    expect(h.repos.createDeploymentStatus).not.toHaveBeenCalled();
    expect(h.repos.createCommitStatus).toHaveBeenCalledWith(expect.objectContaining({
      state: "failure", description: "Delivery failed; production activation/recovery is not verified.",
    }));
    expect(h.pause).toHaveBeenCalledTimes(1);
    expect(h.core.setFailed).toHaveBeenCalledWith(expect.stringContaining("recovery result: failure"));
  });

  it("executes exclusive source capture and bounded intent persistence before invoking recovery", async () => {
    const h = publisher();
    await h.execute("force-disable-rollout", "Capture the exact source recovery binding before fence acquisition");
    expect(h.capture).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(path.join(h.directory, "production-cutover-context", "context.json"), "utf8")))
      .toEqual({ binding: h.f.binding });
    await h.execute("recover-paper", "Record bounded retained recovery before Azure access");
    expect(h.recover).not.toHaveBeenCalled();
    const intent = JSON.parse(fs.readFileSync(path.join(h.directory, "production-recovery", "intent.json"), "utf8"));
    expect(intent).toMatchObject({ status: "retained", fence: "unknown", binding: null, runAttempt: 2 });
    expect(Date.parse(intent.deadlineAt) - Date.parse(intent.startedAt)).toBe(3_600_000);
    await h.execute("recover-paper", "Preserve balances and prove disabled/Manual before disabling schedule monitoring");
    expect(h.recover).toHaveBeenCalledTimes(1);
    expect(h.core.setOutput).toHaveBeenCalledWith("status", "disabled");
    expect(h.fileSystem.writeFileSync).toHaveBeenCalledWith("production-recovery/result.json", expect.any(String), { flag: "wx" });
    await expect(h.execute("recover-paper", "Record bounded retained recovery before Azure access")).rejects.toThrow("EEXIST");
  });

  it.each(["recover-paper", "release-recovered-fence"])("persists explicit retained failure for %s without leaking an exception", async (id) => {
    const h = publisher();
    const error = new Error("private-service-template");
    h.recover.mockRejectedValue(error);
    h.releaseFence.mockRejectedValue(error);
    if (id === "recover-paper") {
      await h.execute(id, "Record bounded retained recovery before Azure access");
      await h.execute(id, "Preserve balances and prove disabled/Manual before disabling schedule monitoring");
    } else await h.execute(id, "Release only the original owner after fresh disabled readback");
    const file = id === "recover-paper" ? ["production-recovery", "result.json"] : ["production-recovered-fence", "receipt.json"];
    const body = fs.readFileSync(path.join(h.directory, ...file), "utf8");
    expect(JSON.parse(body).status).toBe("retained");
    expect(body).not.toContain(error.message);
    expect(JSON.stringify(h.core.setFailed.mock.calls)).not.toContain(error.message);
    expect(h.core.setFailed).toHaveBeenCalledTimes(1);
  });

  it.each(["missing", "invalid", "private-field", "wrong-attempt"])(
    "cannot equate a green recovery job with verified recovery when its receipt is %s",
    async (kind) => {
      const h = publisher();
      h.env.PRODUCTION_RECOVERY_RECEIPT = kind === "missing" ? "" : kind === "invalid" ? "not-json" :
        JSON.stringify(kind === "private-field" ? { ...h.recovery, token: "private-service-template" } :
          { ...h.recovery, runAttempt: 1 });
      await h.execute("publish-production-failure", "Record exact-SHA failure without claiming recovery succeeded");
      expect(h.repos.createCommitStatus).toHaveBeenCalledWith(expect.objectContaining({
        state: "failure", description: "Delivery failed; production activation/recovery is not verified.",
      }));
      const output = fs.readFileSync(path.join(h.directory, "production-recovery-status", "receipt.json"), "utf8");
      expect(JSON.parse(output).state).toBe("recovery-retained");
      expect(output).not.toContain("private-service-template");
      expect(h.pause).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps failed upload/login recovery unverified even if a step produced a disabled receipt", async () => {
    const h = publisher();
    h.env.RECOVERY_RESULT = "failure";
    await h.execute("publish-production-failure", "Record exact-SHA failure without claiming recovery succeeded");
    expect(h.repos.createCommitStatus).toHaveBeenCalledWith(expect.objectContaining({
      description: "Delivery failed; production activation/recovery is not verified.",
    }));
  });

  it("fails the recovery step explicitly when candidate backup failure retains its fence", async () => {
    const h = publisher();
    const { deploymentFenceOwner } = jest.requireActual<{ deploymentFenceOwner(repositoryId: string, runId: string): string }>(
      "../../../.github/scripts/azure/lib/deployment-owner.cjs",
    );
    h.recover.mockResolvedValue({
      ...h.recovery, fence: "retained", reason: "candidate-baseline-unverified", cutover: {
        owner: deploymentFenceOwner("456", "1001"), sourceReleaseSha: h.f.sha, candidateReleaseSha: h.f.sha,
        sourceImageDigest: h.f.binding.webImageDigest, targetOrigin: h.f.binding.targetOrigin,
        evidenceContainerUrl: h.f.binding.evidenceContainerUrl,
      },
    });
    await h.execute("recover-paper", "Record bounded retained recovery before Azure access");
    await h.execute("recover-paper", "Preserve balances and prove disabled/Manual before disabling schedule monitoring");
    expect(h.core.setFailed).toHaveBeenCalledWith(expect.stringContaining("fence remains retained"));
    expect(h.core.setOutput).toHaveBeenCalledWith("fence", "retained");
    expect(h.releaseFence).not.toHaveBeenCalled();
  });

  it.each(["failure", "skipped", "missing-receipt", "wrong-attempt", "success"])(
    "reports a %s recovered fence without treating it as delivered paper production",
    async (result) => {
      const h = publisher();
      const { deploymentFenceOwner } = jest.requireActual<{ deploymentFenceOwner(repositoryId: string, runId: string): string }>(
        "../../../.github/scripts/azure/lib/deployment-owner.cjs",
      );
      const receipt = { ...h.recovery, fence: "required", cutover: {
        owner: deploymentFenceOwner("456", "1001"), sourceReleaseSha: h.f.sha, candidateReleaseSha: h.f.sha,
        sourceImageDigest: h.f.binding.webImageDigest, targetOrigin: h.f.binding.targetOrigin,
        evidenceContainerUrl: h.f.binding.evidenceContainerUrl,
      } };
      h.env.PRODUCTION_RECOVERY_RECEIPT = JSON.stringify(receipt);
      h.env.RECOVERY_FENCE_RESULT = ["failure", "skipped"].includes(result) ? result : "success";
      if (result !== "missing-receipt") {
        h.env.RECOVERED_FENCE_RECEIPT = JSON.stringify({
          ...receipt, fence: "released", runAttempt: result === "wrong-attempt" ? 1 : 2,
        });
      }
      await h.execute("publish-production-failure", "Record exact-SHA failure without claiming recovery succeeded");
      const output = JSON.parse(fs.readFileSync(path.join(h.directory, "production-recovery-status", "receipt.json"), "utf8"));
      expect(output.state).toBe(result === "success" ? "disabled-verified" :
        ["failure", "skipped"].includes(result) ? "fence-retained" : "recovery-retained");
      expect(h.repos.createCommitStatus).toHaveBeenCalledWith(expect.objectContaining({ state: "failure" }));
      expect(h.repos.createDeploymentStatus).toHaveBeenCalledWith(expect.objectContaining({ state: "failure" }));
      expect(h.pause).toHaveBeenCalledTimes(1);
    },
  );

  it("reports untouched deferral distinctly and still publishes the actual failed attempt", async () => {
    const h = publisher();
    h.env.PRODUCTION_RECOVERY_RECEIPT = JSON.stringify({
      ...h.intent, status: "untouched", completedAt: new Date().toISOString(), reason: "verified-mutation-free-deferral",
    });
    await h.execute("publish-production-failure", "Record exact-SHA failure without claiming recovery succeeded");
    expect(h.repos.createCommitStatus).toHaveBeenCalledWith(expect.objectContaining({
      state: "failure", description: "Delivery failed; the verified deferred source was left untouched.",
    }));
  });
});
