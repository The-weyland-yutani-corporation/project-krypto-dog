import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";
import { z } from "zod";

const root = path.resolve(__dirname, "../../..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const strings = z.record(z.string(), z.string());
const stepSchema = z.object({
  name: z.string(),
  id: z.string().optional(),
  if: z.string().optional(),
  run: z.string().optional(),
  env: strings.optional(),
  with: z.record(z.string(), z.unknown()).optional(),
});
const workflow = z.object({
  on: z.record(z.string(), z.unknown()),
  concurrency: z.object({
    group: z.string(),
    "cancel-in-progress": z.boolean(),
  }),
  jobs: z.record(z.string(), z.object({
    needs: z.union([z.string(), z.array(z.string())]).optional(),
    if: z.string().optional(),
    environment: z.string().optional(),
    env: strings.optional(),
    outputs: strings.optional(),
    steps: z.array(stepSchema),
  })),
}).parse(parse(read(".github/workflows/azure-deploy-prod.yml")));

function job(id: string) {
  const value = workflow.jobs[id];
  if (!value) throw new Error(`Missing production job: ${id}`);
  return value;
}

function step(jobId: string, name: string) {
  const value = job(jobId).steps.find((candidate) => candidate.name === name);
  if (!value) throw new Error(`Missing production step: ${jobId}/${name}`);
  return value;
}

function run(jobId: string, name: string): string {
  const value = step(jobId, name).run;
  if (!value) throw new Error(`Missing production script: ${jobId}/${name}`);
  return value.replace(/\r\n/g, "\n");
}

function expectBefore(jobId: string, first: string, second: string) {
  const steps = job(jobId).steps;
  expect(steps.indexOf(step(jobId, first))).toBeLessThan(
    steps.indexOf(step(jobId, second)),
  );
}

describe("production cutover workflow", () => {
  it("keeps protected main admission and successful push CI for both stages", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.concurrency).toEqual({
      group: "azure-production-mutation",
      "cancel-in-progress": false,
    });
    const resolve = run("gate", "Resolve and format-validate the exact commit SHA to deploy");
    expect(resolve).toContain('if [ "${GITHUB_REF}" != "refs/heads/main" ]');
    expect(resolve).toContain('azure_validate_release_sha "${candidate}"');
    expect(resolve).toContain('"${deployment_stage}" != "foundation"');
    expect(resolve).toContain('"${deployment_stage}" != "full"');
    const verify = step("gate", "Verify manually-dispatched SHA branch and successful push CI");
    expect(verify.if).toBeUndefined();
    expect(verify.run).toContain("--branch main");
    expect(verify.run).toContain("--ci-workflow ci.yml");
    expect(verify.env?.RESOLVED_SHA).toBe("${{ steps.resolve.outputs.sha }}");
  });

  it("rejects foundation on an existing release and never treats partial inventory as fresh", () => {
    const detect = run("force-disable-rollout", "Detect a complete existing release or a genuinely fresh environment");
    expect(detect).toContain('"${present}" -eq 8');
    expect(detect).toContain('"${DEPLOYMENT_STAGE}" = "foundation"');
    expect(detect).toContain('echo "existing_release=true"');
    expect(detect).toContain('elif [ "${present}" -eq 0 ]');
    expect(detect).toContain('echo "existing_release=false"');
    expect(detect).toMatch(/Partial state[\s\S]*exit 1/);
    expect(run("force-disable-rollout", "Resolve the currently-deployed release SHA and image digest"))
      .toContain('git merge-base --is-ancestor "${current_sha}" "${RESOLVED_SHA}"');
  });

  it("admits the exact source before disabling any healthy execution path", () => {
    const acquire = "Acquire the exact source release's owned cutover fence";
    const disable = "Force rollout.bicep to disabled/Manual before touching infrastructure";
    expectBefore("force-disable-rollout", acquire, disable);
    const admission = run("force-disable-rollout", acquire);
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
    ["backup-current-release", "source", "check-backup", "Run preflight on the current release"],
    ["deploy-environment", "source", "check-env", "Deploy infra/environment.bicep"],
    ["build-images", "source", "check-images", "Build web image and resolve digest"],
    ["deploy-release", "source", "check-release", "Deploy infra/release.bicep"],
    ["migrate-backup-smoke", "candidate", "check-migrate", "Run migrate-init (new release)"],
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
    const release = run("migrate-backup-smoke", "Verify the new disabled release before releasing its cutover fence");
    expect(release.indexOf("verify-disabled-rollout.sh")).toBeLessThan(release.indexOf("--action release"));
    expect(release).toContain('--owner "${FENCE_OWNER}"');
    expect(release).toContain('--job-release-sha "${RESOLVED_SHA}"');
    expectBefore("migrate-backup-smoke",
      "Create and restore-verify a fresh baseline backup (new release)",
      "Verify the new disabled release before releasing its cutover fence");
    expectBefore("migrate-backup-smoke",
      "Verify the new disabled release before releasing its cutover fence",
      "Run target-smoke (new release)");
  });

  it("cannot turn a foundation-only run into image publication or release work", () => {
    for (const id of ["build-images", "deploy-release", "migrate-backup-smoke", "verify-final-state"]) {
      expect(job(id).if).toContain("needs.gate.outputs.deployment_stage == 'full'");
    }
    expect(run("verify-final-state", "Verify the live disabled release and immutable image binding"))
      .toContain('.properties.configuration.triggerType == "Manual"');
    expect(read(".github/workflows/azure-deploy-prod.yml"))
      .not.toMatch(/--set-string-param rolloutMode=(paper|shadow)/);
  });
});

describe("credential-preserving production updates", () => {
  const render = run("deploy-environment", "Render environment.prod.bicepparam");
  const invocation = render.indexOf("node .github/scripts/azure/render-bicepparam.mjs");

  it("selects credentials before both preview and deployment, without changing the renderer", () => {
    expect(invocation).toBeGreaterThan(0);
    expect(render).toContain('--set-string-param postgresCredentialMode="${credential_mode}"');
    expect(step("deploy-environment", "Render environment.prod.bicepparam").env?.EXISTING_RELEASE)
      .toBe("${{ needs.force-disable-rollout.outputs.existing_release }}");
    expectBefore("deploy-environment", "Render environment.prod.bicepparam", "What-if infra/environment.bicep");
    for (const name of ["What-if infra/environment.bicep", "Deploy infra/environment.bicep"]) {
      expect(run("deploy-environment", name)).toContain("--parameters /tmp/environment.prod.resolved.bicepparam");
    }
  });

  it.each([
    ["true", "preserve"],
    ["false", "initialize"],
  ])("executes the real credential selector for inventory %s", (existing, expected) => {
    const result = spawnSync("bash", ["-s"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, EXISTING_RELEASE: existing },
      input: `${render.slice(0, invocation)}\nprintf '%s' "\${credential_mode}"\n`,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(expected);
  });

  it.each(["", "unknown", "TRUE", "deferred", "true\nfalse"])(
    "rejects ambiguous inventory %j instead of initializing credentials",
    (existing) => {
      const result = spawnSync("bash", ["-s"], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, EXISTING_RELEASE: existing },
        input: render.slice(0, invocation),
      });
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("requires an explicit release inventory result");
    },
  );

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
    ["fresh", { existing_release: "false" }, 0],
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
