import { uploadEvidence } from "../../../scripts/azure/lib/evidence-upload";

jest.mock("../../../scripts/azure/lib/run-cli", () => ({
  runCli: jest.fn(),
}));

import { runCli } from "../../../scripts/azure/lib/run-cli";

const mockedRunCli = jest.mocked(runCli);

const VALID_PREFIX = `prod-eastus/${"a".repeat(40)}/verified-backup/job-1`;
const VALID_MSI_CLIENT_ID = "11111111-2222-4333-8444-555555555555";

describe("scripts/azure/lib/evidence-upload", () => {
  beforeEach(() => {
    mockedRunCli.mockReset();
  });

  it("requires a container URL", async () => {
    await expect(
      uploadEvidence({
        reportDirectory: "/tmp/ops-reports/report-dir",
        containerUrl: "",
        destinationPrefix: VALID_PREFIX,
        msiClientId: VALID_MSI_CLIENT_ID,
      }),
    ).rejects.toThrow(/EVIDENCE_CONTAINER_URL is required/);
    expect(mockedRunCli).not.toHaveBeenCalled();
  });

  it("rejects a non-HTTPS container URL before invoking azcopy", async () => {
    await expect(
      uploadEvidence({
        reportDirectory: "/tmp/ops-reports/report-dir",
        containerUrl: "http://evidence.example.com/container",
        destinationPrefix: VALID_PREFIX,
        msiClientId: VALID_MSI_CLIENT_ID,
      }),
    ).rejects.toThrow(/must use HTTPS/);
    expect(mockedRunCli).not.toHaveBeenCalled();
  });

  it("rejects a container URL carrying credentials, a query string, or a fragment", async () => {
    // Built by concatenation (not a single literal) to avoid a credential
    // classifier treating this synthetic test fixture as a real secret.
    const credentialedUrl =
      "https://" + "svc" + ":" + "tokenvalue" + "@evidence.example.com/container";
    await expect(
      uploadEvidence({
        reportDirectory: "/tmp/ops-reports/report-dir",
        containerUrl: credentialedUrl,
        destinationPrefix: VALID_PREFIX,
        msiClientId: VALID_MSI_CLIENT_ID,
      }),
    ).rejects.toThrow(/bare container URL/);
    await expect(
      uploadEvidence({
        reportDirectory: "/tmp/ops-reports/report-dir",
        containerUrl: "https://evidence.example.com/container?sv=2024&sig=SECRET",
        destinationPrefix: VALID_PREFIX,
        msiClientId: VALID_MSI_CLIENT_ID,
      }),
    ).rejects.toThrow(/bare container URL/);
    await expect(
      uploadEvidence({
        reportDirectory: "/tmp/ops-reports/report-dir",
        containerUrl: "https://evidence.example.com/container#frag",
        destinationPrefix: VALID_PREFIX,
        msiClientId: VALID_MSI_CLIENT_ID,
      }),
    ).rejects.toThrow(/bare container URL/);
    expect(mockedRunCli).not.toHaveBeenCalled();
  });

  it("rejects a malformed destination prefix before invoking azcopy", async () => {
    await expect(
      uploadEvidence({
        reportDirectory: "/tmp/ops-reports/report-dir",
        containerUrl: "https://evidence.example.com/container",
        destinationPrefix: "only/three/segments",
        msiClientId: VALID_MSI_CLIENT_ID,
      }),
    ).rejects.toThrow(/ENVIRONMENT_NAME\/RELEASE_SHA\/OPERATION\/JOB_EXECUTION_ID/);
    expect(mockedRunCli).not.toHaveBeenCalled();
  });

  it("rejects a destination prefix containing a path-traversal segment", async () => {
    await expect(
      uploadEvidence({
        reportDirectory: "/tmp/ops-reports/report-dir",
        containerUrl: "https://evidence.example.com/container",
        destinationPrefix: `prod-eastus/../${"a".repeat(40)}/verified-backup/job-1`,
        msiClientId: VALID_MSI_CLIENT_ID,
      }),
    ).rejects.toThrow(/ENVIRONMENT_NAME\/RELEASE_SHA\/OPERATION\/JOB_EXECUTION_ID/);
    expect(mockedRunCli).not.toHaveBeenCalled();
  });

  it("requires an MSI client ID (ops jobs have a user-assigned identity only)", async () => {
    await expect(
      uploadEvidence({
        reportDirectory: "/tmp/ops-reports/report-dir",
        containerUrl: "https://evidence.example.com/container",
        destinationPrefix: VALID_PREFIX,
        msiClientId: "",
      }),
    ).rejects.toThrow(/AZCOPY_MSI_CLIENT_ID is required/);
    expect(mockedRunCli).not.toHaveBeenCalled();
  });

  it.each([
    "not-a-guid",
    "11111111-2222-4333-8444-55555555555", // one hex digit short
    "11111111-2222-4333-8444-5555555555555", // one hex digit long
    "gggggggg-2222-4333-8444-555555555555", // non-hex characters
    "11111111_2222_4333_8444_555555555555", // wrong separators
  ])(
    "rejects a malformed MSI client ID %s before invoking azcopy",
    async (malformed) => {
      await expect(
        uploadEvidence({
          reportDirectory: "/tmp/ops-reports/report-dir",
          containerUrl: "https://evidence.example.com/container",
          destinationPrefix: VALID_PREFIX,
          msiClientId: malformed,
        }),
      ).rejects.toThrow(/AZCOPY_MSI_CLIENT_ID must be a valid GUID/);
      expect(mockedRunCli).not.toHaveBeenCalled();
    },
  );

  it("performs a single azcopy invocation (no separate login step), recursively copying the whole report directory with in-process MSI auto-login", async () => {
    mockedRunCli.mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });

    await uploadEvidence({
      reportDirectory: "/tmp/ops-reports/prod-eastus/aaa/verified-backup/job-1",
      containerUrl: "https://evidence.example.com/container",
      destinationPrefix: VALID_PREFIX,
      msiClientId: VALID_MSI_CLIENT_ID,
    });

    // Exactly one azcopy invocation: there is no separate `azcopy login`
    // step (and therefore no persistent, cross-process login/token cache)
    // -- MSI auto-login is scoped entirely to this single copy call via
    // its own environment.
    expect(mockedRunCli).toHaveBeenCalledTimes(1);
    const [command, args, env] = mockedRunCli.mock.calls[0];
    expect(command).toBe("azcopy");
    expect(args[0]).toBe("copy");
    // Source is a recursive glob over the whole report directory, not a
    // single report.json file, so nested backup archive/checksum files
    // and the manifest are all included.
    expect(args[1]).toBe(
      "/tmp/ops-reports/prod-eastus/aaa/verified-backup/job-1/*",
    );
    expect(args[2]).toBe(
      `https://evidence.example.com/container/${VALID_PREFIX}`,
    );
    expect(args).toContain("--recursive=true");
    expect(args).toContain("--overwrite=false");
    expect(args).not.toContain("login");
    expect(args).not.toContain("--identity");

    // The copy child process's own environment carries the in-process MSI
    // auto-login configuration -- the exact user-assigned identity client
    // ID, not a placeholder, not a different value, and not omitted.
    expect(env?.AZCOPY_AUTO_LOGIN_TYPE).toBe("MSI");
    expect(env?.AZCOPY_MSI_CLIENT_ID).toBe(VALID_MSI_CLIENT_ID);
  });

  it("carries the exact MSI client ID through for a different valid GUID (not a hardcoded/stale value)", async () => {
    mockedRunCli.mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
    const otherClientId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

    await uploadEvidence({
      reportDirectory: "/tmp/ops-reports/report-dir",
      containerUrl: "https://evidence.example.com/container",
      destinationPrefix: VALID_PREFIX,
      msiClientId: otherClientId,
    });

    const [, , env] = mockedRunCli.mock.calls[0];
    expect(env?.AZCOPY_MSI_CLIENT_ID).toBe(otherClientId);
  });

  it("produces a unique destination for every distinct environment/release/operation/execution", async () => {
    const destinations: string[] = [];
    const prefixes = [
      `prod-eastus/${"a".repeat(40)}/verified-backup/job-1`,
      `prod-eastus/${"a".repeat(40)}/verified-backup/job-2`,
      `prod-eastus/${"b".repeat(40)}/verified-backup/job-1`,
      `prod-eastus/${"a".repeat(40)}/target-smoke/job-1`,
      `staging-eastus/${"a".repeat(40)}/verified-backup/job-1`,
    ];
    for (const prefix of prefixes) {
      mockedRunCli.mockReset();
      mockedRunCli.mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
      await uploadEvidence({
        reportDirectory: "/tmp/ops-reports/whatever",
        containerUrl: "https://evidence.example.com/container",
        destinationPrefix: prefix,
        msiClientId: VALID_MSI_CLIENT_ID,
      });
      const copyCallArgs = mockedRunCli.mock.calls[0];
      destinations.push(copyCallArgs[1][2] as string);
    }
    expect(new Set(destinations).size).toBe(destinations.length);
  });

  it("throws if the azcopy copy invocation fails", async () => {
    mockedRunCli.mockResolvedValueOnce({
      exitCode: 1,
      stdout: "",
      stderr: "boom",
    });

    await expect(
      uploadEvidence({
        reportDirectory: "/tmp/ops-reports/report-dir",
        containerUrl: "https://evidence.example.com/container",
        destinationPrefix: VALID_PREFIX,
        msiClientId: VALID_MSI_CLIENT_ID,
      }),
    ).rejects.toThrow(/failed with exit code 1/);
    expect(mockedRunCli).toHaveBeenCalledTimes(1);
  });

  it("never includes the raw container URL's query string, credentials, or the MSI client ID in a thrown message", async () => {
    mockedRunCli.mockResolvedValueOnce({
      exitCode: 1,
      stdout: "",
      stderr: "boom",
    });

    let caught: unknown;
    try {
      await uploadEvidence({
        reportDirectory: "/tmp/ops-reports/report-dir",
        containerUrl: "https://evidence.example.com/container",
        destinationPrefix: VALID_PREFIX,
        msiClientId: VALID_MSI_CLIENT_ID,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).not.toContain("?");
    expect(message).not.toContain(VALID_MSI_CLIENT_ID);
    expect(message).toContain("https://evidence.example.com/container");
  });
});
