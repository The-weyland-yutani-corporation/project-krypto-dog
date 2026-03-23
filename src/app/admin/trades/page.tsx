export const dynamic = "force-dynamic";

import Link from "next/link";
import { db } from "@/db";
import { tradeExecution } from "@/db/schema";
import { desc, count } from "drizzle-orm";

const PAGE_SIZE = 50;

function formatUSD(value: number | null | undefined): string {
  if (value == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(value);
}

export default async function TradesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const params = await searchParams;
  const page = Math.max(1, parseInt(params.page ?? "1", 10) || 1);
  const skip = (page - 1) * PAGE_SIZE;

  const [trades, totalCountRows] = await Promise.all([
    db.select().from(tradeExecution).orderBy(desc(tradeExecution.createdAt)).limit(PAGE_SIZE).offset(skip),
    db.select({ value: count() }).from(tradeExecution),
  ]);

  const totalCount = totalCountRows[0].value;

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  if (trades.length === 0 && page === 1) {
    return (
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Trades</h1>
        <div className="mt-12 text-center">
          <p className="text-5xl">💹</p>
          <p className="mt-4 text-lg font-medium text-gray-600">
            No trades yet
          </p>
          <p className="mt-1 text-sm text-gray-400">
            Trades will appear here once the agent starts executing.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Trades</h1>
          <p className="mt-1 text-sm text-gray-500">
            {totalCount} total trade{totalCount !== 1 ? "s" : ""}
          </p>
        </div>
      </div>

      <div className="mt-6 bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                {[
                  "Time",
                  "Direction",
                  "Asset",
                  "Amount",
                  "Price",
                  "Fees",
                  "P&L",
                  "Reasoning",
                ].map((header) => (
                  <th
                    key={header}
                    className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                  >
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {trades.map((trade) => (
                <tr key={trade.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">
                    {new Date(trade.createdAt).toLocaleString("en-US", {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ${
                        trade.direction === "BUY"
                          ? "bg-green-100 text-green-800"
                          : "bg-red-100 text-red-800"
                      }`}
                    >
                      {trade.direction}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm font-medium text-gray-900 whitespace-nowrap">
                    {trade.asset}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-700 whitespace-nowrap">
                    {formatUSD(trade.amountUSD)}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-700 whitespace-nowrap">
                    {formatUSD(trade.executionPrice)}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500 whitespace-nowrap">
                    {formatUSD(trade.feesUSD)}
                  </td>
                  <td className="px-4 py-3 text-sm font-medium whitespace-nowrap">
                    {trade.pnlUSD != null ? (
                      <span
                        className={
                          trade.pnlUSD >= 0
                            ? "text-green-600"
                            : "text-red-600"
                        }
                      >
                        {trade.pnlUSD >= 0 ? "+" : ""}
                        {formatUSD(trade.pnlUSD)}
                      </span>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500 max-w-xs">
                    <details>
                      <summary className="cursor-pointer truncate max-w-[200px]">
                        {trade.agentReasoning.slice(0, 80)}
                        {trade.agentReasoning.length > 80 ? "…" : ""}
                      </summary>
                      <p className="mt-2 whitespace-pre-wrap text-xs text-gray-600">
                        {trade.agentReasoning}
                      </p>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <p className="text-sm text-gray-500">
            Page {page} of {totalPages}
          </p>
          <div className="flex gap-2">
            {page > 1 && (
              <Link
                href={`/admin/trades?page=${page - 1}`}
                className="px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                ← Previous
              </Link>
            )}
            {page < totalPages && (
              <Link
                href={`/admin/trades?page=${page + 1}`}
                className="px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Next →
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
