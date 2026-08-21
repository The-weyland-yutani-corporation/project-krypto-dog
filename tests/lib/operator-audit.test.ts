import { mockDb } from "../setup";
import { recordOperatorAuditEvent } from "@/lib/operator-audit";
import type { AdminOperator } from "@/lib/admin-auth";

describe("immutable operator audit values", () => {
  it("persists redacted named provenance without raw sessions or claims", async () => {
    const operator: AdminOperator = {
      operatorId: "33333333-3333-4333-8333-333333333333",
      operatorName: "Release Owner Test",
      subjectId: "subject-release-owner",
      role: "RELEASE_OWNER",
      authenticationMethod: "ENTRA_MFA",
      authenticationContext: "c1,c2",
      mfaEvidence: "amr:mfa",
      authenticatedAt: new Date("2026-08-17T19:59:00.000Z"),
      tokenIssuedAt: new Date("2026-08-17T19:59:00.000Z"),
      sessionId: "raw-session-must-not-persist",
      policyVersion: "entra-admin-v1",
    };
    await recordOperatorAuditEvent({
      operator,
      action: "RUN_AGENT",
      outcome: "REQUESTED",
      requestId: "request-operator-audit",
      requestHeaders: new Headers(),
      occurredAt: new Date("2026-08-17T20:00:00.000Z"),
    });

    expect(mockDb._insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "request-operator-audit",
        action: "RUN_AGENT",
        operatorId: operator.operatorId,
        operatorName: operator.operatorName,
        operatorRole: operator.role,
        authenticationMethod: "ENTRA_MFA",
        sessionIdHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
    const persisted = mockDb._insertChain.values.mock.calls.at(-1)?.[0];
    expect(JSON.stringify(persisted)).not.toContain(operator.sessionId);
    expect(JSON.stringify(persisted)).not.toContain("access_token");
  });
});
