import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  safetyIncidentOutbox,
  safetyIncidentTypeEnum,
  type SafetyIncidentOutbox,
} from "@/db/schema";
import {
  assertSafeStructuredId,
  generateCorrelationId,
} from "@/lib/correlation";
import {
  SAFETY_ACTOR_ROLES,
  type SafetyActorRole,
} from "@/lib/safety-roster";

export const SAFETY_INCIDENT_LOG_PREFIX = "[safety-incident]";
export const SAFETY_INCIDENT_TYPES = safetyIncidentTypeEnum.enumValues;
export const SAFETY_INCIDENT_EVENT_KINDS = [
  "CREATED",
  "ACKNOWLEDGED",
  "ESCALATED",
  "RESOLVED",
  "DELIVERY_CONFIRMED",
  "DELIVERY_FAILED",
] as const;
export const SAFETY_INCIDENT_SEVERITIES = ["WARNING", "CRITICAL"] as const;
export const SAFETY_INCIDENT_STATUSES = [
  "OPEN",
  "ACKNOWLEDGED",
  "ESCALATED",
  "RESOLVED",
] as const;

export type SafetyIncidentType = (typeof SAFETY_INCIDENT_TYPES)[number];
export type SafetyIncidentEventKind =
  (typeof SAFETY_INCIDENT_EVENT_KINDS)[number];
export type SafetyIncidentSeverity =
  (typeof SAFETY_INCIDENT_SEVERITIES)[number];
export type SafetyIncidentStatus = (typeof SAFETY_INCIDENT_STATUSES)[number];
export type SafetyIncidentLifecycleKind = Exclude<
  SafetyIncidentEventKind,
  "CREATED"
>;
export type SafetyIncidentHumanLifecycleKind = Extract<
  SafetyIncidentLifecycleKind,
  "ACKNOWLEDGED" | "ESCALATED" | "RESOLVED"
>;
export type SafetyIncidentDeliveryKind = Extract<
  SafetyIncidentLifecycleKind,
  "DELIVERY_CONFIRMED" | "DELIVERY_FAILED"
>;

export type RedactedPrimitive = string | number | boolean | null;
export type RedactedContext = Record<string, RedactedPrimitive>;
export type SafetyIncidentEvidence = Record<string, RedactedPrimitive>;

const REDACTED_CONTEXT_KEYS = new Set([
  "accountingStatus",
  "attempt",
  "component",
  "deliveryChannel",
  "drill",
  "environment",
  "expectedRunSlot",
  "failureCode",
  "httpStatus",
  "journalWritten",
  "leaseAgeSeconds",
  "locked",
  "operation",
  "outcome",
  "provider",
  "reasonCode",
  "reconciled",
  "rolloutMode",
  "route",
  "scenario",
  "triggerSource",
]);

const EVIDENCE_KEYS = new Set([
  "affectedInterval",
  "artifactRef",
  "cause",
  "contactPath",
  "containmentDecision",
  "deliveryChannel",
  "deliveryFailureCode",
  "deliveryReceiptId",
  "deliveryAttemptId",
  "drillScenario",
  "followUpRef",
  "reentryDecision",
  "remediation",
  "residualRisk",
  "retryOutcome",
  "summary",
  "verification",
]);

const SENSITIVE_KEY_PATTERN =
  /(?:secret|token|password|credential|connection|string|prompt|payload|response|body|url|uri|header|cookie|authorization|leaseowner)/i;
const UNSAFE_VALUE_PATTERN =
  /(?:https?:\/\/|postgres(?:ql)?:\/\/|bearer\s|-----BEGIN|(?:password|secret|token|api[_-]?key|sig)=|(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9]|eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.)/i;
const SAFE_DEDUP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SAFE_RUNBOOK_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/#-]{0,199}$/;
const SAFE_ACTOR_PATTERN = /^[^\r\n\u0000-\u001f\u007f]{1,120}$/;
const MAX_REDACTED_STRING_LENGTH = 240;
const MAX_REDACTED_NUMBER = 1_000_000_000;
const COMPLEMENTARY_RESOLUTION_ROLES = new Map<
  SafetyActorRole,
  SafetyActorRole
