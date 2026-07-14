import { NextRequest } from "next/server";
import { createAdminSessionToken } from "@/lib/admin-auth";
import { requireAdminSession } from "@/lib/admin-route-auth";

function request(token?: string): NextRequest {
  return new NextRequest("http://localhost:3000/api/admin/pause", {
    headers: token
      ? { cookie: `krypto-admin-token=${token}` }
      : undefined,
  });
}

describe("requireAdminSession", () => {
  const originalSecret = process.env.ADMIN_SESSION_SECRET;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.ADMIN_SESSION_SECRET = "route-auth-test-secret";
  });

  afterAll(() => {
    if (originalSecret === undefined) {
      delete process.env.ADMIN_SESSION_SECRET;
    } else {
      process.env.ADMIN_SESSION_SECRET = originalSecret;
    }
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("accepts a valid signed session", async () => {
    const token = await createAdminSessionToken("route-auth-test-secret");
    await expect(requireAdminSession(request(token))).resolves.toBeNull();
  });

  it("rejects missing, expired, and forged sessions", async () => {
    await expect(requireAdminSession(request())).resolves.toMatchObject({
      status: 401,
    });

    const expired = await createAdminSessionToken(
      "route-auth-test-secret",
      new Date("2020-01-01T00:00:00.000Z"),
    );
    await expect(requireAdminSession(request(expired))).resolves.toMatchObject({
      status: 401,
    });

    const valid = await createAdminSessionToken("route-auth-test-secret");
    const forged = `${valid.slice(0, -1)}${valid.endsWith("0") ? "1" : "0"}`;
    await expect(requireAdminSession(request(forged))).resolves.toMatchObject({
      status: 401,
    });
  });

  it("fails closed when production session configuration is missing", async () => {
    const token = await createAdminSessionToken("route-auth-test-secret");
    process.env.NODE_ENV = "production";
    delete process.env.ADMIN_SESSION_SECRET;

    await expect(requireAdminSession(request(token))).resolves.toMatchObject({
      status: 401,
    });
  });
});
