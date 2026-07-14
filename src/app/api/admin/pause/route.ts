import { NextRequest, NextResponse } from "next/server";
import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agentJournal, agentState } from "@/db/schema";
import { requireAdminSession } from "@/lib/admin-route-auth";
import { checkSameOrigin } from "@/lib/csrf";

const PauseBody = z.object({ paused: z.boolean() });

/**
 * Pause/resume the agent (operator switch).
 *
 * This toggles `agentState.isOperatorPaused` only. It does NOT touch
 * `isLocked`, which is reserved for the drawdown safety guardrail and may
 * only be cleared via an explicit, audited override flow (not exposed in v2.5).
 */
export async function POST(request: NextRequest) {
  const csrf = checkSameOrigin(request);
  if (csrf) return csrf;
  const auth = await requireAdminSession(request);
  if (auth) return auth;

  let parsed: z.infer<typeof PauseBody>;
  try {
    parsed = PauseBody.parse(await request.json());
  } catch (err) {
    return NextResponse.json(
      {
        error: "Invalid body — expected { paused: boolean }",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 400 },
    );
  }

  const updated = await db.transaction(async (tx) => {
    const [state] = await tx
      .update(agentState)
      .set({ isOperatorPaused: parsed.paused })
      .where(eq(agentState.id, "singleton"))
      .returning({
        isOperatorPaused: agentState.isOperatorPaused,
        isLocked: agentState.isLocked,
        isRunning: agentState.isRunning,
      });
    if (!state) return null;

    await tx.insert(agentJournal).values({
      entryText: `Operator ${parsed.paused ? "paused" : "resumed"} the agent.`,
      marketConditions: {
        event: "operator-pause",
        paused: parsed.paused,
        timestamp: new Date().toISOString(),
      },
    });
    return state;
  });

  if (!updated) {
    return NextResponse.json(
      { error: "AgentState singleton not found" },
      { status: 500 },
    );
  }

  console.warn(
    `[admin/pause] Operator ${parsed.paused ? "PAUSED" : "RESUMED"} the agent`,
  );

  return NextResponse.json({ ok: true, state: updated }, { status: 200 });
}
