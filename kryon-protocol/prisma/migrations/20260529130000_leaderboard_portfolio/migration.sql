-- Leaderboard + Portfolio schema.
-- Written idempotently (IF NOT EXISTS / DO blocks) so it can be applied safely
-- against the live Neon database without a destructive reset.

-- ── Enums ────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "StatsPeriod" AS ENUM ('DAY', 'WEEK', 'MONTH', 'ALL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "PnlEventKind" AS ENUM ('REALIZED_TRADE', 'FUNDING', 'LIQUIDATION', 'FEE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "BalanceChangeKind" AS ENUM ('DEPOSIT', 'WITHDRAWAL', 'TRANSFER_IN', 'TRANSFER_OUT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── TraderStat ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "TraderStat" (
  "id"               TEXT PRIMARY KEY,
  "network"          TEXT NOT NULL,
  "address"          TEXT NOT NULL,
  "period"           "StatsPeriod" NOT NULL,
  "periodStart"      TIMESTAMP(3) NOT NULL,
  "realizedPnl"      TEXT NOT NULL DEFAULT '0',
  "volume"           TEXT NOT NULL DEFAULT '0',
  "tradeCount"       INTEGER NOT NULL DEFAULT 0,
  "winningTrades"    INTEGER NOT NULL DEFAULT 0,
  "losingTrades"     INTEGER NOT NULL DEFAULT 0,
  "winRate"          TEXT NOT NULL DEFAULT '0',
  "roi"              TEXT NOT NULL DEFAULT '0',
  "feesPaid"         TEXT NOT NULL DEFAULT '0',
  "fundingPaid"      TEXT NOT NULL DEFAULT '0',
  "liquidationCount" INTEGER NOT NULL DEFAULT 0,
  "liquidatedVolume" TEXT NOT NULL DEFAULT '0',
  "peakCollateral"   TEXT NOT NULL DEFAULT '0',
  "referralCount"    INTEGER NOT NULL DEFAULT 0,
  "referralVolume"   TEXT NOT NULL DEFAULT '0',
  "lastTradeAt"      TIMESTAMP(3),
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "TraderStat_network_address_period_key" ON "TraderStat" ("network", "address", "period");
CREATE INDEX IF NOT EXISTS "TraderStat_network_period_realizedPnl_idx" ON "TraderStat" ("network", "period", "realizedPnl");
CREATE INDEX IF NOT EXISTS "TraderStat_network_period_volume_idx" ON "TraderStat" ("network", "period", "volume");
CREATE INDEX IF NOT EXISTS "TraderStat_network_period_roi_idx" ON "TraderStat" ("network", "period", "roi");
CREATE INDEX IF NOT EXISTS "TraderStat_address_idx" ON "TraderStat" ("address");

-- ── LeaderboardSnapshot ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "LeaderboardSnapshot" (
  "id"          BIGSERIAL PRIMARY KEY,
  "network"     TEXT NOT NULL,
  "period"      "StatsPeriod" NOT NULL,
  "metric"      TEXT NOT NULL,
  "capturedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "rankings"    JSONB NOT NULL,
  "traderCount" INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS "LeaderboardSnapshot_lookup_idx" ON "LeaderboardSnapshot" ("network", "period", "metric", "capturedAt");

-- ── BalanceChange ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "BalanceChange" (
  "id"           BIGSERIAL PRIMARY KEY,
  "network"      TEXT NOT NULL,
  "address"      TEXT NOT NULL,
  "asset"        TEXT NOT NULL,
  "kind"         "BalanceChangeKind" NOT NULL,
  "amount"       TEXT NOT NULL,
  "balanceAfter" TEXT,
  "ledger"       INTEGER NOT NULL,
  "txHash"       TEXT NOT NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "BalanceChange_unique_idx" ON "BalanceChange" ("network", "txHash", "address", "kind");
CREATE INDEX IF NOT EXISTS "BalanceChange_acct_time_idx" ON "BalanceChange" ("network", "address", "createdAt");
CREATE INDEX IF NOT EXISTS "BalanceChange_address_idx" ON "BalanceChange" ("address");

-- ── PnlEvent ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "PnlEvent" (
  "id"        BIGSERIAL PRIMARY KEY,
  "network"   TEXT NOT NULL,
  "address"   TEXT NOT NULL,
  "marketId"  INTEGER NOT NULL,
  "kind"      "PnlEventKind" NOT NULL,
  "amount"    TEXT NOT NULL,
  "size"      TEXT NOT NULL DEFAULT '0',
  "price"     TEXT NOT NULL DEFAULT '0',
  "ledger"    INTEGER NOT NULL,
  "txHash"    TEXT NOT NULL,
  "refKey"    TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "PnlEvent_unique_idx" ON "PnlEvent" ("network", "address", "kind", "refKey");
CREATE INDEX IF NOT EXISTS "PnlEvent_acct_time_idx" ON "PnlEvent" ("network", "address", "createdAt");
CREATE INDEX IF NOT EXISTS "PnlEvent_market_kind_idx" ON "PnlEvent" ("marketId", "kind");

-- ── FundingPayment ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "FundingPayment" (
  "id"           BIGSERIAL PRIMARY KEY,
  "network"      TEXT NOT NULL,
  "address"      TEXT NOT NULL,
  "marketId"     INTEGER NOT NULL,
  "amount"       TEXT NOT NULL,
  "fundingIndex" TEXT NOT NULL,
  "ledger"       INTEGER NOT NULL,
  "txHash"       TEXT NOT NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "FundingPayment_unique_idx" ON "FundingPayment" ("network", "address", "marketId", "fundingIndex");
CREATE INDEX IF NOT EXISTS "FundingPayment_acct_time_idx" ON "FundingPayment" ("network", "address", "createdAt");

-- ── PortfolioSnapshot ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "PortfolioSnapshot" (
  "id"                BIGSERIAL PRIMARY KEY,
  "network"           TEXT NOT NULL,
  "address"           TEXT NOT NULL,
  "collateralValue"   TEXT NOT NULL DEFAULT '0',
  "equity"            TEXT NOT NULL DEFAULT '0',
  "unrealizedPnl"     TEXT NOT NULL DEFAULT '0',
  "realizedPnlCum"    TEXT NOT NULL DEFAULT '0',
  "freeCollateral"    TEXT NOT NULL DEFAULT '0',
  "usedMargin"        TEXT NOT NULL DEFAULT '0',
  "maintenanceMargin" TEXT NOT NULL DEFAULT '0',
  "marginRatio"       TEXT NOT NULL DEFAULT '0',
  "openPositionCount" INTEGER NOT NULL DEFAULT 0,
  "longExposure"      TEXT NOT NULL DEFAULT '0',
  "shortExposure"     TEXT NOT NULL DEFAULT '0',
  "liquidatable"      BOOLEAN NOT NULL DEFAULT false,
  "capturedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "PortfolioSnapshot_acct_time_idx" ON "PortfolioSnapshot" ("network", "address", "capturedAt");

-- ── AccountAnalytics ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "AccountAnalytics" (
  "network"          TEXT NOT NULL,
  "address"          TEXT NOT NULL,
  "realizedPnlAll"   TEXT NOT NULL DEFAULT '0',
  "volumeAll"        TEXT NOT NULL DEFAULT '0',
  "tradeCountAll"    INTEGER NOT NULL DEFAULT 0,
  "winRateAll"       TEXT NOT NULL DEFAULT '0',
  "totalDeposited"   TEXT NOT NULL DEFAULT '0',
  "totalWithdrawn"   TEXT NOT NULL DEFAULT '0',
  "totalFundingPaid" TEXT NOT NULL DEFAULT '0',
  "totalFeesPaid"    TEXT NOT NULL DEFAULT '0',
  "liquidationCount" INTEGER NOT NULL DEFAULT 0,
  "maxDrawdown"      TEXT NOT NULL DEFAULT '0',
  "firstTradeAt"     TIMESTAMP(3),
  "lastTradeAt"      TIMESTAMP(3),
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("network", "address")
);
CREATE INDEX IF NOT EXISTS "AccountAnalytics_network_idx" ON "AccountAnalytics" ("network");
