// Shared seed data constants used by scripts/generate-seed-sql.ts and tests.
// Extracted from the former prisma/seed.ts.

interface SeedTrade {
  direction: "BUY" | "SELL";
  asset: string;
  amountUSD: number;
  amountAsset: number;
  executionPrice: number;
  feesUSD: number;
  slippage: number;
  pnlUSD: number | null;
  agentReasoning: string;
  hoursAgo: number;
}

interface SeedJournal {
  entryText: string;
  ethPrice: number;
  rsi: number;
  emaShort: number;
  emaLong: number;
  emaCrossover: "bullish" | "bearish" | "neutral";
  hoursAgo: number;
  tradeIndex: number | null;
}

// ── Week 1: Bull-run cycle ──────────────────────────────────────────────────

export const TRADES: SeedTrade[] = [
  // T0 — Initial buy on -3.2% dip from $2,100 anchor
  {
    direction: "BUY",
    asset: "ETH",
    amountUSD: 35,
    amountAsset: 0.0172,
    executionPrice: 2035,
    feesUSD: 0.11,
    slippage: 0.002,
    pnlUSD: null,
    agentReasoning:
      "ETH dropped 3.2% from anchor $2,100 to $2,035. RSI(14) at 34 — approaching oversold. EMA(12) $2,050 below EMA(26) $2,080 — bearish but flattening. Initiating position with moderate $35 buy. Will DCA if it falls further. Stop-loss at $1,730 (-15%).",
    hoursAgo: 312,
  },
  // T1 — DCA buy #2, ETH continued falling
  {
    direction: "BUY",
    asset: "ETH",
    amountUSD: 25,
    amountAsset: 0.0128,
    executionPrice: 1953,
    feesUSD: 0.08,
    slippage: 0.003,
    pnlUSD: null,
    agentReasoning:
      "DCA buy #2. ETH fell to $1,953 — now -7% from anchor. RSI(14) at 24, deeply oversold. Portfolio value $180, still above $150 killswitch. Reducing size to $25. Weighted avg entry now $2,001. 2 of 3 DCA buys used.",
    hoursAgo: 288,
  },
  // T2 — DCA buy #3 (max), catching the bottom
  {
    direction: "BUY",
    asset: "ETH",
    amountUSD: 15,
    amountAsset: 0.008,
    executionPrice: 1875,
    feesUSD: 0.05,
    slippage: 0.004,
    pnlUSD: null,
    agentReasoning:
      "DCA buy #3 (final). ETH at $1,875, -10.7% from anchor. RSI(14) at 19 — extreme oversold territory. Small $15 position, preserving capital. Portfolio value $166, approaching drawdown zone. No more DCA available. Avg entry now $1,967.",
    hoursAgo: 264,
  },
  // T3 — Partial sell on recovery (3% above avg entry)
  {
    direction: "SELL",
    asset: "ETH",
    amountUSD: 30,
    amountAsset: 0.0148,
    executionPrice: 2027,
    feesUSD: 0.09,
    slippage: 0.001,
    pnlUSD: 0.89,
    agentReasoning:
      "ETH recovered to $2,027 — +3.1% above avg entry $1,967. RSI(14) at 58, neutral-bullish. EMA(12) crossed above EMA(26) — confirmed bullish crossover. Taking partial profit $30 to secure gains. Still holding 0.0232 ETH (~$47).",
    hoursAgo: 216,
  },
  // T4 — Sell remaining on continued rally
  {
    direction: "SELL",
    asset: "ETH",
    amountUSD: 47.5,
    amountAsset: 0.0232,
    executionPrice: 2048,
    feesUSD: 0.14,
    slippage: 0.001,
    pnlUSD: 1.62,
    agentReasoning:
      "ETH at $2,048, +4.1% above avg entry. RSI(14) at 67, nearing overbought. Selling remaining 0.0232 ETH ($47.50) to close the position. Total cycle P&L: +$2.51 on $75 invested. Re-establishing anchor at $2,048 for next cycle.",
    hoursAgo: 192,
  },

  // ── Week 2: Bear crash → stop-loss → cautious recovery ───────────────────

  // T5 — Fresh buy after reset
  {
    direction: "BUY",
    asset: "ETH",
    amountUSD: 40,
    amountAsset: 0.019,
    executionPrice: 2105,
    feesUSD: 0.12,
    slippage: 0.002,
    pnlUSD: null,
    agentReasoning:
      "New cycle. ETH rallied to $2,105. RSI(14) at 55, healthy trend. EMA(12) $2,090 above EMA(26) $2,060 — bullish momentum. Entering with $40 buy. Anchor set at $2,105. Stop-loss at $1,789 (-15%).",
    hoursAgo: 144,
  },
  // T6 — DCA into crash
  {
    direction: "BUY",
    asset: "ETH",
    amountUSD: 30,
    amountAsset: 0.0167,
    executionPrice: 1796,
    feesUSD: 0.09,
    slippage: 0.005,
    pnlUSD: null,
    agentReasoning:
      "Major selloff. ETH crashed to $1,796 — down 14.7% from entry. RSI(14) at 15, extreme oversold panic. DCA buy #1 at $30. Weighted avg entry now $1,968. Portfolio value $161 — dangerously close to $150 killswitch. Slippage elevated at 0.5%.",
    hoursAgo: 120,
  },
  // T7 — Stop-loss sell: -15% breached on the position
  {
    direction: "SELL",
    asset: "ETH",
    amountUSD: 59.57,
    amountAsset: 0.0357,
    executionPrice: 1669,
    feesUSD: 0.18,
    slippage: 0.008,
    pnlUSD: -10.43,
    agentReasoning:
      "STOP-LOSS TRIGGERED. ETH crashed to $1,669 — down 15.2% from weighted avg entry $1,968. Exceeds -15% stop-loss threshold. Liquidating entire 0.0357 ETH position at a loss. Portfolio value $156. P&L on this cycle: -$10.43. Switching to observation mode.",
    hoursAgo: 96,
  },
  // T8 — Cautious re-entry after recovery
  {
    direction: "BUY",
    asset: "ETH",
    amountUSD: 20,
    amountAsset: 0.0108,
    executionPrice: 1852,
    feesUSD: 0.06,
    slippage: 0.002,
    pnlUSD: null,
    agentReasoning:
      "Cautious re-entry. ETH recovered to $1,852 from crash low of $1,669 (+11%). RSI(14) at 42, recovering from oversold. Small $20 position — capital preservation is priority after the stop-loss. Anchor at $1,852. Stop-loss at $1,574.",
    hoursAgo: 48,
  },
  // T9 — Small profit-taking sell
  {
    direction: "SELL",
    asset: "ETH",
    amountUSD: 10.5,
    amountAsset: 0.0055,
    executionPrice: 1909,
    feesUSD: 0.03,
    slippage: 0.001,
    pnlUSD: 0.32,
    agentReasoning:
      "Partial profit. ETH at $1,909, +3.1% above entry $1,852. RSI(14) at 56. Taking small $10.50 off the table to lock gains. Still holding 0.0053 ETH (~$10). Conservative approach after recent stop-loss.",
    hoursAgo: 24,
  },
];

