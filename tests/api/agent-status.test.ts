import { NextRequest } from "next/server";

import { GET } from "@/app/api/agent/status/route";
import { mockDb } from "../setup";

describe("agent status route", () => {
  const originalSecret = process.env.CRON_SECRET;
  const originalMode = process.env.ROLLOUT_MODE;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = "status-secret";
    process.env.ROLLOUT_MODE = "disabled";
    mockDb.select.mockReturnValue(mockDb._selectChain);
    mockDb._selectChain.from.mockReturnValue(mockDb._selectChain);
    mockDb._selectChain.where.mockReturnValue(mockDb._selectChain);
    mockDb._selectChain.limit.mockResolvedValue([]);
  });

  afterAll(() => {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
    if (originalMode === undefined) delete process.env.ROLLOUT_MODE;
    else process.env.ROLLOUT_MODE = originalMode;
  });

  it("requires cron authentication", async () => {
    const response = await GET(
      new NextRequest("https://krypto.example.com/api/agent/status"),
    );

    expect(response.status).toBe(401);
  });

  it("reports the effective disabled mode without running the agent", async () => {
    const response = await GET(
      new NextRequest("https://krypto.example.com/api/agent/status", {
        headers: { "x-cron-secret": "status-secret" },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      rolloutMode: "disabled",
      databaseBinding: null,
    });
  });

  it("proves a database challenge through the runtime connection", async () => {
    mockDb._selectChain.limit.mockResolvedValueOnce([
      { id: "deployment-smoke-binding-123e4567-e89b-42d3-a456-426614174000" },
    ]);
    const response = await GET(
      new NextRequest("https://krypto.example.com/api/agent/status", {
        headers: {
          "x-cron-secret": "status-secret",
          "x-database-challenge":
            "deployment-smoke-binding-123e4567-e89b-42d3-a456-426614174000",
        },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      rolloutMode: "disabled",
      databaseBinding: true,
    });
  });

  it("reports an absent valid database challenge", async () => {
    const response = await GET(
      new NextRequest("https://krypto.example.com/api/agent/status", {
        headers: {
          "x-cron-secret": "status-secret",
          "x-database-challenge":
            "deployment-smoke-binding-123e4567-e89b-42d3-a456-426614174000",
        },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      rolloutMode: "disabled",
      databaseBinding: false,
    });
  });

  it("rejects malformed database challenges before querying", async () => {
    const response = await GET(
      new NextRequest("https://krypto.example.com/api/agent/status", {
        headers: {
          "x-cron-secret": "status-secret",
          "x-database-challenge": "not-a-binding-id",
        },
      }),
    );

    expect(response.status).toBe(400);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("fails closed on invalid rollout configuration", async () => {
    process.env.ROLLOUT_MODE = "live";
    const response = await GET(
      new NextRequest("https://krypto.example.com/api/agent/status", {
        headers: { "x-cron-secret": "status-secret" },
      }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid rollout configuration",
    });
  });
});
