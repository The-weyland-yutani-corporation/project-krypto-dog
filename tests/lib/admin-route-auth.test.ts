import { NextRequest } from "next/server";
import { requireAdminOperator } from "@/lib/admin-route-auth";
import {
  ADMIN_TEST_NOW,
  adminIdentityEnv,
  adminPrincipalHeaders,
} from "../helpers/admin-identity";

describe("requireAdminOperator", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(ADMIN_TEST_NOW);
    Object.assign(process.env, adminIdentityEnv());
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(() => {
    process.env = saved;
  });

  it("returns the named operator for a valid platform principal", async () => {
    const request = new NextRequest("https://krypto.example/api/admin/pause", {
      headers: adminPrincipalHeaders(),
    });
    await expect(
      requireAdminOperator(request, "PAUSE_AGENT"),
    ).resolves.toMatchObject({
      ok: true,
      operator: { operatorName: "Release Owner Test" },
    });
  });

  it("returns fail-closed no-store responses for missing and stale auth", async () => {
    const missing = await requireAdminOperator(
      new NextRequest("https://krypto.example/api/admin/pause"),
      "PAUSE_AGENT",
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.response.status).toBe(401);
      expect(missing.response.headers.get("cache-control")).toBe(
        "no-store, max-age=0",
      );
      expect(missing.response.headers.get("x-frame-options")).toBe("DENY");
    }

    const stale = await requireAdminOperator(
      new NextRequest("https://krypto.example/api/admin/pause", {
        headers: adminPrincipalHeaders({ authContexts: ["c1"] }),
      }),
      "PAUSE_AGENT",
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.response.status).toBe(403);
      expect(stale.response.headers.get("www-authenticate")).toContain(
        "insufficient_authentication_context",
      );
    }
  });

  it("maps MFA, role, and unavailable-boundary failures without leaking claims", async () => {
    const mfa = await requireAdminOperator(
      new NextRequest("https://krypto.example/api/admin/pause", {
        headers: adminPrincipalHeaders({
          authMethods: ["pwd"],
          authContexts: [],
        }),
      }),
      "PAUSE_AGENT",
    );
    expect(mfa.ok).toBe(false);
    if (!mfa.ok) {
      expect(mfa.response.status).toBe(403);
      expect(await mfa.response.json()).toEqual({
        error: "MFA-backed authentication is required",
        code: "MFA_REQUIRED",
      });
    }

    const role = await requireAdminOperator(
      new NextRequest("https://krypto.example/api/admin/unlock", {
        headers: adminPrincipalHeaders({ role: "OPERATOR" }),
      }),
      "UNLOCK_AGENT",
    );
    expect(role.ok).toBe(false);
    if (!role.ok) {
      expect(role.response.status).toBe(403);
      expect(await role.response.json()).toMatchObject({
        error: "Operator is not authorized",
      });
    }

    process.env.ADMIN_IDENTITY_MODE = "disabled";
    const unavailable = await requireAdminOperator(
      new NextRequest("https://krypto.example/api/admin/pause"),
      "PAUSE_AGENT",
    );
    expect(unavailable.ok).toBe(false);
    if (!unavailable.ok) {
      expect(unavailable.response.status).toBe(503);
      expect(await unavailable.response.json()).toMatchObject({
        error: "Admin identity boundary is unavailable",
      });
    }
  });
});
