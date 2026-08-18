import { formatDecimal, USD_SCALE } from "./accounting";

/**
 * Promotion anchors are deliberately shorter lived than an approval. A shadow
 * observation older than one hourly decision window cannot become the first
 * PAPER trigger.
 */
export const PAPER_ANCHOR_MAX_AGE_SECONDS = 60 * 60;

export const ANCHOR_SOURCES = [
  "account-initialization",
  "legacy-migration-0011",
  "mark-to-market",
  "paper-buy",
  "paper-full-exit",
  "paper-sell",
  "shadow-reference",
] as const;

export type AnchorSource = (typeof ANCHOR_SOURCES)[number];

export interface PriceAnchorMetadata {
  observedAt: string;
  source: AnchorSource;
  maxAgeSeconds: number;
  releaseId: string;
  configVersion: string;
  observedPriceUSD: string | null;
  observedPortfolioValueUSD: string | null;
}

export function createPriceAnchorMetadata(input: {
  observedAt: Date;
  source: AnchorSource;
  releaseId: string;
  configVersion: string;
  observedPriceUSD: bigint | null;
  observedPortfolioValueUSD?: bigint | null;
  maxAgeSeconds?: number;
}): PriceAnchorMetadata {
  if (Number.isNaN(input.observedAt.getTime())) {
    throw new Error("Anchor observation time must be valid");
  }
  if (!input.releaseId || !input.configVersion) {
    throw new Error("Anchor release and config attribution are required");
  }
  const maxAgeSeconds =
    input.maxAgeSeconds ?? PAPER_ANCHOR_MAX_AGE_SECONDS;
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds <= 0) {
    throw new Error("Anchor maximum age must be a positive integer");
  }
  return {
    observedAt: input.observedAt.toISOString(),
    source: input.source,
    maxAgeSeconds,
    releaseId: input.releaseId,
    configVersion: input.configVersion,
    observedPriceUSD:
      input.observedPriceUSD === null
        ? null
        : formatDecimal(input.observedPriceUSD, USD_SCALE),
    observedPortfolioValueUSD:
      input.observedPortfolioValueUSD === undefined ||
      input.observedPortfolioValueUSD === null
        ? null
        : formatDecimal(input.observedPortfolioValueUSD, USD_SCALE),
  };
}
