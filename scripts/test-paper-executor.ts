import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "../src/db/schema";
import {
  agentRun,
  agentState,
  tradeExecution,
} from "../src/db/schema";
import { createPaperExecutor } from "../src/trading/paper-executor";
import { DEFAULT_STRATEGY_CONFIG } from "../src/trading/strategy-config";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for paper executor tests`);
  }
  return value;
}

const url = requireEnv("DATABASE_URL");

function client() {
  return postgres(url, { max: 1, prepare: false });
}

const adminClient = client();
const firstClient = client();
const secondClient = client();
const adminDb = drizzle(adminClient, { schema });
const firstExecutor = createPaperExecutor(
  drizzle(firstClient, { schema }),
);
const secondExecutor = createPaperExecutor(
  drizzle(secondClient, { schema }),
);

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100_000_000) / 100_000_000;
}

async function prepareRun(
  id: string,
  owner: string,
  now: Date,
): Promise<void> {
  await adminDb.insert(agentRun).values({
    id,
    idempotencyKey: `${id}-idempotency`,
    triggerSource: "database-test",
    tradingMode: "PAPER",
    strategyVersion: DEFAULT_STRATEGY_CONFIG.version,
  });
  await adminDb
    .update(agentState)
    .set({
      leaseOwner: owner,
      leaseExpiresAt: new Date(now.getTime() + 60 * 60 * 1000),
      isRunning: true,
    })
    .where(eq(agentState.id, "singleton"));
}

async function stateSnapshot() {
  const [state] = await adminDb
    .select()
    .from(agentState)
    .where(eq(agentState.id, "singleton"));
  assert(state);
  return state;
}

async function main() {
  const start = new Date();
  await adminDb
    .update(agentState)
    .set({
      referencePriceUSD: "2000.00000000",
      strategyVersion: DEFAULT_STRATEGY_CONFIG.version,
      strategySnapshot: DEFAULT_STRATEGY_CONFIG,
      accountingStatus: "RECONCILED",
    })
    .where(eq(agentState.id, "singleton"));

  await prepareRun("executor-run-1", "lease-1", start);
  const firstRequest = {
    agentRunId: "executor-run-1",
    leaseOwner: "lease-1",
    decision: {
      action: "BUY" as const,
      notionalUSD: 25,
      reasoning: "database concurrency test",
    },
    market: {
      spotPriceUSD: 1900,
      observedAt: start,
      rsi: 30,
      emaShort: 1950,
      emaLong: 2000,
    },
    strategy: DEFAULT_STRATEGY_CONFIG,
    now: start,
  };

  const concurrent = await Promise.all([
    firstExecutor(firstRequest),
    secondExecutor(firstRequest),
  ]);
  assert.deepEqual(
    concurrent.map((result) => result.status).sort(),
    ["executed", "idempotent"],
  );

  const [firstTradeCount] = await adminDb
    .select({ id: tradeExecution.id })
    .from(tradeExecution)
    .where(eq(tradeExecution.agentRunId, "executor-run-1"));
  assert(firstTradeCount);

  const rollbackTime = new Date(start.getTime() + 3 * 60 * 60 * 1000);
  await prepareRun("executor-run-2", "lease-2", rollbackTime);
  const beforeRollback = await stateSnapshot();
  await assert.rejects(
    firstExecutor({
      ...firstRequest,
      agentRunId: "executor-run-2",
      leaseOwner: "lease-2",
      decision: {
        action: "BUY",
        notionalUSD: 20,
        reasoning: "rollback test",
      },
      market: {
        ...firstRequest.market,
        spotPriceUSD: 1800,
        observedAt: rollbackTime,
      },
      now: rollbackTime,
      hooks: {
        afterTradeInsert: () => {
          throw new Error("injected post-insert failure");
        },
      },
    }),
    /injected post-insert failure/,
  );

  const afterRollback = await stateSnapshot();
  assert.equal(
    afterRollback.currentPositionETHDecimal,
    beforeRollback.currentPositionETHDecimal,
  );
  assert.equal(
    afterRollback.currentPositionUSDCDecimal,
    beforeRollback.currentPositionUSDCDecimal,
  );
  const rolledBackTrades = await adminDb
    .select({ id: tradeExecution.id })
    .from(tradeExecution)
    .where(eq(tradeExecution.agentRunId, "executor-run-2"));
  assert.equal(rolledBackTrades.length, 0);

  await secondExecutor({
    ...firstRequest,
    agentRunId: "executor-run-2",
    leaseOwner: "lease-2",
    decision: {
      action: "BUY",
      notionalUSD: 20,
      reasoning: "second DCA entry",
    },
    market: {
      ...firstRequest.market,
      spotPriceUSD: 1800,
      observedAt: rollbackTime,
    },
    now: rollbackTime,
  });

  const partialTime = new Date(start.getTime() + 6 * 60 * 60 * 1000);
  await prepareRun("executor-run-3", "lease-3", partialTime);
  const partial = await firstExecutor({
    ...firstRequest,
    agentRunId: "executor-run-3",
    leaseOwner: "lease-3",
    decision: {
      action: "SELL",
      notionalUSD: 10,
      reasoning: "partial take profit",
    },
    market: {
      ...firstRequest.market,
      spotPriceUSD: 2100,
      observedAt: partialTime,
    },
    now: partialTime,
  });
  assert.equal(partial.direction, "SELL");
  assert.notEqual(partial.accountAfter.weightedCostBasisUSD, null);
  assert.equal(partial.accountAfter.dcaCount, 2);

  const fullExitTime = new Date(start.getTime() + 9 * 60 * 60 * 1000);
  await prepareRun("executor-run-4", "lease-4", fullExitTime);
  const beforeExit = await stateSnapshot();
  const fullExitNotional = roundMoney(
    Number(beforeExit.currentPositionETHDecimal) * 2200,
  );
  const fullExit = await secondExecutor({
    ...firstRequest,
    agentRunId: "executor-run-4",
    leaseOwner: "lease-4",
    decision: {
      action: "SELL",
      notionalUSD: fullExitNotional,
      reasoning: "full take-profit exit",
    },
    market: {
      ...firstRequest.market,
      spotPriceUSD: 2200,
      observedAt: fullExitTime,
    },
    now: fullExitTime,
  });

  assert.equal(fullExit.accountAfter.ethBalance, "0.000000000000000000");
  assert.equal(fullExit.accountAfter.weightedCostBasisUSD, null);
  assert.equal(fullExit.accountAfter.dcaCount, 0);

  const ownershipTime = new Date(start.getTime() + 12 * 60 * 60 * 1000);
  await prepareRun("executor-run-5", "lease-5", ownershipTime);
  await assert.rejects(
    firstExecutor({
      ...firstRequest,
      agentRunId: "executor-run-5",
      leaseOwner: "not-lease-5",
      decision: {
        action: "BUY",
        notionalUSD: 20,
        reasoning: "lease ownership rejection",
      },
      market: {
        ...firstRequest.market,
        spotPriceUSD: 1900,
        observedAt: ownershipTime,
      },
      now: ownershipTime,
    }),
    /lease/i,
  );
  const ownerMismatchTrades = await adminDb
    .select({ id: tradeExecution.id })
    .from(tradeExecution)
    .where(eq(tradeExecution.agentRunId, "executor-run-5"));
  assert.equal(ownerMismatchTrades.length, 0);

  const allTrades = await adminDb.select().from(tradeExecution);
  assert.equal(allTrades.length, 4);
  assert.equal(
    new Set(allTrades.map((trade) => trade.agentRunId)).size,
    allTrades.length,
  );

  // ── Denial suite: unique agentRunId DB constraint backstop ──────────────────

  // AC-1: Direct SQL duplicate insert raises unique_violation (23505).
  await adminClient`
    INSERT INTO krypto."AgentRun" (id, "idempotencyKey", "triggerSource", "tradingMode", "strategyVersion")
    VALUES ('backstop-run-1', 'backstop-run-1-idem', 'database-test', 'PAPER', ${DEFAULT_STRATEGY_CONFIG.version})
  `;
  await adminClient`
    INSERT INTO krypto."TradeExecution"
      (id, direction, asset, "amountUSD", "amountAsset", "executionPrice", "feesUSD", slippage,
       "agentReasoning", "agentRunId", "strategyVersion", "signalSnapshot")
    VALUES (
      'backstop-trade-1', 'BUY', 'ETH', 10, 0.005, 2000, 0, 0,
      'backstop direct insert', 'backstop-run-1', ${DEFAULT_STRATEGY_CONFIG.version}, '{}'::jsonb
    )
  `;
  {
    let caught: unknown;
    try {
      await adminClient`
        INSERT INTO krypto."TradeExecution"
          (id, direction, asset, "amountUSD", "amountAsset", "executionPrice", "feesUSD", slippage,
           "agentReasoning", "agentRunId", "strategyVersion", "signalSnapshot")
        VALUES (
          'backstop-trade-1-dup', 'BUY', 'ETH', 10, 0.005, 2000, 0, 0,
          'backstop duplicate insert', 'backstop-run-1', ${DEFAULT_STRATEGY_CONFIG.version}, '{}'::jsonb
        )
      `;
    } catch (err) {
      caught = err;
    }
    assert(caught instanceof Error, "Expected an error for duplicate agentRunId");
    assert(
      (caught as { code?: string }).code === "23505",
      `Expected unique_violation (23505) but got: ${(caught as { code?: string }).code}`,
    );
  }

  // AC-2: When a transaction tries to double-insert a tradeExecution row with
  // the same agentRunId (simulating the executor defeating its in-app guard),
  // the DB constraint fires and the transaction rolls back cleanly.
  //
  // We use adminDb.transaction to model the executor's transactional context
  // and inject a second INSERT for the same agentRunId inside that transaction.
  await adminClient`
    INSERT INTO krypto."AgentRun" (id, "idempotencyKey", "triggerSource", "tradingMode", "strategyVersion")
    VALUES ('backstop-run-2', 'backstop-run-2-idem', 'database-test', 'PAPER', ${DEFAULT_STRATEGY_CONFIG.version})
  `;
  const beforeBackstop = await stateSnapshot();

  {
    let caught: unknown;
    try {
      await adminDb.transaction(async (tx) => {
        // First insert — succeeds within the transaction.
        await tx.insert(tradeExecution).values({
          id: "backstop-trade-2a",
          direction: "BUY",
          asset: "ETH",
          amountUSD: 15,
          amountAsset: 0.0077,
          executionPrice: 1950,
          feesUSD: 0,
          slippage: 0,
          agentReasoning: "backstop executor double-insert test",
          agentRunId: "backstop-run-2",
          strategyVersion: DEFAULT_STRATEGY_CONFIG.version,
          signalSnapshot: {},
        });
        // Second insert with same agentRunId — must raise 23505 and roll back.
        await tx.insert(tradeExecution).values({
          id: "backstop-trade-2b",
          direction: "BUY",
          asset: "ETH",
          amountUSD: 15,
          amountAsset: 0.0077,
          executionPrice: 1950,
          feesUSD: 0,
          slippage: 0,
          agentReasoning: "backstop executor double-insert duplicate",
          agentRunId: "backstop-run-2",
          strategyVersion: DEFAULT_STRATEGY_CONFIG.version,
          signalSnapshot: {},
        });
      });
    } catch (err) {
      caught = err;
    }
    assert(caught instanceof Error, "Expected an error for duplicate agentRunId within a transaction");
    assert(
      (caught as { code?: string }).code === "23505" ||
        /unique/i.test((caught as Error).message),
      `Expected unique_violation (23505) but got: code=${(caught as { code?: string }).code} msg=${(caught as Error).message}`,
    );
  }

  // Verify the transaction rolled back — no tradeExecution rows for backstop-run-2.
  const backstopTrades = await adminDb
    .select({ id: tradeExecution.id })
    .from(tradeExecution)
    .where(eq(tradeExecution.agentRunId, "backstop-run-2"));
  assert.equal(
    backstopTrades.length,
    0,
    "No tradeExecution row should persist after the backstop constraint rollback",
  );
  // Portfolio state must be unchanged.
  const afterBackstop = await stateSnapshot();
  assert.equal(
    afterBackstop.currentPositionETHDecimal,
    beforeBackstop.currentPositionETHDecimal,
    "ETH position must be unchanged after backstop constraint rollback",
  );
  assert.equal(
    afterBackstop.currentPositionUSDCDecimal,
    beforeBackstop.currentPositionUSDCDecimal,
    "USDC position must be unchanged after backstop constraint rollback",
  );

  console.log(
    "Paper executor tests passed for concurrency, idempotency, rollback, lease ownership, weighted accounting, partial sell, full exit, and agentRunId DB constraint backstop (denial suite).",
  );
}

main()
  .finally(async () => {
    await Promise.all([
      adminClient.end(),
      firstClient.end(),
      secondClient.end(),
    ]);
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
