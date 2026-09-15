import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { DEV_DIGEST, DEV_SHA } from "./fixtures/dev-evidence";

describe("development operation failure retention", () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "krypto-retention-"));
    mkdirSync(join(directory, "lib"));
    const source = resolve(".github", "scripts", "azure");
    for (const file of ["run-ops-with-evidence.sh", "validate-report.mjs", "report-validation.cjs"]) {
      copyFileSync(join(source, file), join(directory, file));
    }
    copyFileSync(join(source, "lib", "common.sh"), join(directory, "lib", "common.sh"));
    writeFileSync(join(directory, "run-ops-job.sh"), '#!/usr/bin/env bash\necho operation >> calls.log\nexit "$TEST_OPERATION_EXIT"\n');
    writeFileSync(join(directory, "download-evidence.sh"), `#!/usr/bin/env bash
set -euo pipefail
echo retention >> calls.log
if [ "$TEST_RETENTION_EXIT" != "0" ]; then exit "$TEST_RETENTION_EXIT"; fi
mkdir -p "evidence/dev/${DEV_SHA}/target-smoke/run731-a1-target-smoke"
printf '%s' "$TEST_REPORT" > "evidence/dev/${DEV_SHA}/target-smoke/run731-a1-target-smoke/report.json"
`);
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  function run(operationExit: number, retentionExit: number, passed: boolean) {
    const report = {
      passed, releaseSha: DEV_SHA, imageDigest: DEV_DIGEST, rolloutMode: "disabled",
      binding: { releaseSha: DEV_SHA, imageDigest: DEV_DIGEST, rolloutMode: "disabled" },
    };
    const env = { ...process.env };
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
    if (!pathKey) throw new Error("PATH is required for the shell fixture.");
    env[pathKey] = `${dirname(process.execPath)}${delimiter}${env[pathKey]}`;
    const result = spawnSync("bash", [
      "run-ops-with-evidence.sh", "--job-name", "caj-dev-target-smoke",
      "--resource-group", "rg-krypto-dev", "--timeout-seconds", "1800",
      "--job-execution-id", "run731-a1-target-smoke", "--operation", "target-smoke",
      "--container-url", "https://examplestorage.blob.core.windows.net/evidence",
      "--environment-name", "dev", "--release-sha", DEV_SHA,
      "--destination", "evidence", "--image-digest", DEV_DIGEST,
    ], {
      cwd: directory, encoding: "utf8", timeout: 15000, windowsHide: true,
      env: {
        ...env, TEST_OPERATION_EXIT: String(operationExit),
        TEST_RETENTION_EXIT: String(retentionExit), TEST_REPORT: JSON.stringify(report),
      },
    });
    expect(result.error).toBeUndefined();
    expect(readFileSync(join(directory, "calls.log"), "utf8")).toBe("operation\nretention\n");
    if (result.status === 127) throw new Error(result.stderr);
    return result;
  }

  it("downloads the authentic failure report and preserves the original operation exit", () => {
    const result = run(13, 0, false);
    expect(result.status).toBe(13);
    expect(result.stderr).toContain("original exit 13");
    const report = JSON.parse(readFileSync(join(directory, "evidence", "dev", DEV_SHA, "target-smoke", "run731-a1-target-smoke", "report.json"), "utf8"));
    expect(report.passed).toBe(false);
  });

  it("reports both failures without replacing the primary failure with the retention exit", () => {
    const result = run(13, 72, false);
    expect(result.status).toBe(13);
    expect(result.stderr).toContain("retention failed (exit 72)");
    expect(result.stderr).toContain("original exit 13");
  });

  it("retains evidence after an interrupted execution without claiming success", () => {
    expect(run(130, 0, true).status).toBe(130);
  });

  it("fails when a successful job has no readable report", () => {
    expect(run(0, 72, true).status).toBe(72);
  });

  it("does not accept a report's failed pass field even after a successful job", () => {
    expect(run(0, 0, false).status).toBe(1);
  });

  it("accepts only a successfully executed, retained, bound passing report", () => {
    expect(run(0, 0, true).status).toBe(0);
  });
});
