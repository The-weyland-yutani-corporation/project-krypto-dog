import {
  evaluateOperationsHealth,
  type OperationsHealthInput,
} from "@/lib/operations-health";

const NOW = new Date("2026-03-22T12:00:00.000Z");

function healthyInput(): OperationsHealthInput {
  return {
    now: NOW,
    rolloutMode: "paper",
    state: {
      lastCompletedRunAt: new Date("2026-03-22T11:00:00.000Z"),
      isRunning: false,
      leaseOwner: null,
      leaseExpiresAt: null,
      accountingStatus: "RECONCILED",
      accountingIssue: null,
    },
    latestRun: {
      marketSnapshot: { observedAt: "2026-03-22T11:00:00.000Z" },
    },
    latestAlert: {
      createdAt: new Date("2026-03-22T08:00:00.000Z"),
      marketConditions: {
        event: "daily-summary-delivery",
        status: "sent",
      },
    },
  };
}

describe("evaluateOperationsHealth", () => {
  it("reports healthy production-paper indicators", () => {
    const health = evaluateOperationsHealth(healthyInput());

    expect(health.schedule.value).toBe("Healthy");
    expect(health.lease.value).toBe("Idle");
    expect(health.marketData.value).toBe("Fresh");
    expect(health.reconciliation.value).toBe("Reconciled");
    expect(health.alertDelivery.value).toBe("Sent");
  });

  it("detects missed runs, stale market data, and a recoverable lease", () => {
    const base = healthyInput();
    const input: OperationsHealthInput = {
      ...base,
      state: {
        ...base.state!,
        lastCompletedRunAt: new Date("2026-03-22T08:00:00.000Z"),
        isRunning: true,
      },
      latestRun: {
        marketSnapshot: {
          observedAt: "2026-03-22T08:00:00.000Z",
        },
      },
    };

    const health = evaluateOperationsHealth(input);

    expect(health.schedule.value).toBe("Missed");
    expect(health.lease.value).toBe("Recoverable");
    expect(health.marketData.value).toBe("Stale");
  });

  it("distinguishes disabled mode from missing operational evidence", () => {
    const health = evaluateOperationsHealth({
      now: NOW,
      rolloutMode: "disabled",
      state: null,
      latestRun: null,
      latestAlert: null,
    });

    expect(health.schedule.value).toBe("Disabled");
    expect(health.marketData.value).toBe("Disabled");
    expect(health.lease.value).toBe("Unknown");
    expect(health.alertDelivery.value).toBe("Unknown");
  });

  it("surfaces quarantine and alert-delivery failure", () => {
    const base = healthyInput();
    const input: OperationsHealthInput = {
      ...base,
      state: {
        ...base.state!,
        accountingStatus: "QUARANTINED",
        accountingIssue: "Ledger mismatch",
      },
      latestAlert: {
        ...base.latestAlert!,
        marketConditions: {
          event: "daily-summary-delivery",
          status: "failed",
        },
      },
    };

    const health = evaluateOperationsHealth(input);

    expect(health.reconciliation).toMatchObject({
      value: "Quarantined",
      detail: "Ledger mismatch",
      tone: "destructive",
    });
    expect(health.alertDelivery).toMatchObject({
      value: "Failed",
      tone: "destructive",
    });
  });
});
