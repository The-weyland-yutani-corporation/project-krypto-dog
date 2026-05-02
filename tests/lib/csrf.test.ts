import { NextRequest } from "next/server";
import { checkSameOrigin } from "@/lib/csrf";

function makeReq(headers: Record<string, string>) {
  return new NextRequest(
    new Request("http://localhost:3000/api/admin/test", {
      method: "POST",
      headers,
    }),
  );
}

describe("CSRF — checkSameOrigin", () => {
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
});
