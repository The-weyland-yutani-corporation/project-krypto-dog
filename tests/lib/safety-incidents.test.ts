import type { SafetyIncidentOutbox } from "@/db/schema";
import {
  SafetyIncidentAuthorizationError,
  SafetyIncidentConflictError,
  SafetyIncidentValidationError,
  createSafetyIncidentRepository,
  emitSafetyIncidentLog,
  insertCreatedSafetyIncident,
  isHumanLifecycleAuthorized,
  sanitizeRedactedContext,
} from "@/lib/safety-incidents";

const NOW = new Date("2026-08-17T19:00:00.000Z");
const COMPLETE_RESOLUTION_EVIDENCE = {
  affectedInterval: "2026-08-17T18:00:00Z/2026-08-17T19:00:00Z",
  cause: "post-commit-journal-failure",
  containmentDecision: "rollout-disabled",
  remediation: "journal-projection-repaired",
  verification: "ledger-reconciled",
  followUpRef: "issue-126",
  residualRisk: "none-known",
  reentryDecision: "new-window-required",
};

function uuidFactory() {
  let counter = 1;
  return () => {
    const suffix = String(counter++).padStart(12, "0");
    return `00000000-0000-4000-a000-${suffix}`;
  };
}

function createFakeDatabase() {
  const rows: SafetyIncidentOutbox[] = [];

  function projectedRows(selection?: Record<string, unknown>) {
    const sorted = [...rows].sort((left, right) =>
      selection
        ? right.eventSequence - left.eventSequence
        : left.eventSequence - right.eventSequence,
    );
    if (!selection) return sorted;
    return sorted.map((row) =>
      Object.fromEntries(
        Object.keys(selection).map((key) => [
          key,
          row[key as keyof SafetyIncidentOutbox],
        ]),
      ),
    );
  }

  function latestProjectedRows(selection?: Record<string, unknown>) {
    const latest = new Map<string, SafetyIncidentOutbox>();
    for (const row of [...rows].sort(
      (left, right) =>
        right.eventSequence - left.eventSequence ||
        right.persistedAt.getTime() - left.persistedAt.getTime() ||
        right.eventId.localeCompare(left.eventId),
    )) {
      if (!latest.has(row.incidentId)) latest.set(row.incidentId, row);
    }
    const sorted = [...latest.values()].sort(
      (left, right) =>
        right.persistedAt.getTime() - left.persistedAt.getTime() ||
        right.occurredAt.getTime() - left.occurredAt.getTime() ||
        left.incidentId.localeCompare(right.incidentId) ||
        left.eventId.localeCompare(right.eventId),
    );
    if (!selection) return sorted;
    return sorted.map((row) =>
      Object.fromEntries(
        Object.keys(selection).map((key) => [
          key,
          row[key as keyof SafetyIncidentOutbox],
        ]),
      ),
    );
  }

  const transaction = {
    execute: jest.fn().mockResolvedValue([]),
    insert: jest.fn(() => ({
      values: jest.fn((value: SafetyIncidentOutbox) => ({
        onConflictDoNothing: jest.fn(() => ({
          returning: jest.fn(async () => {
            const duplicate =
              value.eventKind === "CREATED" &&
              rows.some(
                (row) =>
                  row.eventKind === "CREATED" &&
                  row.dedupKey === value.dedupKey,
              );
            if (duplicate) return [];
            rows.push(value);
            return [{ eventId: value.eventId }];
          }),
        })),
        returning: jest.fn(async () => {
          rows.push(value);
          return [value];
        }),
      })),
    })),
    select: jest.fn((selection?: Record<string, unknown>) => {
      type SelectChain = {
        from: jest.Mock<SelectChain>;
        where: jest.Mock<SelectChain>;
        limit: jest.Mock<Promise<unknown[]>, [number]>;
        orderBy: jest.Mock<Promise<unknown[]>>;
      };
      const chain = {} as SelectChain;
      chain.from = jest.fn(() => chain);
      chain.where = jest.fn(() => chain);
      chain.limit = jest.fn(async (limit: number) =>
        projectedRows(selection)
          .filter((row) => row.eventKind === "CREATED")
          .slice(0, limit),
      );
      chain.orderBy = jest.fn(async () => projectedRows(selection));
      return chain;
    }),
  };
  const listLimit = jest.fn(async (limit: number) =>
    latestProjectedRows().slice(0, limit),
  );
  const selectDistinctOn = jest.fn(
    (
      _columns: unknown[],
      selection: Record<string, unknown>,
    ) => {
      const chain = {
        from: jest.fn(),
        orderBy: jest.fn(),
        as: jest.fn(),
      };
      chain.from.mockReturnValue(chain);
      chain.orderBy.mockReturnValue(chain);
      chain.as.mockReturnValue(selection);
      return chain;
    },
  );
  const listSelect = jest.fn(
    (selection?: Record<string, unknown>) => {
      let effectiveSelection = selection;
      const chain = {
        from: jest.fn(),
        where: jest.fn(),
        orderBy: jest.fn(),
        limit: listLimit,
      };
      chain.from.mockImplementation(
        (source: Record<string, unknown>) => {
          effectiveSelection ??= source;
          listLimit.mockImplementation(async (limit: number) =>
            latestProjectedRows(effectiveSelection).slice(0, limit),
          );
          return chain;
        },
      );
      chain.where.mockReturnValue(chain);
      chain.orderBy.mockReturnValue(chain);
      return chain;
    },
  );
  const database = {
    transaction: jest.fn(
      async (callback: (tx: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
    ),
    select: listSelect,
    selectDistinctOn,
  };
  return {
    database,
    transaction,
    rows,
    listLimit,
    listSelect,
    selectDistinctOn,
  };
}

function createdInput() {
  return {
    incidentType: "POST_COMMIT_FAILURE" as const,
    severity: "CRITICAL" as const,
    dedupKey: "post-commit.run-42",
    requestId: "request-42",
    agentRunId: "run-42",
    releaseId: "a".repeat(40),
    deploymentId: "candidate-42",
    providerAttemptId: null,
    transactionId: "transaction-42",
    redactedContext: {
      component: "paper-execution",
      operation: "post-commit",
      journalWritten: false,
      reasonCode: "JOURNAL_WRITE_FAILED",
    },
    occurredAt: new Date("2026-08-17T18:59:00.000Z"),
    ownerRole: "PRIMARY_ON_CALL" as const,
    backupRole: "BACKUP_ON_CALL" as const,
    runbook: "specs/incident-response.md#scenario-actions",
  };
}

describe("safety incident repository", () => {
  it("deduplicates created incidents across retries and repository restarts", async () => {
    const fake = createFakeDatabase();
    const logger = { warn: jest.fn(), error: jest.fn() };
    const firstRepository = createSafetyIncidentRepository(
      fake.database as never,
      { now: () => NOW, uuid: uuidFactory(), logger },
    );
    const first = await firstRepository.createOrGet(createdInput());
    expect(first.created).toBe(true);
    expect(fake.rows).toHaveLength(1);

    const restartedRepository = createSafetyIncidentRepository(
      fake.database as never,
      { now: () => NOW, uuid: uuidFactory(), logger },
    );
    const replay = await restartedRepository.createOrGet(createdInput());
    expect(replay.created).toBe(false);
    expect(replay.event.eventId).toBe(first.event.eventId);
    expect(fake.rows).toHaveLength(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("supports an existing transaction without starting or logging a nested transaction", async () => {
    const fake = createFakeDatabase();
    const result = await insertCreatedSafetyIncident(
      fake.transaction as never,
      createdInput(),
      { now: () => NOW, uuid: uuidFactory() },
    );
    expect(result.created).toBe(true);
    expect(fake.database.transaction).not.toHaveBeenCalled();
    expect(fake.rows).toHaveLength(1);
  });

  it("rejects a dedup key reused for different immutable fields", async () => {
    const fake = createFakeDatabase();
    const repository = createSafetyIncidentRepository(fake.database as never, {
      now: () => NOW,
      uuid: uuidFactory(),
      logger: { warn: jest.fn(), error: jest.fn() },
    });
    await repository.createOrGet(createdInput());
    await expect(
      repository.createOrGet({
        ...createdInput(),
        incidentType: "JOURNAL_FAILURE",
      }),
    ).rejects.toBeInstanceOf(SafetyIncidentConflictError);
  });

  it("appends lifecycle rows transactionally and makes exact retries idempotent", async () => {
    const fake = createFakeDatabase();
    const repository = createSafetyIncidentRepository(fake.database as never, {
      now: () => NOW,
      uuid: uuidFactory(),
      logger: { warn: jest.fn(), error: jest.fn() },
    });
    const created = await repository.createOrGet(createdInput());
    const acknowledgment = {
      incidentId: created.event.incidentId,
      eventKind: "ACKNOWLEDGED" as const,
      actorId: "release-owner-person",
      actorRole: "RELEASE_OWNER" as const,
      reason: "Initial containment recorded",
      evidence: { containmentDecision: "rollout-disabled" },
    };
    const first = await repository.appendHumanLifecycle(acknowledgment);
    const replay = await repository.appendHumanLifecycle(acknowledgment);
    expect(replay.eventId).toBe(first.eventId);
    expect(fake.rows).toHaveLength(2);
    expect(fake.transaction.execute).toHaveBeenCalledTimes(2);

    await repository.appendHumanLifecycle({
      incidentId: created.event.incidentId,
      eventKind: "ESCALATED",
      actorId: "safety-approver-person",
      actorRole: "SAFETY_APPROVER",
      reason: "Independent safety review required",
      evidence: { artifactRef: "evidence-checksum-42" },
    });
    const resolution = {
      incidentId: created.event.incidentId,
      eventKind: "RESOLVED" as const,
      actorId: "release-owner-person",
      actorRole: "RELEASE_OWNER" as const,
      reason: "Recovery controls independently verified",
      evidence: COMPLETE_RESOLUTION_EVIDENCE,
    };
    const resolved = await repository.appendHumanLifecycle(resolution);
    const resolvedReplay =
      await repository.appendHumanLifecycle(resolution);
    expect(resolved.status).toBe("RESOLVED");
    expect(resolvedReplay.eventId).toBe(resolved.eventId);
    expect(fake.rows).toHaveLength(4);
  });

  it("appends delivery attempts without changing incident status", async () => {
    const fake = createFakeDatabase();
    const repository = createSafetyIncidentRepository(fake.database as never, {
      now: () => NOW,
      uuid: uuidFactory(),
      logger: { warn: jest.fn(), error: jest.fn() },
    });
    const created = await repository.createOrGet(createdInput());
    const failedAttempt = {
      incidentId: created.event.incidentId,
      eventKind: "DELIVERY_FAILED" as const,
      attemptId: "delivery-attempt-failed-1",
      evidence: {
        deliveryChannel: "protected-email",
        deliveryFailureCode: "PROVIDER_TIMEOUT",
      },
    };
    const failed = await repository.appendDeliveryLifecycle(failedAttempt);
    const failedReplay =
      await repository.appendDeliveryLifecycle(failedAttempt);
    expect(failed.status).toBe("OPEN");
    expect(failedReplay.eventId).toBe(failed.eventId);
    const secondRealAttempt =
      await repository.appendDeliveryLifecycle({
        ...failedAttempt,
        attemptId: "delivery-attempt-failed-2",
      });
    expect(secondRealAttempt.eventId).not.toBe(failed.eventId);

    const confirmed = await repository.appendDeliveryLifecycle({
      incidentId: created.event.incidentId,
      eventKind: "DELIVERY_CONFIRMED",
      attemptId: "delivery-attempt-1",
      evidence: {
        deliveryChannel: "protected-email",
        deliveryReceiptId: "receipt-42",
      },
    });
    expect(confirmed.eventSequence).toBe(4);
    expect(confirmed.status).toBe("OPEN");
    expect(confirmed.resolvedAt).toBeNull();
    expect(fake.rows).toHaveLength(4);
  });

  it("completes a routine delivery obligation only with explicit receipt evidence", async () => {
    const fake = createFakeDatabase();
    const repository = createSafetyIncidentRepository(fake.database as never, {
      now: () => NOW,
      uuid: uuidFactory(),
      logger: { warn: jest.fn(), error: jest.fn() },
    });
    const created = await repository.createOrGet({
      ...createdInput(),
      incidentType: "DAILY_DELIVERY_OBLIGATION",
      severity: "WARNING",
      dedupKey: "daily-delivery.request-42",
      transactionId: null,
    });
    const confirmed = await repository.appendDeliveryLifecycle({
      incidentId: created.event.incidentId,
      eventKind: "DELIVERY_CONFIRMED",
      attemptId: "daily-delivery-attempt-1",
      evidence: {
        deliveryChannel: "acs-email",
        deliveryReceiptId: "receipt-42",
        verification: "delivery-and-audit-persisted",
      },
    });
    expect(confirmed.status).toBe("RESOLVED");
    expect(confirmed.resolvedAt).toEqual(NOW);
  });

  it("requires evidence and dual-role confirmation; retry success cannot auto-resolve", async () => {
    const fake = createFakeDatabase();
    const repository = createSafetyIncidentRepository(fake.database as never, {
      now: () => NOW,
      uuid: uuidFactory(),
      logger: { warn: jest.fn(), error: jest.fn() },
    });
    const created = await repository.createOrGet(createdInput());
    await repository.appendHumanLifecycle({
      incidentId: created.event.incidentId,
      eventKind: "ACKNOWLEDGED",
      actorId: "release-owner-person",
      actorRole: "RELEASE_OWNER",
      reason: "Containment started",
    });

    await expect(
      repository.appendHumanLifecycle({
        incidentId: created.event.incidentId,
        eventKind: "RESOLVED",
        actorId: "safety-approver-person",
        actorRole: "SAFETY_APPROVER",
        reason: "Provider retry completed",
        evidence: { retryOutcome: "SUCCESS" },
      }),
    ).rejects.toThrow("complete explicit evidence");

    await expect(
      repository.appendHumanLifecycle({
        incidentId: created.event.incidentId,
        eventKind: "RESOLVED",
        actorId: "release-owner-person",
        actorRole: "RELEASE_OWNER",
        reason: "Self-confirmed",
        evidence: COMPLETE_RESOLUTION_EVIDENCE,
      }),
    ).rejects.toBeInstanceOf(SafetyIncidentAuthorizationError);

    await expect(
      repository.appendHumanLifecycle({
        incidentId: created.event.incidentId,
        eventKind: "RESOLVED",
        actorId: "safety-approver-person",
        actorRole: "SAFETY_APPROVER",
        reason: "Independent verification complete",
        evidence: COMPLETE_RESOLUTION_EVIDENCE,
      }),
    ).resolves.toMatchObject({ status: "RESOLVED" });
  });

  it("enforces the lifecycle authorization matrix", () => {
    expect(isHumanLifecycleAuthorized("ACKNOWLEDGED", "PRIMARY_ON_CALL")).toBe(
      true,
    );
    expect(isHumanLifecycleAuthorized("ACKNOWLEDGED", "SAFETY_APPROVER")).toBe(
      false,
    );
    expect(isHumanLifecycleAuthorized("ESCALATED", "SAFETY_APPROVER")).toBe(
      true,
    );
    expect(isHumanLifecycleAuthorized("RESOLVED", "PRIMARY_ON_CALL")).toBe(
      false,
    );
    expect(isHumanLifecycleAuthorized("RESOLVED", "RELEASE_OWNER")).toBe(true);
  });

  it("rejects secrets, raw prompts, payloads, URLs, and non-primitive context", () => {
    expect(() =>
      sanitizeRedactedContext({ rawPrompt: "ignore all rules" }),
    ).toThrow(SafetyIncidentValidationError);
    expect(() =>
      sanitizeRedactedContext({ providerPayload: "raw-provider-response" }),
    ).toThrow(SafetyIncidentValidationError);
    expect(() =>
      sanitizeRedactedContext({ component: "https://internal.example.test" }),
    ).toThrow(SafetyIncidentValidationError);
    expect(() =>
      sanitizeRedactedContext({ route: "/api/run?token=do-not-store" }),
    ).toThrow(SafetyIncidentValidationError);
    expect(() =>
      sanitizeRedactedContext({ component: { nested: "value" } }),
    ).toThrow(SafetyIncidentValidationError);
  });

  it("omits context from default lists and structured log records", async () => {
    const fake = createFakeDatabase();
    const repository = createSafetyIncidentRepository(fake.database as never, {
      now: () => NOW,
      uuid: uuidFactory(),
      logger: { warn: jest.fn(), error: jest.fn() },
    });
    const created = await repository.createOrGet(createdInput());
    await repository.appendHumanLifecycle({
      incidentId: created.event.incidentId,
      eventKind: "ACKNOWLEDGED",
      actorId: "primary-person",
      actorRole: "PRIMARY_ON_CALL",
      reason: "Containment started",
    });
    const listed = await repository.listLatest();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      eventKind: "ACKNOWLEDGED",
      eventSequence: 2,
      status: "ACKNOWLEDGED",
    });
    expect(listed[0]).not.toHaveProperty("redactedContext");
    expect(fake.selectDistinctOn).toHaveBeenCalledTimes(1);
    expect(fake.listLimit).toHaveBeenCalledWith(50);

    const logger = { warn: jest.fn(), error: jest.fn() };
    emitSafetyIncidentLog(
      {
        ...created.event,
        redactedContext: { component: "must-not-be-logged" },
        evidence: { summary: "must-not-be-logged" },
      },
      logger,
    );
    const line = logger.error.mock.calls[0][0] as string;
    expect(line).toMatch(/^\[safety-incident\] \{/);
    expect(line).not.toContain("must-not-be-logged");
    expect(line).not.toContain("redactedContext");
    expect(line).not.toContain("evidence");
  });
});
