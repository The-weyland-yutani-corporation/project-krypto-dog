import { db } from "@/db";
import { agentState } from "@/db/schema";
import { eq } from "drizzle-orm";
import { SystemLockedError } from "@/lib/types";
import { MIN_PORTFOLIO_VALUE_USD } from "@/lib/config";
import { sendGuardrailAlert } from "@/lib/email";
import { getMarketDataProvider } from "@/lib/market-data-provider";

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

  const ethPrice = await getMarketDataProvider().getEthSpotPrice();

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

    void sendGuardrailAlert("Max Drawdown", { portfolioValue })
      .then((result) => {
        if (result.status === "skipped") {
          console.error(
            `[guardrails] Drawdown alert skipped: ${result.reason}`,
          );
        }
      })
      .catch((err) =>
        console.error("[guardrails] Failed to send drawdown alert email:", err),
      );

    throw new SystemLockedError();
  }
}
