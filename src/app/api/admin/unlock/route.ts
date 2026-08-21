import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { db } from "@/db";
import { agentJournal, agentState } from "@/db/schema";
import { requireAdminOperator } from "@/lib/admin-route-auth";
import { checkSameOrigin } from "@/lib/csrf";
import { recordOperatorAuditEvent } from "@/lib/operator-audit";

const UnlockBody = z.object({
  confirm: z.literal("UNLOCK"),
  reason: z.string().trim().min(10).max(500),
});

export async function POST(request: NextRequest) {
  const csrf = checkSameOrigin(request);
  if (csrf) return csrf;
  const auth = await requireAdminOperator(request, "UNLOCK_AGENT");
  if (!auth.ok) return auth.response;

  const parsed = UnlockBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      {
        error:
          'Invalid body - expected { confirm: "UNLOCK", reason: string (10-500 chars) }',
      },
      { status: 400 },
    );
  }

  const now = new Date();
  const result = await db.transaction(async (tx) => {
    const [state] = await tx
      .select({
        isLocked: agentState.isLocked,
        lockReason: agentState.lockReason,
        lockedAt: agentState.lockedAt,
        leaseOwner: agentState.leaseOwner,
        leaseExpiresAt: agentState.leaseExpiresAt,
      })
      .from(agentState)
      .where(eq(agentState.id, "singleton"))
      .for("update")
      .limit(1);

    if (!state) return { kind: "missing" as const };
    if (!state.isLocked) return { kind: "not-locked" as const };
    if (
      state.leaseOwner !== null &&
      (state.leaseExpiresAt === null || state.leaseExpiresAt > now)
    ) {
      return { kind: "active-run" as const };
    }

    const [updated] = await tx
      .update(agentState)
      .set({
        isLocked: false,
        lockReason: null,
        lockedAt: null,
        isOperatorPaused: true,
      })
      .where(eq(agentState.id, "singleton"))
      .returning({
        isLocked: agentState.isLocked,
        isOperatorPaused: agentState.isOperatorPaused,
      });
    if (!updated) return { kind: "missing" as const };

    const auditEventId = await recordOperatorAuditEvent({
      writer: tx,
      operator: auth.operator,
      action: "UNLOCK_AGENT",
      requestHeaders: request.headers,
      outcome: "APPLIED",
      occurredAt: now,
    });
    await tx.insert(agentJournal).values({
      entryText: `${auth.operator.operatorName} cleared the drawdown safety lock and left the agent paused. Reason: ${parsed.data.reason}`,
      marketConditions: {
        event: "operator-unlock",
        reason: parsed.data.reason,
        priorLockReason: state.lockReason,
        priorLockedAt: state.lockedAt?.toISOString() ?? null,
        operatorAuditEventId: auditEventId,
        timestamp: now.toISOString(),
      },
    });

    return { kind: "unlocked" as const, state: updated };
  });

  switch (result.kind) {
    case "missing":
      return NextResponse.json(
        { error: "AgentState singleton not found" },
        { status: 500 },
      );
    case "not-locked":
      return NextResponse.json(
        { error: "Safety lock is not active" },
        { status: 409 },
      );
    case "active-run":
      return NextResponse.json(
        { error: "Cannot clear the safety lock while a run lease is active" },
        { status: 409 },
      );
    case "unlocked":
      console.warn(
        `[admin/unlock] Operator cleared drawdown lock: ${parsed.data.reason}`,
      );
      return NextResponse.json(
        { ok: true, state: result.state },
        { status: 200 },
      );
  }
}
