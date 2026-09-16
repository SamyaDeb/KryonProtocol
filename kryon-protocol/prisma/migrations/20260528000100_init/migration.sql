-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "TxStatus" AS ENUM ('QUEUED', 'SUBMITTED', 'CONFIRMED', 'FAILED');

-- CreateEnum
CREATE TYPE "KeeperActionStatus" AS ENUM ('PLANNED', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "AuditSeverity" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO');

-- CreateTable
CREATE TABLE "LedgerCursor" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "contractId" TEXT,
    "ledger" INTEGER NOT NULL,
    "cursor" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerCursor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProtocolEvent" (
    "id" BIGSERIAL NOT NULL,
    "network" TEXT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "txHash" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "replayKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProtocolEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Market" (
    "id" INTEGER NOT NULL,
    "symbol" TEXT NOT NULL,
    "settlementAsset" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "lastPrice" TEXT NOT NULL DEFAULT '0',
    "volume" TEXT NOT NULL DEFAULT '0',
    "longOpenInterest" TEXT NOT NULL DEFAULT '0',
    "shortOpenInterest" TEXT NOT NULL DEFAULT '0',
    "fundingLongIndex" TEXT NOT NULL DEFAULT '0',
    "fundingShortIndex" TEXT NOT NULL DEFAULT '0',
    "lastOraclePrice" TEXT NOT NULL DEFAULT '0',
    "lastOracleLedger" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Market_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "address" TEXT NOT NULL,
    "collateral" JSONB NOT NULL DEFAULT '{}',
    "cancelledNonces" BIGINT[] DEFAULT ARRAY[]::BIGINT[],
    "filledByNonce" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("address")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "marketId" INTEGER NOT NULL,
    "isLong" BOOLEAN NOT NULL,
    "size" TEXT NOT NULL,
    "limitPrice" TEXT NOT NULL,
    "reduceOnly" BOOLEAN NOT NULL,
    "nonce" BIGINT NOT NULL,
    "expiryTs" BIGINT NOT NULL,
    "cancelled" BOOLEAN NOT NULL DEFAULT false,
    "filledSize" TEXT NOT NULL DEFAULT '0',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Fill" (
    "id" BIGSERIAL NOT NULL,
    "network" TEXT NOT NULL,
    "marketId" INTEGER NOT NULL,
    "maker" TEXT NOT NULL,
    "makerNonce" BIGINT NOT NULL,
    "taker" TEXT NOT NULL,
    "takerNonce" BIGINT NOT NULL,
    "fillSize" TEXT NOT NULL,
    "fillPrice" TEXT NOT NULL,
    "feeMaker" TEXT NOT NULL DEFAULT '0',
    "feeTaker" TEXT NOT NULL DEFAULT '0',
    "txHash" TEXT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Fill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Position" (
    "id" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "marketId" INTEGER NOT NULL,
    "positionId" BIGINT NOT NULL,
    "size" TEXT NOT NULL,
    "entryPrice" TEXT NOT NULL,
    "margin" TEXT NOT NULL DEFAULT '0',
    "isLong" BOOLEAN NOT NULL,
    "lastFundingIndex" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OracleSnapshot" (
    "id" BIGSERIAL NOT NULL,
    "network" TEXT NOT NULL,
    "marketId" INTEGER NOT NULL,
    "asset" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "price" TEXT NOT NULL,
    "confidence" TEXT NOT NULL,
    "publishTime" BIGINT NOT NULL,
    "writeTime" BIGINT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "txHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OracleSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FundingUpdate" (
    "id" BIGSERIAL NOT NULL,
    "network" TEXT NOT NULL,
    "marketId" INTEGER NOT NULL,
    "longIndex" TEXT NOT NULL,
    "shortIndex" TEXT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "txHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FundingUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TxJob" (
    "id" BIGSERIAL NOT NULL,
    "network" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "unsignedXdr" TEXT,
    "signedXdr" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "status" "TxStatus" NOT NULL DEFAULT 'QUEUED',
    "lastError" TEXT,
    "submittedHash" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
    "txJobId" BIGINT,
    "ledger" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KeeperAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeploymentArtifact" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "contractName" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "wasmHash" TEXT NOT NULL,
    "gitCommit" TEXT NOT NULL,
    "manifest" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeploymentArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GovernanceProposal" (
    "id" BIGINT NOT NULL,
    "network" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "wasmHash" TEXT NOT NULL,
    "eta" BIGINT NOT NULL,
    "executed" BOOLEAN NOT NULL DEFAULT false,
    "cancelled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GovernanceProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditFinding" (
    "id" TEXT NOT NULL,
    "severity" "AuditSeverity" NOT NULL,
    "title" TEXT NOT NULL,
    "component" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuditFinding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LedgerCursor_network_ledger_idx" ON "LedgerCursor"("network", "ledger");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerCursor_network_contractId_key" ON "LedgerCursor"("network", "contractId");

-- CreateIndex
CREATE UNIQUE INDEX "ProtocolEvent_replayKey_key" ON "ProtocolEvent"("replayKey");

-- CreateIndex
CREATE INDEX "ProtocolEvent_network_ledger_idx" ON "ProtocolEvent"("network", "ledger");

-- CreateIndex
CREATE INDEX "ProtocolEvent_txHash_idx" ON "ProtocolEvent"("txHash");

-- CreateIndex
CREATE INDEX "ProtocolEvent_topic_idx" ON "ProtocolEvent"("topic");

-- CreateIndex
CREATE INDEX "Order_marketId_isLong_limitPrice_idx" ON "Order"("marketId", "isLong", "limitPrice");

-- CreateIndex
CREATE INDEX "Order_expiryTs_idx" ON "Order"("expiryTs");

-- CreateIndex
CREATE UNIQUE INDEX "Order_owner_nonce_key" ON "Order"("owner", "nonce");

-- CreateIndex
CREATE INDEX "Fill_marketId_ledger_idx" ON "Fill"("marketId", "ledger");

-- CreateIndex
CREATE INDEX "Fill_maker_idx" ON "Fill"("maker");

-- CreateIndex
CREATE INDEX "Fill_taker_idx" ON "Fill"("taker");

-- CreateIndex
CREATE UNIQUE INDEX "Fill_network_txHash_maker_makerNonce_taker_takerNonce_key" ON "Fill"("network", "txHash", "maker", "makerNonce", "taker", "takerNonce");

-- CreateIndex
CREATE INDEX "Position_marketId_isLong_idx" ON "Position"("marketId", "isLong");

-- CreateIndex
CREATE UNIQUE INDEX "Position_owner_positionId_key" ON "Position"("owner", "positionId");

-- CreateIndex
CREATE INDEX "OracleSnapshot_marketId_ledger_idx" ON "OracleSnapshot"("marketId", "ledger");

-- CreateIndex
CREATE INDEX "OracleSnapshot_asset_publishTime_idx" ON "OracleSnapshot"("asset", "publishTime");

-- CreateIndex
CREATE UNIQUE INDEX "OracleSnapshot_network_asset_publishTime_source_key" ON "OracleSnapshot"("network", "asset", "publishTime", "source");

-- CreateIndex
CREATE INDEX "FundingUpdate_marketId_ledger_idx" ON "FundingUpdate"("marketId", "ledger");

-- CreateIndex
CREATE UNIQUE INDEX "FundingUpdate_network_marketId_ledger_txHash_key" ON "FundingUpdate"("network", "marketId", "ledger", "txHash");

-- CreateIndex
CREATE INDEX "TxJob_status_nextAttemptAt_idx" ON "TxJob"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "TxJob_submittedHash_idx" ON "TxJob"("submittedHash");

-- CreateIndex
CREATE UNIQUE INDEX "TxJob_network_kind_payloadHash_key" ON "TxJob"("network", "kind", "payloadHash");

-- CreateIndex
CREATE INDEX "KeeperAction_network_kind_status_idx" ON "KeeperAction"("network", "kind", "status");

-- CreateIndex
CREATE INDEX "KeeperAction_marketId_idx" ON "KeeperAction"("marketId");

-- CreateIndex
CREATE INDEX "DeploymentArtifact_wasmHash_idx" ON "DeploymentArtifact"("wasmHash");

-- CreateIndex
CREATE UNIQUE INDEX "DeploymentArtifact_network_contractName_key" ON "DeploymentArtifact"("network", "contractName");

-- CreateIndex
CREATE INDEX "GovernanceProposal_network_eta_idx" ON "GovernanceProposal"("network", "eta");

-- CreateIndex
CREATE INDEX "AuditFinding_severity_status_idx" ON "AuditFinding"("severity", "status");

-- CreateIndex
CREATE INDEX "AuditFinding_component_idx" ON "AuditFinding"("component");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_owner_fkey" FOREIGN KEY ("owner") REFERENCES "Account"("address") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fill" ADD CONSTRAINT "Fill_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fill" ADD CONSTRAINT "Fill_maker_fkey" FOREIGN KEY ("maker") REFERENCES "Account"("address") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fill" ADD CONSTRAINT "Fill_taker_fkey" FOREIGN KEY ("taker") REFERENCES "Account"("address") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_owner_fkey" FOREIGN KEY ("owner") REFERENCES "Account"("address") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OracleSnapshot" ADD CONSTRAINT "OracleSnapshot_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FundingUpdate" ADD CONSTRAINT "FundingUpdate_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KeeperAction" ADD CONSTRAINT "KeeperAction_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE SET NULL ON UPDATE CASCADE;

