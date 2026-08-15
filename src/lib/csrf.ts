import { NextRequest, NextResponse } from "next/server";
import { normalizeAppOrigin } from "@/lib/app-origin";

/**
 * Defense-in-depth CSRF check for admin POST endpoints.
 *
 * The admin session cookie is `SameSite=Lax`, which already blocks
 * cross-origin POST attacks for browsers that honour it. This adds an
 * explicit Origin/Referer match as a second line of defence — useful if a
 * client somehow has Lax cookies sent (e.g. top-level navigation form POST)
 * or if an older browser misbehaves.
 *
 * Returns null on success, or a JSON 403 response on failure.
 */
export function checkSameOrigin(request: NextRequest): NextResponse | null {
  const configuredOrigin = process.env.APP_ORIGIN;
  const requestOrigin = configuredOrigin
    ? normalizeAppOrigin(configuredOrigin)
    : process.env.NODE_ENV === "production"
      ? undefined
      : request.nextUrl.origin;
  const headerOrigin = request.headers.get("origin");

  if (!requestOrigin) {
    return NextResponse.json(
      { error: "Request origin could not be validated" },
      { status: 403 },
    );
  }

  if (headerOrigin) {
    return headerOrigin === requestOrigin
      ? null
      : NextResponse.json(
          { error: "Cross-origin requests are not allowed" },
          { status: 403 },
        );
  }

  // Origin header should be present on every fetch() POST. Fall back to
  // Referer just in case (older browsers / unusual clients).
  const referer = request.headers.get("referer");
  if (referer) {
    try {
      const refOrigin = new URL(referer).origin;
      return refOrigin === requestOrigin
        ? null
        : NextResponse.json(
            { error: "Cross-origin requests are not allowed" },
            { status: 403 },
          );
    } catch {
      // fallthrough to reject
    }
  }

  return NextResponse.json(
    { error: "Missing Origin/Referer header" },
    { status: 403 },
  );
}
