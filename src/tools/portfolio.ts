import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod/v3";
import { db } from "@/db";
import { agentState } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getMarketDataProvider } from "@/lib/market-data-provider";

async function fetchEthPrice(): Promise<number> {
  return getMarketDataProvider().getEthSpotPrice();
}

export const getPortfolioStateTool = new DynamicStructuredTool({
  name: "get_portfolio_state",
  description:
    "Returns the current portfolio state including ETH balance, USDC balance, portfolio value, and position P&L.",
  schema: z.object({}),
  func: async () => {
    try {
      const stateRows = await db
        .select()
        .from(agentState)
        .where(eq(agentState.id, "singleton"))
        .limit(1);
      const state = stateRows[0];

      if (!state) {
        return "No portfolio state found. The agent has not been initialized yet.";
      }

      const currentPrice = await fetchEthPrice();
      const portfolioValue =
        state.currentPositionETH * currentPrice + state.currentPositionUSDC;

      const lines: string[] = [
        `ETH Balance: ${state.currentPositionETH.toFixed(6)} ETH`,
        `USDC Balance: $${state.currentPositionUSDC.toFixed(2)}`,
        `Current ETH Price: $${currentPrice.toFixed(2)}`,
        `Portfolio Value: $${portfolioValue.toFixed(2)}`,
        `Last Trade Price (anchor): ${state.lastTradePrice ? `$${state.lastTradePrice.toFixed(2)}` : "N/A"}`,
        `System Locked: ${state.isLocked ? "YES ⛔" : "No"}`,
      ];

      if (state.lastTradePrice && state.currentPositionETH > 0) {
        const pnl =
          (currentPrice - state.lastTradePrice) * state.currentPositionETH;
        const pnlPct =
          ((currentPrice - state.lastTradePrice) / state.lastTradePrice) * 100;
        lines.push(
          `Position P&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)`
        );
      }

      return lines.join("\n");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return `Error fetching portfolio state: ${msg}`;
    }
  },
});