>([
  ["RELEASE_OWNER", "SAFETY_APPROVER"],
  ["SAFETY_APPROVER", "RELEASE_OWNER"],
]);

type SafetyIncidentDatabase = typeof db;
export type SafetyIncidentTransaction = Parameters<
  Parameters<SafetyIncidentDatabase["transaction"]>[0]
>[0];

export class SafetyIncidentValidationError extends Error {
  readonly code = "SAFETY_INCIDENT_VALIDATION";
}

export class SafetyIncidentNotFoundError extends Error {
  readonly code = "SAFETY_INCIDENT_NOT_FOUND";
}

export class SafetyIncidentConflictError extends Error {
  readonly code = "SAFETY_INCIDENT_CONFLICT";
}

export class SafetyIncidentAuthorizationError extends Error {
  readonly code = "SAFETY_INCIDENT_FORBIDDEN";
}

export interface CreateSafetyIncidentInput {
  incidentType: SafetyIncidentType;
  severity: SafetyIncidentSeverity;
  dedupKey: string;
  requestId: string;
  agentRunId?: string | null;
  releaseId: string;
  deploymentId: string;
  providerAttemptId?: string | null;
  transactionId?: string | null;
  redactedContext: unknown;
  occurredAt?: Date;
  ownerRole: SafetyActorRole;
  backupRole: SafetyActorRole;
  runbook: string;
  actorId?: string | null;
  actorRole?: SafetyActorRole | null;
  evidence?: unknown;
}

export interface CreateSafetyIncidentResult {
  event: SafetyIncidentOutbox;
  created: boolean;
}

export interface AppendHumanLifecycleInput {
  incidentId: string;
  eventKind: SafetyIncidentHumanLifecycleKind;
  actorId: string;
  actorRole: SafetyActorRole;
  reason: string;
  evidence?: unknown;
}

export interface AppendDeliveryLifecycleInput {
  incidentId: string;
  eventKind: SafetyIncidentDeliveryKind;
  attemptId: string;
  evidence: unknown;
  actorId?: string;
  actorRole?: SafetyActorRole;
}

export interface ListSafetyIncidentsOptions {
  limit?: number;
  severity?: SafetyIncidentSeverity;
  status?: SafetyIncidentStatus;
  includeContext?: boolean;
}

export interface SafetyIncidentListItem {
  eventId: string;
  incidentId: string;
  eventSequence: number;
  eventKind: SafetyIncidentEventKind;
  incidentType: SafetyIncidentType;
  severity: SafetyIncidentSeverity;
  status: SafetyIncidentStatus;
  requestId: string;
  agentRunId: string | null;
  releaseId: string;
  deploymentId: string;
  providerAttemptId: string | null;
  transactionId: string | null;
  occurredAt: Date;
  persistedAt: Date;
  acknowledgedAt: Date | null;
  resolvedAt: Date | null;
  escalatedAt: Date | null;
  ownerRole: string;
  backupRole: string;
  runbook: string;
  actorRole: string | null;
  redactedContext?: RedactedContext;
}

export interface SafetyIncidentRepository {
  createOrGet(
    input: CreateSafetyIncidentInput,
  ): Promise<CreateSafetyIncidentResult>;
  appendHumanLifecycle(
    input: AppendHumanLifecycleInput,
  ): Promise<SafetyIncidentOutbox>;
  appendDeliveryLifecycle(
    input: AppendDeliveryLifecycleInput,
  ): Promise<SafetyIncidentOutbox>;
  listLatest(
    options?: ListSafetyIncidentsOptions,
  ): Promise<SafetyIncidentListItem[]>;
}

interface SafetyIncidentDependencies {
  now?: () => Date;
  uuid?: () => string;
  logger?: Pick<Console, "error" | "warn">;
}

interface LifecycleAppendResult {
  event: SafetyIncidentOutbox;
  appended: boolean;
}

const HUMAN_LIFECYCLE_AUTHORIZATION: Record<
  SafetyIncidentHumanLifecycleKind,
  readonly SafetyActorRole[]
