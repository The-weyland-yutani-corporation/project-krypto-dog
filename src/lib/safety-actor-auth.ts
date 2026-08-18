import {
  createHash,
  createPublicKey,
  verify,
  type KeyObject,
} from "node:crypto";
import {
  SAFETY_ACTOR_ROLES,
  SafetyRosterValidationError,
  type SafetyActorRole,
} from "@/lib/safety-roster";

const ACTOR_KEY_ENV_KEYS: Record<SafetyActorRole, string> = {
  PRIMARY_ON_CALL: "SAFETY_PRIMARY_ON_CALL_PUBLIC_KEY",
  BACKUP_ON_CALL: "SAFETY_BACKUP_ON_CALL_PUBLIC_KEY",
  RELEASE_OWNER: "SAFETY_RELEASE_OWNER_PUBLIC_KEY",
  SAFETY_APPROVER: "SAFETY_APPROVER_PUBLIC_KEY",
  EVIDENCE_CUSTODIAN: "SAFETY_EVIDENCE_CUSTODIAN_PUBLIC_KEY",
  ROLLBACK_OWNER: "SAFETY_ROLLBACK_OWNER_PUBLIC_KEY",
};

export type SafetyActorPublicKeys = Record<SafetyActorRole, KeyObject>;

export interface SafetyActorAssertion {
  action: "ACKNOWLEDGE" | "ESCALATE" | "RESOLVE";
  incidentId: string;
  actorId: string;
  actorRole: SafetyActorRole;
  reason: string;
  evidence: Record<string, unknown> | undefined;
  signedAt: string;
  signature: string;
}

function readActorPublicKey(
  value: string | undefined,
  envKey: string,
): KeyObject {
  const encoded = value?.trim();
  if (
    !encoded ||
    encoded.length > 256 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  ) {
    throw new SafetyRosterValidationError(
      `${envKey} must be a base64 Ed25519 SPKI public key`,
    );
  }
  try {
    const key = createPublicKey({
      key: Buffer.from(encoded, "base64"),
      format: "der",
      type: "spki",
    });
    if (key.asymmetricKeyType !== "ed25519") {
      throw new Error("not Ed25519");
    }
    return key;
  } catch {
    throw new SafetyRosterValidationError(
      `${envKey} must be a valid Ed25519 SPKI public key`,
    );
  }
}

export function readSafetyActorPublicKeys(
  env: Record<string, string | undefined> = process.env,
): SafetyActorPublicKeys {
  const keys = SAFETY_ACTOR_ROLES.map((role) => {
    const envKey = ACTOR_KEY_ENV_KEYS[role];
    return {
      role,
      key: readActorPublicKey(env[envKey], envKey),
    };
  });
  const fingerprints = keys.map(({ key }) =>
    createHash("sha256")
      .update(key.export({ format: "der", type: "spki" }) as Buffer)
      .digest("hex"),
  );
  if (new Set(fingerprints).size !== keys.length) {
    throw new SafetyRosterValidationError(
      "Every safety responder role must use a distinct public key",
    );
  }
  return Object.fromEntries(
    keys.map(({ role, key }) => [role, key]),
  ) as SafetyActorPublicKeys;
}

function canonicalEvidence(
  evidence: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (!evidence) return null;
  return Object.fromEntries(
    Object.entries(evidence).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

export function canonicalSafetyActorAssertion(
  assertion: Omit<SafetyActorAssertion, "signature">,
): string {
  return JSON.stringify({
    action: assertion.action,
    incidentId: assertion.incidentId,
    actorId: assertion.actorId,
    actorRole: assertion.actorRole,
    reason: assertion.reason,
    evidence: canonicalEvidence(assertion.evidence),
    signedAt: assertion.signedAt,
  });
}

export function verifySafetyActorAssertion(
  assertion: SafetyActorAssertion,
  options: {
    env?: Record<string, string | undefined>;
    now?: Date;
  } = {},
): boolean {
  const signedAt = new Date(assertion.signedAt);
  const now = options.now ?? new Date();
  if (
    Number.isNaN(signedAt.getTime()) ||
    Math.abs(now.getTime() - signedAt.getTime()) > 5 * 60 * 1_000 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(assertion.signature)
  ) {
    return false;
  }
  const keys = readSafetyActorPublicKeys(options.env);
  return verify(
    null,
    Buffer.from(
      canonicalSafetyActorAssertion({
        action: assertion.action,
        incidentId: assertion.incidentId,
        actorId: assertion.actorId,
        actorRole: assertion.actorRole,
        reason: assertion.reason,
        evidence: assertion.evidence,
        signedAt: assertion.signedAt,
      }),
      "utf8",
    ),
    keys[assertion.actorRole],
    Buffer.from(assertion.signature, "base64"),
  );
}
