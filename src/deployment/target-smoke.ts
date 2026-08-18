import { createHmac, timingSafeEqual } from "node:crypto";
import postgres from "postgres";

import type { ProviderSmokeResult } from "@/deployment/provider-smoke";
import { runProviderSmoke } from "@/deployment/provider-smoke";

const REQUEST_TIMEOUT_MS = 30_000;

export type TargetSmokeCheck = {
  id: string;
  status: "pass" | "block";
  summary: string;
  evidence?: Record<string, unknown>;
};

export type TargetSmokeBinding = {
  approvalId: string;
  bindingId: string;
  modeMismatchEvidenceId: string;
  cronEvidenceId: string;
  adminEvidenceId: string;
  targetOrigin: string;
  releaseSha: string;
  imageDigest: string;
  rolloutMode: "disabled";
  /** Canonical UTC timestamp signed into the approval and persisted as the journal row's createdAt. */
  approvedAt: string;
  /**
   * Keyed HMAC-SHA256 (full hex) binding the cron secret to the
   * DEPLOYMENT_APPROVAL_SECRET. Replaces the retired MD5(cronSecret)
   * fingerprint, which anything that already knows CRON_SECRET (e.g. the
   * runtime itself) could recompute and forge into a fabricated
   * AgentJournal row. Nothing that only knows CRON_SECRET can reproduce
   * this value.
   */
  cronSecretBinding: string;
  /**
   * Keyed HMAC-SHA256 (full hex) approval signature over the canonical,
   * versioned serialization of approvalId and all target-smoke evidence IDs,
   * targetOrigin/releaseSha/imageDigest/rolloutMode/cronSecretBinding/
   * approvedAt. Proves the whole row was produced by something holding
   * DEPLOYMENT_APPROVAL_SECRET -- runtime inserting AgentJournal rows on its
   * own cannot fabricate this.
   */
  approvalSignature: string;
};

export type TargetSmokeReport = {
  schemaVersion: "1.6.0";
  generatedAt: string;
  target: string;
  releaseSha: string;
  imageDigest: string;
  rolloutMode: "disabled";
  evidenceIds: {
    databaseBinding: string;
    approval: string;
    modeMismatch: string;
    cron: string;
    admin: string;
  };
  checks: TargetSmokeCheck[];
  providerChecksRunFrom: "operator-environment";
  passed: boolean;
  manualGatesRemaining: string[];
  binding: TargetSmokeBinding | null;
};

export type TargetSmokeOptions = {
  baseUrl: string;
  expectedHost: string;
  databaseUrl: string;
  cronSecret: string;
  adminPassword: string;
  /** Exact lowercase 40-hex commit SHA of the deployed release. Required, validated, never guessed. */
  releaseSha: string;
  /** Exact `sha256:<64-hex>` digest of the deployed image. Required, validated, never guessed. */
  imageDigest: string;
  /**
   * High-entropy secret shared only between operator/ops-job invocations
   * of target-smoke and activation-check -- runtime/web never receives
   * it. Required and length-validated (never guessed or defaulted) so
   * the persisted cron-secret binding and approval signature cannot be
   * forged by anything that only knows CRON_SECRET.
   */
  approvalSecret: string;
};

type PreSmokeEvidence = {
  tradeCount: number;
  activeKryptoCronJobs: number;
  pendingKryptoHttpRequests: number;
  state: {
    present: boolean;
    accountingStatus: string | null;
    openPosition: boolean | null;
    activeLease: boolean;
  };
};

type PostSmokeEvidence = {
  runCount: number;
  disabledRunCount: number;
  tradeCount: number;
  leaseReleased: boolean;
  deliveryStatus: string | null;
};

export type TargetSmokeDependencies = {
  fetchImpl?: typeof fetch;
  runProviders?: () => Promise<ProviderSmokeResult>;
  inspectBefore?: (databaseUrl: string) => Promise<PreSmokeEvidence>;
  inspectAfter?: (input: {
    databaseUrl: string;
    idempotencyKeys: string[];
    startedAt: Date;
  }) => Promise<PostSmokeEvidence>;
  createBinding?: (input: {
    databaseUrl: string;
    bindingId: string;
  }) => Promise<void>;
  createApproval?: (input: {
    databaseUrl: string;
    approvalId: string;
    bindingId: string;
    modeMismatchEvidenceId: string;
    cronEvidenceId: string;
    adminEvidenceId: string;
    targetOrigin: string;
    cronSecret: string;
    releaseSha: string;
    imageDigest: string;
    approvalSecret: string;
    approvedAt: Date;
  }) => Promise<void>;
  now?: () => Date;
  randomUuid?: () => string;
};

type CheckResult<T> = {
  passed: boolean;
  value?: T;
};

function errorCode(error: unknown): string {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return error instanceof Error ? error.name : "UnknownError";
}

function sanitizedTarget(value: string): string {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function validateTargetBaseUrl(
  value: string,
  expectedHost: string,
): URL {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Target URL must use HTTP or HTTPS.");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error(
      "Target URL must not contain credentials, a path, query, or fragment.",
    );
  }
  if (url.hostname.toLowerCase() !== expectedHost.toLowerCase()) {
    throw new Error("Target hostname does not match --confirm-host.");
  }
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
    url.hostname.toLowerCase(),
  );
  if (url.protocol !== "https:" && !loopback) {
    throw new Error("Remote target smoke requires HTTPS.");
  }
  return url;
}