> = {
  ACKNOWLEDGED: ["PRIMARY_ON_CALL", "BACKUP_ON_CALL", "RELEASE_OWNER"],
  ESCALATED: [
    "PRIMARY_ON_CALL",
    "BACKUP_ON_CALL",
    "RELEASE_OWNER",
    "SAFETY_APPROVER",
  ],
  RESOLVED: ["RELEASE_OWNER", "SAFETY_APPROVER"],
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function validatePrimitive(
  value: unknown,
  key: string,
): RedactedPrimitive {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Math.abs(value) > MAX_REDACTED_NUMBER) {
      throw new SafetyIncidentValidationError(
        `${key} must be a bounded finite number`,
      );
    }
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (
      !trimmed ||
      trimmed.length > MAX_REDACTED_STRING_LENGTH ||
      /[\r\n\u0000-\u001f\u007f]/.test(trimmed) ||
      UNSAFE_VALUE_PATTERN.test(trimmed)
    ) {
      throw new SafetyIncidentValidationError(
        `${key} must be a bounded redacted string`,
      );
    }
    return trimmed;
  }
  throw new SafetyIncidentValidationError(
    `${key} must be a primitive redacted value`,
  );
}

function sanitizeAllowlistedRecord(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  fieldName: string,
): Record<string, RedactedPrimitive> {
  if (!isPlainRecord(value)) {
    throw new SafetyIncidentValidationError(
      `${fieldName} must be a plain object`,
    );
  }
  const entries = Object.entries(value);
  if (entries.length > 24) {
    throw new SafetyIncidentValidationError(
      `${fieldName} contains too many fields`,
    );
  }

  const sanitized: Record<string, RedactedPrimitive> = {};
  for (const [key, rawValue] of entries.sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!allowedKeys.has(key) || SENSITIVE_KEY_PATTERN.test(key)) {
      throw new SafetyIncidentValidationError(
        `${fieldName}.${key} is not allowlisted`,
      );
    }
    sanitized[key] = validatePrimitive(rawValue, `${fieldName}.${key}`);
  }
  return sanitized;
}

export function sanitizeRedactedContext(value: unknown): RedactedContext {
  return sanitizeAllowlistedRecord(
    value,
    REDACTED_CONTEXT_KEYS,
    "redactedContext",
  );
}

export function sanitizeSafetyEvidence(
  value: unknown,
): SafetyIncidentEvidence {
  return sanitizeAllowlistedRecord(value, EVIDENCE_KEYS, "evidence");
}

function validateActorId(actorId: string): string {
  const value = actorId.trim();
  if (
    !SAFE_ACTOR_PATTERN.test(value) ||
    value.includes("://") ||
    UNSAFE_VALUE_PATTERN.test(value)
  ) {
    throw new SafetyIncidentValidationError(
      "actorId must be a bounded protected roster assignment",
    );
  }
  return value;
}

function validateReason(reason: string): string {
  const value = reason.trim();
  if (
    value.length < 3 ||
    value.length > MAX_REDACTED_STRING_LENGTH ||
    /[\r\n\u0000-\u001f\u007f]/.test(value) ||
    UNSAFE_VALUE_PATTERN.test(value)
  ) {
    throw new SafetyIncidentValidationError(
      "reason must be a bounded redacted explanation",
    );
  }
  return value;
}

function validateCorrelationField(value: string, fieldName: string): void {
  try {
    assertSafeStructuredId(value, fieldName);
  } catch {
    throw new SafetyIncidentValidationError(
      `${fieldName} must be an allowlisted structured identifier`,
    );
  }
}

