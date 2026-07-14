import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull, lte, or } from "drizzle-orm";
import { db } from "@/db";
import { agentJournal, agentState } from "@/db/schema";
import { requireAdminSession } from "@/lib/admin-route-auth";
import { checkSameOrigin } from "@/lib/csrf";

/**
 * Recover a legacy or expired run lease left over from a crashed run.
 *
 * Active owned leases cannot be released through this endpoint. Drawdown and
 * operator controls are independent and remain untouched.
 */
export async function POST(request: NextRequest) {
  const csrf = checkSameOrigin(request);
  if (csrf) return csrf;
  const auth = await requireAdminSession(request);
  if (auth) return auth;

  const recovery = await db.transaction(async (tx) => {
    const [priorState] = await tx
      .select({
        isRunning: agentState.isRunning,
        isLocked: agentState.isLocked,
        isOperatorPaused: agentState.isOperatorPaused,
        lastRunAt: agentState.lastRunAt,
        leaseOwner: agentState.leaseOwner,
        leaseExpiresAt: agentState.leaseExpiresAt,
      })
      .from(agentState)
      .where(eq(agentState.id, "singleton"))
      .limit(1);
    if (!priorState) {
      return { kind: "missing" as const };
    }

    const [state] = await tx
      .update(agentState)
      .set({
        isRunning: false,
        leaseOwner: null,
        leaseExpiresAt: null,
      })
      .where(
        and(
          eq(agentState.id, "singleton"),
          or(
            isNull(agentState.leaseOwner),
            lte(agentState.leaseExpiresAt, new Date()),
          ),
        ),
      )
      .returning({
        isRunning: agentState.isRunning,
        isLocked: agentState.isLocked,
        isOperatorPaused: agentState.isOperatorPaused,
        leaseOwner: agentState.leaseOwner,
        leaseExpiresAt: agentState.leaseExpiresAt,
      });
    if (!state) {
      return { kind: "active" as const, priorState };
    }

    await tx.insert(agentJournal).values({
      entryText: "Operator recovered an expired or legacy run lease.",
      marketConditions: {
        event: "lease-recovery",
        priorLeaseOwner: priorState.leaseOwner,
        priorLeaseExpiresAt:
          priorState.leaseExpiresAt?.toISOString() ?? null,
        timestamp: new Date().toISOString(),
      },
    });
    return { kind: "recovered" as const, priorState, state };
  });

  if (recovery.kind === "missing") {
    return NextResponse.json(
      { error: "AgentState singleton not found" },
      { status: 500 },
    );
  }

  if (recovery.kind === "active") {
    return NextResponse.json(
      {
        error: "Run lease is still active",
        priorState: recovery.priorState,
      },
      { status: 409 },
    );
  }

  console.warn(
    `[admin/release-run-lease] Operator recovered expired run lease. Prior state: ${JSON.stringify(recovery.priorState)}`,
  );

  return NextResponse.json(
    {
      ok: true,
      priorState: recovery.priorState,
      state: recovery.state,
    },
    { status: 200 },
  );
}