const RELEASE_SHA_PATTERN = /^[0-9a-f]{40}$/;
const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const APPROVAL_ID_PATTERN = new RegExp(
  `^deployment-smoke-approved-${UUID_PATTERN}$`,
);
const BINDING_ID_PATTERN = new RegExp(
  `^deployment-smoke-binding-${UUID_PATTERN}$`,
);
const MODE_MISMATCH_EVIDENCE_ID_PATTERN = new RegExp(
  `^deployment-smoke-mode-mismatch-${UUID_PATTERN}$`,
);
const CRON_EVIDENCE_ID_PATTERN = new RegExp(
  `^deployment-smoke-cron-${UUID_PATTERN}$`,
);
const ADMIN_EVIDENCE_ID_PATTERN = new RegExp(
  `^deployment-smoke-admin-${UUID_PATTERN}$`,
);

/**
 * Validates an exact, lowercase 40-hex commit SHA. Never derives, defaults,
 * or truncates a value -- an invalid or missing SHA is a hard failure.
 */
export function validateReleaseSha(value: string): string {
  if (!RELEASE_SHA_PATTERN.test(value)) {
    throw new Error(
      "RELEASE_SHA must be exactly 40 lowercase hexadecimal characters.",
    );
  }
  return value;
}

/**
 * Validates an exact `sha256:<64-hex>` image digest. Never derives,
 * defaults, or guesses a value -- an invalid or missing digest is a hard
 * failure.
 */
export function validateImageDigest(value: string): string {
  if (!IMAGE_DIGEST_PATTERN.test(value)) {
    throw new Error(
      "IMAGE_DIGEST must be an exact sha256:<64 lowercase hex> digest.",
    );
  }
  return value;
}

export function validTargetSmokeEvidenceIds(fields: {
  approvalId: string | null | undefined;
  bindingId: string | null | undefined;
  modeMismatchEvidenceId: string | null | undefined;
  cronEvidenceId: string | null | undefined;
  adminEvidenceId: string | null | undefined;
}): boolean {
  return (
    typeof fields.approvalId === "string" &&
    APPROVAL_ID_PATTERN.test(fields.approvalId) &&
    typeof fields.bindingId === "string" &&
    BINDING_ID_PATTERN.test(fields.bindingId) &&
    typeof fields.modeMismatchEvidenceId === "string" &&
    MODE_MISMATCH_EVIDENCE_ID_PATTERN.test(fields.modeMismatchEvidenceId) &&
    typeof fields.cronEvidenceId === "string" &&
    CRON_EVIDENCE_ID_PATTERN.test(fields.cronEvidenceId) &&
    typeof fields.adminEvidenceId === "string" &&
    ADMIN_EVIDENCE_ID_PATTERN.test(fields.adminEvidenceId)
  );
}

const APPROVAL_SECRET_MIN_LENGTH = 32;

/**
 * Validates DEPLOYMENT_APPROVAL_SECRET: required and long enough to serve
 * as high-entropy HMAC-SHA256 key material (minimum 32 characters, i.e.
 * at least 256 bits of key space assuming reasonable character
 * diversity). Actual entropy cannot be measured from a string alone, so
 * length is enforced as the fail-closed proxy -- a short/guessable value
 * is rejected rather than silently accepted.
 */
export function validateApprovalSecret(value: string): string {
  if (value.length < APPROVAL_SECRET_MIN_LENGTH) {
    throw new Error(
      `DEPLOYMENT_APPROVAL_SECRET must be at least ${APPROVAL_SECRET_MIN_LENGTH} characters of high-entropy material.`,
    );
  }
  return value;
}

const APPROVAL_PAYLOAD_VERSION = "2";

function lengthPrefixed(value: string): string {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}

/**
 * Canonical, versioned, unambiguous serialization of the fields bound by
 * the approval signature. Every field is netstring-style length-prefixed
 * so no delimiter choice or field content can make two distinct field
 * sets serialize identically.
 */
export function canonicalApprovalPayload(fields: {
  approvalId: string;
  bindingId: string;
  modeMismatchEvidenceId: string;
  cronEvidenceId: string;
  adminEvidenceId: string;
  targetOrigin: string;
  releaseSha: string;
  imageDigest: string;
  /**
   * The write path (`createTargetApproval`) only ever signs the literal
   * "disabled". This is typed as `string` (not the literal) so
   * verification can reconstruct the exact payload that was signed from
   * whatever value is actually persisted -- including a tampered or
   * legacy value -- and let the signature check fail on its own rather
   * than on a type mismatch.
   */
  rolloutMode: string;
  cronSecretBinding: string;
  approvedAt: string;
}): string {
  return [
    APPROVAL_PAYLOAD_VERSION,
    lengthPrefixed(fields.approvalId),
    lengthPrefixed(fields.bindingId),
    lengthPrefixed(fields.modeMismatchEvidenceId),
    lengthPrefixed(fields.cronEvidenceId),
    lengthPrefixed(fields.adminEvidenceId),
    lengthPrefixed(fields.targetOrigin),
    lengthPrefixed(fields.releaseSha),
    lengthPrefixed(fields.imageDigest),
    lengthPrefixed(fields.rolloutMode),
    lengthPrefixed(fields.cronSecretBinding),
    lengthPrefixed(fields.approvedAt),
  ].join(".");
}

/**
 * Keyed HMAC-SHA256 (full hex) binding of the cron secret to
 * DEPLOYMENT_APPROVAL_SECRET. Unlike the retired MD5(cronSecret)
 * fingerprint, this cannot be recomputed by anything that knows only
 * CRON_SECRET -- runtime/web never receives DEPLOYMENT_APPROVAL_SECRET,
 * so it cannot forge a deployment-smoke-approved row.
 */
