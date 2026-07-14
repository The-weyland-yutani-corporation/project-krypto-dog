import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { agentState } from "../src/db/schema";
import { INITIAL_CAPITAL_USD } from "../src/lib/config";

async function main() {
  const directUrl = process.env.DIRECT_URL;
  if (!directUrl) {
    throw new Error(
      "DIRECT_URL is required to initialize the paper account singleton.",
    );
  }

  const client = postgres(directUrl, {
    max: 1,
    prepare: false,
  });
  const db = drizzle(client);

  console.log("Initializing the AgentState singleton...");

  try {
    await db
      .insert(agentState)
      .values({
        id: "singleton",
        currentPositionETH: 0,
        currentPositionUSDC: INITIAL_CAPITAL_USD,
        portfolioValueUSD: INITIAL_CAPITAL_USD,
        initialCapitalUSD: INITIAL_CAPITAL_USD.toFixed(8),
        currentPositionETHDecimal: "0.000000000000000000",
        currentPositionUSDCDecimal: INITIAL_CAPITAL_USD.toFixed(8),
        portfolioValueUSDDecimal: INITIAL_CAPITAL_USD.toFixed(8),
        peakPortfolioValueUSD: INITIAL_CAPITAL_USD.toFixed(8),
        drawdownPct: "0.00000000",
        strategyVersion: "v2.1-default",
        strategySnapshot: { source: "account-initialization" },
        accountingStatus: "RECONCILED",
        isLocked: false,
        isOperatorPaused: false,
        isRunning: false,
        updatedAt: new Date(),
      })
      .onConflictDoNothing();

    console.log("AgentState initialized (or already exists); no rows deleted.");
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error("AgentState initialization failed:", e);
  process.exit(1);
});
