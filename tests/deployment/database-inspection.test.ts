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
const identity = { database: "disposable", username: "owner", readOnly: "on", serverVersionNum: 170005 };
const emptyCounts = {
  catalogObjects: 0, largeObjects: 0, databaseSettings: 0, privilegeChanges: 0, metadata: 0,
};
const emptyCatalog = {
  stateCounts: emptyCounts,
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
      if (query.startsWith("SELECT current_database()")) return [identity];
      if (query.includes("WITH inspected_database")) return [emptyCatalog];
      return [];
    });
  });

  it("admits an actually empty database through fixed read-only queries", async () => {
    await expect(inspectEmptyDatabase(options)).resolves.toEqual({
      catalogProfile: "postgresql-17-bootstrap-v2",
      serverVersionNum: 170005,
      databaseHost: "localhost",
      databaseName: "disposable",
      runtimeLoginRole: "krypto_app",
      observedAt: "2026-10-25T00:00:00.000Z",
      readOnly: true,
      stateCounts: emptyCounts,
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

  it.each(Object.keys(emptyCounts))("counts retained %s even with no ordinary tables or runtime roles", async (category) => {
    const stateCounts = { ...emptyCounts, [category]: 1 };
    mockQuery.mockImplementation(async (query) =>
      query.startsWith("SELECT current_database()") ? [identity]
        : query.includes("WITH inspected_database") ? [{ ...emptyCatalog, stateCounts }] : [],
    );
    await expect(inspectEmptyDatabase(options)).resolves.toMatchObject({
      stateCounts, objectCount: 1, empty: false, runtimeRolePresent: false, runtimeLoginPresent: false,
    });
  });

  it.each([
    { runtimeRolePresent: true },
    { runtimeLoginPresent: true },
    { stateCounts: { ...emptyCounts, catalogObjects: 20 }, runtimeRolePresent: true, runtimeLoginPresent: true },
  ])("rejects retained state without changing it: %j", async (retained) => {
    mockQuery.mockImplementation(async (query) => {
      return query.startsWith("SELECT current_database()") ? [identity]
        : query.includes("WITH inspected_database") ? [{ ...emptyCatalog, ...retained }] : [];
    });
    await expect(inspectEmptyDatabase(options)).resolves.toMatchObject({
      ...retained,
      readOnly: true,
      empty: false,
    });
    expect(mockEnd).toHaveBeenCalledTimes(1);
  });

  it.each([160000, 180000, 170001.5, "170000", null, Number.NaN])(
    "refuses an unvalidated or malformed server version before reading catalogs: %s",
    async (serverVersionNum) => {
      mockQuery.mockImplementation(async (query) =>
        query.startsWith("SELECT current_database()") ? [{ ...identity, serverVersionNum }] : [],
      );
      await expect(inspectEmptyDatabase(options)).rejects.toThrow("PostgreSQL 17");
      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect(mockEnd).toHaveBeenCalledTimes(1);
    },
  );

  it("reads large-object metadata and subscription identities, never payloads or connection secrets", async () => {
    await inspectEmptyDatabase(options);
    const query = mockQuery.mock.calls[2][0];
    expect(query).toContain("FROM pg_largeobject_metadata");
    expect(query).not.toMatch(/FROM\s+pg_largeobject\b/);
    expect(query).toContain("SELECT 'pg_subscription'::regclass, oid FROM pg_subscription");
    expect(query).not.toContain("subconninfo");
    expect(query).not.toContain("nspname NOT IN ('pg_catalog'");
    expect(query).toContain("FROM allowed_extension_objects");
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
      query.startsWith("SELECT current_database()") ? [{ ...identity, ...changed }] : [],
    );
    await expect(inspectEmptyDatabase(options)).rejects.toThrow("read-only target");
    expect(mockQuery.mock.calls.some(([query]) => query.includes("WITH inspected_database"))).toBe(false);
    expect(mockEnd).toHaveBeenCalledTimes(1);
  });

  it.each([
    [],
    [emptyCatalog, emptyCatalog],
    ...[null, [], {}, { ...emptyCounts, unknown: 0 }, ...[
      "0", -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1,
    ].map((largeObjects) => ({ ...emptyCounts, largeObjects }))].map((stateCounts) =>
      [{ ...emptyCatalog, stateCounts }]),
    [{ ...emptyCatalog, runtimeRolePresent: null }],
    [{ ...emptyCatalog, runtimeLoginPresent: 0 }],
    [{ ...emptyCatalog, observedAt: new Date("invalid") }],
    [{ ...emptyCatalog, observedAt: "2026-10-25T00:00:00Z" }],
  ].map((rows) => ({ rows })))(
    "never turns incomplete catalog evidence into success: %j",
    async ({ rows }) => {
      mockQuery.mockImplementation(async (query) =>
        query.startsWith("SELECT current_database()") ? [identity]
          : query.includes("WITH inspected_database") ? rows : [],
      );
      await expect(inspectEmptyDatabase(options)).rejects.toThrow("catalog evidence");
      expect(mockEnd).toHaveBeenCalledTimes(1);
    },
  );

  it("refuses a total exceeding safe-integer bounds", async () => {
    mockQuery.mockImplementation(async (query) =>
      query.startsWith("SELECT current_database()") ? [identity]
        : query.includes("WITH inspected_database") ? [{
          ...emptyCatalog,
          stateCounts: { ...emptyCounts, catalogObjects: Number.MAX_SAFE_INTEGER, largeObjects: 1 },
        }] : [],
    );
    await expect(inspectEmptyDatabase(options)).rejects.toThrow("unbounded");
    expect(mockEnd).toHaveBeenCalledTimes(1);
  });

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
