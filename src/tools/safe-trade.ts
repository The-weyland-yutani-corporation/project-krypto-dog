import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod/v3";
import { db } from "@/db";
import { agentState, tradeExecution } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { ALLOWED_ASSETS, MAX_TRADE_SIZE_USD } from "@/lib/config";
import { getMarketDataProvider } from "@/lib/market-data-provider";

async function fetchEthPrice(): Promise<number> {
  return getMarketDataProvider().getEthSpotPrice();
}

interface SafeTradeInput {
  direction: "BUY" | "SELL";
  asset: string;
  amountUSD: number;
  reasoning?: string;
}

export async function safeTradeHandler(input: SafeTradeInput): Promise<string> {
  const { direction, asset, amountUSD, reasoning = "" } = input;

  // Guardrail 4: Asset whitelist
  if (!ALLOWED_ASSETS.includes(asset as (typeof ALLOWED_ASSETS)[number])) {
    return "Error: Unauthorized asset. Only ETH and USDC are allowed.";
  }

  // Guardrail 3: Max trade size
  if (amountUSD > MAX_TRADE_SIZE_USD) {
    return `Error: Trade exceeds max limit of $${MAX_TRADE_SIZE_USD}. Please reduce trade size.`;
  }

  if (amountUSD <= 0) {
    return "Error: Trade amount must be greater than $0.";
  }

  // Guardrail 5: Balance validation
  const stateCheck = await db
    .select()
    .from(agentState)
    .where(eq(agentState.id, "singleton"))
    .limit(1);
  const currentState = stateCheck[0];
  if (!currentState) {
    return "Error: Agent state not found.";
  }

  try {
    const executionPrice = await fetchEthPrice();
    const amountAsset = amountUSD / executionPrice;
    const feesUSD = amountUSD * 0.003; // 0.3% fee

    if (direction === "SELL" && currentState.currentPositionETH < amountAsset) {
      return `Error: Insufficient ETH balance. You hold ${currentState.currentPositionETH.toFixed(6)} ETH but this trade requires ${amountAsset.toFixed(6)} ETH.`;
    }

    if (direction === "BUY") {
      const requiredUSDC = amountUSD + feesUSD;
      if (currentState.currentPositionUSDC < requiredUSDC) {
        return `Error: Insufficient USDC balance. You hold $${currentState.currentPositionUSDC.toFixed(2)} USDC but this trade requires $${requiredUSDC.toFixed(2)} (including fees).`;
      }
    }

    // Re-check operator pause / drawdown lock immediately before recording
    // the trade. This is the in-flight stop: if the operator pauses (or
    // drawdown trips) after pre-flight passed but before INSERT, we abort
    // here rather than persist a trade the operator no longer wants.
    const guardCheck = await db
      .select({
        isLocked: agentState.isLocked,
        isOperatorPaused: agentState.isOperatorPaused,
      })
      .from(agentState)
      .where(eq(agentState.id, "singleton"))
      .limit(1);
    const guardState = guardCheck[0];
    if (guardState?.isOperatorPaused) {
      return "Trade aborted: operator paused the agent during this run.";
    }
    if (guardState?.isLocked) {
      return "Trade aborted: drawdown safety lock engaged during this run.";
    }

    // Realised PnL (SELL only). Anchor = price of most recent BUY.
    //
    // Querying tradeExecution (rather than agentState.lastTradePrice) avoids
    // two known issues:
    //   1. After a SELL, agentState.lastTradePrice becomes the SELL price, so
    //      a subsequent SELL would be anchored to another SELL — nonsensical.
    //   2. lastTradePrice is also bumped by SELLs in the state writeback below,
    //      which would silently corrupt the anchor for future trades.
    //
    // The matched BUY fee is allocated proportionally for partial sells so
    // realised PnL reflects the round-trip fee cost instead of the SELL fee
    // only. Limitation: this still uses only the *most recent* BUY, not a
    // volume-weighted cost basis across DCA chains. True VWAP cost basis is
    // tracked as a v3 follow-up (see specs/rfcs/0001-v3-live-trading.md).
    let pnlUSD: number | null = null;
    if (direction === "SELL") {
      const lastBuyRows = await db
        .select({
          price: tradeExecution.executionPrice,
          amountAsset: tradeExecution.amountAsset,
          feesUSD: tradeExecution.feesUSD,
        })
        .from(tradeExecution)
        .where(eq(tradeExecution.direction, "BUY"))
        .orderBy(desc(tradeExecution.createdAt))
        .limit(1);
      const lastBuy = lastBuyRows[0];
      const anchor = lastBuy?.price;
      if (anchor != null && anchor > 0) {
        const buyAmountAsset = lastBuy.amountAsset;
        const buyFeeShare =
          buyAmountAsset > 0
            ? lastBuy.feesUSD * Math.min(amountAsset / buyAmountAsset, 1)
            : 0;
        pnlUSD = (executionPrice - anchor) * amountAsset - feesUSD - buyFeeShare;
      }
    }

    // Log trade to database
    const [trade] = await db
      .insert(tradeExecution)
      .values({
        direction,
        asset,
        amountUSD,
        amountAsset,
        executionPrice,
        feesUSD,
        slippage: 0,
        pnlUSD,
        agentReasoning: reasoning,
      })
      .returning();

    const ethDelta = direction === "BUY" ? amountAsset : -amountAsset;
    const usdcDelta =
      direction === "BUY" ? -(amountUSD + feesUSD) : amountUSD - feesUSD;

    const newEth = currentState.currentPositionETH + ethDelta;
    const newUsdc = currentState.currentPositionUSDC + usdcDelta;

    await db
      .insert(agentState)
      .values({
        id: "singleton",
        lastTradePrice: executionPrice,
        currentPositionETH: newEth,
        currentPositionUSDC: newUsdc,
        portfolioValueUSD: newEth * executionPrice + newUsdc,
      })
      .onConflictDoUpdate({
        target: agentState.id,
        set: {
          lastTradePrice: executionPrice,
          currentPositionETH: newEth,
          currentPositionUSDC: newUsdc,
          portfolioValueUSD: newEth * executionPrice + newUsdc,
        },
      });

    return [
      `Trade executed successfully.`,
      `ID: ${trade.id}`,
      `Direction: ${direction}`,
      `Asset: ${asset}`,
      `Amount: $${amountUSD.toFixed(2)}`,
      `Execution Price: $${executionPrice.toFixed(2)}`,
      `Asset Amount: ${amountAsset.toFixed(6)} ${asset}`,
      `Fees: $${feesUSD.toFixed(4)}`,
      `P&L: ${pnlUSD === null ? "N/A" : `${pnlUSD >= 0 ? "+" : ""}$${pnlUSD.toFixed(4)}`}`,
      `New ETH Balance: ${newEth.toFixed(6)}`,
      `New USDC Balance: $${newUsdc.toFixed(2)}`,
    ].join("\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Error executing trade: ${message}`;
  }
}

export const safeTrade = new DynamicStructuredTool({
  name: "safe_trade",
  description:
    "Execute a trade on the ETH/USDC pair. Specify direction (BUY or SELL), asset (ETH or USDC), and amount in USD.",
  schema: z.object({
    direction: z.enum(["BUY", "SELL"]),
    asset: z.string(),
    amountUSD: z.number(),
    reasoning: z
      .string()
      .optional()
      .default("")
      .describe("Why this trade is being made"),
  }),
  func: async (input) => safeTradeHandler(input),
});
