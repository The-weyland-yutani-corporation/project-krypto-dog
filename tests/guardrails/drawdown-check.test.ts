import { mockDb } from "../setup";
import { SystemLockedError } from "@/lib/types";
import { MIN_PORTFOLIO_VALUE_USD } from "@/lib/config";

const mockFetch = jest.fn();
global.fetch = mockFetch;

import { checkDrawdown } from "@/guardrails/drawdown-check";

describe("Guardrail 1 – Drawdown Killswitch", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Restore chain methods after clearAllMocks
    mockDb._selectChain.from.mockReturnValue(mockDb._selectChain);
    mockDb._selectChain.where.mockReturnValue(mockDb._selectChain);
    mockDb._selectChain.orderBy.mockReturnValue(mockDb._selectChain);
    mockDb._selectChain.limit.mockResolvedValue([]);
    mockDb._updateChain.set.mockReturnValue(mockDb._updateChain);
    mockDb._updateChain.where.mockReturnValue(mockDb._updateChain);
    mockDb.select.mockReturnValue(mockDb._selectChain);
    mockDb.update.mockReturnValue(mockDb._updateChain);
  });

  function stubEthPrice(price: number) {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: { amount: String(price) } }),
    });
  }

  function stubAgentState(state: Record<string, unknown> | null) {
    // Set the terminal .limit() to resolve with the data
    mockDb._selectChain.limit.mockResolvedValue(state ? [state] : []);
  }

  it("should throw SystemLockedError when agent is already locked", async () => {
    stubAgentState({ id: "singleton", isLocked: true, currentPositionETH: 0, currentPositionUSDC: 200 });
    await expect(checkDrawdown()).rejects.toThrow(SystemLockedError);
  });

  it("should NOT throw when portfolio value >= $150", async () => {
    stubAgentState({ id: "singleton", isLocked: false, currentPositionETH: 0.05, currentPositionUSDC: 100 });
    stubEthPrice(2000);
    await expect(checkDrawdown()).resolves.not.toThrow();
  });

  it("should lock the agent and throw when portfolio value < $150", async () => {
    stubAgentState({ id: "singleton", isLocked: false, currentPositionETH: 0.01, currentPositionUSDC: 50 });
    stubEthPrice(1000);
    await expect(checkDrawdown()).rejects.toThrow(SystemLockedError);
    expect(mockDb.update).toHaveBeenCalled();
  });

  it("should handle missing agent state gracefully", async () => {
    stubAgentState(null);
    await expect(checkDrawdown()).rejects.toThrow();
  });

  it("should handle ETH price fetch failure", async () => {
    stubAgentState({ id: "singleton", isLocked: false, currentPositionETH: 0.05, currentPositionUSDC: 100 });
    mockFetch.mockRejectedValue(new Error("Network error"));
    await expect(checkDrawdown()).rejects.toThrow();
  });

  it("should use MIN_PORTFOLIO_VALUE_USD ($150) as threshold", () => {
    expect(MIN_PORTFOLIO_VALUE_USD).toBe(150);
  });
});
