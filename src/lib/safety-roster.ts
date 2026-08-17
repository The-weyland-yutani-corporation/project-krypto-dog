export const SAFETY_ACTOR_ROLES = [
  "PRIMARY_ON_CALL",
  "BACKUP_ON_CALL",
  "RELEASE_OWNER",
  "SAFETY_APPROVER",
  "EVIDENCE_CUSTODIAN",
  "ROLLBACK_OWNER",
] as const;

export type SafetyActorRole = (typeof SAFETY_ACTOR_ROLES)[number];

export interface SafetyRoster {
  primaryOnCall: string;
  backupOnCall: string;
  releaseOwner: string;
  safetyApprover: string;
  evidenceCustodian: string;
  rollbackOwner: string;
}

export interface RedactedSafetyRosterSummary {
  complete: boolean;
  assigned: Record<keyof SafetyRoster, boolean>;
  authenticatorsConfigured?: boolean;
}

const ROSTER_ENV_KEYS: Record<keyof SafetyRoster, string> = {
  primaryOnCall: "SAFETY_PRIMARY_ON_CALL",
  backupOnCall: "SAFETY_BACKUP_ON_CALL",
  releaseOwner: "SAFETY_RELEASE_OWNER",
  safetyApprover: "SAFETY_APPROVER",
  evidenceCustodian: "SAFETY_EVIDENCE_CUSTODIAN",
  rollbackOwner: "SAFETY_ROLLBACK_OWNER",
};

const ACTOR_PUBLIC_KEY_ENV_NAMES = [
  "SAFETY_PRIMARY_ON_CALL_PUBLIC_KEY",
  "SAFETY_BACKUP_ON_CALL_PUBLIC_KEY",
  "SAFETY_RELEASE_OWNER_PUBLIC_KEY",
  "SAFETY_APPROVER_PUBLIC_KEY",
  "SAFETY_EVIDENCE_CUSTODIAN_PUBLIC_KEY",
  "SAFETY_ROLLBACK_OWNER_PUBLIC_KEY",
] as const;

const PLACEHOLDER_VALUES = new Set([
  "-",
  "changeme",
  "example",
  "n/a",
  "na",
  "name",
  "none",
  "not-set",
  "owner",
  "person",
  "placeholder",
  "replace-me",
  "required",
  "tbd",
  "test",
  "todo",
  "unknown",
  "unset",
  "your name",
  "your-name",
]);

export class SafetyRosterValidationError extends Error {
  readonly code = "SAFETY_ROSTER_INVALID";
}

function parseAssignment(value: string | undefined, envKey: string): string {
  const assignment = value?.trim();
  if (!assignment) {
    throw new SafetyRosterValidationError(`${envKey} is required`);
  }
  const normalized = assignment.toLowerCase();
  if (
    assignment.length > 120 ||
    /[\r\n\u0000-\u001f\u007f]/.test(assignment) ||
    assignment.includes("://") ||
    PLACEHOLDER_VALUES.has(normalized) ||
    normalized.startsWith("[required") ||
    normalized.startsWith("<") ||
    normalized.startsWith("example ") ||
    normalized.startsWith("test ") ||
    normalized.includes("@example.")
  ) {
    throw new SafetyRosterValidationError(
      `${envKey} must contain a real, bounded role assignment`,
    );
  }
  return assignment;
}

export function readSafetyRoster(
  env: Record<string, string | undefined> = process.env,
): SafetyRoster {
  const roster = Object.fromEntries(
    Object.entries(ROSTER_ENV_KEYS).map(([role, envKey]) => [
      role,
      parseAssignment(env[envKey], envKey),
    ]),
  ) as unknown as SafetyRoster;

  if (
    roster.primaryOnCall.toLowerCase() === roster.backupOnCall.toLowerCase()
  ) {
    throw new SafetyRosterValidationError(
      "Primary and backup on-call assignments must be distinct",
    );
  }
  if (
    roster.releaseOwner.toLowerCase() === roster.safetyApprover.toLowerCase()
  ) {
    throw new SafetyRosterValidationError(
      "Release owner and safety approver assignments must be distinct",
    );
  }
  return roster;
}

export function summarizeSafetyRoster(
  roster: SafetyRoster,
  authenticatorsConfigured?: boolean,
): RedactedSafetyRosterSummary {
  const assigned = {
    primaryOnCall: Boolean(roster.primaryOnCall),
    backupOnCall: Boolean(roster.backupOnCall),
    releaseOwner: Boolean(roster.releaseOwner),
    safetyApprover: Boolean(roster.safetyApprover),
    evidenceCustodian: Boolean(roster.evidenceCustodian),
    rollbackOwner: Boolean(roster.rollbackOwner),
  };
  return {
    complete: Object.values(assigned).every(Boolean),
    assigned,
    ...(authenticatorsConfigured === undefined
      ? {}
      : { authenticatorsConfigured }),
  };
}

export function safetyActorPublicKeysConfigured(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const keys = ACTOR_PUBLIC_KEY_ENV_NAMES.map((name) => env[name]?.trim());
  return (
    keys.every(
      (key) =>
        key !== undefined &&
        key.length <= 256 &&
        /^[A-Za-z0-9+/]+={0,2}$/.test(key),
    ) &&
    new Set(keys.map((key) => key?.replace(/=+$/, ""))).size === keys.length
  );
}

export function rosterAssignmentForRole(
  roster: SafetyRoster,
  role: SafetyActorRole,
): string {
  switch (role) {
    case "PRIMARY_ON_CALL":
      return roster.primaryOnCall;
    case "BACKUP_ON_CALL":
      return roster.backupOnCall;
    case "RELEASE_OWNER":
      return roster.releaseOwner;
    case "SAFETY_APPROVER":
      return roster.safetyApprover;
    case "EVIDENCE_CUSTODIAN":
      return roster.evidenceCustodian;
    case "ROLLBACK_OWNER":
      return roster.rollbackOwner;
  }
}