export const JOURNALS: SeedJournal[] = [
  {
    entryText:
      "Initial market scan. ETH at $2,100, consolidating after a +8% weekly rally. RSI(14) at 52 — neutral. EMA(12) and EMA(26) tightly converged at $2,080/$2,085 — no clear signal. Waiting for a -3% dip to enter. Portfolio: $200 USDC, no ETH exposure.",
    ethPrice: 2100,
    rsi: 52,
    emaShort: 2080,
    emaLong: 2085,
    emaCrossover: "neutral",
    hoursAgo: 336,
    tradeIndex: null,
  },
  {
    entryText:
      "Dip arrived. ETH dropped 3.2% to $2,035 — triggered buy zone. Entered with $35 position. RSI dropping into oversold territory. Will DCA if it falls further. Stop-loss set at $1,730 (-15% from entry).",
    ethPrice: 2035,
    rsi: 34,
    emaShort: 2050,
    emaLong: 2080,
    emaCrossover: "bearish",
    hoursAgo: 312,
    tradeIndex: 0,
  },
  {
    entryText:
      "ETH continued falling to $1,953. DCA buy #2 executed at $25. RSI at 24 — extreme oversold. Portfolio value dropped to ~$180 but still safe above $150 killswitch. Avg entry now $2,001. One DCA buy remaining.",
    ethPrice: 1953,
    rsi: 24,
    emaShort: 1970,
    emaLong: 2040,
    emaCrossover: "bearish",
    hoursAgo: 288,
    tradeIndex: 1,
  },
  {
    entryText:
      "Bottom-fishing with final DCA buy. ETH at $1,875 — RSI at 19 (panic oversold). Only $15 to preserve capital. Portfolio value $166 — getting close to danger zone. No more DCA available. Need recovery to $1,967+ to break even.",
    ethPrice: 1875,
    rsi: 19,
    emaShort: 1910,
    emaLong: 2010,
    emaCrossover: "bearish",
    hoursAgo: 264,
    tradeIndex: 2,
  },
  {
    entryText:
      "ETH bouncing at $1,940. Recovery underway but only +3.5% from bottom. RSI recovering to 44. EMA(12) curling up toward EMA(26). Not yet at +3% from avg entry ($1,967). Holding position, no action.",
    ethPrice: 1940,
    rsi: 44,
    emaShort: 1950,
    emaLong: 2000,
    emaCrossover: "bearish",
    hoursAgo: 240,
    tradeIndex: null,
  },
  {
    entryText:
      "Recovery confirmed! ETH at $2,027, +3.1% above avg entry. EMA bullish crossover. Taking partial profit of $30. Keeping some exposure for further upside. Cycle is turning profitable.",
    ethPrice: 2027,
    rsi: 58,
    emaShort: 2020,
    emaLong: 2000,
    emaCrossover: "bullish",
    hoursAgo: 216,
    tradeIndex: 3,
  },
  {
    entryText:
      "Closing Week 1 position. ETH at $2,048, RSI nearing overbought at 67. Sold remaining 0.0232 ETH. Total cycle P&L: +$2.51. Resetting anchor. Good first cycle — system worked as designed.",
    ethPrice: 2048,
    rsi: 67,
    emaShort: 2040,
    emaLong: 2010,
    emaCrossover: "bullish",
    hoursAgo: 192,
    tradeIndex: 4,
  },
  {
    entryText:
      "Post-cycle observation. ETH ranging $2,050–$2,090. RSI cooling to 54. No clear entry signal — waiting for a -3% dip from new anchor $2,048. Portfolio fully in USDC: $202.51 (up from $200 initial). System performing as expected.",
    ethPrice: 2070,
    rsi: 54,
    emaShort: 2060,
    emaLong: 2040,
    emaCrossover: "bullish",
    hoursAgo: 168,
    tradeIndex: null,
  },
  {
    entryText:
      "New cycle entry. ETH rallied to $2,105. Momentum is strong. Entering with $40 position, slightly larger than usual given bullish EMA structure. Anchor at $2,105.",
    ethPrice: 2105,
    rsi: 55,
    emaShort: 2090,
    emaLong: 2060,
    emaCrossover: "bullish",
    hoursAgo: 144,
    tradeIndex: 5,
  },
  {
    entryText:
      "BLACK SWAN. ETH crashed 14.7% to $1,796. Market-wide liquidations. RSI at 15 — haven't seen this in weeks. DCA buy at $30 but portfolio value is $161 — VERY close to $150 killswitch. Slippage was 0.5% — liquidity is thin. This is a high-risk moment.",
    ethPrice: 1796,
    rsi: 15,
    emaShort: 1850,
    emaLong: 2020,
    emaCrossover: "bearish",
    hoursAgo: 120,
    tradeIndex: 6,
  },
  {
    entryText:
      "STOP-LOSS EXECUTED. ETH hit $1,669, -15.2% from avg entry. Sold entire position at a loss. P&L: -$10.43. Slippage was 0.8% — terrible execution in the panic. Portfolio now $156 USDC. Need to be extremely cautious. Switching to observation mode — no trades until RSI recovers above 30.",
    ethPrice: 1669,
    rsi: 11,
    emaShort: 1750,
    emaLong: 1980,
    emaCrossover: "bearish",
    hoursAgo: 96,
    tradeIndex: 7,
  },
  {
    entryText:
      "Post-crash observation. ETH recovering slowly to $1,780. RSI back to 28 — still oversold but improving. Not ready to re-enter yet. Need to see RSI above 35 and some EMA convergence. Portfolio: $156 USDC. Lesson learned: the crash was too fast for my 1-hour cron to react properly.",
    ethPrice: 1780,
    rsi: 28,
    emaShort: 1770,
    emaLong: 1920,
    emaCrossover: "bearish",
    hoursAgo: 72,
    tradeIndex: null,
  },
  {
    entryText:
      "Cautious re-entry. ETH at $1,852, recovered +11% from crash low. RSI at 42 — healthy. Entering with only $20 — capital preservation mode after the stop-loss. Small position, tight stop.",
    ethPrice: 1852,
    rsi: 42,
    emaShort: 1840,
    emaLong: 1880,
    emaCrossover: "bearish",
    hoursAgo: 48,
    tradeIndex: 8,
  },
  {
    entryText:
      "Small win. ETH at $1,909, +3.1% above entry. Taking $10.50 partial profit. Conservative approach — locking in gains quickly after the stop-loss experience. Still holding 0.0053 ETH ($10.12).",
    ethPrice: 1909,
    rsi: 56,
    emaShort: 1900,
    emaLong: 1870,
    emaCrossover: "bullish",
    hoursAgo: 24,
    tradeIndex: 9,
  },
  {
    entryText:
      "Current status: holding 0.0053 ETH ($10.60) + $182.13 USDC = ~$192.73 portfolio. ETH at $2,000, continuing recovery. RSI at 51, neutral. EMA crossover is bullish. Will hold current position and look for +3% exit at $1,908+ or cut at -15% ($1,574). Running total P&L from all cycles: -$7.60 (first cycle +$2.51, second cycle -$10.43, third cycle +$0.32 so far).",
    ethPrice: 2000,
    rsi: 51,
    emaShort: 1960,
    emaLong: 1900,
    emaCrossover: "bullish",
    hoursAgo: 3,
    tradeIndex: null,
  },
];

export const FINAL_AGENT_STATE = {
  lastTradePrice: 1909,
  currentPositionETH: 0.0053,
  currentPositionUSDC: 182.13,
  portfolioValueUSD: 192.73,
  isLocked: false,
  isRunning: false,
};