function validateCreatedInput(
  input: CreateSafetyIncidentInput,
  defaultOccurredAt: Date,
): {
  redactedContext: RedactedContext;
  occurredAt: Date;
} {
  if (!SAFETY_INCIDENT_TYPES.includes(input.incidentType)) {
    throw new SafetyIncidentValidationError("incidentType is not allowlisted");
  }
  if (!SAFETY_INCIDENT_SEVERITIES.includes(input.severity)) {
    throw new SafetyIncidentValidationError("severity is not allowlisted");
  }
  if (
    !SAFE_DEDUP_PATTERN.test(input.dedupKey) ||
    SENSITIVE_KEY_PATTERN.test(input.dedupKey)
  ) {
    throw new SafetyIncidentValidationError(
      "dedupKey must be an allowlisted identifier",
    );
  }
  validateCorrelationField(input.requestId, "requestId");
  validateCorrelationField(input.releaseId, "releaseId");
  validateCorrelationField(input.deploymentId, "deploymentId");
  if (input.agentRunId) {
    validateCorrelationField(input.agentRunId, "agentRunId");
  }
  if (input.providerAttemptId) {
    validateCorrelationField(input.providerAttemptId, "providerAttemptId");
  }
  if (input.transactionId) {
    validateCorrelationField(input.transactionId, "transactionId");
  }
  if (!SAFETY_ACTOR_ROLES.includes(input.ownerRole)) {
    throw new SafetyIncidentValidationError("ownerRole is not allowlisted");
  }
  if (!SAFETY_ACTOR_ROLES.includes(input.backupRole)) {
    throw new SafetyIncidentValidationError("backupRole is not allowlisted");
  }
  if (
    input.ownerRole === input.backupRole ||
    !SAFE_RUNBOOK_PATTERN.test(input.runbook)
  ) {
    throw new SafetyIncidentValidationError(
      "incident owner, backup, or runbook is invalid",
    );
  }
  const occurredAt = input.occurredAt ?? defaultOccurredAt;
  if (Number.isNaN(occurredAt.getTime())) {
    throw new SafetyIncidentValidationError("occurredAt must be a valid date");
  }
  return {
    redactedContext: sanitizeRedactedContext(input.redactedContext),
    occurredAt,
  };
}

function immutableCreatedFieldsMatch(
  existing: SafetyIncidentOutbox,
  input: CreateSafetyIncidentInput,
  redactedContext: RedactedContext,
  evidence: SafetyIncidentEvidence | null,
  occurredAt: Date,
): boolean {
  return (
    existing.incidentType === input.incidentType &&
    existing.severity === input.severity &&
    existing.requestId === input.requestId &&
    existing.agentRunId === (input.agentRunId ?? null) &&
    existing.releaseId === input.releaseId &&
    existing.deploymentId === input.deploymentId &&
    existing.providerAttemptId === (input.providerAttemptId ?? null) &&
    existing.transactionId === (input.transactionId ?? null) &&
    existing.ownerRole === input.ownerRole &&
    existing.backupRole === input.backupRole &&
    existing.runbook === input.runbook &&
    existing.actorId === (input.actorId ?? null) &&
    existing.actorRole === (input.actorRole ?? null) &&
    (input.occurredAt === undefined ||
      existing.occurredAt.getTime() === occurredAt.getTime()) &&
    JSON.stringify(canonicalPrimitiveRecord(existing.redactedContext)) ===
      JSON.stringify(canonicalPrimitiveRecord(redactedContext)) &&
    JSON.stringify(canonicalPrimitiveRecord(existing.evidence)) ===
      JSON.stringify(canonicalPrimitiveRecord(evidence))
  );
}

function canonicalPrimitiveRecord(
  value: unknown,
): Record<string, RedactedPrimitive> | null {
  if (value === null) return null;
  if (!isPlainRecord(value)) return null;
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  ) as Record<string, RedactedPrimitive>;
}

/**
 * Insert the initial obligation inside an existing transaction. This helper
 * intentionally does not log: the caller's transaction may still roll back.
 */
