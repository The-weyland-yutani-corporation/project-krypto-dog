import { NextRequest, NextResponse } from "next/server";

function getAdminSessionSecret(): string {
  const dedicated = process.env.ADMIN_SESSION_SECRET;
  if (dedicated) return dedicated;
  return process.env.CRON_SECRET || "fallback";
}

async function computeHmac(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function verifyToken(token: string, secret: string): Promise<boolean> {
  const expected = await computeHmac(secret, "admin-authenticated");
  if (token.length !== expected.length) return false;
  // Constant-time comparison
  let mismatch = 0;
  for (let i = 0; i < token.length; i++) {
    mismatch |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

function unauthorized(request: NextRequest): NextResponse {
  // Pages get a redirect to the login screen; API endpoints get JSON so the
  // client fetch can surface a structured error rather than receiving HTML.
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.redirect(new URL("/admin/login", request.url));
}

export async function middleware(request: NextRequest) {
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
    if (!(await verifyToken(token, secret))) {
      return unauthorized(request);
    }
  } catch {
    return unauthorized(request);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*", "/api/admin/:path*"],
};
