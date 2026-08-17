import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { executeAgentRun } from "../src/agent/run-flow";
import { closeDatabase, db } from "../src/db";
import {
  agentJournal,
  agentRun,
  agentState,
  safetyIncidentOutbox,
  tradeExecution,
} from "../src/db/schema";
import {
  createFixtureMarketDataProvider,
  MarketDataError,
  setMarketDataProvider,
  type MarketDataProvider,
} from "../src/lib/market-data-provider";
import { executePaperTrade } from "../src/trading/paper-executor";
import { RequiredRolloutModeError } from "../src/trading/errors";
import { DEFAULT_STRATEGY_CONFIG } from "../src/trading/strategy-config";

const ACCOUNT_ID = "singleton";

async function resetAccount(): Promise<void> {
  // This harness runs only against the disposable PostgreSQL scratch database
  // created by test-migrations.sh. Production/runtime roles have no TRUNCATE
  // privilege and the product exposes no evidence-reset operation.
  await db.execute(sql`
    TRUNCATE TABLE
      "krypto"."SafetyIncidentOutbox",
      "krypto"."AgentJournal",
      "krypto"."TradeExecution",
      "krypto"."AgentRun"
  `);
  await db
    .update(agentState)
    .set({
      lastTradePrice: null,
      currentPositionETH: 0,
      currentPositionUSDC: 200,
      portfolioValueUSD: 200,
      isLocked: false,
      isOperatorPaused: false,
      isRunning: false,
      lastRunAt: null,
      initialCapitalUSD: "200.00000000",
      lastTradePriceDecimal: null,
      currentPositionETHDecimal: "0.000000000000000000",
      currentPositionUSDCDecimal: "200.00000000",
      portfolioValueUSDDecimal: "200.00000000",
      weightedCostBasisUSD: null,
      referencePriceUSD: null,
      lastBuyPriceUSD: null,
      dcaCount: 0,
      peakPortfolioValueUSD: "200.00000000",
      drawdownPct: "0.00000000",
      strategyVersion: DEFAULT_STRATEGY_CONFIG.version,
      strategySnapshot: DEFAULT_STRATEGY_CONFIG,
      accountingStatus: "RECONCILED",
      accountingIssue: null,
      lockReason: null,
      lockedAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastCompletedRunAt: null,
    })
    .where(eq(agentState.id, ACCOUNT_ID));
}

async function loadRun(idempotencyKey: string) {
  const [run] = await db
    .select()
    .from(agentRun)
    .where(eq(agentRun.idempotencyKey, idempotencyKey))
    .limit(1);
  assert(run);
  return run;
}

async function loadState() {
  const [state] = await db
    .select()
    .from(agentState)
    .where(eq(agentState.id, ACCOUNT_ID))
    .limit(1);
  assert(state);
  return state;
}

async function createOpenPosition(now: Date): Promise<void> {
  const databaseStartedAt = new Date();
  const databaseDeadlineAt = new Date(
    databaseStartedAt.getTime() + 180_000,
  );
  await db
    .update(agentState)
    .set({
      referencePriceUSD: "2000.00000000",
      leaseOwner: "setup-buy-owner",
      leaseExpiresAt: new Date(now.getTime() + 60_000),
      isRunning: true,
    })
    .where(eq(agentState.id, ACCOUNT_ID));
  await db.insert(agentRun).values({
    id: "setup-buy-run",
    idempotencyKey: "setup-buy-idempotency",
    requestId: "setup-buy-request",
    releaseId: "database-test-release",
    deploymentId: "database-test-deployment",
    triggerSource: "database-test",
    tradingMode: "PAPER",
    strategyVersion: DEFAULT_STRATEGY_CONFIG.version,
    startedAt: databaseStartedAt,
    deadlineAt: databaseDeadlineAt,
  });

  await executePaperTrade({
    agentRunId: "setup-buy-run",
    leaseOwner: "setup-buy-owner",
    decision: {
      action: "BUY",
      notionalUSD: 25,
      reasoning: "create a reconciled open position",
    },
    market: {
      spotPriceUSD: 1900,
      observedAt: now,
      rsi: 30,
      emaShort: 1950,
      emaLong: 2000,
    },
    strategy: DEFAULT_STRATEGY_CONFIG,
    now,
    nowFn: () => now,
    deadlineAt: databaseDeadlineAt,
  });

  await db
    .update(agentState)
    .set({
      leaseOwner: null,
      leaseExpiresAt: null,
      isRunning: false,
    })
    .where(eq(agentState.id, ACCOUNT_ID));
}

