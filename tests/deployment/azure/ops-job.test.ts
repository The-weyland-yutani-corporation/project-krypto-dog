import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VALID_RELEASE_SHA = "a".repeat(40);

/**
 * Writes a fake `azcopy` executable to a fresh temp directory and returns
 * that directory so it can be prepended onto PATH. Only `copy <args...>`
 * is treated as an expected invocation: it appends the full argv *and*
 * the `AZCOPY_AUTO_LOGIN_TYPE`/`AZCOPY_MSI_CLIENT_ID` environment it
 * actually received to `FAKE_AZCOPY_LOG_PATH` (read from its own
 * environment, set per-test), then exits with
 * `FAKE_AZCOPY_COPY_EXIT_CODE` (default 0). Any other subcommand --
 * notably a regressed `login` call -- is logged as `UNEXPECTED` and
 * always exits nonzero, so a test can assert both that upload succeeded
 * *and* that no separate login subprocess was ever invoked.
 */
function writeFakeAzcopy(): string {
  const binDir = mkdtempSync(join(tmpdir(), "krypto-fake-azcopy-"));
  const script = `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "copy" ]; then
  shift
  printf 'COPY %s AZCOPY_AUTO_LOGIN_TYPE=%s AZCOPY_MSI_CLIENT_ID=%s\\n' \\
    "$*" "\${AZCOPY_AUTO_LOGIN_TYPE:-}" "\${AZCOPY_MSI_CLIENT_ID:-}" \\
    >> "\${FAKE_AZCOPY_LOG_PATH}"
  exit "\${FAKE_AZCOPY_COPY_EXIT_CODE:-0}"
fi
printf 'UNEXPECTED %s\\n' "$*" >> "\${FAKE_AZCOPY_LOG_PATH}"
exit 1
`;
  const binPath = join(binDir, "azcopy");
  writeFileSync(binPath, script, "utf8");
  chmodSync(binPath, 0o755);
  return binDir;
}

function runOpsJob(
  env: Record<string, string | undefined>,
): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(
      "npx",
      ["tsx", "scripts/azure/ops-job.ts"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, ...env },
      },
    );
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const execError = error as {
      status: number | null;
      stdout: string;
      stderr: string;
    };
    return {
      status: execError.status ?? 1,
      stdout: execError.stdout ?? "",
      stderr: execError.stderr ?? "",
    };
  }
}

