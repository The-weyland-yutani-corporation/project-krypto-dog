ALTER TABLE "public"."AgentState"
ADD COLUMN IF NOT EXISTS "isOperatorPaused" boolean DEFAULT false NOT NULL;