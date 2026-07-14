import {
  ETH_SCALE,
  USD_SCALE,
  applyAccountingTransition,
  feeFromBps,
  formatDecimal,
  notionalForQuantity,
  parseDecimal,
  quantityForNotional,
} from "@/trading/accounting";

const usd = (value: string) => parseDecimal(value, USD_SCALE);
const eth = (value: string) => parseDecimal(value, ETH_SCALE);

describe("fixed-point accounting", () => {
  it("round-trips exact decimal values", () => {
    const value = "0.123456789012345678";
    expect(formatDecimal(parseDecimal(value, ETH_SCALE), ETH_SCALE)).toBe(
      value,
    );
  });

  it("derives quantity and fees without floating-point arithmetic", () => {
    const price = usd("1902.85000000");
    const notional = usd("25.00000000");
    const quantity = quantityForNotional(notional, price);
    const gross = notionalForQuantity(quantity, price);

    expect(gross).toBeLessThanOrEqual(notional);
    expect(formatDecimal(feeFromBps(gross, 30), USD_SCALE)).toBe(
      "0.07500000",
    );
  });

  it("maintains weighted cost basis across multiple buys", () => {
    const first = applyAccountingTransition(
      {
        ethBalance: 0n,
        usdcBalance: usd("200.00000000"),
        weightedCostBasisUSD: null,
        dcaCount: 0,
      },
      {
        direction: "BUY",
        quantityETH: eth("0.010000000000000000"),
        grossNotionalUSD: usd("20.00000000"),
        feeUSD: usd("0.06000000"),
        executionPriceUSD: usd("2000.00000000"),
        fullExit: false,
      },
    );
    const second = applyAccountingTransition(first.after, {
      direction: "BUY",
      quantityETH: eth("0.006000000000000000"),
      grossNotionalUSD: usd("15.00000000"),
      feeUSD: usd("0.04500000"),
      executionPriceUSD: usd("2500.00000000"),
      fullExit: false,
    });

    expect(
      formatDecimal(second.after.weightedCostBasisUSD!, USD_SCALE),
    ).toBe("2194.06250000");
    expect(second.after.dcaCount).toBe(2);
  });

  it("keeps cost basis and DCA count on partial sells", () => {
    const transition = applyAccountingTransition(
      {
        ethBalance: eth("0.016000000000000000"),
        usdcBalance: usd("164.89500000"),
        weightedCostBasisUSD: usd("2194.06250000"),
        dcaCount: 2,
      },
      {
        direction: "SELL",
        quantityETH: eth("0.004000000000000000"),
        grossNotionalUSD: usd("10.00000000"),
        feeUSD: usd("0.03000000"),
        executionPriceUSD: usd("2500.00000000"),
        fullExit: false,
      },
    );

    expect(
      formatDecimal(transition.after.weightedCostBasisUSD!, USD_SCALE),
    ).toBe("2194.06250000");
    expect(transition.after.dcaCount).toBe(2);
    expect(formatDecimal(transition.realizedPnlUSD!, USD_SCALE)).toBe(
      "1.19375000",
    );
  });

  it("resets cost basis and DCA count on full exit", () => {
    const transition = applyAccountingTransition(
      {
        ethBalance: eth("0.012000000000000000"),
        usdcBalance: usd("174.86500000"),
        weightedCostBasisUSD: usd("2194.06250000"),
        dcaCount: 2,
      },
      {
        direction: "SELL",
        quantityETH: eth("0.012000000000000000"),
        grossNotionalUSD: usd("30.00000000"),
        feeUSD: usd("0.09000000"),
        executionPriceUSD: usd("2500.00000000"),
        fullExit: true,
      },
    );

    expect(transition.after.ethBalance).toBe(0n);
    expect(transition.after.weightedCostBasisUSD).toBeNull();
    expect(transition.after.dcaCount).toBe(0);
  });

  it("rejects overselling", () => {
    expect(() =>
      applyAccountingTransition(
        {
          ethBalance: eth("0.010000000000000000"),
          usdcBalance: usd("100.00000000"),
          weightedCostBasisUSD: usd("2000.00000000"),
          dcaCount: 1,
        },
        {
          direction: "SELL",
          quantityETH: eth("0.020000000000000000"),
          grossNotionalUSD: usd("40.00000000"),
          feeUSD: usd("0.12000000"),
          executionPriceUSD: usd("2000.00000000"),
          fullExit: false,
        },
      ),
    ).toThrow(/Insufficient ETH/);
  });
});
