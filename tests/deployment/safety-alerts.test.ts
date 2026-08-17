import fs from "node:fs";

describe("Azure independent safety alert contract", () => {
  const safety = fs.readFileSync(
    "infra/modules/safety-alerts.bicep",
    "utf8",
  );
  const missing = fs.readFileSync(
    "infra/modules/missing-hourly-success-alert.bicep",
    "utf8",
  );
  const monitoring = fs.readFileSync(
    "infra/modules/monitoring.bicep",
    "utf8",
  );
  const relayMissing = fs.readFileSync(
    "infra/modules/safety-relay-missing-alert.bicep",
    "utf8",
  );

  it.each([
    "route-run-deadline-budget",
    "drawdown-lock",
    "stale-overlapping-lease",
    "reconciliation-quarantine",
    "unexpected-shadow-trade",
    "auth-provenance-credential",
    "daily-delivery-failure",
    "critical-daily-delivery-failure",
    "journal-written-false",
    "persisted-post-commit-failure",
    "readiness-capacity",
    "sustained-readiness-critical",
    "critical-ack-escalation",
    "warning-ack-escalation",
    "warning-test-fire",
    "critical-test-fire",
  ])("declares the %s alert", (signal) => {
    expect(safety).toContain(`key: '${signal}'`);
  });

  it("declares a release-bound relay absence alert including zero-history", () => {
    expect(relayMissing).toContain("safety-relay-missing");
    expect(relayMissing).toContain("RelayEnabledAt");
    expect(relayMissing).toContain("RecentCompleted == 0");
    expect(relayMissing).not.toContain("EverSeen > 0");
    expect(relayMissing).toContain("autoMitigate: false");
  });

  it("queries external logs and durable incident markers rather than process liveness", () => {
    expect(safety).toContain("ContainerAppConsoleLogs_CL");
    expect(safety).toContain("ContainerAppSystemLogs_CL");
    expect(safety).toContain("[safety-incident]");
    expect(safety).toContain("[safety-incident-export]");
    expect(safety).toContain("parse_json");
    expect(safety).toContain("arg_max(TimeGenerated, *)");
    expect(safety).not.toMatch(/\bHeartbeat\b/);
    expect(missing).toContain('Reason_s == "Completed"');
  });

  it("makes ownership, dedup, acknowledgment, escalation, and runbook executable metadata", () => {
    for (const property of [
      "ownerRole",
      "backupRole",
      "deduplication",
      "acknowledgmentTarget",
      "escalationAfter",
      "runbook",
    ]) {
      expect(safety).toContain(property);
      expect(missing).toContain(property);
      expect(monitoring).toContain(property);
      expect(relayMissing).toContain(property);
    }
    expect(safety).toContain("autoMitigate: false");
    expect(missing).toContain("autoMitigate: false");
    expect(monitoring).toContain("autoMitigate: false");
  });
});
