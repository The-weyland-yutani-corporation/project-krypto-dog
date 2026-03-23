import { TRADES, JOURNALS, FINAL_AGENT_STATE } from "../prisma/seed.ts";
import * as fs from "fs";

function hoursAgo(h: number): Date {
  return new Date(Date.now() - h * 60 * 60 * 1000);
}

function esc(s: string): string {
  return s.replace(/'/g, "''");
}

let sql = "";

// Clear existing data
sql += 'DELETE FROM "AgentJournal";\n';
sql += 'DELETE FROM "TradeExecution";\n';
sql += 'DELETE FROM "AgentState";\n\n';

// AgentState singleton
sql += `INSERT INTO "AgentState" ("id", "lastTradePrice", "currentPositionETH", "currentPositionUSDC", "portfolioValueUSD", "isLocked", "isRunning", "lastRunAt", "updatedAt") VALUES ('singleton', NULL, 0, 200, 200, false, false, NULL, NOW());\n\n`;

// Trades
TRADES.forEach((t, i) => {
  const ts = hoursAgo(t.hoursAgo).toISOString();
  sql += `INSERT INTO "TradeExecution" ("id", "direction", "asset", "amountUSD", "amountAsset", "executionPrice", "feesUSD", "slippage", "pnlUSD", "agentReasoning", "createdAt") VALUES ('seed-trade-${i}', '${t.direction}', '${t.asset}', ${t.amountUSD}, ${t.amountAsset}, ${t.executionPrice}, ${t.feesUSD}, ${t.slippage}, ${t.pnlUSD === null ? "NULL" : t.pnlUSD}, '${esc(t.agentReasoning)}', '${ts}');\n`;
});

sql += "\n";

// Journals
JOURNALS.forEach((j, i) => {
  const ts = hoursAgo(j.hoursAgo).toISOString();
  const tradeId =
    j.tradeIndex !== null ? `'seed-trade-${j.tradeIndex}'` : "NULL";
  const mc = JSON.stringify({
    ethPrice: j.ethPrice,
    rsi: j.rsi,
    emaShort: j.emaShort,
    emaLong: j.emaLong,
    emaCrossover: j.emaCrossover,
    timestamp: ts,
  });
  sql += `INSERT INTO "AgentJournal" ("id", "entryText", "marketConditions", "tradeExecutionId", "createdAt") VALUES ('seed-journal-${i}', '${esc(j.entryText)}', '${esc(mc)}', ${tradeId}, '${ts}');\n`;
});

// Update to final state
sql += `\nUPDATE "AgentState" SET "lastTradePrice" = ${FINAL_AGENT_STATE.lastTradePrice}, "currentPositionETH" = ${FINAL_AGENT_STATE.currentPositionETH}, "currentPositionUSDC" = ${FINAL_AGENT_STATE.currentPositionUSDC}, "portfolioValueUSD" = ${FINAL_AGENT_STATE.portfolioValueUSD}, "lastRunAt" = '${hoursAgo(3).toISOString()}', "updatedAt" = NOW() WHERE "id" = 'singleton';\n`;

fs.writeFileSync("supabase/migrations/20260322000001_seed_data.sql", sql);
console.log(`Generated seed SQL (${sql.split("\n").length} lines)`);
