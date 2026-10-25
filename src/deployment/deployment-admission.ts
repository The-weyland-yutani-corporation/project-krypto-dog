import { randomUUID } from "node:crypto";
import postgres from "postgres";

import {
  approvalSignatureIsValid,
  bindingRowExists,
  loadLatestApproval,
} from "@/deployment/approval";
import {
  constantTimeEqual,
  cronSecretBinding,
  validateApprovalSecret,
  validateImageDigest,
  validateReleaseSha,
  validateTargetBaseUrl,
} from "@/deployment/target-smoke";
import { ETH_SCALE, parseDecimal } from "@/trading/accounting";
import { AccountingError } from "@/trading/errors";
import {
  assertFreshWorkflowObservation,
  WorkflowObservationError,
  type VerifiedWorkflowObservation,
  type WorkflowObservationReceipt,
} from "@/deployment/workflow-observation";

export const DEPLOYMENT_FENCE_TIMEOUT_SECONDS = 6 * 60 * 60;

export type DeploymentFenceAction = "acquire" | "verify" | "release";
export type DeploymentAdmissionStatus =
  | "admitted"
  | "held"
  | "released"
  | "deferred"
  | "blocked";

export const DEPLOYMENT_FENCE_SUCCESS_STATUS = {
  acquire: "admitted",
  verify: "held",
  release: "released",
} as const;

type DeploymentBinding = {
  owner: string;
  sourceReleaseSha: string;
  candidateReleaseSha: string;
  imageDigest: string;
  targetOrigin: string;
};

export type DeploymentAdmissionOptions = DeploymentBinding & {
  databaseUrl: string;
} & (
    | { action: "acquire"; cronSecret: string; approvalSecret: string }
    | { action: "verify" }
    | { action: "release"; observation: VerifiedWorkflowObservation }
  );

export type DeploymentAdmissionReport = DeploymentBinding & {
  schemaVersion: "1.1.0";
  generatedAt: string;
  operation: "deployment-admission";
  action: DeploymentFenceAction;
  status: DeploymentAdmissionStatus;
  reason: string;
  summary: string;
  expiresAt: string | null;
  workflowObservation: WorkflowObservationReceipt | null;
};

type StateRow = {
  accountingStatus: string;
  ethBalance: string | null;
  isOperatorPaused: boolean;
  isLocked: boolean;
  isRunning: boolean;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
};

type FenceRow = DeploymentBinding & {
  expiresAt: Date;
  releasedAt: Date | null;
};

export function validateDeploymentFenceOwner(value: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  ) {
    throw new Error("Deployment fence owner must be a lowercase UUID v4 or v5.");
  }
  return value;
}

export function validateDeploymentFenceAction(
  value: string,
): DeploymentFenceAction {
  if (value !== "acquire" && value !== "verify" && value !== "release") {
    throw new Error("Deployment fence action must be acquire, verify, or release.");
  }
  return value;
}

function matchesBinding(fence: FenceRow, binding: DeploymentBinding): boolean {
  return (
    fence.owner === binding.owner &&
    fence.sourceReleaseSha === binding.sourceReleaseSha &&
    fence.candidateReleaseSha === binding.candidateReleaseSha &&
    fence.imageDigest === binding.imageDigest &&
    fence.targetOrigin === binding.targetOrigin
  );
}

