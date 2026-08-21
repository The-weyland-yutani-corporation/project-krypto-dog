import { readFileSync } from "node:fs";
import {
  adminSecurityHeaders,
  applyAdminSecurityHeaders,
} from "@/lib/admin-security-headers";

describe("admin security response policy", () => {
  it("defines the complete no-store header set and suppresses framework banners", () => {
    const configSource = readFileSync("next.config.ts", "utf8");
    expect(configSource).toContain("poweredByHeader: false");
    expect(adminSecurityHeaders()).toMatchObject({
      "Cache-Control": "no-store, max-age=0",
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    });

    const response = applyAdminSecurityHeaders(
      new Response(null, { headers: { "x-powered-by": "Next.js" } }),
    );
    expect(response.headers.has("x-powered-by")).toBe(false);
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(response.headers.get("permissions-policy")).toContain(
      "microphone=()",
    );
  });

  it("keeps the login availability decision runtime-bound", () => {
    const pageSource = readFileSync("src/app/admin/login/page.tsx", "utf8");
    expect(pageSource).toContain('export const dynamic = "force-dynamic"');
  });

  it("applies no-store to admin and auth routes through Next configuration", () => {
    const configSource = readFileSync("next.config.ts", "utf8");
    for (const source of [
      "/admin/:path*",
      "/api/admin/:path*",
      "/api/auth/:path*",
    ]) {
      expect(configSource).toContain(`source: "${source}"`);
    }
    expect(configSource).toContain(
      '{ key: "Cache-Control", value: "no-store, max-age=0" }',
    );
    expect(configSource).toContain(
      '{ key: "X-Frame-Options", value: "DENY" }',
    );
    expect(configSource).toContain(
      '{ key: "X-Content-Type-Options", value: "nosniff" }',
    );
  });
});
