import { NextRequest } from "next/server";
import { checkSameOrigin } from "@/lib/csrf";

function makeReq(
  headers: Record<string, string>,
  url = "http://localhost:3000/api/admin/test",
) {
  return new NextRequest(
    new Request(url, {
      method: "POST",
      headers,
    }),
  );
}

describe("CSRF — checkSameOrigin", () => {
  const originalAppOrigin = process.env.APP_ORIGIN;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalAppOrigin === undefined) {
      delete process.env.APP_ORIGIN;
    } else {
      process.env.APP_ORIGIN = originalAppOrigin;
    }
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("allows same-origin Origin header", () => {
    const r = makeReq({ origin: "http://localhost:3000" });
    expect(checkSameOrigin(r)).toBeNull();
  });

  it("rejects cross-origin Origin header", () => {
    const r = makeReq({ origin: "https://evil.example.com" });
    const res = checkSameOrigin(r);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it("falls back to Referer when Origin is missing — same origin allowed", () => {
    const r = makeReq({ referer: "http://localhost:3000/admin" });
    expect(checkSameOrigin(r)).toBeNull();
  });

  it("falls back to Referer when Origin is missing — cross origin rejected", () => {
    const r = makeReq({ referer: "https://evil.example.com/some/page" });
    const res = checkSameOrigin(r);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it("rejects when both Origin and Referer are missing", () => {
    const r = makeReq({});
    const res = checkSameOrigin(r);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it("rejects malformed Referer", () => {
    const r = makeReq({ referer: "not-a-url" });
    const res = checkSameOrigin(r);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it("uses the configured public origin behind a reverse proxy", () => {
    process.env.APP_ORIGIN = "https://krypto.example.com";

    const request = makeReq(
      { origin: "https://krypto.example.com" },
      "http://localhost:3000/api/admin/test",
    );

    expect(checkSameOrigin(request)).toBeNull();
  });

  it("does not accept the proxy's internal origin when APP_ORIGIN is configured", () => {
    process.env.APP_ORIGIN = "https://krypto.example.com";

    const response = checkSameOrigin(
      makeReq({ origin: "http://localhost:3000" }),
    );

    expect(response).not.toBeNull();
    expect(response!.status).toBe(403);
  });

  it("fails closed when APP_ORIGIN is malformed", () => {
    process.env.APP_ORIGIN = "https://krypto.example.com/admin";

    const response = checkSameOrigin(
      makeReq({ origin: "https://krypto.example.com" }),
    );

    expect(response).not.toBeNull();
    expect(response!.status).toBe(403);
  });

  it("fails closed in production when APP_ORIGIN is missing", () => {
    process.env.NODE_ENV = "production";
    delete process.env.APP_ORIGIN;

    const response = checkSameOrigin(
      makeReq({ origin: "http://localhost:3000" }),
    );

    expect(response).not.toBeNull();
    expect(response!.status).toBe(403);
  });
});