export async function insertCreatedSafetyIncident(
  transaction: SafetyIncidentTransaction,
  input: CreateSafetyIncidentInput,
  dependencies: Pick<SafetyIncidentDependencies, "now" | "uuid"> = {},
): Promise<CreateSafetyIncidentResult> {
  const now = dependencies.now?.() ?? new Date();
  const { redactedContext, occurredAt } = validateCreatedInput(input, now);
  const actorId = input.actorId ? validateActorId(input.actorId) : null;
  const actorRole = input.actorRole ?? null;
  if (actorRole && !SAFETY_ACTOR_ROLES.includes(actorRole)) {
    throw new SafetyIncidentValidationError("actorRole is not allowlisted");
  }
  if ((actorId === null) !== (actorRole === null)) {
    throw new SafetyIncidentValidationError(
      "created incident actorId and actorRole must be supplied together",
    );
  }
  const evidence =
    input.evidence === undefined
      ? null
      : sanitizeSafetyEvidence(input.evidence);
  if (occurredAt.getTime() > now.getTime()) {
    throw new SafetyIncidentValidationError(
      "occurredAt cannot be later than persistence time",
    );
  }

  const incidentId = generateCorrelationId(dependencies.uuid ?? randomUUID);
  const eventId = generateCorrelationId(dependencies.uuid ?? randomUUID);
  const inserted = await transaction
    .insert(safetyIncidentOutbox)
    .values({
      eventId,
      incidentId,
      eventSequence: 1,
      eventKind: "CREATED",
      incidentType: input.incidentType,
      severity: input.severity,
      status: "OPEN",
      dedupKey: input.dedupKey,
      requestId: input.requestId,
      agentRunId: input.agentRunId ?? null,
      releaseId: input.releaseId,
      deploymentId: input.deploymentId,
      providerAttemptId: input.providerAttemptId ?? null,
      transactionId: input.transactionId ?? null,
      redactedContext,
      occurredAt,
      persistedAt: now,
      acknowledgedAt: null,
      resolvedAt: null,
      escalatedAt: null,
      ownerRole: input.ownerRole,
      backupRole: input.backupRole,
      runbook: input.runbook,
      actorId,
      actorRole,
      evidence,
    })
    .onConflictDoNothing()
    .returning({ eventId: safetyIncidentOutbox.eventId });

  const [createdOrExisting] = await transaction
    .select()
    .from(safetyIncidentOutbox)
    .where(
      and(
        eq(safetyIncidentOutbox.dedupKey, input.dedupKey),
        eq(safetyIncidentOutbox.eventKind, "CREATED"),
      ),
    )
    .limit(1);
  if (!createdOrExisting) {
    throw new SafetyIncidentConflictError(
      "Created incident could not be recovered after deduplication",
    );
  }
  if (
    !immutableCreatedFieldsMatch(
      createdOrExisting,
      input,
      redactedContext,
      evidence,
      occurredAt,
    )
  ) {
    throw new SafetyIncidentConflictError(
      "dedupKey is already bound to different immutable incident fields",
    );
  }
  return {
    event: createdOrExisting,
    created: inserted.some((row) => row.eventId === eventId),
  };
}

export function isHumanLifecycleAuthorized(
  eventKind: SafetyIncidentHumanLifecycleKind,
  actorRole: SafetyActorRole,
): boolean {
  return HUMAN_LIFECYCLE_AUTHORIZATION[eventKind].includes(actorRole);
}

export function assertHumanLifecycleAuthorized(
  eventKind: SafetyIncidentHumanLifecycleKind,
  actorRole: SafetyActorRole,
): void {
  if (!isHumanLifecycleAuthorized(eventKind, actorRole)) {
    throw new SafetyIncidentAuthorizationError(
      `${actorRole} cannot append ${eventKind}`,
    );
  }
}

function operationIdFor(input: {
  incidentId: string;
  eventKind: SafetyIncidentLifecycleKind;
  actorId: string | null;
  actorRole: SafetyActorRole | null;
  attemptId: string | null;
  evidence: SafetyIncidentEvidence;
}): string {
  return createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex");
}

function evidenceWithOperationId(
  evidence: SafetyIncidentEvidence,
  operationId: string,
): SafetyIncidentEvidence {
  return { ...evidence, operationId };
}

function isIdempotentEvent(
  event: SafetyIncidentOutbox,
  eventKind: SafetyIncidentLifecycleKind,
  operationId: string,
): boolean {
  return (
    event.eventKind === eventKind &&
    isPlainRecord(event.evidence) &&
    event.evidence.operationId === operationId
  );
}

function requireResolutionEvidence(evidence: SafetyIncidentEvidence): void {
  const requiredKeys = [
    "affectedInterval",
    "cause",
    "containmentDecision",
    "remediation",
    "verification",
    "followUpRef",
    "residualRisk",
    "reentryDecision",
  ];
  if (
    !requiredKeys.every(
      (key) =>
        typeof evidence[key] === "string" &&
        (evidence[key] as string).trim() !== "",
    )
  ) {
    throw new SafetyIncidentValidationError(
      `resolution requires complete explicit evidence: ${requiredKeys.join(", ")}`,
    );
  }
}

