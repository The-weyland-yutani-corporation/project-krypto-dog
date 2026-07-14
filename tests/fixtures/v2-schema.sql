CREATE TYPE "public"."TradeDirection" AS ENUM ('BUY', 'SELL');

CREATE TABLE "public"."AgentState" (
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

CREATE TABLE "public"."TradeExecution" (
    "id" TEXT NOT NULL,
    "direction" "public"."TradeDirection" NOT NULL,
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

CREATE TABLE "public"."AgentJournal" (
    "id" TEXT NOT NULL,
    "entryText" TEXT NOT NULL,
    "marketConditions" JSONB NOT NULL,
    "tradeExecutionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentJournal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TradeExecution_createdAt_idx"
ON "public"."TradeExecution"("createdAt");

CREATE INDEX "AgentJournal_createdAt_idx"
ON "public"."AgentJournal"("createdAt");

ALTER TABLE "public"."AgentJournal"
ADD CONSTRAINT "AgentJournal_tradeExecutionId_fkey"
FOREIGN KEY ("tradeExecutionId")
REFERENCES "public"."TradeExecution"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;
