export const dynamic = "force-dynamic";

import Link from "next/link";
import { db } from "@/db";
import { agentJournal, tradeExecution } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/krypto/empty-state";
import { PageHeader } from "@/components/krypto/page-header";

interface MarketConditions {
  ethPrice?: number;
  spotPriceUSD?: number;
  rsi?: number;
  emaShort?: number;
  emaLong?: number;
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
        <PageHeader
          eyebrow="Agent memory"
          title="Journal"
          description="Reasoning snapshots, market context, and trade-linked memory."
        />
        <EmptyState
          icon="📓"
          title="No journal entries yet"
          description="The agent will log observations, decisions, and fallback memory here."
        />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow="Agent memory"
        title="Journal"
        description="Agent observations and market analysis from recent paper runs."
      />

      <div className="mt-6 space-y-4">
        {entries.map((entry) => {
          const conditions = parseMarketConditions(entry.marketConditions);
          const ethPrice = conditions.spotPriceUSD ?? conditions.ethPrice;

          return (
            <div
              key={entry.id}
              className="rounded-xl border border-border bg-card p-5 shadow-[0_16px_60px_rgba(0,0,0,0.22)]"
            >
              <div className="flex items-start justify-between gap-4">
                <time className="whitespace-nowrap font-mono text-xs text-muted-foreground">
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
                  >
                    <Badge variant={entry.tradeExecution.direction === "BUY" ? "success" : "destructive"}>
                      {entry.tradeExecution.direction === "BUY" ? "↗" : "↘"}{" "}
                      {entry.tradeExecution.direction} Trade
                    </Badge>
                  </Link>
                )}
              </div>

              <p className="mt-4 whitespace-pre-wrap text-sm leading-6 text-card-foreground">
                {entry.entryText}
              </p>

              {(ethPrice != null ||
                conditions.rsi != null ||
                conditions.emaShort != null ||
                conditions.emaLong != null) && (
                <div className="mt-3 flex flex-wrap gap-3">
                  {ethPrice != null && (
                    <Badge variant="info">
                      ETH {formatUSD(ethPrice)}
                    </Badge>
                  )}
                  {conditions.rsi != null && (
                    <Badge variant="outline">
                      RSI {conditions.rsi.toFixed(1)}
                    </Badge>
                  )}
                  {conditions.emaShort != null && (
                    <Badge variant="warning">
                      EMA 12 {formatUSD(conditions.emaShort)}
                    </Badge>
                  )}
                  {conditions.emaLong != null && (
                    <Badge variant="warning">
                      EMA 26 {formatUSD(conditions.emaLong)}
                    </Badge>
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
