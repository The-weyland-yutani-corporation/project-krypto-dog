export const dynamic = "force-dynamic";

import { db } from "@/db";
import { agentState, tradeExecution } from "@/db/schema";
import { eq, gte, count, sum } from "drizzle-orm";
import { OperationsPanel } from "./_components/OperationsPanel";
import { AutoRefresh } from "./_components/AutoRefresh";
import { BacktestSnapshot } from "@/components/charts/backtest-snapshot";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/krypto/page-header";
import { MetricCard } from "@/components/krypto/metric-card";
import { getBacktestSnapshotData } from "@/lib/backtest-display";

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
  // eslint-disable-next-line react-hooks/purity -- server component runs once per request
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [stateRows, totalTradesRows, recentTradesRows, pnlRows] = await Promise.all([
    db.select().from(agentState).where(eq(agentState.id, "singleton")),
    db.select({ value: count() }).from(tradeExecution),
    db.select({ value: count() }).from(tradeExecution).where(gte(tradeExecution.createdAt, twentyFourHoursAgo)),
    db.select({ value: sum(tradeExecution.pnlUSD) }).from(tradeExecution),
  ]);

  const state = stateRows[0] ?? null;
  const totalTrades = totalTradesRows[0].value;
  const recentTrades = recentTradesRows[0].value;
  const totalPnl = Number(pnlRows[0].value) || 0;
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
          />
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard label="Portfolio Value (USD)" value={formatUSD(state?.portfolioValueUSD)} />

        <MetricCard label="ETH Balance" value={`${formatNumber(state?.currentPositionETH)} ETH`} />

        <MetricCard label="USDC Balance" value={formatUSD(state?.currentPositionUSDC)} />

        <MetricCard label="Last Trade Price" value={state?.lastTradePrice ? formatUSD(state.lastTradePrice) : "—"} />

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
      </div>

      <div className="mt-6">
        <BacktestSnapshot {...chartData} />
      </div>
    </div>
  );
}
