import {
  USD_SCALE,
  formatDecimal,
  parseDecimal,
} from "@/trading/accounting";
import {
  calculateDrawdownPct,
  calculatePaperExecution,
} from "@/trading/paper-execution";

describe("paper execution calculation", () => {
  it("models a production BUY with exact accounting and post-trade equity", () => {
    const result = calculatePaperExecution(
      {
        account: {
          ethBalance: 0n,
          usdcBalance: parseDecimal("200.00000000", USD_SCALE),
          weightedCostBasisUSD: null,
          dcaCount: 0,
        },
        direction: "BUY",
        requestedNotionalUSD: parseDecimal("50.00000000", USD_SCALE),
        observedPriceUSD: parseDecimal("1940.00000000", USD_SCALE),
        feeBps: 30,
        slippageBps: 15,
        fullExit: false,
        initialCapitalUSD: parseDecimal("200.00000000", USD_SCALE),
        peakPortfolioValueUSD: parseDecimal("200.00000000", USD_SCALE),
      },
      USD_SCALE,
    );

    expect(formatDecimal(result.executionPriceUSD, USD_SCALE)).toBe(
      "1942.91000000",
    );
    expect(formatDecimal(result.feeUSD, USD_SCALE)).toBe("0.15000000");
    expect(formatDecimal(result.slippageUSD, USD_SCALE)).toBe(
      "0.07488766",
    );
    expect(formatDecimal(result.portfolioValueUSD, USD_SCALE)).toBe(
      "199.77511234",
    );
    expect(formatDecimal(result.drawdownPct, USD_SCALE)).toBe(
      "0.11244383",
    );
  });

  it("returns zero drawdown at a new peak", () => {
    expect(
      calculateDrawdownPct(
        parseDecimal("200.00000000", USD_SCALE),
        parseDecimal("201.00000000", USD_SCALE),
        USD_SCALE,
      ),
    ).toBe(0n);
  });
});
