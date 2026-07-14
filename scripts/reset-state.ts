import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import {
  agentState,
  agentRun,
  tradeExecution,
  agentJournal,
} from "../src/db/schema";
import { INITIAL_CAPITAL_USD } from "../src/lib/config";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set");
  }

  const looksLikeProd =
    /supabase\.co/i.test(url) ||
    /amazonaws\.com/i.test(url) ||
    /azure\.com/i.test(url);
  if (looksLikeProd && process.env.ALLOW_DESTRUCTIVE_RESET !== "yes") {
    throw new Error(
      "Refusing to run destructive reset against what looks like a production DATABASE_URL. " +
        "Set ALLOW_DESTRUCTIVE_RESET=yes to override.",
    );
  }

  const client = postgres(url);
  const db = drizzle(client);

  console.log("🧹 Resetting agent state to fresh defaults…");

  const journalsDeleted = await db.delete(agentJournal).returning({ id: agentJournal.id });
  const tradesDeleted = await db
    .delete(tradeExecution)
    .returning({ id: tradeExecution.id });
  const runsDeleted = await db.delete(agentRun).returning({ id: agentRun.id });

  await db
    .update(agentState)
    .set({
      lastTradePrice: null,
      currentPositionETH: 0,
      currentPositionUSDC: INITIAL_CAPITAL_USD,
      portfolioValueUSD: INITIAL_CAPITAL_USD,
      initialCapitalUSD: INITIAL_CAPITAL_USD.toFixed(8),
      lastTradePriceDecimal: null,
      currentPositionETHDecimal: "0.000000000000000000",
      currentPositionUSDCDecimal: INITIAL_CAPITAL_USD.toFixed(8),
      portfolioValueUSDDecimal: INITIAL_CAPITAL_USD.toFixed(8),
      weightedCostBasisUSD: null,
      referencePriceUSD: null,
      lastBuyPriceUSD: null,
      dcaCount: 0,
      peakPortfolioValueUSD: INITIAL_CAPITAL_USD.toFixed(8),
      drawdownPct: "0.00000000",
      strategyVersion: "v2.1-default",
      strategySnapshot: { source: "local-reset" },
      accountingStatus: "RECONCILED",
      accountingIssue: null,
      isLocked: false,
      lockReason: null,
      lockedAt: null,
      isOperatorPaused: false,
      isRunning: false,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastRunAt: null,
      lastCompletedRunAt: null,
    })
    .where(eq(agentState.id, "singleton"));

  console.log(
    `✅ Reset complete. Removed ${runsDeleted.length} run(s), ${tradesDeleted.length} trade(s), and ${journalsDeleted.length} journal entr${journalsDeleted.length === 1 ? "y" : "ies"}.`,
  );
  console.log(
    `   AgentState → 0 ETH / $${INITIAL_CAPITAL_USD} USDC / value $${INITIAL_CAPITAL_USD} / unlocked / operator resumed.`,
  );

  await client.end();
}

main().catch((e) => {
  console.error("❌ Reset failed:", e);
  process.exit(1);
});
