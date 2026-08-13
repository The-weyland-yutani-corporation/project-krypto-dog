import postgres from "postgres";

import {
  canonicalApprovalPayload,
  computeApprovalSignature,
  constantTimeEqual,
  cronSecretBinding,
  readOnly,
  validateApprovalSecret,
  validateImageDigest,
  validateReleaseSha,
} from "@/deployment/target-smoke";

/**
 * Read-only schedule-activation verifier.
 *
 * This module never mutates trading state. It exists to answer exactly one
 * question before a schedule is enabled: "does the most recent disabled
 * target-smoke approval, persisted by `runTargetSmoke`, still exactly match
 * this activation's release SHA, image digest, target origin, and cron
 * secret -- and is the underlying database currently safe (reconciled,
 * position-free, lease-free)?"
 *
 * Every comparison is exact and fails closed: a missing approval row, a
 * missing binding row, any field mismatch, a non-"disabled" persisted
 * rollout mode, an active lease, an unreconciled/quarantined accounting
 * status, or an open paper position all reject activation. There is no
 * partial-credit or best-effort path.
 *
 * The cron-secret binding and approval signature are both keyed
 * HMAC-SHA256 values over DEPLOYMENT_APPROVAL_SECRET -- a secret that is
 * required here and in target-smoke, but is never available to the
 * runtime/web process that can otherwise insert AgentJournal rows. This
 * activation check recomputes and constant-time verifies both values, so
 * a row inserted by anything that only knows CRON_SECRET (but not
 * DEPLOYMENT_APPROVAL_SECRET) cannot pass. A legacy row persisted before
 * this scheme existed has no cron-secret binding or approval signature at
 * all and is rejected the same way as a forged one -- fail closed, never
 * grandfathered in.
 */

export const ACTIVATION_CHECK_SCHEMA_VERSION = "1.0.0";

export type ActivationCheckOptions = {
  databaseUrl: string;
  releaseSha: string;
  imageDigest: string;
  targetOrigin: string;
  cronSecret: string;
  /**
   * High-entropy secret shared only between operator/ops-job invocations
   * of target-smoke and activation-check -- runtime/web never receives
   * it. Required so the persisted cron-secret binding and approval
   * signature can be recomputed and constant-time verified here.
   */
  approvalSecret: string;
};

export type ActivationCheckResult = {
  id: string;
  status: "pass" | "block";
  summary: string;
};

export type ActivationCheckReport = {
  schemaVersion: "1.0.0";
  generatedAt: string;
  targetOrigin: string;
  releaseSha: string;
  imageDigest: string;
  checks: ActivationCheckResult[];
  approved: boolean;
  blockers: string[];
};

type LatestApprovalRow = {
  id: string;
  createdAt: Date;
  bindingId: string | null;
  targetOrigin: string | null;
  cronSecretBinding: string | null;
  releaseSha: string | null;
  imageDigest: string | null;
  rolloutMode: string | null;
  approvalSignature: string | null;
};

type AgentStateRow = {
  accountingStatus: string;
  ethBalance: string | null;
  isRunning: boolean;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
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

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function sanitizedOrigin(value: string): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error(
      "Target origin must be a bare http(s) origin without credentials, a path, query, or fragment.",
    );
  }
  const loopback = LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase());
  if (url.protocol !== "https:" && !loopback) {
    throw new Error(
      "Target origin must use HTTPS unless it is an explicit loopback address.",
    );
  }
  return url.origin;
}

async function loadLatestApproval(
  sql: postgres.Sql,
): Promise<LatestApprovalRow | undefined> {
  const [row] = await sql<LatestApprovalRow[]>`
    SELECT
      id,
      "createdAt",
      "marketConditions" ->> 'bindingId' AS "bindingId",
      "marketConditions" ->> 'targetOrigin' AS "targetOrigin",
      "marketConditions" ->> 'cronSecretBinding' AS "cronSecretBinding",
      "marketConditions" ->> 'releaseSha' AS "releaseSha",
      "marketConditions" ->> 'imageDigest' AS "imageDigest",
      "marketConditions" ->> 'rolloutMode' AS "rolloutMode",
      "marketConditions" ->> 'approvalSignature' AS "approvalSignature"
    FROM "krypto"."AgentJournal"
    WHERE "marketConditions" ->> 'event' = 'deployment-smoke-approved'
    ORDER BY "createdAt" DESC, id DESC
    LIMIT 1
  `;
  return row;
}

async function bindingRowExists(
  sql: postgres.Sql,
  bindingId: string,
): Promise<boolean> {
  const [row] = await sql<Array<{ event: string | null }>>`
    SELECT "marketConditions" ->> 'event' AS event
    FROM "krypto"."AgentJournal"
    WHERE id = ${bindingId}
    LIMIT 1
  `;
  return row?.event === "deployment-smoke-binding";
}