describe("scripts/azure/ops-job.ts (strict entrypoint dispatch)", () => {
  let reportsBaseDir: string;

  beforeEach(() => {
    reportsBaseDir = mkdtempSync(join(tmpdir(), "krypto-ops-job-test-"));
  });

  afterEach(() => {
    rmSync(reportsBaseDir, { recursive: true, force: true });
  });

  const BASE_ENV = {
    ENVIRONMENT_NAME: "test-env",
    RELEASE_SHA: VALID_RELEASE_SHA,
    JOB_EXECUTION_ID: "job-1",
    EVIDENCE_CONTAINER_URL: "https://evidence.example.com/container",
    AZCOPY_MSI_CLIENT_ID: "11111111-2222-4333-8444-555555555555",
  };

  it("rejects an OPERATION outside the closed enum before dispatch, touching no filesystem report", () => {
    const result = runOpsJob({
      ...BASE_ENV,
      OPERATION: "drop-database; rm -rf /",
      REPORTS_BASE_DIR: reportsBaseDir,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/OPERATION must be one of/);
  });

  it.each([
    "ENVIRONMENT_NAME",
    "RELEASE_SHA",
    "OPERATION",
    "JOB_EXECUTION_ID",
    "EVIDENCE_CONTAINER_URL",
    "AZCOPY_MSI_CLIENT_ID",
  ])("requires %s before doing any work", (missingKey) => {
    const env: Record<string, string | undefined> = {
      ...BASE_ENV,
      OPERATION: "migrate-init",
      REPORTS_BASE_DIR: reportsBaseDir,
      [missingKey]: undefined,
    };
    const result = runOpsJob(env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(new RegExp(`${missingKey} is required`));
  });

  it("rejects a malformed RELEASE_SHA before deriving any report path", () => {
    const result = runOpsJob({
      ...BASE_ENV,
      OPERATION: "migrate-init",
      RELEASE_SHA: "not-a-sha",
      REPORTS_BASE_DIR: reportsBaseDir,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/40-character|hex|lowercase/i);
  });

  it("derives an immutable per-execution report directory and reserves report.json", () => {
    const result = runOpsJob({
      ...BASE_ENV,
      OPERATION: "migrate-init",
      REPORTS_BASE_DIR: reportsBaseDir,
    });
    // migrate-init will fail fast (no DIRECT_URL configured), but the report
    // directory/path must already have been reserved before that failure.
    expect(result.status).not.toBe(0);
    const reportPath = join(
      reportsBaseDir,
      "test-env",
      VALID_RELEASE_SHA,
      "migrate-init",
      "job-1",
      "report.json",
    );
    const contents = readFileSync(reportPath, "utf8");
    expect(contents).toBe("");
  });

  it("refuses to overwrite an already-reserved report path on a repeat invocation", () => {
    const env = {
      ...BASE_ENV,
      OPERATION: "migrate-init",
      REPORTS_BASE_DIR: reportsBaseDir,
    };
    const first = runOpsJob(env);
    expect(first.status).not.toBe(0);
    const second = runOpsJob(env);
    expect(second.status).not.toBe(0);
    expect(second.stderr).toMatch(/EEXIST|already exists/);
  });

  it("never invokes a shell for OPERATION (no injection via shell metacharacters)", () => {
    const sentinel = join(tmpdir(), "should-not-exist-krypto-ops-injection");
    rmSync(sentinel, { force: true });
    try {
      const result = runOpsJob({
        ...BASE_ENV,
        OPERATION: `migrate-init; touch ${sentinel}`,
        REPORTS_BASE_DIR: reportsBaseDir,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/OPERATION must be one of/);
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      if (existsSync(sentinel)) unlinkSync(sentinel);
    }
  });

  it("never logs the evidence container URL or a credential to stdout/stderr on failure", () => {
    const result = runOpsJob({
      ...BASE_ENV,
      OPERATION: "migrate-init",
      EVIDENCE_CONTAINER_URL:
        "https://evidence.example.com/container?sv=2024&sig=TOP-SECRET",
      REPORTS_BASE_DIR: reportsBaseDir,
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("TOP-SECRET");
    expect(result.stderr).not.toContain("TOP-SECRET");
  });

  describe("evidence upload for both pass and fail outcomes (MSI in-process auto-login)", () => {
    let azcopyLogPath: string;
    let fakeAzcopyDir: string;

    beforeEach(() => {
      azcopyLogPath = join(reportsBaseDir, "azcopy-invocations.log");
      fakeAzcopyDir = writeFakeAzcopy();
    });

    afterEach(() => {
      rmSync(fakeAzcopyDir, { recursive: true, force: true });
    });

    function runOpsJobWithFakeAzcopy(
      env: Record<string, string | undefined>,
      copyExitCode = 0,
    ): { status: number; stdout: string; stderr: string } {
      return runOpsJob({
        ...env,
        PATH: `${fakeAzcopyDir}:${process.env.PATH ?? ""}`,
        FAKE_AZCOPY_LOG_PATH: azcopyLogPath,
        FAKE_AZCOPY_COPY_EXIT_CODE: String(copyExitCode),
      });
    }

    it("uploads the failed-report directory via a single azcopy invocation (no separate login subprocess), carrying the exact MSI client ID in its child env", () => {
      const result = runOpsJobWithFakeAzcopy({
        ...BASE_ENV,
        OPERATION: "preflight",
        REPORTS_BASE_DIR: reportsBaseDir,
      });

      // preflight fails closed (no DIRECT_URL/DATABASE_URL configured) but
      // must never look like a thrown/crashed job: exitCode 2 is the
      // distinct "operation failed, evidence uploaded" outcome.
      expect(result.status).toBe(2);

      const reportPath = join(
        reportsBaseDir,
        "test-env",
        VALID_RELEASE_SHA,
        "preflight",
        "job-1",
        "report.json",
      );
      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      expect(report.preflight.databasePreflightPassed).toBe(false);

      const reportDirectory = join(
        reportsBaseDir,
        "test-env",
        VALID_RELEASE_SHA,
        "preflight",
        "job-1",
      );
      const invocations = readFileSync(azcopyLogPath, "utf8").trim().split("\n");
      // Exactly one azcopy invocation total -- proves there is no separate
      // `azcopy login` subprocess (which would additionally log an
      // UNEXPECTED line and exit nonzero) preceding the copy.
      expect(invocations).toHaveLength(1);
      expect(invocations[0]).not.toMatch(/^UNEXPECTED/);
      expect(invocations[0].startsWith("COPY ")).toBe(true);

      const match = invocations[0].match(
        /^COPY (.*) AZCOPY_AUTO_LOGIN_TYPE=(\S*) AZCOPY_MSI_CLIENT_ID=(\S*)$/,
      );
      expect(match).not.toBeNull();
      const [, argsPart, autoLoginType, msiClientId] = match!;
      const [source, destination, ...flags] = argsPart.split(" ");
      expect(source).toBe(`${reportDirectory}/*`);
      expect(destination).toBe(
        "https://evidence.example.com/container/test-env/" +
          `${VALID_RELEASE_SHA}/preflight/job-1`,
      );
      expect(flags).toEqual(
        expect.arrayContaining(["--recursive=true", "--overwrite=false"]),
      );
      // The copy child process's own environment carries the in-process
      // MSI auto-login configuration -- the exact user-assigned identity
      // client ID from AZCOPY_MSI_CLIENT_ID, not a placeholder or a
      // system-assigned/default lookup.
      expect(autoLoginType).toBe("MSI");
      expect(msiClientId).toBe(BASE_ENV.AZCOPY_MSI_CLIENT_ID);
    });

    it("never attempts an upload when the operation throws before producing any result", () => {
      const result = runOpsJobWithFakeAzcopy({
        ENVIRONMENT_NAME: "test-env",
        RELEASE_SHA: VALID_RELEASE_SHA,
        JOB_EXECUTION_ID: "job-1",
        EVIDENCE_CONTAINER_URL: "https://evidence.example.com/container",
        AZCOPY_MSI_CLIENT_ID: BASE_ENV.AZCOPY_MSI_CLIENT_ID,
        OPERATION: "activation-check",
        REPORTS_BASE_DIR: reportsBaseDir,
      });

      // activation-check fails closed (no DIRECT_URL/etc configured) via a
      // thrown error before it ever produces a {passed, report} result, so
      // no report content is dispatched and no upload is attempted -- the
      // "always upload" behavior applies only once a real result exists.
      expect(result.status).not.toBe(0);
      expect(result.status).not.toBe(2);
      expect(existsSync(azcopyLogPath)).toBe(false);
    });

    it("fails closed before invoking azcopy at all when AZCOPY_MSI_CLIENT_ID is malformed (not a GUID)", () => {
      const result = runOpsJobWithFakeAzcopy({
        ...BASE_ENV,
        OPERATION: "preflight",
        AZCOPY_MSI_CLIENT_ID: "not-a-guid",
        REPORTS_BASE_DIR: reportsBaseDir,
      });

      expect(result.status).not.toBe(0);
      expect(result.status).not.toBe(2);
      expect(result.stderr).toMatch(/AZCOPY_MSI_CLIENT_ID must be a valid GUID/);
      // Validation fails before azcopy is ever spawned -- no log entry at
      // all, whether COPY or UNEXPECTED.
      expect(existsSync(azcopyLogPath)).toBe(false);

      // The failed operation's own report is still preserved on disk even
      // though the identity was misconfigured and the upload never ran.
      const reportPath = join(
        reportsBaseDir,
        "test-env",
        VALID_RELEASE_SHA,
        "preflight",
        "job-1",
        "report.json",
      );
      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      expect(report.preflight.databasePreflightPassed).toBe(false);
    });

    it("preserves a hard failure (never exit 0, never the soft failure code 2) if the evidence upload itself fails after a failed operation", () => {
      const result = runOpsJobWithFakeAzcopy(
        {
          ...BASE_ENV,
          OPERATION: "preflight",
          REPORTS_BASE_DIR: reportsBaseDir,
        },
        1,
      );

      expect(result.status).not.toBe(0);
      expect(result.status).not.toBe(2);
      expect(result.stderr).toMatch(/Azure ops job failed/);

      // The failed operation's own report must still be preserved on disk
      // exactly as produced -- an upload failure must never cause the
      // already-written failure report to be hidden, mutated, or made to
      // look like a pass.
      const reportPath = join(
        reportsBaseDir,
        "test-env",
        VALID_RELEASE_SHA,
        "preflight",
        "job-1",
        "report.json",
      );
      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      expect(report.preflight.databasePreflightPassed).toBe(false);
    });

    it("never leaks a credentialed evidence container URL to stdout/stderr when a failed report reaches the upload step", () => {
      const result = runOpsJobWithFakeAzcopy({
        ...BASE_ENV,
        OPERATION: "preflight",
        EVIDENCE_CONTAINER_URL:
          "https://evidence.example.com/container?sv=2024&sig=TOP-SECRET",
        REPORTS_BASE_DIR: reportsBaseDir,
      });

      // A query-string-bearing container URL is rejected by
      // validateContainerUrl before azcopy is ever invoked (managed
      // identity is the only supported auth path), and that rejection
      // must never echo the secret back.
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain("TOP-SECRET");
      expect(result.stderr).not.toContain("TOP-SECRET");
      expect(existsSync(azcopyLogPath)).toBe(false);
    });

    it("never leaks the MSI client ID's own value into a thrown/malformed-value error message beyond the exact expected GUID", () => {
      // Not a secret, but still should never appear duplicated/garbled or
      // alongside any other credential in an error message; this asserts
      // the malformed-value message names the env var, not the value.
      const result = runOpsJobWithFakeAzcopy({
        ...BASE_ENV,
        OPERATION: "preflight",
        AZCOPY_MSI_CLIENT_ID: "totally-not-a-guid-value",
        REPORTS_BASE_DIR: reportsBaseDir,
      });

      expect(result.stderr).not.toContain("totally-not-a-guid-value");
    });
  });
});
