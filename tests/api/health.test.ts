import { GET as liveGET } from "@/app/api/health/live/route";
import { GET as readyGET } from "@/app/api/health/ready/route";

describe("GET /api/health/live", () => {
  it("returns 200 with only process-level fields", async () => {
    const response = await liveGET();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json();
    expect(body).toEqual({
      status: "ok",
      uptimeSeconds: expect.any(Number),
    });
    expect(Object.keys(body).sort()).toEqual(["status", "uptimeSeconds"]);
  });

  it("requires no authentication header and exposes no config/db/trading fields", async () => {
    const response = await liveGET();
    expect(response.status).not.toBe(401);
    const body = await response.json();
    expect(body).not.toHaveProperty("rolloutMode");
    expect(body).not.toHaveProperty("databaseBinding");
  });
});

describe("GET /api/health/ready", () => {
  it("always returns 200 ok (process-only, no shutdown-signal interception)", async () => {
    const response = await readyGET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ status: "ok", uptimeSeconds: expect.any(Number) });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("requires no authentication header", async () => {
    const response = await readyGET();
    expect(response.status).not.toBe(401);
  });

  it("exposes no config/db/trading fields", async () => {
    const body = await (await readyGET()).json();
    expect(Object.keys(body).sort()).toEqual(["status", "uptimeSeconds"]);
  });

  it("does not install SIGTERM/SIGINT listeners that could suppress default termination", async () => {
    const termBefore = process.listenerCount("SIGTERM");
    const intBefore = process.listenerCount("SIGINT");

    await readyGET();
    await liveGET();

    expect(process.listenerCount("SIGTERM")).toBe(termBefore);
    expect(process.listenerCount("SIGINT")).toBe(intBefore);
  });
});
