-- Deterministic ledger attestation and explicit anchor provenance (issue #130).
-- Existing ledger and state rows are preserved. Legacy observations are
-- classified rather than silently reseeded or rewritten.
SET ROLE "krypto_schema_owner";
--> statement-breakpoint
ALTER TABLE "krypto"."AgentState" ADD COLUMN "referencePriceAnchor" jsonb;--> statement-breakpoint
ALTER TABLE "krypto"."AgentState" ADD COLUMN "lastBuyPriceAnchor" jsonb;--> statement-breakpoint
ALTER TABLE "krypto"."AgentState" ADD COLUMN "peakPortfolioValueAnchor" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "krypto"."AgentState" ADD COLUMN "portfolioValueObservation" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "krypto"."AgentState"
SET
  "referencePriceAnchor" = CASE
    WHEN "referencePriceUSD" IS NULL THEN NULL
    ELSE jsonb_build_object(
      'observedAt', to_char("updatedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'source', 'legacy-migration-0011',
      'maxAgeSeconds', 3600,
      'releaseId', 'legacy-release',
      'configVersion', "strategyVersion",
      'observedPriceUSD', "referencePriceUSD"::text,
      'observedPortfolioValueUSD', NULL
    )
  END,
  "lastBuyPriceAnchor" = CASE
    WHEN "lastBuyPriceUSD" IS NULL THEN NULL
    ELSE jsonb_build_object(
      'observedAt', to_char("updatedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'source', 'legacy-migration-0011',
      'maxAgeSeconds', 3600,
      'releaseId', 'legacy-release',
      'configVersion', "strategyVersion",
      'observedPriceUSD', "lastBuyPriceUSD"::text,
      'observedPortfolioValueUSD', NULL
    )
  END,
  "peakPortfolioValueAnchor" = jsonb_build_object(
    'observedAt', to_char("updatedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'source', 'legacy-migration-0011',
    'maxAgeSeconds', 3600,
    'releaseId', 'legacy-release',
    'configVersion', "strategyVersion",
    'observedPriceUSD', CASE
      WHEN "currentPositionETHDecimal" = 0 THEN NULL
      ELSE "lastTradePriceDecimal"::text
    END,
    'observedPortfolioValueUSD', "peakPortfolioValueUSD"::text
  ),
  "portfolioValueObservation" = jsonb_build_object(
    'observedAt', to_char("updatedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'source', 'legacy-migration-0011',
    'maxAgeSeconds', 3600,
    'releaseId', 'legacy-release',
    'configVersion', "strategyVersion",
    'observedPriceUSD', CASE
      WHEN "currentPositionETHDecimal" = 0 THEN NULL
      ELSE "lastTradePriceDecimal"::text
    END,
    'observedPortfolioValueUSD', "portfolioValueUSDDecimal"::text
  )
WHERE id = 'singleton';
--> statement-breakpoint
ALTER TABLE "krypto"."AgentState" ADD CONSTRAINT "AgentState_reference_anchor_pair_check" CHECK (("krypto"."AgentState"."referencePriceUSD" IS NULL AND "krypto"."AgentState"."referencePriceAnchor" IS NULL)
        OR ("krypto"."AgentState"."referencePriceUSD" IS NOT NULL AND jsonb_typeof("krypto"."AgentState"."referencePriceAnchor") = 'object'));--> statement-breakpoint
ALTER TABLE "krypto"."AgentState" ADD CONSTRAINT "AgentState_last_buy_anchor_pair_check" CHECK (("krypto"."AgentState"."lastBuyPriceUSD" IS NULL AND "krypto"."AgentState"."lastBuyPriceAnchor" IS NULL)
        OR ("krypto"."AgentState"."lastBuyPriceUSD" IS NOT NULL AND jsonb_typeof("krypto"."AgentState"."lastBuyPriceAnchor") = 'object'));--> statement-breakpoint
ALTER TABLE "krypto"."AgentState" ADD CONSTRAINT "AgentState_peak_anchor_object_check" CHECK (jsonb_typeof("krypto"."AgentState"."peakPortfolioValueAnchor") = 'object');--> statement-breakpoint
ALTER TABLE "krypto"."AgentState" ADD CONSTRAINT "AgentState_portfolio_observation_object_check" CHECK (jsonb_typeof("krypto"."AgentState"."portfolioValueObservation") = 'object');
--> statement-breakpoint
UPDATE "krypto"."RuntimeContract"
SET
  "schemaFingerprint" = '0011_ledger_attestation_anchors_v1',
  "contractVersion" = 3,
  "updatedAt" = now()
WHERE id = 'singleton';
--> statement-breakpoint
RESET ROLE;