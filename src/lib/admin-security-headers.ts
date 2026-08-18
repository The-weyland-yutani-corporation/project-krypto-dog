const ADMIN_SECURITY_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; upgrade-insecure-requests",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy":
    "camera=(), display-capture=(), geolocation=(), microphone=(), payment=(), usb=()",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
} as const;

export function adminSecurityHeaders(): Record<string, string> {
  return { ...ADMIN_SECURITY_HEADERS };
}

export function applyAdminSecurityHeaders<T extends Response>(response: T): T {
  for (const [name, value] of Object.entries(ADMIN_SECURITY_HEADERS)) {
    response.headers.set(name, value);
  }
  response.headers.delete("X-Powered-By");
  return response;
}
