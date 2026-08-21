import {
  GET as loginGet,
  POST as loginPost,
} from "@/app/api/auth/login/route";

describe("admin Entra login boundary", () => {
  const originalMode = process.env.ADMIN_IDENTITY_MODE;
  const originalPlatform = process.env.ADMIN_PLATFORM_AUTH;
  const originalStepUpContext =
    process.env.ADMIN_ENTRA_STEP_UP_AUTH_CONTEXT;

  beforeEach(() => {
    process.env.ADMIN_IDENTITY_MODE = "entra";
    process.env.ADMIN_PLATFORM_AUTH = "azure-container-apps";
    process.env.ADMIN_ENTRA_STEP_UP_AUTH_CONTEXT = "c2";
  });

  afterAll(() => {
    process.env.ADMIN_IDENTITY_MODE = originalMode;
    process.env.ADMIN_PLATFORM_AUTH = originalPlatform;
    process.env.ADMIN_ENTRA_STEP_UP_AUTH_CONTEXT = originalStepUpContext;
  });

  it("delegates browser sign-in to Container Apps and bounds return paths", async () => {
    const response = await loginGet(
      new Request(
        "https://krypto.example/api/auth/login?returnTo=/admin/journal",
      ),
    );
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/.auth/login/aad");
    expect(location.searchParams.get("post_login_redirect_uri")).toBe(
      "/admin/journal",
    );
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");

    const stepUp = await loginGet(
      new Request(
        "https://krypto.example/api/auth/login?stepUp=1&returnTo=/admin",
      ),
    );
    expect(stepUp.status).toBe(307);
    expect(new URL(stepUp.headers.get("location")!).pathname).toBe(
      "/.auth/login/aad",
    );
    expect(new URL(stepUp.headers.get("location")!).searchParams.get(
      "prompt",
    )).toBe("login");
    expect(new URL(stepUp.headers.get("location")!).searchParams.get(
      "claims",
    )).toContain('"value":"c2"');

    const unsafe = await loginGet(
      new Request(
        "https://krypto.example/api/auth/login?returnTo=//evil.example",
      ),
    );
    expect(new URL(unsafe.headers.get("location")!).searchParams.get(
      "post_login_redirect_uri",
    )).toBe("/admin");
  });

  it("rejects password-only routine authentication without a cookie", async () => {
    const response = await loginPost();
    expect(response.status).toBe(401);
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
  });

  it("keeps local disabled mode fail closed", async () => {
    process.env.ADMIN_IDENTITY_MODE = "disabled";
    const response = await loginGet(
      new Request("http://localhost:3000/api/auth/login"),
    );
    expect(response.status).toBe(503);
    expect(response.headers.has("set-cookie")).toBe(false);
  });
});
