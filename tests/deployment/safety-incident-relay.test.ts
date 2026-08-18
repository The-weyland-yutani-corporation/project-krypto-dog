import {
  runSafetyIncidentRelay,
  SAFETY_INCIDENT_EXPORT_PREFIX,
  type SafetyIncidentRelayRow,
} from "@/deployment/safety-incident-relay";

const ROW: SafetyIncidentRelayRow = {
  eventId: "event-1",
  incidentId: "incident-1",
  eventSequence: 2,
  eventKind: "DELIVERY_FAILED",
  incidentType: "POST_COMMIT_FAILURE",
  severity: "CRITICAL",
  status: "OPEN",
  requestId: "request-1",
  agentRunId: "run-1",
  releaseId: "release-1",
  deploymentId: "deployment-1",
  providerAttemptId: "attempt-foundry-1-abcdef",
  transactionId: "trade-1",
  occurredAt: new Date("2026-08-17T20:00:00.000Z"),
  persistedAt: new Date("2026-08-17T20:00:01.000Z"),
  acknowledgedAt: null,
  escalatedAt: null,
  resolvedAt: null,
  deliveryAttemptId: "delivery-attempt-1",
};

describe("independent safety incident relay", () => {
  it("exports only allowlisted latest durable state and a scan heartbeat", async () => {
    const logger = { log: jest.fn() };
    await expect(
      runSafetyIncidentRelay({
        loadLatest: async () => [ROW],
        now: () => new Date("2026-08-17T20:05:00.000Z"),
        logger,
      }),
    ).resolves.toEqual({ exported: 1 });
    const exportLine = logger.log.mock.calls[0]?.[0] as string;
    expect(exportLine.startsWith(SAFETY_INCIDENT_EXPORT_PREFIX)).toBe(true);
    expect(exportLine).toContain('"incidentId":"incident-1"');
    expect(exportLine).toContain('"pendingAgeSeconds":300');
    expect(exportLine).toContain(
      '"deliveryAttemptId":"delivery-attempt-1"',
    );
    expect(exportLine).not.toContain("redactedContext");
    expect(exportLine).not.toContain("evidence");
    expect(logger.log.mock.calls[1]?.[0]).toContain(
      '"eventType":"safety_incident_relay_scan"',
    );
  });

  it("refuses unsafe database values instead of exporting them", async () => {
    await expect(
      runSafetyIncidentRelay({
        loadLatest: async () => [
          { ...ROW, requestId: "https://secret.example.test" },
        ],
        logger: { log: jest.fn() },
      }),
    ).rejects.toThrow("requestId is not a safe structured identifier");
  });
});
