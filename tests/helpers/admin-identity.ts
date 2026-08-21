import type { AdminOperatorRole } from "@/lib/admin-auth";

export const ADMIN_TEST_IDS = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  clientId: "22222222-2222-4222-8222-222222222222",
  operatorId: "33333333-3333-4333-8333-333333333333",
  unauthorizedId: "44444444-4444-4444-8444-444444444444",
  sessionId: "55555555-5555-4555-8555-555555555555",
} as const;

export const ADMIN_TEST_NOW = new Date("2026-08-17T20:00:00.000Z");

export function adminIdentityEnv(
  role: AdminOperatorRole = "RELEASE_OWNER",
): Record<string, string> {
  return {
    NODE_ENV: "production",
    ADMIN_IDENTITY_MODE: "entra",
    ADMIN_PLATFORM_AUTH: "azure-container-apps",
    ADMIN_ENTRA_TENANT_ID: ADMIN_TEST_IDS.tenantId,
    ADMIN_ENTRA_CLIENT_ID: ADMIN_TEST_IDS.clientId,
    ADMIN_ENTRA_AUDIENCE: ADMIN_TEST_IDS.clientId,
    ADMIN_ENTRA_ISSUER: `https://login.microsoftonline.com/${ADMIN_TEST_IDS.tenantId}/v2.0`,
    ADMIN_ENTRA_OPERATOR_ALLOWLIST: JSON.stringify([
      {
        id: ADMIN_TEST_IDS.operatorId,
        name: "Release Owner Test",
        role,
      },
    ]),
    ADMIN_ENTRA_MFA_AUTH_CONTEXT: "c1",
    ADMIN_ENTRA_STEP_UP_AUTH_CONTEXT: "c2",
    ADMIN_ENTRA_TOKEN_MAX_AGE_SECONDS: "3600",
    ADMIN_ENTRA_AUTH_MAX_AGE_SECONDS: "28800",
    ADMIN_ENTRA_STEP_UP_MAX_AGE_SECONDS: "300",
    ADMIN_AUTH_NOT_BEFORE: "2026-08-17T00:00:00.000Z",
    ADMIN_AUTH_POLICY_VERSION: "entra-admin-v1",
  };
}

const appRole = {
  OPERATOR: "Krypto.Admin.Operator",
  RELEASE_OWNER: "Krypto.Admin.ReleaseOwner",
  SAFETY_APPROVER: "Krypto.Admin.SafetyApprover",
} as const;

export function adminPrincipalHeaders(options: {
  role?: AdminOperatorRole;
  operatorId?: string;
  tenantId?: string;
  audience?: string;
  issuer?: string;
  issuedAt?: number;
  notBefore?: number;
  expiresAt?: number;
  authTime?: number;
  authMethods?: string[];
  authContexts?: string[];
  malformed?: boolean;
} = {}): Headers {
  const nowSeconds = Math.floor(ADMIN_TEST_NOW.getTime() / 1000);
  const role = options.role ?? "RELEASE_OWNER";
  const operatorId = options.operatorId ?? ADMIN_TEST_IDS.operatorId;
  const claims = [
    { typ: "aud", val: options.audience ?? ADMIN_TEST_IDS.clientId },
    {
      typ: "iss",
      val:
        options.issuer ??
        `https://login.microsoftonline.com/${ADMIN_TEST_IDS.tenantId}/v2.0`,
    },
    { typ: "iat", val: String(options.issuedAt ?? nowSeconds - 60) },
    { typ: "nbf", val: String(options.notBefore ?? nowSeconds - 60) },
    { typ: "exp", val: String(options.expiresAt ?? nowSeconds + 3600) },
    { typ: "oid", val: operatorId },
    { typ: "sub", val: `subject-${operatorId}` },
    { typ: "tid", val: options.tenantId ?? ADMIN_TEST_IDS.tenantId },
    { typ: "sid", val: ADMIN_TEST_IDS.sessionId },
    { typ: "auth_time", val: String(options.authTime ?? nowSeconds - 60) },
    ...(options.authMethods ?? ["mfa"]).map((val) => ({ typ: "amr", val })),
    ...(options.authContexts ?? ["c1", "c2"]).map((val) => ({
      typ: "acrs",
      val,
    })),
    { typ: "roles", val: appRole[role] },
  ];
  const principal = Buffer.from(
    JSON.stringify({
      auth_typ: "aad",
      name_typ: "name",
      role_typ: "roles",
      claims,
    }),
    "utf8",
  ).toString("base64");
  return new Headers({
    "x-ms-client-principal": options.malformed
      ? `${principal.slice(0, -1)}!`
      : principal,
    "x-ms-client-principal-id": operatorId,
    "x-ms-client-principal-idp": "aad",
    "x-ms-client-principal-name": "mutable@example.invalid",
  });
}
