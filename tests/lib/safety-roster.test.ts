import {
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import {
  SAFETY_ACTOR_ROLES,
  SafetyRosterValidationError,
  readSafetyRoster,
  rosterAssignmentForRole,
  safetyActorPublicKeysConfigured,
  summarizeSafetyRoster,
} from "@/lib/safety-roster";
import {
  canonicalSafetyActorAssertion,
  readSafetyActorPublicKeys,
  verifySafetyActorAssertion,
} from "@/lib/safety-actor-auth";

const COMPLETE_ROSTER = {
  SAFETY_PRIMARY_ON_CALL: "ops-primary",
  SAFETY_BACKUP_ON_CALL: "ops-backup",
  SAFETY_RELEASE_OWNER: "release-owner",
  SAFETY_APPROVER: "safety-approver",
  SAFETY_EVIDENCE_CUSTODIAN: "evidence-custodian",
  SAFETY_ROLLBACK_OWNER: "rollback-owner",
};

describe("safety responder roster", () => {
  it("loads required assignments and returns only a redacted summary", () => {
    const roster = readSafetyRoster(COMPLETE_ROSTER);
    expect(rosterAssignmentForRole(roster, "SAFETY_APPROVER")).toBe(
      "safety-approver",
    );
    const summary = summarizeSafetyRoster(roster);
    expect(summary.complete).toBe(true);
    expect(Object.values(summary.assigned)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(JSON.stringify(summary)).not.toContain("ops-primary");
    expect(JSON.stringify(summary)).not.toContain("safety-approver");
  });

  it.each([
    "",
    "TBD",
    "placeholder",
    "example operator",
    "[REQUIRED — named person]",
    "https://owner.test",
  ])(
    "rejects missing or placeholder assignment %p",
    (assignment) => {
      expect(() =>
        readSafetyRoster({
          ...COMPLETE_ROSTER,
          SAFETY_PRIMARY_ON_CALL: assignment,
        }),
      ).toThrow(SafetyRosterValidationError);
    },
  );

  it("requires independent primary/backup and release/safety assignments", () => {
    expect(() =>
      readSafetyRoster({
        ...COMPLETE_ROSTER,
        SAFETY_BACKUP_ON_CALL: COMPLETE_ROSTER.SAFETY_PRIMARY_ON_CALL,
      }),
    ).toThrow("Primary and backup");
    expect(() =>
      readSafetyRoster({
        ...COMPLETE_ROSTER,
        SAFETY_APPROVER: COMPLETE_ROSTER.SAFETY_RELEASE_OWNER,
      }),
    ).toThrow("Release owner and safety approver");
  });

  it("verifies a fresh Ed25519 role assertion and rejects tampering", () => {
    const keyEnvNames = {
      PRIMARY_ON_CALL: "SAFETY_PRIMARY_ON_CALL_PUBLIC_KEY",
      BACKUP_ON_CALL: "SAFETY_BACKUP_ON_CALL_PUBLIC_KEY",
      RELEASE_OWNER: "SAFETY_RELEASE_OWNER_PUBLIC_KEY",
      SAFETY_APPROVER: "SAFETY_APPROVER_PUBLIC_KEY",
      EVIDENCE_CUSTODIAN: "SAFETY_EVIDENCE_CUSTODIAN_PUBLIC_KEY",
      ROLLBACK_OWNER: "SAFETY_ROLLBACK_OWNER_PUBLIC_KEY",
    } as const;
    const keyPairs = {} as Record<
      (typeof SAFETY_ACTOR_ROLES)[number],
      { publicKey: KeyObject; privateKey: KeyObject }
    >;
    for (const role of SAFETY_ACTOR_ROLES) {
      keyPairs[role] = generateKeyPairSync("ed25519") as {
        publicKey: KeyObject;
        privateKey: KeyObject;
      };
    }
    const env = Object.fromEntries(
      SAFETY_ACTOR_ROLES.map((role) => [
        keyEnvNames[role],
        keyPairs[role].publicKey
          .export({ format: "der", type: "spki" })
          .toString("base64"),
      ]),
    );
    expect(safetyActorPublicKeysConfigured(env)).toBe(true);
    const unsigned = {
      action: "ACKNOWLEDGE" as const,
      incidentId: "incident-42",
      actorId: "release-owner",
      actorRole: "RELEASE_OWNER" as const,
      reason: "Containment started",
      evidence: { containmentDecision: "rollout-disabled" },
      signedAt: "2026-08-17T20:00:00.000Z",
    };
    const signature = sign(
      null,
      Buffer.from(canonicalSafetyActorAssertion(unsigned), "utf8"),
      keyPairs.RELEASE_OWNER.privateKey,
    ).toString("base64");

    expect(
      verifySafetyActorAssertion(
        { ...unsigned, signature },
        { env, now: new Date("2026-08-17T20:04:00.000Z") },
      ),
    ).toBe(true);
    expect(
      verifySafetyActorAssertion(
        { ...unsigned, reason: "Tampered", signature },
        { env, now: new Date("2026-08-17T20:04:00.000Z") },
      ),
    ).toBe(false);
    expect(
      verifySafetyActorAssertion(
        { ...unsigned, signature },
        { env, now: new Date("2026-08-17T20:06:00.000Z") },
      ),
    ).toBe(false);
    expect(() =>
      readSafetyActorPublicKeys({
        ...env,
        SAFETY_BACKUP_ON_CALL_PUBLIC_KEY:
          env.SAFETY_PRIMARY_ON_CALL_PUBLIC_KEY?.replace(/=+$/, ""),
      }),
    ).toThrow("distinct public key");
  });
});