function requireDualRoleResolution(
  history: SafetyIncidentOutbox[],
  actorId: string,
  actorRole: SafetyActorRole,
): void {
  const complementaryRole = COMPLEMENTARY_RESOLUTION_ROLES.get(actorRole);
  if (!complementaryRole) {
    throw new SafetyIncidentAuthorizationError(
      "resolution requires the release owner and safety approver",
    );
  }
  const complementaryConfirmation = history.some(
    (event) =>
      (event.eventKind === "ACKNOWLEDGED" ||
        event.eventKind === "ESCALATED") &&
      event.actorRole === complementaryRole &&
      event.actorId !== null &&
      event.actorId !== actorId &&
      isHumanLifecycleAuthorized(event.eventKind, complementaryRole),
  );
  if (!complementaryConfirmation) {
    throw new SafetyIncidentAuthorizationError(
      `resolution requires prior ${complementaryRole} confirmation by a distinct actor`,
    );
  }
}

function lifecycleStatus(
  eventKind: SafetyIncidentLifecycleKind,
  currentStatus: SafetyIncidentStatus,
  incidentType: SafetyIncidentType,
): SafetyIncidentStatus {
  switch (eventKind) {
    case "ACKNOWLEDGED":
      if (currentStatus !== "OPEN") {
        throw new SafetyIncidentConflictError(
          "only an open incident can be acknowledged",
        );
      }
      return "ACKNOWLEDGED";
    case "ESCALATED":
      if (currentStatus !== "OPEN" && currentStatus !== "ACKNOWLEDGED") {
        throw new SafetyIncidentConflictError(
          "only an open or acknowledged incident can be escalated",
        );
      }
      return "ESCALATED";
    case "RESOLVED":
      if (
        currentStatus !== "ACKNOWLEDGED" &&
        currentStatus !== "ESCALATED"
      ) {
        throw new SafetyIncidentConflictError(
          "only an acknowledged or escalated incident can be resolved",
        );
      }
      return "RESOLVED";
    case "DELIVERY_CONFIRMED":
      return incidentType === "PAPER_TRADE_POST_COMMIT" ||
        incidentType === "DAILY_DELIVERY_OBLIGATION"
        ? "RESOLVED"
        : currentStatus;
    case "DELIVERY_FAILED":
      return currentStatus;
  }
}

