import postgres from "postgres";

import { canonicalSha256 } from "@/backtest/canonical";
import {
  DEFAULT_LEDGER_ATTESTATION_MAX_TRADES,
  attestLedger,
  type LedgerAttestationIncident,
  type LedgerAttestationJournal,
  type LedgerAttestationPurpose,
  type LedgerAttestationReport,
  type LedgerAttestationRun,
  type LedgerAttestationState,
  type LedgerAttestationTrade,
} from "@/trading/ledger-attestation";

export interface RunLedgerAttestationOptions {
  databaseUrl: string;
  releaseSha: string;
  imageDigest: string;
  configVersion: string;
  purpose: LedgerAttestationPurpose;
  asOf: Date;
  runtimeRole?: string;
  maxTrades?: number;
}

type RawTrade = Omit<
  LedgerAttestationTrade,
  "run" | "journals" | "incidents" | "legacy"
> & {
  legacyAmountUSD: string;
  legacyAmountAsset: string;
  legacyExecutionPrice: string;
  legacyFeesUSD: string;
  legacyPnlUSD: string | null;
};

function validateBinding(options: RunLedgerAttestationOptions): void {
  if (!/^[0-9a-f]{40}$/.test(options.releaseSha)) {
    throw new Error("Ledger attestation release SHA is invalid");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(options.imageDigest)) {
    throw new Error("Ledger attestation image digest is invalid");
  }
  if (
    !options.configVersion ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.configVersion)
  ) {
    throw new Error("Ledger attestation config version is invalid");
  }
  if (!(options.asOf instanceof Date) || Number.isNaN(options.asOf.getTime())) {
    throw new Error("Ledger attestation time is invalid");
  }
  if (
    options.runtimeRole !== undefined &&
    !/^[a-z_][a-z0-9_]{0,62}$/.test(options.runtimeRole)
  ) {
    throw new Error("Ledger attestation runtime role is invalid");
  }
}

/**
 * Reads one repeatable snapshot under a PostgreSQL READ ONLY transaction.
 * There is deliberately no write-capable callback or fallback query path.
 */
