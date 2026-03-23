import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod/v3";
import { db } from "@/db";
import { agentState, tradeExecution } from "@/db/schema";
import { eq } from "drizzle-orm";
import { ALLOWED_ASSETS, MAX_TRADE_SIZE_USD } from "@/lib/config";

async function fetchEthPrice(): Promise<number> {
  const res = await fetch(
    "https://api.coinbase.com/v2/prices/ETH-USD/spot"
  );
  const json = (await res.json()) as {
    data: { amount: string };
  };
  return parseFloat(json.data.amount);
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

  try {
    const executionPrice = await fetchEthPrice();
    const amountAsset = amountUSD / executionPrice;
    const feesUSD = amountUSD * 0.003; // 0.3% fee

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
        agentReasoning: reasoning,
      })
      .returning();

    // Update AgentState balances
    const stateRows = await db
      .select()
      .from(agentState)
      .where(eq(agentState.id, "singleton"))
      .limit(1);
    const state = stateRows[0];

    const ethDelta = direction === "BUY" ? amountAsset : -amountAsset;
    const usdcDelta =
      direction === "BUY" ? -(amountUSD + feesUSD) : amountUSD - feesUSD;

    const newEth = (state?.currentPositionETH ?? 0) + ethDelta;
    const newUsdc = (state?.currentPositionUSDC ?? 200) + usdcDelta;

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
