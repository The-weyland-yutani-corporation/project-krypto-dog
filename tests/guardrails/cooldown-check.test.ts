import { mockDb } from "../setup";
import { COOLDOWN_MS } from "@/lib/config";
import { checkCooldown } from "@/guardrails/cooldown-check";

describe("Guardrail 2 – Trade Cooldown", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.select.mockReturnValue(mockDb._selectChain);
    mockDb._selectChain.from.mockReturnValue(mockDb._selectChain);
    mockDb._selectChain.where.mockReturnValue(mockDb._selectChain);
    mockDb._selectChain.orderBy.mockReturnValue(mockDb._selectChain);
    mockDb._selectChain.limit.mockResolvedValue([]);
  });

  function stubLastTrade(trade: Record<string, unknown> | null) {
    mockDb._selectChain.limit.mockResolvedValue(trade ? [trade] : []);
  }

  it("should return false when there are no previous trades", async () => {
    stubLastTrade(null);
    expect(await checkCooldown()).toBe(false);
  });

  it("should return false when the last trade was > 2 hours ago", async () => {
    stubLastTrade({ id: "t1", createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000) });
    expect(await checkCooldown()).toBe(false);
  });

  it("should return true when the last trade was < 2 hours ago", async () => {
    stubLastTrade({ id: "t2", createdAt: new Date(Date.now() - 1 * 60 * 60 * 1000) });
    expect(await checkCooldown()).toBe(true);
  });

  it("should return false at exactly 2 hours (boundary)", async () => {
    stubLastTrade({ id: "t3", createdAt: new Date(Date.now() - COOLDOWN_MS) });
    expect(await checkCooldown()).toBe(false);
  });

  it("should use COOLDOWN_MS equal to 2 hours", () => {
    expect(COOLDOWN_MS).toBe(2 * 60 * 60 * 1000);
  });
});
