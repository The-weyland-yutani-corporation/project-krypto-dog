import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { agentState, tradeExecution, agentJournal } from "@/db/schema";
import { eq, gte, desc } from "drizzle-orm";
import { EmailDeliveryError, sendDailySummary } from "@/lib/email";
import { timingSafeStringEqual } from "@/lib/secure-compare";

async function recordDelivery(
  status: "sent" | "skipped" | "failed",
  detail: string | null,
): Promise<void> {
  await db.insert(agentJournal).values({
    entryText: `Daily summary delivery ${status}${detail ? `: ${detail}` : "."}`,
    marketConditions: {
      event: "daily-summary-delivery",
      status,
      detail,
      timestamp: new Date().toISOString(),
    },
  });
}

async function failureResponse(error: unknown): Promise<NextResponse> {
  const message = error instanceof Error ? error.message : String(error);
  let alertAuditRecorded = true;
  try {
    await recordDelivery("failed", message);
  } catch (auditError) {
    alertAuditRecorded = false;
    console.error("[daily-summary] Failed to record alert failure:", auditError);
  }
  console.error("[daily-summary] Error:", error);
  return NextResponse.json(
    { error: message, alertAuditRecorded },
    { status: error instanceof EmailDeliveryError ? 502 : 500 },
  );
}

export async function POST(request: NextRequest) {
  // Auth — same CRON_SECRET as agent run
  const cronSecret = request.headers.get("x-cron-secret");
  const expectedSecret = process.env.CRON_SECRET;
  if (
    !cronSecret ||
    !expectedSecret ||
    !timingSafeStringEqual(cronSecret, expectedSecret)
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Fetch current portfolio state
    const [state] = await db
      .select()
      .from(agentState)
      .where(eq(agentState.id, "singleton"))
      .limit(1);

    if (!state) {
      return NextResponse.json(
        { error: "AgentState not found" },
        { status: 500 }
      );
    }

    // Fetch last 24h trades
    const recentTrades = await db
      .select()
      .from(tradeExecution)
      .where(gte(tradeExecution.createdAt, twentyFourHoursAgo))
      .orderBy(desc(tradeExecution.createdAt));

    // Fetch last 24h journal entries
    const recentJournals = await db
      .select()
      .from(agentJournal)
      .where(gte(agentJournal.createdAt, twentyFourHoursAgo))
      .orderBy(desc(agentJournal.createdAt));

    const totalPnl = recentTrades.reduce(
      (sum, trade) =>
        sum +
        Number(trade.realizedPnlUSDDecimal ?? trade.pnlUSD ?? 0),
      0,
    );

    const tradesSummary = recentTrades.map((trade) => ({
      direction: trade.direction,
      asset: trade.asset,
      amountUSD: Number(trade.requestedNotionalUSD ?? trade.amountUSD),
      pnlUSD:
        trade.realizedPnlUSDDecimal === null
          ? trade.pnlUSD
          : Number(trade.realizedPnlUSDDecimal),
    }));

    const journalHighlights = recentJournals
      .slice(0, 5)
      .map((j) => j.entryText.slice(0, 200));

    const delivery = await sendDailySummary({
      portfolioValueUSD: Number(
        state.portfolioValueUSDDecimal ?? state.portfolioValueUSD,
      ),
      totalPnlUSD: totalPnl,
      tradesExecuted: recentTrades.length,
      tradesSummary,
      journalHighlights,
    });
    try {
      await recordDelivery(
        delivery.status,
        delivery.status === "sent"
          ? (delivery.id ?? null)
          : delivery.reason,
      );
    } catch (error) {
      console.error("[daily-summary] Delivery succeeded but audit failed:", error);
      return NextResponse.json(
        {
          generated: true,
          delivery,
          alertAuditRecorded: false,
          error: error instanceof Error ? error.message : String(error),
        },
        { status: 500 },
      );
    }

    return NextResponse.json({
      generated: true,
      delivery,
      alertAuditRecorded: true,
      tradesCount: recentTrades.length,
      totalPnlUSD: totalPnl,
    });
  } catch (error) {
    return failureResponse(error);
  }
}
