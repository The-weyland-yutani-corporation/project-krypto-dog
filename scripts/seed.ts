import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { agentState } from "../src/db/schema";

async function main() {
  const client = postgres(process.env.DATABASE_URL!);
  const db = drizzle(client);

  console.log("🌱 Seeding AgentState singleton...");

  await db
    .insert(agentState)
    .values({
      id: "singleton",
      currentPositionETH: 0,
      currentPositionUSDC: 200,
      portfolioValueUSD: 200,
      isLocked: false,
      isRunning: false,
    })
    .onConflictDoNothing();

  console.log("✅ AgentState seeded (or already exists).");

  await client.end();
}

main().catch((e) => {
  console.error("❌ Seed failed:", e);
  process.exit(1);
});
