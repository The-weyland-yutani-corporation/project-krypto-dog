export const dynamic = "force-dynamic";

import { db } from "@/db";
import {
  agentJournal,
  agentRun,
  agentState,
  tradeExecution,
} from "@/db/schema";
import { count, desc, eq, gte, sql, sum } from "drizzle-orm";
import { OperationsPanel } from "./_components/OperationsPanel";
import { AutoRefresh } from "./_components/AutoRefresh";
import { BacktestSnapshot } from "@/components/charts/backtest-snapshot";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/krypto/page-header";
import { MetricCard } from "@/components/krypto/metric-card";
import { getBacktestSnapshotData } from "@/lib/backtest-display";
import { evaluateOperationsHealth } from "@/lib/operations-health";

function formatUSD(value: number | null | undefined): string {
  if (value == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value);
}

function formatNumber(value: number | null | undefined, decimals = 4): string {
  if (value == null) return "—";
  return value.toFixed(decimals);
}

function StatusBadge({
  isLocked,
  isOperatorPaused,
  isRunning,
}: {
  isLocked: boolean;
  isOperatorPaused: boolean;
  isRunning: boolean;
}) {
  if (isLocked) {
    return (
      <Badge variant="destructive">
        Locked
      </Badge>
    );
  }
  if (isOperatorPaused) {
    return <Badge variant="warning">Paused</Badge>;
  }
  if (isRunning) {
    return <Badge variant="success">Running</Badge>;
  }
  return <Badge variant="outline">Idle</Badge>;
}

