import { databaseClient } from "@/db";
import { admissionSnapshot } from "@/lib/run-admission";
import { resolveTradingMode } from "@/trading/strategy-config";
import {
  readSafetyRoster,
  safetyActorPublicKeysConfigured,
} from "@/lib/safety-roster";

export const EXPECTED_SCHEMA_FINGERPRINT =
  "0012_operator_admin_identity_v1";
export const EXECUTION_CONTRACT_VERSION = "bounded-sync-v1";
export const READINESS_TIMEOUT_MS = 4_000;

interface ReadinessDatabaseRow {
  [key: string]: unknown;
  runtimeMember: boolean;
  runtimeGroupNoLogin: boolean;
  separateRuntimeLogin: boolean;
  elevatedMember: boolean;
  safeRole: boolean;
  loginRole: boolean;
  inheritedRole: boolean;
  stableIdentity: boolean;
  boundedConnectionLimit: boolean;
  postgres17: boolean;
  ledgerDenied: boolean;
  runtimeContractReadable: boolean;
  schemaFingerprint: string | null;
  contractVersion: number | null;
  singletonCount: number;
  reconciledCount: number;
  leaseSaneCount: number;
  unresolvedCriticalIncidentCount: number;
}

export type ReadinessReasonCode =
  | "release-provenance"
  | "runtime-configuration"
  | "database-connectivity"
  | "runtime-identity"
  | "runtime-denials"
  | "postgres-version"
  | "schema-contract"
  | "state-singleton"
  | "accounting-reconciliation"
  | "lease-sanity"
  | "safety-incidents"
  | "safety-roster"
  | "rollout-mode"
  | "admission-capacity";

export interface ReadinessDependencies {
  query?: () => Promise<ReadinessDatabaseRow | undefined>;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  admission?: () => ReturnType<typeof admissionSnapshot>;
}

export interface ReadinessResult {
  ready: boolean;
  reasons: ReadonlyArray<ReadinessReasonCode>;
}

const READINESS_QUERY = `
  SELECT
    pg_has_role(current_user, 'krypto_runtime', 'MEMBER') AS "runtimeMember",
    (
      SELECT NOT runtime_group.rolcanlogin
      FROM pg_roles AS runtime_group
      WHERE runtime_group.rolname = 'krypto_runtime'
    ) AS "runtimeGroupNoLogin",
    current_user <> 'krypto_runtime' AS "separateRuntimeLogin",
    (
      pg_has_role(current_user, 'krypto_schema_owner', 'MEMBER')
      OR pg_has_role(current_user, 'krypto_migrator', 'MEMBER')
      OR pg_has_role(current_user, 'krypto_scheduler', 'MEMBER')
    ) AS "elevatedMember",
    (
      NOT role.rolsuper
      AND NOT role.rolcreatedb
      AND NOT role.rolcreaterole
      AND NOT role.rolreplication
      AND NOT role.rolbypassrls
    ) AS "safeRole",
    role.rolcanlogin AS "loginRole",
    role.rolinherit AS "inheritedRole",
    current_user = session_user AND current_role = current_user
      AS "stableIdentity",
    role.rolconnlimit = 20 AS "boundedConnectionLimit",
    (
      current_setting('server_version_num')::integer >= 170000
      AND current_setting('server_version_num')::integer < 180000
    ) AS "postgres17",
    (
      to_regnamespace('drizzle') IS NULL
      OR NOT has_schema_privilege(current_user, 'drizzle', 'USAGE')
    ) AS "ledgerDenied",
    has_table_privilege(
      current_user,
      'krypto."RuntimeContract"',
      'SELECT'
    ) AS "runtimeContractReadable",
    contract."schemaFingerprint" AS "schemaFingerprint",
    contract."contractVersion" AS "contractVersion",
    state_counts."singletonCount"::integer AS "singletonCount",
    state_counts."reconciledCount"::integer AS "reconciledCount",
    state_counts."leaseSaneCount"::integer AS "leaseSaneCount",
    incident_counts."unresolvedCriticalIncidentCount"::integer
      AS "unresolvedCriticalIncidentCount"
  FROM pg_roles AS role
  CROSS JOIN (
    SELECT
      count(*) FILTER (WHERE state."id" = 'singleton') AS "singletonCount",
      count(*) FILTER (
        WHERE state."id" = 'singleton'
          AND state."accountingStatus" = 'RECONCILED'
      ) AS "reconciledCount",
      count(*) FILTER (
        WHERE state."id" = 'singleton'
          AND (
            (
              state."leaseOwner" IS NULL
              AND state."leaseExpiresAt" IS NULL
              AND NOT state."isRunning"
            )
            OR (
              state."leaseOwner" IS NOT NULL
              AND state."leaseExpiresAt" IS NOT NULL
              AND state."isRunning"
              AND state."leaseExpiresAt" > clock_timestamp()
              AND state."leaseExpiresAt"
                <= clock_timestamp() + interval '300 seconds'
            )
          )
      ) AS "leaseSaneCount"
    FROM "krypto"."AgentState" AS state
  ) AS state_counts
  CROSS JOIN (
    SELECT count(*) AS "unresolvedCriticalIncidentCount"
    FROM (
      SELECT DISTINCT ON (incident."incidentId")
        incident."severity",
        incident."status"
      FROM "krypto"."SafetyIncidentOutbox" AS incident
      ORDER BY
        incident."incidentId",
        incident."eventSequence" DESC
    ) AS latest_incident
    WHERE latest_incident."severity" = 'CRITICAL'
      AND latest_incident."status" <> 'RESOLVED'
  ) AS incident_counts
  LEFT JOIN "krypto"."RuntimeContract" AS contract
    ON contract."id" = 'singleton'
  WHERE role.rolname = current_user
`;

