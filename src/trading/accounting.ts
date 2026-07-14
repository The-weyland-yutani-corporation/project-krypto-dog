import { AccountingError } from "./errors";

export const USD_SCALE = 8;
export const ETH_SCALE = 18;

const POWERS_OF_TEN = new Map<number, bigint>();

function scaleFactor(scale: number): bigint {
  const cached = POWERS_OF_TEN.get(scale);
  if (cached) return cached;
  const value = 10n ** BigInt(scale);
  POWERS_OF_TEN.set(scale, value);
  return value;
}

export function parseDecimal(value: string, scale: number): bigint {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) {
    throw new AccountingError(`Invalid decimal value: ${value}`);
  }

  const [, sign, whole, fraction = ""] = match;
  if (fraction.length > scale) {
    throw new AccountingError(
      `Decimal value ${value} exceeds scale ${scale}`,
    );
  }

  const units =
    BigInt(whole) * scaleFactor(scale) +
    BigInt(fraction.padEnd(scale, "0") || "0");
  return sign === "-" ? -units : units;
}

export function formatDecimal(value: bigint, scale: number): string {
  const negative = value < 0;
  const absolute = negative ? -value : value;
  const factor = scaleFactor(scale);
  const whole = absolute / factor;
  const fraction = (absolute % factor).toString().padStart(scale, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

function divideRounded(
  numerator: bigint,
  denominator: bigint,
  mode: "floor" | "nearest" | "ceil",
): bigint {
  if (denominator <= 0) {
    throw new AccountingError("Division requires a positive denominator");
  }
  if (numerator < 0) {
    throw new AccountingError("Rounded division does not accept negatives");
  }

  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n || mode === "floor") return quotient;
  if (mode === "ceil") return quotient + 1n;
  return remainder * 2n >= denominator ? quotient + 1n : quotient;
}

export function applyBps(
  value: bigint,
  bps: number,
  direction: "increase" | "decrease",
): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new AccountingError(`Invalid basis points: ${bps}`);
  }
  const multiplier =
    direction === "increase" ? 10_000 + bps : 10_000 - bps;
  return divideRounded(value * BigInt(multiplier), 10_000n, "nearest");
}

export function feeFromBps(value: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0) {
    throw new AccountingError(`Invalid fee basis points: ${bps}`);
  }
  return divideRounded(value * BigInt(bps), 10_000n, "ceil");
}

export function quantityForNotional(
  notionalUSD: bigint,
  executionPriceUSD: bigint,
): bigint {
  return divideRounded(
    notionalUSD * scaleFactor(ETH_SCALE),
    executionPriceUSD,
    "floor",
  );
}

export function notionalForQuantity(
  quantityETH: bigint,
  executionPriceUSD: bigint,
): bigint {
  return divideRounded(
    quantityETH * executionPriceUSD,
    scaleFactor(ETH_SCALE),
    "floor",
  );
}

function costForPosition(
  quantityETH: bigint,
  weightedCostBasisUSD: bigint | null,
): bigint {
  if (quantityETH === 0n) return 0n;
  if (weightedCostBasisUSD === null) {
    throw new AccountingError(
      "An open ETH position requires a weighted cost basis",
    );
  }
  return notionalForQuantity(quantityETH, weightedCostBasisUSD);
}

export interface DecimalAccount {
  ethBalance: bigint;
  usdcBalance: bigint;
  weightedCostBasisUSD: bigint | null;
  dcaCount: number;
}

export interface DecimalExecution {
  direction: "BUY" | "SELL";
  quantityETH: bigint;
  grossNotionalUSD: bigint;
  feeUSD: bigint;
  executionPriceUSD: bigint;
  fullExit: boolean;
}

export interface AccountingTransition {
  before: DecimalAccount;
  after: DecimalAccount;
  realizedPnlUSD: bigint | null;
  costBasisBeforeUSD: bigint | null;
  costBasisAfterUSD: bigint | null;
}

export function applyAccountingTransition(
  account: DecimalAccount,
  execution: DecimalExecution,
): AccountingTransition {
  if (
    account.ethBalance < 0n ||
    account.usdcBalance < 0n ||
    execution.quantityETH <= 0n ||
    execution.grossNotionalUSD <= 0n ||
    execution.feeUSD < 0n ||
    execution.executionPriceUSD <= 0n
  ) {
    throw new AccountingError("Accounting inputs must be finite and positive");
  }

  const costBefore = costForPosition(
    account.ethBalance,
    account.weightedCostBasisUSD,
  );

  if (execution.direction === "BUY") {
    const totalDebit = execution.grossNotionalUSD + execution.feeUSD;
    if (totalDebit > account.usdcBalance) {
      throw new AccountingError("Insufficient USDC balance");
    }

    const newQuantity = account.ethBalance + execution.quantityETH;
    const newCost = costBefore + totalDebit;
    const newWeightedCost = divideRounded(
      newCost * scaleFactor(ETH_SCALE),
      newQuantity,
      "nearest",
    );

    return {
      before: account,
      after: {
        ethBalance: newQuantity,
        usdcBalance: account.usdcBalance - totalDebit,
        weightedCostBasisUSD: newWeightedCost,
        dcaCount: account.dcaCount + 1,
      },
      realizedPnlUSD: null,
      costBasisBeforeUSD: account.weightedCostBasisUSD,
      costBasisAfterUSD: newWeightedCost,
    };
  }

  if (execution.quantityETH > account.ethBalance) {
    throw new AccountingError("Insufficient ETH balance");
  }
  if (account.weightedCostBasisUSD === null) {
    throw new AccountingError("SELL requires an open weighted cost basis");
  }

  const soldCost = notionalForQuantity(
    execution.quantityETH,
    account.weightedCostBasisUSD,
  );
  const netProceeds = execution.grossNotionalUSD - execution.feeUSD;
  const realizedPnlUSD = netProceeds - soldCost;
  const remainingQuantity = account.ethBalance - execution.quantityETH;
  const fullExit = execution.fullExit || remainingQuantity === 0n;

  if (fullExit && remainingQuantity !== 0n) {
    throw new AccountingError(
      "A full exit must sell the complete ETH balance",
    );
  }

  return {
    before: account,
    after: {
      ethBalance: remainingQuantity,
      usdcBalance: account.usdcBalance + netProceeds,
      weightedCostBasisUSD: fullExit
        ? null
        : account.weightedCostBasisUSD,
      dcaCount: fullExit ? 0 : account.dcaCount,
    },
    realizedPnlUSD,
    costBasisBeforeUSD: account.weightedCostBasisUSD,
    costBasisAfterUSD: fullExit ? null : account.weightedCostBasisUSD,
  };
}
