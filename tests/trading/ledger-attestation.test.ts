import fixtures from "@/../tests/fixtures/ledger-attestation/golden.json";
import {
  ETH_SCALE,
  USD_SCALE,
  formatDecimal,
  parseDecimal,
  type DecimalAccount,
} from "@/trading/accounting";
import { createPriceAnchorMetadata } from "@/trading/anchors";
import {
  attestLedger,
  type LedgerAttestationInput,
  type LedgerAttestationTrade,
} from "@/trading/ledger-attestation";
import { calculatePaperExecution } from "@/trading/paper-execution";
import { DEFAULT_STRATEGY_CONFIG } from "@/trading/strategy-config";

type Intent = {
  direction: "BUY" | "SELL";
  notionalUSD: string;
  observedPriceUSD: string;
  fullExit?: boolean;
  legacy?: boolean;
};

const RELEASE_SHA = "a".repeat(40);
const IMAGE_DIGEST = `sha256:${"b".repeat(64)}`;
const START = new Date("2026-08-17T12:00:00.000Z");
const AS_OF = new Date("2026-08-17T12:30:00.000Z");

function decimal(value: bigint, scale = USD_SCALE): string {
  return formatDecimal(value, scale);
}

function fixtureInput(intents: Intent[]): LedgerAttestationInput {
  let account: DecimalAccount = {
    ethBalance: 0n,
    usdcBalance: parseDecimal("200.00000000", USD_SCALE),
    weightedCostBasisUSD: null,
    dcaCount: 0,
  };
  const initialCapital = account.usdcBalance;
  let peak = initialCapital;
  let referencePrice: bigint | null = null;
  let referenceAnchor: unknown = null;
  let lastBuyPrice: bigint | null = null;
  let lastBuyAnchor: unknown = null;
  let lastTradePrice: bigint | null = null;
  let portfolio = initialCapital;
  let peakAnchor = createPriceAnchorMetadata({
    observedAt: START,
    source: "account-initialization",
    releaseId: RELEASE_SHA,
    configVersion: DEFAULT_STRATEGY_CONFIG.version,
    observedPriceUSD: null,
    observedPortfolioValueUSD: initialCapital,
  });
  let portfolioObservation = peakAnchor;
  const trades: LedgerAttestationTrade[] = [];

  for (const [index, intent] of intents.entries()) {
    const occurredAt = new Date(START.getTime() + (index + 1) * 60_000);
    const observed = parseDecimal(intent.observedPriceUSD, USD_SCALE);
    const legacy = intent.legacy === true;
    const feeBps = DEFAULT_STRATEGY_CONFIG.feeBps;
    const slippageBps = legacy
      ? 0
      : DEFAULT_STRATEGY_CONFIG.paperSlippageBps;
    const calculation = calculatePaperExecution(
      {
        account,
        direction: intent.direction,
        requestedNotionalUSD: parseDecimal(
          intent.notionalUSD,
          USD_SCALE,
        ),
        observedPriceUSD: observed,
        feeBps,
        slippageBps,
        fullExit: intent.fullExit === true,
        initialCapitalUSD: initialCapital,
        peakPortfolioValueUSD: peak,
      },
      USD_SCALE,
    );
    const before = account;
    account = calculation.transition.after;
    portfolio = calculation.portfolioValueUSD;
    const priorPeak = peak;
    peak = calculation.peakPortfolioValueUSD;
    lastTradePrice = calculation.executionPriceUSD;
    const source =
      intent.direction === "BUY"
        ? "paper-buy"
        : intent.fullExit
          ? "paper-full-exit"
          : "paper-sell";
    portfolioObservation = createPriceAnchorMetadata({
      observedAt: occurredAt,
      source,
      releaseId: RELEASE_SHA,
      configVersion: DEFAULT_STRATEGY_CONFIG.version,
      observedPriceUSD: observed,
      observedPortfolioValueUSD: portfolio,
    });
    if (peak > priorPeak) peakAnchor = portfolioObservation;
    if (intent.direction === "BUY") {
      lastBuyPrice = calculation.executionPriceUSD;
      lastBuyAnchor = createPriceAnchorMetadata({
        observedAt: occurredAt,
        source: "paper-buy",
        releaseId: RELEASE_SHA,
        configVersion: DEFAULT_STRATEGY_CONFIG.version,
        observedPriceUSD: calculation.executionPriceUSD,
      });
      if (referencePrice === null) {
        referencePrice = observed;
        referenceAnchor = createPriceAnchorMetadata({
          observedAt: occurredAt,
          source: "shadow-reference",
          releaseId: RELEASE_SHA,
          configVersion: DEFAULT_STRATEGY_CONFIG.version,
          observedPriceUSD: observed,
        });
      }
    } else if (intent.fullExit) {
      lastBuyPrice = null;
      lastBuyAnchor = null;
      referencePrice = calculation.executionPriceUSD;
      referenceAnchor = createPriceAnchorMetadata({
        observedAt: occurredAt,
        source: "paper-full-exit",
        releaseId: RELEASE_SHA,
        configVersion: DEFAULT_STRATEGY_CONFIG.version,
        observedPriceUSD: calculation.executionPriceUSD,
      });
    }

    const id = `trade-${index + 1}`;
    const runId = `run-${index + 1}`;
    const requestId = `request-${index + 1}`;
    const incidentId = `incident-${index + 1}`;
    const quantity = decimal(calculation.quantityETH, ETH_SCALE);
    const gross = decimal(calculation.grossNotionalUSD);
    const execution = decimal(calculation.executionPriceUSD);
    const fee = decimal(calculation.feeUSD);
    const realized =
      calculation.transition.realizedPnlUSD === null
        ? null
        : decimal(calculation.transition.realizedPnlUSD);
    const modernRun = {
      id: runId,
      requestId,
      releaseId: RELEASE_SHA,
      deploymentId: IMAGE_DIGEST,
      providerAttemptId: `attempt-coinbase-1-${index}`,
      tradingMode: "PAPER",
      outcome: "EXECUTED",
      strategyVersion: DEFAULT_STRATEGY_CONFIG.version,
      completedAt: occurredAt.toISOString(),
    };
    trades.push({
      id,
      createdAt: occurredAt.toISOString(),
      direction: intent.direction,
      asset: "ETH",
      pair: "ETH/USDC",
      agentRunId: legacy ? null : runId,
      requestedNotionalUSD: decimal(
        parseDecimal(intent.notionalUSD, USD_SCALE),
      ),
      observedMarketPriceUSD: decimal(observed),
      modeledExecutionPriceUSD: execution,
      quantityAssetDecimal: quantity,
      feeRateBps: feeBps,
      feesUSDDecimal: fee,
      slippageBps,
      slippageUSD: decimal(calculation.slippageUSD),
      ethBalanceBefore: decimal(before.ethBalance, ETH_SCALE),
      ethBalanceAfter: decimal(account.ethBalance, ETH_SCALE),
      usdcBalanceBefore: decimal(before.usdcBalance),
      usdcBalanceAfter: decimal(account.usdcBalance),
      costBasisBeforeUSD:
        calculation.transition.costBasisBeforeUSD === null
          ? null
          : decimal(calculation.transition.costBasisBeforeUSD),
      costBasisAfterUSD:
        calculation.transition.costBasisAfterUSD === null
          ? null
          : decimal(calculation.transition.costBasisAfterUSD),
      realizedPnlUSDDecimal: realized,
      strategyVersion: legacy
        ? "v2-legacy"
        : DEFAULT_STRATEGY_CONFIG.version,
      signalSnapshot: legacy
        ? { source: "v2-backfill" }
        : { market: { observedAt: occurredAt.toISOString() } },
      legacy: {
        amountUSD: gross,
        amountAsset: quantity,
        executionPrice: execution,
        feesUSD: fee,
        pnlUSD: realized,
      },
      run: legacy ? null : modernRun,
      journals: legacy
        ? []
        : [
            {
              id: `journal-${index + 1}`,
              agentRunId: runId,
              tradeExecutionId: id,
              marketConditions: {
                requestId,
                runId,
                releaseId: RELEASE_SHA,
                deploymentId: IMAGE_DIGEST,
                providerAttemptId: modernRun.providerAttemptId,
                transactionId: id,
                incidentId,
              },
            },
          ],
      incidents: legacy
        ? []
        : [
            {
              incidentId,
              eventKind: "CREATED",
              incidentType: "PAPER_TRADE_POST_COMMIT",
              requestId,
              agentRunId: runId,
              releaseId: RELEASE_SHA,
              deploymentId: IMAGE_DIGEST,
              providerAttemptId: modernRun.providerAttemptId,
              transactionId: id,
            },
          ],
    });
  }

  return {
    binding: {
      releaseSha: RELEASE_SHA,
      imageDigest: IMAGE_DIGEST,
      configVersion: DEFAULT_STRATEGY_CONFIG.version,
      databaseIdentityHash: `sha256:${"c".repeat(64)}`,
      runtimeRole: "krypto_runtime",
      purpose: "target-smoke",
      asOf: AS_OF.toISOString(),
    },
    state: {
      initialCapitalUSD: decimal(initialCapital),
      lastTradePriceDecimal:
        lastTradePrice === null ? null : decimal(lastTradePrice),
      currentPositionETHDecimal: decimal(account.ethBalance, ETH_SCALE),
      currentPositionUSDCDecimal: decimal(account.usdcBalance),
      portfolioValueUSDDecimal: decimal(portfolio),
      weightedCostBasisUSD:
        account.weightedCostBasisUSD === null
          ? null
          : decimal(account.weightedCostBasisUSD),
      referencePriceUSD:
        referencePrice === null ? null : decimal(referencePrice),
      referencePriceAnchor: referenceAnchor,
      lastBuyPriceUSD:
        lastBuyPrice === null ? null : decimal(lastBuyPrice),
      lastBuyPriceAnchor: lastBuyAnchor,
      dcaCount: account.dcaCount,
      peakPortfolioValueUSD: decimal(peak),
      peakPortfolioValueAnchor: peakAnchor,
      portfolioValueObservation: portfolioObservation,
      accountingStatus: "RECONCILED",
      strategyVersion: DEFAULT_STRATEGY_CONFIG.version,
      legacy: {
        lastTradePrice:
          lastTradePrice === null ? null : decimal(lastTradePrice),
        currentPositionETH: decimal(account.ethBalance, ETH_SCALE),
        currentPositionUSDC: decimal(account.usdcBalance),
        portfolioValueUSD: decimal(portfolio),
      },
    },
    trades,
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

describe("deterministic immutable-ledger attestation", () => {
  it.each(Object.entries(fixtures))(
    "attests the %s golden fixture",
    (_name, intents) => {
      const report = attestLedger(fixtureInput(intents as Intent[]));
      expect(report.status).toBe("PASS");
      expect(report.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(report.bounds.observedTrades).toBe(intents.length);
    },
  );

  it("is idempotent, deterministic, and does not mutate its input", () => {
    const input = fixtureInput(fixtures["multiple-dca"] as Intent[]);
    const before = structuredClone(input);
    const first = attestLedger(input);
    const second = attestLedger(input);
    expect(second).toEqual(first);
    expect(input).toEqual(before);
  });

  it("requires a fresh explicit retained reference immediately before PAPER", () => {
    const input = fixtureInput(fixtures["one-entry"] as Intent[]);
    input.binding.purpose = "pre-paper";
    expect(attestLedger(input)).toMatchObject({
      status: "PASS",
      anchorDecision: "RETAIN",
      paperPromotionEligible: true,
    });

    const stale = clone(input);
    (
      stale.state!.referencePriceAnchor as { observedAt: string }
    ).observedAt = "2026-08-17T10:00:00.000Z";
    const report = attestLedger(stale);
    expect(report.status).toBe("FAIL");
    expect(report.checks).toContainEqual(
      expect.objectContaining({ code: "STALE_ANCHOR" }),
    );
    expect(report.paperPromotionEligible).toBe(false);
  });

  it.each([
    ["fee", (input: LedgerAttestationInput) => {
      input.trades[0].feesUSDDecimal = "0.07000000";
    }],
    ["before chain", (input: LedgerAttestationInput) => {
      input.trades[0].ethBalanceBefore = "0.100000000000000000";
    }],
    ["legacy compatibility", (input: LedgerAttestationInput) => {
      input.trades[0].legacy.amountAsset = "0.100000000000000000";
    }],
    ["orphan run", (input: LedgerAttestationInput) => {
      input.trades[0].run = null;
    }],
    ["journal correlation", (input: LedgerAttestationInput) => {
      input.trades[0].journals[0].tradeExecutionId = "wrong";
    }],
    ["incident correlation", (input: LedgerAttestationInput) => {
      input.trades[0].incidents[0].requestId = "wrong";
    }],
    ["DCA count", (input: LedgerAttestationInput) => {
      input.state!.dcaCount = 99;
    }],
  ])("rejects single-field %s corruption", (_name, corrupt) => {
    const input = fixtureInput(fixtures["one-entry"] as Intent[]);
    corrupt(input);
    expect(attestLedger(input).status).toBe("FAIL");
  });

  it("rejects stale last-buy residue in a flat state", () => {
    const input = fixtureInput(fixtures["full-exit"] as Intent[]);
    input.state!.lastBuyPriceUSD = "2000.00000000";
    input.state!.lastBuyPriceAnchor = input.state!.referencePriceAnchor;
    expect(attestLedger(input).checks).toContainEqual(
      expect.objectContaining({ code: "FLAT_STATE_RESIDUE" }),
    );
  });

  it("rejects duplicates and out-of-order chains", () => {
    const duplicate = fixtureInput(fixtures["multiple-dca"] as Intent[]);
    duplicate.trades[1].id = duplicate.trades[0].id;
    expect(attestLedger(duplicate).status).toBe("FAIL");

    const outOfOrder = fixtureInput(fixtures["multiple-dca"] as Intent[]);
    outOfOrder.trades.reverse();
    expect(attestLedger(outOfOrder).status).toBe("FAIL");
  });

  it("property-checks valid generated chains and rejects one corrupted field", () => {
    let seed = 0x130;
    const random = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return seed >>> 0;
    };
    for (let example = 0; example < 64; example += 1) {
      const count = 1 + (random() % 3);
      const intents: Intent[] = Array.from({ length: count }, (_, index) => ({
        direction: "BUY",
        notionalUSD: `${10 + (random() % 11)}.00000000`,
        observedPriceUSD: `${1800 + (random() % 401)}.00000000`,
        legacy: false,
        fullExit: false,
      }));
      const valid = fixtureInput(intents);
      expect(attestLedger(valid).status).toBe("PASS");

      const corrupted = clone(valid);
      const target = random() % corrupted.trades.length;
      corrupted.trades[target].usdcBalanceAfter = decimal(
        parseDecimal(
          corrupted.trades[target].usdcBalanceAfter!,
          USD_SCALE,
        ) + 1n,
      );
      const report = attestLedger(corrupted);
      expect(report.status).toBe("FAIL");
      expect(report.checks).toContainEqual(
        expect.objectContaining({
          code: "EXACT_VALUE_MISMATCH",
          field: "usdcBalanceAfter",
        }),
      );
    }
  });
});