function queryReadinessDatabase(): {
  promise: Promise<ReadinessDatabaseRow | undefined>;
  cancel: () => void;
} {
  // postgres.js exposes explicit cancellation on PendingQuery. Using the
  // runtime client keeps readiness on DATABASE_URL and prevents a timed-out
  // probe from occupying the single runtime pool slot in the background.
  const pending =
    databaseClient.unsafe<ReadinessDatabaseRow[]>(READINESS_QUERY);
  return {
    promise: pending.then((rows) => rows[0]),
    cancel: () => pending.cancel(),
  };
}

function releaseProvenanceValid(
  env: Record<string, string | undefined>,
): boolean {
  return (
    /^[0-9a-f]{40}$/.test(env.RELEASE_SHA ?? "") &&
    /^sha256:[0-9a-f]{64}$/.test(env.IMAGE_DIGEST ?? "")
  );
}

function boundedPositiveInteger(
  value: string | undefined,
  maximum: number,
): boolean {
  if (!/^[1-9][0-9]*$/.test(value ?? "")) return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= maximum;
}

function runtimeConfigurationValid(
  env: Record<string, string | undefined>,
): boolean {
  return (
    env.EXECUTION_CONTRACT_VERSION === EXECUTION_CONTRACT_VERSION &&
    env.DATABASE_POOL_MAX === "1" &&
    env.AGENT_RUN_ADMISSION_CAPACITY === "1" &&
    boundedPositiveInteger(env.COINBASE_DAILY_REQUEST_BUDGET, 1_000) &&
    boundedPositiveInteger(env.FOUNDRY_DAILY_REQUEST_BUDGET, 200) &&
    boundedPositiveInteger(env.POSTHOG_DAILY_REQUEST_BUDGET, 2_000) &&
    boundedPositiveInteger(env.ACS_DAILY_REQUEST_BUDGET, 100) &&
    Boolean(env.AZURE_FOUNDRY_AGENT_NAME?.trim()) &&
    Boolean(env.AZURE_FOUNDRY_AGENT_VERSION?.trim())
  );
}

export async function evaluateReadiness(
  dependencies: ReadinessDependencies = {},
): Promise<ReadinessResult> {
  const env = dependencies.env ?? process.env;
  const timeoutMs = dependencies.timeoutMs ?? READINESS_TIMEOUT_MS;
  const operation = dependencies.query
    ? { promise: dependencies.query(), cancel: () => undefined }
    : queryReadinessDatabase();
  let row: ReadinessDatabaseRow | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    row = await Promise.race([
      operation.promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          try {
            operation.cancel();
          } catch {
            // Cancellation is best effort; the bounded client timeouts remain
            // the second line of defense.
          }
          reject(new Error("Readiness database query timed out"));
        }, timeoutMs);
      }),
    ]);
  } catch {
    row = undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }

  let rolloutMode = false;
  let resolvedMode: ReturnType<typeof resolveTradingMode> | null = null;
  try {
    resolvedMode = resolveTradingMode(env);
    rolloutMode = true;
  } catch {
    rolloutMode = false;
  }

  let admissionAvailable = false;
  try {
    admissionAvailable =
      (dependencies.admission ?? admissionSnapshot)().available > 0;
  } catch {
    admissionAvailable = false;
  }

  let safetyRosterValid = false;
  try {
    if (resolvedMode !== "disabled") {
      readSafetyRoster(env);
      if (!safetyActorPublicKeysConfigured(env)) {
        throw new Error("Safety actor public keys are incomplete");
      }
    }
    safetyRosterValid = true;
  } catch {
    safetyRosterValid = false;
  }

  const checks: Array<[ReadinessReasonCode, boolean]> = [
    ["release-provenance", releaseProvenanceValid(env)],
    ["runtime-configuration", runtimeConfigurationValid(env)],
    ["database-connectivity", Boolean(row)],
    [
      "runtime-identity",
      Boolean(
        row?.runtimeMember &&
          row.runtimeGroupNoLogin &&
          row.separateRuntimeLogin &&
          row.loginRole &&
          row.inheritedRole &&
          row.stableIdentity &&
          row.boundedConnectionLimit,
      ),
    ],
    [
      "runtime-denials",
      Boolean(row?.safeRole && !row.elevatedMember && row.ledgerDenied),
    ],
    ["postgres-version", Boolean(row?.postgres17)],
    [
      "schema-contract",
      Boolean(
        row?.runtimeContractReadable &&
          row.schemaFingerprint === EXPECTED_SCHEMA_FINGERPRINT &&
          row.contractVersion === 4,
      ),
    ],
    ["state-singleton", row?.singletonCount === 1],
    ["accounting-reconciliation", row?.reconciledCount === 1],
    ["lease-sanity", row?.leaseSaneCount === 1],
    [
      "safety-incidents",
      row?.unresolvedCriticalIncidentCount === 0,
    ],
    ["safety-roster", safetyRosterValid],
    ["rollout-mode", rolloutMode],
    ["admission-capacity", admissionAvailable],
  ];
  const reasons = checks
    .filter(([, passed]) => !passed)
    .map(([reason]) => reason);
  return { ready: reasons.length === 0, reasons };
}