async function appendLifecycleInTransaction(
  transaction: SafetyIncidentTransaction,
  input:
    | AppendHumanLifecycleInput
    | AppendDeliveryLifecycleInput,
  dependencies: Required<Pick<SafetyIncidentDependencies, "now" | "uuid">>,
): Promise<LifecycleAppendResult> {
  validateCorrelationField(input.incidentId, "incidentId");
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtext(${input.incidentId}))`,
  );
  const history = await transaction
    .select()
    .from(safetyIncidentOutbox)
    .where(eq(safetyIncidentOutbox.incidentId, input.incidentId))
    .orderBy(asc(safetyIncidentOutbox.eventSequence));
  const latest = history.at(-1);
  if (!latest) {
    throw new SafetyIncidentNotFoundError("Safety incident was not found");
  }

  let actorId: string | null = null;
  let actorRole: SafetyActorRole | null = null;
  let sanitizedEvidence: SafetyIncidentEvidence;
  if (
    input.eventKind === "ACKNOWLEDGED" ||
    input.eventKind === "ESCALATED" ||
    input.eventKind === "RESOLVED"
  ) {
    actorId = validateActorId(input.actorId);
    actorRole = input.actorRole;
    assertHumanLifecycleAuthorized(input.eventKind, actorRole);
    sanitizedEvidence = {
      ...sanitizeSafetyEvidence(input.evidence ?? {}),
      reason: validateReason(input.reason),
    };
    if (input.eventKind === "RESOLVED") {
      requireResolutionEvidence(sanitizedEvidence);
      requireDualRoleResolution(history, actorId, actorRole);
    }
  } else {
    actorId = input.actorId ? validateActorId(input.actorId) : null;
    actorRole = input.actorRole ?? null;
    if ((actorId === null) !== (actorRole === null)) {
      throw new SafetyIncidentValidationError(
        "delivery actorId and actorRole must be supplied together",
      );
    }
    sanitizedEvidence = sanitizeSafetyEvidence(input.evidence);
  }

  const operationId = operationIdFor({
    incidentId: input.incidentId,
    eventKind: input.eventKind,
    actorId,
    actorRole,
    attemptId:
      "attemptId" in input
        ? assertSafeStructuredId(input.attemptId, "attemptId")
        : null,
    evidence: sanitizedEvidence,
  });
  const existing = history.find((event) =>
    isIdempotentEvent(event, input.eventKind, operationId),
  );
  if (existing) return { event: existing, appended: false };

  const status = lifecycleStatus(
    input.eventKind,
    latest.status,
    latest.incidentType,
  );
  const now = dependencies.now();
  if (
    Number.isNaN(now.getTime()) ||
    now.getTime() < latest.occurredAt.getTime() ||
    now.getTime() < latest.persistedAt.getTime()
  ) {
    throw new SafetyIncidentValidationError(
      "lifecycle persistence time must be monotonic",
    );
  }
  const event: typeof safetyIncidentOutbox.$inferInsert = {
    eventId: generateCorrelationId(dependencies.uuid),
    incidentId: latest.incidentId,
    eventSequence: latest.eventSequence + 1,
    eventKind: input.eventKind,
    incidentType: latest.incidentType,
    severity: latest.severity,
    status,
    dedupKey: latest.dedupKey,
    requestId: latest.requestId,
    agentRunId: latest.agentRunId,
    releaseId: latest.releaseId,
    deploymentId: latest.deploymentId,
    providerAttemptId: latest.providerAttemptId,
    transactionId: latest.transactionId,
    redactedContext: latest.redactedContext,
    occurredAt: latest.occurredAt,
    persistedAt: now,
    acknowledgedAt:
      input.eventKind === "ACKNOWLEDGED" ? now : latest.acknowledgedAt,
    escalatedAt:
      input.eventKind === "ESCALATED" ? now : latest.escalatedAt,
    resolvedAt:
      input.eventKind === "RESOLVED" ||
      (input.eventKind === "DELIVERY_CONFIRMED" &&
        status === "RESOLVED")
        ? now
        : latest.resolvedAt,
    ownerRole: latest.ownerRole,
    backupRole: latest.backupRole,
    runbook: latest.runbook,
    actorId,
    actorRole,
    evidence: evidenceWithOperationId(
      "attemptId" in input
        ? { ...sanitizedEvidence, deliveryAttemptId: input.attemptId }
        : sanitizedEvidence,
      operationId,
    ),
  };
  const [inserted] = await transaction
    .insert(safetyIncidentOutbox)
    .values(event)
    .returning();
  if (!inserted) {
    throw new SafetyIncidentConflictError(
      "Safety incident lifecycle event was not appended",
    );
  }
  return { event: inserted, appended: true };
}

const LIST_PROJECTION = {
  eventId: safetyIncidentOutbox.eventId,
  incidentId: safetyIncidentOutbox.incidentId,
  eventSequence: safetyIncidentOutbox.eventSequence,
  eventKind: safetyIncidentOutbox.eventKind,
  incidentType: safetyIncidentOutbox.incidentType,
  severity: safetyIncidentOutbox.severity,
  status: safetyIncidentOutbox.status,
  requestId: safetyIncidentOutbox.requestId,
  agentRunId: safetyIncidentOutbox.agentRunId,
  releaseId: safetyIncidentOutbox.releaseId,
  deploymentId: safetyIncidentOutbox.deploymentId,
  providerAttemptId: safetyIncidentOutbox.providerAttemptId,
  transactionId: safetyIncidentOutbox.transactionId,
  occurredAt: safetyIncidentOutbox.occurredAt,
  persistedAt: safetyIncidentOutbox.persistedAt,
  acknowledgedAt: safetyIncidentOutbox.acknowledgedAt,
  resolvedAt: safetyIncidentOutbox.resolvedAt,
  escalatedAt: safetyIncidentOutbox.escalatedAt,
  ownerRole: safetyIncidentOutbox.ownerRole,
  backupRole: safetyIncidentOutbox.backupRole,
  runbook: safetyIncidentOutbox.runbook,
  actorRole: safetyIncidentOutbox.actorRole,
};

export function emitSafetyIncidentLog(
  event: SafetyIncidentOutbox,
  logger: Pick<Console, "error" | "warn"> = console,
): void {
  const record = JSON.stringify({
    eventId: event.eventId,
    incidentId: event.incidentId,
    eventSequence: event.eventSequence,
    eventKind: event.eventKind,
    incidentType: event.incidentType,
    severity: event.severity,
    status: event.status,
    requestId: event.requestId,
    agentRunId: event.agentRunId,
    releaseId: event.releaseId,
    deploymentId: event.deploymentId,
    providerAttemptId: event.providerAttemptId,
    transactionId: event.transactionId,
    occurredAt: event.occurredAt.toISOString(),
    persistedAt: event.persistedAt.toISOString(),
  });
  const line = `${SAFETY_INCIDENT_LOG_PREFIX} ${record}`;
  if (event.severity === "CRITICAL") {
    logger.error(line);
  } else {
    logger.warn(line);
  }
}

export function createSafetyIncidentRepository(
  database: SafetyIncidentDatabase = db,
  dependencies: SafetyIncidentDependencies = {},
): SafetyIncidentRepository {
  const now = dependencies.now ?? (() => new Date());
  const uuid = dependencies.uuid ?? randomUUID;
  const logger = dependencies.logger ?? console;

  return {
    async createOrGet(input) {
      const result = await database.transaction((transaction) =>
        insertCreatedSafetyIncident(transaction, input, { now, uuid }),
      );
      if (result.created) emitSafetyIncidentLog(result.event, logger);
      return result;
    },

    async appendHumanLifecycle(input) {
      const result = await database.transaction((transaction) =>
        appendLifecycleInTransaction(transaction, input, { now, uuid }),
      );
      if (result.appended) emitSafetyIncidentLog(result.event, logger);
      return result.event;
    },

    async appendDeliveryLifecycle(input) {
      const result = await database.transaction((transaction) =>
        appendLifecycleInTransaction(transaction, input, { now, uuid }),
      );
      if (result.appended) emitSafetyIncidentLog(result.event, logger);
      return result.event;
    },

    async listLatest(options = {}) {
      const limit = options.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new SafetyIncidentValidationError(
          "list limit must be from 1 through 100",
        );
      }
      if (
        options.severity &&
        !SAFETY_INCIDENT_SEVERITIES.includes(options.severity)
      ) {
        throw new SafetyIncidentValidationError(
          "list severity is not allowlisted",
        );
      }
      if (
        options.status &&
        !SAFETY_INCIDENT_STATUSES.includes(options.status)
      ) {
        throw new SafetyIncidentValidationError(
          "list status is not allowlisted",
        );
      }

      const rows = options.includeContext
        ? await database
            .select({
              ...LIST_PROJECTION,
              redactedContext: safetyIncidentOutbox.redactedContext,
            })
            .from(safetyIncidentOutbox)
            .orderBy(
              desc(safetyIncidentOutbox.persistedAt),
              desc(safetyIncidentOutbox.eventSequence),
            )
        : await database
            .select(LIST_PROJECTION)
            .from(safetyIncidentOutbox)
            .orderBy(
              desc(safetyIncidentOutbox.persistedAt),
              desc(safetyIncidentOutbox.eventSequence),
            );

      const latestByIncident = new Map<string, SafetyIncidentListItem>();
      for (const row of rows) {
        if (!latestByIncident.has(row.incidentId)) {
          latestByIncident.set(
            row.incidentId,
            row as SafetyIncidentListItem,
          );
        }
      }
      return [...latestByIncident.values()]
        .filter(
          (row) =>
            (!options.severity || row.severity === options.severity) &&
            (!options.status || row.status === options.status),
        )
        .slice(0, limit);
    },
  };
}

export const safetyIncidentRepository = createSafetyIncidentRepository();
