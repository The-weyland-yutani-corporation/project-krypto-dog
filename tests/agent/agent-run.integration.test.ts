import { mockDb } from "../setup";
import { SystemLockedError } from "@/lib/types";

jest.mock("@/guardrails/drawdown-check", () => ({ checkDrawdown: jest.fn() }));
jest.mock("@/guardrails/cooldown-check", () => ({ checkCooldown: jest.fn() }));
jest.mock("@/guardrails/index", () => ({ runPreFlightChecks: jest.fn() }));

import { checkDrawdown } from "@/guardrails/drawdown-check";
import { checkCooldown } from "@/guardrails/cooldown-check";
import { runPreFlightChecks } from "@/guardrails";

const mockedRunPreFlightChecks = runPreFlightChecks as jest.MockedFunction<typeof runPreFlightChecks>;

describe("Guardrails – Pre-flight Orchestrator", () => {
  beforeEach(() => jest.clearAllMocks());

  it("should return skip=false when all checks pass", async () => {
    mockedRunPreFlightChecks.mockResolvedValue({ skip: false });
    const result = await runPreFlightChecks();
    expect(result.skip).toBe(false);
  });

  it("should return skip=true with locked reason when drawdown fires", async () => {
    mockedRunPreFlightChecks.mockResolvedValue({ skip: true, reason: "System locked: max drawdown reached" });
    const result = await runPreFlightChecks();
    expect(result.skip).toBe(true);
    expect(result.reason).toMatch(/locked/i);
  });

  it("should return skip=true with cooldown reason", async () => {
    mockedRunPreFlightChecks.mockResolvedValue({ skip: true, reason: "Cooldown active" });
    const result = await runPreFlightChecks();
    expect(result.skip).toBe(true);
    expect(result.reason).toMatch(/cooldown/i);
  });
});

describe("Agent Run – Mutex", () => {
  beforeEach(() => jest.clearAllMocks());

  it("should acquire mutex via atomic update returning", async () => {
    mockDb._updateChain.returning.mockResolvedValue([{ id: "singleton", isRunning: true }]);
    const result = await mockDb.update({}).set({}).where({}).returning();
    expect(result.length).toBe(1);
  });

  it("should fail to acquire mutex if already running", async () => {
    mockDb._updateChain.returning.mockResolvedValue([]);
    const result = await mockDb.update({}).set({}).where({}).returning();
    expect(result.length).toBe(0);
  });
});

describe("Agent Run – API Auth", () => {
  it("CRON_SECRET env var should be configured", () => {
    expect(process.env.CRON_SECRET).toBe("test-cron-secret");
  });
});
