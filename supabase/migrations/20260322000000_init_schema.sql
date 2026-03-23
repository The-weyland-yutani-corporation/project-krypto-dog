-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "TradeDirection" AS ENUM ('BUY', 'SELL');

-- CreateTable
CREATE TABLE "AgentState" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "lastTradePrice" DOUBLE PRECISION,
    "currentPositionETH" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currentPositionUSDC" DOUBLE PRECISION NOT NULL DEFAULT 200,
    "portfolioValueUSD" DOUBLE PRECISION NOT NULL DEFAULT 200,
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "isRunning" BOOLEAN NOT NULL DEFAULT false,
    "lastRunAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradeExecution" (
    "id" TEXT NOT NULL,
    "direction" "TradeDirection" NOT NULL,
    "asset" TEXT NOT NULL,
    "amountUSD" DOUBLE PRECISION NOT NULL,
    "amountAsset" DOUBLE PRECISION NOT NULL,
    "executionPrice" DOUBLE PRECISION NOT NULL,
    "feesUSD" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "slippage" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "pnlUSD" DOUBLE PRECISION,
    "agentReasoning" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TradeExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentJournal" (
    "id" TEXT NOT NULL,
    "entryText" TEXT NOT NULL,
    "marketConditions" JSONB NOT NULL,
    "tradeExecutionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentJournal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TradeExecution_createdAt_idx" ON "TradeExecution"("createdAt");

-- CreateIndex
CREATE INDEX "AgentJournal_createdAt_idx" ON "AgentJournal"("createdAt");

-- AddForeignKey
ALTER TABLE "AgentJournal" ADD CONSTRAINT "AgentJournal_tradeExecutionId_fkey" FOREIGN KEY ("tradeExecutionId") REFERENCES "TradeExecution"("id") ON DELETE SET NULL ON UPDATE CASCADE;

