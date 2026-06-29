import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agentState } from "@/db/schema";
import { checkSameOrigin } from "@/lib/csrf";

/**
 * Release a stuck run lease (`isRunning = true` left over from a crashed run).
 *
 * Only clears `isRunning`. Does NOT clear `isLocked` (drawdown safety) or
 * `isOperatorPaused` — those are policy decisions and should be cleared
 * deliberately via their own controls.
 *
 * This endpoint is dangerous: if invoked while a run is genuinely in flight,
 * a second run can start in parallel and write conflicting trades. The UI
 * gates it behind a confirm dialog and the in-flight `safeTrade` re-checks
 * pause/lock before INSERTing — but the operator should still treat this as
 * "use only when you're sure the previous run is dead".
 */
export async function POST(request: NextRequest) {
  const csrf = checkSameOrigin(request);
  if (csrf) return csrf;

  const before = await db
    .select({
      isRunning: agentState.isRunning,
      isLocked: agentState.isLocked,
      isOperatorPaused: agentState.isOperatorPaused,
      lastRunAt: agentState.lastRunAt,
    })
    .from(agentState)
    .where(eq(agentState.id, "singleton"))
    .limit(1);

  const priorState = before[0];
  if (!priorState) {
    return NextResponse.json(
      { error: "AgentState singleton not found" },
      { status: 500 },
    );
  }

  const [after] = await db
    .update(agentState)
    .set({ isRunning: false })
    .where(eq(agentState.id, "singleton"))
    .returning({
      isRunning: agentState.isRunning,
      isLocked: agentState.isLocked,
      isOperatorPaused: agentState.isOperatorPaused,
    });

  console.warn(
    `[admin/release-run-lease] Operator force-released run lease. Prior state: ${JSON.stringify(priorState)}`,
  );

  return NextResponse.json(
    {
      ok: true,
      priorState,
      state: after,
    },
    { status: 200 },
  );
}