export function cronSecretBinding(
  cronSecret: string,
  approvalSecret: string,
): string {
  return createHmac("sha256", approvalSecret)
    .update(cronSecret)
    .digest("hex");
}

/**
 * Keyed HMAC-SHA256 (full hex) approval signature over the canonical
 * payload, using DEPLOYMENT_APPROVAL_SECRET as the key.
 */
export function computeApprovalSignature(
  payload: string,
  approvalSecret: string,
): string {
  return createHmac("sha256", approvalSecret).update(payload).digest("hex");
}

/**
 * Constant-time comparison of a known-good expected value against a
 * possibly-attacker-influenced or missing persisted value. Never
 * short-circuits on a fast `!==` before the lengths are known to match,
 * and treats anything that is not exactly a string as a hard mismatch
 * (a missing/legacy/unsigned row must never pass).
 */
export function constantTimeEqual(
  expected: string,
  actual: string | null | undefined,
): boolean {
  if (typeof actual !== "string") {
    return false;
  }
  const expectedBuffer = Buffer.from(expected, "utf8");
  const actualBuffer = Buffer.from(actual, "utf8");
  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, actualBuffer);
}

export function extractSessionCookie(headers: Headers): string {
  const values =
    "getSetCookie" in headers &&
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : [headers.get("set-cookie")].filter(
          (value): value is string => value !== null,
        );
  const cookie = values
    .map((value) => value.split(";", 1)[0])
    .find((value) => value.startsWith("krypto-admin-token="));
  if (!cookie || cookie === "krypto-admin-token=") {
    throw new Error("Admin login did not return a session cookie.");
  }
  return cookie;
}

export async function readOnly<T>(
  databaseUrl: string,
  operation: (sql: postgres.Sql) => Promise<T>,
): Promise<T> {
  const sql = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
  });
  try {
    await sql`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`;
    await sql`SET LOCAL statement_timeout = '15s'`;
    return await operation(sql);
  } finally {
    try {
      await sql`ROLLBACK`;
    } finally {
      await sql.end({ timeout: 5 });
    }
  }
}

export async function inspectTargetBefore(
  databaseUrl: string,
): Promise<PreSmokeEvidence> {
  return readOnly(databaseUrl, async (sql) => {
    const [state] = await sql<
      Array<{
        accountingStatus: string;
        ethBalance: string | null;
        isRunning: boolean;
        leaseOwner: string | null;
        leaseExpiresAt: Date | null;
      }>
    >`
      SELECT
        "accountingStatus"::text AS "accountingStatus",
        COALESCE(
          "currentPositionETHDecimal",
          "currentPositionETH"::numeric
        )::text AS "ethBalance",
        "isRunning",
        "leaseOwner",
        "leaseExpiresAt"
      FROM "krypto"."AgentState"
      WHERE id = 'singleton'
      LIMIT 1
    `;
    const [trades] = await sql<Array<{ count: string }>>`
      SELECT COUNT(*)::text AS count
      FROM "krypto"."TradeExecution"
    `;
    const [cronAvailability] = await sql<Array<{ available: boolean }>>`
      SELECT to_regclass('cron.job') IS NOT NULL AS available
    `;
    let activeKryptoCronJobs = 0;
    if (cronAvailability?.available) {
      const [cron] = await sql<Array<{ count: string }>>`
        SELECT COUNT(*)::text AS count
        FROM cron.job
        WHERE active
          AND (
            COALESCE(jobname, '') ILIKE 'krypto%'
            OR COALESCE(command, '') ILIKE '%krypto%'
            OR COALESCE(command, '') ~* '/api/agent/(run|daily-summary)'
            OR COALESCE(command, '') ~* 'invoke_(agent_run|daily_summary)'
            OR COALESCE(command, '') ILIKE '%krypto_invoke_endpoint%'
          )
      `;
      activeKryptoCronJobs = Number(cron?.count ?? 0);
    }
    const [httpQueueAvailability] = await sql<
      Array<{ available: boolean }>
    >`
      SELECT to_regclass(
        'net.http_request_queue'
      ) IS NOT NULL AS available
    `;
    let pendingKryptoHttpRequests = 0;
    if (httpQueueAvailability?.available) {
      const [pending] = await sql<Array<{ count: string }>>`
        SELECT COUNT(*)::text AS count
        FROM net.http_request_queue
        WHERE url ~* '/api/agent/(run|daily-summary)'
      `;
      pendingKryptoHttpRequests = Number(pending?.count ?? 0);
    }
    const ethBalance =
      state?.ethBalance === null || state?.ethBalance === undefined
        ? null
        : Number(state.ethBalance);
    const activeLease =
      state?.isRunning === true ||
      state?.leaseOwner !== null ||
      state?.leaseExpiresAt !== null;
    return {
      tradeCount: Number(trades?.count ?? 0),
      activeKryptoCronJobs,
      pendingKryptoHttpRequests,
      state: {
        present: state !== undefined,
        accountingStatus: state?.accountingStatus ?? null,
        openPosition:
          ethBalance === null || !Number.isFinite(ethBalance)
            ? null
            : ethBalance !== 0,
        activeLease,
      },
    };
  });
}

