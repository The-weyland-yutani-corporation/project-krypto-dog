process.env.NODE_ENV = "test";

// Dummy env vars so config validation doesn't crash during tests.
// Authentication is mocked at the client boundary; no API key is configured.
process.env.AZURE_OPENAI_BASE_URL =
  "https://test.openai.azure.com/openai/v1";
process.env.AZURE_OPENAI_DEPLOYMENT_NAME = "krypto-test-luna";
process.env.AZURE_FOUNDRY_PROJECT_ENDPOINT =
  "https://test.services.ai.azure.com/api/projects/krypto-test-agents";
process.env.AZURE_FOUNDRY_AGENT_NAME = "krypto-test-decision";
process.env.AZURE_FOUNDRY_AGENT_VERSION = "1";
process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
process.env.POSTHOG_API_KEY = "phc_test_key";
process.env.POSTHOG_HOST = "https://app.posthog.com";
process.env.POSTHOG_ENVIRONMENT = "dev";
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
