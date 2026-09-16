-- add_market_integrity
--
-- Two latent gaps that a single market never exposed but eight will:
--
--   1. "Market".symbol had no uniqueness constraint (the only index was the
--      Market_pkey on id), so two rows could claim "BTC-PERP" — and every
--      symbol→id lookup in the app would then resolve nondeterministically.
--
--   2. "Order".marketId was the ONE market-carrying column with no foreign key.
--      Fill, Position, OracleSnapshot and FundingUpdate all have one. Without
--      it an order could be accepted for a market that was never registered,
--      and would then sit unmatched forever (the matcher's oracle-band filter
--      fails closed when it cannot read Market.lastOraclePrice).
--
-- Both statements are guarded so this migration is safe to re-run and safe on
-- a database where the constraints were added by hand.

-- 1. Unique market symbols.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Market_symbol_key'
  ) THEN
    ALTER TABLE "Market" ADD CONSTRAINT "Market_symbol_key" UNIQUE ("symbol");
  END IF;
END $$;

-- 2. Order.marketId → Market.id.
--    RESTRICT, not CASCADE: de-listing a market must never silently delete the
--    order history that settled against it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Order_marketId_fkey'
  ) THEN
    ALTER TABLE "Order"
      ADD CONSTRAINT "Order_marketId_fkey"
      FOREIGN KEY ("marketId") REFERENCES "Market"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
