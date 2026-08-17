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
import {
  requestIdFromHeaders,
  resolveReleaseDeploymentCorrelation,
} from "@/lib/correlation";
import { safetyIncidentRepository } from "@/lib/safety-incidents";

async function recordDelivery(
  status: "sent" | "skipped" | "failed",
  detail: string | null,
  deadline?: ExecutionDeadline,
  terminal = false,
): Promise<string> {
  deadline?.assertActive(
    "daily summary delivery persistence",
    terminal,
  );
  const [entry] = await db
    .insert(agentJournal)
    .values({
      entryText: `Daily summary delivery ${status}${detail ? `: ${detail}` : "."}`,
      marketConditions: {
        event: "daily-summary-delivery",
        status,
        detail,
        timestamp: new Date().toISOString(),
      },
    })
    .returning({ id: agentJournal.id });
  if (!entry) throw new Error("Daily delivery audit returned no evidence ID");
  return entry.id;
}

async function failureResponse(
  error: unknown,
  correlation: {
    requestId: string;
    releaseId: string;
    deploymentId: string;
  },
  obligationIncidentId: string | null,
  deadline?: ExecutionDeadline,
  priorAuditFailure = false,
): Promise<NextResponse> {
  const message = error instanceof Error ? error.message : String(error);
  let alertAuditRecorded = !priorAuditFailure;
  try {
    await recordDelivery("failed", message, deadline, true);
  } catch {
    alertAuditRecorded = false;
    console.error(
      JSON.stringify({
        eventType: "journal_persistence_failed",
        requestId: correlation.requestId,
        failureCode: "daily-delivery-failure-audit",
      }),
    );
  }
  if (obligationIncidentId) {
    try {
      await safetyIncidentRepository.appendDeliveryLifecycle({
        incidentId: obligationIncidentId,
        eventKind: "DELIVERY_FAILED",
        attemptId: `daily-failure:${correlation.requestId}`,
        evidence: {
          deliveryChannel: "acs-email",
          deliveryFailureCode:
            error instanceof EmailDeliveryError
              ? "acs-delivery-failed"
              : error instanceof ProviderBudgetError
                ? "provider-budget"
                : error instanceof ExecutionDeadlineError
                  ? "execution-deadline"
                  : "daily-summary-failed",
          retryOutcome: "not-resolved",
        },
      });
    } catch {
      console.error(
        JSON.stringify({
          eventType: "incident_lifecycle_persistence_failed",
          requestId: correlation.requestId,
          failureCode: "daily-delivery-obligation-update",
        }),
      );
    }
  }
  const incident = await safetyIncidentRepository.createOrGet({
    incidentType:
      error instanceof EmailDeliveryError
        ? "EMAIL_DELIVERY_FAILURE"
        : error instanceof ProviderBudgetError ||
            error instanceof AdmissionCapacityError ||
            error instanceof ExecutionDeadlineError
          ? "DEADLINE_BUDGET_EXHAUSTION"
          : "POST_COMMIT_FAILURE",
    severity: "CRITICAL",
    dedupKey: `daily-summary-failure:${correlation.requestId}`,
    requestId: correlation.requestId,
    releaseId: correlation.releaseId,
    deploymentId: correlation.deploymentId,
    redactedContext: {
      component: "daily-summary",
      operation: "delivery",
      failureCode:
        error instanceof EmailDeliveryError
          ? "acs-delivery-failed"
          : error instanceof ProviderBudgetError
            ? "provider-budget"
            : error instanceof AdmissionCapacityError
              ? "admission-capacity"
            : error instanceof ExecutionDeadlineError
              ? "execution-deadline"
              : "daily-summary-failed",
      deliveryChannel: "acs-email",
      outcome: "error",
    },
    ownerRole: "PRIMARY_ON_CALL",
    backupRole: "BACKUP_ON_CALL",
    runbook: "specs/incident-response.md#daily-delivery-failure",
  });
  console.error(
    JSON.stringify({
      eventType: "daily_summary_failed",
      requestId: correlation.requestId,
      incidentId: incident.event.incidentId,
      failureCode: "daily-summary-failed",
    }),
  );
  return NextResponse.json(
    {
      error: message,
      alertAuditRecorded,
      incidentId: incident.event.incidentId,
    },
    {
      status:
        error instanceof ExecutionDeadlineError
          ? 504
          : error instanceof ProviderBudgetError ||
              error instanceof AdmissionCapacityError
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
  const correlation = {
    requestId: requestIdFromHeaders(request.headers),
    ...resolveReleaseDeploymentCorrelation(),
  };
  let obligationIncidentId: string | null = null;
  try {
    releaseAdmission = tryAcquireRunAdmission(deadline);
    const obligation = await safetyIncidentRepository.createOrGet({
      incidentType: "DAILY_DELIVERY_OBLIGATION",
      severity: "WARNING",
      dedupKey: `daily-summary-obligation:${correlation.requestId}`,
      requestId: correlation.requestId,
      releaseId: correlation.releaseId,
      deploymentId: correlation.deploymentId,
      redactedContext: {
        component: "daily-summary",
        operation: "delivery",
        deliveryChannel: "acs-email",
        rolloutMode: actualMode,
      },
      ownerRole: "PRIMARY_ON_CALL",
      backupRole: "BACKUP_ON_CALL",
      runbook: "specs/incident-response.md#daily-delivery-failure",
    });
    obligationIncidentId = obligation.event.incidentId;
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
      throw new Error("AgentState not found");
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
      const journalId = await recordDelivery(
        delivery.status,
        delivery.status === "sent"
          ? (delivery.id ?? null)
          : delivery.reason,
        deadline,
      );
      await flushPostHog({ deadline });
      await safetyIncidentRepository.appendDeliveryLifecycle({
        incidentId: obligationIncidentId,
        eventKind: "DELIVERY_CONFIRMED",
        attemptId: `daily-confirmed:${correlation.requestId}`,
        evidence: {
          artifactRef: `agent-journal:${journalId}`,
          deliveryChannel: "acs-email",
          deliveryReceiptId:
            delivery.status === "sent" ? (delivery.id ?? "sent") : "skipped",
          verification: "delivery-and-audit-persisted",
        },
      });
    } catch (error) {
      return failureResponse(
        error,
        correlation,
        obligationIncidentId,
        deadline,
        true,
      );
    }

    return NextResponse.json({
      generated: true,
      delivery,
      alertAuditRecorded: true,
      incidentId: obligationIncidentId,
      tradesCount: recentTrades.length,
      totalPnlUSD: totalPnl,
    });
  } catch (error) {
    return failureResponse(
      error,
      correlation,
      obligationIncidentId,
      deadline,
    );
  } finally {
    releaseAdmission?.();
    deadline.dispose();
  }
}
