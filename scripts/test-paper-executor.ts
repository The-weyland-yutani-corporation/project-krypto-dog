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
import { TradeConflictError } from "../src/trading/errors";
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

  // --- Denial suite: missing AgentRun ---
  const missingRunTime = new Date(start.getTime() + 15 * 60 * 60 * 1000);
  // Set up a valid lease state but use a non-existent agentRunId
  await adminDb
    .update(agentState)
    .set({
      leaseOwner: "lease-missing",
      leaseExpiresAt: new Date(missingRunTime.getTime() + 60 * 60 * 1000),
      isRunning: true,
    })
    .where(eq(agentState.id, "singleton"));
  const beforeMissingRun = await stateSnapshot();
  await assert.rejects(
    firstExecutor({
      ...firstRequest,
      agentRunId: "executor-run-nonexistent",
      leaseOwner: "lease-missing",
      decision: {
        action: "BUY",
        notionalUSD: 10,
        reasoning: "missing agent run rejection",
      },
      market: {
        ...firstRequest.market,
        spotPriceUSD: 2000,
        observedAt: missingRunTime,
      },
      now: missingRunTime,
    }),
    TradeConflictError,
  );
  const afterMissingRun = await stateSnapshot();
  assert.equal(
    afterMissingRun.currentPositionETHDecimal,
    beforeMissingRun.currentPositionETHDecimal,
  );
  assert.equal(
    afterMissingRun.currentPositionUSDCDecimal,
    beforeMissingRun.currentPositionUSDCDecimal,
  );
  const missingRunTrades = await adminDb
    .select({ id: tradeExecution.id })
    .from(tradeExecution)
    .where(eq(tradeExecution.agentRunId, "executor-run-nonexistent"));
  assert.equal(missingRunTrades.length, 0);

  // --- Denial suite: expired lease (past) ---
  const expiredTime = new Date(start.getTime() + 18 * 60 * 60 * 1000);
  await adminDb.insert(agentRun).values({
    id: "executor-run-expired",
    idempotencyKey: "executor-run-expired-idempotency",
    triggerSource: "database-test",
    tradingMode: "PAPER",
    strategyVersion: DEFAULT_STRATEGY_CONFIG.version,
  });
  await adminDb
    .update(agentState)
    .set({
      leaseOwner: "lease-expired",
      leaseExpiresAt: new Date(expiredTime.getTime() - 1), // 1 ms in the past
      isRunning: true,
    })
    .where(eq(agentState.id, "singleton"));
  const beforeExpired = await stateSnapshot();
  await assert.rejects(
    firstExecutor({
      ...firstRequest,
      agentRunId: "executor-run-expired",
      leaseOwner: "lease-expired",
      decision: {
        action: "BUY",
        notionalUSD: 10,
        reasoning: "expired lease rejection",
      },
      market: {
        ...firstRequest.market,
        spotPriceUSD: 2000,
        observedAt: expiredTime,
      },
      now: expiredTime,
    }),
    TradeConflictError,
  );
  const afterExpired = await stateSnapshot();
  assert.equal(
    afterExpired.currentPositionETHDecimal,
    beforeExpired.currentPositionETHDecimal,
  );
  assert.equal(
    afterExpired.currentPositionUSDCDecimal,
    beforeExpired.currentPositionUSDCDecimal,
  );
  const expiredTrades = await adminDb
    .select({ id: tradeExecution.id })
    .from(tradeExecution)
    .where(eq(tradeExecution.agentRunId, "executor-run-expired"));
  assert.equal(expiredTrades.length, 0);

  // --- Denial suite: lease expired at exactly now (edge case) ---
  const exactNowTime = new Date(start.getTime() + 21 * 60 * 60 * 1000);
  await adminDb.insert(agentRun).values({
    id: "executor-run-exact-now",
    idempotencyKey: "executor-run-exact-now-idempotency",
    triggerSource: "database-test",
    tradingMode: "PAPER",
    strategyVersion: DEFAULT_STRATEGY_CONFIG.version,
  });
  await adminDb
    .update(agentState)
    .set({
      leaseOwner: "lease-exact-now",
      leaseExpiresAt: exactNowTime, // equals now exactly
      isRunning: true,
    })
    .where(eq(agentState.id, "singleton"));
  const beforeExactNow = await stateSnapshot();
  await assert.rejects(
    firstExecutor({
      ...firstRequest,
      agentRunId: "executor-run-exact-now",
      leaseOwner: "lease-exact-now",
      decision: {
        action: "BUY",
        notionalUSD: 10,
        reasoning: "exact-now lease rejection",
      },
      market: {
        ...firstRequest.market,
        spotPriceUSD: 2000,
        observedAt: exactNowTime,
      },
      now: exactNowTime,
    }),
    TradeConflictError,
  );
  const afterExactNow = await stateSnapshot();
  assert.equal(
    afterExactNow.currentPositionETHDecimal,
    beforeExactNow.currentPositionETHDecimal,
  );
  assert.equal(
    afterExactNow.currentPositionUSDCDecimal,
    beforeExactNow.currentPositionUSDCDecimal,
  );
  const exactNowTrades = await adminDb
    .select({ id: tradeExecution.id })
    .from(tradeExecution)
    .where(eq(tradeExecution.agentRunId, "executor-run-exact-now"));
  assert.equal(exactNowTrades.length, 0);

  console.log(
    "Paper executor tests passed for concurrency, idempotency, rollback, lease ownership, weighted accounting, partial sell, full exit, missing AgentRun denial, expired lease denial, and exact-now lease denial.",
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
