import { NextRequest, NextResponse } from "next/server";
import {
  authorizeAdminRequest,
  type AdminAction,
  type AdminOperator,
} from "@/lib/admin-auth";
import { applyAdminSecurityHeaders } from "@/lib/admin-security-headers";

export type AdminRouteAuthorization =
  | { ok: true; operator: AdminOperator }
  | { ok: false; response: NextResponse };

export async function requireAdminOperator(
  request: NextRequest,
  action: AdminAction,
): Promise<AdminRouteAuthorization> {
  const authorization = authorizeAdminRequest(request.headers, action);
  if (authorization.ok) {
    return authorization;
  }

  const message =
    authorization.code === "STEP_UP_REQUIRED"
      ? "Recent step-up authentication is required"
      : authorization.code === "MFA_REQUIRED"
        ? "MFA-backed authentication is required"
        : authorization.status === 403
          ? "Operator is not authorized"
          : authorization.status === 503
            ? "Admin identity boundary is unavailable"
            : "Authentication required";
  const response = NextResponse.json(
    { error: message, code: authorization.code },
    { status: authorization.status },
  );
  if (authorization.status === 401) {
    response.headers.set("WWW-Authenticate", 'Bearer realm="krypto-admin"');
  } else if (authorization.code === "STEP_UP_REQUIRED") {
    response.headers.set(
      "WWW-Authenticate",
      'Bearer realm="krypto-admin", error="insufficient_authentication_context"',
    );
  }
  return {
    ok: false,
    response: applyAdminSecurityHeaders(response),
  };
}
