import { calculateATR, calculateRSI, calculateEMA } from "@/lib/indicators";
import { ATR_PERIOD } from "@/lib/config";

describe("calculateATR", () => {
  it("computes Wilder-smoothed ATR for a known series", () => {
    // Bars (aligned high/low/close):
    //   0: 10 / 8  / 9
    //   1: 12 / 9  / 11
    //   2: 13 / 11 / 12
    //   3: 14 / 12 / 13
    // True ranges (i >= 1):
    //   TR1 = max(12-9, |12-9|, |9-9|)   = 3
    //   TR2 = max(13-11, |13-11|, |11-11|) = 2
    //   TR3 = max(14-12, |14-13|, |12-13|) = 2
    // period=2: seed = (3+2)/2 = 2.5; smoothed = (2.5*1 + 2)/2 = 2.25
    const highs = [10, 12, 13, 14];
    const lows = [8, 9, 11, 12];
    const closes = [9, 11, 12, 13];

    expect(calculateATR(highs, lows, closes, 2)).toBeCloseTo(2.25, 10);
  });

  it("converges to the constant true range when every bar has the same range", () => {
    // Each bar spans +/-1 around a rising close, so every true range is 2.
    const highs: number[] = [];
    const lows: number[] = [];
    const closes: number[] = [];
    for (let i = 0; i < 20; i++) {
      highs.push(100 + i + 1);
      lows.push(100 + i - 1);
      closes.push(100 + i);
    }

    expect(calculateATR(highs, lows, closes, ATR_PERIOD)).toBeCloseTo(2, 10);
  });

  it("returns 0 for a flat market (no intrabar range or movement)", () => {
    const flat = [100, 100, 100, 100, 100];
    expect(calculateATR(flat, flat, flat, 3)).toBe(0);
  });

  it("returns 0 when there is insufficient data (fewer than period + 1 bars)", () => {
    // period + 1 = 4 bars required; only 3 provided.
    const highs = [10, 11, 12];
    const lows = [9, 10, 11];
    const closes = [9.5, 10.5, 11.5];
    expect(calculateATR(highs, lows, closes, 3)).toBe(0);
  });

  it("returns 0 for a non-positive period", () => {
    const highs = [10, 11, 12, 13];
    const lows = [9, 10, 11, 12];
    const closes = [9.5, 10.5, 11.5, 12.5];
    expect(calculateATR(highs, lows, closes, 0)).toBe(0);
  });

  it("uses the shortest array length when inputs are misaligned", () => {
    // closes is shorter, so only the first 4 aligned bars are considered,
    // reproducing the period=2 known-series result of 2.25.
    const highs = [10, 12, 13, 14, 99];
    const lows = [8, 9, 11, 12, 0];
    const closes = [9, 11, 12, 13];
    expect(calculateATR(highs, lows, closes, 2)).toBeCloseTo(2.25, 10);
  });

  it("captures gap-driven true range via the previous close", () => {
    // A gap up on bar 1 makes |high - prevClose| the dominant true range.
    //   0: 10 / 9  / 9
    //   1: 30 / 25 / 28  -> TR = max(30-25, |30-9|, |25-9|) = 21
    //   2: 31 / 27 / 29  -> TR = max(31-27, |31-28|, |27-28|) = 4
    // period=1: seed = TR1 = 21; smoothed = (21*0 + 4)/1 = 4
    const highs = [10, 30, 31];
    const lows = [9, 25, 27];
    const closes = [9, 28, 29];
    expect(calculateATR(highs, lows, closes, 1)).toBeCloseTo(4, 10);
  });
});

describe("calculateRSI", () => {
  it("returns neutral 50 when there is insufficient data", () => {
    expect(calculateRSI([100, 101], 14)).toBe(50);
  });

  it("returns 100 when there are only gains (no losses)", () => {
    const closes = [10, 11, 12, 13, 14, 15];
    expect(calculateRSI(closes, 3)).toBe(100);
  });
});

describe("calculateEMA", () => {
  it("returns 0 for an empty series", () => {
    expect(calculateEMA([], 12)).toBe(0);
  });

  it("returns the constant value for a flat series", () => {
    expect(calculateEMA([50, 50, 50, 50, 50], 3)).toBeCloseTo(50, 10);
  });
});
