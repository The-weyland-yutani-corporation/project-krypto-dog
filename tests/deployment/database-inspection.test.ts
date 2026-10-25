import postgres from "postgres";

import { inspectEmptyDatabase } from "@/deployment/database-inspection";

const mockEnd = jest.fn<Promise<void>, [{ timeout: number }]>();
const mockQuery = jest.fn<Promise<unknown[]>, [string, unknown[]?]>();
const mockBegin = jest.fn<
  Promise<unknown>,
  [string, (query: { unsafe: typeof mockQuery }) => Promise<unknown>]
>();
const mockSql = { begin: mockBegin, end: mockEnd };
jest.mock("postgres", () => ({
  __esModule: true,
  default: jest.fn(() => mockSql),
}));

const options = {
  directUrl: "postgresql://owner:fixture-password@localhost/disposable",
  expectedHost: "localhost",
  expectedDatabase: "disposable",
  runtimeLoginRole: "krypto_app",
};
const identity = { database: "disposable", username: "owner", readOnly: "on" };
const emptyCatalog = {
  objectCount: 0,
  runtimeRolePresent: false,
  runtimeLoginPresent: false,
  observedAt: new Date("2026-10-25T00:00:00Z"),
};

describe("read-only database bootstrap inspection", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnd.mockResolvedValue();
    mockBegin.mockImplementation(async (_options, action) => action({ unsafe: mockQuery }));
    mockQuery.mockReset();
    mockQuery.mockImplementation(async (query) => {
      if (query.includes("current_database()")) return [identity];
      if (query.includes("WITH user_namespaces")) return [emptyCatalog];
      return [];
    });
  });

  it("admits an actually empty database through fixed read-only queries", async () => {
    await expect(inspectEmptyDatabase(options)).resolves.toEqual({
      databaseHost: "localhost",
      databaseName: "disposable",
      runtimeLoginRole: "krypto_app",
      observedAt: "2026-10-25T00:00:00.000Z",
      readOnly: true,
      objectCount: 0,
      runtimeRolePresent: false,
      runtimeLoginPresent: false,
      empty: true,
    });
    expect(postgres).toHaveBeenCalledWith(
      options.directUrl,
      expect.objectContaining({
        max: 1, connect_timeout: 10,
        connection: expect.objectContaining({ statement_timeout: 5_000 }),
      }),
    );
    expect(mockBegin).toHaveBeenCalledWith(
      "isolation level repeatable read read only", expect.any(Function),
    );
    expect(mockQuery.mock.calls[0][0]).toBe("SET LOCAL search_path = pg_catalog");
    expect(mockQuery.mock.calls[2][1]).toEqual(["krypto_runtime", "krypto_app"]);
    expect(mockQuery.mock.calls.some(([query]) =>
      /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE|TRUNCATE)\b/i.test(query),
    )).toBe(false);
    expect(mockEnd).toHaveBeenCalledTimes(1);
  });

  it.each([
    { objectCount: 1 },
    { runtimeRolePresent: true },
    { runtimeLoginPresent: true },
    { objectCount: 20, runtimeRolePresent: true, runtimeLoginPresent: true },
  ])("rejects retained state without changing it: %j", async (retained) => {
    mockQuery.mockImplementation(async (query) => {
      return query.includes("current_database()") ? [identity]
        : query.includes("WITH user_namespaces") ? [{ ...emptyCatalog, ...retained }] : [];
    });
    await expect(inspectEmptyDatabase(options)).resolves.toMatchObject({
      ...retained,
      readOnly: true,
      empty: false,
    });
    expect(mockEnd).toHaveBeenCalledTimes(1);
  });

  it.each([
    { expectedHost: "another.example.com" },
    { expectedDatabase: "another_database" },
    { expectedDatabase: "public;DROP TABLE" },
    { runtimeLoginRole: "krypto_runtime" },
    { runtimeLoginRole: "x".repeat(64) },
    { runtimeLoginRole: "app;GRANT" },
    { directUrl: "not-a-url" },
    { directUrl: "https://owner:fixture-password@localhost/disposable" },
    { directUrl: `${options.directUrl}?options=-c%20search_path%3Dattacker` },
    { directUrl: `${options.directUrl}?sslmode=require&sslmode=disable` },
    { directUrl: `${options.directUrl}#fragment` },
    { directUrl: "postgresql://localhost/disposable" },
  ])("rejects a malformed/foreign binding before connection: %j", async (invalid) => {
    await expect(inspectEmptyDatabase({ ...options, ...invalid })).rejects.toThrow();
    expect(postgres).not.toHaveBeenCalled();
    expect(mockBegin).not.toHaveBeenCalled();
  });

  it.each([
    { database: "another_database" },
    { username: "another_owner" },
    { readOnly: "off" },
  ])("rejects a different or writable actual connection: %j", async (changed) => {
    mockQuery.mockImplementation(async (query) =>
      query.includes("current_database()") ? [{ ...identity, ...changed }] : [],
    );
    await expect(inspectEmptyDatabase(options)).rejects.toThrow("read-only target");
    expect(mockQuery.mock.calls.some(([query]) => query.includes("WITH user_namespaces"))).toBe(false);
    expect(mockEnd).toHaveBeenCalledTimes(1);
  });

  it.each([
    [],
    [emptyCatalog, emptyCatalog],
    [{ ...emptyCatalog, objectCount: "0" }],
    [{ ...emptyCatalog, objectCount: -1 }],
    [{ ...emptyCatalog, runtimeRolePresent: null }],
    [{ ...emptyCatalog, runtimeLoginPresent: 0 }],
    [{ ...emptyCatalog, observedAt: new Date("invalid") }],
    [{ ...emptyCatalog, observedAt: "2026-10-25T00:00:00Z" }],
  ].map((rows) => ({ rows })))(
    "never turns incomplete catalog evidence into success: %j",
    async ({ rows }) => {
      mockQuery.mockImplementation(async (query) =>
        query.includes("current_database()") ? [identity]
          : query.includes("WITH user_namespaces") ? rows : [],
      );
      await expect(inspectEmptyDatabase(options)).rejects.toThrow("catalog evidence");
      expect(mockEnd).toHaveBeenCalledTimes(1);
    },
  );

  it("closes the client and propagates denied/failed reads", async () => {
    mockQuery.mockRejectedValueOnce(new Error("permission denied"));
    await expect(inspectEmptyDatabase(options)).rejects.toThrow("permission denied");
    expect(mockEnd).toHaveBeenCalledTimes(1);
  });

  it("closes failed connections and never treats an unavailable database as empty", async () => {
    mockBegin.mockRejectedValueOnce(new Error("connection unavailable"));
    await expect(inspectEmptyDatabase(options)).rejects.toThrow("connection unavailable");
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockEnd).toHaveBeenCalledTimes(1);
  });
});
