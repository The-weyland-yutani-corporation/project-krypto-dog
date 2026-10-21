import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { db } from "@/db";
import { agentJournal, agentState } from "@/db/schema";
import { requireAdminSession } from "@/lib/admin-route-auth";
import { checkSameOrigin } from "@/lib/csrf";
import { ETH_SCALE, parseDecimal } from "@/trading/accounting";

const UnlockBody = z.object({
  confirm: z.literal("UNLOCK"),
  reason: z.string().trim().min(10).max(500),
});

type UnlockResult =
  | { kind: "missing" }
  | { kind: "not-locked" }
  | { kind: "active-run" }
  | { kind: "accounting-unreconciled"; accountingStatus: string }
  | { kind: "invalid-position"; currentPositionETHDecimal: string | null }
  | {
      kind: "flat-last-buy-present";
      lastBuyPriceUSD: string | null;
    }
  | {
      kind: "unlocked";
      state: { isLocked: boolean; isOperatorPaused: boolean };
    };

function isZeroEth(value: string | null): boolean {
  if (value === null) return false;
  return parseDecimal(value, ETH_SCALE) === 0n;
}

function isPositiveEth(value: string | null): boolean {
  if (value === null) return false;
  return parseDecimal(value, ETH_SCALE) > 0n;
}

export async function POST(request: NextRequest) {
  const csrf = checkSameOrigin(request);
  if (csrf) return csrf;
  const auth = await requireAdminSession(request);
  if (auth) return auth;

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
  const result: UnlockResult = await db.transaction(async (tx) => {
    const [state] = await tx
      .select({
        isLocked: agentState.isLocked,
        lockReason: agentState.lockReason,
        lockedAt: agentState.lockedAt,
        leaseOwner: agentState.leaseOwner,
        leaseExpiresAt: agentState.leaseExpiresAt,
        accountingStatus: agentState.accountingStatus,
        currentPositionETHDecimal: agentState.currentPositionETHDecimal,
        referencePriceUSD: agentState.referencePriceUSD,
        lastBuyPriceUSD: agentState.lastBuyPriceUSD,
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
    if (state.accountingStatus !== "RECONCILED") {
      return {
        kind: "accounting-unreconciled" as const,
        accountingStatus: state.accountingStatus,
      };
    }

    const position = state.currentPositionETHDecimal;
    const flat = isZeroEth(position);
    const open = isPositiveEth(position);
    if (!flat && !open) {
      return {
        kind: "invalid-position" as const,
        currentPositionETHDecimal: position,
      };
    }

    const priorReferencePriceUSD = state.referencePriceUSD;
    const priorLastBuyPriceUSD = state.lastBuyPriceUSD;

    if (flat && priorLastBuyPriceUSD !== null) {
      return {
        kind: "flat-last-buy-present" as const,
        lastBuyPriceUSD: priorLastBuyPriceUSD,
      };
    }

    const positionClass = flat ? ("flat" as const) : ("open" as const);
    const nextReferencePriceUSD = flat ? null : priorReferencePriceUSD;
    const nextLastBuyPriceUSD = open ? null : priorLastBuyPriceUSD;

    const [updated] = await tx
      .update(agentState)
      .set({
        isLocked: false,
        lockReason: null,
        lockedAt: null,
        isOperatorPaused: true,
        ...(flat ? { referencePriceUSD: null } : { lastBuyPriceUSD: null }),
      })
      .where(eq(agentState.id, "singleton"))
      .returning({
        isLocked: agentState.isLocked,
        isOperatorPaused: agentState.isOperatorPaused,
      });
    if (!updated) return { kind: "missing" as const };

    await tx.insert(agentJournal).values({
      entryText: `Operator cleared the drawdown safety lock and left the agent paused. Reason: ${parsed.data.reason}`,
      marketConditions: {
        event: "operator-unlock",
        reason: parsed.data.reason,
        positionClass,
        accountingStatus: state.accountingStatus,
        currentPositionETHDecimal: position,
        referencePriceUSD: {
          before: priorReferencePriceUSD,
          after: nextReferencePriceUSD,
        },
        lastBuyPriceUSD: {
          before: priorLastBuyPriceUSD,
          after: nextLastBuyPriceUSD,
        },
        priorLockReason: state.lockReason,
        priorLockedAt: state.lockedAt?.toISOString() ?? null,
        isOperatorPaused: true,
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
    case "accounting-unreconciled":
      return NextResponse.json(
        {
          error:
            "Cannot clear the safety lock while accounting is not RECONCILED",
          accountingStatus: result.accountingStatus,
        },
        { status: 409 },
      );
    case "invalid-position":
      return NextResponse.json(
        {
          error:
            "Cannot clear the safety lock with an invalid or missing ETH position",
          currentPositionETHDecimal: result.currentPositionETHDecimal,
        },
        { status: 409 },
      );
    case "flat-last-buy-present":
      return NextResponse.json(
        {
          error:
            "Cannot clear the safety lock while flat with a non-null lastBuyPriceUSD",
          lastBuyPriceUSD: result.lastBuyPriceUSD,
        },
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
