import { createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";

export const WORKFLOW_OBSERVATION_ISSUER = "https://token.actions.githubusercontent.com";
export const WORKFLOW_OBSERVATION_PATH = ".github/workflows/azure-deploy-prod.yml";
export const WORKFLOW_OBSERVATION_MAX_AGE_MS = 180_000;
export const WORKFLOW_OBSERVATION_MAX_BYTES = 16_384;
export const SCHEDULE_OBSERVATION_MAX_AGE_MS = 4_800_000;

export class WorkflowObservationError extends Error {
  override name = "WorkflowObservationError";
}

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const identifier = z.string().regex(/^[1-9][0-9]{0,19}$/);
const executionId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/);
const timestamp = z.iso.datetime({ precision: 3 });
const origin = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && !url.username && !url.password;
  } catch {
    return false;
  }
}, "An exact HTTPS origin is required.");
const resourceId = z.string().regex(
  /^\/subscriptions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/resourceGroups\/[A-Za-z0-9_.()-]{1,90}\/providers\/Microsoft\.App\/(?:containerApps|jobs)\/[a-z][a-z0-9-]{0,31}$/i,
);

export const workflowObservationTrustSchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  repositoryId: identifier,
  repositoryOwnerId: identifier,
}).strict();

export type WorkflowObservationTrust = z.infer<typeof workflowObservationTrustSchema>;

const observationBase = z.object({
  schemaVersion: z.literal(1),
  workflow: workflowObservationTrustSchema.extend({
    sha,
    runId: identifier,
    runAttempt: z.number().int().positive().safe(),
  }),
  observedAt: timestamp,
  completedAt: timestamp,
  operationExecutionId: executionId,
  releaseSha: sha,
  imageDigest: digest,
  opsImageDigest: digest,
  targetOrigin: origin,
  resources: z.object({
    web: resourceId,
    hourly: resourceId,
    daily: resourceId,
    ops: resourceId,
  }).strict().superRefine((resources, context) => {
    const values = Object.values(resources).map((id) => id.toLowerCase());
    const scopes = values.map((id) => id.split("/providers/")[0]);
    if (!resources.web.toLowerCase().includes("/containerapps/") ||
        ![resources.hourly, resources.daily, resources.ops].every((id) => id.toLowerCase().includes("/jobs/")) ||
        new Set(values).size !== 4 || new Set(scopes).size !== 1) {
      context.addIssue({ code: "custom", message: "Observation resources must be distinct, correctly typed and in one Azure resource group." });
    }
  }),
});

export const cutoverObservationSchema = observationBase.extend({
  purpose: z.literal("cutover-release"),
  owner: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  sourceReleaseSha: sha,
  candidateReleaseSha: sha,
  sourceImageDigest: digest,
  revision: z.string().regex(/^[a-z0-9][a-z0-9-]{0,95}$/),
  rolloutMode: z.literal("disabled"),
  hourlyTriggerType: z.literal("Manual"),
  dailyTriggerType: z.literal("Manual"),
  inactiveRevisionsQuiescent: z.literal(true),
  schedulerExecutionsQuiescent: z.literal(true),
}).strict();

