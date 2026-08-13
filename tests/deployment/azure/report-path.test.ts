import { sep } from "node:path";

import {
  AZURE_OPERATIONS,
  deriveEvidenceDestinationPrefix,
  deriveReportDirectory,
  isAzureOperation,
  validateEnvironmentName,
  validateJobExecutionId,
  validateOperation,
} from "../../../scripts/azure/lib/report-path";

const VALID_RELEASE_SHA = "a".repeat(40);

describe("scripts/azure/lib/report-path", () => {
  describe("validateEnvironmentName", () => {
    it("accepts a lowercase alphanumeric/hyphen name", () => {
      expect(validateEnvironmentName("prod-eastus")).toBe("prod-eastus");
    });

    it.each([
      ["", "empty"],
      ["A", "uppercase"],
      ["1prod", "leading digit"],
      ["p", "too short"],
      ["p".repeat(33), "too long"],
      ["prod_eastus", "underscore"],
      ["prod eastus", "space"],
      ["../etc", "path traversal"],
    ])("rejects %s (%s)", (value) => {
      expect(() => validateEnvironmentName(value)).toThrow();
    });
  });

  describe("validateJobExecutionId", () => {
    it("accepts a bounded alphanumeric/dot/dash/underscore id", () => {
      expect(validateJobExecutionId("job-2024.01.01_1")).toBe(
        "job-2024.01.01_1",
      );
    });

    it.each([
      ["", "empty"],
      ["/etc/passwd", "absolute path"],
      ["a".repeat(65), "too long"],
      ["job id", "space"],
      ["../job", "path traversal"],
    ])("rejects %s (%s)", (value) => {
      expect(() => validateJobExecutionId(value)).toThrow();
    });
  });

  describe("isAzureOperation / validateOperation", () => {
    it("accepts every member of the closed enum", () => {
      for (const operation of AZURE_OPERATIONS) {
        expect(isAzureOperation(operation)).toBe(true);
        expect(validateOperation(operation)).toBe(operation);
      }
    });

    it("rejects an operation outside the closed enum", () => {
      expect(isAzureOperation("delete-everything")).toBe(false);
      expect(() => validateOperation("delete-everything")).toThrow(
        /OPERATION must be one of/,
      );
    });

    it("rejects an empty operation", () => {
      expect(() => validateOperation("")).toThrow();
    });
  });

  describe("deriveReportDirectory", () => {
    it("derives a deterministic path from the four validated inputs", () => {
      const directory = deriveReportDirectory({
        environmentName: "prod-eastus",
        releaseSha: VALID_RELEASE_SHA,
        operation: "target-smoke",
        jobExecutionId: "job-1",
        baseDirectory: "/tmp/ops-reports",
      });
      expect(directory).toBe(
        ["", "tmp", "ops-reports", "prod-eastus", VALID_RELEASE_SHA, "target-smoke", "job-1"].join(
          sep,
        ),
      );
    });

    it("is stable for identical inputs (deterministic, not random)", () => {
      const input = {
        environmentName: "prod-eastus",
        releaseSha: VALID_RELEASE_SHA,
        operation: "activation-check",
        jobExecutionId: "job-42",
        baseDirectory: "/tmp/ops-reports",
      };
      expect(deriveReportDirectory(input)).toBe(deriveReportDirectory(input));
    });

    it("rejects a malformed release SHA before deriving any path", () => {
      expect(() =>
        deriveReportDirectory({
          environmentName: "prod-eastus",
          releaseSha: "not-a-sha",
          operation: "preflight",
          jobExecutionId: "job-1",
          baseDirectory: "/tmp/ops-reports",
        }),
      ).toThrow();
    });

    it("rejects a path-traversal attempt smuggled through jobExecutionId", () => {
      expect(() =>
        deriveReportDirectory({
          environmentName: "prod-eastus",
          releaseSha: VALID_RELEASE_SHA,
          operation: "preflight",
          jobExecutionId: "../../etc",
          baseDirectory: "/tmp/ops-reports",
        }),
      ).toThrow();
    });

    it("rejects a path-traversal attempt smuggled through environmentName", () => {
      expect(() =>
        deriveReportDirectory({
          environmentName: "../etc",
          releaseSha: VALID_RELEASE_SHA,
          operation: "preflight",
          jobExecutionId: "job-1",
          baseDirectory: "/tmp/ops-reports",
        }),
      ).toThrow();
    });

    it("rejects an operation outside the closed enum", () => {
      expect(() =>
        deriveReportDirectory({
          environmentName: "prod-eastus",
          releaseSha: VALID_RELEASE_SHA,
          operation: "drop-database",
          jobExecutionId: "job-1",
          baseDirectory: "/tmp/ops-reports",
        }),
      ).toThrow();
    });

    it("defaults the base directory to <cwd>/ops-reports when omitted", () => {
      const directory = deriveReportDirectory({
        environmentName: "prod-eastus",
        releaseSha: VALID_RELEASE_SHA,
        operation: "preflight",
        jobExecutionId: "job-1",
      });
      expect(directory).toContain(`${sep}ops-reports${sep}`);
      expect(directory.endsWith(["prod-eastus", VALID_RELEASE_SHA, "preflight", "job-1"].join(sep))).toBe(
        true,
      );
    });
  });

  describe("deriveEvidenceDestinationPrefix", () => {
    it("joins the four validated inputs with forward slashes regardless of OS path separator", () => {
      const prefix = deriveEvidenceDestinationPrefix({
        environmentName: "prod-eastus",
        releaseSha: VALID_RELEASE_SHA,
        operation: "verified-backup",
        jobExecutionId: "job-1",
      });
      expect(prefix).toBe(
        `prod-eastus/${VALID_RELEASE_SHA}/verified-backup/job-1`,
      );
    });

    it("produces unique destinations for distinct inputs (no execution can collide)", () => {
      const base = {
        environmentName: "prod-eastus",
        releaseSha: VALID_RELEASE_SHA,
        operation: "verified-backup" as const,
        jobExecutionId: "job-1",
      };
      const variants = [
        base,
        { ...base, jobExecutionId: "job-2" },
        { ...base, releaseSha: "b".repeat(40) },
        { ...base, operation: "target-smoke" as const },
        { ...base, environmentName: "staging-eastus" },
      ];
      const prefixes = variants.map((input) =>
        deriveEvidenceDestinationPrefix(input),
      );
      expect(new Set(prefixes).size).toBe(prefixes.length);
    });

    it("rejects a malformed release SHA before deriving a destination", () => {
      expect(() =>
        deriveEvidenceDestinationPrefix({
          environmentName: "prod-eastus",
          releaseSha: "not-a-sha",
          operation: "verified-backup",
          jobExecutionId: "job-1",
        }),
      ).toThrow();
    });

    it("rejects an operation outside the closed enum", () => {
      expect(() =>
        deriveEvidenceDestinationPrefix({
          environmentName: "prod-eastus",
          releaseSha: VALID_RELEASE_SHA,
          operation: "drop-database",
          jobExecutionId: "job-1",
        }),
      ).toThrow();
    });

    it("rejects a path-traversal attempt smuggled through jobExecutionId", () => {
      expect(() =>
        deriveEvidenceDestinationPrefix({
          environmentName: "prod-eastus",
          releaseSha: VALID_RELEASE_SHA,
          operation: "verified-backup",
          jobExecutionId: "../../etc",
        }),
      ).toThrow();
    });
  });
});
