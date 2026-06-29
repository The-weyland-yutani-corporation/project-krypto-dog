export const dynamic = "force-dynamic";

import Link from "next/link";
import { db } from "@/db";
import { tradeExecution } from "@/db/schema";
import { desc, count } from "drizzle-orm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/krypto/empty-state";
import { PageHeader } from "@/components/krypto/page-header";

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
        <PageHeader
          eyebrow="Ledger"
          title="Trades"
          description="Paper trade executions, modeled fees, realised P&L, and model reasoning."
        />
        <EmptyState
          icon="💹"
          title="No trades yet"
          description="Trades will appear here once the paper agent starts executing."
        />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow="Ledger"
        title="Trades"
        description={`${totalCount} total paper trade${totalCount !== 1 ? "s" : ""} recorded by the agent.`}
      />

      <Card className="mt-6 overflow-hidden">
        <CardContent className="p-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
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
                  <TableHead
                    key={header}
                  >
                    {header}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {trades.map((trade) => (
                <TableRow key={trade.id}>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {new Date(trade.createdAt).toLocaleString("en-US", {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <Badge variant={trade.direction === "BUY" ? "success" : "destructive"}>
                      {trade.direction}
                    </Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap font-medium text-foreground">
                    {trade.asset}
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">
                    {formatUSD(trade.amountUSD)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">
                    {formatUSD(trade.executionPrice)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
                    {formatUSD(trade.feesUSD)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap font-medium tabular-nums">
                    {trade.pnlUSD != null ? (
                      <span
                        className={
                          trade.pnlUSD >= 0
                            ? "text-success"
                            : "text-destructive"
                        }
                      >
                        {trade.pnlUSD >= 0 ? "+" : ""}
                        {formatUSD(trade.pnlUSD)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="max-w-xs text-muted-foreground">
                    <details>
                      <summary className="cursor-pointer truncate max-w-[200px]">
                        {trade.agentReasoning.slice(0, 80)}
                        {trade.agentReasoning.length > 80 ? "…" : ""}
                      </summary>
                      <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-muted-foreground">
                        {trade.agentReasoning}
                      </p>
                    </details>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        </CardContent>
      </Card>

      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Page {page} of {totalPages}
          </p>
          <div className="flex gap-2">
            {page > 1 && (
              <Button asChild variant="secondary" size="sm">
                <Link href={`/admin/trades?page=${page - 1}`}>← Previous</Link>
              </Button>
            )}
            {page < totalPages && (
              <Button asChild variant="secondary" size="sm">
                <Link href={`/admin/trades?page=${page + 1}`}>Next →</Link>
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
