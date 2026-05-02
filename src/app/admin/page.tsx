export const dynamic = "force-dynamic";

import { db } from "@/db";
import { agentState, tradeExecution } from "@/db/schema";
import { eq, gte, count, sum } from "drizzle-orm";
import { OperationsPanel } from "./_components/OperationsPanel";
import { AutoRefresh } from "./_components/AutoRefresh";

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
      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
        Locked
      </span>
    );
  }
  if (isOperatorPaused) {
    return (
      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
        Paused
      </span>
    );
  }
  if (isRunning) {
    return (
      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
        Running
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
      Idle
    </span>
  );
}

function StatCard({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5">
      <p className="text-sm font-medium text-gray-500">{label}</p>
      <div className="mt-1 text-2xl font-semibold text-gray-900">
        {children}
      </div>
    </div>
  );
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

  return (
    <div>
      <AutoRefresh />
      <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
      <p className="mt-1 text-sm text-gray-500">Portfolio overview</p>

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
        <StatCard label="Portfolio Value (USD)">
          {formatUSD(state?.portfolioValueUSD)}
        </StatCard>

        <StatCard label="ETH Balance">
          {formatNumber(state?.currentPositionETH)} ETH
        </StatCard>

        <StatCard label="USDC Balance">
          {formatUSD(state?.currentPositionUSDC)}
        </StatCard>

        <StatCard label="Last Trade Price">
          {state?.lastTradePrice
            ? formatUSD(state.lastTradePrice)
            : "—"}
        </StatCard>

        <StatCard label="Total P&L">
          <span
            className={
              totalPnl >= 0 ? "text-green-600" : "text-red-600"
            }
          >
            {totalPnl >= 0 ? "+" : ""}
            {formatUSD(totalPnl)}
          </span>
        </StatCard>

        <StatCard label="Trades">
          <span>{totalTrades}</span>
          <span className="ml-2 text-sm font-normal text-gray-500">
            ({recentTrades} last 24h)
          </span>
        </StatCard>

        <StatCard label="System Status">
          {state ? (
            <StatusBadge
              isLocked={state.isLocked}
              isOperatorPaused={state.isOperatorPaused}
              isRunning={state.isRunning}
            />
          ) : (
            <span className="text-sm text-gray-400">No state</span>
          )}
        </StatCard>

        <StatCard label="Last Run">
          <span className="text-base">
            {state?.lastRunAt
              ? new Date(state.lastRunAt).toLocaleString("en-US", {
                  dateStyle: "medium",
                  timeStyle: "short",
                })
              : "Never"}
          </span>
        </StatCard>
      </div>
    </div>
  );
}
