import {
  USD_SCALE,
  feeFromBps,
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

  // Case 1: SELL slippage decreases execution price
  it("models SELL slippage — executionPriceUSD < observedPriceUSD", () => {
    const observedPrice = parseDecimal("2000.00000000", USD_SCALE);
    const result = calculatePaperExecution(
      {
        account: {
          ethBalance: parseDecimal("1.000000000000000000", 18),
          usdcBalance: parseDecimal("0.00000000", USD_SCALE),
          weightedCostBasisUSD: parseDecimal("1800.00000000", USD_SCALE),
          dcaCount: 1,
        },
        direction: "SELL",
        requestedNotionalUSD: parseDecimal("500.00000000", USD_SCALE),
        observedPriceUSD: observedPrice,
        feeBps: 30,
        slippageBps: 20,
        fullExit: false,
        initialCapitalUSD: parseDecimal("1800.00000000", USD_SCALE),
        peakPortfolioValueUSD: parseDecimal("2000.00000000", USD_SCALE),
      },
      USD_SCALE,
    );
    expect(result.executionPriceUSD).toBeLessThan(observedPrice);
    expect(result.slippageUSD).toBe(
      result.observedNotionalUSD > result.grossNotionalUSD
        ? result.observedNotionalUSD - result.grossNotionalUSD
        : result.grossNotionalUSD - result.observedNotionalUSD,
    );
  });

  // Case 2: Partial SELL — quantity derived from observedPrice, grossNotional uses executionPrice
  it("partial SELL uses observedPriceUSD for quantity and executionPriceUSD for grossNotional", () => {
    const observedPrice = parseDecimal("2000.00000000", USD_SCALE);
    const result = calculatePaperExecution(
      {
        account: {
          ethBalance: parseDecimal("1.000000000000000000", 18),
          usdcBalance: parseDecimal("0.00000000", USD_SCALE),
          weightedCostBasisUSD: parseDecimal("1800.00000000", USD_SCALE),
          dcaCount: 1,
        },
        direction: "SELL",
        requestedNotionalUSD: parseDecimal("400.00000000", USD_SCALE),
        observedPriceUSD: observedPrice,
        feeBps: 30,
        slippageBps: 10,
        fullExit: false,
        initialCapitalUSD: parseDecimal("1800.00000000", USD_SCALE),
        peakPortfolioValueUSD: parseDecimal("2000.00000000", USD_SCALE),
      },
      USD_SCALE,
    );
    // grossNotionalUSD = quantityETH * executionPriceUSD (below observed)
    expect(result.grossNotionalUSD).toBeLessThan(result.observedNotionalUSD);
    // USDC balance increases by grossNotional - fee
    expect(result.transition.after.usdcBalance).toBe(
      result.grossNotionalUSD - result.feeUSD,
    );
  });

  // Case 3: Full exit — entire ETH balance sold
  it("full exit sells entire ethBalance and zeroes out position", () => {
    const ethBalance = parseDecimal("0.500000000000000000", 18);
    const result = calculatePaperExecution(
      {
        account: {
          ethBalance,
          usdcBalance: parseDecimal("50.00000000", USD_SCALE),
          weightedCostBasisUSD: parseDecimal("1900.00000000", USD_SCALE),
          dcaCount: 1,
        },
        direction: "SELL",
        requestedNotionalUSD: parseDecimal("100.00000000", USD_SCALE),
        observedPriceUSD: parseDecimal("2000.00000000", USD_SCALE),
        feeBps: 30,
        slippageBps: 10,
        fullExit: true,
        initialCapitalUSD: parseDecimal("1000.00000000", USD_SCALE),
        peakPortfolioValueUSD: parseDecimal("1050.00000000", USD_SCALE),
      },
      USD_SCALE,
    );
    expect(result.quantityETH).toBe(ethBalance);
    expect(result.transition.after.ethBalance).toBe(0n);
    expect(result.transition.after.weightedCostBasisUSD).toBeNull();
    expect(result.transition.after.dcaCount).toBe(0);
  });

  // Case 4: Fee ceiling rounding — non-divisible notional rounds up
  it("feeFromBps rounds fee up (ceiling) when not evenly divisible", () => {
    // 10_001 * 30 = 300_030; 300_030 / 10_000 = 30.003 → ceil = 31
    const notional = 10_001n;
    const fee = feeFromBps(notional, 30);
    expect(fee).toBe(31n);
    // confirm it is strictly greater than floor
    expect(fee).toBeGreaterThan((notional * 30n) / 10_000n);
  });

  // Case 5: Zero-rounding boundary — bps = 0
  it("zero feeBps produces zero fee; zero slippageBps produces no slippage", () => {
    const observedPrice = parseDecimal("2000.00000000", USD_SCALE);
    const result = calculatePaperExecution(
      {
        account: {
          ethBalance: 0n,
          usdcBalance: parseDecimal("200.00000000", USD_SCALE),
          weightedCostBasisUSD: null,
          dcaCount: 0,
        },
        direction: "BUY",
        requestedNotionalUSD: parseDecimal("100.00000000", USD_SCALE),
        observedPriceUSD: observedPrice,
        feeBps: 0,
        slippageBps: 0,
        fullExit: false,
        initialCapitalUSD: parseDecimal("200.00000000", USD_SCALE),
        peakPortfolioValueUSD: parseDecimal("200.00000000", USD_SCALE),
      },
      USD_SCALE,
    );
    expect(result.feeUSD).toBe(0n);
    expect(result.executionPriceUSD).toBe(observedPrice);
    expect(result.slippageUSD).toBe(0n);
  });

  // Case 6: Maximum bps = 10_000 on BUY doubles the price, no overflow
  it("slippageBps = 10_000 on BUY doubles executionPriceUSD without overflow", () => {
    const observedPrice = parseDecimal("2000.00000000", USD_SCALE);
    const result = calculatePaperExecution(
      {
        account: {
          ethBalance: 0n,
          usdcBalance: parseDecimal("10000.00000000", USD_SCALE),
          weightedCostBasisUSD: null,
          dcaCount: 0,
        },
        direction: "BUY",
        requestedNotionalUSD: parseDecimal("100.00000000", USD_SCALE),
        observedPriceUSD: observedPrice,
        feeBps: 0,
        slippageBps: 10_000,
        fullExit: false,
        initialCapitalUSD: parseDecimal("10000.00000000", USD_SCALE),
        peakPortfolioValueUSD: parseDecimal("10000.00000000", USD_SCALE),
      },
      USD_SCALE,
    );
    expect(result.executionPriceUSD).toBe(observedPrice * 2n);
  });

  // Case 7: Drawdown boundaries
  it("calculateDrawdownPct — below / at / above peak", () => {
    const peak = parseDecimal("1000.00000000", USD_SCALE);
    // Below peak → positive drawdown
    expect(
      calculateDrawdownPct(peak, parseDecimal("900.00000000", USD_SCALE), USD_SCALE),
    ).toBeGreaterThan(0n);
    // At peak → 0
    expect(calculateDrawdownPct(peak, peak, USD_SCALE)).toBe(0n);
    // Above peak → 0 (clamped)
    expect(
      calculateDrawdownPct(peak, parseDecimal("1100.00000000", USD_SCALE), USD_SCALE),
    ).toBe(0n);
  });

  // Case 8: No negative balances after any valid BUY or SELL
  it("no negative balances after valid BUY and SELL", () => {
    const buyResult = calculatePaperExecution(
      {
        account: {
          ethBalance: 0n,
          usdcBalance: parseDecimal("500.00000000", USD_SCALE),
          weightedCostBasisUSD: null,
          dcaCount: 0,
        },
        direction: "BUY",
        requestedNotionalUSD: parseDecimal("200.00000000", USD_SCALE),
        observedPriceUSD: parseDecimal("2000.00000000", USD_SCALE),
        feeBps: 30,
        slippageBps: 15,
        fullExit: false,
        initialCapitalUSD: parseDecimal("500.00000000", USD_SCALE),
        peakPortfolioValueUSD: parseDecimal("500.00000000", USD_SCALE),
      },
      USD_SCALE,
    );
    expect(buyResult.transition.after.ethBalance).toBeGreaterThanOrEqual(0n);
    expect(buyResult.transition.after.usdcBalance).toBeGreaterThanOrEqual(0n);

    const sellResult = calculatePaperExecution(
      {
        account: buyResult.transition.after,
        direction: "SELL",
        requestedNotionalUSD: parseDecimal("100.00000000", USD_SCALE),
        observedPriceUSD: parseDecimal("2000.00000000", USD_SCALE),
        feeBps: 30,
        slippageBps: 15,
        fullExit: false,
        initialCapitalUSD: parseDecimal("500.00000000", USD_SCALE),
        peakPortfolioValueUSD: buyResult.peakPortfolioValueUSD,
      },
      USD_SCALE,
    );
    expect(sellResult.transition.after.ethBalance).toBeGreaterThanOrEqual(0n);
    expect(sellResult.transition.after.usdcBalance).toBeGreaterThanOrEqual(0n);
  });
});
