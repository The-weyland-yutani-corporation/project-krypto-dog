import { authorizeAdminRequest } from "@/lib/admin-auth";
import {
  ADMIN_TEST_IDS,
  ADMIN_TEST_NOW,
  adminIdentityEnv,
  adminPrincipalHeaders,
} from "../helpers/admin-identity";

describe("platform-backed admin authorization", () => {
  it("authorizes a named allowlisted MFA-backed operator", () => {
    const result = authorizeAdminRequest(
      adminPrincipalHeaders(),
      "READ_ADMIN",
      { env: adminIdentityEnv(), now: ADMIN_TEST_NOW },
    );
    expect(result).toMatchObject({
      ok: true,
      operator: {
        operatorId: ADMIN_TEST_IDS.operatorId,
        operatorName: "Release Owner Test",
        role: "RELEASE_OWNER",
        authenticationMethod: "ENTRA_MFA",
        policyVersion: "entra-admin-v1",
      },
    });
  });

  it("requires recent step-up context for every sensitive action", () => {
    const env = adminIdentityEnv();
    for (const action of [
      "RUN_AGENT",
      "PAUSE_AGENT",
      "RESUME_AGENT",
      "UNLOCK_AGENT",
      "RECOVER_RUN_LEASE",
      "TEST_FIRE_SAFETY_INCIDENT",
    ] as const) {
      expect(
        authorizeAdminRequest(adminPrincipalHeaders(), action, {
          env,
          now: ADMIN_TEST_NOW,
        }).ok,
      ).toBe(true);
      expect(
        authorizeAdminRequest(
          adminPrincipalHeaders({ authContexts: ["c1"] }),
          action,
          { env, now: ADMIN_TEST_NOW },
        ),
      ).toMatchObject({ ok: false, code: "STEP_UP_REQUIRED" });
    }
  });

  it("fails closed for anonymous, malformed, and disabled platform seams", () => {
    expect(
      authorizeAdminRequest(new Headers(), "READ_ADMIN", {
        env: adminIdentityEnv(),
        now: ADMIN_TEST_NOW,
      }),
    ).toMatchObject({ ok: false, code: "AUTHENTICATION_REQUIRED" });
    expect(
      authorizeAdminRequest(
        adminPrincipalHeaders({ malformed: true }),
        "READ_ADMIN",
        { env: adminIdentityEnv(), now: ADMIN_TEST_NOW },
      ),
    ).toMatchObject({ ok: false, code: "AUTHENTICATION_INVALID" });
    expect(
      authorizeAdminRequest(adminPrincipalHeaders(), "READ_ADMIN", {
        env: { ...adminIdentityEnv(), ADMIN_IDENTITY_MODE: "disabled" },
        now: ADMIN_TEST_NOW,
      }),
    ).toMatchObject({ ok: false, code: "IDENTITY_DISABLED" });
    expect(
      authorizeAdminRequest(adminPrincipalHeaders(), "READ_ADMIN", {
        env: { ...adminIdentityEnv(), ADMIN_PLATFORM_AUTH: "forwarded-header" },
        now: ADMIN_TEST_NOW,
      }),
    ).toMatchObject({ ok: false, code: "PLATFORM_BOUNDARY_INVALID" });
    expect(
      authorizeAdminRequest(adminPrincipalHeaders(), "READ_ADMIN", {
        env: {
          ...adminIdentityEnv(),
          NODE_ENV: "test",
          ADMIN_PLATFORM_AUTH: "forwarded-header",
        },
        now: ADMIN_TEST_NOW,
      }),
    ).toMatchObject({ ok: false, code: "PLATFORM_BOUNDARY_INVALID" });
  });

  it.each([
    [
      "wrong tenant",
      adminPrincipalHeaders({
        tenantId: "99999999-9999-4999-8999-999999999999",
      }),
    ],
    ["wrong audience", adminPrincipalHeaders({ audience: "wrong-audience" })],
    [
      "wrong issuer",
      adminPrincipalHeaders({ issuer: "https://issuer.invalid/v2.0" }),
    ],
  ])("rejects %s binding", (_label, headers) => {
    expect(
      authorizeAdminRequest(headers, "READ_ADMIN", {
        env: adminIdentityEnv(),
        now: ADMIN_TEST_NOW,
      }),
    ).toMatchObject({ ok: false, code: "AUTHENTICATION_INVALID" });
  });

  it("rejects identities outside the immutable allowlist and role matrix", () => {
    expect(
      authorizeAdminRequest(
        adminPrincipalHeaders({ operatorId: ADMIN_TEST_IDS.unauthorizedId }),
        "READ_ADMIN",
        { env: adminIdentityEnv(), now: ADMIN_TEST_NOW },
      ),
    ).toMatchObject({ ok: false, code: "OPERATOR_NOT_ALLOWED" });
    expect(
      authorizeAdminRequest(
        adminPrincipalHeaders({ role: "OPERATOR" }),
        "UNLOCK_AGENT",
        { env: adminIdentityEnv("OPERATOR"), now: ADMIN_TEST_NOW },
      ),
    ).toMatchObject({ ok: false, code: "OPERATOR_NOT_ALLOWED" });
  });

  it("rejects missing MFA and stale step-up", () => {
    expect(
      authorizeAdminRequest(
        adminPrincipalHeaders({
          authMethods: ["pwd"],
          authContexts: [],
        }),
        "READ_ADMIN",
        { env: adminIdentityEnv(), now: ADMIN_TEST_NOW },
      ),
    ).toMatchObject({ ok: false, code: "MFA_REQUIRED" });
    expect(
      authorizeAdminRequest(
        adminPrincipalHeaders({
          authTime: Math.floor(ADMIN_TEST_NOW.getTime() / 1000) - 301,
        }),
        "RUN_AGENT",
        { env: adminIdentityEnv(), now: ADMIN_TEST_NOW },
      ),
    ).toMatchObject({ ok: false, code: "STEP_UP_REQUIRED" });
  });

  it("rejects expired, revoked, future, and stale platform sessions", () => {
    const nowSeconds = Math.floor(ADMIN_TEST_NOW.getTime() / 1000);
    for (const headers of [
      adminPrincipalHeaders({ expiresAt: nowSeconds }),
      adminPrincipalHeaders({ issuedAt: nowSeconds - 86_400 }),
      adminPrincipalHeaders({ issuedAt: nowSeconds + 120 }),
      adminPrincipalHeaders({ issuedAt: nowSeconds - 18 * 60 * 60 }),
    ]) {
      expect(
        authorizeAdminRequest(headers, "READ_ADMIN", {
          env: adminIdentityEnv(),
          now: ADMIN_TEST_NOW,
        }),
      ).toMatchObject({ ok: false, code: "AUTHENTICATION_INVALID" });
    }
  });
});