// Ops-only. Release consumes signed disabled/Manual readback in its transaction.
// Expiry is a recovery deadline, never permission to resume trading.
export async function runDeploymentAdmission(
  options: DeploymentAdmissionOptions,
): Promise<DeploymentAdmissionReport> {
  const action = validateDeploymentFenceAction(options.action);
  const binding: DeploymentBinding = {
    owner: validateDeploymentFenceOwner(options.owner),
    sourceReleaseSha: validateReleaseSha(options.sourceReleaseSha),
    candidateReleaseSha: validateReleaseSha(options.candidateReleaseSha),
    imageDigest: validateImageDigest(options.imageDigest),
    targetOrigin: validateTargetBaseUrl(
      options.targetOrigin,
      new URL(options.targetOrigin).hostname,
    ).origin,
  };
  if (!options.databaseUrl) {
    throw new Error("A direct database URL is required for deployment admission.");
  }
  if (options.action === "acquire") {
    validateApprovalSecret(options.approvalSecret);
    if (!options.cronSecret) {
      throw new Error("CRON_SECRET is required for deployment admission.");
    }
  }
  let workflowObservation: WorkflowObservationReceipt | null = null;

  function report(
    status: DeploymentAdmissionStatus,
    reason: string,
    summary: string,
    expiresAt: Date | null = null,
  ): DeploymentAdmissionReport {
    return {
      schemaVersion: "1.1.0",
      generatedAt: new Date().toISOString(),
      operation: "deployment-admission",
      action,
      ...binding,
      status,
      reason,
      summary,
      expiresAt: expiresAt?.toISOString() ?? null,
      workflowObservation,
    };
  }

  const sql = postgres(options.databaseUrl, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    connection: { application_name: "krypto-deployment-admission" },
  });
  try {
    async function mutate(
      tx: postgres.ReservedSql,
    ): Promise<DeploymentAdmissionReport> {
      await tx`SET LOCAL lock_timeout = '5s'`;
      await tx`SET LOCAL statement_timeout = '15s'`;
      const [state] = await tx<StateRow[]>`
        SELECT
          "accountingStatus"::text AS "accountingStatus",
          "currentPositionETHDecimal"::text AS "ethBalance",
          "isOperatorPaused", "isLocked", "isRunning",
          "leaseOwner", "leaseExpiresAt"
        FROM "krypto"."AgentState"
        WHERE id = 'singleton'
        FOR UPDATE
      `;
      if (!state) {
        return report("blocked", "missing-state", "AgentState is missing.");
      }
      const [{ observedAt }] = await tx<Array<{ observedAt: Date }>>`
        SELECT clock_timestamp() AS "observedAt"
      `;

      // A separate statement after the shared row lock sees a fence committed
      // while this transaction was waiting, unlike a pre-lock subquery snapshot.
      const [fence] = await tx<FenceRow[]>`
        SELECT
          owner, "sourceReleaseSha", "candidateReleaseSha",
          "imageDigest", "targetOrigin", "expiresAt", "releasedAt"
        FROM "krypto"."DeploymentFence"
        WHERE id = 'singleton'
          AND ("releasedAt" IS NULL OR owner = ${binding.owner})
        ORDER BY "releasedAt" NULLS FIRST
        LIMIT 1
        FOR UPDATE
      `;
      if (options.action === "acquire") {
        const approval = await loadLatestApproval(tx);
        const bound =
          approval?.bindingId &&
          approval.releaseSha === binding.sourceReleaseSha &&
          approval.imageDigest === binding.imageDigest &&
          approval.targetOrigin === binding.targetOrigin &&
          approval.rolloutMode === "disabled" &&
          constantTimeEqual(
            cronSecretBinding(options.cronSecret, options.approvalSecret),
            approval.cronSecretBinding,
          ) &&
          approvalSignatureIsValid(approval, options.approvalSecret) &&
          (await bindingRowExists(tx, approval.bindingId));
        if (!bound) {
          return report(
            "blocked",
            "source-binding",
            "The database has no valid signed approval for this exact source release.",
          );
        }
      }
      if (action !== "release" && (state.isOperatorPaused !== false || state.isLocked !== false)) {
        return report(
          "blocked",
          "stop-control",
          "Operator pause or drawdown lock is active or unverifiable.",
        );
      }
      if (state.accountingStatus !== "RECONCILED") {
        return report(
          "blocked",
          "accounting",
          "Deployment admission requires reconciled accounting.",
        );
      }
      if (
        typeof state.isRunning !== "boolean" ||
        (state.isRunning === false &&
          (state.leaseOwner !== null || state.leaseExpiresAt !== null)) ||
        (state.isRunning === true &&
          (typeof state.leaseOwner !== "string" ||
            state.leaseOwner.length === 0 ||
            !(state.leaseExpiresAt instanceof Date) ||
            !Number.isFinite(state.leaseExpiresAt.getTime())))
      ) {
        return report(
          "blocked",
          "invalid-lease",
          "Run lease state is inconsistent or unverifiable.",
        );
      }
      if (state.leaseExpiresAt !== null && state.leaseExpiresAt <= observedAt) {
        return report(
          "blocked",
          "expired-lease",
          "An expired run lease requires runtime recovery before deployment.",
        );
      }

      let ethBalance: bigint;
      try {
        if (state.ethBalance === null) {
          throw new AccountingError("ETH balance is uninitialized.");
        }
        ethBalance = parseDecimal(state.ethBalance, ETH_SCALE);
      } catch (error) {
        if (!(error instanceof AccountingError)) throw error;
        return report("blocked", "invalid-position", "ETH balance is invalid.");
      }
      if (ethBalance < 0n) {
        return report("blocked", "invalid-position", "ETH balance is negative.");
      }
      if (ethBalance !== 0n) {
        return report(
          action === "acquire" ? "deferred" : "blocked",
          "open-position",
          "An open paper position prevents cutover; no balance was changed.",
        );
      }
      if (
        state.isRunning !== false ||
        state.leaseOwner !== null ||
        state.leaseExpiresAt !== null
      ) {
        return report(
          action === "acquire" ? "deferred" : "blocked",
          "run-lease",
          "A run lease prevents cutover; no lease was stolen or cleared.",
        );
      }

      if (options.action === "verify") {
        if (!fence || fence.releasedAt !== null || !matchesBinding(fence, binding)) {
          return report("blocked", "ownership-mismatch", "The exact active cutover fence is not held.");
        }
        if (!Number.isFinite(fence.expiresAt.getTime()) || fence.expiresAt <= observedAt) {
          return report("blocked", "expired-fence", "The cutover deadline expired; no further mutation is authorized.");
        }
        return report("held", "fence-held", "The exact healthy, unexpired cutover fence remains held.", fence.expiresAt);
      }
      if (options.action === "release") {
        if (!fence || !matchesBinding(fence, binding)) {
          return report(
            "blocked",
            "ownership-mismatch",
            "Only the exact cutover owner and release binding may release its fence.",
          );
        }
        const [{ releaseObservedAt }] = await tx<Array<{ releaseObservedAt: Date }>>`
          SELECT clock_timestamp() AS "releaseObservedAt"
        `;
        try {
          assertFreshWorkflowObservation(options.observation, releaseObservedAt);
        } catch (error) {
          if (!(error instanceof WorkflowObservationError)) throw error;
          return report("blocked", "workflow-observation", error.message);
        }
        const observed = options.observation.observation;
        if (observed.purpose !== "cutover-release" ||
            observed.owner !== binding.owner ||
            observed.sourceReleaseSha !== binding.sourceReleaseSha ||
            observed.candidateReleaseSha !== binding.candidateReleaseSha ||
            observed.sourceImageDigest !== binding.imageDigest ||
            observed.targetOrigin !== binding.targetOrigin ||
            observed.workflow.sha !== binding.candidateReleaseSha ||
            (observed.releaseSha !== binding.candidateReleaseSha &&
              (observed.releaseSha !== binding.sourceReleaseSha || observed.imageDigest !== binding.imageDigest))) {
          return report(
            "blocked", "workflow-observation-binding",
            "Disabled readback does not match the exact cutover owner and release binding.",
          );
        }
        workflowObservation = options.observation.receipt;
        if (fence.releasedAt !== null) {
          return report(
            "released",
            "already-released",
            "This exact owner already released its fence.",
            fence.expiresAt,
          );
        }
        await tx`
          UPDATE "krypto"."DeploymentFence"
          SET "releasedAt" = clock_timestamp()
          WHERE id = 'singleton' AND owner = ${binding.owner}
        `;
      } else {
        if (fence?.releasedAt === null) {
          if (
            !Number.isFinite(fence.expiresAt.getTime()) ||
            fence.expiresAt <= observedAt
          ) {
            return report(
              "blocked",
              "expired-fence",
              "An expired cutover fence still blocks execution and requires recovery.",
            );
          }
          if (!matchesBinding(fence, binding)) {
            return report(
              "blocked",
              "ownership-mismatch",
              "Another cutover owns the fence; ownership cannot be stolen.",
            );
          }
          return report(
            "admitted",
            "already-owned",
            "This exact owner still holds the unexpired cutover fence.",
            fence.expiresAt,
          );
        }
        if (fence?.owner === binding.owner) {
          return report(
            "blocked",
            "released-owner",
            "A completed cutover owner cannot re-arm its released fence.",
          );
        }
        // Owner is the primary key; the singleton index excludes released history.
        const [created] = await tx<Array<{ expiresAt: Date }>>`
          INSERT INTO "krypto"."DeploymentFence" (
            id, owner, "sourceReleaseSha", "candidateReleaseSha",
            "imageDigest", "targetOrigin", "createdAt", "expiresAt", "releasedAt"
          ) VALUES (
            'singleton', ${binding.owner}, ${binding.sourceReleaseSha},
            ${binding.candidateReleaseSha}, ${binding.imageDigest},
            ${binding.targetOrigin}, clock_timestamp(),
            clock_timestamp() + ${DEPLOYMENT_FENCE_TIMEOUT_SECONDS} * INTERVAL '1 second',
            NULL
          )
          RETURNING "expiresAt"
        `;
        if (!created) {
          throw new Error("Deployment fence acquisition lost ownership.");
        }
        await tx`
          INSERT INTO "krypto"."AgentJournal" (id, "entryText", "marketConditions")
          VALUES (
            ${`deployment-fence-acquired-${randomUUID()}`},
            'Deployment cutover acquired an owned fence; trading state is unchanged.',
            ${tx.json({
              event: "deployment-fence-acquired",
              ...binding,
              expiresAt: created.expiresAt.toISOString(),
            })}
          )
        `;
        return report(
          "admitted",
          "fence-acquired",
          "The flat, lease-free source release is fenced for this cutover.",
          created.expiresAt,
        );
      }

      await tx`
        INSERT INTO "krypto"."AgentJournal" (id, "entryText", "marketConditions")
        VALUES (
          ${`deployment-fence-released-${randomUUID()}`},
          'Ops caller released its owned deployment fence; operator stops are unchanged.',
          ${tx.json({ event: "deployment-fence-released", ...binding, workflowObservation })}
        )
      `;
      return report(
        "released",
        "fence-released",
        "The exact owned cutover fence was released; operator stops were not changed.",
        fence.expiresAt,
      );
    }
    const tx = await sql.reserve();
    try {
      await tx`BEGIN`;
      const result = await mutate(tx);
      await tx`COMMIT`;
      return result;
    } catch (error) {
      await tx`ROLLBACK`;
      throw error;
    } finally {
      tx.release();
    }
  } catch (error) {
    const code =
      error instanceof postgres.PostgresError ? error.code : "unknown";
    return report(
      action === "acquire" && code === "55P03" ? "deferred" : "blocked",
      code === "55P03" ? "database-busy" : "database-error",
      code === "55P03"
        ? "The account row is busy; no cutover mutation was committed."
        : "Deployment admission failed; no rollout is authorized.",
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}