async function main(): Promise<void> {
  delete process.env.POSTHOG_API_KEY;
  delete process.env.AZURE_OPENAI_BASE_URL;
  delete process.env.AZURE_OPENAI_DEPLOYMENT_NAME;
  delete process.env.AZURE_CLIENT_ID;

  await resetAccount();
  process.env.ROLLOUT_MODE = "paper";
  await assert.rejects(
    executeAgentRun({
      triggerSource: "admin",
      idempotencyKey: "run-flow-required-disabled",
      requiredMode: "disabled",
    }),
    RequiredRolloutModeError,
  );
  assert.equal(
    (
      await db
        .select()
        .from(agentRun)
        .where(
          eq(
            agentRun.idempotencyKey,
            "run-flow-required-disabled",
          ),
        )
    ).length,
    0,
  );
  assert.equal((await loadState()).leaseOwner, null);

  await resetAccount();
  process.env.ROLLOUT_MODE = "disabled";
  const disabled = await executeAgentRun({
    triggerSource: "admin",
    idempotencyKey: "run-flow-disabled",
  });
  assert.equal(disabled.kind, "ok");
  if (disabled.kind !== "ok") throw new Error("disabled run failed");
  assert.equal(disabled.result.action, "disabled");
  assert.equal((await loadRun("run-flow-disabled")).outcome, "DISABLED");
  assert.equal((await loadState()).leaseOwner, null);

  const replay = await executeAgentRun({
    triggerSource: "admin",
    idempotencyKey: "run-flow-disabled",
  });
  assert.equal(replay.kind, "ok");
  assert.equal(
    (
      await db
        .select()
        .from(agentRun)
        .where(eq(agentRun.idempotencyKey, "run-flow-disabled"))
    ).length,
    1,
  );
  await db
    .update(agentRun)
    .set({
      outcome: "EXECUTED",
      errorType: "post-commit-persistence",
      errorMessage: "journal persistence failed after commit",
    })
    .where(eq(agentRun.idempotencyKey, "run-flow-disabled"));
  const postCommitReplay = await executeAgentRun({
    triggerSource: "admin",
    idempotencyKey: "run-flow-disabled",
  });
  assert.equal(postCommitReplay.kind, "upstream_error");
  if (postCommitReplay.kind !== "upstream_error") {
    throw new Error("post-commit replay lost its failure status");
  }
  assert.equal(postCommitReplay.httpStatus, 500);

  await resetAccount();
  process.env.ROLLOUT_MODE = "paper";
  const restoreColdProvider = setMarketDataProvider(
    createFixtureMarketDataProvider(Array(100).fill(2000)),
  );
  const coldStart = await executeAgentRun({
    triggerSource: "admin",
    idempotencyKey: "run-flow-cold-start",
  });
  restoreColdProvider();
  assert.equal(coldStart.kind, "ok");
  if (coldStart.kind !== "ok") throw new Error("cold-start run failed");
  assert.equal(coldStart.result.action, "hold");
  assert.equal((await loadState()).referencePriceUSD, "2000.00000000");
  assert.equal((await loadRun("run-flow-cold-start")).outcome, "HOLD");
  assert.equal((await db.select().from(tradeExecution)).length, 0);

  await resetAccount();
  await createOpenPosition(new Date(Date.now() - 3 * 60 * 60 * 1000));
  const incompleteReplay = await executeAgentRun({
    triggerSource: "admin",
    idempotencyKey: "setup-buy-idempotency",
  });
  assert.equal(incompleteReplay.kind, "upstream_error");
  assert.notEqual(
    (await loadState()).currentPositionETHDecimal,
    "0.000000000000000000",
    "replay must preserve the committed paper position",
  );
  assert.equal(
    (
      await db
        .select()
        .from(safetyIncidentOutbox)
        .where(eq(safetyIncidentOutbox.incidentType, "POST_COMMIT_FAILURE"))
    ).length,
    1,
    "restart replay must escalate an unconfirmed obligation to critical",
  );
  const restoreStopProvider = setMarketDataProvider(
    createFixtureMarketDataProvider(Array(100).fill(1500)),
  );
  const stopLoss = await executeAgentRun({
    triggerSource: "cron",
    idempotencyKey: "run-flow-stop-loss",
  });
  restoreStopProvider();
  assert.equal(stopLoss.kind, "ok");
  if (stopLoss.kind !== "ok") throw new Error("stop-loss run failed");
  assert.equal(stopLoss.result.status, "executed");
  assert.equal(stopLoss.result.trade?.direction, "SELL");
  assert.equal((await loadState()).currentPositionETHDecimal, "0.000000000000000000");
  assert.equal((await loadState()).dcaCount, 0);
  assert.equal((await db.select().from(tradeExecution)).length, 2);
  const [stopJournal] = await db
    .select()
    .from(agentJournal)
    .where(eq(agentJournal.agentRunId, stopLoss.result.runId!))
    .limit(1);
  assert(stopJournal);
  const stopJournalCorrelation = stopJournal.marketConditions as Record<
    string,
    unknown
  >;
  assert.equal(stopJournalCorrelation.requestId, stopLoss.result.requestId);
  assert.equal(stopJournalCorrelation.runId, stopLoss.result.runId);
  assert.equal(
    stopJournalCorrelation.providerAttemptId,
    stopLoss.result.providerAttemptId,
  );
  assert.equal(
    stopJournalCorrelation.transactionId,
    stopLoss.result.transactionId,
  );
  assert.equal(stopJournalCorrelation.incidentId, stopLoss.result.incidentId);

  await resetAccount();
  await createOpenPosition(new Date(Date.now() - 3 * 60 * 60 * 1000));
  const restoreJournalFailureProvider = setMarketDataProvider(
    createFixtureMarketDataProvider(Array(100).fill(1500)),
  );
  const journalFailure = await executeAgentRun({
    triggerSource: "cron",
    idempotencyKey: "run-flow-post-commit-journal-failure",
    hooks: {
      afterPaperCommitBeforeJournal: () => {
        throw new Error("injected journal persistence failure");
      },
    },
  });
  restoreJournalFailureProvider();
  assert.equal(journalFailure.kind, "upstream_error");
  assert.equal(
    (await loadRun("run-flow-post-commit-journal-failure")).errorType,
    "post-commit-persistence",
  );
  assert.equal(
    (await loadState()).currentPositionETHDecimal,
    "0.000000000000000000",
    "journal failure must not roll back or alter the committed paper state",
  );
  assert.equal(
    (
      await db
        .select()
        .from(safetyIncidentOutbox)
        .where(eq(safetyIncidentOutbox.incidentType, "POST_COMMIT_FAILURE"))
    ).length,
    1,
    "journal failure must leave a durable critical incident",
  );

  await resetAccount();
  await createOpenPosition(new Date(Date.now() - 3 * 60 * 60 * 1000));
  const restoreTelemetryFailureProvider = setMarketDataProvider(
    createFixtureMarketDataProvider(Array(100).fill(1500)),
  );
  const telemetryFailure = await executeAgentRun({
    triggerSource: "cron",
    idempotencyKey: "run-flow-post-commit-telemetry-failure",
    hooks: {
      beforeTelemetryFlush: () => {
        throw new Error("injected telemetry delivery failure");
      },
    },
  });
  restoreTelemetryFailureProvider();
  assert.equal(telemetryFailure.kind, "upstream_error");
  if (telemetryFailure.kind !== "upstream_error") {
    throw new Error("telemetry failure did not surface terminal evidence");
  }
  assert.equal(
    telemetryFailure.result.journalWritten,
    true,
    "telemetry failure must not falsify the already-persisted journal",
  );
  assert.equal(
    (await loadState()).currentPositionETHDecimal,
    "0.000000000000000000",
    "telemetry failure must not roll back or alter the committed paper state",
  );
  assert.equal(
    (
      await db
        .select()
        .from(safetyIncidentOutbox)
        .where(eq(safetyIncidentOutbox.incidentType, "TELEMETRY_FAILURE"))
    ).length,
    1,
    "telemetry failure must leave durable critical post-commit evidence",
  );

  await resetAccount();
  await createOpenPosition(new Date(Date.now() - 3 * 60 * 60 * 1000));
  process.env.ROLLOUT_MODE = "shadow";
  const restoreShadowProvider = setMarketDataProvider(
    createFixtureMarketDataProvider(Array(100).fill(1500)),
  );
  const shadow = await executeAgentRun({
    triggerSource: "cron",
    idempotencyKey: "run-flow-shadow-stop",
  });
  restoreShadowProvider();
  assert.equal(shadow.kind, "ok");
  if (shadow.kind !== "ok") throw new Error("shadow run failed");
  assert.equal(shadow.result.action, "shadow");
  assert.equal((await loadRun("run-flow-shadow-stop")).outcome, "SHADOW");
  assert.notEqual((await loadState()).currentPositionETHDecimal, "0.000000000000000000");
  assert.equal((await db.select().from(tradeExecution)).length, 1);

  await resetAccount();
  process.env.ROLLOUT_MODE = "disabled";
  await db
    .update(agentState)
    .set({
      leaseOwner: "another-run",
      leaseExpiresAt: new Date(Date.now() + 60_000),
      isRunning: true,
    })
    .where(eq(agentState.id, ACCOUNT_ID));
  const conflict = await executeAgentRun({
    triggerSource: "admin",
    idempotencyKey: "run-flow-conflict",
  });
  assert.equal(conflict.kind, "mutex");
  assert.equal((await loadRun("run-flow-conflict")).outcome, "CONFLICT");
  assert.equal((await loadState()).leaseOwner, "another-run");
  process.env.ROLLOUT_MODE = "disabled";
  await db
    .update(agentState)
    .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
    .where(eq(agentState.id, ACCOUNT_ID));
  const conflictRetry = await executeAgentRun({
    triggerSource: "admin",
    idempotencyKey: "run-flow-conflict",
  });
  assert.equal(conflictRetry.kind, "ok");
  assert.equal((await loadRun("run-flow-conflict")).outcome, "DISABLED");
  assert.equal(
    (
      await db
        .select()
        .from(agentRun)
        .where(eq(agentRun.idempotencyKey, "run-flow-conflict"))
    ).length,
    1,
  );
  assert.equal((await loadState()).leaseOwner, null);

  await resetAccount();
  process.env.ROLLOUT_MODE = "disabled";
  await db
    .update(agentState)
    .set({
      leaseOwner: "expired-run",
      leaseExpiresAt: new Date(Date.now() - 1_000),
      isRunning: true,
    })
    .where(eq(agentState.id, ACCOUNT_ID));
  const recovered = await executeAgentRun({
    triggerSource: "admin",
    idempotencyKey: "run-flow-expired-lease",
  });
  assert.equal(recovered.kind, "ok");
  assert.equal((await loadRun("run-flow-expired-lease")).outcome, "DISABLED");
  assert.equal((await loadState()).leaseOwner, null);

  await resetAccount();
  process.env.ROLLOUT_MODE = "disabled";
  const liveOwnerStartedAt = new Date(Date.now() - 181_000);
  await db.insert(agentRun).values({
    id: "live-owner-run",
    idempotencyKey: "run-flow-live-owner",
    requestId: "run-flow-live-owner-request",
    releaseId: "database-test-release",
    deploymentId: "database-test-deployment",
    triggerSource: "cron",
    tradingMode: "DISABLED",
    outcome: "RUNNING",
    strategyVersion: DEFAULT_STRATEGY_CONFIG.version,
    startedAt: liveOwnerStartedAt,
    deadlineAt: new Date(liveOwnerStartedAt.getTime() + 180_000),
  });
  await db
    .update(agentState)
    .set({
      leaseOwner: "live-owner-run",
      leaseExpiresAt: new Date(Date.now() + 60_000),
      isRunning: true,
    })
    .where(eq(agentState.id, ACCOUNT_ID));
  const liveOwnerReplay = await executeAgentRun({
    triggerSource: "cron",
    idempotencyKey: "run-flow-live-owner",
  });
  assert.equal(liveOwnerReplay.kind, "mutex");
  assert.equal((await loadRun("run-flow-live-owner")).outcome, "RUNNING");
  assert.equal((await loadState()).leaseOwner, "live-owner-run");

  await resetAccount();
  process.env.ROLLOUT_MODE = "disabled";
  const staleStartedAt = new Date();
  await db.insert(agentRun).values({
    id: "stale-running-run",
    idempotencyKey: "run-flow-stale-running",
    requestId: "run-flow-stale-running-request",
    releaseId: "database-test-release",
    deploymentId: "database-test-deployment",
    triggerSource: "cron",
    tradingMode: "DISABLED",
    outcome: "RUNNING",
    strategyVersion: DEFAULT_STRATEGY_CONFIG.version,
    startedAt: staleStartedAt,
    deadlineAt: new Date(staleStartedAt.getTime() + 180_000),
  });
  await db
    .update(agentState)
    .set({
      leaseOwner: "stale-running-run",
      leaseExpiresAt: new Date(Date.now() - 1_000),
      isRunning: true,
    })
    .where(eq(agentState.id, ACCOUNT_ID));
  const staleRunningRetry = await executeAgentRun({
    triggerSource: "cron",
    idempotencyKey: "run-flow-stale-running",
  });
  assert.equal(staleRunningRetry.kind, "ok");
  assert.equal((await loadRun("run-flow-stale-running")).outcome, "DISABLED");
  assert.equal((await loadState()).leaseOwner, null);

  await resetAccount();
  const expiredStartedAt = new Date(Date.now() - 181_000);
  await db.insert(agentRun).values({
    id: "expired-running-run",
    idempotencyKey: "run-flow-expired-running",
    requestId: "run-flow-expired-running-request",
    releaseId: "database-test-release",
    deploymentId: "database-test-deployment",
    triggerSource: "cron",
    tradingMode: "DISABLED",
    outcome: "RUNNING",
    strategyVersion: DEFAULT_STRATEGY_CONFIG.version,
    startedAt: expiredStartedAt,
    deadlineAt: new Date(expiredStartedAt.getTime() + 180_000),
  });
  await db
    .update(agentState)
    .set({
      leaseOwner: "expired-running-run",
      leaseExpiresAt: new Date(Date.now() - 1_000),
      isRunning: true,
    })
    .where(eq(agentState.id, ACCOUNT_ID));
  const expiredRunningRetry = await executeAgentRun({
    triggerSource: "cron",
    idempotencyKey: "run-flow-expired-running",
  });
  assert.equal(expiredRunningRetry.kind, "upstream_error");
  assert.equal((await loadState()).leaseOwner, null);
  assert.equal(
    (
      await db
        .select()
        .from(safetyIncidentOutbox)
        .where(
          eq(
            safetyIncidentOutbox.incidentType,
            "DEADLINE_BUDGET_EXHAUSTION",
          ),
        )
    ).length,
    1,
    "expired run recovery must atomically preserve a durable incident",
  );

  await resetAccount();
  process.env.ROLLOUT_MODE = "live";
  const badConfig = await executeAgentRun({
    triggerSource: "admin",
    idempotencyKey: "run-flow-bad-config",
  });
  assert.equal(badConfig.kind, "upstream_error");
  if (badConfig.kind !== "upstream_error") {
    throw new Error("invalid configuration was not surfaced");
  }
  assert.equal(badConfig.httpStatus, 500);
  const badConfigRun = await loadRun("run-flow-bad-config");
  assert.equal(badConfigRun.errorType, "configuration-error");
  assert.equal(badConfigRun.tradingMode, "DISABLED");
  assert.equal((await loadState()).leaseOwner, null);
  const badConfigReplay = await executeAgentRun({
    triggerSource: "admin",
    idempotencyKey: "run-flow-bad-config",
  });
  assert.equal(badConfigReplay.kind, "upstream_error");
  if (badConfigReplay.kind !== "upstream_error") {
    throw new Error("configuration replay did not preserve failure");
  }
  assert.equal(badConfigReplay.httpStatus, 500);

  await resetAccount();
  process.env.ROLLOUT_MODE = "paper";
  const failingProvider: MarketDataProvider = {
    async getEthSpotPrice() {
      throw new MarketDataError("fixture outage", "network", true);
    },
    async getEthFourHourCandles() {
      throw new MarketDataError("fixture outage", "network", true);
    },
    async getEthClosingPrices() {
      throw new MarketDataError("fixture outage", "network", true);
    },
  };
  const restoreFailingProvider = setMarketDataProvider(failingProvider);
  const marketFailure = await executeAgentRun({
    triggerSource: "cron",
    idempotencyKey: "run-flow-market-failure",
  });
  restoreFailingProvider();
  assert.equal(marketFailure.kind, "upstream_error");
  if (marketFailure.kind !== "upstream_error") {
    throw new Error("market failure was not surfaced");
  }
  assert.equal(marketFailure.httpStatus, 502);
  const marketFailureRun = await loadRun("run-flow-market-failure");
  assert.equal(marketFailureRun.outcome, "UPSTREAM_ERROR");
  assert.match(
    marketFailureRun.providerAttemptId ?? "",
    /^attempt-coinbase-1-/,
  );
  const [marketFailureIncident] = await db
    .select()
    .from(safetyIncidentOutbox)
    .where(eq(safetyIncidentOutbox.agentRunId, marketFailureRun.id))
    .limit(1);
  assert.equal(
    marketFailureIncident?.providerAttemptId,
    marketFailureRun.providerAttemptId,
  );
  assert.equal((await loadState()).leaseOwner, null);

  await resetAccount();
  process.env.ROLLOUT_MODE = "paper";
  await db
    .update(agentState)
    .set({ currentPositionUSDCDecimal: null })
    .where(eq(agentState.id, ACCOUNT_ID));
  const restoreAccountingProvider = setMarketDataProvider(
    createFixtureMarketDataProvider(Array(100).fill(2000)),
  );
  const accountingFailure = await executeAgentRun({
    triggerSource: "cron",
    idempotencyKey: "run-flow-accounting-quarantine",
  });
  restoreAccountingProvider();
  assert.equal(accountingFailure.kind, "upstream_error");
  assert.equal((await loadState()).accountingStatus, "QUARANTINED");
  assert.equal(
    (
      await db
        .select()
        .from(safetyIncidentOutbox)
        .where(
          eq(
            safetyIncidentOutbox.incidentType,
            "RECONCILIATION_QUARANTINE",
          ),
        )
    ).length,
    1,
    "typed accounting failures must atomically quarantine and persist evidence",
  );

  console.log(
    "Run-flow tests passed for disabled mode, terminal/stale/conflict idempotent replay, cold start, mandatory stop-loss, shadow mode, post-commit journal/telemetry durability, correlation, lease recovery, stable configuration errors, market failures, and accounting quarantine.",
  );
}

main()
  .finally(async () => {
    await closeDatabase();
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
