import { canonicalSha256 } from "@/backtest/canonical";
import {
  ETH_SCALE,
  USD_SCALE,
  applyAccountingTransition,
  applyBps,
  feeFromBps,
  formatDecimal,
  notionalForQuantity,
  parseDecimal,
  quantityForNotional,
  type DecimalAccount,
} from "./accounting";
import {
  ANCHOR_SOURCES,
  PAPER_ANCHOR_MAX_AGE_SECONDS,
  type PriceAnchorMetadata,
} from "./anchors";

export const LEDGER_ATTESTATION_SCHEMA_VERSION = "1.0.0";
export const DEFAULT_LEDGER_ATTESTATION_MAX_TRADES = 10_000;

export type LedgerAttestationPurpose =
  | "preflight"
  | "target-smoke"
  | "pre-paper";

export interface LedgerAttestationBinding {
  releaseSha: string;
  imageDigest: string;
  configVersion: string;
  databaseIdentityHash: string;
  runtimeRole: string;
  purpose: LedgerAttestationPurpose;
  asOf: string;
}

export interface LedgerAttestationState {
  initialCapitalUSD: string;
  lastTradePriceDecimal: string | null;
  currentPositionETHDecimal: string | null;
  currentPositionUSDCDecimal: string | null;
  portfolioValueUSDDecimal: string | null;
  weightedCostBasisUSD: string | null;
  referencePriceUSD: string | null;
  referencePriceAnchor: unknown;
  lastBuyPriceUSD: string | null;
  lastBuyPriceAnchor: unknown;
  dcaCount: number;
  peakPortfolioValueUSD: string | null;
  peakPortfolioValueAnchor: unknown;
  portfolioValueObservation: unknown;
  accountingStatus: string;
  strategyVersion: string;
  legacy: {
    lastTradePrice: string | null;
    currentPositionETH: string;
    currentPositionUSDC: string;
    portfolioValueUSD: string;
  };
}

export interface LedgerAttestationRun {
  id: string;
  requestId: string;
  releaseId: string;
  deploymentId: string;
  providerAttemptId: string | null;
  tradingMode: string;
  outcome: string;
  strategyVersion: string;
  completedAt: string | null;
}

export interface LedgerAttestationJournal {
  id: string;
  agentRunId: string | null;
  tradeExecutionId: string | null;
  marketConditions: unknown;
}

export interface LedgerAttestationIncident {
  incidentId: string;
  eventKind: string;
  incidentType: string;
  requestId: string;
  agentRunId: string | null;
  releaseId: string;
  deploymentId: string;
  providerAttemptId: string | null;
  transactionId: string | null;
}

export interface LedgerAttestationTrade {
  id: string;
  createdAt: string;
  direction: string;
  asset: string;
  pair: string;
  agentRunId: string | null;
  requestedNotionalUSD: string | null;
  observedMarketPriceUSD: string | null;
  modeledExecutionPriceUSD: string | null;
  quantityAssetDecimal: string | null;
  feeRateBps: number | null;
  feesUSDDecimal: string | null;
  slippageBps: number | null;
  slippageUSD: string | null;
  ethBalanceBefore: string | null;
  ethBalanceAfter: string | null;
  usdcBalanceBefore: string | null;
  usdcBalanceAfter: string | null;
  costBasisBeforeUSD: string | null;
  costBasisAfterUSD: string | null;
  realizedPnlUSDDecimal: string | null;
  strategyVersion: string;
  signalSnapshot: unknown;
  legacy: {
    amountUSD: string;
    amountAsset: string;
    executionPrice: string;
    feesUSD: string;
    pnlUSD: string | null;
  };
  run: LedgerAttestationRun | null;
  journals: LedgerAttestationJournal[];
  incidents: LedgerAttestationIncident[];
}

export interface LedgerAttestationInput {
  binding: LedgerAttestationBinding;
  state: LedgerAttestationState | null;
  trades: LedgerAttestationTrade[];
  maxTrades?: number;
}

export interface LedgerAttestationCheck {
  code: string;
  status: "pass" | "fail";
  field?: string;
  trade?: string;
}