export async function inspectTargetAfter(input: {
  databaseUrl: string;
  idempotencyKeys: string[];
  startedAt: Date;
}): Promise<PostSmokeEvidence> {
  return readOnly(input.databaseUrl, async (sql) => {
    const runs = await sql<
      Array<{
        idempotencyKey: string;
        tradingMode: string;
        outcome: string;
        completedAt: Date | null;
      }>
    >`
      SELECT
        "idempotencyKey",
        "tradingMode"::text AS "tradingMode",
        "outcome"::text AS outcome,
        "completedAt"
      FROM "krypto"."AgentRun"
      WHERE "idempotencyKey" = ANY(${input.idempotencyKeys})
      ORDER BY "idempotencyKey"
    `;
    const [trades] = await sql<Array<{ count: string }>>`
      SELECT COUNT(*)::text AS count
      FROM "krypto"."TradeExecution"
    `;
    const [state] = await sql<
      Array<{
        isRunning: boolean;
        leaseOwner: string | null;
        leaseExpiresAt: Date | null;
      }>
    >`
      SELECT "isRunning", "leaseOwner", "leaseExpiresAt"
      FROM "krypto"."AgentState"
      WHERE id = 'singleton'
      LIMIT 1
    `;
    const [delivery] = await sql<Array<{ status: string | null }>>`
      SELECT "marketConditions" ->> 'status' AS status
      FROM "krypto"."AgentJournal"
      WHERE "createdAt" >= ${input.startedAt}
        AND "marketConditions" ->> 'event' = 'daily-summary-delivery'
      ORDER BY "createdAt" DESC
      LIMIT 1
    `;
    return {
      runCount: runs.length,
      disabledRunCount: runs.filter(
        (run) =>
          run.tradingMode === "DISABLED" &&
          run.outcome === "DISABLED" &&
          run.completedAt !== null,
      ).length,
      tradeCount: Number(trades?.count ?? 0),
      leaseReleased:
        state !== undefined &&
        !state.isRunning &&
        state.leaseOwner === null &&
        state.leaseExpiresAt === null,
      deliveryStatus: delivery?.status ?? null,
    };
  });
}

