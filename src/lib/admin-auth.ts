import { z } from "zod/v4";

const CLOCK_SKEW_SECONDS = 60;
const DEFAULT_TOKEN_MAX_AGE_SECONDS = 60 * 60;
const DEFAULT_AUTH_MAX_AGE_SECONDS = 8 * 60 * 60;
const DEFAULT_STEP_UP_MAX_AGE_SECONDS = 5 * 60;
const MAX_PRINCIPAL_HEADER_BYTES = 32 * 1024;

const GUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_CLAIM_PATTERN = /^[A-Za-z0-9._:/@+-]{1,240}$/;
const SAFE_POLICY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENTRA_ISSUER_HOSTS = new Set([
  "login.microsoftonline.com",
  "login.microsoftonline.us",
  "login.chinacloudapi.cn",
]);

const OPERATOR_ROLES = [
  "OPERATOR",
  "RELEASE_OWNER",
  "SAFETY_APPROVER",
] as const;

export type AdminOperatorRole = (typeof OPERATOR_ROLES)[number];

export const ADMIN_ACTIONS = [
  "READ_ADMIN",
  "RUN_AGENT",
  "PAUSE_AGENT",
  "RESUME_AGENT",
  "UNLOCK_AGENT",
  "RECOVER_RUN_LEASE",
  "READ_SAFETY_INCIDENTS",
  "TEST_FIRE_SAFETY_INCIDENT",
  "CHANGE_SAFETY_INCIDENT",
] as const;

export type AdminAction = (typeof ADMIN_ACTIONS)[number];

const SENSITIVE_ACTIONS = new Set<AdminAction>([
  "RUN_AGENT",
  "PAUSE_AGENT",
  "RESUME_AGENT",
  "UNLOCK_AGENT",
  "RECOVER_RUN_LEASE",
  "TEST_FIRE_SAFETY_INCIDENT",
  "CHANGE_SAFETY_INCIDENT",
]);

const ACTION_ROLES: Record<AdminAction, readonly AdminOperatorRole[]> = {
  READ_ADMIN: OPERATOR_ROLES,
  RUN_AGENT: OPERATOR_ROLES,
  PAUSE_AGENT: OPERATOR_ROLES,
  RESUME_AGENT: OPERATOR_ROLES,
  UNLOCK_AGENT: ["RELEASE_OWNER", "SAFETY_APPROVER"],
  RECOVER_RUN_LEASE: ["RELEASE_OWNER", "SAFETY_APPROVER"],
  READ_SAFETY_INCIDENTS: OPERATOR_ROLES,
  TEST_FIRE_SAFETY_INCIDENT: ["RELEASE_OWNER", "SAFETY_APPROVER"],
  CHANGE_SAFETY_INCIDENT: ["RELEASE_OWNER", "SAFETY_APPROVER"],
};

const APP_ROLE_BY_OPERATOR_ROLE: Record<AdminOperatorRole, string> = {
  OPERATOR: "Krypto.Admin.Operator",
  RELEASE_OWNER: "Krypto.Admin.ReleaseOwner",
  SAFETY_APPROVER: "Krypto.Admin.SafetyApprover",
};

const AllowlistEntrySchema = z
  .object({
    id: z.string().regex(GUID_PATTERN),
    name: z.string().trim().min(2).max(120),
    role: z.enum(OPERATOR_ROLES),
  })
  .strict();

const PrincipalSchema = z
  .object({
    auth_typ: z.string().max(32),
    name_typ: z.string().max(240),
    role_typ: z.string().max(240),
    claims: z
      .array(
        z
          .object({
            typ: z.string().min(1).max(240),
            val: z.string().max(2048),
          })
          .strict(),
      )
      .min(1)
      .max(96),
  })
  .strict();

export interface AdminOperator {
  operatorId: string;
  operatorName: string;
  subjectId: string;
  role: AdminOperatorRole;
  authenticationMethod: "ENTRA_MFA";
  authenticationContext: string;
  mfaEvidence: string;
  authenticatedAt: Date;
  tokenIssuedAt: Date;
  sessionId: string;
  policyVersion: string;
}

