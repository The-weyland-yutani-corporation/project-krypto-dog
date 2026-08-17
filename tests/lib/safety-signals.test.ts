import { classifySafetySignals } from "@/lib/safety-signals";

describe("independent safety signal classification", () => {
  it.each([
    ["missingScheduledRun", "MISSING_RUN"],
    ["providerFailed", "PROVIDER_FAILURE"],
    ["drawdownLocked", "DRAWDOWN_LOCK"],
    ["staleOrOverlappingLease", "STALE_OR_OVERLAPPING_LEASE"],
    ["reconciliationQuarantined", "RECONCILIATION_QUARANTINE"],
    ["unexpectedShadowTrade", "UNEXPECTED_SHADOW_TRADE"],
    [
      "authenticationOrProvenanceMismatch",
      "AUTH_PROVENANCE_MISMATCH",
    ],
    ["credentialConcern", "CREDENTIAL_CONCERN"],
    ["postCommitFailurePersisted", "POST_COMMIT_FAILURE"],
    ["telemetryFailed", "TELEMETRY_FAILURE"],
  ] as const)("maps %s to durable critical %s evidence", (field, type) => {
    expect(classifySafetySignals({ [field]: true })).toEqual([
      expect.objectContaining({
        incidentType: type,
        severity: "CRITICAL",
      }),
    ]);
  });

  it("classifies journal, daily delivery, deadline, route, and readiness independently", () => {
    expect(
      classifySafetySignals({
        journalWritten: false,
        dailyDeliveryFailed: true,
        deadlineOrBudgetExhausted: true,
        routeOrRunError: true,
        readinessOrCapacityFailed: true,
      }),
    ).toEqual([
      {
        incidentType: "ROUTE_RUN_FAILURE",
        severity: "CRITICAL",
        reasonCode: "route-or-run-error",
      },
      {
        incidentType: "DEADLINE_BUDGET_EXHAUSTION",
        severity: "CRITICAL",
        reasonCode: "deadline-or-budget-exhausted",
      },
      {
        incidentType: "EMAIL_DELIVERY_FAILURE",
        severity: "WARNING",
        reasonCode: "daily-delivery-failure",
      },
      {
        incidentType: "JOURNAL_FAILURE",
        severity: "CRITICAL",
        reasonCode: "journal-written-false",
      },
      {
        incidentType: "READINESS_CAPACITY_FAILURE",
        severity: "WARNING",
        reasonCode: "readiness-or-capacity-failure",
      },
    ]);
  });

  it("does not invent an incident from a healthy observation", () => {
    expect(
      classifySafetySignals({
        journalWritten: true,
      }),
    ).toEqual([]);
  });
});
