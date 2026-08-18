import { NextResponse } from "next/server";
import { applyAdminSecurityHeaders } from "@/lib/admin-security-headers";

function safeReturnTo(value: string | null): string {
  return value?.startsWith("/admin") && !value.startsWith("//")
    ? value
    : "/admin";
}

export async function GET(request: Request) {
  if (
    process.env.ADMIN_IDENTITY_MODE !== "entra" ||
    process.env.ADMIN_PLATFORM_AUTH !== "azure-container-apps"
  ) {
    return applyAdminSecurityHeaders(
      NextResponse.json(
        {
          error:
            "Admin sign-in is disabled until the platform identity boundary is configured",
        },
        { status: 503 },
      ),
    );
  }
  const requestUrl = new URL(request.url);
  const login = new URL("/.auth/login/aad", requestUrl.origin);
  login.searchParams.set(
    "post_login_redirect_uri",
    safeReturnTo(requestUrl.searchParams.get("returnTo")),
  );
  if (requestUrl.searchParams.get("stepUp") === "1") {
    const context = process.env.ADMIN_ENTRA_STEP_UP_AUTH_CONTEXT;
    if (!context || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(context)) {
      return applyAdminSecurityHeaders(
        NextResponse.json(
          { error: "Step-up authentication context is unavailable" },
          { status: 503 },
        ),
      );
    }
    login.searchParams.set("prompt", "login");
    login.searchParams.set(
      "max_age",
      process.env.ADMIN_ENTRA_STEP_UP_MAX_AGE_SECONDS ?? "300",
    );
    login.searchParams.set(
      "claims",
      JSON.stringify({
        id_token: { acrs: { essential: true, value: context } },
      }),
    );
  }
  return applyAdminSecurityHeaders(NextResponse.redirect(login, 307));
}

export async function POST() {
  return applyAdminSecurityHeaders(
    NextResponse.json(
      {
        error:
          "Password authentication is not available; use the Microsoft Entra sign-in boundary",
      },
      { status: 401 },
    ),
  );
}
