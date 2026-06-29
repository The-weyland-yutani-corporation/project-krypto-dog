import { POST as login } from "@/app/api/auth/login/route";

function makeLoginReq(password: string, ip: string): Request {
  return new Request("http://localhost:3000/api/auth/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": ip,
    },
    body: JSON.stringify({ password }),
  });
}

describe("POST /api/auth/login", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalAdminPassword = process.env.ADMIN_PASSWORD;
  const originalAdminSessionSecret = process.env.ADMIN_SESSION_SECRET;

  beforeEach(() => {
    process.env.NODE_ENV = "production";
    process.env.ADMIN_PASSWORD = "correct-password";
    process.env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalAdminPassword === undefined) {
      delete process.env.ADMIN_PASSWORD;
    } else {
      process.env.ADMIN_PASSWORD = originalAdminPassword;
    }
    if (originalAdminSessionSecret === undefined) {
      delete process.env.ADMIN_SESSION_SECRET;
    } else {
      process.env.ADMIN_SESSION_SECRET = originalAdminSessionSecret;
    }
  });

  it("sets the admin session cookie on successful login", async () => {
    const res = await login(makeLoginReq("correct-password", "203.0.113.10"));

    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("krypto-admin-token=");
  });

  it("does not count successful logins toward the failed-attempt rate limit", async () => {
    const ip = "203.0.113.20";
    for (let i = 0; i < 6; i += 1) {
      const res = await login(makeLoginReq("correct-password", ip));
      expect(res.status).toBe(200);
    }

    const failed = await login(makeLoginReq("wrong-password", ip));
    expect(failed.status).toBe(401);
  });

  it("rate-limits repeated failed logins", async () => {
    const ip = "203.0.113.30";
    for (let i = 0; i < 5; i += 1) {
      const res = await login(makeLoginReq("wrong-password", ip));
      expect(res.status).toBe(401);
    }

    const limited = await login(makeLoginReq("wrong-password", ip));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
  });
});
