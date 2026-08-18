import { NextRequest, NextResponse } from "next/server";
import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agentJournal, agentState } from "@/db/schema";
import { requireAdminOperator } from "@/lib/admin-route-auth";
import { checkSameOrigin } from "@/lib/csrf";
import { recordOperatorAuditEvent } from "@/lib/operator-audit";

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
  const action = parsed.paused ? "PAUSE_AGENT" : "RESUME_AGENT";
  const auth = await requireAdminOperator(request, action);
  if (!auth.ok) return auth.response;

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

    const auditEventId = await recordOperatorAuditEvent({
      writer: tx,
      operator: auth.operator,
      action,
      requestHeaders: request.headers,
      outcome: "APPLIED",
    });
    await tx.insert(agentJournal).values({
      entryText: `${auth.operator.operatorName} ${parsed.paused ? "paused" : "resumed"} the agent.`,
      marketConditions: {
        event: "operator-pause",
        paused: parsed.paused,
        operatorAuditEventId: auditEventId,
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
