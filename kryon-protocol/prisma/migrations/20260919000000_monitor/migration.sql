-- Monitor status and alert history (Phase 3 step 5f).
--
-- MonitorStatus holds one row per network, upserted every tick: what the
-- status page reads. MonitorAlert is append-only, one row per transition
-- (fire, reminder, resolve), so it grows with incidents rather than with ticks.

-- CreateEnum
CREATE TYPE "MonitorLevel" AS ENUM ('OK', 'WARN', 'PAGE');

-- CreateEnum
CREATE TYPE "MonitorSeverity" AS ENUM ('PAGE', 'WARN');

-- CreateEnum
CREATE TYPE "MonitorAlertEvent" AS ENUM ('FIRING', 'REMINDER', 'RESOLVED');

-- CreateTable
CREATE TABLE "MonitorStatus" (
    "network" TEXT NOT NULL,
    "level" "MonitorLevel" NOT NULL,
    "checks" JSONB NOT NULL DEFAULT '[]',
    "firing" JSONB NOT NULL DEFAULT '[]',
    "tickAt" TIMESTAMP(3) NOT NULL,
    "tickDurationMs" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MonitorStatus_pkey" PRIMARY KEY ("network")
);

-- CreateTable
CREATE TABLE "MonitorAlert" (
    "id" BIGSERIAL NOT NULL,
    "network" TEXT NOT NULL,
    "alertKey" TEXT NOT NULL,
    "check" TEXT NOT NULL,
    "subject" TEXT,
    "severity" "MonitorSeverity" NOT NULL,
    "event" "MonitorAlertEvent" NOT NULL,
    "detail" TEXT NOT NULL,
    "values" JSONB NOT NULL DEFAULT '{}',
    "runbook" TEXT,
    "forSecs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MonitorAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MonitorAlert_network_createdAt_idx" ON "MonitorAlert"("network", "createdAt");

-- CreateIndex
CREATE INDEX "MonitorAlert_network_alertKey_createdAt_idx" ON "MonitorAlert"("network", "alertKey", "createdAt");

-- The same network guard every other table carries.
ALTER TABLE "MonitorStatus" ADD CONSTRAINT "MonitorStatus_network_check" CHECK ("network" IN ('arc-mainnet', 'arc-testnet', 'arc-local'));
ALTER TABLE "MonitorAlert" ADD CONSTRAINT "MonitorAlert_network_check" CHECK ("network" IN ('arc-mainnet', 'arc-testnet', 'arc-local'));