export async function createTargetBinding(input: {
  databaseUrl: string;
  bindingId: string;
}): Promise<void> {
  const sql = postgres(input.databaseUrl, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
  });
  try {
    await sql`
      INSERT INTO "krypto"."AgentJournal" (
        id,
        "entryText",
        "marketConditions"
      ) VALUES (
        ${input.bindingId},
        'Deployment smoke database binding challenge.',
        ${sql.json({
          event: "deployment-smoke-binding",
          bindingId: input.bindingId,
          timestamp: new Date().toISOString(),
        })}
      )
    `;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function createTargetApproval(input: {
  databaseUrl: string;
  approvalId: string;
  bindingId: string;
  modeMismatchEvidenceId: string;
  cronEvidenceId: string;
  adminEvidenceId: string;
  targetOrigin: string;
  cronSecret: string;
  releaseSha: string;
  imageDigest: string;
  approvalSecret: string;
  approvedAt: Date;
}): Promise<void> {
  if (
    !validTargetSmokeEvidenceIds({
      approvalId: input.approvalId,
      bindingId: input.bindingId,
      modeMismatchEvidenceId: input.modeMismatchEvidenceId,
      cronEvidenceId: input.cronEvidenceId,
      adminEvidenceId: input.adminEvidenceId,
    })
  ) {
    throw new Error("Target-smoke evidence IDs are malformed.");
  }
  if (Number.isNaN(input.approvedAt.getTime())) {
    throw new Error("Approval timestamp must be a valid Date.");
  }
  const sql = postgres(input.databaseUrl, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
  });
  try {
    const approvedAt = input.approvedAt.toISOString();
    const binding = cronSecretBinding(input.cronSecret, input.approvalSecret);
    const signature = computeApprovalSignature(
      canonicalApprovalPayload({
        approvalId: input.approvalId,
        bindingId: input.bindingId,
        modeMismatchEvidenceId: input.modeMismatchEvidenceId,
        cronEvidenceId: input.cronEvidenceId,
        adminEvidenceId: input.adminEvidenceId,
        targetOrigin: input.targetOrigin,
        releaseSha: input.releaseSha,
        imageDigest: input.imageDigest,
        rolloutMode: "disabled",
        cronSecretBinding: binding,
        approvedAt,
      }),
      input.approvalSecret,
    );
    await sql`
      INSERT INTO "krypto"."AgentJournal" (
        id,
        "entryText",
        "marketConditions",
        "createdAt"
      ) VALUES (
        ${input.approvalId},
        'Deployment smoke target and cron configuration approved.',
        ${sql.json({
          event: "deployment-smoke-approved",
          bindingId: input.bindingId,
          modeMismatchEvidenceId: input.modeMismatchEvidenceId,
          cronEvidenceId: input.cronEvidenceId,
          adminEvidenceId: input.adminEvidenceId,
          targetOrigin: input.targetOrigin,
          cronSecretBinding: binding,
          releaseSha: input.releaseSha,
          imageDigest: input.imageDigest,
          rolloutMode: "disabled",
          approvalSignature: signature,
          approvedAt,
        })},
        (${approvedAt}::timestamptz AT TIME ZONE 'UTC')
      )
    `;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function request(
  fetchImpl: typeof fetch,
  url: URL,
  init: RequestInit,
): Promise<Response> {
  return fetchImpl(url, {
    ...init,
    redirect: init.redirect ?? "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function responseJson(response: Response): Promise<
  Record<string, unknown>
> {
  const value = (await response.json()) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Target returned a non-object JSON response.");
  }
  return value as Record<string, unknown>;
}

export async function runTargetSmoke(
  options: TargetSmokeOptions,
  dependencies: TargetSmokeDependencies = {},
): Promise<TargetSmokeReport> {
  if (process.env.ROLLOUT_MODE?.toLowerCase() !== "disabled") {
    throw new Error(
      "The operator environment must explicitly set ROLLOUT_MODE=disabled.",
    );
  }
  const baseUrl = validateTargetBaseUrl(
    options.baseUrl,
    options.expectedHost,
  );
  if (
    !options.databaseUrl ||
    !options.cronSecret ||
    !options.adminPassword
  ) {
    throw new Error(
      "DIRECT_URL, CRON_SECRET, and ADMIN_PASSWORD are required.",
    );
  }
  if (!options.releaseSha || !options.imageDigest) {
    throw new Error("RELEASE_SHA and IMAGE_DIGEST are required.");
  }
  if (!options.approvalSecret) {
    throw new Error("DEPLOYMENT_APPROVAL_SECRET is required.");
  }
  const releaseSha = validateReleaseSha(options.releaseSha);
  const imageDigest = validateImageDigest(options.imageDigest);
  const approvalSecret = validateApprovalSecret(options.approvalSecret);
  const safetyReleaseOwner = process.env.SAFETY_RELEASE_OWNER?.trim();
  if (!safetyReleaseOwner) {
    throw new Error(
      "SAFETY_RELEASE_OWNER is required for the non-trading safety test-fire contract.",
    );
  }

  const now = dependencies.now ?? (() => new Date());
  const randomUuid = dependencies.randomUuid ?? (() => crypto.randomUUID());
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const inspectBefore = dependencies.inspectBefore ?? inspectTargetBefore;
  const inspectAfter = dependencies.inspectAfter ?? inspectTargetAfter;
  const createBinding =
    dependencies.createBinding ?? createTargetBinding;
  const createApproval =
    dependencies.createApproval ?? createTargetApproval;
  const providerSmoke = dependencies.runProviders ?? runProviderSmoke;
  const startedAt = now();
  const evidenceIds = {
    databaseBinding: `deployment-smoke-binding-${randomUuid()}`,
    approval: `deployment-smoke-approved-${randomUuid()}`,
    modeMismatch: `deployment-smoke-mode-mismatch-${randomUuid()}`,
    cron: `deployment-smoke-cron-${randomUuid()}`,
    admin: `deployment-smoke-admin-${randomUuid()}`,
  };
  if (
    !validTargetSmokeEvidenceIds({
      approvalId: evidenceIds.approval,
      bindingId: evidenceIds.databaseBinding,
      modeMismatchEvidenceId: evidenceIds.modeMismatch,
      cronEvidenceId: evidenceIds.cron,
      adminEvidenceId: evidenceIds.admin,
    })
  ) {
    throw new Error("Generated target-smoke evidence IDs are malformed.");
  }
  const checks: TargetSmokeCheck[] = [];

  async function check<T>(
    id: string,
    summary: string,
    operation: () => Promise<T>,
    evidence?: (value: T) => Record<string, unknown>,
  ): Promise<CheckResult<T>> {
    try {
      const value = await operation();
      checks.push({
        id,
        status: "pass",
        summary,
        evidence: evidence?.(value),
      });
      return { passed: true, value };
    } catch (error) {
      checks.push({
        id,
        status: "block",
        summary: `${summary} failed.`,
        evidence: { errorCode: errorCode(error) },
      });
      return { passed: false };
    }
  }

  function blockedReport(manualGate: string): TargetSmokeReport {
    return {
      schemaVersion: "1.6.0",
      generatedAt: now().toISOString(),
      target: sanitizedTarget(options.baseUrl),
      releaseSha,
      imageDigest,
      rolloutMode: "disabled",
      evidenceIds,
      checks,
      providerChecksRunFrom: "operator-environment",
      passed: false,
      manualGatesRemaining: [manualGate],
      binding: null,
    };
  }

  const targetMode = await check(
    "target-rollout-mode",
    "Target authenticates status checks and reports disabled mode",
    async () => {
      const unauthorized = await request(
        fetchImpl,
        new URL("/api/agent/status", baseUrl),
        { method: "GET" },
      );
      if (unauthorized.status !== 401) {
        throw new Error("Unauthenticated target status was not rejected.");
      }
      const response = await request(
        fetchImpl,
        new URL("/api/agent/status", baseUrl),
        {
          method: "GET",
          headers: { "x-cron-secret": options.cronSecret },
        },
      );
      const body = await responseJson(response);
      if (response.status !== 200 || body.rolloutMode !== "disabled") {
        throw new Error("Target rollout mode is not disabled.");
      }
      return {
        unauthorizedStatus: unauthorized.status,
        rolloutMode: body.rolloutMode,
      };
    },
    (value) => value,
  );

  if (!targetMode.passed) {
    return blockedReport(
      "Deploy and prove ROLLOUT_MODE=disabled before any smoke run.",
    );
  }

  const before = await check(
    "database-safety",
    "Database is reconciled, position-free, lease-free, and cron-free",
    async () => {
      const value = await inspectBefore(options.databaseUrl);
      if (
        !value.state.present ||
        value.state.accountingStatus !== "RECONCILED" ||
        value.state.openPosition !== false ||
        value.state.activeLease ||
        value.activeKryptoCronJobs !== 0 ||
        value.pendingKryptoHttpRequests !== 0
      ) {
        throw new Error("Database safety prerequisites are not satisfied.");
      }
      return value;
    },
    (value) => ({
      tradeCount: value.tradeCount,
      accountingStatus: value.state.accountingStatus,
      openPosition: value.state.openPosition,
      activeLease: value.state.activeLease,
      activeKryptoCronJobs: value.activeKryptoCronJobs,
      pendingKryptoHttpRequests:
        value.pendingKryptoHttpRequests,
    }),
  );

  if (!before.passed || !before.value) {
    return blockedReport(
      "Resolve database safety blockers before any target smoke mutation.",
    );
  }

  const databaseBinding = await check(
    "database-target-binding",
    "DIRECT_URL and the deployed runtime use the same database",
    async () => {
      await createBinding({
        databaseUrl: options.databaseUrl,
        bindingId: evidenceIds.databaseBinding,
      });
      const response = await request(
        fetchImpl,
        new URL("/api/agent/status", baseUrl),
        {
          method: "GET",
          headers: {
            "x-cron-secret": options.cronSecret,
            "x-database-challenge": evidenceIds.databaseBinding,
          },
        },
      );
      const body = await responseJson(response);
      if (
        response.status !== 200 ||
        body.rolloutMode !== "disabled" ||
        body.databaseBinding !== true
      ) {
        throw new Error("Runtime database binding was not proven.");
      }
      return {
        bindingId: evidenceIds.databaseBinding,
        rolloutMode: body.rolloutMode,
      };
    },
    (value) => value,
  );

  if (!databaseBinding.passed) {
    return blockedReport(
      "Correct the base URL or DIRECT_URL target before invoking the agent.",
    );
  }

  const cronAuth = await check(
    "cron-auth-rejection",
    "Agent run endpoint rejects a missing cron secret",
    async () => {
      const response = await request(
        fetchImpl,
        new URL("/api/agent/run", baseUrl),
        {
          method: "POST",
          headers: { "x-required-rollout-mode": "disabled" },
        },
      );
      if (response.status !== 401) {
        throw new Error("Unauthenticated cron request was not rejected.");
      }
      return response.status;
    },
    (status) => ({ status }),
  );
  if (!cronAuth.passed) {
    return blockedReport(
      "Repair cron-route authentication before any authenticated smoke run.",
    );
  }

  const requiredModeRejection = await check(
    "required-mode-rejection",
    "Agent run rejects a valid mismatched required mode without database mutation",
    async () => {
      const response = await request(
        fetchImpl,
        new URL("/api/agent/run", baseUrl),
        {
          method: "POST",
          headers: {
            "x-cron-secret": options.cronSecret,
            "x-idempotency-key": evidenceIds.modeMismatch,
            "x-krypto-mode-probe": "no-mutation",
            "x-required-rollout-mode": "paper",
          },
        },
      );
      const body = await responseJson(response);
      if (
        response.status !== 409 ||
        body.expectedMode !== "paper" ||
        body.actualMode !== "disabled"
      ) {
        throw new Error("Required rollout mode was not enforced.");
      }
      const database = await inspectAfter({
        databaseUrl: options.databaseUrl,
        idempotencyKeys: [evidenceIds.modeMismatch],
        startedAt,
      });
      if (
        database.runCount !== 0 ||
        database.tradeCount !== before.value!.tradeCount ||
        !database.leaseReleased
      ) {
        throw new Error(
          "Rejected required-mode probe mutated run, trade, or lease state.",
        );
      }
      return {
        status: response.status,
        expectedMode: body.expectedMode,
        actualMode: body.actualMode,
        runCount: database.runCount,
      };
    },
    (value) => value,
  );
  if (!requiredModeRejection.passed) {
    return blockedReport(
      "Repair required-mode enforcement before any disabled smoke run.",
    );
  }

  const cronRun = await check(
    "disabled-cron-run",
    "Authenticated cron run persists a disabled outcome",
    async () => {
      const response = await request(
        fetchImpl,
        new URL("/api/agent/run", baseUrl),
        {
          method: "POST",
          headers: {
            "x-cron-secret": options.cronSecret,
            "x-idempotency-key": evidenceIds.cron,
            "x-required-rollout-mode": "disabled",
          },
        },
      );
      const body = await responseJson(response);
      if (response.status !== 200 || body.action !== "disabled") {
        throw new Error("Cron smoke did not return a disabled outcome.");
      }
      return { status: response.status, action: body.action };
    },
    (value) => value,
  );
  if (!cronRun.passed) {
    return blockedReport(
      "Keep rollout disabled and resolve the failed cron smoke before continuing.",
    );
  }

  const adminAuth = await check(
    "admin-auth-rejection",
    "Protected admin API rejects a missing session",
    async () => {
      const response = await request(
        fetchImpl,
        new URL("/api/admin/run-agent", baseUrl),
        {
          method: "POST",
          headers: {
            origin: baseUrl.origin,
            "x-required-rollout-mode": "disabled",
          },
        },
      );
      if (response.status !== 401) {
        throw new Error("Unauthenticated admin request was not rejected.");
      }
      return response.status;
    },
    (status) => ({ status }),
  );
  if (!adminAuth.passed) {
    return blockedReport(
      "Repair admin-route authentication before creating a session.",
    );
  }

  const login = await check(
    "admin-login",
    "Admin login issues a secure session",
    async () => {
      const response = await request(
        fetchImpl,
        new URL("/api/auth/login", baseUrl),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: baseUrl.origin,
          },
          body: JSON.stringify({ password: options.adminPassword }),
        },
      );
      if (response.status !== 200) {
        throw new Error("Admin login failed.");
      }
      return extractSessionCookie(response.headers);
    },
    () => ({ authenticated: true }),
  );

  if (!login.passed || !login.value) {
    checks.push({
      id: "admin-session-flow",
      status: "block",
      summary: "Admin run and logout checks were skipped because login failed.",
    });
    return blockedReport(
      "Repair admin login before any further target smoke actions.",
    );
  }

  const adminRun = await check(
    "admin-session-run",
    "Authenticated admin session reaches a disabled run",
    async () => {
      const page = await request(fetchImpl, new URL("/admin", baseUrl), {
        method: "GET",
        headers: { cookie: login.value! },
      });
      if (page.status !== 200) {
        throw new Error("Authenticated admin page was unavailable.");
      }
      const response = await request(
        fetchImpl,
        new URL("/api/admin/run-agent", baseUrl),
        {
          method: "POST",
          headers: {
            cookie: login.value!,
            origin: baseUrl.origin,
            "x-idempotency-key": evidenceIds.admin,
            "x-required-rollout-mode": "disabled",
          },
        },
      );
      const body = await responseJson(response);
      if (response.status !== 200 || body.action !== "disabled") {
        throw new Error("Admin smoke did not return a disabled outcome.");
      }
      return { pageStatus: page.status, runStatus: response.status };
    },
    (value) => value,
  );

  const safetyTestFire = await check(
    "safety-incident-test-fire-dry-run",
    "Protected warning test fire proves the non-trading incident contract without persistence",
    async () => {
      const response = await request(
        fetchImpl,
        new URL("/api/admin/safety-incidents/test-fire", baseUrl),
        {
          method: "POST",
          headers: {
            cookie: login.value!,
            origin: baseUrl.origin,
            "content-type": "application/json",
            "x-request-id": `target-smoke-${evidenceIds.admin}`,
          },
          body: JSON.stringify({
            severity: "WARNING",
            dryRun: true,
            drill: false,
            actorId: safetyReleaseOwner,
            actorRole: "RELEASE_OWNER",
            reason: "Target smoke non-trading warning test fire",
          }),
        },
      );
      const body = await responseJson(response);
      const roster =
        body.roster !== null &&
        typeof body.roster === "object" &&
        !Array.isArray(body.roster)
          ? (body.roster as Record<string, unknown>)
          : null;
      if (
        response.status !== 200 ||
        body.dryRun !== true ||
        body.persisted !== false ||
        body.incidentType !== "TEST_FIRE_WARNING" ||
        roster?.complete !== true ||
        roster?.authenticatorsConfigured !== true
      ) {
        throw new Error(
          "Safety warning test fire was not a complete non-trading dry run.",
        );
      }
      return {
        status: response.status,
        incidentType: body.incidentType,
        persisted: body.persisted,
        rosterComplete: roster.complete,
        authenticatorsConfigured: roster.authenticatorsConfigured,
      };
    },
    (value) => value,
  );
  if (!safetyTestFire.passed) {
    return blockedReport(
      "Complete the protected responder roster and non-trading test-fire contract before rollout evidence.",
    );
  }

  const adminLogout = await check(
      "admin-logout",
      "Logout clears the admin cookie and protected access",
      async () => {
        const logout = await request(
          fetchImpl,
          new URL("/api/auth/logout", baseUrl),
          {
            method: "POST",
            headers: {
              cookie: login.value!,
              origin: baseUrl.origin,
            },
          },
        );
        const clearCookie = logout.headers.get("set-cookie") ?? "";
        if (
          logout.status !== 303 ||
          !clearCookie.startsWith("krypto-admin-token=") ||
          !/max-age=0/i.test(clearCookie)
        ) {
          throw new Error("Logout did not clear the admin cookie.");
        }
        const afterLogout = await request(
          fetchImpl,
          new URL("/api/admin/run-agent", baseUrl),
          {
            method: "POST",
            headers: {
              origin: baseUrl.origin,
              "x-required-rollout-mode": "disabled",
            },
          },
        );
        if (afterLogout.status !== 401) {
          throw new Error("Protected admin access remained available.");
        }
        return {
          logoutStatus: logout.status,
          protectedStatus: afterLogout.status,
        };
      },
      (value) => value,
  );
  if (!adminRun.passed || !adminLogout.passed) {
    return blockedReport(
      "Resolve the admin run/logout failure before daily-summary checks.",
    );
  }

  const dailyAuth = await check(
    "daily-summary-auth-rejection",
    "Daily summary endpoint rejects a missing cron secret",
    async () => {
      const response = await request(
        fetchImpl,
        new URL("/api/agent/daily-summary", baseUrl),
        { method: "POST" },
      );
      if (response.status !== 401) {
        throw new Error("Unauthenticated daily summary was not rejected.");
      }
      return response.status;
    },
    (status) => ({ status }),
  );
  if (!dailyAuth.passed) {
    return blockedReport(
      "Repair daily-summary authentication before sending a smoke email.",
    );
  }

  const dailyDelivery = await check(
    "daily-summary-delivery",
    "Daily summary is sent and its delivery audit is persisted",
    async () => {
      const response = await request(
        fetchImpl,
        new URL("/api/agent/daily-summary", baseUrl),
        {
          method: "POST",
          headers: {
            "x-cron-secret": options.cronSecret,
            "x-required-rollout-mode": "disabled",
          },
        },
      );
      const body = await responseJson(response);
      const delivery =
        body.delivery !== null &&
        typeof body.delivery === "object" &&
        !Array.isArray(body.delivery)
          ? (body.delivery as Record<string, unknown>)
          : null;
      if (
        response.status !== 200 ||
        body.generated !== true ||
        body.alertAuditRecorded !== true ||
        delivery?.status !== "sent"
      ) {
        throw new Error("Daily summary was not sent and audited.");
      }
      return { status: response.status, deliveryStatus: delivery.status };
    },
    (value) => value,
  );
  if (!dailyDelivery.passed) {
    return blockedReport(
      "Resolve and audit daily-summary delivery before provider checks.",
    );
  }

  const databasePostconditions = await check(
    "database-postconditions",
    "Disabled runs, unchanged trades, released lease, and sent-email audit are persisted",
    async () => {
      const value = await inspectAfter({
        databaseUrl: options.databaseUrl,
        idempotencyKeys: [
          evidenceIds.modeMismatch,
          evidenceIds.cron,
          evidenceIds.admin,
        ],
        startedAt,
      });
      if (
        value.runCount !== 2 ||
        value.disabledRunCount !== 2 ||
        value.tradeCount !== before.value!.tradeCount ||
        !value.leaseReleased ||
        value.deliveryStatus !== "sent"
      ) {
        throw new Error("Target database postconditions are incomplete.");
      }
      return value;
    },
    (value) => value,
  );
  if (!databasePostconditions.passed) {
    return blockedReport(
      "Resolve target database postconditions before provider checks.",
    );
  }

  const providerConnectivity = await check(
    "provider-connectivity",
    "Foundry, Coinbase, and PostHog checks succeed without trading",
    providerSmoke,
    (value) => ({
      foundry: value.foundry,
      coinbase: value.coinbase,
      postHog: value.postHog,
      executionEnvironment: "operator",
    }),
  );
  const finalDatabasePostconditions = await check(
    "final-database-postconditions",
    "Provider validation leaves trades unchanged and the run lease released",
    async () => {
      const value = await inspectAfter({
        databaseUrl: options.databaseUrl,
        idempotencyKeys: [
          evidenceIds.modeMismatch,
          evidenceIds.cron,
          evidenceIds.admin,
        ],
        startedAt,
      });
      if (
        value.runCount !== 2 ||
        value.disabledRunCount !== 2 ||
        value.tradeCount !== before.value!.tradeCount ||
        !value.leaseReleased ||
        value.deliveryStatus !== "sent"
      ) {
        throw new Error(
          "Provider validation changed target database postconditions.",
        );
      }
      return value;
    },
    (value) => value,
  );
  if (!finalDatabasePostconditions.passed) {
    return blockedReport(
      "Reject provider validation until final no-trade database postconditions pass.",
    );
  }
  if (!providerConnectivity.passed) {
    return blockedReport(
      "Resolve provider connectivity before approving cron configuration.",
    );
  }

  const targetApproval = await check(
    "target-cron-approval",
    "Successful smoke binds the reviewed target origin, release, image digest, and keyed cron-secret binding",
    async () => {
      const approvedAtDate = now();
      if (Number.isNaN(approvedAtDate.getTime())) {
        throw new Error("Approval clock returned an invalid Date.");
      }
      const approvedAt = approvedAtDate.toISOString();
      const cronBinding = cronSecretBinding(
        options.cronSecret,
        approvalSecret,
      );
      const signature = computeApprovalSignature(
        canonicalApprovalPayload({
          approvalId: evidenceIds.approval,
          bindingId: evidenceIds.databaseBinding,
          modeMismatchEvidenceId: evidenceIds.modeMismatch,
          cronEvidenceId: evidenceIds.cron,
          adminEvidenceId: evidenceIds.admin,
          targetOrigin: baseUrl.origin,
          releaseSha,
          imageDigest,
          rolloutMode: "disabled",
          cronSecretBinding: cronBinding,
          approvedAt,
        }),
        approvalSecret,
      );
      await createApproval({
        databaseUrl: options.databaseUrl,
        approvalId: evidenceIds.approval,
        bindingId: evidenceIds.databaseBinding,
        modeMismatchEvidenceId: evidenceIds.modeMismatch,
        cronEvidenceId: evidenceIds.cron,
        adminEvidenceId: evidenceIds.admin,
        targetOrigin: baseUrl.origin,
        cronSecret: options.cronSecret,
        releaseSha,
        imageDigest,
        approvalSecret,
        approvedAt: approvedAtDate,
      });
      const binding: TargetSmokeBinding = {
        approvalId: evidenceIds.approval,
        bindingId: evidenceIds.databaseBinding,
        modeMismatchEvidenceId: evidenceIds.modeMismatch,
        cronEvidenceId: evidenceIds.cron,
        adminEvidenceId: evidenceIds.admin,
        targetOrigin: baseUrl.origin,
        releaseSha,
        imageDigest,
        rolloutMode: "disabled",
        cronSecretBinding: cronBinding,
        approvedAt,
        approvalSignature: signature,
      };
      return binding;
    },
    (value) => value,
  );
  if (!targetApproval.passed || !targetApproval.value) {
    return blockedReport(
      "Persist the successful target/cron approval before enabling schedules.",
    );
  }

  return {
    schemaVersion: "1.6.0",
    generatedAt: targetApproval.value.approvedAt,
    target: sanitizedTarget(options.baseUrl),
    releaseSha,
    imageDigest,
    rolloutMode: "disabled",
    evidenceIds,
    checks,
    providerChecksRunFrom: "operator-environment",
    passed: checks.every((check_) => check_.status === "pass"),
    manualGatesRemaining: [
      "Confirm the deployment_smoke event is visible in PostHog.",
      "Confirm the daily summary reached the intended mailbox.",
      "Review target logs for the two disabled run IDs before shadow promotion.",
      "Run attended non-trading warning and critical delivery/acknowledgment/escalation drills and index immutable evidence in issue #76 before #75.",
    ],
    binding: targetApproval.value,
  };
}
