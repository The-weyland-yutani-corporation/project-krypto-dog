export type HealthTone =
  | "default"
  | "success"
  | "warning"
  | "destructive"
  | "info";

export interface HealthIndicator {
  value: string;
  detail: string;
  tone: HealthTone;
}

interface OperationsState {
  lastCompletedRunAt: Date | null;
  isRunning: boolean;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  accountingStatus: string;
  accountingIssue: string | null;
}

interface LatestRun {
  marketSnapshot: unknown;
}

interface LatestAlert {
  createdAt: Date;
  marketConditions: unknown;
}

export interface OperationsHealthInput {
  now: Date;
  rolloutMode: string;
  state: OperationsState | null;
  latestRun: LatestRun | null;
  latestAlert: LatestAlert | null;
}

export interface OperationsHealth {
  schedule: HealthIndicator;
  lease: HealthIndicator;
  marketData: HealthIndicator;
  reconciliation: HealthIndicator;
  alertDelivery: HealthIndicator;
}

const RUN_GRACE_MS = 2 * 60 * 60 * 1000;
const MARKET_DATA_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const ALERT_MAX_AGE_MS = 36 * 60 * 60 * 1000;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function ageLabel(now: Date, timestamp: Date): string {
  const ageMs = Math.max(0, now.getTime() - timestamp.getTime());
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function evaluateOperationsHealth(
  input: OperationsHealthInput,
): OperationsHealth {
  const { now, rolloutMode, state, latestRun, latestAlert } = input;
  const disabled = rolloutMode.toLowerCase() === "disabled";

  const schedule: HealthIndicator = disabled
    ? {
        value: "Disabled",
        detail: "Scheduled trading is intentionally disabled",
        tone: "info",
      }
    : !state?.lastCompletedRunAt
      ? {
          value: "Unknown",
          detail: "No completed run has been recorded",
          tone: "warning",
        }
      : now.getTime() - state.lastCompletedRunAt.getTime() > RUN_GRACE_MS
        ? {
            value: "Missed",
            detail: `Last completed run ${ageLabel(now, state.lastCompletedRunAt)}`,
            tone: "destructive",
          }
        : {
            value: "Healthy",
            detail: `Last completed run ${ageLabel(now, state.lastCompletedRunAt)}`,
            tone: "success",
          };

  let lease: HealthIndicator;
  if (!state) {
    lease = {
      value: "Unknown",
      detail: "Agent state is unavailable",
      tone: "warning",
    };
  } else if (state.isRunning) {
    const leaseExpiresAt = state.leaseExpiresAt;
    const active =
      state.leaseOwner !== null &&
      leaseExpiresAt !== null &&
      leaseExpiresAt > now;
    lease = active
      ? {
          value: "Active",
          detail: `Lease expires ${leaseExpiresAt.toLocaleTimeString()}`,
          tone: "info",
        }
      : {
          value: "Recoverable",
          detail: "Run flag has no active owned lease",
          tone: "destructive",
        };
  } else if (state.leaseOwner !== null || state.leaseExpiresAt !== null) {
    lease = {
      value: "Stale",
      detail: "Lease metadata remains while no run is active",
      tone: "warning",
    };
  } else {
    lease = {
      value: "Idle",
      detail: "No run lease is held",
      tone: "success",
    };
  }

  const observedAt = parseDate(record(latestRun?.marketSnapshot)?.observedAt);
  const marketData: HealthIndicator = disabled
    ? {
        value: "Disabled",
        detail: "No fresh market snapshot is required in disabled mode",
        tone: "info",
      }
    : !observedAt
      ? {
          value: "Unknown",
          detail: "Latest run has no valid market observation",
          tone: "warning",
        }
      : now.getTime() - observedAt.getTime() > MARKET_DATA_MAX_AGE_MS
        ? {
            value: "Stale",
            detail: `Latest observation ${ageLabel(now, observedAt)}`,
            tone: "destructive",
          }
        : {
            value: "Fresh",
            detail: `Latest observation ${ageLabel(now, observedAt)}`,
            tone: "success",
          };

  const reconciliation: HealthIndicator =
    state?.accountingStatus === "RECONCILED"
      ? {
          value: "Reconciled",
          detail: "Materialized balances match the immutable ledger",
          tone: "success",
        }
      : state?.accountingStatus === "QUARANTINED"
        ? {
            value: "Quarantined",
            detail: state.accountingIssue ?? "Accounting review required",
            tone: "destructive",
          }
        : {
            value: state?.accountingStatus ?? "Unknown",
            detail: state?.accountingIssue ?? "Reconciliation is not proven",
            tone: "warning",
          };

  const alertRecord = record(latestAlert?.marketConditions);
  const alertStatus =
    typeof alertRecord?.status === "string" ? alertRecord.status : null;
  let alertDelivery: HealthIndicator;
  if (!latestAlert || !alertStatus) {
    alertDelivery = {
      value: "Unknown",
      detail: "No daily-summary delivery result is recorded",
      tone: "warning",
    };
  } else if (
    now.getTime() - latestAlert.createdAt.getTime() >
    ALERT_MAX_AGE_MS
  ) {
    alertDelivery = {
      value: "Stale",
      detail: `Last delivery result ${ageLabel(now, latestAlert.createdAt)}`,
      tone: "warning",
    };
  } else if (alertStatus === "sent") {
    alertDelivery = {
      value: "Sent",
      detail: `Last delivery ${ageLabel(now, latestAlert.createdAt)}`,
      tone: "success",
    };
  } else if (alertStatus === "skipped") {
    alertDelivery = {
      value: "Skipped",
      detail: `Email configuration incomplete; checked ${ageLabel(now, latestAlert.createdAt)}`,
      tone: "warning",
    };
  } else {
    alertDelivery = {
      value: "Failed",
      detail: `Last delivery failure ${ageLabel(now, latestAlert.createdAt)}`,
      tone: "destructive",
    };
  }

  return {
    schedule,
    lease,
    marketData,
    reconciliation,
    alertDelivery,
  };
}
