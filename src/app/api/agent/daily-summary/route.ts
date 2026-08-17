import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { agentState, tradeExecution, agentJournal } from "@/db/schema";
import { eq, gte, desc } from "drizzle-orm";
import { isValidCronSecret } from "@/lib/cron-auth";
import { EmailDeliveryError, sendDailySummary } from "@/lib/email";
import { readRequiredRolloutMode } from "@/lib/required-rollout-mode";
import { resolveTradingMode } from "@/trading/strategy-config";
import {
  AdmissionCapacityError,
  ExecutionDeadlineError,
  ProviderBudgetError,
  createExecutionDeadline,
  type ExecutionDeadline,
} from "@/lib/execution-envelope";
import { tryAcquireRunAdmission } from "@/lib/run-admission";
import {
  flushPostHog,
  reservePostHogBudget,
} from "@/lib/posthog";

async function recordDelivery(
  status: "sent" | "skipped" | "failed",
  detail: string | null,
  deadline?: ExecutionDeadline,
  terminal = false,
): Promise<void> {
  deadline?.assertActive(
    "daily summary delivery persistence",
    terminal,
  );
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

async function failureResponse(
  error: unknown,
  deadline?: ExecutionDeadline,
): Promise<NextResponse> {
  const message = error instanceof Error ? error.message : String(error);
  let alertAuditRecorded = true;
  try {
    await recordDelivery("failed", message, deadline, true);
  } catch (auditError) {
    alertAuditRecorded = false;
    console.error("[daily-summary] Failed to record alert failure:", auditError);
  }
  console.error("[daily-summary] Error:", error);
  return NextResponse.json(
    { error: message, alertAuditRecorded },
    {
      status:
        error instanceof ExecutionDeadlineError
          ? 504
          : error instanceof ProviderBudgetError
            ? 503
            : error instanceof EmailDeliveryError
              ? 502
              : 500,
    },
  );
}

export async function POST(request: NextRequest) {
  // Auth — same CRON_SECRET as agent run
  if (!isValidCronSecret(request.headers.get("x-cron-secret"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let requiredMode: ReturnType<typeof readRequiredRolloutMode>;
  try {
    requiredMode = readRequiredRolloutMode(request);
  } catch {
    return NextResponse.json(
      { error: "Invalid required rollout mode" },
      { status: 400 },
    );
  }
  if (!requiredMode) {
    return NextResponse.json(
      { error: "Required rollout mode is missing" },
      { status: 400 },
    );
  }
  let actualMode: ReturnType<typeof resolveTradingMode>;
  try {
    actualMode = resolveTradingMode();
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
  if (requiredMode !== actualMode) {
    return NextResponse.json(
      {
        error: "Rollout mode changed before summary generation",
        expectedMode: requiredMode,
        actualMode,
      },
      { status: 409 },
    );
  }

  const deadline = createExecutionDeadline({ signal: request.signal });
  let releaseAdmission: (() => void) | undefined;
  try {
    releaseAdmission = tryAcquireRunAdmission(deadline);
    await reservePostHogBudget({ deadline });
    deadline.assertActive("daily summary database read");
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

    deadline.assertActive("daily summary ACS delivery");
    const delivery = await sendDailySummary(
      {
        portfolioValueUSD: Number(
          state.portfolioValueUSDDecimal ?? state.portfolioValueUSD,
        ),
        totalPnlUSD: totalPnl,
        tradesExecuted: recentTrades.length,
        tradesSummary,
        journalHighlights,
      },
      { deadline },
    );
    try {
      deadline.assertActive("daily summary delivery journal");
      await recordDelivery(
        delivery.status,
        delivery.status === "sent"
          ? (delivery.id ?? null)
          : delivery.reason,
        deadline,
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
    if (error instanceof AdmissionCapacityError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 503, headers: { "Retry-After": "1" } },
      );
    }
    return failureResponse(error, deadline);
  } finally {
    if (deadline.remainingMs() > 0) {
      try {
        await flushPostHog({ deadline });
      } catch (error) {
        console.error("[daily-summary] Failed to flush analytics:", error);
      }
    }
    releaseAdmission?.();
    deadline.dispose();
  }
}
