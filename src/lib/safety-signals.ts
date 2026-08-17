import type {
  SafetyIncidentSeverity,
  SafetyIncidentType,
} from "@/lib/safety-incidents";

export interface SafetySignalObservation {
  missingScheduledRun?: boolean;
  routeOrRunError?: boolean;
  deadlineOrBudgetExhausted?: boolean;
  providerFailed?: boolean;
  drawdownLocked?: boolean;
  staleOrOverlappingLease?: boolean;
  reconciliationQuarantined?: boolean;
  unexpectedShadowTrade?: boolean;
  authenticationOrProvenanceMismatch?: boolean;
  credentialConcern?: boolean;
  dailyDeliveryFailed?: boolean;
  journalWritten?: boolean | null;
  postCommitFailurePersisted?: boolean;
  telemetryFailed?: boolean;
  readinessOrCapacityFailed?: boolean;
}

export interface SafetySignal {
  incidentType: SafetyIncidentType;
  severity: SafetyIncidentSeverity;
  reasonCode: string;
}

/**
 * Deterministic mapping shared by source tests and safe drill evidence. Numeric
 * windows/targets remain authoritative only in production-readiness-prd.v1.md;
 * external monitors supply these already-evaluated observations.
 */
export function classifySafetySignals(
  observation: SafetySignalObservation,
): SafetySignal[] {
  const signals: SafetySignal[] = [];
  const add = (
    incidentType: SafetyIncidentType,
    severity: SafetyIncidentSeverity,
    reasonCode: string,
  ) => signals.push({ incidentType, severity, reasonCode });

  if (observation.missingScheduledRun) {
    add("MISSING_RUN", "CRITICAL", "scheduled-run-missing");
  }
  if (observation.routeOrRunError) {
    add("ROUTE_RUN_FAILURE", "CRITICAL", "route-or-run-error");
  }
  if (observation.deadlineOrBudgetExhausted) {
    add(
      "DEADLINE_BUDGET_EXHAUSTION",
      "CRITICAL",
      "deadline-or-budget-exhausted",
    );
  }
  if (observation.providerFailed) {
    add("PROVIDER_FAILURE", "CRITICAL", "provider-failure");
  }
  if (observation.drawdownLocked) {
    add("DRAWDOWN_LOCK", "CRITICAL", "drawdown-lock");
  }
  if (observation.staleOrOverlappingLease) {
    add(
      "STALE_OR_OVERLAPPING_LEASE",
      "CRITICAL",
      "stale-or-overlapping-lease",
    );
  }
  if (observation.reconciliationQuarantined) {
    add(
      "RECONCILIATION_QUARANTINE",
      "CRITICAL",
      "reconciliation-quarantine",
    );
  }
  if (observation.unexpectedShadowTrade) {
    add(
      "UNEXPECTED_SHADOW_TRADE",
      "CRITICAL",
      "unexpected-shadow-trade",
    );
  }
  if (observation.authenticationOrProvenanceMismatch) {
    add(
      "AUTH_PROVENANCE_MISMATCH",
      "CRITICAL",
      "authentication-or-provenance-mismatch",
    );
  }
  if (observation.credentialConcern) {
    add("CREDENTIAL_CONCERN", "CRITICAL", "credential-concern");
  }
  if (observation.dailyDeliveryFailed) {
    add("EMAIL_DELIVERY_FAILURE", "WARNING", "daily-delivery-failure");
  }
  if (observation.journalWritten === false) {
    add("JOURNAL_FAILURE", "CRITICAL", "journal-written-false");
  }
  if (observation.postCommitFailurePersisted) {
    add("POST_COMMIT_FAILURE", "CRITICAL", "post-commit-failure");
  }
  if (observation.telemetryFailed) {
    add("TELEMETRY_FAILURE", "CRITICAL", "telemetry-failure");
  }
  if (observation.readinessOrCapacityFailed) {
    add(
      "READINESS_CAPACITY_FAILURE",
      "WARNING",
      "readiness-or-capacity-failure",
    );
  }

  return signals;
}