async function loadAgentState(
  sql: postgres.Sql,
): Promise<AgentStateRow | undefined> {
  const [row] = await sql<AgentStateRow[]>`
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
  return row;
}

/**
 * Runs the read-only activation check against `DIRECT_URL`. Never opens a
 * writable transaction and never mutates trading state.
 */
export async function runActivationCheck(
  options: ActivationCheckOptions,
): Promise<ActivationCheckReport> {
  if (
    !options.databaseUrl ||
    !options.releaseSha ||
    !options.imageDigest ||
    !options.targetOrigin ||
    !options.cronSecret ||
    !options.approvalSecret
  ) {
    throw new Error(
      "DIRECT_URL, RELEASE_SHA, IMAGE_DIGEST, TARGET_ORIGIN, CRON_SECRET, and DEPLOYMENT_APPROVAL_SECRET are required.",
    );
  }
  const releaseSha = validateReleaseSha(options.releaseSha);
  const imageDigest = validateImageDigest(options.imageDigest);
  const targetOrigin = sanitizedOrigin(options.targetOrigin);
  const approvalSecret = validateApprovalSecret(options.approvalSecret);
  const expectedCronSecretBinding = cronSecretBinding(
    options.cronSecret,
    approvalSecret,
  );

  const checks: ActivationCheckResult[] = [];
  const blockers: string[] = [];

  function record(id: string, ok: boolean, summary: string): void {
    checks.push({ id, status: ok ? "pass" : "block", summary });
    if (!ok) {
      blockers.push(summary);
    }
  }

  let approval: LatestApprovalRow | undefined;
  let bindingExists = false;
  let state: AgentStateRow | undefined;

  try {
    await readOnly(options.databaseUrl, async (sql) => {
      approval = await loadLatestApproval(sql);
      if (approval?.bindingId) {
        bindingExists = await bindingRowExists(sql, approval.bindingId);
      }
      state = await loadAgentState(sql);
    });
  } catch (error) {
    record(
      "activation-database-read",
      false,
      `Could not read activation evidence: ${errorCode(error)}.`,
    );
    return {
      schemaVersion: ACTIVATION_CHECK_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      targetOrigin,
      releaseSha,
      imageDigest,
      checks,
      approved: false,
      blockers,
    };
  }

  record(
    "latest-approval-present",
    approval !== undefined,
    approval === undefined
      ? "No deployment-smoke-approved journal entry was found."
      : "A deployment-smoke-approved journal entry was found.",
  );

  record(
    "binding-row-present",
    approval !== undefined && bindingExists,
    approval === undefined
      ? "Binding row could not be checked because no approval was found."
      : bindingExists
        ? "The approval's referenced database-binding row exists."
        : "The approval's referenced database-binding row is missing.",
  );

  record(
    "target-origin-match",
    approval?.targetOrigin === targetOrigin,
    approval?.targetOrigin === targetOrigin
      ? "Persisted target origin matches this activation."
      : "Persisted target origin does not match this activation.",
  );

  record(
    "cron-secret-binding-match",
    constantTimeEqual(expectedCronSecretBinding, approval?.cronSecretBinding),
    constantTimeEqual(expectedCronSecretBinding, approval?.cronSecretBinding)
      ? "Persisted cron-secret binding matches this activation."
      : "Persisted cron-secret binding does not match this activation.",
  );

  const approvalSignatureFieldsPresent =
    approval !== undefined &&
    approval.bindingId !== null &&
    approval.targetOrigin !== null &&
    approval.releaseSha !== null &&
    approval.imageDigest !== null &&
    approval.rolloutMode !== null &&
    approval.cronSecretBinding !== null;

  const expectedApprovalSignature = approvalSignatureFieldsPresent
    ? computeApprovalSignature(
        canonicalApprovalPayload({
          bindingId: approval!.bindingId!,
          targetOrigin: approval!.targetOrigin!,
          releaseSha: approval!.releaseSha!,
          imageDigest: approval!.imageDigest!,
          rolloutMode: approval!.rolloutMode!,
          cronSecretBinding: approval!.cronSecretBinding!,
        }),
        approvalSecret,
      )
    : null;
  const approvalSignatureValid =
    expectedApprovalSignature !== null &&
    constantTimeEqual(expectedApprovalSignature, approval?.approvalSignature);

  record(
    "approval-signature-valid",
    approvalSignatureValid,
    approvalSignatureValid
      ? "Persisted approval signature is valid."
      : "Persisted approval signature is missing, from a legacy unsigned row, or invalid.",
  );

  record(
    "release-sha-match",
    approval?.releaseSha === releaseSha,
    approval?.releaseSha === releaseSha
      ? "Persisted release SHA matches this activation."
      : "Persisted release SHA does not match this activation.",
  );

  record(
    "image-digest-match",
    approval?.imageDigest === imageDigest,
    approval?.imageDigest === imageDigest
      ? "Persisted image digest matches this activation."
      : "Persisted image digest does not match this activation.",
  );

  record(
    "smoke-rollout-mode-disabled",
    approval?.rolloutMode === "disabled",
    approval?.rolloutMode === "disabled"
      ? "The approved smoke run was recorded with rollout mode disabled."
      : "The approved smoke run was not recorded with rollout mode disabled.",
  );

  const activeLease =
    state === undefined ||
    state.isRunning === true ||
    state.leaseOwner !== null ||
    state.leaseExpiresAt !== null;
  record(
    "no-active-lease",
    state !== undefined && !activeLease,
    state !== undefined && !activeLease
      ? "No active run lease is held."
      : "An active run lease is held or agent state is missing.",
  );

  const reconciled = state?.accountingStatus === "RECONCILED";
  record(
    "accounting-reconciled",
    reconciled,
    reconciled
      ? "Accounting status is RECONCILED."
      : `Accounting status is not RECONCILED (${state?.accountingStatus ?? "missing"}).`,
  );

  const ethBalance =
    state?.ethBalance === null || state?.ethBalance === undefined
      ? null
      : Number(state.ethBalance);
  const openPosition =
    ethBalance === null || !Number.isFinite(ethBalance)
      ? true
      : ethBalance !== 0;
  record(
    "no-open-paper-position",
    !openPosition,
    !openPosition
      ? "No open paper position is held."
      : "An open paper position is held.",
  );

  const approved = checks.every((entry) => entry.status === "pass");

  return {
    schemaVersion: ACTIVATION_CHECK_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    targetOrigin,
    releaseSha,
    imageDigest,
    checks,
    approved,
    blockers,
  };
}
