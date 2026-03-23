import { db } from "@/db";
import { tradeExecution } from "@/db/schema";
import { desc } from "drizzle-orm";
import { COOLDOWN_MS } from "@/lib/config";

export async function checkCooldown(): Promise<boolean> {
  const rows = await db
    .select()
    .from(tradeExecution)
    .orderBy(desc(tradeExecution.createdAt))
    .limit(1);

  const lastTrade = rows[0];

  if (!lastTrade) {
    return false;
  }

  if (Date.now() - lastTrade.createdAt.getTime() < COOLDOWN_MS) {
    return true;
  }

  return false;
}
