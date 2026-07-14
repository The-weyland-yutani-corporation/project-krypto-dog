process.env.NODE_ENV = "test";

// Dummy env vars so config validation doesn't crash during tests.
// Use preferred ANTHROPIC_FOUNDRY_* names; legacy AZURE_OPENAI_* fallback is
// still supported but CDP credentials are no longer required.
process.env.ANTHROPIC_FOUNDRY_BASE_URL = "https://test.services.ai.azure.com/anthropic";
process.env.ANTHROPIC_FOUNDRY_API_KEY = "test-api-key";
process.env.ANTHROPIC_FOUNDRY_DEPLOYMENT = "claude-sonnet-stub";
process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
process.env.POSTHOG_API_KEY = "phc_test_key";
process.env.POSTHOG_HOST = "https://app.posthog.com";
process.env.CRON_SECRET = "test-cron-secret";
process.env.ADMIN_SESSION_SECRET = "test-admin-session-secret";

// ---------------------------------------------------------------------------
// Mock: Drizzle db
// ---------------------------------------------------------------------------

function createChain() {
  const chain: Record<string, jest.Mock> & { then?: unknown } = {};
  const chainMethods = ["from", "where", "orderBy", "offset", "set", "for"];
  const terminalMethods = ["limit", "returning", "onConflictDoUpdate", "onConflictDoNothing"];

  // Chain methods return the chain for further chaining
  for (const m of chainMethods) {
    chain[m] = jest.fn().mockReturnValue(chain);
  }
  // Terminal methods return a resolved promise by default
  for (const m of terminalMethods) {
    chain[m] = jest.fn().mockResolvedValue([]);
  }
  // values() returns chain (for .returning() or .onConflict*())
  chain.values = jest.fn().mockReturnValue(chain);

  // Make chain itself thenable so `await db.update().set().where()` works
  // (when there's no terminal method after where)
  chain.then = (resolve: (v: unknown) => void) => Promise.resolve([]).then(resolve);

  return chain;
}

const _selectChain = createChain();
const _insertChain = createChain();
const _updateChain = createChain();
const _deleteChain = createChain();

const mockDrizzleDb = {
  select: jest.fn().mockReturnValue(_selectChain),
  insert: jest.fn().mockReturnValue(_insertChain),
  update: jest.fn().mockReturnValue(_updateChain),
  delete: jest.fn().mockReturnValue(_deleteChain),
  transaction: jest.fn(),
  query: {},
  _selectChain,
  _insertChain,
  _updateChain,
  _deleteChain,
};

mockDrizzleDb.transaction.mockImplementation(
  async (callback: (tx: typeof mockDrizzleDb) => Promise<unknown>) =>
    callback(mockDrizzleDb),
);

jest.mock("@/db", () => ({
  db: mockDrizzleDb,
}));

export const mockDb = mockDrizzleDb;
