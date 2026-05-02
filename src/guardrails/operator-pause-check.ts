import { db } from "@/db";
import { agentState } from "@/db/schema";
import { eq } from "drizzle-orm";

/**
 * Returns true if the operator has paused the agent via the admin UI.
 *
 * This is intentionally separate from `isLocked` (which is the drawdown safety
 * lock and may only be cleared via an explicit, audited override flow). An
 * operator-paused agent can be resumed by toggling the same admin control;
 * a drawdown-locked agent cannot.
 */
export async function checkOperatorPaused(): Promise<boolean> {
  const rows = await db
    .select({ paused: agentState.isOperatorPaused })
    .from(agentState)
    .where(eq(agentState.id, "singleton"))
    .limit(1);
  return rows[0]?.paused === true;
}