export const scheduledExecutionObservationSchema = observationBase.extend({
  purpose: z.literal("scheduled-execution"),
  authorizationId: z.string().regex(/^[0-9a-f]{64}$/),
  scheduleGeneration: z.number().int().positive().max(9_999_999_999),
  scheduleEnabledAt: timestamp,
  revision: cutoverObservationSchema.shape.revision,
  rolloutMode: z.literal("paper"),
  hourlyTriggerType: z.literal("Schedule"),
  dailyTriggerType: z.literal("Schedule"),
  hourlyCron: z.literal("0 * * * *"),
  dailyCron: z.literal("5 0 * * *"),
  inactiveRevisionsQuiescent: z.literal(true),
  originAssurance: z.literal("schedule-observed-not-origin-proven"),
  execution: z.object({
    id: z.string().max(512),
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/),
    status: z.literal("Succeeded"),
    startedAt: timestamp,
    completedAt: timestamp,
    imageDigest: digest,
    templateDigest: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict(),
}).strict().superRefine((observation, context) => {
  const enabled = Date.parse(observation.scheduleEnabledAt);
  const started = Date.parse(observation.execution.startedAt);
  const ended = Date.parse(observation.execution.completedAt);
  const observed = Date.parse(observation.observedAt);
  const firstWindow = (Math.floor(enabled / 3_600_000) + 1) * 3_600_000;
  if (observation.execution.id.toLowerCase() !==
        `${observation.resources.hourly}/executions/${observation.execution.name}`.toLowerCase() ||
      observation.execution.imageDigest !== observation.imageDigest ||
      enabled < observation.scheduleGeneration * 1000 || enabled > observed ||
      observed - enabled > SCHEDULE_OBSERVATION_MAX_AGE_MS ||
      Math.floor(started / 3_600_000) * 3_600_000 !== firstWindow ||
      ended < started || ended > observed) {
    context.addIssue({
      code: "custom",
      message: "Scheduled observation must bind the exact job, image and completed first full UTC-hour execution after verified enablement.",
    });
  }
});

export const workflowObservationSchema = z.discriminatedUnion("purpose", [
  cutoverObservationSchema, scheduledExecutionObservationSchema,
]);
export type WorkflowObservation = z.infer<typeof workflowObservationSchema>;
export type CutoverObservation = z.infer<typeof cutoverObservationSchema>;
export type ScheduledExecutionObservation = z.infer<typeof scheduledExecutionObservationSchema>;

const observationEnvironments = {
  "cutover-release": "production-deploy",
  "scheduled-execution": "production-promotion",
} as const;

export type WorkflowObservationReceipt = Readonly<{
  issuer: typeof WORKFLOW_OBSERVATION_ISSUER;
  purpose: WorkflowObservation["purpose"];
  observationDigest: string;
  repositoryId: string;
  repositoryOwnerId: string;
  workflowRef: string;
  workflowSha: string;
  runId: string;
  runAttempt: number;
  observedAt: string;
  expiresAt: string;
}>;

const verified = Symbol("verified-workflow-observation");
const verifiedObservations = new WeakSet<object>();
export type VerifiedWorkflowObservation = Readonly<{
  [verified]: true;
  observation: WorkflowObservation;
  receipt: WorkflowObservationReceipt;
}>;

const githubKeys = createRemoteJWKSet(
  new URL(`${WORKFLOW_OBSERVATION_ISSUER}/.well-known/jwks`),
  { timeoutDuration: 10_000, cooldownDuration: 30_000, cacheMaxAge: 600_000 },
);

export function canonicalObservationJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalObservationJson).join(",")}]`;
  if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalObservationJson(entry)}`).join(",")}}`;
  }
  throw new Error("Workflow observations must contain only finite JSON values.");
}

export function workflowObservationAudience(observation: WorkflowObservation): string {
  const parsed = workflowObservationSchema.parse(observation);
  const hash = createHash("sha256").update(canonicalObservationJson(parsed)).digest("hex");
  return `urn:project-krypto:workflow-observation:v1:${hash}`;
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

export function assertFreshWorkflowObservation(
  evidence: VerifiedWorkflowObservation,
  now: Date,
): void {
  if (evidence?.[verified] !== true || !verifiedObservations.has(evidence)) {
    throw new WorkflowObservationError("A cryptographically verified workflow observation is required.");
  }
  const observed = Date.parse(evidence.observation.observedAt);
  const completed = Date.parse(evidence.observation.completedAt);
  const expires = Date.parse(evidence.receipt.expiresAt);
  const current = now.getTime();
  if (!Number.isFinite(current) || observed > current || completed > current ||
      completed < observed || completed - observed > 90_000 ||
      current - observed > WORKFLOW_OBSERVATION_MAX_AGE_MS || expires <= current) {
    throw new WorkflowObservationError("Workflow observation is expired, future-dated or outside its bounded readback interval.");
  }
}

export async function verifyWorkflowObservation(
  input: string,
  expected: WorkflowObservationTrust & {
    purpose: WorkflowObservation["purpose"];
    workflowSha: string;
    operationExecutionId: string;
  },
  verification: { now?: Date; keys?: JWTVerifyGetKey } = {},
): Promise<VerifiedWorkflowObservation> {
  if (typeof input !== "string" || Buffer.byteLength(input, "utf8") > WORKFLOW_OBSERVATION_MAX_BYTES) {
    throw new Error("Workflow observation proof is missing or exceeds its size limit.");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(input);
  } catch {
    throw new Error("Workflow observation proof is not valid JSON.");
  }
  const parsed = z.object({
    observation: workflowObservationSchema,
    token: z.string().min(1).max(12_000),
  }).strict().safeParse(decoded);
  if (!parsed.success) throw new Error("Workflow observation proof does not match the closed schema.");
  const trust = workflowObservationTrustSchema.parse({
    repository: expected.repository,
    repositoryId: expected.repositoryId,
    repositoryOwnerId: expected.repositoryOwnerId,
  });
  sha.parse(expected.workflowSha);
  executionId.parse(expected.operationExecutionId);
  const { observation, token } = parsed.data;
  const environment = observationEnvironments[observation.purpose];
  const workflowRef = `${trust.repository}/${WORKFLOW_OBSERVATION_PATH}@refs/heads/main`;
  const [owner, repo] = trust.repository.split("/");
  const subject = `repo:${owner}@${trust.repositoryOwnerId}/${repo}@${trust.repositoryId}:environment:${environment}`;
  const now = verification.now ?? new Date();
  const audience = workflowObservationAudience(observation);
  const { payload, protectedHeader } = await jwtVerify(token, verification.keys ?? githubKeys, {
    issuer: WORKFLOW_OBSERVATION_ISSUER,
    audience,
    subject,
    algorithms: ["RS256"],
    requiredClaims: [
      "iss", "sub", "aud", "exp", "iat", "nbf", "jti", "repository", "repository_id",
      "repository_owner_id", "ref", "ref_type", "workflow_ref", "workflow_sha",
      "run_id", "run_attempt", "environment", "event_name",
    ],
    currentDate: now,
    maxTokenAge: "3m",
  });
  const claims: Record<string, string> = {
    repository: trust.repository,
    repository_id: trust.repositoryId,
    repository_owner_id: trust.repositoryOwnerId,
    ref: "refs/heads/main",
    ref_type: "branch",
    workflow_ref: workflowRef,
    workflow_sha: expected.workflowSha,
    run_id: observation.workflow.runId,
    run_attempt: String(observation.workflow.runAttempt),
    environment,
  };
  if (typeof protectedHeader.kid !== "string" || !protectedHeader.kid ||
      payload.aud !== audience || typeof payload.jti !== "string" || !payload.jti ||
      !["workflow_dispatch", "workflow_run"].includes(String(payload.event_name)) ||
      Object.entries(claims).some(([key, value]) => payload[key] !== value) ||
      observation.workflow.repository !== trust.repository ||
      observation.workflow.repositoryId !== trust.repositoryId ||
      observation.workflow.repositoryOwnerId !== trust.repositoryOwnerId ||
      observation.workflow.sha !== expected.workflowSha ||
      observation.purpose !== expected.purpose ||
      observation.operationExecutionId !== expected.operationExecutionId) {
    throw new Error("Workflow observation identity, purpose or invocation binding does not match.");
  }
  const issued = payload.iat;
  const expires = payload.exp;
  if (typeof issued !== "number" || !Number.isSafeInteger(issued) ||
      typeof expires !== "number" || !Number.isSafeInteger(expires) ||
      expires <= issued || expires - issued > 600 ||
      issued * 1000 < Date.parse(observation.completedAt) - 1000) {
    throw new Error("Workflow observation token does not attest a fresh completed readback.");
  }
  const evidence: VerifiedWorkflowObservation = freeze({
    [verified]: true as const,
    observation,
    receipt: {
      issuer: WORKFLOW_OBSERVATION_ISSUER,
      purpose: observation.purpose,
      observationDigest: audience.slice(audience.lastIndexOf(":") + 1),
      repositoryId: trust.repositoryId,
      repositoryOwnerId: trust.repositoryOwnerId,
      workflowRef,
      workflowSha: expected.workflowSha,
      runId: observation.workflow.runId,
      runAttempt: observation.workflow.runAttempt,
      observedAt: observation.observedAt,
      expiresAt: new Date(expires * 1000).toISOString(),
    },
  });
  verifiedObservations.add(evidence);
  assertFreshWorkflowObservation(evidence, now);
  return evidence;
}

export function workflowObservationTrustFromEnv(
  env: NodeJS.ProcessEnv,
): WorkflowObservationTrust {
  return workflowObservationTrustSchema.parse({
    repository: env.DEPLOYMENT_REPOSITORY,
    repositoryId: env.DEPLOYMENT_REPOSITORY_ID,
    repositoryOwnerId: env.DEPLOYMENT_REPOSITORY_OWNER_ID,
  });
}
