import { db } from "@/db";
import { agentState } from "@/db/schema";
import { eq } from "drizzle-orm";
import { SystemLockedError } from "@/lib/types";
import { MIN_PORTFOLIO_VALUE_USD } from "@/lib/config";
import { sendGuardrailAlert } from "@/lib/email";

export async function checkDrawdown(): Promise<void> {
  const rows = await db
    .select()
    .from(agentState)
    .where(eq(agentState.id, "singleton"))
    .limit(1);

  if (!rows[0]) {
    throw new Error("AgentState singleton not found");
  }
  const state = rows[0];

  if (state.isLocked) {
    throw new SystemLockedError();
  }

  const res = await fetch(
    "https://api.coinbase.com/v2/prices/ETH-USD/spot"
  );
  if (!res.ok) {
    throw new Error(`Coinbase API error: ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as { data: { amount: string } };
  const ethPrice = parseFloat(json.data.amount);

  const portfolioValue =
    state.currentPositionETH * ethPrice + state.currentPositionUSDC;

  await db
    .update(agentState)
    .set({ portfolioValueUSD: portfolioValue })
    .where(eq(agentState.id, "singleton"));

  if (portfolioValue < MIN_PORTFOLIO_VALUE_USD) {
    await db
      .update(agentState)
      .set({ isLocked: true })
      .where(eq(agentState.id, "singleton"));

    // Send email alert (non-blocking)
    sendGuardrailAlert("Max Drawdown", { portfolioValue }).catch((err) =>
      console.error("[guardrails] Failed to send drawdown alert email:", err)
    );

    throw new SystemLockedError();
  }
}
