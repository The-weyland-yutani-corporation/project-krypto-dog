import { NextRequest, NextResponse } from "next/server";
import type { ProxyConfig } from "next/server";
import {
  getAdminSessionSecret,
  verifyAdminSessionToken,
} from "@/lib/admin-auth";

function unauthorized(request: NextRequest): NextResponse {
  // Pages get a redirect to the login screen; API endpoints get JSON so the
  // client fetch can surface a structured error rather than receiving HTML.
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.redirect(new URL("/admin/login", request.url));
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname === "/admin/login") {
    return NextResponse.next();
  }

  const token = request.cookies.get("krypto-admin-token")?.value;
  const secret = getAdminSessionSecret();

  if (!token) {
    return unauthorized(request);
  }

  try {
    if (!(await verifyAdminSessionToken(token, secret))) {
      return unauthorized(request);
    }
  } catch {
    return unauthorized(request);
  }

  return NextResponse.next();
}

export const config: ProxyConfig = {
  matcher: ["/admin/:path*", "/api/admin/:path*"],
};
