-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "TxJobStatus" AS ENUM ('PENDING', 'SUBMITTED', 'REPLACED', 'CONFIRMED', 'REVERTED', 'DROPPED', 'FAILED');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "FillStatus" AS ENUM ('PENDING', 'SETTLED', 'REJECTED');

-- CreateEnum
CREATE TYPE "KeeperActionStatus" AS ENUM ('PLANNED', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "GovernanceOperationStatus" AS ENUM ('SCHEDULED', 'EXECUTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "StatsPeriod" AS ENUM ('DAY', 'WEEK', 'MONTH', 'ALL');

-- CreateEnum
CREATE TYPE "PnlEventKind" AS ENUM ('REALIZED_TRADE', 'FUNDING', 'LIQUIDATION', 'LIQUIDATION_PENALTY', 'DELEVERAGE', 'FEE');

-- CreateEnum
CREATE TYPE "BalanceChangeKind" AS ENUM ('DEPOSIT', 'WITHDRAWAL', 'TRANSFER_IN', 'TRANSFER_OUT');

-- CreateTable
CREATE TABLE "BlockCursor" (
    "network" TEXT NOT NULL,
    "stream" TEXT NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "blockHash" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlockCursor_pkey" PRIMARY KEY ("network","stream")
);

-- CreateTable
CREATE TABLE "ProtocolEvent" (
    "id" BIGSERIAL NOT NULL,
    "network" TEXT NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "blockHash" TEXT NOT NULL,
    "blockTimestamp" TIMESTAMP(3) NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "contract" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "topic0" TEXT NOT NULL,
    "args" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProtocolEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Market" (
    "network" TEXT NOT NULL,
    "id" INTEGER NOT NULL,
    "symbol" TEXT NOT NULL,
    "oracleId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "params" JSONB NOT NULL DEFAULT '{}',
    "makerRate" INTEGER NOT NULL DEFAULT 0,
    "takerRate" INTEGER NOT NULL DEFAULT 0,
    "lastMark" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "lastIndex" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "longFundingIndex" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "shortFundingIndex" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "fundingRatePerHour" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "longOpenInterest" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "shortOpenInterest" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Market_pkey" PRIMARY KEY ("network","id")
);

-- CreateTable
CREATE TABLE "Account" (
    "network" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "feeTier" INTEGER NOT NULL DEFAULT 0,
    "minValidNonce" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "ledgerBalance" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("network","address")
);

-- CreateTable
CREATE TABLE "Order" (
    "orderHash" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "marketId" INTEGER NOT NULL,
    "isLong" BOOLEAN NOT NULL,
    "size" DECIMAL(78,0) NOT NULL,
    "limitPrice" DECIMAL(78,0) NOT NULL,
    "reduceOnly" BOOLEAN NOT NULL,
    "nonce" DECIMAL(78,0) NOT NULL,
    "expiry" BIGINT NOT NULL,
    "referrer" TEXT,
    "signature" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'OPEN',
    "filledSize" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("orderHash")
);

-- CreateTable
CREATE TABLE "Fill" (
    "id" BIGSERIAL NOT NULL,
    "network" TEXT NOT NULL,
    "fillId" TEXT NOT NULL,
    "status" "FillStatus" NOT NULL DEFAULT 'PENDING',
    "rejectReason" TEXT,
    "marketId" INTEGER NOT NULL,
    "maker" TEXT NOT NULL,
    "taker" TEXT NOT NULL,
    "makerOrderHash" TEXT NOT NULL,
    "takerOrderHash" TEXT NOT NULL,
    "takerIsBuy" BOOLEAN NOT NULL,
    "size" DECIMAL(78,0) NOT NULL,
    "price" DECIMAL(78,0) NOT NULL,
    "makerFee" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "takerFee" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "makerTier" INTEGER NOT NULL DEFAULT 0,
    "takerTier" INTEGER NOT NULL DEFAULT 0,
    "txJobId" TEXT,
    "blockNumber" BIGINT,
    "txHash" TEXT,
    "logIndex" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Fill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Position" (
    "network" TEXT NOT NULL,
    "trader" TEXT NOT NULL,
    "marketId" INTEGER NOT NULL,
    "size" DECIMAL(78,0) NOT NULL,
    "openNotional" DECIMAL(78,0) NOT NULL,
    "lastPrice" DECIMAL(78,0) NOT NULL,
    "realizedPnlCum" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "lastBlockNumber" BIGINT NOT NULL,
    "lastLogIndex" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Position_pkey" PRIMARY KEY ("network","trader","marketId")
);

-- CreateTable
CREATE TABLE "OracleSnapshot" (
    "id" BIGSERIAL NOT NULL,
    "network" TEXT NOT NULL,
    "oracleId" TEXT NOT NULL,
    "price" DECIMAL(78,0) NOT NULL,
    "confidence" DECIMAL(78,0) NOT NULL,
    "publishTime" BIGINT NOT NULL,
    "writeTime" BIGINT NOT NULL,
    "sourceCount" INTEGER NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OracleSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FundingUpdate" (
    "id" BIGSERIAL NOT NULL,
    "network" TEXT NOT NULL,
    "marketId" INTEGER NOT NULL,
    "longIndex" DECIMAL(78,0) NOT NULL,
    "shortIndex" DECIMAL(78,0) NOT NULL,
    "ratePerHour" DECIMAL(78,0) NOT NULL,
    "premium" DECIMAL(78,0) NOT NULL,
    "mark" DECIMAL(78,0) NOT NULL,
    "index" DECIMAL(78,0) NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FundingUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FundingPayment" (
    "id" BIGSERIAL NOT NULL,
    "network" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "marketId" INTEGER NOT NULL,
    "amount" DECIMAL(78,0) NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FundingPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LiquidationEvent" (
    "id" BIGSERIAL NOT NULL,
    "network" TEXT NOT NULL,
    "trader" TEXT NOT NULL,
    "liquidator" TEXT NOT NULL,
    "marketId" INTEGER NOT NULL,
    "closeSize" DECIMAL(78,0) NOT NULL,
    "price" DECIMAL(78,0) NOT NULL,
    "realizedPnl" DECIMAL(78,0) NOT NULL,
    "penalty" DECIMAL(78,0) NOT NULL,
    "reward" DECIMAL(78,0) NOT NULL,
    "equityBefore" DECIMAL(78,0) NOT NULL,
    "equityAfter" DECIMAL(78,0) NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LiquidationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeleverageEvent" (
    "id" BIGSERIAL NOT NULL,
    "network" TEXT NOT NULL,
    "counterparty" TEXT NOT NULL,
    "keeper" TEXT NOT NULL,
    "marketId" INTEGER NOT NULL,
    "closeSize" DECIMAL(78,0) NOT NULL,
    "price" DECIMAL(78,0) NOT NULL,
    "realizedPnl" DECIMAL(78,0) NOT NULL,
    "haircut" DECIMAL(78,0) NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeleverageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackstopUnwind" (
    "id" BIGSERIAL NOT NULL,
    "network" TEXT NOT NULL,
    "marketId" INTEGER NOT NULL,
    "size" DECIMAL(78,0) NOT NULL,
    "price" DECIMAL(78,0) NOT NULL,
    "notional" DECIMAL(78,0) NOT NULL,
    "dayTotal" DECIMAL(78,0) NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BackstopUnwind_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeeAccrual" (
    "id" BIGSERIAL NOT NULL,
    "network" TEXT NOT NULL,
    "marketId" INTEGER NOT NULL,
    "payer" TEXT NOT NULL,
    "referrer" TEXT,
    "amount" DECIMAL(78,0) NOT NULL,
    "toTreasury" DECIMAL(78,0) NOT NULL,
    "toInsurance" DECIMAL(78,0) NOT NULL,
    "toReferral" DECIMAL(78,0) NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeeAccrual_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeeClaim" (
    "id" BIGSERIAL NOT NULL,
    "network" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "amount" DECIMAL(78,0) NOT NULL,
    "internalAmount" DECIMAL(78,0) NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeeClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeeTierAssignment" (
    "id" BIGSERIAL NOT NULL,
    "network" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "tier" INTEGER NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeeTierAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TxJob" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "toAddress" TEXT NOT NULL,
    "nonce" INTEGER NOT NULL,
    "data" TEXT NOT NULL,
    "value" DECIMAL(78,0) NOT NULL,
    "gasLimit" DECIMAL(78,0) NOT NULL,
    "maxFeePerGas" DECIMAL(78,0) NOT NULL,
    "maxPriorityFeePerGas" DECIMAL(78,0) NOT NULL,
    "rawTx" TEXT NOT NULL,
    "submittedHash" TEXT NOT NULL,
    "replacedByHash" TEXT,
    "status" "TxJobStatus" NOT NULL,
    "gasUsed" DECIMAL(78,0),
    "effectiveGasPrice" DECIMAL(78,0),
    "blockNumber" BIGINT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TxJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KeeperAction" (
    "id" BIGSERIAL NOT NULL,
    "network" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "marketId" INTEGER,
    "account" TEXT,
    "payload" JSONB NOT NULL,
    "status" "KeeperActionStatus" NOT NULL DEFAULT 'PLANNED',
    "txJobId" TEXT,
    "blockNumber" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KeeperAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GasSpend" (
    "network" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "service" TEXT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "txCount" INTEGER NOT NULL DEFAULT 0,
    "gasUsed" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "costWei" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GasSpend_pkey" PRIMARY KEY ("network","day","service","fromAddress")
);

-- CreateTable
CREATE TABLE "DeploymentArtifact" (
    "id" BIGSERIAL NOT NULL,
    "network" TEXT NOT NULL,
    "contractName" TEXT NOT NULL,
    "proxy" TEXT NOT NULL,
    "implementation" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "gitCommit" TEXT NOT NULL,
    "arcForgeVersion" TEXT NOT NULL,
    "deployBlock" BIGINT NOT NULL,
    "txHash" TEXT NOT NULL,
    "manifest" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeploymentArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GovernanceOperation" (
    "network" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "predecessor" TEXT NOT NULL,
    "salt" TEXT NOT NULL,
    "calls" JSONB NOT NULL,
    "delaySeconds" BIGINT NOT NULL,
    "readyAt" TIMESTAMP(3) NOT NULL,
    "status" "GovernanceOperationStatus" NOT NULL DEFAULT 'SCHEDULED',
    "description" TEXT,
    "scheduledTxHash" TEXT NOT NULL,
    "executedTxHash" TEXT,
    "cancelledTxHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GovernanceOperation_pkey" PRIMARY KEY ("network","operationId")
);

-- CreateTable
CREATE TABLE "BalanceChange" (
    "id" BIGSERIAL NOT NULL,
    "network" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "kind" "BalanceChangeKind" NOT NULL,
    "counterparty" TEXT,
    "amount" DECIMAL(78,0),
    "internalAmount" DECIMAL(78,0) NOT NULL,
    "reason" TEXT,
    "blockNumber" BIGINT NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BalanceChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PnlEvent" (
    "id" BIGSERIAL NOT NULL,
    "network" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "marketId" INTEGER NOT NULL,
    "kind" "PnlEventKind" NOT NULL,
    "amount" DECIMAL(78,0) NOT NULL,
    "size" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "price" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "blockNumber" BIGINT NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PnlEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TraderStat" (
    "network" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "period" "StatsPeriod" NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "realizedPnl" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "volume" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "tradeCount" INTEGER NOT NULL DEFAULT 0,
    "winningTrades" INTEGER NOT NULL DEFAULT 0,
    "losingTrades" INTEGER NOT NULL DEFAULT 0,
    "winRate" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "roi" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "feesPaid" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "fundingPaid" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "liquidationCount" INTEGER NOT NULL DEFAULT 0,
    "liquidatedVolume" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "peakEquity" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "referralCount" INTEGER NOT NULL DEFAULT 0,
    "referralVolume" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "lastTradeAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TraderStat_pkey" PRIMARY KEY ("network","address","period")
);

-- CreateTable
CREATE TABLE "LeaderboardSnapshot" (
    "id" BIGSERIAL NOT NULL,
    "network" TEXT NOT NULL,
    "period" "StatsPeriod" NOT NULL,
    "metric" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rankings" JSONB NOT NULL,
    "traderCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "LeaderboardSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortfolioSnapshot" (
    "id" BIGSERIAL NOT NULL,
    "network" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "equity" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "collateral" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "unrealizedPnl" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "realizedPnlCum" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "freeCollateral" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "initialMargin" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "maintenanceMargin" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "openPositionCount" INTEGER NOT NULL DEFAULT 0,
    "longExposure" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "shortExposure" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "liquidatable" BOOLEAN NOT NULL DEFAULT false,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortfolioSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountAnalytics" (
    "network" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "realizedPnlAll" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "volumeAll" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "volume30d" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "tradeCountAll" INTEGER NOT NULL DEFAULT 0,
    "winRateAll" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "totalDeposited" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "totalWithdrawn" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "totalFundingPaid" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "totalFeesPaid" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "liquidationCount" INTEGER NOT NULL DEFAULT 0,
    "maxDrawdown" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "firstTradeAt" TIMESTAMP(3),
    "lastTradeAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountAnalytics_pkey" PRIMARY KEY ("network","address")
);

-- CreateIndex
CREATE INDEX "ProtocolEvent_network_blockNumber_logIndex_idx" ON "ProtocolEvent"("network", "blockNumber", "logIndex");

-- CreateIndex
CREATE INDEX "ProtocolEvent_network_eventName_blockNumber_idx" ON "ProtocolEvent"("network", "eventName", "blockNumber");

-- CreateIndex
CREATE INDEX "ProtocolEvent_contract_idx" ON "ProtocolEvent"("contract");

-- CreateIndex
CREATE UNIQUE INDEX "ProtocolEvent_network_txHash_logIndex_key" ON "ProtocolEvent"("network", "txHash", "logIndex");

-- CreateIndex
CREATE UNIQUE INDEX "Market_network_symbol_key" ON "Market"("network", "symbol");

-- CreateIndex
CREATE INDEX "Order_network_marketId_status_isLong_limitPrice_idx" ON "Order"("network", "marketId", "status", "isLong", "limitPrice");

-- CreateIndex
CREATE INDEX "Order_network_status_expiry_idx" ON "Order"("network", "status", "expiry");

-- CreateIndex
CREATE UNIQUE INDEX "Order_network_owner_nonce_key" ON "Order"("network", "owner", "nonce");

-- CreateIndex
CREATE INDEX "Fill_network_marketId_blockNumber_idx" ON "Fill"("network", "marketId", "blockNumber");

-- CreateIndex
CREATE INDEX "Fill_network_status_createdAt_idx" ON "Fill"("network", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Fill_network_maker_createdAt_idx" ON "Fill"("network", "maker", "createdAt");

-- CreateIndex
CREATE INDEX "Fill_network_taker_createdAt_idx" ON "Fill"("network", "taker", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Fill_network_fillId_key" ON "Fill"("network", "fillId");

-- CreateIndex
CREATE UNIQUE INDEX "Fill_network_txHash_logIndex_key" ON "Fill"("network", "txHash", "logIndex");

-- CreateIndex
CREATE INDEX "Position_network_marketId_idx" ON "Position"("network", "marketId");

-- CreateIndex
CREATE INDEX "OracleSnapshot_network_oracleId_publishTime_idx" ON "OracleSnapshot"("network", "oracleId", "publishTime");

-- CreateIndex
CREATE UNIQUE INDEX "OracleSnapshot_network_txHash_logIndex_key" ON "OracleSnapshot"("network", "txHash", "logIndex");

-- CreateIndex
CREATE INDEX "FundingUpdate_network_marketId_blockNumber_idx" ON "FundingUpdate"("network", "marketId", "blockNumber");

-- CreateIndex
CREATE UNIQUE INDEX "FundingUpdate_network_txHash_logIndex_key" ON "FundingUpdate"("network", "txHash", "logIndex");

-- CreateIndex
CREATE INDEX "FundingPayment_network_address_createdAt_idx" ON "FundingPayment"("network", "address", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "FundingPayment_network_txHash_logIndex_key" ON "FundingPayment"("network", "txHash", "logIndex");

-- CreateIndex
CREATE INDEX "LiquidationEvent_network_trader_createdAt_idx" ON "LiquidationEvent"("network", "trader", "createdAt");

-- CreateIndex
CREATE INDEX "LiquidationEvent_network_marketId_blockNumber_idx" ON "LiquidationEvent"("network", "marketId", "blockNumber");

-- CreateIndex
CREATE UNIQUE INDEX "LiquidationEvent_network_txHash_logIndex_key" ON "LiquidationEvent"("network", "txHash", "logIndex");

-- CreateIndex
CREATE INDEX "DeleverageEvent_network_counterparty_createdAt_idx" ON "DeleverageEvent"("network", "counterparty", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DeleverageEvent_network_txHash_logIndex_key" ON "DeleverageEvent"("network", "txHash", "logIndex");

-- CreateIndex
CREATE INDEX "BackstopUnwind_network_marketId_blockNumber_idx" ON "BackstopUnwind"("network", "marketId", "blockNumber");

-- CreateIndex
CREATE UNIQUE INDEX "BackstopUnwind_network_txHash_logIndex_key" ON "BackstopUnwind"("network", "txHash", "logIndex");

-- CreateIndex
CREATE INDEX "FeeAccrual_network_payer_createdAt_idx" ON "FeeAccrual"("network", "payer", "createdAt");

-- CreateIndex
CREATE INDEX "FeeAccrual_network_referrer_createdAt_idx" ON "FeeAccrual"("network", "referrer", "createdAt");

-- CreateIndex
CREATE INDEX "FeeAccrual_network_marketId_blockNumber_idx" ON "FeeAccrual"("network", "marketId", "blockNumber");

-- CreateIndex
CREATE UNIQUE INDEX "FeeAccrual_network_txHash_logIndex_key" ON "FeeAccrual"("network", "txHash", "logIndex");

-- CreateIndex
CREATE INDEX "FeeClaim_network_bucket_createdAt_idx" ON "FeeClaim"("network", "bucket", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "FeeClaim_network_txHash_logIndex_key" ON "FeeClaim"("network", "txHash", "logIndex");

-- CreateIndex
CREATE INDEX "FeeTierAssignment_network_address_blockNumber_idx" ON "FeeTierAssignment"("network", "address", "blockNumber");

-- CreateIndex
CREATE UNIQUE INDEX "FeeTierAssignment_network_txHash_logIndex_key" ON "FeeTierAssignment"("network", "txHash", "logIndex");

-- CreateIndex
CREATE INDEX "TxJob_network_fromAddress_nonce_createdAt_idx" ON "TxJob"("network", "fromAddress", "nonce", "createdAt");

-- CreateIndex
CREATE INDEX "TxJob_network_status_fromAddress_idx" ON "TxJob"("network", "status", "fromAddress");

-- CreateIndex
CREATE UNIQUE INDEX "TxJob_network_submittedHash_key" ON "TxJob"("network", "submittedHash");

-- CreateIndex
CREATE INDEX "KeeperAction_network_kind_status_idx" ON "KeeperAction"("network", "kind", "status");

-- CreateIndex
CREATE INDEX "KeeperAction_network_marketId_idx" ON "KeeperAction"("network", "marketId");

-- CreateIndex
CREATE INDEX "DeploymentArtifact_network_proxy_idx" ON "DeploymentArtifact"("network", "proxy");

-- CreateIndex
CREATE UNIQUE INDEX "DeploymentArtifact_network_contractName_implementation_key" ON "DeploymentArtifact"("network", "contractName", "implementation");

-- CreateIndex
CREATE INDEX "GovernanceOperation_network_status_readyAt_idx" ON "GovernanceOperation"("network", "status", "readyAt");

-- CreateIndex
CREATE INDEX "BalanceChange_network_address_createdAt_idx" ON "BalanceChange"("network", "address", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BalanceChange_network_txHash_logIndex_address_kind_key" ON "BalanceChange"("network", "txHash", "logIndex", "address", "kind");

-- CreateIndex
CREATE INDEX "PnlEvent_network_address_createdAt_idx" ON "PnlEvent"("network", "address", "createdAt");

-- CreateIndex
CREATE INDEX "PnlEvent_network_marketId_kind_idx" ON "PnlEvent"("network", "marketId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "PnlEvent_network_txHash_logIndex_address_kind_key" ON "PnlEvent"("network", "txHash", "logIndex", "address", "kind");

-- CreateIndex
CREATE INDEX "TraderStat_network_period_realizedPnl_idx" ON "TraderStat"("network", "period", "realizedPnl");

-- CreateIndex
CREATE INDEX "TraderStat_network_period_volume_idx" ON "TraderStat"("network", "period", "volume");

-- CreateIndex
CREATE INDEX "TraderStat_network_period_roi_idx" ON "TraderStat"("network", "period", "roi");

-- CreateIndex
CREATE INDEX "LeaderboardSnapshot_network_period_metric_capturedAt_idx" ON "LeaderboardSnapshot"("network", "period", "metric", "capturedAt");

-- CreateIndex
CREATE INDEX "PortfolioSnapshot_network_address_capturedAt_idx" ON "PortfolioSnapshot"("network", "address", "capturedAt");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_network_owner_fkey" FOREIGN KEY ("network", "owner") REFERENCES "Account"("network", "address") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_network_marketId_fkey" FOREIGN KEY ("network", "marketId") REFERENCES "Market"("network", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fill" ADD CONSTRAINT "Fill_network_marketId_fkey" FOREIGN KEY ("network", "marketId") REFERENCES "Market"("network", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_network_trader_fkey" FOREIGN KEY ("network", "trader") REFERENCES "Account"("network", "address") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_network_marketId_fkey" FOREIGN KEY ("network", "marketId") REFERENCES "Market"("network", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FundingUpdate" ADD CONSTRAINT "FundingUpdate_network_marketId_fkey" FOREIGN KEY ("network", "marketId") REFERENCES "Market"("network", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- CHECK constraints (not expressible in schema.prisma). Addresses and hashes
-- are lowercase hex; writers must normalise before insert.

ALTER TABLE "BlockCursor" ADD CONSTRAINT "BlockCursor_network_check" CHECK ("network" IN ('arc-mainnet', 'arc-testnet', 'arc-local'));
ALTER TABLE "ProtocolEvent" ADD CONSTRAINT "ProtocolEvent_network_check" CHECK ("network" IN ('arc-mainnet', 'arc-testnet', 'arc-local'));
ALTER TABLE "Market" ADD CONSTRAINT "Market_network_check" CHECK ("network" IN ('arc-mainnet', 'arc-testnet', 'arc-local'));
ALTER TABLE "Account" ADD CONSTRAINT "Account_network_check" CHECK ("network" IN ('arc-mainnet', 'arc-testnet', 'arc-local'));
ALTER TABLE "Order" ADD CONSTRAINT "Order_network_check" CHECK ("network" IN ('arc-mainnet', 'arc-testnet', 'arc-local'));
ALTER TABLE "Fill" ADD CONSTRAINT "Fill_network_check" CHECK ("network" IN ('arc-mainnet', 'arc-testnet', 'arc-local'));
ALTER TABLE "Position" ADD CONSTRAINT "Position_network_check" CHECK ("network" IN ('arc-mainnet', 'arc-testnet', 'arc-local'));
ALTER TABLE "OracleSnapshot" ADD CONSTRAINT "OracleSnapshot_network_check" CHECK ("network" IN ('arc-mainnet', 'arc-testnet', 'arc-local'));
ALTER TABLE "FundingUpdate" ADD CONSTRAINT "FundingUpdate_network_check" CHECK ("network" IN ('arc-mainnet', 'arc-testnet', 'arc-local'));
ALTER TABLE "FundingPayment" ADD CONSTRAINT "FundingPayment_network_check" CHECK ("network" IN ('arc-mainnet', 'arc-testnet', 'arc-local'));
ALTER TABLE "LiquidationEvent" ADD CONSTRAINT "LiquidationEvent_network_check" CHECK ("network" IN ('arc-mainnet', 'arc-testnet', 'arc-local'));
ALTER TABLE "DeleverageEvent" ADD CONSTRAINT "DeleverageEvent_network_check" CHECK ("network" IN ('arc-mainnet', 'arc-testnet', 'arc-local'));
ALTER TABLE "BackstopUnwind" ADD CONSTRAINT "BackstopUnwind_network_check" CHECK ("network" IN ('arc-mainnet', 'arc-testnet', 'arc-local'));
ALTER TABLE "FeeAccrual" ADD CONSTRAINT "FeeAccrual_network_check" CHECK ("network" IN ('arc-mainnet', 'arc-testnet', 'arc-local'));
ALTER TABLE "FeeClaim" ADD CONSTRAINT "FeeClaim_network_check" CHECK ("network" IN ('arc-mainnet', 'arc-testnet', 'arc-local'));
ALTER TABLE "FeeTierAssignment" ADD CONSTRAINT "FeeTierAssignment_network_check" CHECK ("network" IN ('arc-mainnet', 'arc-testnet', 'arc-local'));
ALTER TABLE "TxJob" ADD CONSTRAINT "TxJob_network_check" CHECK ("network" IN ('arc-mainnet', 'arc-testnet', 'arc-local'));
ALTER TABLE "KeeperAction" ADD CONSTRAINT "KeeperAction_network_check" CHECK ("network" IN ('arc-mainnet', 'arc-testnet', 'arc-local'));
ALTER TABLE "GasSpend" ADD CONSTRAINT "GasSpend_network_check" CHECK ("network" IN ('arc-mainnet', 'arc-testnet', 'arc-local'));
ALTER TABLE "DeploymentArtifact" ADD CONSTRAINT "DeploymentArtifact_network_check" CHECK ("network" IN ('arc-mainnet', 'arc-testnet', 'arc-local'));
ALTER TABLE "GovernanceOperation" ADD CONSTRAINT "GovernanceOperation_network_check" CHECK ("network" IN ('arc-mainnet', 'arc-testnet', 'arc-local'));
ALTER TABLE "BalanceChange" ADD CONSTRAINT "BalanceChange_network_check" CHECK ("network" IN ('arc-mainnet', 'arc-testnet', 'arc-local'));
ALTER TABLE "PnlEvent" ADD CONSTRAINT "PnlEvent_network_check" CHECK ("network" IN ('arc-mainnet', 'arc-testnet', 'arc-local'));
ALTER TABLE "TraderStat" ADD CONSTRAINT "TraderStat_network_check" CHECK ("network" IN ('arc-mainnet', 'arc-testnet', 'arc-local'));
ALTER TABLE "LeaderboardSnapshot" ADD CONSTRAINT "LeaderboardSnapshot_network_check" CHECK ("network" IN ('arc-mainnet', 'arc-testnet', 'arc-local'));
ALTER TABLE "PortfolioSnapshot" ADD CONSTRAINT "PortfolioSnapshot_network_check" CHECK ("network" IN ('arc-mainnet', 'arc-testnet', 'arc-local'));
ALTER TABLE "AccountAnalytics" ADD CONSTRAINT "AccountAnalytics_network_check" CHECK ("network" IN ('arc-mainnet', 'arc-testnet', 'arc-local'));
ALTER TABLE "ProtocolEvent" ADD CONSTRAINT "ProtocolEvent_contract_addr" CHECK ("contract" ~ '^0x[0-9a-f]{40}$');
ALTER TABLE "Account" ADD CONSTRAINT "Account_address_addr" CHECK ("address" ~ '^0x[0-9a-f]{40}$');
ALTER TABLE "Order" ADD CONSTRAINT "Order_owner_addr" CHECK ("owner" ~ '^0x[0-9a-f]{40}$');
ALTER TABLE "Order" ADD CONSTRAINT "Order_referrer_addr" CHECK ("referrer" ~ '^0x[0-9a-f]{40}$');
ALTER TABLE "Fill" ADD CONSTRAINT "Fill_maker_addr" CHECK ("maker" ~ '^0x[0-9a-f]{40}$');
ALTER TABLE "Fill" ADD CONSTRAINT "Fill_taker_addr" CHECK ("taker" ~ '^0x[0-9a-f]{40}$');
ALTER TABLE "Position" ADD CONSTRAINT "Position_trader_addr" CHECK ("trader" ~ '^0x[0-9a-f]{40}$');
ALTER TABLE "FundingPayment" ADD CONSTRAINT "FundingPayment_address_addr" CHECK ("address" ~ '^0x[0-9a-f]{40}$');
ALTER TABLE "LiquidationEvent" ADD CONSTRAINT "LiquidationEvent_trader_addr" CHECK ("trader" ~ '^0x[0-9a-f]{40}$');
ALTER TABLE "LiquidationEvent" ADD CONSTRAINT "LiquidationEvent_liquidator_addr" CHECK ("liquidator" ~ '^0x[0-9a-f]{40}$');
ALTER TABLE "DeleverageEvent" ADD CONSTRAINT "DeleverageEvent_counterparty_addr" CHECK ("counterparty" ~ '^0x[0-9a-f]{40}$');
ALTER TABLE "DeleverageEvent" ADD CONSTRAINT "DeleverageEvent_keeper_addr" CHECK ("keeper" ~ '^0x[0-9a-f]{40}$');
ALTER TABLE "FeeAccrual" ADD CONSTRAINT "FeeAccrual_payer_addr" CHECK ("payer" ~ '^0x[0-9a-f]{40}$');
ALTER TABLE "FeeAccrual" ADD CONSTRAINT "FeeAccrual_referrer_addr" CHECK ("referrer" ~ '^0x[0-9a-f]{40}$');
ALTER TABLE "FeeClaim" ADD CONSTRAINT "FeeClaim_recipient_addr" CHECK ("recipient" ~ '^0x[0-9a-f]{40}$');
ALTER TABLE "FeeTierAssignment" ADD CONSTRAINT "FeeTierAssignment_address_addr" CHECK ("address" ~ '^0x[0-9a-f]{40}$');
ALTER TABLE "TxJob" ADD CONSTRAINT "TxJob_fromAddress_addr" CHECK ("fromAddress" ~ '^0x[0-9a-f]{40}$');
ALTER TABLE "TxJob" ADD CONSTRAINT "TxJob_toAddress_addr" CHECK ("toAddress" ~ '^0x[0-9a-f]{40}$');
ALTER TABLE "KeeperAction" ADD CONSTRAINT "KeeperAction_account_addr" CHECK ("account" ~ '^0x[0-9a-f]{40}$');
ALTER TABLE "GasSpend" ADD CONSTRAINT "GasSpend_fromAddress_addr" CHECK ("fromAddress" ~ '^0x[0-9a-f]{40}$');
ALTER TABLE "DeploymentArtifact" ADD CONSTRAINT "DeploymentArtifact_proxy_addr" CHECK ("proxy" ~ '^0x[0-9a-f]{40}$');
ALTER TABLE "DeploymentArtifact" ADD CONSTRAINT "DeploymentArtifact_implementation_addr" CHECK ("implementation" ~ '^0x[0-9a-f]{40}$');
ALTER TABLE "BalanceChange" ADD CONSTRAINT "BalanceChange_address_addr" CHECK ("address" ~ '^0x[0-9a-f]{40}$');
ALTER TABLE "BalanceChange" ADD CONSTRAINT "BalanceChange_counterparty_addr" CHECK ("counterparty" ~ '^0x[0-9a-f]{40}$');
ALTER TABLE "PnlEvent" ADD CONSTRAINT "PnlEvent_address_addr" CHECK ("address" ~ '^0x[0-9a-f]{40}$');
ALTER TABLE "TraderStat" ADD CONSTRAINT "TraderStat_address_addr" CHECK ("address" ~ '^0x[0-9a-f]{40}$');
ALTER TABLE "PortfolioSnapshot" ADD CONSTRAINT "PortfolioSnapshot_address_addr" CHECK ("address" ~ '^0x[0-9a-f]{40}$');
ALTER TABLE "AccountAnalytics" ADD CONSTRAINT "AccountAnalytics_address_addr" CHECK ("address" ~ '^0x[0-9a-f]{40}$');
ALTER TABLE "BlockCursor" ADD CONSTRAINT "BlockCursor_blockHash_b32" CHECK ("blockHash" ~ '^0x[0-9a-f]{64}$');
ALTER TABLE "ProtocolEvent" ADD CONSTRAINT "ProtocolEvent_blockHash_b32" CHECK ("blockHash" ~ '^0x[0-9a-f]{64}$');
ALTER TABLE "ProtocolEvent" ADD CONSTRAINT "ProtocolEvent_txHash_b32" CHECK ("txHash" ~ '^0x[0-9a-f]{64}$');
ALTER TABLE "ProtocolEvent" ADD CONSTRAINT "ProtocolEvent_topic0_b32" CHECK ("topic0" ~ '^0x[0-9a-f]{64}$');
ALTER TABLE "Market" ADD CONSTRAINT "Market_oracleId_b32" CHECK ("oracleId" ~ '^0x[0-9a-f]{64}$');
ALTER TABLE "Order" ADD CONSTRAINT "Order_orderHash_b32" CHECK ("orderHash" ~ '^0x[0-9a-f]{64}$');
ALTER TABLE "Fill" ADD CONSTRAINT "Fill_fillId_b32" CHECK ("fillId" ~ '^0x[0-9a-f]{64}$');
ALTER TABLE "Fill" ADD CONSTRAINT "Fill_makerOrderHash_b32" CHECK ("makerOrderHash" ~ '^0x[0-9a-f]{64}$');
ALTER TABLE "Fill" ADD CONSTRAINT "Fill_takerOrderHash_b32" CHECK ("takerOrderHash" ~ '^0x[0-9a-f]{64}$');
ALTER TABLE "Fill" ADD CONSTRAINT "Fill_txHash_b32" CHECK ("txHash" ~ '^0x[0-9a-f]{64}$');
ALTER TABLE "OracleSnapshot" ADD CONSTRAINT "OracleSnapshot_oracleId_b32" CHECK ("oracleId" ~ '^0x[0-9a-f]{64}$');
ALTER TABLE "OracleSnapshot" ADD CONSTRAINT "OracleSnapshot_txHash_b32" CHECK ("txHash" ~ '^0x[0-9a-f]{64}$');
ALTER TABLE "FundingUpdate" ADD CONSTRAINT "FundingUpdate_txHash_b32" CHECK ("txHash" ~ '^0x[0-9a-f]{64}$');
ALTER TABLE "FundingPayment" ADD CONSTRAINT "FundingPayment_txHash_b32" CHECK ("txHash" ~ '^0x[0-9a-f]{64}$');
ALTER TABLE "LiquidationEvent" ADD CONSTRAINT "LiquidationEvent_txHash_b32" CHECK ("txHash" ~ '^0x[0-9a-f]{64}$');
ALTER TABLE "DeleverageEvent" ADD CONSTRAINT "DeleverageEvent_txHash_b32" CHECK ("txHash" ~ '^0x[0-9a-f]{64}$');
ALTER TABLE "BackstopUnwind" ADD CONSTRAINT "BackstopUnwind_txHash_b32" CHECK ("txHash" ~ '^0x[0-9a-f]{64}$');
ALTER TABLE "FeeAccrual" ADD CONSTRAINT "FeeAccrual_txHash_b32" CHECK ("txHash" ~ '^0x[0-9a-f]{64}$');
ALTER TABLE "FeeClaim" ADD CONSTRAINT "FeeClaim_bucket_b32" CHECK ("bucket" ~ '^0x[0-9a-f]{64}$');
ALTER TABLE "FeeClaim" ADD CONSTRAINT "FeeClaim_txHash_b32" CHECK ("txHash" ~ '^0x[0-9a-f]{64}$');
ALTER TABLE "FeeTierAssignment" ADD CONSTRAINT "FeeTierAssignment_txHash_b32" CHECK ("txHash" ~ '^0x[0-9a-f]{64}$');
ALTER TABLE "TxJob" ADD CONSTRAINT "TxJob_submittedHash_b32" CHECK ("submittedHash" ~ '^0x[0-9a-f]{64}$');
ALTER TABLE "TxJob" ADD CONSTRAINT "TxJob_replacedByHash_b32" CHECK ("replacedByHash" ~ '^0x[0-9a-f]{64}$');
ALTER TABLE "DeploymentArtifact" ADD CONSTRAINT "DeploymentArtifact_codeHash_b32" CHECK ("codeHash" ~ '^0x[0-9a-f]{64}$');
ALTER TABLE "DeploymentArtifact" ADD CONSTRAINT "DeploymentArtifact_txHash_b32" CHECK ("txHash" ~ '^0x[0-9a-f]{64}$');
ALTER TABLE "GovernanceOperation" ADD CONSTRAINT "GovernanceOperation_operationId_b32" CHECK ("operationId" ~ '^0x[0-9a-f]{64}$');
ALTER TABLE "GovernanceOperation" ADD CONSTRAINT "GovernanceOperation_predecessor_b32" CHECK ("predecessor" ~ '^0x[0-9a-f]{64}$');
ALTER TABLE "GovernanceOperation" ADD CONSTRAINT "GovernanceOperation_salt_b32" CHECK ("salt" ~ '^0x[0-9a-f]{64}$');
ALTER TABLE "GovernanceOperation" ADD CONSTRAINT "GovernanceOperation_scheduledTxHash_b32" CHECK ("scheduledTxHash" ~ '^0x[0-9a-f]{64}$');
ALTER TABLE "GovernanceOperation" ADD CONSTRAINT "GovernanceOperation_executedTxHash_b32" CHECK ("executedTxHash" ~ '^0x[0-9a-f]{64}$');
ALTER TABLE "GovernanceOperation" ADD CONSTRAINT "GovernanceOperation_cancelledTxHash_b32" CHECK ("cancelledTxHash" ~ '^0x[0-9a-f]{64}$');
ALTER TABLE "BalanceChange" ADD CONSTRAINT "BalanceChange_reason_b32" CHECK ("reason" ~ '^0x[0-9a-f]{64}$');
ALTER TABLE "BalanceChange" ADD CONSTRAINT "BalanceChange_txHash_b32" CHECK ("txHash" ~ '^0x[0-9a-f]{64}$');
ALTER TABLE "PnlEvent" ADD CONSTRAINT "PnlEvent_txHash_b32" CHECK ("txHash" ~ '^0x[0-9a-f]{64}$');
ALTER TABLE "Order" ADD CONSTRAINT "Order_signature_hex" CHECK ("signature" ~ '^0x([0-9a-f]{2})*$');
ALTER TABLE "TxJob" ADD CONSTRAINT "TxJob_data_hex" CHECK ("data" ~ '^0x([0-9a-f]{2})*$');
ALTER TABLE "TxJob" ADD CONSTRAINT "TxJob_rawTx_hex" CHECK ("rawTx" ~ '^0x([0-9a-f]{2})*$');
ALTER TABLE "Order" ADD CONSTRAINT "Order_size_pos" CHECK ("size" > 0 AND "limitPrice" > 0);
ALTER TABLE "Order" ADD CONSTRAINT "Order_filledSize_range" CHECK ("filledSize" >= 0 AND "filledSize" <= "size");
ALTER TABLE "Fill" ADD CONSTRAINT "Fill_size_pos" CHECK ("size" > 0 AND "price" > 0);
ALTER TABLE "Fill" ADD CONSTRAINT "Fill_status_settled" CHECK (("status" = 'SETTLED') = ("txHash" IS NOT NULL AND "logIndex" IS NOT NULL AND "blockNumber" IS NOT NULL));
ALTER TABLE "BalanceChange" ADD CONSTRAINT "BalanceChange_internalAmount_nonneg" CHECK ("internalAmount" >= 0);
ALTER TABLE "TxJob" ADD CONSTRAINT "TxJob_nonce_nonneg" CHECK ("nonce" >= 0);