export interface LedgerAttestationTransition {
  sequence: number;
  trade: string;
  classification: "modern" | "legacy-compatible";
  direction: "BUY" | "SELL";
  quantityETH: string;
  requestedNotionalUSD: string;
  grossNotionalUSD: string;
  observedMarketPriceUSD: string;
  executionPriceUSD: string;
  feeUSD: string;
  realizedPnlUSD: string | null;
  portfolioValueBeforeUSD: string;
  portfolioValueUSD: string;
  before: {
    ethBalance: string;
    usdcBalance: string;
    weightedCostBasisUSD: string | null;
    dcaCount: number;
  };
  after: {
    ethBalance: string;
    usdcBalance: string;
    weightedCostBasisUSD: string | null;
    dcaCount: number;
  };
}

export interface LedgerAttestationReport {
  schemaVersion: typeof LEDGER_ATTESTATION_SCHEMA_VERSION;
  binding: LedgerAttestationBinding;
  bounds: {
    maximumTrades: number;
    observedTrades: number;
  };
  status: "PASS" | "FAIL";
  checks: LedgerAttestationCheck[];
  totals: {
    feesUSD: string;
    realizedPnlUSD: string;
    legacyCompatibleTrades: number;
  };
  derivedState: {
    ethBalance: string;
    usdcBalance: string;
    weightedCostBasisUSD: string | null;
    dcaCount: number;
    portfolioValueUSD: string;
    peakPortfolioValueUSD: string;
    lastTradePriceUSD: string | null;
    referencePriceUSD: string | null;
    lastBuyPriceUSD: string | null;
  };
  anchorDecision: "RETAIN" | "RESET_REQUIRED" | "BLOCK";
  paperPromotionEligible: boolean;
  transitions: LedgerAttestationTransition[];
  checksum: string;
}

function hashedId(value: string): string {
  return `sha256:${canonicalSha256(value)}`;
}

function fixed(value: bigint, scale: number): string {
  return formatDecimal(value, scale);
}

