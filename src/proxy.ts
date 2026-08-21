import { NextRequest, NextResponse } from "next/server";
import type { ProxyConfig } from "next/server";
import { authorizeAdminRequest } from "@/lib/admin-auth";
import { applyAdminSecurityHeaders } from "@/lib/admin-security-headers";

function rejected(request: NextRequest, status: 401 | 403 | 503): NextResponse {
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return applyAdminSecurityHeaders(
      NextResponse.json(
        {
          error:
            status === 503
              ? "Admin identity boundary is unavailable"
              : "Authentication required",
        },
        { status },
      ),
    );
  }
  if (status === 503) {
    return applyAdminSecurityHeaders(
      new NextResponse("Admin identity boundary is unavailable", {
        status: 503,
      }),
    );
  }
  const login = new URL("/admin/login", request.url);
  login.searchParams.set(
    "returnTo",
    `${request.nextUrl.pathname}${request.nextUrl.search}`,
  );
  return applyAdminSecurityHeaders(NextResponse.redirect(login));
}

export async function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === "/admin/login") {
    return applyAdminSecurityHeaders(NextResponse.next());
  }

  const authorization = authorizeAdminRequest(
    request.headers,
    "READ_ADMIN",
  );
  if (!authorization.ok) {
    return rejected(request, authorization.status);
  }
  return applyAdminSecurityHeaders(NextResponse.next());
}

export const config: ProxyConfig = {
  matcher: ["/admin/:path*", "/api/admin/:path*"],
};