export default async function AdminDashboard() {
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [
    stateRows,
    totalTradesRows,
    recentTradesRows,
    pnlRows,
    latestRunRows,
    latestAlertRows,
  ] = await Promise.all([
    db.select().from(agentState).where(eq(agentState.id, "singleton")),
    db.select({ value: count() }).from(tradeExecution),
    db.select({ value: count() }).from(tradeExecution).where(gte(tradeExecution.createdAt, twentyFourHoursAgo)),
    db
      .select({ value: sum(tradeExecution.realizedPnlUSDDecimal) })
      .from(tradeExecution),
    db.select().from(agentRun).orderBy(desc(agentRun.startedAt)).limit(1),
    db
      .select({
        marketConditions: agentJournal.marketConditions,
        createdAt: agentJournal.createdAt,
      })
      .from(agentJournal)
      .where(
        sql`${agentJournal.marketConditions}->>'event' = 'daily-summary-delivery'`,
      )
      .orderBy(desc(agentJournal.createdAt))
      .limit(1),
  ]);

  const state = stateRows[0] ?? null;
  const totalTrades = totalTradesRows[0].value;
  const recentTrades = recentTradesRows[0].value;
  const totalPnl = Number(pnlRows[0].value) || 0;
  const latestRun = latestRunRows[0] ?? null;
  const latestAlert = latestAlertRows[0] ?? null;
  const renderedAtMs = Date.now();
  const leaseExpired =
    state?.leaseExpiresAt !== null &&
    state?.leaseExpiresAt !== undefined &&
    state.leaseExpiresAt.getTime() <= renderedAtMs;
  const canRecoverLease =
    state?.isRunning === true &&
    (state.leaseOwner === null || state.leaseExpiresAt === null || leaseExpired);
  const rolloutMode = process.env.ROLLOUT_MODE ?? "disabled";
  const health = evaluateOperationsHealth({
    now: new Date(renderedAtMs),
    rolloutMode,
    state,
    latestRun,
    latestAlert,
  });
  const chartData = getBacktestSnapshotData();

  return (
    <div>
      <AutoRefresh />
      <PageHeader
        eyebrow="Operator console"
        title="Agent dashboard"
        description="Paper portfolio state, run controls, and deterministic evidence snapshots before any live trading."
      />

      {state && (
        <div className="mt-6">
          <OperationsPanel
            isRunning={state.isRunning}
            isLocked={state.isLocked}
            isOperatorPaused={state.isOperatorPaused}
            canRecoverLease={canRecoverLease}
          />
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          label="Portfolio Value (USD)"
          value={formatUSD(
            state?.portfolioValueUSDDecimal === null ||
              state?.portfolioValueUSDDecimal === undefined
              ? state?.portfolioValueUSD
              : Number(state.portfolioValueUSDDecimal),
          )}
        />

        <MetricCard
          label="ETH Balance"
          value={`${formatNumber(
            state?.currentPositionETHDecimal === null ||
              state?.currentPositionETHDecimal === undefined
              ? state?.currentPositionETH
              : Number(state.currentPositionETHDecimal),
          )} ETH`}
        />

        <MetricCard
          label="USDC Balance"
          value={formatUSD(
            state?.currentPositionUSDCDecimal === null ||
              state?.currentPositionUSDCDecimal === undefined
              ? state?.currentPositionUSDC
              : Number(state.currentPositionUSDCDecimal),
          )}
        />

        <MetricCard
          label="Last Trade Price"
          value={
            state?.lastTradePriceDecimal
              ? formatUSD(Number(state.lastTradePriceDecimal))
              : state?.lastTradePrice
                ? formatUSD(state.lastTradePrice)
                : "—"
          }
        />

        <MetricCard
          label="Total P&L"
          tone={totalPnl >= 0 ? "success" : "destructive"}
          value={
          <span
            className={
              totalPnl >= 0 ? "text-success" : "text-destructive"
            }
          >
            {totalPnl >= 0 ? "+" : ""}
            {formatUSD(totalPnl)}
          </span>
          }
        />

        <MetricCard
          label="Trades"
          value={totalTrades}
          detail={`${recentTrades} last 24h`}
        />

        <MetricCard
          label="System Status"
          value={state ? (
            <StatusBadge
              isLocked={state.isLocked}
              isOperatorPaused={state.isOperatorPaused}
              isRunning={state.isRunning}
            />
          ) : (
            <span className="text-sm text-muted-foreground">No state</span>
          )}
        />

        <MetricCard
          label="Last Run"
          value={
          <span className="text-base text-foreground">
            {state?.lastRunAt
              ? new Date(state.lastRunAt).toLocaleString("en-US", {
                  dateStyle: "medium",
                  timeStyle: "short",
                })
              : "Never"}
          </span>
          }
        />

        <MetricCard
          label="Drawdown"
          value={
            state?.drawdownPct === null || state?.drawdownPct === undefined
              ? "—"
              : `${Number(state.drawdownPct).toFixed(2)}%`
          }
          detail={`Peak ${formatUSD(
            state?.peakPortfolioValueUSD
              ? Number(state.peakPortfolioValueUSD)
              : undefined,
          )}`}
        />

        <MetricCard
          label="Accounting"
          value={health.reconciliation.value}
          detail={health.reconciliation.detail}
          tone={health.reconciliation.tone}
        />

        <MetricCard
          label="Rollout Mode"
          value={rolloutMode}
          detail={`Strategy ${state?.strategyVersion ?? "unknown"}`}
        />

        <MetricCard
          label="Latest AgentRun"
          value={latestRun?.outcome ?? "None"}
          detail={
            latestRun
              ? `${latestRun.triggerSource} · ${latestRun.latencyMs ?? 0} ms`
              : "No invocation recorded"
          }
        />

        <MetricCard
          label="Run Schedule"
          value={health.schedule.value}
          detail={health.schedule.detail}
          tone={health.schedule.tone}
        />

        <MetricCard
          label="Run Lease"
          value={health.lease.value}
          detail={health.lease.detail}
          tone={health.lease.tone}
        />

        <MetricCard
          label="Market Data"
          value={health.marketData.value}
          detail={health.marketData.detail}
          tone={health.marketData.tone}
        />

        <MetricCard
          label="Alert Delivery"
          value={health.alertDelivery.value}
          detail={health.alertDelivery.detail}
          tone={health.alertDelivery.tone}
        />
      </div>

      <div className="mt-6">
        <BacktestSnapshot {...chartData} />
      </div>
    </div>
  );
}
