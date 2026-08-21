import { NextResponse } from "next/server";
import { applyAdminSecurityHeaders } from "@/lib/admin-security-headers";

function logoutResponse(request: Request, status: 303 | 307): NextResponse {
  const requestUrl = new URL(request.url);
  const logout = new URL("/.auth/logout", requestUrl.origin);
  logout.searchParams.set("post_logout_redirect_uri", "/admin/login");
  return applyAdminSecurityHeaders(NextResponse.redirect(logout, status));
}

export async function POST(request: Request) {
  return logoutResponse(request, 303);
}

export async function GET(request: Request) {
  return logoutResponse(request, 307);
}