function nullableFixed(value: bigint | null, scale: number): string | null {
  return value === null ? null : fixed(value, scale);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function canonicalTime(value: string): Date | null {
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value
    ? date
    : null;
}

function parseAnchor(value: unknown): PriceAnchorMetadata | null {
  const candidate = record(value);
  if (
    !candidate ||
    typeof candidate.observedAt !== "string" ||
    canonicalTime(candidate.observedAt) === null ||
    typeof candidate.source !== "string" ||
    !ANCHOR_SOURCES.includes(
      candidate.source as (typeof ANCHOR_SOURCES)[number],
    ) ||
    !Number.isSafeInteger(candidate.maxAgeSeconds) ||
    candidate.maxAgeSeconds !== PAPER_ANCHOR_MAX_AGE_SECONDS ||
    typeof candidate.releaseId !== "string" ||
    candidate.releaseId.length === 0 ||
    typeof candidate.configVersion !== "string" ||
    candidate.configVersion.length === 0 ||
    !(
      candidate.observedPriceUSD === null ||
      typeof candidate.observedPriceUSD === "string"
    ) ||
    !(
      candidate.observedPortfolioValueUSD === null ||
      typeof candidate.observedPortfolioValueUSD === "string"
    )
  ) {
    return null;
  }
  return candidate as unknown as PriceAnchorMetadata;
}

function exactJsonField(
  value: unknown,
  field: string,
): string | null | undefined {
  const object = record(value);
  const entry = object?.[field];
  return entry === null || typeof entry === "string" ? entry : undefined;
}

export function attestLedger(
  input: LedgerAttestationInput,
): LedgerAttestationReport {
  const maximumTrades =
    input.maxTrades ?? DEFAULT_LEDGER_ATTESTATION_MAX_TRADES;
  if (
    !Number.isSafeInteger(maximumTrades) ||
    maximumTrades < 1 ||
    maximumTrades > DEFAULT_LEDGER_ATTESTATION_MAX_TRADES
  ) {
    throw new Error(
      `Ledger attestation bound must be between 1 and ${DEFAULT_LEDGER_ATTESTATION_MAX_TRADES}`,
    );
  }

  const checks: LedgerAttestationCheck[] = [];
  const transitions: LedgerAttestationTransition[] = [];
  const fail = (code: string, field?: string, tradeId?: string) => {
    checks.push({
      code,
      status: "fail",
      ...(field ? { field } : {}),
      ...(tradeId ? { trade: hashedId(tradeId) } : {}),
    });
  };
  const expectExact = (
    actual: string | null,
    expected: string | null,
    field: string,
    tradeId?: string,
  ) => {
    if (actual !== expected) fail("EXACT_VALUE_MISMATCH", field, tradeId);
  };

  const asOf = canonicalTime(input.binding.asOf);
  if (!asOf) fail("INVALID_ATTESTATION_TIME", "binding.asOf");
  if (input.trades.length > maximumTrades) {
    fail("LEDGER_BOUND_EXCEEDED", "trades");
  }
  if (!input.state) {
    fail("AGENT_STATE_MISSING", "state");
  }

  let account: DecimalAccount = {
    ethBalance: 0n,
    usdcBalance: 0n,
    weightedCostBasisUSD: null,
    dcaCount: 0,
  };
  let initialCapital = 0n;
  let totalFees = 0n;
  let totalRealizedPnl = 0n;
  let peakFromTrades = 0n;
  let lastTradePrice: bigint | null = null;
  let derivedReference: bigint | null = null;
  let derivedLastBuy: bigint | null = null;
  let legacyCompatibleTrades = 0;

  if (input.state) {
    try {
      initialCapital = parseDecimal(
        input.state.initialCapitalUSD,
        USD_SCALE,
      );
      if (initialCapital <= 0n) {
        fail("INVALID_INITIAL_STATE", "initialCapitalUSD");
      }
      account.usdcBalance = initialCapital;
      peakFromTrades = initialCapital;
    } catch {
      fail("INVALID_FIXED_POINT", "initialCapitalUSD");
    }
  }

  const ids = new Set<string>();
  const runIds = new Set<string>();
  let previousOrder: string | null = null;

  for (const [index, trade] of input.trades
    .slice(0, maximumTrades)
    .entries()) {
    const tradeHash = hashedId(trade.id);
    if (ids.has(trade.id)) fail("DUPLICATE_TRADE", "id", trade.id);
    ids.add(trade.id);

    const createdAt = canonicalTime(trade.createdAt);
    const order = `${trade.createdAt}\u0000${trade.id}`;
    if (!createdAt) fail("INVALID_TRADE_TIME", "createdAt", trade.id);
    if (previousOrder !== null && order <= previousOrder) {
      fail("OUT_OF_ORDER_TRADE", "createdAt", trade.id);
    }
    previousOrder = order;

    const snapshot = record(trade.signalSnapshot);
    const legacy =
      trade.agentRunId === null &&
      trade.strategyVersion === "v2-legacy" &&
      snapshot?.source === "v2-backfill";
    const classification = legacy ? "legacy-compatible" : "modern";
    if (legacy) legacyCompatibleTrades += 1;

    if (trade.direction !== "BUY" && trade.direction !== "SELL") {
      fail("INVALID_DIRECTION", "direction", trade.id);
      continue;
    }
    if (trade.asset !== "ETH" || trade.pair !== "ETH/USDC") {
      fail("INVALID_MARKET", "asset/pair", trade.id);
    }

    if (legacy) {
      if (trade.run !== null) {
        fail("LEGACY_RUN_LINK_PRESENT", "run", trade.id);
      }
    } else {
      if (!trade.agentRunId || !trade.run) {
        fail("ORPHAN_TRADE", "agentRunId", trade.id);
      } else {
        if (runIds.has(trade.agentRunId)) {
          fail("DUPLICATE_RUN_TRADE", "agentRunId", trade.id);
        }
        runIds.add(trade.agentRunId);
        const run = trade.run;
        if (
          run.id !== trade.agentRunId ||
          run.tradingMode !== "PAPER" ||
          run.outcome !== "EXECUTED" ||
          run.completedAt === null ||
          run.strategyVersion !== trade.strategyVersion
        ) {
          fail("INVALID_RUN_LINK", "run", trade.id);
        }
        const linkedJournals = trade.journals.filter(
          (journal) =>
            journal.agentRunId === run.id &&
            journal.tradeExecutionId === trade.id,
        );
        if (linkedJournals.length !== 1) {
          fail("INVALID_JOURNAL_LINK_COUNT", "journals", trade.id);
        } else {
          const correlation = linkedJournals[0].marketConditions;
          if (
            exactJsonField(correlation, "requestId") !== run.requestId ||
            exactJsonField(correlation, "runId") !== run.id ||
            exactJsonField(correlation, "releaseId") !== run.releaseId ||
            exactJsonField(correlation, "deploymentId") !==
              run.deploymentId ||
            exactJsonField(correlation, "providerAttemptId") !==
              run.providerAttemptId ||
            exactJsonField(correlation, "transactionId") !== trade.id
          ) {
            fail("JOURNAL_CORRELATION_MISMATCH", "journals", trade.id);
          }
        }
        const createdIncidents = trade.incidents.filter(
          (incident) =>
            incident.eventKind === "CREATED" &&
            incident.incidentType === "PAPER_TRADE_POST_COMMIT",
        );
        if (createdIncidents.length !== 1) {
          fail("INVALID_INCIDENT_LINK_COUNT", "incidents", trade.id);
        } else {
          const incident = createdIncidents[0];
          if (
            incident.requestId !== run.requestId ||
            incident.agentRunId !== run.id ||
            incident.releaseId !== run.releaseId ||
            incident.deploymentId !== run.deploymentId ||
            incident.providerAttemptId !== run.providerAttemptId ||
            incident.transactionId !== trade.id ||
            exactJsonField(
              linkedJournals[0]?.marketConditions,
              "incidentId",
            ) !== incident.incidentId
          ) {
            fail("INCIDENT_CORRELATION_MISMATCH", "incidents", trade.id);
          }
        }
      }
    }

    try {
      if (
        trade.requestedNotionalUSD === null ||
        trade.observedMarketPriceUSD === null ||
        trade.modeledExecutionPriceUSD === null ||
        trade.quantityAssetDecimal === null ||
        trade.feeRateBps === null ||
        trade.feesUSDDecimal === null ||
        trade.slippageBps === null ||
        trade.slippageUSD === null
      ) {
        throw new Error("missing fixed-point field");
      }
      const requested = parseDecimal(
        trade.requestedNotionalUSD,
        USD_SCALE,
      );
      const observed = parseDecimal(
        trade.observedMarketPriceUSD,
        USD_SCALE,
      );
      const execution = parseDecimal(
        trade.modeledExecutionPriceUSD,
        USD_SCALE,
      );
      const quantity = parseDecimal(
        trade.quantityAssetDecimal,
        ETH_SCALE,
      );
      const fee = parseDecimal(trade.feesUSDDecimal, USD_SCALE);
      const slippage = parseDecimal(trade.slippageUSD, USD_SCALE);
      if (
        requested <= 0n ||
        observed <= 0n ||
        execution <= 0n ||
        quantity <= 0n ||
        fee < 0n ||
        slippage < 0n ||
        !Number.isSafeInteger(trade.feeRateBps) ||
        trade.feeRateBps < 0 ||
        !Number.isSafeInteger(trade.slippageBps) ||
        trade.slippageBps < 0
      ) {
        throw new Error("invalid fixed-point field");
      }

      const fullExit =
        trade.direction === "SELL" && quantity === account.ethBalance;
      const gross = legacy
        ? requested
        : notionalForQuantity(quantity, execution);

      if (!legacy) {
        const expectedExecution = applyBps(
          observed,
          trade.slippageBps,
          trade.direction === "BUY" ? "increase" : "decrease",
        );
        expectExact(
          fixed(execution, USD_SCALE),
          fixed(expectedExecution, USD_SCALE),
          "modeledExecutionPriceUSD",
          trade.id,
        );
        const expectedQuantity =
          trade.direction === "SELL" && fullExit
            ? account.ethBalance
            : quantityForNotional(
                requested,
                trade.direction === "BUY" ? execution : observed,
              );
        expectExact(
          fixed(quantity, ETH_SCALE),
          fixed(expectedQuantity, ETH_SCALE),
          "quantityAssetDecimal",
          trade.id,
        );
        expectExact(
          fixed(fee, USD_SCALE),
          fixed(feeFromBps(gross, trade.feeRateBps), USD_SCALE),
          "feesUSDDecimal",
          trade.id,
        );
        const observedNotional = notionalForQuantity(quantity, observed);
        const expectedSlippage =
          observedNotional >= gross
            ? observedNotional - gross
            : gross - observedNotional;
        expectExact(
          fixed(slippage, USD_SCALE),
          fixed(expectedSlippage, USD_SCALE),
          "slippageUSD",
          trade.id,
        );
      }

      expectExact(
        trade.legacy.amountUSD,
        fixed(gross, USD_SCALE),
        "legacy.amountUSD",
        trade.id,
      );
      expectExact(
        trade.legacy.amountAsset,
        fixed(quantity, ETH_SCALE),
        "legacy.amountAsset",
        trade.id,
      );
      expectExact(
        trade.legacy.executionPrice,
        fixed(execution, USD_SCALE),
        "legacy.executionPrice",
        trade.id,
      );
      expectExact(
        trade.legacy.feesUSD,
        fixed(fee, USD_SCALE),
        "legacy.feesUSD",
        trade.id,
      );

      const before = account;
      const transition = applyAccountingTransition(before, {
        direction: trade.direction,
        quantityETH: quantity,
        grossNotionalUSD: gross,
        feeUSD: fee,
        executionPriceUSD: execution,
        fullExit,
      });
      account = transition.after;
      const realized = transition.realizedPnlUSD;
      const portfolioBefore =
        before.usdcBalance +
        notionalForQuantity(before.ethBalance, observed);
      const portfolio =
        account.usdcBalance +
        notionalForQuantity(account.ethBalance, observed);
      if (portfolio > peakFromTrades) peakFromTrades = portfolio;
      totalFees += fee;
      totalRealizedPnl += realized ?? 0n;
      lastTradePrice = execution;
      if (trade.direction === "BUY") {
        derivedLastBuy = execution;
      } else if (fullExit) {
        derivedLastBuy = null;
        derivedReference = execution;
      }

      expectExact(
        trade.ethBalanceBefore,
        fixed(before.ethBalance, ETH_SCALE),
        "ethBalanceBefore",
        trade.id,
      );
      expectExact(
        trade.ethBalanceAfter,
        fixed(account.ethBalance, ETH_SCALE),
        "ethBalanceAfter",
        trade.id,
      );
      expectExact(
        trade.usdcBalanceBefore,
        fixed(before.usdcBalance, USD_SCALE),
        "usdcBalanceBefore",
        trade.id,
      );
      expectExact(
        trade.usdcBalanceAfter,
        fixed(account.usdcBalance, USD_SCALE),
        "usdcBalanceAfter",
        trade.id,
      );
      expectExact(
        trade.costBasisBeforeUSD,
        nullableFixed(transition.costBasisBeforeUSD, USD_SCALE),
        "costBasisBeforeUSD",
        trade.id,
      );
      expectExact(
        trade.costBasisAfterUSD,
        nullableFixed(transition.costBasisAfterUSD, USD_SCALE),
        "costBasisAfterUSD",
        trade.id,
      );
      expectExact(
        trade.realizedPnlUSDDecimal,
        nullableFixed(realized, USD_SCALE),
        "realizedPnlUSDDecimal",
        trade.id,
      );
      expectExact(
        trade.legacy.pnlUSD,
        nullableFixed(realized, USD_SCALE),
        "legacy.pnlUSD",
        trade.id,
      );

      transitions.push({
        sequence: index + 1,
        trade: tradeHash,
        classification,
        direction: trade.direction,
        quantityETH: fixed(quantity, ETH_SCALE),
        requestedNotionalUSD: fixed(requested, USD_SCALE),
        grossNotionalUSD: fixed(gross, USD_SCALE),
        observedMarketPriceUSD: fixed(observed, USD_SCALE),
        executionPriceUSD: fixed(execution, USD_SCALE),
        feeUSD: fixed(fee, USD_SCALE),
        realizedPnlUSD: nullableFixed(realized, USD_SCALE),
        portfolioValueBeforeUSD: fixed(portfolioBefore, USD_SCALE),
        portfolioValueUSD: fixed(portfolio, USD_SCALE),
        before: {
          ethBalance: fixed(before.ethBalance, ETH_SCALE),
          usdcBalance: fixed(before.usdcBalance, USD_SCALE),
          weightedCostBasisUSD: nullableFixed(
            before.weightedCostBasisUSD,
            USD_SCALE,
          ),
          dcaCount: before.dcaCount,
        },
        after: {
          ethBalance: fixed(account.ethBalance, ETH_SCALE),
          usdcBalance: fixed(account.usdcBalance, USD_SCALE),
          weightedCostBasisUSD: nullableFixed(
            account.weightedCostBasisUSD,
            USD_SCALE,
          ),
          dcaCount: account.dcaCount,
        },
      });
    } catch {
      fail("INVALID_TRADE_FIXED_POINT", "trade", trade.id);
    }
  }

  let portfolioValue = account.usdcBalance;
  let peakPortfolioValue = peakFromTrades;
  let anchorResetRequired = false;
  let anchorDecision: LedgerAttestationReport["anchorDecision"] =
    "RESET_REQUIRED";

  if (input.state) {
    const state = input.state;
    expectExact(
      state.currentPositionETHDecimal,
      fixed(account.ethBalance, ETH_SCALE),
      "state.currentPositionETHDecimal",
    );
    expectExact(
      state.currentPositionUSDCDecimal,
      fixed(account.usdcBalance, USD_SCALE),
      "state.currentPositionUSDCDecimal",
    );
    expectExact(
      state.weightedCostBasisUSD,
      nullableFixed(account.weightedCostBasisUSD, USD_SCALE),
      "state.weightedCostBasisUSD",
    );
    if (state.dcaCount !== account.dcaCount) {
      fail("EXACT_VALUE_MISMATCH", "state.dcaCount");
    }
    expectExact(
      state.lastTradePriceDecimal,
      nullableFixed(lastTradePrice, USD_SCALE),
      "state.lastTradePriceDecimal",
    );
    expectExact(
      state.legacy.currentPositionETH,
      fixed(account.ethBalance, ETH_SCALE),
      "state.legacy.currentPositionETH",
    );
    expectExact(
      state.legacy.currentPositionUSDC,
      fixed(account.usdcBalance, USD_SCALE),
      "state.legacy.currentPositionUSDC",
    );
    expectExact(
      state.legacy.lastTradePrice,
      nullableFixed(lastTradePrice, USD_SCALE),
      "state.legacy.lastTradePrice",
    );

    const validateAnchor = (
      value: unknown,
      field: string,
    ): PriceAnchorMetadata | null => {
      const anchor = parseAnchor(value);
      if (!anchor) {
        anchorResetRequired = true;
        fail("INVALID_ANCHOR_METADATA", field);
        return null;
      }
      if (anchor.configVersion !== input.binding.configVersion) {
        anchorResetRequired = true;
        fail("ANCHOR_CONFIG_MISMATCH", field);
      }
      if (asOf) {
        const observedAt = canonicalTime(anchor.observedAt)!;
        const ageMs = asOf.getTime() - observedAt.getTime();
        if (
          ageMs < 0 ||
          ageMs > anchor.maxAgeSeconds * 1_000
        ) {
          anchorResetRequired = true;
          fail("STALE_ANCHOR", field);
        }
      }
      return anchor;
    };

    const portfolioObservation = validateAnchor(
      state.portfolioValueObservation,
      "state.portfolioValueObservation",
    );
    if (portfolioObservation) {
      try {
        const observedPrice =
          portfolioObservation.observedPriceUSD === null
            ? null
            : parseDecimal(
                portfolioObservation.observedPriceUSD,
                USD_SCALE,
              );
        portfolioValue =
          observedPrice === null
            ? account.usdcBalance
            : account.usdcBalance +
              notionalForQuantity(account.ethBalance, observedPrice);
        if (observedPrice === null && account.ethBalance !== 0n) {
          fail(
            "PORTFOLIO_OBSERVATION_PRICE_MISSING",
            "state.portfolioValueObservation",
          );
        }
        expectExact(
          portfolioObservation.observedPortfolioValueUSD,
          fixed(portfolioValue, USD_SCALE),
          "state.portfolioValueObservation.observedPortfolioValueUSD",
        );
      } catch {
        fail(
          "INVALID_ANCHOR_FIXED_POINT",
          "state.portfolioValueObservation",
        );
      }
    }
    expectExact(
      state.portfolioValueUSDDecimal,
      fixed(portfolioValue, USD_SCALE),
      "state.portfolioValueUSDDecimal",
    );
    expectExact(
      state.legacy.portfolioValueUSD,
      fixed(portfolioValue, USD_SCALE),
      "state.legacy.portfolioValueUSD",
    );

    const peakAnchor = validateAnchor(
      state.peakPortfolioValueAnchor,
      "state.peakPortfolioValueAnchor",
    );
    if (peakAnchor) {
      try {
        if (peakAnchor.observedPortfolioValueUSD === null) {
          throw new Error("peak value missing");
        }
        peakPortfolioValue = parseDecimal(
          peakAnchor.observedPortfolioValueUSD,
          USD_SCALE,
        );
        if (
          peakPortfolioValue < peakFromTrades ||
          peakPortfolioValue < initialCapital
        ) {
          fail("PEAK_CHAIN_MISMATCH", "state.peakPortfolioValueUSD");
        }
      } catch {
        fail(
          "INVALID_ANCHOR_FIXED_POINT",
          "state.peakPortfolioValueAnchor",
        );
      }
    }
    expectExact(
      state.peakPortfolioValueUSD,
      fixed(peakPortfolioValue, USD_SCALE),
      "state.peakPortfolioValueUSD",
    );

    if (account.ethBalance === 0n) {
      if (
        account.dcaCount !== 0 ||
        account.weightedCostBasisUSD !== null ||
        state.lastBuyPriceUSD !== null ||
        state.lastBuyPriceAnchor !== null
      ) {
        fail("FLAT_STATE_RESIDUE", "state");
      }
    } else {
      expectExact(
        state.lastBuyPriceUSD,
        nullableFixed(derivedLastBuy, USD_SCALE),
        "state.lastBuyPriceUSD",
      );
      const lastBuyAnchor = validateAnchor(
        state.lastBuyPriceAnchor,
        "state.lastBuyPriceAnchor",
      );
      if (lastBuyAnchor) {
        expectExact(
          lastBuyAnchor.observedPriceUSD,
          state.lastBuyPriceUSD,
          "state.lastBuyPriceAnchor.observedPriceUSD",
        );
      }
    }

    if (derivedReference !== null) {
      expectExact(
        state.referencePriceUSD,
        fixed(derivedReference, USD_SCALE),
        "state.referencePriceUSD",
      );
    }
    if (state.referencePriceUSD !== null) {
      const referenceAnchor = validateAnchor(
        state.referencePriceAnchor,
        "state.referencePriceAnchor",
      );
      if (referenceAnchor) {
        expectExact(
          referenceAnchor.observedPriceUSD,
          state.referencePriceUSD,
          "state.referencePriceAnchor.observedPriceUSD",
        );
        anchorDecision = "RETAIN";
      }
    } else if (state.referencePriceAnchor !== null) {
      anchorResetRequired = true;
      fail("REFERENCE_ANCHOR_WITHOUT_VALUE", "state.referencePriceAnchor");
    }

    if (state.accountingStatus !== "RECONCILED") {
      fail("ACCOUNTING_NOT_RECONCILED", "state.accountingStatus");
    }
    if (state.strategyVersion !== input.binding.configVersion) {
      fail("STATE_CONFIG_MISMATCH", "state.strategyVersion");
    }
  }

  if (
    input.binding.purpose === "pre-paper" &&
    anchorDecision !== "RETAIN"
  ) {
    anchorResetRequired = true;
    fail("PAPER_REFERENCE_RESET_REQUIRED", "state.referencePriceUSD");
  }

  if (checks.length === 0) {
    checks.push({ code: "LEDGER_ATTESTED", status: "pass" });
  } else {
    anchorDecision = anchorResetRequired ? "RESET_REQUIRED" : "BLOCK";
  }

  const base = {
    schemaVersion: LEDGER_ATTESTATION_SCHEMA_VERSION as typeof LEDGER_ATTESTATION_SCHEMA_VERSION,
    binding: input.binding,
    bounds: {
      maximumTrades,
      observedTrades: input.trades.length,
    },
    status: checks.some((check) => check.status === "fail")
      ? ("FAIL" as const)
      : ("PASS" as const),
    checks,
    totals: {
      feesUSD: fixed(totalFees, USD_SCALE),
      realizedPnlUSD: fixed(totalRealizedPnl, USD_SCALE),
      legacyCompatibleTrades,
    },
    derivedState: {
      ethBalance: fixed(account.ethBalance, ETH_SCALE),
      usdcBalance: fixed(account.usdcBalance, USD_SCALE),
      weightedCostBasisUSD: nullableFixed(
        account.weightedCostBasisUSD,
        USD_SCALE,
      ),
      dcaCount: account.dcaCount,
      portfolioValueUSD: fixed(portfolioValue, USD_SCALE),
      peakPortfolioValueUSD: fixed(peakPortfolioValue, USD_SCALE),
      lastTradePriceUSD: nullableFixed(lastTradePrice, USD_SCALE),
      referencePriceUSD: input.state?.referencePriceUSD ?? null,
      lastBuyPriceUSD: input.state?.lastBuyPriceUSD ?? null,
    },
    anchorDecision,
    paperPromotionEligible:
      input.binding.purpose === "pre-paper" &&
      checks.every((check) => check.status === "pass") &&
      anchorDecision === "RETAIN",
    transitions,
  };
  return {
    ...base,
    checksum: `sha256:${canonicalSha256(base)}`,
  };
}