export async function runLedgerAttestation(
  options: RunLedgerAttestationOptions,
): Promise<LedgerAttestationReport> {
  validateBinding(options);
  const maximumTrades =
    options.maxTrades ?? DEFAULT_LEDGER_ATTESTATION_MAX_TRADES;
  const sql = postgres(options.databaseUrl, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
  });
  try {
    await sql`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`;
    await sql`SET LOCAL statement_timeout = '15s'`;
    await sql`SET LOCAL lock_timeout = '2s'`;
    await sql`SET LOCAL TIME ZONE 'UTC'`;

    const [identity] = await sql<
      Array<{
        databaseName: string;
        serverAddress: string;
        serverPort: number;
        transactionReadOnly: string;
        runtimeRolePresent: boolean;
      }>
    >`
      SELECT
        current_database() AS "databaseName",
        COALESCE(inet_server_addr()::text, 'local-socket') AS "serverAddress",
        current_setting('port')::int AS "serverPort",
        current_setting('transaction_read_only') AS "transactionReadOnly",
        to_regrole(${options.runtimeRole ?? "krypto_runtime"}) IS NOT NULL
          AS "runtimeRolePresent"
    `;
    if (
      !identity ||
      identity.transactionReadOnly !== "on" ||
      !identity.runtimeRolePresent
    ) {
      throw new Error(
        "Ledger attestation could not prove its read-only transaction and runtime role binding",
      );
    }

    const [state] = await sql<Array<LedgerAttestationState>>`
      SELECT
        "initialCapitalUSD"::text AS "initialCapitalUSD",
        "lastTradePriceDecimal"::text AS "lastTradePriceDecimal",
        "currentPositionETHDecimal"::text AS "currentPositionETHDecimal",
        "currentPositionUSDCDecimal"::text AS "currentPositionUSDCDecimal",
        "portfolioValueUSDDecimal"::text AS "portfolioValueUSDDecimal",
        "weightedCostBasisUSD"::text AS "weightedCostBasisUSD",
        "referencePriceUSD"::text AS "referencePriceUSD",
        "referencePriceAnchor",
        "lastBuyPriceUSD"::text AS "lastBuyPriceUSD",
        "lastBuyPriceAnchor",
        "dcaCount",
        "peakPortfolioValueUSD"::text AS "peakPortfolioValueUSD",
        "peakPortfolioValueAnchor",
        "portfolioValueObservation",
        "accountingStatus"::text AS "accountingStatus",
        "strategyVersion",
        jsonb_build_object(
          'lastTradePrice',
          CASE WHEN "lastTradePrice" IS NULL THEN NULL
            ELSE round("lastTradePrice"::numeric, 8)::numeric(20,8)::text END,
          'currentPositionETH',
          round("currentPositionETH"::numeric, 18)::numeric(28,18)::text,
          'currentPositionUSDC',
          round("currentPositionUSDC"::numeric, 8)::numeric(20,8)::text,
          'portfolioValueUSD',
          round("portfolioValueUSD"::numeric, 8)::numeric(20,8)::text
        ) AS legacy
      FROM "krypto"."AgentState"
      WHERE id = 'singleton'
      LIMIT 1
    `;

    const trades = await sql<RawTrade[]>`
      SELECT
        id,
        to_char(
          "createdAt",
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) AS "createdAt",
        direction::text AS direction,
        asset,
        pair,
        "agentRunId",
        "requestedNotionalUSD"::text AS "requestedNotionalUSD",
        "observedMarketPriceUSD"::text AS "observedMarketPriceUSD",
        "modeledExecutionPriceUSD"::text AS "modeledExecutionPriceUSD",
        "quantityAssetDecimal"::text AS "quantityAssetDecimal",
        "feeRateBps",
        "feesUSDDecimal"::text AS "feesUSDDecimal",
        "slippageBps",
        "slippageUSD"::text AS "slippageUSD",
        "ethBalanceBefore"::text AS "ethBalanceBefore",
        "ethBalanceAfter"::text AS "ethBalanceAfter",
        "usdcBalanceBefore"::text AS "usdcBalanceBefore",
        "usdcBalanceAfter"::text AS "usdcBalanceAfter",
        "costBasisBeforeUSD"::text AS "costBasisBeforeUSD",
        "costBasisAfterUSD"::text AS "costBasisAfterUSD",
        "realizedPnlUSDDecimal"::text AS "realizedPnlUSDDecimal",
        "strategyVersion",
        "signalSnapshot",
        round("amountUSD"::numeric, 8)::numeric(20,8)::text
          AS "legacyAmountUSD",
        round("amountAsset"::numeric, 18)::numeric(28,18)::text
          AS "legacyAmountAsset",
        round("executionPrice"::numeric, 8)::numeric(20,8)::text
          AS "legacyExecutionPrice",
        round("feesUSD"::numeric, 8)::numeric(20,8)::text
          AS "legacyFeesUSD",
        CASE WHEN "pnlUSD" IS NULL THEN NULL
          ELSE round("pnlUSD"::numeric, 8)::numeric(20,8)::text END
          AS "legacyPnlUSD"
      FROM "krypto"."TradeExecution"
      ORDER BY "createdAt", id
      LIMIT ${maximumTrades + 1}
    `;

    const tradeIds = trades.map((trade) => trade.id);
    const agentRunIds = trades
      .map((trade) => trade.agentRunId)
      .filter((value): value is string => value !== null);
    const runs =
      agentRunIds.length === 0
        ? []
        : await sql<LedgerAttestationRun[]>`
            SELECT
              id,
              "requestId",
              "releaseId",
              "deploymentId",
              "providerAttemptId",
              "tradingMode"::text AS "tradingMode",
              outcome::text AS outcome,
              "strategyVersion",
              CASE WHEN "completedAt" IS NULL THEN NULL ELSE to_char(
                "completedAt" AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              ) END AS "completedAt"
            FROM "krypto"."AgentRun"
            WHERE id = ANY(${agentRunIds})
          `;
    const journals =
      tradeIds.length === 0
        ? []
        : await sql<LedgerAttestationJournal[]>`
            SELECT id, "agentRunId", "tradeExecutionId", "marketConditions"
            FROM "krypto"."AgentJournal"
            WHERE "tradeExecutionId" = ANY(${tradeIds})
          `;
    const incidents =
      tradeIds.length === 0
        ? []
        : await sql<LedgerAttestationIncident[]>`
            SELECT
              "incidentId",
              "eventKind"::text AS "eventKind",
              "incidentType"::text AS "incidentType",
              "requestId",
              "agentRunId",
              "releaseId",
              "deploymentId",
              "providerAttemptId",
              "transactionId"
            FROM "krypto"."SafetyIncidentOutbox"
            WHERE "transactionId" = ANY(${tradeIds})
          `;
    const runsById = new Map(runs.map((run) => [run.id, run]));

    return attestLedger({
      binding: {
        releaseSha: options.releaseSha,
        imageDigest: options.imageDigest,
        configVersion: options.configVersion,
        databaseIdentityHash: `sha256:${canonicalSha256({
          databaseName: identity.databaseName,
          serverAddress: identity.serverAddress,
          serverPort: identity.serverPort,
        })}`,
        runtimeRole: options.runtimeRole ?? "krypto_runtime",
        purpose: options.purpose,
        asOf: options.asOf.toISOString(),
      },
      state: state ?? null,
      trades: trades.map((trade) => ({
        id: trade.id,
        createdAt: trade.createdAt,
        direction: trade.direction,
        asset: trade.asset,
        pair: trade.pair,
        agentRunId: trade.agentRunId,
        requestedNotionalUSD: trade.requestedNotionalUSD,
        observedMarketPriceUSD: trade.observedMarketPriceUSD,
        modeledExecutionPriceUSD: trade.modeledExecutionPriceUSD,
        quantityAssetDecimal: trade.quantityAssetDecimal,
        feeRateBps: trade.feeRateBps,
        feesUSDDecimal: trade.feesUSDDecimal,
        slippageBps: trade.slippageBps,
        slippageUSD: trade.slippageUSD,
        ethBalanceBefore: trade.ethBalanceBefore,
        ethBalanceAfter: trade.ethBalanceAfter,
        usdcBalanceBefore: trade.usdcBalanceBefore,
        usdcBalanceAfter: trade.usdcBalanceAfter,
        costBasisBeforeUSD: trade.costBasisBeforeUSD,
        costBasisAfterUSD: trade.costBasisAfterUSD,
        realizedPnlUSDDecimal: trade.realizedPnlUSDDecimal,
        strategyVersion: trade.strategyVersion,
        signalSnapshot: trade.signalSnapshot,
        legacy: {
          amountUSD: trade.legacyAmountUSD,
          amountAsset: trade.legacyAmountAsset,
          executionPrice: trade.legacyExecutionPrice,
          feesUSD: trade.legacyFeesUSD,
          pnlUSD: trade.legacyPnlUSD,
        },
        run: trade.agentRunId
          ? (runsById.get(trade.agentRunId) ?? null)
          : null,
        journals: journals.filter(
          (journal) => journal.tradeExecutionId === trade.id,
        ),
        incidents: incidents.filter(
          (incident) => incident.transactionId === trade.id,
        ),
      })),
      maxTrades: maximumTrades,
    });
  } finally {
    try {
      await sql`ROLLBACK`;
    } finally {
      await sql.end({ timeout: 5 });
    }
  }
}
