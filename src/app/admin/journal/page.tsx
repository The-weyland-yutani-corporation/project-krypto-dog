export const dynamic = "force-dynamic";

import Link from "next/link";
import { db } from "@/db";
import { agentJournal, tradeExecution } from "@/db/schema";
import { desc, eq } from "drizzle-orm";

interface MarketConditions {
  ethPrice?: number;
  rsi?: number;
  ema?: number;
  [key: string]: unknown;
}

function parseMarketConditions(raw: unknown): MarketConditions {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as MarketConditions;
  }
  return {};
}

function formatUSD(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value);
}

export default async function JournalPage() {
  const rows = await db
    .select({
      id: agentJournal.id,
      entryText: agentJournal.entryText,
      marketConditions: agentJournal.marketConditions,
      tradeExecutionId: agentJournal.tradeExecutionId,
      createdAt: agentJournal.createdAt,
      tradeId: tradeExecution.id,
      tradeDirection: tradeExecution.direction,
    })
    .from(agentJournal)
    .leftJoin(tradeExecution, eq(agentJournal.tradeExecutionId, tradeExecution.id))
    .orderBy(desc(agentJournal.createdAt))
    .limit(30);

  const entries = rows.map((row) => ({
    id: row.id,
    entryText: row.entryText,
    marketConditions: row.marketConditions,
    createdAt: row.createdAt,
    tradeExecution: row.tradeId
      ? { id: row.tradeId, direction: row.tradeDirection! }
      : null,
  }));

  if (entries.length === 0) {
    return (
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Journal</h1>
        <div className="mt-12 text-center">
          <p className="text-5xl">📓</p>
          <p className="mt-4 text-lg font-medium text-gray-600">
            No journal entries yet
          </p>
          <p className="mt-1 text-sm text-gray-400">
            The agent will log its observations and decisions here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Journal</h1>
      <p className="mt-1 text-sm text-gray-500">
        Agent observations and market analysis
      </p>

      <div className="mt-6 space-y-4">
        {entries.map((entry) => {
          const conditions = parseMarketConditions(entry.marketConditions);

          return (
            <div
              key={entry.id}
              className="bg-white rounded-xl shadow-sm border border-gray-200 p-5"
            >
              <div className="flex items-start justify-between gap-4">
                <time className="text-xs font-medium text-gray-400 whitespace-nowrap">
                  {new Date(entry.createdAt).toLocaleString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>

                {entry.tradeExecution && (
                  <Link
                    href="/admin/trades"
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold ${
                      entry.tradeExecution.direction === "BUY"
                        ? "bg-green-100 text-green-800"
                        : "bg-red-100 text-red-800"
                    }`}
                  >
                    {entry.tradeExecution.direction === "BUY" ? "↗" : "↘"}{" "}
                    {entry.tradeExecution.direction} Trade
                  </Link>
                )}
              </div>

              <p className="mt-3 text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">
                {entry.entryText}
              </p>

              {/* Market conditions */}
              {(conditions.ethPrice != null ||
                conditions.rsi != null ||
                conditions.ema != null) && (
                <div className="mt-3 flex flex-wrap gap-3">
                  {conditions.ethPrice != null && (
                    <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-blue-50 text-xs font-medium text-blue-700">
                      ETH {formatUSD(conditions.ethPrice)}
                    </span>
                  )}
                  {conditions.rsi != null && (
                    <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-purple-50 text-xs font-medium text-purple-700">
                      RSI {conditions.rsi.toFixed(1)}
                    </span>
                  )}
                  {conditions.ema != null && (
                    <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-amber-50 text-xs font-medium text-amber-700">
                      EMA {formatUSD(conditions.ema)}
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
