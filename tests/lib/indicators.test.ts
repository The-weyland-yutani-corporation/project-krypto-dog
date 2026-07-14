import { calculateEMA, calculateRSI } from "@/lib/indicators";

describe("calculateRSI", () => {
  it("returns neutral when history is insufficient", () => {
    expect(calculateRSI([100, 101], 14)).toBe(50);
  });

  it("returns neutral for a flat market", () => {
    expect(calculateRSI(Array.from({ length: 20 }, () => 100), 14)).toBe(50);
  });

  it("returns 100 for an uninterrupted gain series", () => {
    expect(
      calculateRSI(
        Array.from({ length: 20 }, (_, index) => 100 + index),
        14,
      ),
    ).toBe(100);
  });

  it("returns 0 for an uninterrupted loss series", () => {
    expect(
      calculateRSI(
        Array.from({ length: 20 }, (_, index) => 100 - index),
        14,
      ),
    ).toBe(0);
  });
});

describe("calculateEMA", () => {
  it("returns zero for an empty series", () => {
    expect(calculateEMA([], 12)).toBe(0);
  });

  it("uses the available average when history is shorter than the period", () => {
    expect(calculateEMA([10, 20, 30], 12)).toBe(20);
  });

  it("weights newer observations more heavily", () => {
    const ema = calculateEMA([10, 10, 10, 20], 3);
    expect(ema).toBe(15);
  });
});
