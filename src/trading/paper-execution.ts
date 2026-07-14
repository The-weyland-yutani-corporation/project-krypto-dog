import {
  type AccountingTransition,
  type DecimalAccount,
  applyAccountingTransition,
  applyBps,
  feeFromBps,
  notionalForQuantity,
  quantityForNotional,
} from "./accounting";

export interface PaperExecutionCalculationInput {
  account: DecimalAccount;
  direction: "BUY" | "SELL";
  requestedNotionalUSD: bigint;
  observedPriceUSD: bigint;
  feeBps: number;
  slippageBps: number;
  fullExit: boolean;
  initialCapitalUSD: bigint;
  peakPortfolioValueUSD: bigint;
}

export interface PaperExecutionCalculation {
  executionPriceUSD: bigint;
  quantityETH: bigint;
  grossNotionalUSD: bigint;
  feeUSD: bigint;
  observedNotionalUSD: bigint;
  slippageUSD: bigint;
  transition: AccountingTransition;
  portfolioValueUSD: bigint;
  peakPortfolioValueUSD: bigint;
  drawdownPct: bigint;
}

export function calculateDrawdownPct(
  peakPortfolioValueUSD: bigint,
  portfolioValueUSD: bigint,
  decimalScale: number,
): bigint {
  if (
    peakPortfolioValueUSD <= 0n ||
    portfolioValueUSD >= peakPortfolioValueUSD
  ) {
    return 0n;
  }
  const scale = 10n ** BigInt(decimalScale);
  const numerator =
    (peakPortfolioValueUSD - portfolioValueUSD) * 100n * scale;
  return (numerator + peakPortfolioValueUSD / 2n) / peakPortfolioValueUSD;
}

export function calculatePaperExecution(
  input: PaperExecutionCalculationInput,
  decimalScale: number,
): PaperExecutionCalculation {
  const executionPriceUSD = applyBps(
    input.observedPriceUSD,
    input.slippageBps,
    input.direction === "BUY" ? "increase" : "decrease",
  );
  const quantityETH =
    input.direction === "SELL" && input.fullExit
      ? input.account.ethBalance
      : quantityForNotional(
          input.requestedNotionalUSD,
          input.direction === "BUY"
            ? executionPriceUSD
            : input.observedPriceUSD,
        );
  const grossNotionalUSD = notionalForQuantity(
    quantityETH,
    executionPriceUSD,
  );
  const feeUSD = feeFromBps(grossNotionalUSD, input.feeBps);
  const observedNotionalUSD = notionalForQuantity(
    quantityETH,
    input.observedPriceUSD,
  );
  const slippageUSD =
    observedNotionalUSD >= grossNotionalUSD
      ? observedNotionalUSD - grossNotionalUSD
      : grossNotionalUSD - observedNotionalUSD;
  const transition = applyAccountingTransition(input.account, {
    direction: input.direction,
    quantityETH,
    grossNotionalUSD,
    feeUSD,
    executionPriceUSD,
    fullExit: input.fullExit,
  });
  const portfolioValueUSD =
    notionalForQuantity(
      transition.after.ethBalance,
      input.observedPriceUSD,
    ) + transition.after.usdcBalance;
  const peakPortfolioValueUSD = [
    input.peakPortfolioValueUSD,
    input.initialCapitalUSD,
    portfolioValueUSD,
  ].reduce((maximum, value) => (value > maximum ? value : maximum));

  return {
    executionPriceUSD,
    quantityETH,
    grossNotionalUSD,
    feeUSD,
    observedNotionalUSD,
    slippageUSD,
    transition,
    portfolioValueUSD,
    peakPortfolioValueUSD,
    drawdownPct: calculateDrawdownPct(
      peakPortfolioValueUSD,
      portfolioValueUSD,
      decimalScale,
    ),
  };
}
