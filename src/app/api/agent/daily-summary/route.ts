import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { agentState, tradeExecution, agentJournal } from "@/db/schema";
import { eq, gte, desc } from "drizzle-orm";
import { sendDailySummary } from "@/lib/email";

export async function POST(request: NextRequest) {
  // Auth — same CRON_SECRET as agent run
  const cronSecret = request.headers.get("x-cron-secret");
  if (cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Fetch current portfolio state
    const [state] = await db
      .select()
      .from(agentState)
      .where(eq(agentState.id, "singleton"));

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
      (sum, t) => sum + (t.pnlUSD ?? 0),
      0
    );

    const tradesSummary = recentTrades.map((t) => ({
      direction: t.direction,
      asset: t.asset,
      amountUSD: t.amountUSD,
      pnlUSD: t.pnlUSD,
    }));

    const journalHighlights = recentJournals
      .slice(0, 5)
      .map((j) => j.entryText.slice(0, 200));

    await sendDailySummary({
      portfolioValueUSD: state.portfolioValueUSD,
      totalPnlUSD: totalPnl,
      tradesExecuted: recentTrades.length,
      tradesSummary,
      journalHighlights,
    });

    return NextResponse.json({
      success: true,
      tradesCount: recentTrades.length,
      totalPnlUSD: totalPnl,
    });
  } catch (error) {
    console.error("[daily-summary] Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
