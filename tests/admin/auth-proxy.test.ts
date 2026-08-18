import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import {
  GET as logoutGet,
  POST as logoutPost,
} from "@/app/api/auth/logout/route";
import {
  ADMIN_TEST_NOW,
  adminIdentityEnv,
  adminPrincipalHeaders,
} from "../helpers/admin-identity";

describe("admin proxy authentication", () => {
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

  it("accepts a valid platform-verified principal", async () => {
    const response = await proxy(
      new NextRequest("https://krypto.example/admin", {
        headers: adminPrincipalHeaders(),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
  });

  it("redirects anonymous pages and rejects anonymous or spoofed API access", async () => {
    const page = await proxy(
      new NextRequest("https://krypto.example/admin/journal"),
    );
    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toContain(
      "/admin/login?returnTo=%2Fadmin%2Fjournal",
    );

    const api = await proxy(
      new NextRequest("https://krypto.example/api/admin/run-agent", {
        headers: {
          "x-forwarded-for": "203.0.113.10",
          "x-ms-client-principal-id":
            "33333333-3333-4333-8333-333333333333",
        },
      }),
    );
    expect(api.status).toBe(401);
    expect(api.headers.get("x-frame-options")).toBe("DENY");
  });

  it("fails closed when the local identity boundary is disabled", async () => {
    process.env.ADMIN_IDENTITY_MODE = "disabled";
    const response = await proxy(
      new NextRequest("http://localhost:3000/admin"),
    );
    expect(response.status).toBe(503);
  });
});

describe("admin platform logout", () => {
  it("delegates POST and GET logout to the Container Apps auth sidecar", async () => {
    const post = await logoutPost(
      new Request("https://krypto.example/api/auth/logout", {
        method: "POST",
      }),
    );
    expect(post.status).toBe(303);
    expect(new URL(post.headers.get("location")!).pathname).toBe(
      "/.auth/logout",
    );
    expect(post.headers.has("set-cookie")).toBe(false);

    const get = await logoutGet(
      new Request("https://krypto.example/api/auth/logout"),
    );
    expect(get.status).toBe(307);
    expect(get.headers.get("cache-control")).toBe("no-store, max-age=0");
  });
});