export function isExpectedEntraIssuer(
  issuer: string,
  tenantId: string,
): boolean {
  try {
    const url = new URL(issuer);
    return (
      url.protocol === "https:" &&
      ENTRA_ISSUER_HOSTS.has(url.hostname) &&
      url.pathname === `/${tenantId}/v2.0` &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export type AdminAuthorizationResult =
  | { ok: true; operator: AdminOperator }
  | {
      ok: false;
      status: 401 | 403 | 503;
      code:
        | "IDENTITY_DISABLED"
        | "PLATFORM_BOUNDARY_INVALID"
        | "AUTHENTICATION_REQUIRED"
        | "AUTHENTICATION_INVALID"
        | "MFA_REQUIRED"
        | "OPERATOR_NOT_ALLOWED"
        | "STEP_UP_REQUIRED";
    };

interface AdminIdentityConfig {
  tenantId: string;
  clientId: string;
  audience: string;
  issuer: string;
  allowlist: Map<string, z.infer<typeof AllowlistEntrySchema>>;
  mfaAuthContext: string;
  stepUpAuthContext: string;
  tokenMaxAgeSeconds: number;
  authMaxAgeSeconds: number;
  stepUpMaxAgeSeconds: number;
  notBeforeSeconds: number;
  policyVersion: string;
}

const CLAIM_TYPES = {
  audience: ["aud"],
  issuer: ["iss"],
  issuedAt: ["iat"],
  notBefore: ["nbf"],
  expiresAt: ["exp"],
  objectId: [
    "oid",
    "http://schemas.microsoft.com/identity/claims/objectidentifier",
  ],
  subject: [
    "sub",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier",
  ],
  tenantId: [
    "tid",
    "http://schemas.microsoft.com/identity/claims/tenantid",
  ],
  sessionId: ["sid"],
  authTime: ["auth_time"],
  authMethod: [
    "amr",
    "http://schemas.microsoft.com/claims/authnmethodsreferences",
  ],
  authContext: [
    "acrs",
    "acr",
    "http://schemas.microsoft.com/claims/authnclassreference",
  ],
  role: [
    "roles",
    "role",
    "http://schemas.microsoft.com/ws/2008/06/identity/claims/role",
  ],
} as const;

function boundedPositiveInteger(
  value: string | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error("Admin identity duration must be a positive integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new Error("Admin identity duration exceeds its safe maximum");
  }
  return parsed;
}

function readIdentityConfig(
  env: Record<string, string | undefined>,
): AdminIdentityConfig {
  const tenantId = env.ADMIN_ENTRA_TENANT_ID?.trim();
  const clientId = env.ADMIN_ENTRA_CLIENT_ID?.trim();
  const audience = env.ADMIN_ENTRA_AUDIENCE?.trim();
  const issuer = env.ADMIN_ENTRA_ISSUER?.trim();
  const mfaAuthContext = env.ADMIN_ENTRA_MFA_AUTH_CONTEXT?.trim();
  const stepUpAuthContext = env.ADMIN_ENTRA_STEP_UP_AUTH_CONTEXT?.trim();
  const policyVersion = env.ADMIN_AUTH_POLICY_VERSION?.trim();
  if (
    !tenantId ||
    !GUID_PATTERN.test(tenantId) ||
    !clientId ||
    !GUID_PATTERN.test(clientId) ||
    !audience ||
    !SAFE_CLAIM_PATTERN.test(audience) ||
    !issuer ||
    !isExpectedEntraIssuer(issuer, tenantId) ||
    !mfaAuthContext ||
    !SAFE_POLICY_PATTERN.test(mfaAuthContext) ||
    !stepUpAuthContext ||
    !SAFE_POLICY_PATTERN.test(stepUpAuthContext) ||
    mfaAuthContext === stepUpAuthContext ||
    !policyVersion ||
    !SAFE_POLICY_PATTERN.test(policyVersion)
  ) {
    throw new Error("Admin Entra identity configuration is invalid");
  }

  let rawAllowlist: unknown;
  try {
    rawAllowlist = JSON.parse(env.ADMIN_ENTRA_OPERATOR_ALLOWLIST ?? "");
  } catch {
    throw new Error("Admin operator allowlist must be valid JSON");
  }
  const parsedAllowlist = z.array(AllowlistEntrySchema).min(1).max(32).parse(
    rawAllowlist,
  );
  const allowlist = new Map(
    parsedAllowlist.map((entry) => [entry.id.toLowerCase(), entry]),
  );
  if (allowlist.size !== parsedAllowlist.length) {
    throw new Error("Admin operator allowlist contains duplicate object IDs");
  }

  const notBefore = new Date(
    env.ADMIN_AUTH_NOT_BEFORE ?? "1970-01-01T00:00:00.000Z",
  );
  if (Number.isNaN(notBefore.getTime())) {
    throw new Error("ADMIN_AUTH_NOT_BEFORE must be an ISO timestamp");
  }

  return {
    tenantId: tenantId.toLowerCase(),
    clientId: clientId.toLowerCase(),
    audience,
    issuer,
    allowlist,
    mfaAuthContext,
    stepUpAuthContext,
    tokenMaxAgeSeconds: boundedPositiveInteger(
      env.ADMIN_ENTRA_TOKEN_MAX_AGE_SECONDS,
      DEFAULT_TOKEN_MAX_AGE_SECONDS,
      8 * 60 * 60,
    ),
    authMaxAgeSeconds: boundedPositiveInteger(
      env.ADMIN_ENTRA_AUTH_MAX_AGE_SECONDS,
      DEFAULT_AUTH_MAX_AGE_SECONDS,
      24 * 60 * 60,
    ),
    stepUpMaxAgeSeconds: boundedPositiveInteger(
      env.ADMIN_ENTRA_STEP_UP_MAX_AGE_SECONDS,
      DEFAULT_STEP_UP_MAX_AGE_SECONDS,
      15 * 60,
    ),
    notBeforeSeconds: Math.floor(notBefore.getTime() / 1000),
    policyVersion,
  };
}

function principalFromHeader(value: string): z.infer<typeof PrincipalSchema> {
  if (
    value.length === 0 ||
    value.length > MAX_PRINCIPAL_HEADER_BYTES ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    throw new Error("Platform principal header is malformed");
  }
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.length === 0 ||
    decoded.length > MAX_PRINCIPAL_HEADER_BYTES ||
    decoded.toString("base64") !== value
  ) {
    throw new Error("Platform principal header is not canonical base64");
  }
  return PrincipalSchema.parse(JSON.parse(decoded.toString("utf8")));
}

function claimValues(
  principal: z.infer<typeof PrincipalSchema>,
  types: readonly string[],
): string[] {
  const values = principal.claims
    .filter((claim) => types.includes(claim.typ))
    .flatMap((claim) => {
      if (claim.val.startsWith("[")) {
        try {
          const parsed = JSON.parse(claim.val);
          if (
            Array.isArray(parsed) &&
            parsed.every((entry) => typeof entry === "string")
          ) {
            return parsed;
          }
        } catch {
          return [];
        }
      }
      return [claim.val];
    });
  return values.filter((value) => SAFE_CLAIM_PATTERN.test(value));
}

function singleClaim(
  principal: z.infer<typeof PrincipalSchema>,
  types: readonly string[],
): string {
  const values = claimValues(principal, types);
  if (values.length !== 1) {
    throw new Error("Required platform claim is missing or ambiguous");
  }
  return values[0];
}

function numericClaim(
  principal: z.infer<typeof PrincipalSchema>,
  types: readonly string[],
): number {
  const value = singleClaim(principal, types);
  if (!/^[0-9]{1,12}$/.test(value)) {
    throw new Error("Platform time claim is malformed");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("Platform time claim is outside the safe range");
  }
  return parsed;
}

export function authorizeAdminRequest(
  headers: Pick<Headers, "get">,
  action: AdminAction,
  options: {
    env?: Record<string, string | undefined>;
    now?: Date;
  } = {},
): AdminAuthorizationResult {
  const env = options.env ?? process.env;
  if (env.ADMIN_IDENTITY_MODE !== "entra") {
    return { ok: false, status: 503, code: "IDENTITY_DISABLED" };
  }
  if (
    env.ADMIN_PLATFORM_AUTH !== "azure-container-apps" ||
    (env.NODE_ENV === "production" &&
      env.ADMIN_PLATFORM_AUTH !== "azure-container-apps")
  ) {
    return { ok: false, status: 503, code: "PLATFORM_BOUNDARY_INVALID" };
  }

  let config: AdminIdentityConfig;
  try {
    config = readIdentityConfig(env);
  } catch {
    return { ok: false, status: 503, code: "PLATFORM_BOUNDARY_INVALID" };
  }

  const encodedPrincipal = headers.get("x-ms-client-principal");
  if (!encodedPrincipal) {
    return { ok: false, status: 401, code: "AUTHENTICATION_REQUIRED" };
  }

  try {
    const principal = principalFromHeader(encodedPrincipal);
    const principalId = headers.get("x-ms-client-principal-id")?.toLowerCase();
    const principalIdp = headers.get("x-ms-client-principal-idp");
    if (
      principal.auth_typ !== "aad" ||
      principalIdp !== "aad" ||
      !principalId ||
      !GUID_PATTERN.test(principalId)
    ) {
      return { ok: false, status: 401, code: "AUTHENTICATION_INVALID" };
    }

    const objectId = singleClaim(
      principal,
      CLAIM_TYPES.objectId,
    ).toLowerCase();
    const subjectId = singleClaim(principal, CLAIM_TYPES.subject);
    const tenantId = singleClaim(principal, CLAIM_TYPES.tenantId).toLowerCase();
    const audience = singleClaim(principal, CLAIM_TYPES.audience);
    const issuer = singleClaim(principal, CLAIM_TYPES.issuer);
    const sessionId = singleClaim(principal, CLAIM_TYPES.sessionId);
    if (
      !GUID_PATTERN.test(objectId) ||
      principalId !== objectId ||
      tenantId !== config.tenantId ||
      audience !== config.audience ||
      issuer !== config.issuer ||
      subjectId.length > 240 ||
      sessionId.length > 240
    ) {
      return { ok: false, status: 401, code: "AUTHENTICATION_INVALID" };
    }

    const nowSeconds = Math.floor(
      (options.now ?? new Date()).getTime() / 1000,
    );
    const issuedAt = numericClaim(principal, CLAIM_TYPES.issuedAt);
    const notBefore = numericClaim(principal, CLAIM_TYPES.notBefore);
    const expiresAt = numericClaim(principal, CLAIM_TYPES.expiresAt);
    const authTime = numericClaim(principal, CLAIM_TYPES.authTime);
    if (
      issuedAt > nowSeconds + CLOCK_SKEW_SECONDS ||
      notBefore > nowSeconds + CLOCK_SKEW_SECONDS ||
      expiresAt <= nowSeconds ||
      issuedAt < config.notBeforeSeconds ||
      nowSeconds - issuedAt > config.tokenMaxAgeSeconds ||
      authTime > nowSeconds + CLOCK_SKEW_SECONDS ||
      nowSeconds - authTime > config.authMaxAgeSeconds
    ) {
      return { ok: false, status: 401, code: "AUTHENTICATION_INVALID" };
    }

    const allowlisted = config.allowlist.get(objectId);
    const appRoles = claimValues(principal, CLAIM_TYPES.role);
    if (
      !allowlisted ||
      !appRoles.includes(APP_ROLE_BY_OPERATOR_ROLE[allowlisted.role]) ||
      !ACTION_ROLES[action].includes(allowlisted.role)
    ) {
      return { ok: false, status: 403, code: "OPERATOR_NOT_ALLOWED" };
    }

    const authMethods = claimValues(principal, CLAIM_TYPES.authMethod);
    const authContexts = claimValues(principal, CLAIM_TYPES.authContext);
    const mfaEvidence = authMethods.includes("mfa")
      ? "amr:mfa"
      : authContexts.includes(config.mfaAuthContext)
        ? `acrs:${config.mfaAuthContext}`
        : authContexts.includes(config.stepUpAuthContext)
          ? `acrs:${config.stepUpAuthContext}`
        : undefined;
    if (!mfaEvidence) {
      return { ok: false, status: 403, code: "MFA_REQUIRED" };
    }

    if (
      SENSITIVE_ACTIONS.has(action) &&
      (!authContexts.includes(config.stepUpAuthContext) ||
        nowSeconds - authTime > config.stepUpMaxAgeSeconds)
    ) {
      return { ok: false, status: 403, code: "STEP_UP_REQUIRED" };
    }

    return {
      ok: true,
      operator: {
        operatorId: objectId,
        operatorName: allowlisted.name,
        subjectId,
        role: allowlisted.role,
        authenticationMethod: "ENTRA_MFA",
        authenticationContext: authContexts.sort().join(","),
        mfaEvidence,
        authenticatedAt: new Date(authTime * 1000),
        tokenIssuedAt: new Date(issuedAt * 1000),
        sessionId,
        policyVersion: config.policyVersion,
      },
    };
  } catch {
    return { ok: false, status: 401, code: "AUTHENTICATION_INVALID" };
  }
}
