import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { agentState } from "../src/db/schema";
import { classifyMigrationUrlSafety } from "../src/deployment/migration-url-safety";
import { INITIAL_CAPITAL_USD } from "../src/lib/config";

async function main() {
  const migrationUrl = process.env.MIGRATION_URL;
  const directUrl = process.env.DIRECT_URL;
  const connectionUrl = migrationUrl ?? directUrl;
  if (!connectionUrl) {
    throw new Error(
      "MIGRATION_URL (protected deployment lane) or DIRECT_URL (local/operator initialization) is required to initialize the paper account singleton.",
    );
  }

  if (migrationUrl) {
    const safety = classifyMigrationUrlSafety({
      migrationUrl,
      directUrl,
      runtimeUrl: process.env.DATABASE_URL,
      expectedUsername: "krypto_migrator",
    });
    if (!safety.safe) {
      throw new Error(
        `MIGRATION_URL failed initialization safety validation: ${safety.reasons.join(" ")}`,
      );
    }
  }

  const client = postgres(connectionUrl, {
    max: 1,
    prepare: false,
  });
  const db = drizzle(client);

  console.log("Initializing the AgentState singleton...");

  try {
    if (migrationUrl) {
      // The migrator is NOINHERIT and must explicitly cross the reviewed
      // SET-ROLE boundary. The singleton remains schema-owner-owned; neither
      // the migrator nor the server admin becomes an application object owner.
      await client`SET ROLE "krypto_schema_owner"`;
    }
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
    if (migrationUrl) {
      await client`RESET ROLE`;
    }
    await client.end();
  }
}

main().catch((e) => {
  console.error("AgentState initialization failed:", e);
  process.exit(1);
});
