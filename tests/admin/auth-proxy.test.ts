import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { createAdminSessionToken } from "@/lib/admin-auth";
import {
  GET as logoutGet,
  POST as logoutPost,
} from "@/app/api/auth/logout/route";

function protectedRequest(path: string, token?: string): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    headers: token ? { cookie: `krypto-admin-token=${token}` } : undefined,
  });
}

describe("admin proxy authentication", () => {
  const originalSecret = process.env.ADMIN_SESSION_SECRET;

  beforeEach(() => {
    process.env.ADMIN_SESSION_SECRET = "proxy-test-secret";
  });

  afterAll(() => {
    if (originalSecret === undefined) {
      delete process.env.ADMIN_SESSION_SECRET;
    } else {
      process.env.ADMIN_SESSION_SECRET = originalSecret;
    }
  });

  it("accepts a valid unexpired session", async () => {
    const token = await createAdminSessionToken("proxy-test-secret");
    const response = await proxy(protectedRequest("/admin", token));

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("rejects expired and forged sessions", async () => {
    const expired = await createAdminSessionToken(
      "proxy-test-secret",
      new Date("2020-01-01T00:00:00.000Z"),
    );
    const expiredResponse = await proxy(
      protectedRequest("/admin", expired),
    );
    expect(expiredResponse.status).toBe(307);
    expect(expiredResponse.headers.get("location")).toContain("/admin/login");

    const valid = await createAdminSessionToken("proxy-test-secret");
    const forged = `${valid.slice(0, -1)}${valid.endsWith("0") ? "1" : "0"}`;
    const forgedResponse = await proxy(
      protectedRequest("/api/admin/run-agent", forged),
    );
    expect(forgedResponse.status).toBe(401);
  });
});

describe("admin logout", () => {
  it("clears the cookie and uses a POST-safe redirect", async () => {
    const response = await logoutPost(
      new Request("http://localhost:3000/api/auth/logout", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/admin/login",
    );
    expect(response.headers.get("set-cookie")).toContain(
      "krypto-admin-token=;",
    );
  });

  it("supports direct GET logout links", async () => {
    const response = await logoutGet(
      new Request("http://localhost:3000/api/auth/logout"),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("set-cookie")).toContain(
      "krypto-admin-token=;",
    );
  });
});
